import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalVerifiedReceiptReader } from "../../../src/adapters/filesystem/local-verified-receipt-reader.js";
import { encodeSessionReplicaRecord } from "../../../src/adapters/filesystem/replica-codec.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

function record(targetId: string, digest: string) {
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
    revision: 1,
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

  it("rejects unsafe target path segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoarder-receipts-unsafe-"));
    roots.push(root);
    await expect(new LocalVerifiedReceiptReader(root).list("../other")).rejects.toThrow();
  });
});
