import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "typebox";
import * as Value from "typebox/value";

import type {
  CheckpointUnitOfWork,
  CheckpointUnitOfWorkFactory,
  ObjectStore,
  SessionArchiveRepository,
} from "../../application/ports.js";
import {
  SessionArchive,
  type SessionArchiveRecord,
  type SessionIdentity,
} from "../../domain/model.js";
import { atomicWriteFile } from "./atomic-file.js";
import { LocalFileObjectStore } from "./local-object-store.js";

const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const ObjectReferenceSchema = Type.Object(
  {
    algorithm: Type.Literal("sha256"),
    digest: Sha256Schema,
    encoding: Type.Literal("gzip"),
    logicalBytes: Type.Integer({ minimum: 0 }),
    storedBytes: Type.Integer({ minimum: 0 }),
    relativePath: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
const ArtifactRelationSchema = Type.Object(
  {
    kind: Type.Literal("pi-bash-full-output"),
    sourceEntryId: Type.String({ minLength: 1 }),
    sourceField: Type.Literal("message.details.fullOutputPath"),
    state: Type.Union([
      Type.Literal("captured"),
      Type.Literal("missing"),
      Type.Literal("invalid"),
    ]),
    object: Type.Optional(ObjectReferenceSchema),
    warning: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const CheckpointErrorSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    occurredAt: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);
const SessionArchiveRecordSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    repositoryId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    source: Type.Object(
      {
        size: Type.Integer({ minimum: 0 }),
        mtimeMs: Type.Number({ minimum: 0 }),
        sha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
    sessionObject: ObjectReferenceSchema,
    artifacts: Type.Array(ArtifactRelationSchema),
    capturedAt: Type.String({ minLength: 1 }),
    lastVerifiedAt: Type.String({ minLength: 1 }),
    lastError: Type.Optional(CheckpointErrorSchema),
  },
  { additionalProperties: false },
);

export interface LocalArchiveRepositoryDependencies {
  readTextFile(path: string): Promise<string>;
  atomicWrite(path: string, data: string): Promise<void>;
}

const defaultRepositoryDependencies: LocalArchiveRepositoryDependencies = {
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
    this.dependencies = { ...defaultRepositoryDependencies, ...dependencyOverrides };
  }

  async get(identity: SessionIdentity): Promise<SessionArchive | undefined> {
    const key = identityKey(identity);
    const staged = this.pending.get(key);
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
      const expectedRevision = (existing?.revision ?? 0) + 1;
      if (record.revision !== expectedRevision) {
        throw new Error(
          `Stale archive revision for ${record.repositoryId}/${record.sessionId}: expected ${expectedRevision}, received ${record.revision}.`,
        );
      }
      await this.dependencies.atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
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
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`Archive catalog ${path} contains invalid JSON: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    assertSessionArchiveRecord(value, path);
    return value;
  }
}

/**
 * Local UoW atomicity boundary: immutable objects may be written early, but exactly one
 * aggregate catalog becomes visible only on explicit commit. Rollback publishes nothing.
 */
export class LocalCheckpointUnitOfWork implements CheckpointUnitOfWork {
  readonly archives: LocalSessionArchiveRepository;
  readonly objects: ObjectStore;
  private committed = false;
  private disposed = false;

  constructor(archives: LocalSessionArchiveRepository, objects: ObjectStore) {
    this.archives = archives;
    this.objects = objects;
  }

  async commit(): Promise<void> {
    this.assertOpen();
    const staged = this.archives.staged();
    if (staged.length !== 1) {
      throw new Error(`A checkpoint Unit of Work must commit exactly one aggregate; received ${staged.length}.`);
    }
    const [archive] = staged;
    for (const object of archive!.referencedObjects()) {
      if (!(await this.objects.has(object.digest))) {
        throw new Error(`Archive cannot reference missing CAS object ${object.digest}.`);
      }
    }
    await this.archives.persist(archive!);
    this.archives.clear();
    this.committed = true;
  }

  async rollback(): Promise<void> {
    if (this.disposed) return;
    this.archives.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (!this.committed) await this.rollback();
    this.disposed = true;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Unit of Work is already disposed.");
    if (this.committed) throw new Error("Unit of Work is already committed.");
  }
}

export class LocalCheckpointUnitOfWorkFactory implements CheckpointUnitOfWorkFactory {
  readonly objectStore: LocalFileObjectStore;
  private readonly storageRoot: string;
  private readonly repositoryDependencies: Partial<LocalArchiveRepositoryDependencies>;

  constructor(
    storageRoot: string,
    repositoryDependencies: Partial<LocalArchiveRepositoryDependencies> = {},
  ) {
    this.storageRoot = storageRoot;
    this.objectStore = new LocalFileObjectStore(storageRoot);
    this.repositoryDependencies = repositoryDependencies;
  }

  create(): CheckpointUnitOfWork {
    return new LocalCheckpointUnitOfWork(
      new LocalSessionArchiveRepository(this.storageRoot, this.repositoryDependencies),
      this.objectStore,
    );
  }
}

function assertSessionArchiveRecord(
  value: unknown,
  location: string,
): asserts value is SessionArchiveRecord {
  if (Value.Check(SessionArchiveRecordSchema, value)) return;
  const first = Value.Errors(SessionArchiveRecordSchema, value)[0];
  const detail = first
    ? `${first.instancePath || "/"}: ${first.message}`
    : "unknown validation error";
  throw new Error(`Invalid session archive record at ${location}: ${detail}`);
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
