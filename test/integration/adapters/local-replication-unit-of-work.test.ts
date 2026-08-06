import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalReplicationUnitOfWork,
  LocalReplicationUnitOfWorkFactory,
} from "../../../src/adapters/filesystem/local-replication-unit-of-work.js";
import { LocalSessionReplicaRepository } from "../../../src/adapters/filesystem/local-session-replica-repository.js";
import type { ReplicaObjectRepository } from "../../../src/application/replication-ports.js";
import {
  SessionReplica,
  type RemoteObjectReceipt,
  type ReplicaIdentity,
} from "../../../src/domain/replica.js";
import { replicationUnitOfWorkContract } from "../../contracts/replication-unit-of-work.contract.js";
import { MemoryRemoteObjects, replicaObjectFixture } from "../../support/memory-replication.js";

const temporaryDirectories: string[] = [];
const identity = { targetId: "backup", repositoryId: "repo", sessionId: "session" };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function storageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "session-hoarder-replication-uow-"));
  temporaryDirectories.push(root);
  return root;
}

replicationUnitOfWorkContract("LocalReplicationUnitOfWork", async () => {
  const root = await storageRoot();
  const fixture = replicaObjectFixture();
  const objects = new MemoryRemoteObjects();
  return {
    identity,
    object: fixture.object,
    payload: fixture.payload,
    create: () => new LocalReplicationUnitOfWork(new LocalSessionReplicaRepository(root), objects),
    read: (value) => new LocalSessionReplicaRepository(root).get(value),
    removeRemote: async (digest) => {
      objects.objects.delete(digest);
    },
  };
});

describe("LocalReplicationUnitOfWork", () => {
  it("preserves the previous replica when atomic publication fails", async () => {
    const root = await storageRoot();
    const fixture = replicaObjectFixture();
    const objects = new MemoryRemoteObjects();
    const receipt = await putReceipt(objects, fixture.object, fixture.payload());
    const initial = replicaAt(identity, 1, receipt);
    const initialUow = new LocalReplicationUnitOfWork(
      new LocalSessionReplicaRepository(root),
      objects,
    );
    initialUow.replicas.add(initial);
    await initialUow.commit();

    const loaded = await new LocalSessionReplicaRepository(root).get(identity);
    if (!loaded) throw new Error("expected persisted replica");
    loaded.recordVerifiedRevision({
      revision: 3,
      objects: [receipt],
      verifiedAt: "2026-08-05T12:03:00.000Z",
    });
    const failing = new LocalReplicationUnitOfWork(
      new LocalSessionReplicaRepository(root, {
        atomicWrite: async () => {
          throw new Error("injected replica publication failure");
        },
      }),
      objects,
    );
    failing.replicas.add(loaded);

    await expect(failing.commit()).rejects.toThrow("injected replica publication failure");
    await expect(new LocalSessionReplicaRepository(root).get(identity)).resolves.toMatchObject({
      record: { revision: 1 },
    });
  });

  it("rejects stale concurrent replica publication", async () => {
    const root = await storageRoot();
    const fixture = replicaObjectFixture();
    const objects = new MemoryRemoteObjects();
    const receipt = await putReceipt(objects, fixture.object, fixture.payload());
    const newer = new LocalReplicationUnitOfWork(new LocalSessionReplicaRepository(root), objects);
    const stale = new LocalReplicationUnitOfWork(new LocalSessionReplicaRepository(root), objects);
    newer.replicas.add(replicaAt(identity, 3, receipt));
    stale.replicas.add(replicaAt(identity, 2, receipt));

    await newer.commit();
    await expect(stale.commit()).rejects.toThrow("existing 3, received 2");
  });

  it("fails explicitly for malformed replica records", async () => {
    const root = await storageRoot();
    const repository = new LocalSessionReplicaRepository(root);
    const path = repository.recordPath(identity);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json");

    await expect(repository.get(identity)).rejects.toThrow("contains invalid JSON");
  });

  it("validates target and session path segments", async () => {
    const root = await storageRoot();
    const repository = new LocalSessionReplicaRepository(root);

    expect(() => repository.recordPath({ ...identity, targetId: "../escape" })).toThrow(
      "Invalid replica targetId",
    );
    expect(repository.recordPath(identity)).toBe(
      join(root, "replicas", "backup", "repo", "session.json"),
    );
  });

  it("creates target-bound remote repositories through the factory", async () => {
    const root = await storageRoot();
    const objects = new MemoryRemoteObjects();
    const createObjects = vi.fn((_targetId: string): ReplicaObjectRepository => objects);
    const factory = new LocalReplicationUnitOfWorkFactory(root, createObjects);

    const uow = factory.create("backup");

    expect(createObjects).toHaveBeenCalledWith("backup");
    expect(uow.objects).toBe(objects);
  });
});

async function putReceipt(
  objects: MemoryRemoteObjects,
  object: ReturnType<typeof replicaObjectFixture>["object"],
  payload: ReturnType<ReturnType<typeof replicaObjectFixture>["payload"]>,
): Promise<RemoteObjectReceipt> {
  const result = await objects.put({ object, ...payload });
  if (result.state !== "uploaded") throw new Error("expected fresh remote upload");
  return result.receipt;
}

function replicaAt(
  value: ReplicaIdentity,
  revision: number,
  receipt: RemoteObjectReceipt,
): SessionReplica {
  const replica = SessionReplica.create(value);
  replica.recordVerifiedRevision({
    revision,
    objects: [receipt],
    verifiedAt: `2026-08-05T12:${String(revision).padStart(2, "0")}:00.000Z`,
  });
  return replica;
}
