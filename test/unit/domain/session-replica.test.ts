import { describe, expect, it } from "vitest";

import type { ObjectReference } from "../../../src/domain/model.js";
import {
  SessionReplica,
  type RemoteObjectReceipt,
  type SessionReplicaRecord,
} from "../../../src/domain/replica.js";

const identity = { targetId: "backup", repositoryId: "repo", sessionId: "session" };

function object(digest = "a".repeat(64)): ObjectReference {
  return {
    algorithm: "sha256",
    digest,
    encoding: "gzip",
    logicalBytes: 100,
    storedBytes: 50,
  };
}

function receipt(digest = "a".repeat(64)): RemoteObjectReceipt {
  return {
    object: object(digest),
    key: `objects/sha256/${digest}.gz`,
    etag: `etag-${digest.slice(0, 8)}`,
  };
}

function record(): SessionReplicaRecord {
  return {
    schemaVersion: 1,
    ...identity,
    revision: 3,
    objects: [receipt()],
    verifiedAt: "2026-08-05T12:00:00.000Z",
  };
}

describe("SessionReplica aggregate", () => {
  it("records monotonic verified archive revisions", () => {
    const replica = SessionReplica.create(identity);

    const first = replica.recordVerifiedRevision({
      revision: 3,
      objects: [receipt()],
      verifiedAt: "2026-08-05T12:00:00.000Z",
    });
    const second = replica.recordVerifiedRevision({
      revision: 7,
      objects: [receipt("b".repeat(64))],
      verifiedAt: "2026-08-05T12:01:00.000Z",
    });

    expect(first.revision).toBe(3);
    expect(second.revision).toBe(7);
    expect(replica.coversRevision(7)).toBe(true);
    expect(replica.coversRevision(8)).toBe(false);
  });

  it("rejects stale and duplicate revision publication", () => {
    const replica = SessionReplica.rehydrate(record());

    expect(() =>
      replica.recordVerifiedRevision({
        revision: 3,
        objects: [receipt()],
        verifiedAt: "2026-08-05T12:01:00.000Z",
      }),
    ).toThrow("must advance beyond 3");
  });

  it("requires at least one unique verified object", () => {
    const replica = SessionReplica.create(identity);

    expect(() =>
      replica.recordVerifiedRevision({
        revision: 1,
        objects: [],
        verifiedAt: "2026-08-05T12:00:00.000Z",
      }),
    ).toThrow("at least one object");

    expect(() =>
      replica.recordVerifiedRevision({
        revision: 1,
        objects: [receipt(), receipt()],
        verifiedAt: "2026-08-05T12:00:00.000Z",
      }),
    ).toThrow("duplicate object");
  });

  it("validates receipts and canonical verification timestamps", () => {
    expect(() =>
      SessionReplica.create(identity).recordVerifiedRevision({
        revision: 1,
        objects: [{ ...receipt(), key: "" }],
        verifiedAt: "2026-08-05T12:00:00.000Z",
      }),
    ).toThrow("key must not be empty");

    expect(() =>
      SessionReplica.create(identity).recordVerifiedRevision({
        revision: 1,
        objects: [receipt()],
        verifiedAt: "2026-08-05T12:00:00Z",
      }),
    ).toThrow("verifiedAt must be");
  });

  it("rejects rehydration with a mismatched identity", () => {
    const current = record();

    expect(() => SessionReplica.rehydrate({ ...current, targetId: "" })).toThrow(
      "targetId must not be empty",
    );
  });

  it("returns defensive copies", () => {
    const replica = SessionReplica.rehydrate(record());
    const copy = replica.record!;
    copy.objects[0]!.object.logicalBytes = 999;

    expect(replica.record?.objects[0]?.object.logicalBytes).toBe(100);
  });
});
