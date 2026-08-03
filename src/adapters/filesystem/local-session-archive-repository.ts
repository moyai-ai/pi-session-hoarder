import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SessionArchiveRepository } from "../../application/ports.js";
import {
  SessionArchive,
  type SessionArchiveRecord,
  type SessionIdentity,
} from "../../domain/model.js";
import { atomicWriteFile } from "./atomic-file.js";
import {
  decodeSessionArchiveRecord,
  encodeSessionArchiveRecord,
} from "./catalog-codec.js";
import { hasErrorCode } from "./file-errors.js";

export interface LocalArchiveRepositoryDependencies {
  readTextFile(path: string): Promise<string>;
  atomicWrite(path: string, data: string): Promise<void>;
}

const defaultDependencies: LocalArchiveRepositoryDependencies = {
  readTextFile: (path) => readFile(path, "utf8"),
  atomicWrite: atomicWriteFile,
};
const commitQueues = new Map<string, Promise<unknown>>();

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

  async persist(archive: SessionArchive): Promise<void> {
    const record = archive.record;
    if (!record) throw new Error("Cannot persist an archive without a checkpoint revision.");
    const path = this.recordPath(archive.identity);
    await enqueue(path, async () => {
      const existing = await this.readRecord(archive.identity);
      assertNextRevision(record, existing);
      await this.dependencies.atomicWrite(path, encodeSessionArchiveRecord(record));
    });
  }

  recordPath(identity: SessionIdentity): string {
    validatePathSegment(identity.repositoryId, "repositoryId");
    validatePathSegment(identity.sessionId, "sessionId");
    return join(this.root, identity.repositoryId, `${identity.sessionId}.json`);
  }

  private async readRecord(identity: SessionIdentity): Promise<SessionArchiveRecord | undefined> {
    const path = this.recordPath(identity);
    let text: string;
    try {
      text = await this.dependencies.readTextFile(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw new Error(`Unable to read archive catalog ${path}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    return decodeSessionArchiveRecord(text, path);
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

function validatePathSegment(value: string, name: string): void {
  if (value.length === 0 || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error(`Invalid archive ${name}: ${JSON.stringify(value)}.`);
  }
}

function enqueue<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = commitQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  commitQueues.set(path, next);
  const cleanup = () => {
    if (commitQueues.get(path) === next) commitQueues.delete(path);
  };
  void next.then(cleanup, cleanup);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
