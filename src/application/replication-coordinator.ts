import type { CheckpointError } from "../domain/model.js";
import { awaitBounded } from "./bounded-shutdown.js";
import type { ReplicateSessionResult } from "./replication-service.js";

export type ReplicationStatus =
  | { state: "off" }
  | { state: "idle"; publishedRevision?: number }
  | { state: "pending"; localRevision: number; publishedRevision?: number }
  | { state: "running"; localRevision: number; publishedRevision?: number }
  | {
      state: "error";
      localRevision: number;
      publishedRevision?: number;
      error: CheckpointError;
    };

export interface ReplicationCoordinatorScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReplicationCoordinatorOptions {
  debounceMs: number;
  shutdownTimeoutMs: number;
  runner: { run(signal: AbortSignal): Promise<ReplicateSessionResult | undefined> };
  scheduler?: ReplicationCoordinatorScheduler;
  now?: () => Date;
  isCurrent?: () => boolean;
  onStatus?: (status: ReplicationStatus) => void;
}

const defaultScheduler: ReplicationCoordinatorScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Coalesces committed local revisions into non-overlapping remote replication attempts. */
export class ReplicationCoordinator {
  private readonly options: Required<
    Pick<ReplicationCoordinatorOptions, "debounceMs" | "shutdownTimeoutMs" | "runner">
  > &
    Omit<ReplicationCoordinatorOptions, "debounceMs" | "shutdownTimeoutMs" | "runner">;
  private readonly scheduler: ReplicationCoordinatorScheduler;
  private readonly now: () => Date;
  private readonly isCurrent: () => boolean;
  private desiredRevision?: number;
  private publishedRevision?: number;
  private timer?: unknown;
  private drainPromise?: Promise<ReplicateSessionResult | undefined>;
  private latestResult?: ReplicateSessionResult;
  private abortController = new AbortController();
  private disposed = false;
  private status: ReplicationStatus = { state: "idle" };

  constructor(options: ReplicationCoordinatorOptions) {
    this.options = options;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? (() => new Date());
    this.isCurrent = options.isCurrent ?? (() => true);
  }

  getStatus(): ReplicationStatus {
    return structuredClone(this.status);
  }

  markRevision(revision: number): void {
    if (this.disposed || revision <= (this.publishedRevision ?? 0)) return;
    this.desiredRevision = Math.max(this.desiredRevision ?? 0, revision);
    this.publish({
      state: "pending",
      localRevision: this.desiredRevision,
      ...(this.publishedRevision ? { publishedRevision: this.publishedRevision } : {}),
    });
    if (!this.drainPromise) this.schedule();
  }

  async flush(revision?: number): Promise<ReplicateSessionResult | undefined> {
    if (this.disposed) return undefined;
    const activeDrain = this.drainPromise;
    if (revision !== undefined) this.markRevision(revision);
    this.cancelTimer();
    if (activeDrain) {
      await activeDrain;
      if (this.desiredRevision !== undefined) return this.drain();
      return this.latestResult;
    }
    return this.desiredRevision === undefined ? this.latestResult : this.drain();
  }

  async shutdownAndDrain(): Promise<void> {
    if (this.disposed) return;
    this.cancelTimer();
    const drain =
      this.drainPromise ??
      (this.desiredRevision === undefined ? Promise.resolve(undefined) : this.drain());
    await awaitBounded(drain, this.options.shutdownTimeoutMs, this.scheduler);
    this.cancelWithoutDrain();
  }

  cancelWithoutDrain(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releasePendingWork();
  }

  dispose(): void {
    this.cancelWithoutDrain();
  }

  private releasePendingWork(): void {
    this.cancelTimer();
    this.abortController.abort();
    this.desiredRevision = undefined;
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.options.debounceMs);
  }

  private drain(): Promise<ReplicateSessionResult | undefined> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainLoop().finally(() => {
      this.drainPromise = undefined;
      if (!this.disposed && this.desiredRevision !== undefined && this.status.state !== "error") {
        this.schedule();
      }
    });
    return this.drainPromise;
  }

  private async drainLoop(): Promise<ReplicateSessionResult | undefined> {
    let latest: ReplicateSessionResult | undefined;
    while (!this.disposed && this.desiredRevision !== undefined) {
      const revision = this.desiredRevision;
      this.desiredRevision = undefined;
      const outcome = await this.runRevision(revision);
      if (outcome.result) latest = outcome.result;
      if (outcome.stop) return latest;
    }
    return latest;
  }

  private async runRevision(
    revision: number,
  ): Promise<{ result?: ReplicateSessionResult; stop: boolean }> {
    this.publish(this.runningStatus(revision));
    try {
      const result = await this.options.runner.run(this.abortController.signal);
      if (this.disposed || this.abortController.signal.aborted) return { stop: true };
      if (result) {
        this.latestResult = result;
        this.publishedRevision = Math.max(this.publishedRevision ?? 0, result.record.revision);
      }
      this.publish(this.idleStatus());
      return result ? { result, stop: false } : { stop: false };
    } catch (error) {
      if (this.abortController.signal.aborted || this.disposed) return { stop: true };
      this.desiredRevision = Math.max(this.desiredRevision ?? 0, revision);
      this.publish({
        state: "error",
        localRevision: revision,
        ...this.publishedRevisionFields(),
        error: replicationError(error, this.now()),
      });
      return { stop: true };
    }
  }

  private runningStatus(revision: number): ReplicationStatus {
    return { state: "running", localRevision: revision, ...this.publishedRevisionFields() };
  }

  private idleStatus(): ReplicationStatus {
    return { state: "idle", ...this.publishedRevisionFields() };
  }

  private publishedRevisionFields(): { publishedRevision?: number } {
    return this.publishedRevision ? { publishedRevision: this.publishedRevision } : {};
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(status: ReplicationStatus): void {
    if (this.disposed) return;
    this.status = status;
    if (this.isCurrent()) this.options.onStatus?.(structuredClone(status));
  }
}

function replicationError(error: unknown, now: Date): CheckpointError {
  return {
    code: "REPLICATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    occurredAt: now.toISOString(),
    retryable: true,
  };
}
