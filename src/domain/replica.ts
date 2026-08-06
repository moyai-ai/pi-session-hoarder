import {
  assertCanonicalUtcTimestamp,
  type ObjectReference,
  type SessionIdentity,
} from "./model.js";

export interface ReplicaIdentity extends SessionIdentity {
  targetId: string;
}

export interface RemoteObjectReceipt {
  object: ObjectReference;
  key: string;
  etag?: string;
  versionId?: string;
  checksumSha256?: string;
}

export interface SessionReplicaRecord extends ReplicaIdentity {
  schemaVersion: 1;
  revision: number;
  objects: readonly RemoteObjectReceipt[];
  verifiedAt: string;
}

export interface RecordVerifiedReplicaInput {
  revision: number;
  objects: readonly RemoteObjectReceipt[];
  verifiedAt: string;
}

/** Aggregate root for one target/repository/Pi-session replication state. */
export class SessionReplica {
  readonly identity: ReplicaIdentity;
  private current?: SessionReplicaRecord;

  private constructor(identity: ReplicaIdentity, current?: SessionReplicaRecord) {
    assertReplicaIdentity(identity);
    this.identity = { ...identity };
    if (current) {
      assertReplicaRecord(current);
      if (!sameIdentity(identity, current)) {
        throw new Error("Session replica record identity does not match its aggregate identity.");
      }
      this.current = structuredClone(current);
    }
  }

  static create(identity: ReplicaIdentity): SessionReplica {
    return new SessionReplica(identity);
  }

  static rehydrate(record: SessionReplicaRecord): SessionReplica {
    return new SessionReplica(
      {
        targetId: record.targetId,
        repositoryId: record.repositoryId,
        sessionId: record.sessionId,
      },
      record,
    );
  }

  get record(): SessionReplicaRecord | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }

  get revision(): number {
    return this.current?.revision ?? 0;
  }

  coversRevision(revision: number): boolean {
    return this.revision >= revision;
  }

  recordVerifiedRevision(input: RecordVerifiedReplicaInput): SessionReplicaRecord {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new Error("Replicated archive revision must be a positive safe integer.");
    }
    if (input.revision <= this.revision) {
      throw new Error(
        `Replicated archive revision must advance beyond ${this.revision}; received ${input.revision}.`,
      );
    }
    const record: SessionReplicaRecord = {
      schemaVersion: 1,
      ...this.identity,
      revision: input.revision,
      objects: structuredClone(input.objects),
      verifiedAt: input.verifiedAt,
    };
    assertReplicaRecord(record);
    this.current = record;
    return structuredClone(record);
  }
}

function assertReplicaRecord(record: SessionReplicaRecord): void {
  assertReplicaIdentity(record);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new Error("Session replica revision must be a positive safe integer.");
  }
  if (record.objects.length === 0) {
    throw new Error("A verified session replica must reference at least one object.");
  }
  const digests = new Set<string>();
  for (const receipt of record.objects) {
    assertReceipt(receipt);
    if (digests.has(receipt.object.digest)) {
      throw new Error(`Session replica contains duplicate object ${receipt.object.digest}.`);
    }
    digests.add(receipt.object.digest);
  }
  assertCanonicalUtcTimestamp(record.verifiedAt, "verifiedAt");
}

function assertReceipt(receipt: RemoteObjectReceipt): void {
  if (receipt.key.length === 0) throw new Error("Remote object receipt key must not be empty.");
  if (!/^[a-f0-9]{64}$/.test(receipt.object.digest)) {
    throw new Error(`Invalid replicated SHA-256 digest: ${receipt.object.digest}.`);
  }
  if (
    !Number.isSafeInteger(receipt.object.logicalBytes) ||
    receipt.object.logicalBytes < 0 ||
    !Number.isSafeInteger(receipt.object.storedBytes) ||
    receipt.object.storedBytes < 0
  ) {
    throw new Error("Replicated object byte sizes must be non-negative safe integers.");
  }
}

function assertReplicaIdentity(identity: ReplicaIdentity): void {
  if (identity.targetId.length === 0) throw new Error("targetId must not be empty.");
  if (identity.repositoryId.length === 0) throw new Error("repositoryId must not be empty.");
  if (identity.sessionId.length === 0) throw new Error("sessionId must not be empty.");
}

function sameIdentity(left: ReplicaIdentity, right: ReplicaIdentity): boolean {
  return (
    left.targetId === right.targetId &&
    left.repositoryId === right.repositoryId &&
    left.sessionId === right.sessionId
  );
}
