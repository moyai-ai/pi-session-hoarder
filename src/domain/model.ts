export type RepositoryIdentityKind = "git-remote" | "git-root" | "cwd";

/** Canonical UTC format emitted by Date#toISOString(). */
export const UTC_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const UTC_TIMESTAMP_REGEX = new RegExp(UTC_TIMESTAMP_PATTERN);

export interface RepositoryIdentity {
  kind: RepositoryIdentityKind;
  canonicalValue: string;
  repositoryId: string;
}

export interface SessionIdentity {
  repositoryId: string;
  sessionId: string;
}

export interface ObjectReference {
  algorithm: "sha256";
  digest: string;
  encoding: "gzip";
  logicalBytes: number;
  storedBytes: number;
}

export function sameObjectReference(left: ObjectReference, right: ObjectReference): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.encoding === right.encoding &&
    left.logicalBytes === right.logicalBytes &&
    left.storedBytes === right.storedBytes
  );
}

export type ArtifactSourceState = "present" | "missing" | "invalid";
export type ArtifactArchiveState = "captured" | "unavailable";

export interface ArtifactRelation {
  kind: "pi-bash-full-output";
  sourceEntryId: string;
  sourceField: "message.details.fullOutputPath";
  sourceState: ArtifactSourceState;
  archiveState: ArtifactArchiveState;
  object?: ObjectReference;
  warning?: string;
}

export function artifactRelationKey(
  relation: Pick<ArtifactRelation, "kind" | "sourceEntryId" | "sourceField">,
): string {
  return `${relation.kind}\0${relation.sourceEntryId}\0${relation.sourceField}`;
}

export interface SourceSnapshot {
  size: number;
  mtimeMs: number;
  /** Must match sessionObject.digest for a committed checkpoint. */
  sha256: string;
}

export interface CheckpointRevision {
  revision: number;
  source: SourceSnapshot;
  sessionObject: ObjectReference;
  artifacts: readonly ArtifactRelation[];
  capturedAt: string;
  lastVerifiedAt: string;
}

export interface CheckpointError {
  code: string;
  message: string;
  occurredAt: string;
  retryable: boolean;
}

export interface SessionArchiveRecord extends CheckpointRevision, SessionIdentity {
  schemaVersion: 3;
  lastError?: CheckpointError;
}

export interface RecordCheckpointInput {
  source: SourceSnapshot;
  sessionObject: ObjectReference;
  artifacts: readonly ArtifactRelation[];
  capturedAt: string;
  lastVerifiedAt: string;
}

/** Aggregate root and consistency boundary for one repository/Pi-session pair. */
export class SessionArchive {
  readonly identity: SessionIdentity;
  private current?: SessionArchiveRecord;

  private constructor(identity: SessionIdentity, current?: SessionArchiveRecord) {
    assertIdentity(identity);
    this.identity = { ...identity };
    if (current) {
      assertRecordInvariants(current);
      if (
        current.repositoryId !== identity.repositoryId ||
        current.sessionId !== identity.sessionId
      ) {
        throw new Error("Session archive record identity does not match its aggregate identity.");
      }
      this.current = structuredClone(current);
    }
  }

  static create(identity: SessionIdentity): SessionArchive {
    return new SessionArchive(identity);
  }

  static rehydrate(record: SessionArchiveRecord): SessionArchive {
    return new SessionArchive(
      { repositoryId: record.repositoryId, sessionId: record.sessionId },
      record,
    );
  }

  get record(): SessionArchiveRecord | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }

  get revision(): number {
    return this.current?.revision ?? 0;
  }

  isSourceCurrent(source: Pick<SourceSnapshot, "size" | "mtimeMs">): boolean {
    return Boolean(
      this.current &&
      this.current.source.size === source.size &&
      this.current.source.mtimeMs === source.mtimeMs,
    );
  }

  recordCheckpoint(input: RecordCheckpointInput): SessionArchiveRecord {
    const record: SessionArchiveRecord = {
      schemaVersion: 3,
      ...this.identity,
      revision: this.revision + 1,
      source: structuredClone(input.source),
      sessionObject: structuredClone(input.sessionObject),
      artifacts: structuredClone(input.artifacts),
      capturedAt: input.capturedAt,
      lastVerifiedAt: input.lastVerifiedAt,
    };
    assertRecordInvariants(record);
    this.current = record;
    return structuredClone(record);
  }

  referencedObjects(): readonly ObjectReference[] {
    if (!this.current) return [];
    return [
      structuredClone(this.current.sessionObject),
      ...this.current.artifacts.flatMap((artifact) =>
        artifact.object ? [structuredClone(artifact.object)] : [],
      ),
    ];
  }
}

export type CheckpointStatus =
  | { state: "disabled"; reason?: string }
  | { state: "idle"; revision?: number; lastSuccessAt?: string }
  | { state: "pending"; dirtyReasons: readonly string[] }
  | { state: "running"; startedAt: string }
  | { state: "error"; error: CheckpointError; revision?: number };

function assertIdentity(identity: SessionIdentity): void {
  if (identity.repositoryId.length === 0) throw new Error("repositoryId must not be empty.");
  if (identity.sessionId.length === 0) throw new Error("sessionId must not be empty.");
}

function assertRecordInvariants(record: SessionArchiveRecord): void {
  assertIdentity(record);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new Error("Session archive revision must be a positive safe integer.");
  }
  if (record.source.sha256 !== record.sessionObject.digest) {
    throw new Error("Session source SHA-256 must match the session object digest.");
  }
  assertRecordTimestamps(record);
  for (const artifact of record.artifacts) {
    if (artifact.archiveState === "captured" && !artifact.object) {
      throw new Error("A captured artifact relation must reference an object.");
    }
    if (artifact.archiveState === "unavailable" && artifact.object) {
      throw new Error("An unavailable artifact relation cannot reference an object.");
    }
  }
}

function assertRecordTimestamps(record: SessionArchiveRecord): void {
  assertCanonicalUtcTimestamp(record.capturedAt, "capturedAt");
  assertCanonicalUtcTimestamp(record.lastVerifiedAt, "lastVerifiedAt");
  if (record.lastError) {
    assertCanonicalUtcTimestamp(record.lastError.occurredAt, "lastError.occurredAt");
  }
}

export function assertCanonicalUtcTimestamp(value: string, field: string): void {
  if (!UTC_TIMESTAMP_REGEX.test(value)) {
    throw new Error(`${field} must be a canonical UTC ISO 8601 timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${field} must be a valid canonical UTC ISO 8601 timestamp.`);
  }
}
