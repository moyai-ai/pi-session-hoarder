import { describe, expect, it } from "vitest";

import type { HoarderDurableStatus } from "../../../src/application/status-query.js";
import type { SessionArchiveRecord } from "../../../src/domain/model.js";
import { ActiveSession } from "../../../src/entrypoints/active-session.js";

const timestamp = "2026-08-06T12:00:00.000Z";

function record(revision: number, digestCharacter: string): SessionArchiveRecord {
  const digest = digestCharacter.repeat(64);
  return {
    schemaVersion: 3,
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
    },
    artifacts: [],
    capturedAt: timestamp,
    lastVerifiedAt: timestamp,
  };
}

function durable(archive?: SessionArchiveRecord): HoarderDurableStatus {
  return {
    ...(archive
      ? {
          archive,
          localRevision: archive.revision,
          publishedRevision: archive.revision,
          referencedObjects: 1,
          localObjects: 1,
        }
      : { referencedObjects: 0, localObjects: 0 }),
    target: "local",
    remoteVerifiedObjects: 0,
    remoteOnlyObjects: 0,
    remoteOnlyStoredBytes: 0,
    lazyRetrieval: "off",
    warnings: [],
  };
}

function runtime() {
  return new ActiveSession(
    {
      cwd: "/project",
      sessionId: "session",
      sessionFile: "/session.jsonl",
      isProjectTrusted: true,
      hasUi: false,
      renderStatus: () => undefined,
      clearStatus: () => undefined,
    },
    1,
    {
      setInterval: () => 1,
      clearInterval: () => undefined,
    },
    () => true,
  );
}

describe("ActiveSession durable status refresh", () => {
  it("rejects out-of-order refresh completion", () => {
    const active = runtime();
    const older = active.beginStatusRefresh();
    const newer = active.beginStatusRefresh();

    expect(active.applyDurableStatus(newer, durable(record(2, "b")))).toBe(true);
    expect(active.applyDurableStatus(older, durable(record(1, "a")))).toBe(false);
    expect(active.record?.revision).toBe(2);
    expect(active.durable?.localRevision).toBe(2);
  });

  it("keeps the last known committed record when a later read cannot return an archive", () => {
    const active = runtime();
    active.record = record(2, "b");
    const refresh = active.beginStatusRefresh();

    expect(active.applyDurableStatus(refresh, durable())).toBe(true);
    expect(active.record?.revision).toBe(2);
    expect(active.durable?.localRevision).toBeUndefined();
  });
});
