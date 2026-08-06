import { describe, expect, it, vi } from "vitest";

import {
  ReplicationCoordinator,
  type ReplicationCoordinatorScheduler,
} from "../../../src/application/replication-coordinator.js";
import type { ReplicateSessionResult } from "../../../src/application/replication-service.js";
import type { SessionReplicaRecord } from "../../../src/domain/replica.js";

class FakeScheduler implements ReplicationCoordinatorScheduler {
  private nextId = 0;
  private tasks = new Map<number, () => void>();
  setTimeout(callback: () => void): unknown {
    const id = ++this.nextId;
    this.tasks.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  runAll(): void {
    for (const [id, callback] of this.tasks) {
      this.tasks.delete(id);
      callback();
    }
  }
}

function result(revision: number): ReplicateSessionResult {
  return {
    changed: true,
    record: {
      schemaVersion: 1,
      targetId: "backup",
      repositoryId: "repo",
      sessionId: "session",
      revision,
      objects: [
        {
          object: {
            algorithm: "sha256",
            digest: "a".repeat(64),
            encoding: "gzip",
            logicalBytes: 1,
            storedBytes: 1,
          },
          key: "objects/sha256/a.gz",
        },
      ],
      verifiedAt: "2026-08-05T12:00:00.000Z",
    } satisfies SessionReplicaRecord,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ReplicationCoordinator", () => {
  it("coalesces revision storms and publishes only the newest revision", async () => {
    const scheduler = new FakeScheduler();
    const run = vi.fn(async () => result(3));
    const coordinator = new ReplicationCoordinator({
      debounceMs: 10,
      shutdownTimeoutMs: 10,
      scheduler,
      runner: { run },
    });

    coordinator.markRevision(1);
    coordinator.markRevision(2);
    coordinator.markRevision(3);
    scheduler.runAll();
    await settle();

    expect(run).toHaveBeenCalledOnce();
    expect(coordinator.getStatus()).toEqual({ state: "idle", publishedRevision: 3 });
  });

  it("never overlaps and follows a running attempt with the latest revision", async () => {
    const first = deferred<ReplicateSessionResult>();
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(result(4));
    const coordinator = new ReplicationCoordinator({
      debounceMs: 0,
      shutdownTimeoutMs: 10,
      runner: { run },
    });

    const flushing = coordinator.flush(1);
    await settle();
    coordinator.markRevision(2);
    coordinator.markRevision(4);
    expect(run).toHaveBeenCalledOnce();
    first.resolve(result(1));
    await expect(flushing).resolves.toEqual(result(4));
    expect(run).toHaveBeenCalledTimes(2);
    expect(coordinator.getStatus()).toEqual({ state: "idle", publishedRevision: 4 });
  });

  it("keeps failures retryable without publishing stale lifecycle status", async () => {
    const onStatus = vi.fn();
    let current = true;
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(result(2));
    const coordinator = new ReplicationCoordinator({
      debounceMs: 0,
      shutdownTimeoutMs: 10,
      runner: { run },
      isCurrent: () => current,
      onStatus,
    });

    await coordinator.flush(2);
    expect(coordinator.getStatus()).toMatchObject({ state: "error", localRevision: 2 });
    current = false;
    await coordinator.flush(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onStatus).not.toHaveBeenLastCalledWith({ state: "idle", publishedRevision: 2 });
  });

  it("bounds shutdown and aborts late remote work", async () => {
    const scheduler = new FakeScheduler();
    const pending = deferred<ReplicateSessionResult>();
    let signal: AbortSignal | undefined;
    const coordinator = new ReplicationCoordinator({
      debounceMs: 0,
      shutdownTimeoutMs: 10,
      scheduler,
      runner: {
        run: async (value) => {
          signal = value;
          return pending.promise;
        },
      },
    });
    coordinator.markRevision(1);
    const shutdown = coordinator.shutdown();
    await settle();
    scheduler.runAll();
    await shutdown;

    expect(signal?.aborted).toBe(true);
    pending.resolve(result(1));
  });
});
