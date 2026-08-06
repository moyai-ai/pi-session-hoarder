import { describe, expect, it, vi } from "vitest";

import { ProjectCatalogApplicationService } from "../../../src/application/project-catalog.js";
import { SessionReplica } from "../../../src/domain/replica.js";
import type { SessionArchiveRecord } from "../../../src/domain/model.js";

const session = object("a");
const artifact = object("b");

function object(character: string) {
  return {
    algorithm: "sha256" as const,
    digest: character.repeat(64),
    encoding: "gzip" as const,
    logicalBytes: 100,
    storedBytes: 80,
  };
}

function archive(): SessionArchiveRecord {
  return {
    schemaVersion: 2,
    repositoryId: "repo",
    sessionId: "session",
    revision: 3,
    source: { size: 100, mtimeMs: 1, sha256: session.digest },
    sessionObject: session,
    artifacts: [
      {
        kind: "pi-bash-full-output",
        sourceEntryId: "entry",
        sourceField: "message.details.fullOutputPath",
        state: "captured",
        object: artifact,
        warning: "/private/path must never project",
      },
    ],
    capturedAt: "2026-08-06T12:00:00.000Z",
    lastVerifiedAt: "2026-08-06T12:00:00.000Z",
    lastError: {
      code: "PRIVATE",
      message: "secret operational detail",
      occurredAt: "2026-08-06T12:00:00.000Z",
      retryable: true,
    },
  };
}

function replica(revision = 3) {
  const value = SessionReplica.create({
    targetId: "backup",
    repositoryId: "repo",
    sessionId: "session",
  });
  value.recordVerifiedRevision({
    revision,
    verifiedAt: "2026-08-06T12:00:00.000Z",
    objects: [session, artifact].map((reference) => ({
      object: reference,
      key: `prefix/objects/sha256/${reference.digest}.gz`,
      etag: `"${reference.digest.slice(0, 8)}"`,
      checksumSha256: "encoded-checksum",
    })),
  });
  return value;
}

function setup(options: { local?: readonly string[]; replica?: SessionReplica } = {}) {
  let written: unknown;
  const writer = vi.fn(async (_root, _sessionId, catalog) => {
    written = catalog;
    return "/worktree/.pi/session-hoarder/catalog/session.json";
  });
  const service = new ProjectCatalogApplicationService({
    git: {
      inspect: async () => ({
        worktreeRoot: "/worktree",
        head: "c".repeat(40),
        branch: "feature",
        detached: false,
        dirty: true,
      }),
    },
    writer: { write: writer },
    local: { has: async (digest) => (options.local ?? []).includes(digest) },
    replicas: { get: async () => options.replica },
    remotePolicy: {
      matches: (reference, receipt) =>
        receipt.key === `prefix/objects/sha256/${reference.digest}.gz`,
    },
  });
  return { service, writer, written: () => written };
}

const target = {
  targetId: "backup",
  bucket: "private-bucket",
  region: "us-east-1",
  prefix: "prefix",
  endpoint: "https://credentials.invalid?token=secret",
  profile: "private-profile",
  forcePathStyle: false,
};

describe("ProjectCatalogApplicationService", () => {
  it("publishes a PR-safe local projection without private content", async () => {
    const context = setup({ local: [session.digest, artifact.digest] });
    await expect(
      context.service.publish({
        cwd: "/worktree/subdir",
        trusted: true,
        archive: archive(),
        storageTarget: "local",
      }),
    ).resolves.toEqual({ revision: 3, path: "/worktree/.pi/session-hoarder/catalog/session.json" });
    const text = JSON.stringify(context.written());
    expect(text).not.toContain("/private/path");
    expect(text).not.toContain("secret operational detail");
    expect(text).not.toContain("worktreeRoot");
    expect(context.written()).toMatchObject({
      schemaVersion: 1,
      revision: 3,
      git: { head: "c".repeat(40), branch: "feature", detached: false, dirty: true },
      sessionObject: { locations: [{ kind: "local-cas" }] },
      artifacts: [{ state: "captured", object: { locations: [{ kind: "local-cas" }] } }],
    });
  });

  it("serializes mixed verified local and globally configured S3 locations", async () => {
    const context = setup({ local: [session.digest], replica: replica() });
    await context.service.publish({
      cwd: "/worktree",
      trusted: true,
      archive: archive(),
      storageTarget: "s3",
      s3: target,
    });
    expect(context.written()).toMatchObject({
      sessionObject: {
        locations: [
          { kind: "local-cas" },
          { kind: "s3", targetId: "backup", bucket: "private-bucket", region: "us-east-1" },
        ],
      },
      artifacts: [{ object: { locations: [{ kind: "s3", targetId: "backup" }] } }],
    });
    const text = JSON.stringify(context.written());
    expect(text).not.toContain("credentials.invalid");
    expect(text).not.toContain("private-profile");
  });

  it("requires trust, a worktree, local bytes, and matching S3 publication", async () => {
    const local = setup();
    await expect(
      local.service.publish({
        cwd: "/x",
        trusted: false,
        archive: archive(),
        storageTarget: "local",
      }),
    ).rejects.toThrow("trusted");
    await expect(
      local.service.publish({
        cwd: "/x",
        trusted: true,
        archive: archive(),
        storageTarget: "local",
      }),
    ).rejects.toThrow("unavailable");
    const stale = setup({ local: [session.digest, artifact.digest], replica: replica(2) });
    await expect(
      stale.service.publish({
        cwd: "/x",
        trusted: true,
        archive: archive(),
        storageTarget: "s3",
        s3: target,
      }),
    ).rejects.toThrow("matching verified S3 replica");
    const noGit = new ProjectCatalogApplicationService({
      git: { inspect: async () => undefined },
      writer: { write: vi.fn() },
      local: { has: async () => true },
      replicas: { get: async () => undefined },
    });
    await expect(
      noGit.publish({ cwd: "/x", trusted: true, archive: archive(), storageTarget: "local" }),
    ).rejects.toThrow("Git worktree");
  });
});
