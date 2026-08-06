import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SessionReplicaRepository } from "../../application/replication-ports.js";
import {
  SessionReplica,
  type ReplicaIdentity,
  type SessionReplicaRecord,
} from "../../domain/replica.js";
import { atomicWriteFile, serializeFileOperation } from "./atomic-file.js";
import { readOptionalTextRecord, validatePathSegment } from "./file-errors.js";
import { decodeSessionReplicaRecord, encodeSessionReplicaRecord } from "./replica-codec.js";

export interface LocalReplicaRepositoryDependencies {
  readTextFile(path: string): Promise<string>;
  atomicWrite(path: string, data: string): Promise<void>;
}

const defaultDependencies: LocalReplicaRepositoryDependencies = {
  readTextFile: (path) => readFile(path, "utf8"),
  atomicWrite: atomicWriteFile,
};

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
    const record = await this.readRecord(identity);
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
    const path = this.recordPath(replica.identity);
    await serializeFileOperation(path, async () => {
      const existing = await this.readRecord(replica.identity);
      assertRevisionAdvances(record, existing);
      await this.dependencies.atomicWrite(path, encodeSessionReplicaRecord(record));
    });
  }

  recordPath(identity: ReplicaIdentity): string {
    validatePathSegment(identity.targetId, "targetId", "replica");
    validatePathSegment(identity.repositoryId, "repositoryId", "replica");
    validatePathSegment(identity.sessionId, "sessionId", "replica");
    return join(this.root, identity.targetId, identity.repositoryId, `${identity.sessionId}.json`);
  }

  private async readRecord(identity: ReplicaIdentity): Promise<SessionReplicaRecord | undefined> {
    const path = this.recordPath(identity);
    const text = await readOptionalTextRecord(
      path,
      this.dependencies.readTextFile,
      "session replica",
    );
    return text === undefined ? undefined : decodeSessionReplicaRecord(text, path);
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
