import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCheckpointUnitOfWork } from "../../../src/adapters/filesystem/local-unit-of-work.js";
import { LocalSessionArchiveRepository } from "../../../src/adapters/filesystem/local-session-archive-repository.js";
import { LocalFileObjectStore } from "../../../src/adapters/filesystem/local-object-store.js";
import { SessionArchive, type ObjectReference } from "../../../src/domain/model.js";
import { checkpointUnitOfWorkContract } from "../../contracts/checkpoint-unit-of-work.contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-hoarder-uow-"));
  temporaryDirectories.push(root);
  const objects = new LocalFileObjectStore(root);
  const source = join(root, "source.jsonl");
  await writeFile(source, "session bytes\n");
  const stored = await objects.putFile(source);
  return { root, objects, source, stored };
}

function archiveFor(object: ObjectReference, revisionSource = { size: 14, mtimeMs: 1 }) {
  const archive = SessionArchive.create({ repositoryId: "repo-id", sessionId: "session-id" });
  archive.recordCheckpoint({
    source: { ...revisionSource, sha256: object.digest },
    sessionObject: object,
    artifacts: [],
    capturedAt: "2026-08-03T00:00:00.000Z",
    lastVerifiedAt: "2026-08-03T00:00:00.000Z",
  });
  return archive;
}

checkpointUnitOfWorkContract("LocalCheckpointUnitOfWork", async () => {
  const { root, objects, source } = await fixture();
  return {
    create: () => new LocalCheckpointUnitOfWork(new LocalSessionArchiveRepository(root), objects),
    writeSource: async (contents) => {
      await writeFile(source, contents);
      return source;
    },
    read: (identity) => new LocalSessionArchiveRepository(root).get(identity),
  };
});

