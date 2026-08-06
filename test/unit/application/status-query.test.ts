import { describe, expect, it, vi } from "vitest";

import type { HoarderConfig } from "../../../src/application/configuration.js";
import { LocalHoarderStatusQuery } from "../../../src/application/status-query.js";
import { SessionArchive, type ObjectReference } from "../../../src/domain/model.js";
import { SessionReplica } from "../../../src/domain/replica.js";

const identity = { repositoryId: "repo", sessionId: "session" };
const targetIdentity = { ...identity, targetId: "backup" };
const timestamp = "2026-08-06T12:00:00.000Z";

function object(digestCharacter: string, logicalBytes = 100, storedBytes = 50): ObjectReference {
  return {
    algorithm: "sha256",
    digest: digestCharacter.repeat(64),
    encoding: "gzip",
    logicalBytes,
    storedBytes,
  };
}

function archive(revision = 1) {
  const aggregate = SessionArchive.create(identity);
  for (let current = 1; current <= revision; current += 1) {
    const sessionObject = object(String(current % 10));
    aggregate.recordCheckpoint({
      source: { size: sessionObject.logicalBytes, mtimeMs: current, sha256: sessionObject.digest },
      sessionObject,
      artifacts: [],
      capturedAt: timestamp,
      lastVerifiedAt: timestamp,
    });
  }
  return aggregate;
}

function replica(revision: number, objects: readonly ObjectReference[]) {
  const aggregate = SessionReplica.create(targetIdentity);
  aggregate.recordVerifiedRevision({
    revision,
    objects: objects.map((value) => ({
      object: value,
      key: `session-hoarder/objects/sha256/${value.digest}.gz`,
    })),
    verifiedAt: timestamp,
  });
  return aggregate;
}

function config(storageTarget: "local" | "s3"): HoarderConfig {
  return {
    enabled: true,
    debounceMs: 30_000,
    shutdownTimeoutMs: 3_000,
    storageRoot: "/archive",
    storageTarget,
    ...(storageTarget === "s3"
      ? {
          s3: {
            targetId: "backup",
            bucket: "bucket",
            region: "us-east-1",
            prefix: "session-hoarder",
            forcePathStyle: false,
          },
        }
      : {}),
    gitCatalogEnabled: false,
  };
}

function setup(
  options: {
    archive?: ReturnType<typeof archive>;
    replica?: ReturnType<typeof replica>;
    local?: readonly string[];
    archiveError?: boolean;
    replicaError?: boolean;
  } = {},
) {
  const has = vi.fn(async (digest: string) => options.local?.includes(digest) ?? false);
  const query = new LocalHoarderStatusQuery({
    archives: {
      get: vi.fn(async () => {
        if (options.archiveError) throw new Error("private archive path");
        return options.archive;
      }),
    },
    replicas: {
      get: vi.fn(async () => {
        if (options.replicaError) throw new Error("private replica path");
        return options.replica;
      }),
    },
    local: { has },
  });
  return { query, has };
}

async function read(query: LocalHoarderStatusQuery, storageTarget: "local" | "s3" = "s3") {
  return query.read({ ...identity, config: config(storageTarget) });
}

