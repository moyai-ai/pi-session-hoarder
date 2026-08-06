import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { SessionReplicaRepository } from "../../application/replication-ports.js";
import {
  SessionReplica,
  type ReplicaIdentity,
  type SessionReplicaRecord,
} from "../../domain/replica.js";
import { atomicWriteFile, serializeFileOperation } from "./atomic-file.js";
import { hasErrorCode, readOptionalTextRecord, validatePathSegment } from "./file-errors.js";
import { decodeSessionReplicaRecord, encodeSessionReplicaRecord } from "./replica-codec.js";

export interface LocalReplicaRepositoryDependencies {
  readTextFile(path: string): Promise<string>;
  readDirectory(path: string): Promise<Dirent[]>;
  atomicWrite(path: string, data: string): Promise<void>;
}

const defaultDependencies: LocalReplicaRepositoryDependencies = {
  readTextFile: (path) => readFile(path, "utf8"),
  readDirectory: (path) => readdir(path, { withFileTypes: true }),
  atomicWrite: atomicWriteFile,
};

const REVISION_FILE = /^(\d+)\.json$/;
const REVISION_WIDTH = 5;

/** Filesystem repository for target-specific SessionReplica aggregates. */
export class LocalSessionReplicaRepository implements SessionReplicaRepository {
  readonly root: string;
  private readonly dependencies: LocalReplicaRepositoryDependencies;
  private pending?: SessionReplica;

  constructor(
    storageRoot: string,
    dependencyOverrides: Partial<LocalReplicaRepositoryDependencies> = {},
  ) {
    this.root = join(storageRoot, "replicas");
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides };
  }

  async get(identity: ReplicaIdentity): Promise<SessionReplica | undefined> {
    if (this.pending && sameIdentity(this.pending.identity, identity)) return this.pending;
    const record = await this.readLatestRecord(identity);
    return record ? SessionReplica.rehydrate(record) : undefined;
  }

  add(replica: SessionReplica): void {
    if (!replica.record) throw new Error("Cannot stage a replica without a verified revision.");
    if (this.pending && !sameIdentity(this.pending.identity, replica.identity)) {
      throw new Error("A replication Unit of Work may stage only one replica aggregate.");
    }
    this.pending = replica;
  }

  staged(): SessionReplica | undefined {
    return this.pending;
  }

  clear(): void {
    this.pending = undefined;
  }

  async persist(replica: SessionReplica): Promise<void> {
    const record = replica.record;
    if (!record) throw new Error("Cannot persist a replica without a verified revision.");
    const serializationKey = this.revisionDirectory(replica.identity);
    await serializeFileOperation(serializationKey, async () => {
      const existing = await this.readLatestRecord(replica.identity);
      assertRevisionAdvances(record, existing);
      await this.dependencies.atomicWrite(
        this.revisionRecordPath(replica.identity, record.revision),
        encodeSessionReplicaRecord(record),
      );
    });
  }

  /** Legacy latest-only record path retained for backward-compatible reads. */
  recordPath(identity: ReplicaIdentity): string {
    this.validateIdentity(identity);
    return join(this.root, identity.targetId, identity.repositoryId, `${identity.sessionId}.json`);
  }

  /** Immutable record path for one successfully published replica revision. */
  revisionRecordPath(identity: ReplicaIdentity, revision: number): string {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error(`Invalid replica revision: ${revision}.`);
    }
    return join(
      this.revisionDirectory(identity),
      `${String(revision).padStart(REVISION_WIDTH, "0")}.json`,
    );
  }

  private revisionDirectory(identity: ReplicaIdentity): string {
    this.validateIdentity(identity);
    return join(this.root, identity.targetId, identity.repositoryId, identity.sessionId);
  }

  private async readLatestRecord(
    identity: ReplicaIdentity,
  ): Promise<SessionReplicaRecord | undefined> {
    const [legacy, revision] = await Promise.all([
      this.readRecord(this.recordPath(identity)),
      this.readLatestRevisionRecord(identity),
    ]);
    if (!legacy) return revision;
    if (!revision) return legacy;
    return revision.revision >= legacy.revision ? revision : legacy;
  }

  private async readLatestRevisionRecord(
    identity: ReplicaIdentity,
  ): Promise<SessionReplicaRecord | undefined> {
    const directory = this.revisionDirectory(identity);
    const entries = await this.readOptionalDirectory(directory);
    const latest = entries
      .filter((entry) => entry.isFile())
      .flatMap((entry) => {
        const match = REVISION_FILE.exec(entry.name);
        if (!match) return [];
        const revision = Number(match[1]);
        return Number.isSafeInteger(revision) && revision > 0
          ? [{ name: entry.name, revision }]
          : [];
      })
      .sort((left, right) => right.revision - left.revision)[0];
    if (!latest) return undefined;
    const path = join(directory, latest.name);
    const record = await this.readRecord(path);
    if (!record) return undefined;
    if (record.revision !== latest.revision) {
      throw new Error(
        `Replica record revision ${record.revision} does not match revision file ${path}.`,
      );
    }
    return record;
  }

  private async readRecord(path: string): Promise<SessionReplicaRecord | undefined> {
    const text = await readOptionalTextRecord(
      path,
      this.dependencies.readTextFile,
      "session replica",
    );
    return text === undefined ? undefined : decodeSessionReplicaRecord(text, path);
  }

  private async readOptionalDirectory(path: string): Promise<Dirent[]> {
    try {
      return await this.dependencies.readDirectory(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  private validateIdentity(identity: ReplicaIdentity): void {
    validatePathSegment(identity.targetId, "targetId", "replica");
    validatePathSegment(identity.repositoryId, "repositoryId", "replica");
    validatePathSegment(identity.sessionId, "sessionId", "replica");
  }
}

function assertRevisionAdvances(
  record: SessionReplicaRecord,
  existing: SessionReplicaRecord | undefined,
): void {
  if (!existing || record.revision > existing.revision) return;
  throw new Error(
    `Stale replica revision for ${record.targetId}/${record.repositoryId}/${record.sessionId}: existing ${existing.revision}, received ${record.revision}.`,
  );
}

function sameIdentity(left: ReplicaIdentity, right: ReplicaIdentity): boolean {
  return (
    left.targetId === right.targetId &&
    left.repositoryId === right.repositoryId &&
    left.sessionId === right.sessionId
  );
}
