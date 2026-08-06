import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SessionArchiveRepository } from "../../application/ports.js";
import {
  SessionArchive,
  type SessionArchiveRecord,
  type SessionIdentity,
} from "../../domain/model.js";
import { atomicWriteFile, serializeFileOperation } from "./atomic-file.js";
import { decodeSessionArchiveRecord, encodeSessionArchiveRecord } from "./catalog-codec.js";
import { readOptionalTextRecord, validatePathSegment } from "./file-errors.js";

export interface LocalArchiveRepositoryDependencies {
  readTextFile(path: string): Promise<string>;
  atomicWrite(path: string, data: string): Promise<void>;
}

const defaultDependencies: LocalArchiveRepositoryDependencies = {
  readTextFile: (path) => readFile(path, "utf8"),
  atomicWrite: atomicWriteFile,
};

/** Repository adapter for the SessionArchive aggregate. Writes are staged until UoW commit. */
export class LocalSessionArchiveRepository implements SessionArchiveRepository {
  readonly root: string;
  private readonly dependencies: LocalArchiveRepositoryDependencies;
  private readonly pending = new Map<string, SessionArchive>();

  constructor(
    storageRoot: string,
    dependencyOverrides: Partial<LocalArchiveRepositoryDependencies> = {},
  ) {
    this.root = join(storageRoot, "catalog");
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides };
  }

  async get(identity: SessionIdentity): Promise<SessionArchive | undefined> {
    const staged = this.pending.get(identityKey(identity));
    if (staged) return staged;
    const record = await this.readRecord(identity);
    return record ? SessionArchive.rehydrate(record) : undefined;
  }

  add(archive: SessionArchive): void {
    if (!archive.record) throw new Error("Cannot stage an archive without a checkpoint revision.");
    this.pending.set(identityKey(archive.identity), archive);
  }

  staged(): readonly SessionArchive[] {
    return [...this.pending.values()];
  }

  clear(): void {
    this.pending.clear();
  }

  async committedRecord(identity: SessionIdentity): Promise<SessionArchiveRecord | undefined> {
    return this.readRecord(identity);
  }

  async persist(archive: SessionArchive): Promise<void> {
    const record = archive.record;
    if (!record) throw new Error("Cannot persist an archive without a checkpoint revision.");
    const path = this.recordPath(archive.identity);
    await serializeFileOperation(path, async () => {
      const existing = await this.readRecord(archive.identity);
      assertNextRevision(record, existing);
      await this.dependencies.atomicWrite(path, encodeSessionArchiveRecord(record));
    });
  }

  recordPath(identity: SessionIdentity): string {
    validatePathSegment(identity.repositoryId, "repositoryId", "archive");
    validatePathSegment(identity.sessionId, "sessionId", "archive");
    return join(this.root, identity.repositoryId, `${identity.sessionId}.json`);
  }

  private async readRecord(identity: SessionIdentity): Promise<SessionArchiveRecord | undefined> {
    const path = this.recordPath(identity);
    const text = await readOptionalTextRecord(
      path,
      this.dependencies.readTextFile,
      "archive catalog",
    );
    return text === undefined ? undefined : decodeSessionArchiveRecord(text, path);
  }
}

function assertNextRevision(
  record: SessionArchiveRecord,
  existing: SessionArchiveRecord | undefined,
): void {
  const expectedRevision = (existing?.revision ?? 0) + 1;
  if (record.revision === expectedRevision) return;
  throw new Error(
    `Stale archive revision for ${record.repositoryId}/${record.sessionId}: expected ${expectedRevision}, received ${record.revision}.`,
  );
}

function identityKey(identity: SessionIdentity): string {
  return `${identity.repositoryId}\0${identity.sessionId}`;
}
