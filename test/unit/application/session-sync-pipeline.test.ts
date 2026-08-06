import { describe, expect, it, vi } from "vitest";

import { SessionSyncPipeline } from "../../../src/application/session-sync-pipeline.js";
import type { SessionArchiveRecord } from "../../../src/domain/model.js";
import type { SessionReplicaRecord } from "../../../src/domain/replica.js";

const archive = { revision: 3 } as SessionArchiveRecord;
const replica = { revision: 3 } as SessionReplicaRecord;

describe("SessionSyncPipeline", () => {
  it("orders checkpoint, exact-revision replication, and projection", async () => {
    const calls: string[] = [];
    const pipeline = new SessionSyncPipeline({
      checkpoint: vi.fn(async () => {
        calls.push("checkpoint");
        return { changed: true, record: archive };
      }),
      currentRevision: () => 3,
      replication: () => ({
        queue: vi.fn(),
        flush: vi.fn(async (revision) => {
          calls.push(`replication:${revision}`);
          return { changed: true, record: replica };
        }),
        error: () => undefined,
      }),
      projection: {
        publish: vi.fn(async () => {
          calls.push("projection");
        }),
        current: () => ({ revision: 3, path: "catalog.json" }),
        error: () => undefined,
      },
    });

    const result = await pipeline.sync();

    expect(calls).toEqual(["checkpoint", "replication:3", "projection"]);
    expect(result).toMatchObject({
      checkpoint: { changed: true },
      replication: { changed: true },
      projection: { revision: 3 },
    });
  });

  it("publishes locally after checkpoint and remotely only after the matching revision", async () => {
    const publish = vi.fn(async () => undefined);
    let remote = false;
    const queue = vi.fn();
    const pipeline = new SessionSyncPipeline({
      checkpoint: vi.fn(),
      currentRevision: () => 3,
      replication: () => (remote ? { queue, flush: vi.fn(), error: () => undefined } : undefined),
      projection: { publish, current: () => undefined, error: () => undefined },
    });

    await pipeline.afterCheckpoint({ changed: true, record: archive });
    remote = true;
    await pipeline.afterCheckpoint({ changed: true, record: archive });
    await pipeline.afterReplication({ changed: true, record: { ...replica, revision: 2 } });
    await pipeline.afterReplication({ changed: true, record: replica });

    expect(queue).toHaveBeenCalledWith(3);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("reports replication failure independently from a successful checkpoint", async () => {
    const pipeline = new SessionSyncPipeline({
      checkpoint: async () => ({ changed: false, record: archive }),
      currentRevision: () => 3,
      replication: () => ({
        queue: vi.fn(),
        flush: async () => {
          throw new Error("remote unavailable");
        },
        error: () => undefined,
      }),
    });

    await expect(pipeline.sync()).resolves.toMatchObject({
      checkpoint: { changed: false },
      replicationError: { message: "remote unavailable" },
    });
  });
});