describe("LocalCheckpointUnitOfWork", () => {
  it("publishes one aggregate only after explicit commit", async () => {
    const { root, objects, stored } = await fixture();
    const repository = new LocalSessionArchiveRepository(root);
    const uow = new LocalCheckpointUnitOfWork(repository, objects);
    const archive = archiveFor(stored.object);
    uow.archives.add(archive);

    await expect(
      new LocalSessionArchiveRepository(root).get(archive.identity),
    ).resolves.toBeUndefined();
    await uow.commit();

    const reloaded = await new LocalSessionArchiveRepository(root).get(archive.identity);
    expect(reloaded?.record).toEqual(archive.record);
  });

  it("rolls back staged catalog changes by default", async () => {
    const { root, objects, stored } = await fixture();
    const repository = new LocalSessionArchiveRepository(root);
    const uow = new LocalCheckpointUnitOfWork(repository, objects);
    const archive = archiveFor(stored.object);
    uow.archives.add(archive);

    await uow.rollback();
    await uow.dispose();

    await expect(
      new LocalSessionArchiveRepository(root).get(archive.identity),
    ).resolves.toBeUndefined();
    expect(await objects.has(stored.object.digest)).toBe(true);
  });

  it("refuses to publish an aggregate that references a missing object", async () => {
    const { root, objects, stored } = await fixture();
    const missing = { ...stored.object, digest: "b".repeat(64) };
    const repository = new LocalSessionArchiveRepository(root);
    const uow = new LocalCheckpointUnitOfWork(repository, objects);
    uow.archives.add(archiveFor(missing));

    await expect(uow.commit()).rejects.toThrow("missing CAS object");
    await expect(
      new LocalSessionArchiveRepository(root).get({
        repositoryId: "repo-id",
        sessionId: "session-id",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects stale concurrent aggregate revisions", async () => {
    const { root, objects, stored } = await fixture();
    const first = archiveFor(stored.object);
    const stale = archiveFor(stored.object, { size: 15, mtimeMs: 2 });
    const firstUow = new LocalCheckpointUnitOfWork(
      new LocalSessionArchiveRepository(root),
      objects,
    );
    const staleUow = new LocalCheckpointUnitOfWork(
      new LocalSessionArchiveRepository(root),
      objects,
    );
    firstUow.archives.add(first);
    staleUow.archives.add(stale);

    await firstUow.commit();
    await expect(staleUow.commit()).rejects.toThrow("expected 2, received 1");
  });

  it("preserves the previous aggregate when the atomic catalog write fails", async () => {
    const { root, objects, stored } = await fixture();
    const initialRepository = new LocalSessionArchiveRepository(root);
    const initialUow = new LocalCheckpointUnitOfWork(initialRepository, objects);
    const initial = archiveFor(stored.object);
    initialUow.archives.add(initial);
    await initialUow.commit();

    const loaded = await new LocalSessionArchiveRepository(root).get(initial.identity);
    if (!loaded) throw new Error("expected persisted archive");
    loaded.recordCheckpoint({
      source: { size: 20, mtimeMs: 2, sha256: stored.object.digest },
      sessionObject: stored.object,
      artifacts: [],
      capturedAt: "2026-08-03T00:00:01.000Z",
      lastVerifiedAt: "2026-08-03T00:00:01.000Z",
    });
    const failingRepository = new LocalSessionArchiveRepository(root, {
      atomicWrite: async () => {
        throw new Error("simulated interruption");
      },
    });
    const failingUow = new LocalCheckpointUnitOfWork(failingRepository, objects);
    failingUow.archives.add(loaded);

    await expect(failingUow.commit()).rejects.toThrow("simulated interruption");
    const unchanged = await new LocalSessionArchiveRepository(root).get(initial.identity);
    expect(unchanged?.record).toEqual(initial.record);
  });

  it("requires exactly one aggregate per checkpoint Unit of Work", async () => {
    const { root, objects } = await fixture();
    const uow = new LocalCheckpointUnitOfWork(new LocalSessionArchiveRepository(root), objects);

    await expect(uow.commit()).rejects.toThrow("exactly one aggregate");
  });

  it("fails explicitly for malformed catalog data", async () => {
    const { root } = await fixture();
    const repository = new LocalSessionArchiveRepository(root);
    const path = repository.recordPath({ repositoryId: "repo-id", sessionId: "session-id" });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json");

    await expect(
      repository.get({ repositoryId: "repo-id", sessionId: "session-id" }),
    ).rejects.toThrow("contains invalid JSON");
  });

  it.each([
    ["2026-08-03T00:00:00.000+00:00", "Invalid session archive record"],
    ["2026-02-30T00:00:00.000Z", "capturedAt must be a valid"],
  ])("rejects persisted non-UTC or invalid timestamp %s", async (capturedAt, error) => {
    const { root, stored } = await fixture();
    const repository = new LocalSessionArchiveRepository(root);
    const identity = { repositoryId: "repo-id", sessionId: "session-id" };
    const path = repository.recordPath(identity);
    const record = archiveFor(stored.object).record!;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ ...record, capturedAt }));

    await expect(repository.get(identity)).rejects.toThrow(error);
  });

  it("loads schema-v1 catalogs without rewriting them and writes schema v2 on the next commit", async () => {
    const { root, objects, stored } = await fixture();
    const repository = new LocalSessionArchiveRepository(root);
    const identity = { repositoryId: "repo-id", sessionId: "session-id" };
    const path = repository.recordPath(identity);
    const current = archiveFor(stored.object).record!;
    const legacyRecord = {
      ...current,
      schemaVersion: 1,
      sessionObject: {
        ...current.sessionObject,
        relativePath: `objects/sha256/${current.sessionObject.digest}.gz`,
      },
      artifacts: [
        {
          kind: "pi-bash-full-output",
          sourceEntryId: "legacy-artifact",
          sourceField: "message.details.fullOutputPath",
          state: "captured",
          object: {
            ...current.sessionObject,
            relativePath: `objects/sha256/${current.sessionObject.digest}.gz`,
          },
        },
      ],
    };
    const legacyText = `${JSON.stringify(legacyRecord, null, 2)}\n`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, legacyText);

    const loaded = await repository.get(identity);

    expect(loaded?.record).toMatchObject({ schemaVersion: 2, revision: 1 });
    expect(loaded?.record?.sessionObject).not.toHaveProperty("relativePath");
    expect(loaded?.record?.artifacts[0]?.object).not.toHaveProperty("relativePath");
    expect(await readFile(path, "utf8")).toBe(legacyText);

    loaded!.recordCheckpoint({
      source: { size: 20, mtimeMs: 2, sha256: stored.object.digest },
      sessionObject: stored.object,
      artifacts: loaded!.record!.artifacts,
      capturedAt: "2026-08-03T00:00:01.000Z",
      lastVerifiedAt: "2026-08-03T00:00:01.000Z",
    });
    const uow = new LocalCheckpointUnitOfWork(repository, objects);
    uow.archives.add(loaded!);
    await uow.commit();

    const rewritten = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(rewritten).toMatchObject({ schemaVersion: 2, revision: 2 });
    expect(JSON.stringify(rewritten)).not.toContain("relativePath");
  });

  it("validates persisted aggregate records before rehydrating the domain", async () => {
    const { root } = await fixture();
    const repository = new LocalSessionArchiveRepository(root);
    const identity = { repositoryId: "repo-id", sessionId: "session-id" };
    const path = repository.recordPath(identity);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 1 }));

    await expect(repository.get(identity)).rejects.toThrow("Invalid session archive record");
  });

  it("rejects unsupported catalog schema versions explicitly", async () => {
    const { root } = await fixture();
    const repository = new LocalSessionArchiveRepository(root);
    const identity = { repositoryId: "repo-id", sessionId: "session-id" };
    const path = repository.recordPath(identity);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 99 }));

    await expect(repository.get(identity)).rejects.toThrow("unsupported schema version 99");
  });
});