describe("LocalHoarderStatusQuery", () => {
  it("reports a fresh local session without reading replica state", async () => {
    const context = setup();

    await expect(read(context.query, "local")).resolves.toEqual({
      target: "local",
      referencedObjects: 0,
      localObjects: 0,
      remoteVerifiedObjects: 0,
      remoteOnlyObjects: 0,
      remoteOnlyStoredBytes: 0,
      lazyRetrieval: "off",
      warnings: [],
    });
  });

  it("reports a local archive with no selected-target receipt", async () => {
    const localArchive = archive();
    const digest = localArchive.record!.sessionObject.digest;

    const status = await read(setup({ archive: localArchive, local: [digest] }).query);

    expect(status).toMatchObject({
      localRevision: 1,
      referencedObjects: 1,
      localObjects: 1,
      remoteVerifiedObjects: 0,
      remoteOnlyObjects: 0,
    });
    expect(status).not.toHaveProperty("publishedRevision");
  });

  it("recovers a matching published S3 revision without coordinator history", async () => {
    const localArchive = archive(2);
    const currentObject = localArchive.record!.sessionObject;

    await expect(
      read(
        setup({
          archive: localArchive,
          replica: replica(2, [currentObject]),
          local: [currentObject.digest],
        }).query,
      ),
    ).resolves.toMatchObject({
      localRevision: 2,
      publishedRevision: 2,
      remoteVerifiedObjects: 1,
      remoteOnlyObjects: 0,
      warnings: [],
    });
  });

  it("preserves an older durable published revision while the current revision is unpublished", async () => {
    const currentArchive = archive(2);
    const olderObject = object("1");

    await expect(
      read(
        setup({
          archive: currentArchive,
          replica: replica(1, [olderObject]),
          local: [currentArchive.record!.sessionObject.digest],
        }).query,
      ),
    ).resolves.toMatchObject({
      localRevision: 2,
      publishedRevision: 1,
      remoteVerifiedObjects: 0,
      remoteOnlyObjects: 0,
      warnings: [],
    });
  });

  it("reports exact current-revision remote-only objects after prune", async () => {
    const localArchive = archive();
    const currentObject = localArchive.record!.sessionObject;

    await expect(
      read(setup({ archive: localArchive, replica: replica(1, [currentObject]) }).query),
    ).resolves.toMatchObject({
      publishedRevision: 1,
      referencedObjects: 1,
      localObjects: 0,
      remoteVerifiedObjects: 1,
      remoteOnlyObjects: 1,
      remoteOnlyStoredBytes: currentObject.storedBytes,
      lazyRetrieval: "enabled",
    });
  });

  it("sanitizes an unreadable archive record without throwing", async () => {
    const status = await read(setup({ archiveError: true }).query);

    expect(status).not.toHaveProperty("localRevision");
    expect(status.warnings).toEqual([
      "The durable local archive record is invalid or unavailable.",
    ]);
    expect(status.warnings.join(" ")).not.toContain("private archive path");
  });

  it("ignores stale and malformed selected-target replica records with sanitized warnings", async () => {
    const localArchive = archive();
    const currentObject = localArchive.record!.sessionObject;
    const stale = await read(
      setup({ archive: localArchive, replica: replica(2, [currentObject]) }).query,
    );
    const malformed = await read(setup({ archive: localArchive, replicaError: true }).query);

    expect(stale).toMatchObject({ remoteVerifiedObjects: 0 });
    expect(stale).not.toHaveProperty("publishedRevision");
    expect(stale.warnings).toContain(
      "The selected-target replica is ahead of the local archive and was ignored.",
    );
    expect(malformed.warnings).toEqual([
      "The selected-target replica record is invalid or unavailable.",
    ]);
    expect(malformed.warnings.join(" ")).not.toContain("private replica path");
  });

  it("switches to local using durable archive state without remote calls", async () => {
    const localArchive = archive();
    const dependencies = setup({
      archive: localArchive,
      local: [localArchive.record!.sessionObject.digest],
    });

    await expect(read(dependencies.query, "local")).resolves.toMatchObject({
      localRevision: 1,
      publishedRevision: 1,
      target: "local",
      lazyRetrieval: "off",
    });
    expect(dependencies.has).toHaveBeenCalledOnce();
  });

  it("does not classify unknown local presence as remote-only", async () => {
    const localArchive = archive();
    const currentObject = localArchive.record!.sessionObject;
    const query = new LocalHoarderStatusQuery({
      archives: { get: async () => localArchive },
      replicas: { get: async () => replica(1, [currentObject]) },
      local: { has: async () => Promise.reject(new Error("presence failed")) },
    });

    await expect(read(query)).resolves.toMatchObject({
      remoteVerifiedObjects: 1,
      remoteOnlyObjects: 0,
      warnings: ["Some local object presence checks could not be completed."],
    });
  });
});
