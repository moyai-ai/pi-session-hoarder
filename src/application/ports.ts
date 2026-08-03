import type {
  ArtifactRelation,
  ObjectReference,
  SessionArchive,
  SessionIdentity,
} from "../domain/model.js";

export interface SessionArchiveRepository {
  get(identity: SessionIdentity): Promise<SessionArchive | undefined>;
  add(archive: SessionArchive): void;
}

export interface ObjectStorePutResult {
  object: ObjectReference;
  absolutePath: string;
}

export interface ObjectStoreVerification {
  valid: boolean;
  digest: string;
  logicalBytes: number;
}

export interface ObjectStore {
  putFile(path: string, signal?: AbortSignal): Promise<ObjectStorePutResult>;
  has(digest: string): Promise<boolean>;
  verify(object: ObjectReference, signal?: AbortSignal): Promise<ObjectStoreVerification>;
}

export interface CheckpointUnitOfWork {
  readonly archives: SessionArchiveRepository;
  readonly objects: ObjectStore;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CheckpointUnitOfWorkFactory {
  create(): CheckpointUnitOfWork;
}

export interface SourceBoundary {
  size: number;
  mtimeMs: number;
}

export interface CapturedSessionSnapshot extends SourceBoundary {
  path: string;
  sourcePath: string;
  dispose(): Promise<void>;
}

export interface SessionSnapshotter {
  inspect(sourcePath: string): Promise<SourceBoundary | undefined>;
  capture(
    sourcePath: string,
    boundary: SourceBoundary,
    signal?: AbortSignal,
  ): Promise<CapturedSessionSnapshot>;
}

export interface DiscoveredArtifact {
  path?: string;
  relation: ArtifactRelation;
}

export interface ArtifactDiscovery {
  discover(sessionSnapshotPath: string): Promise<readonly DiscoveredArtifact[]>;
}

export interface Clock {
  now(): Date;
}
