import { describe, expect, it } from "vitest";

import type { CheckpointUnitOfWork } from "../../src/application/ports.js";
import {
  SessionArchive,
  type ObjectReference,
  type SessionIdentity,
} from "../../src/domain/model.js";

export interface CheckpointUnitOfWorkContractHarness {
  create(): CheckpointUnitOfWork;
  writeSource(contents: Uint8Array): Promise<string>;
  read(identity: SessionIdentity): Promise<SessionArchive | undefined>;
}

const identity = { repositoryId: "contract-repo", sessionId: "contract-session" };

export function checkpointUnitOfWorkContract(
  name: string,
  createHarness: () => Promise<CheckpointUnitOfWorkContractHarness>,
): void {
  describe(`${name} CheckpointUnitOfWork contract`, () => {
    it("publishes a staged aggregate only after explicit commit", async () => {
      const harness = await createHarness();
      const uow = harness.create();
      const source = await harness.writeSource(Buffer.from("committed session"));
      const stored = await uow.objects.putFile(source);
      const archive = archiveWithObject(stored.object);
      uow.archives.add(archive);

      await expect(harness.read(identity)).resolves.toBeUndefined();
      await uow.commit();
      await uow.dispose();

      await expect(harness.read(identity)).resolves.toMatchObject({
        record: { revision: 1, sessionObject: stored.object },
      });
    });

    it("publishes no aggregate when rolled back", async () => {
      const harness = await createHarness();
      const uow = harness.create();
      const source = await harness.writeSource(Buffer.from("rolled back session"));
      const stored = await uow.objects.putFile(source);
      uow.archives.add(archiveWithObject(stored.object));

      await uow.rollback();
      await uow.dispose();

      await expect(harness.read(identity)).resolves.toBeUndefined();
    });

    it("refuses to publish an aggregate that references a missing object", async () => {
      const harness = await createHarness();
      const uow = harness.create();
      const missing: ObjectReference = {
        algorithm: "sha256",
        digest: "a".repeat(64),
        encoding: "gzip",
        logicalBytes: 1,
        storedBytes: 1,
        relativePath: `objects/sha256/aa/${"a".repeat(64)}.gz`,
      };
      uow.archives.add(archiveWithObject(missing));

      await expect(uow.commit()).rejects.toThrow("missing CAS object");
      await uow.rollback();
      await uow.dispose();
      await expect(harness.read(identity)).resolves.toBeUndefined();
    });
  });
}

function archiveWithObject(object: ObjectReference): SessionArchive {
  const archive = SessionArchive.create(identity);
  archive.recordCheckpoint({
    source: { size: object.logicalBytes, mtimeMs: 1, sha256: object.digest },
    sessionObject: object,
    artifacts: [],
    capturedAt: "2026-08-03T12:00:00.000Z",
    lastVerifiedAt: "2026-08-03T12:00:00.000Z",
  });
  return archive;
}
