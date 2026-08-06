import { describe, expect, it } from "vitest";

import type {
  EncodedObjectPayload,
  ReplicationUnitOfWork,
} from "../../src/application/replication-ports.js";
import type { ObjectReference } from "../../src/domain/model.js";
import { SessionReplica, type ReplicaIdentity } from "../../src/domain/replica.js";

export interface ReplicationUnitOfWorkContractHarness {
  identity: ReplicaIdentity;
  object: ObjectReference;
  create(): ReplicationUnitOfWork;
  read(identity: ReplicaIdentity): Promise<SessionReplica | undefined>;
  removeRemote(digest: string): Promise<void>;
  payload(): EncodedObjectPayload;
}

export function replicationUnitOfWorkContract(
  name: string,
  createHarness: () => Promise<ReplicationUnitOfWorkContractHarness>,
): void {
  describe(`${name} ReplicationUnitOfWork contract`, () => {
    it("publishes a staged replica only after explicit commit", async () => {
      const harness = await createHarness();
      const uow = harness.create();
      const receipt = await stageReplica(harness, uow);

      await expect(harness.read(harness.identity)).resolves.toBeUndefined();
      await uow.commit();
      await uow.dispose();

      await expect(harness.read(harness.identity)).resolves.toMatchObject({
        record: { revision: 1, objects: [receipt] },
      });
    });

    it("publishes no replica when rolled back", async () => {
      const harness = await createHarness();
      const uow = harness.create();
      await stageReplica(harness, uow);

      await uow.rollback();
      await uow.dispose();

      await expect(harness.read(harness.identity)).resolves.toBeUndefined();
    });

    it("refuses to publish when a referenced remote object is unavailable", async () => {
      const harness = await createHarness();
      const uow = harness.create();
      await stageReplica(harness, uow);
      await harness.removeRemote(harness.object.digest);

      await expect(uow.commit()).rejects.toThrow("unverified remote object");
      await uow.rollback();
      await uow.dispose();
      await expect(harness.read(harness.identity)).resolves.toBeUndefined();
    });
  });
}

async function stageReplica(
  harness: ReplicationUnitOfWorkContractHarness,
  uow: ReplicationUnitOfWork,
) {
  const result = await uow.objects.put({
    object: harness.object,
    ...harness.payload(),
  });
  if (result.state !== "uploaded") throw new Error("expected a fresh remote upload");
  uow.replicas.add(replicaWith(harness.identity, result.receipt));
  return result.receipt;
}

function replicaWith(
  identity: ReplicaIdentity,
  receipt: import("../../src/domain/replica.js").RemoteObjectReceipt,
): SessionReplica {
  const replica = SessionReplica.create(identity);
  replica.recordVerifiedRevision({
    revision: 1,
    objects: [receipt],
    verifiedAt: "2026-08-05T12:00:00.000Z",
  });
  return replica;
}
