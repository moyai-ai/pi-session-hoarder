import type { ObjectReference, SessionArchive, SessionIdentity } from "../domain/model.js";
import type { RemoteObjectReceipt, ReplicaIdentity, SessionReplica } from "../domain/replica.js";
import type { Clock, ObjectStoreVerification } from "./ports.js";

export interface SessionArchiveReader {
  get(identity: SessionIdentity): Promise<SessionArchive | undefined>;
}

export interface VerifiableEncodedObjectPayload {
  contentLength: number;
  /** Base64-encoded SHA-256 of the encoded gzip bytes when supplied by the transport. */
  checksumSha256?: string;
  body: AsyncIterable<Uint8Array>;
}

export interface EncodedObjectPayload extends VerifiableEncodedObjectPayload {
  checksumSha256: string;
}

export interface EncodedObjectSource {
  verifyLogical(object: ObjectReference, signal?: AbortSignal): Promise<ObjectStoreVerification>;
  openEncoded(object: ObjectReference, signal?: AbortSignal): Promise<EncodedObjectPayload>;
}

export interface RemoteObjectVerification {
  valid: boolean;
}

export interface RemoteObjectMetadata {
  contentLength?: number;
  etag?: string;
  versionId?: string;
  checksumSha256?: string;
}

export type RemoteObjectObservation =
  | { state: "absent" }
  | {
      state: "untrusted-present";
      key: string;
      metadata: RemoteObjectMetadata;
    };

export interface RemoteUntrustedObjectPayload extends VerifiableEncodedObjectPayload {
  key: string;
  checksumSha256?: string;
  etag?: string;
  versionId?: string;
}

export interface RemoteObjectPutInput extends EncodedObjectPayload {
  object: ObjectReference;
}

export type RemoteObjectPutResult =
  | { state: "uploaded"; receipt: RemoteObjectReceipt }
  | { state: "conflict"; observation: RemoteObjectObservation };

export interface EncodedObjectVerifier {
  verify(
    object: ObjectReference,
    payload: VerifiableEncodedObjectPayload,
    signal?: AbortSignal,
  ): Promise<RemoteObjectVerification>;
}

export interface ReplicaObjectRepository {
  inspect(object: ObjectReference, signal?: AbortSignal): Promise<RemoteObjectObservation>;
  put(input: RemoteObjectPutInput, signal?: AbortSignal): Promise<RemoteObjectPutResult>;
  verifyTrustedReceipt(
    object: ObjectReference,
    receipt: RemoteObjectReceipt,
    signal?: AbortSignal,
  ): Promise<RemoteObjectVerification>;
  retrieveUntrusted(
    object: ObjectReference,
    observation: Extract<RemoteObjectObservation, { state: "untrusted-present" }>,
    signal?: AbortSignal,
  ): Promise<RemoteUntrustedObjectPayload>;
  matches(object: ObjectReference, receipt: RemoteObjectReceipt): boolean;
}

export interface SessionReplicaRepository {
  get(identity: ReplicaIdentity): Promise<SessionReplica | undefined>;
  add(replica: SessionReplica): void;
}

export interface ReplicationUnitOfWork {
  readonly replicas: SessionReplicaRepository;
  readonly objects: ReplicaObjectRepository;
  commit(signal?: AbortSignal): Promise<void>;
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ReplicationUnitOfWorkFactory {
  create(targetId: string): ReplicationUnitOfWork;
}

export interface ReplicationApplicationDependencies {
  archives: SessionArchiveReader;
  source: EncodedObjectSource;
  verifier: EncodedObjectVerifier;
  unitOfWorkFactory: ReplicationUnitOfWorkFactory;
  clock: Clock;
}
