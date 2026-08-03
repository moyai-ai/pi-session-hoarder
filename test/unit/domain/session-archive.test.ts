import { describe, expect, it } from "vitest";

import {
  SessionArchive,
  type ObjectReference,
  type SessionArchiveRecord,
} from "../../../src/domain/model.js";

const digest = "a".repeat(64);

function object(hash = digest): ObjectReference {
  return {
    algorithm: "sha256",
    digest: hash,
    encoding: "gzip",
    logicalBytes: 10,
    storedBytes: 8,
    relativePath: `objects/${hash}.gz`,
  };
}

function record(): SessionArchiveRecord {
  return {
    schemaVersion: 1,
    repositoryId: "repo",
    sessionId: "session",
    revision: 1,
    source: { size: 10, mtimeMs: 123, sha256: digest },
    sessionObject: object(),
    artifacts: [],
    capturedAt: "2026-08-03T00:00:00.000Z",
    lastVerifiedAt: "2026-08-03T00:00:00.000Z",
  };
}

describe("SessionArchive aggregate", () => {
  it("owns monotonic checkpoint revisions", () => {
    const archive = SessionArchive.create({ repositoryId: "repo", sessionId: "session" });

    const first = archive.recordCheckpoint({
      source: { size: 10, mtimeMs: 1, sha256: digest },
      sessionObject: object(),
      artifacts: [],
      capturedAt: "first",
      lastVerifiedAt: "first",
    });
    const second = archive.recordCheckpoint({
      source: { size: 11, mtimeMs: 2, sha256: digest },
      sessionObject: object(),
      artifacts: [],
      capturedAt: "second",
      lastVerifiedAt: "second",
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
  });

  it("recognizes unchanged source boundaries", () => {
    const archive = SessionArchive.rehydrate(record());

    expect(archive.isSourceCurrent({ size: 10, mtimeMs: 123 })).toBe(true);
    expect(archive.isSourceCurrent({ size: 11, mtimeMs: 123 })).toBe(false);
  });

  it("enforces source and object digest consistency", () => {
    const archive = SessionArchive.create({ repositoryId: "repo", sessionId: "session" });

    expect(() =>
      archive.recordCheckpoint({
        source: { size: 10, mtimeMs: 1, sha256: "b".repeat(64) },
        sessionObject: object(),
        artifacts: [],
        capturedAt: "now",
        lastVerifiedAt: "now",
      }),
    ).toThrow("must match");
  });

  it("requires captured artifact relations to reference an object", () => {
    const archive = SessionArchive.create({ repositoryId: "repo", sessionId: "session" });

    expect(() =>
      archive.recordCheckpoint({
        source: { size: 10, mtimeMs: 1, sha256: digest },
        sessionObject: object(),
        artifacts: [
          {
            kind: "pi-bash-full-output",
            sourceEntryId: "entry",
            sourceField: "message.details.fullOutputPath",
            state: "captured",
          },
        ],
        capturedAt: "now",
        lastVerifiedAt: "now",
      }),
    ).toThrow("must reference an object");
  });

  it("returns defensive copies instead of exposing aggregate state", () => {
    const archive = SessionArchive.rehydrate(record());
    const first = archive.record!;
    first.source.size = 999;

    expect(archive.record?.source.size).toBe(10);
  });
});
