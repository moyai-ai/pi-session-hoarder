import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCasCacheRepository } from "../../../src/adapters/filesystem/local-cache-repository.js";
import { LocalVerifiedReceiptReader } from "../../../src/adapters/filesystem/local-verified-receipt-reader.js";
import { SerializedMaintenanceExclusion } from "../../../src/application/maintenance-exclusion.js";
import { PruneApplicationService } from "../../../src/application/prune-service.js";
import { encodeSessionReplicaRecord } from "../../../src/adapters/filesystem/replica-codec.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

function record(targetId: string, digest: string, revision = 1) {
  const object = {
    algorithm: "sha256" as const,
    digest,
    encoding: "gzip" as const,
    logicalBytes: 10,
    storedBytes: 8,
  };
  return {
    schemaVersion: 1 as const,
    targetId,
    repositoryId: "repo",
    sessionId: "session",
    revision,
    objects: [{ object, key: `prefix/objects/sha256/${digest}.gz`, etag: '"etag"' }],
    verifiedAt: "2026-08-06T12:00:00.000Z",
  };
}

describe("LocalVerifiedReceiptReader", () => {
  it("reads, deduplicates, and target-scopes durable private receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoarder-receipts-"));
    roots.push(root);
    const directory = join(root, "replicas", "backup", "repo");
    await mkdir(directory, { recursive: true });
    const value = record("backup", "a".repeat(64));
    await writeFile(join(directory, "one.json"), encodeSessionReplicaRecord(value));
    await writeFile(
      join(directory, "duplicate.json"),
      encodeSessionReplicaRecord({ ...value, sessionId: "other" }),
    );
    await writeFile(join(directory, "corrupt.json"), "not json");
    await writeFile(join(directory, "ignored.txt"), "not a receipt");

    await expect(new LocalVerifiedReceiptReader(root).list("backup")).resolves.toEqual({
      receipts: value.objects,
      invalidRecords: 1,
    });
    await expect(new LocalVerifiedReceiptReader(root).list("other-target")).resolves.toEqual({
      receipts: [],
      invalidRecords: 0,
    });
  });

  it("retains receipts from every immutable replica revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoarder-receipt-history-"));
    roots.push(root);
    const directory = join(root, "replicas", "backup", "repo", "session");
    await mkdir(directory, { recursive: true });
    const first = record("backup", "a".repeat(64), 1);
    const second = record("backup", "b".repeat(64), 2);
    await writeFile(join(directory, "00001.json"), encodeSessionReplicaRecord(first));
    await writeFile(join(directory, "00002.json"), encodeSessionReplicaRecord(second));
    await writeFile(join(directory, "00003.json"), "not json");

    const inventory = await new LocalVerifiedReceiptReader(root).list("backup");

    expect(inventory.receipts.map((receipt) => receipt.object.digest).sort()).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(inventory.invalidRecords).toBe(1);
  });

  it("keeps objects from historical published revisions prune-eligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoarder-historical-prune-"));
    roots.push(root);
    const receiptDirectory = join(root, "replicas", "backup", "repo", "session");
    const objectDirectory = join(root, "objects", "sha256");
    await Promise.all([
      mkdir(receiptDirectory, { recursive: true }),
      mkdir(objectDirectory, { recursive: true }),
    ]);
    const first = record("backup", "a".repeat(64), 1);
    const second = record("backup", "b".repeat(64), 2);
    await Promise.all([
      writeFile(join(receiptDirectory, "00001.json"), encodeSessionReplicaRecord(first)),
      writeFile(join(receiptDirectory, "00002.json"), encodeSessionReplicaRecord(second)),
      writeFile(join(objectDirectory, `${"a".repeat(64)}.gz`), Buffer.alloc(8)),
      writeFile(join(objectDirectory, `${"b".repeat(64)}.gz`), Buffer.alloc(8)),
    ]);
    const service = new PruneApplicationService({
      cache: new LocalCasCacheRepository(root),
      receipts: new LocalVerifiedReceiptReader(root),
      receiptPolicy: { matches: () => true },
      exclusion: new SerializedMaintenanceExclusion(),
    });

    await expect(service.prune("backup")).resolves.toMatchObject({
      eligibleObjects: 2,
      removedObjects: 2,
      failedObjects: 0,
    });
    await expect(readFile(join(objectDirectory, `${"a".repeat(64)}.gz`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(objectDirectory, `${"b".repeat(64)}.gz`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects unsafe target path segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoarder-receipts-unsafe-"));
    roots.push(root);
    await expect(new LocalVerifiedReceiptReader(root).list("../other")).rejects.toThrow();
  });
});
