import type { CheckpointError, CheckpointStatus } from "../domain/model.js";
import { awaitBounded } from "./bounded-shutdown.js";
import type { CheckpointSessionResult } from "./checkpoint-service.js";

export interface CheckpointRunner {
  run(
    reasons: readonly string[],
    signal: AbortSignal,
  ): Promise<CheckpointSessionResult | undefined>;
}

export interface CoordinatorScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CheckpointCoordinatorOptions {
  debounceMs: number;
  shutdownTimeoutMs: number;
  runner: CheckpointRunner;
  scheduler?: CoordinatorScheduler;
  now?: () => Date;
  isCurrent?: () => boolean;
  onStatus?: (status: CheckpointStatus) => void;
}

const defaultScheduler: CoordinatorScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CheckpointCoordinator {
  private readonly debounceMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly runner: CheckpointRunner;
  private readonly scheduler: CoordinatorScheduler;
  private readonly now: () => Date;
  private readonly isCurrent: () => boolean;
  private readonly onStatus?: (status: CheckpointStatus) => void;
  private readonly dirtyReasons = new Set<string>();
  private timer: unknown;
  private drainPromise?: Promise<CheckpointSessionResult | undefined>;
  private abortController = new AbortController();
  private disposed = false;
  private status: CheckpointStatus = { state: "idle" };

  constructor(options: CheckpointCoordinatorOptions) {
    this.debounceMs = options.debounceMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
    this.runner = options.runner;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? (() => new Date());
    this.isCurrent = options.isCurrent ?? (() => true);
    this.onStatus = options.onStatus;
  }

  getStatus(): CheckpointStatus {
    return structuredClone(this.status);
  }

  markDirty(reason: string): void {
    if (this.disposed) return;
    this.dirtyReasons.add(reason);
    this.publish({ state: "pending", dirtyReasons: [...this.dirtyReasons] });
    if (!this.drainPromise) this.schedule();
  }

  flush(reason = "manual"): Promise<CheckpointSessionResult | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    this.dirtyReasons.add(reason);
    this.cancelTimer();
    return this.drain();
  }

  async shutdown(reason = "shutdown"): Promise<void> {
    if (this.disposed) return;
    this.dirtyReasons.add(reason);
    this.cancelTimer();
    await awaitBounded(this.drain(), this.shutdownTimeoutMs, this.scheduler);
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.abortController.abort();
    this.dirtyReasons.clear();
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.debounceMs);
  }

  private drain(): Promise<CheckpointSessionResult | undefined> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainLoop().finally(() => {
      this.drainPromise = undefined;
      if (!this.disposed && this.dirtyReasons.size > 0 && this.status.state !== "error") {
        this.schedule();
      }
    });
    return this.drainPromise;
  }

  private async drainLoop(): Promise<CheckpointSessionResult | undefined> {
    let latest: CheckpointSessionResult | undefined;
    while (!this.disposed && this.dirtyReasons.size > 0) {
      const reasons = [...this.dirtyReasons];
      this.dirtyReasons.clear();
      const outcome = await this.runCheckpoint(reasons);
      latest = outcome.result;
      if (outcome.stop) return latest;
    }
    return latest;
  }

  private async runCheckpoint(
    reasons: readonly string[],
  ): Promise<{ result: CheckpointSessionResult | undefined; stop: boolean }> {
    this.publish({ state: "running", startedAt: this.now().toISOString() });
    try {
      const result = await this.runner.run(reasons, this.abortController.signal);
      this.publish(successStatus(result));
      return { result, stop: false };
    } catch (error) {
      if (this.abortController.signal.aborted || this.disposed) {
        return { result: undefined, stop: true };
      }
      for (const reason of reasons) this.dirtyReasons.add(reason);
      this.publish({ state: "error", error: checkpointError(error, this.now()) });
      return { result: undefined, stop: true };
    }
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(status: CheckpointStatus): void {
    this.status = status;
    if (this.isCurrent()) this.onStatus?.(structuredClone(status));
  }
}

function successStatus(result: CheckpointSessionResult | undefined): CheckpointStatus {
  return result
    ? {
        state: "idle",
        revision: result.record.revision,
        lastSuccessAt: result.record.capturedAt,
      }
    : { state: "idle" };
}

function checkpointError(error: unknown, occurredAt: Date): CheckpointError {
  return {
    code: errorCode(error),
    message: errorMessage(error),
    occurredAt: occurredAt.toISOString(),
    retryable: true,
  };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "CHECKPOINT_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
