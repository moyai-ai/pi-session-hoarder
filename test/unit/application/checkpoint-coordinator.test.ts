import { describe, expect, it, vi } from "vitest";

import {
  CheckpointCoordinator,
  type CoordinatorScheduler,
} from "../../../src/application/checkpoint-coordinator.js";
import type { CheckpointSessionResult } from "../../../src/application/checkpoint-service.js";
import type { SessionArchiveRecord } from "../../../src/domain/model.js";

class FakeScheduler implements CoordinatorScheduler {
  private now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    const ready = [...this.tasks.entries()]
      .filter(([, task]) => task.at <= this.now)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, task] of ready) {
      this.tasks.delete(id);
      task.callback();
    }
  }

  get pending(): number {
    return this.tasks.size;
  }
}

function record(revision: number): SessionArchiveRecord {
  const digest = "a".repeat(64);
  return {
    schemaVersion: 1,
    repositoryId: "repo",
    sessionId: "session",
    revision,
    source: { size: revision, mtimeMs: revision, sha256: digest },
    sessionObject: {
      algorithm: "sha256",
      digest,
      encoding: "gzip",
      logicalBytes: revision,
      storedBytes: revision,
      relativePath: `objects/${digest}.gz`,
    },
    artifacts: [],
    capturedAt: `2026-08-03T00:00:0${revision}.000Z`,
    lastVerifiedAt: `2026-08-03T00:00:0${revision}.000Z`,
  };
}

function result(revision: number): CheckpointSessionResult {
  return { changed: true, record: record(revision) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CheckpointCoordinator", () => {
  it("debounces and coalesces event storms", async () => {
    const scheduler = new FakeScheduler();
    const run = vi.fn(async (_reasons: readonly string[], _signal: AbortSignal) => result(1));
    const coordinator = new CheckpointCoordinator({
      debounceMs: 100,
      shutdownTimeoutMs: 50,
      scheduler,
      runner: { run },
    });

    coordinator.markDirty("message");
    coordinator.markDirty("message");
    coordinator.markDirty("metadata");
    expect(scheduler.pending).toBe(1);
    scheduler.advance(99);
    expect(run).not.toHaveBeenCalled();
    scheduler.advance(1);
    await settle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual(["message", "metadata"]);
  });

  it("never overlaps runs and schedules one follow-up for changes during a run", async () => {
    const first = deferred<CheckpointSessionResult>();
    const second = deferred<CheckpointSessionResult>();
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = new CheckpointCoordinator({
      debounceMs: 0,
      shutdownTimeoutMs: 50,
      runner: { run },
    });

    const flushing = coordinator.flush("manual");
    await settle();
    coordinator.markDirty("message");
    coordinator.markDirty("tree");
    expect(run).toHaveBeenCalledTimes(1);
    first.resolve(result(1));
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toEqual(["message", "tree"]);
    second.resolve(result(2));
    await expect(flushing).resolves.toEqual(result(2));
  });

  it("keeps failures retryable", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }))
      .mockResolvedValueOnce(result(1));
    const coordinator = new CheckpointCoordinator({
      debounceMs: 100,
      shutdownTimeoutMs: 50,
      runner: { run },
    });

    await coordinator.flush("manual");
    expect(coordinator.getStatus()).toMatchObject({
      state: "error",
      error: { code: "ENOSPC", retryable: true },
    });
    await coordinator.flush("retry");
    expect(coordinator.getStatus()).toMatchObject({ state: "idle", revision: 1 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not publish status from a stale lifecycle generation", async () => {
    const onStatus = vi.fn();
    const coordinator = new CheckpointCoordinator({
      debounceMs: 0,
      shutdownTimeoutMs: 50,
      runner: { run: async () => result(1) },
      isCurrent: () => false,
      onStatus,
    });

    await coordinator.flush();

    expect(onStatus).not.toHaveBeenCalled();
  });

  it("bounds shutdown and aborts late work", async () => {
    const scheduler = new FakeScheduler();
    const pending = deferred<CheckpointSessionResult>();
    let signal: AbortSignal | undefined;
    const coordinator = new CheckpointCoordinator({
      debounceMs: 100,
      shutdownTimeoutMs: 50,
      scheduler,
      runner: {
        run: async (_reasons, runSignal) => {
          signal = runSignal;
          return pending.promise;
        },
      },
    });

    const shutdown = coordinator.shutdown();
    await settle();
    scheduler.advance(50);
    await shutdown;

    expect(signal?.aborted).toBe(true);
    pending.resolve(result(1));
  });
});
