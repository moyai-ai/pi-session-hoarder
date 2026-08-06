import type { ObjectReference } from "../domain/model.js";
import type { RemoteObjectReceipt } from "../domain/replica.js";

export interface RemoteEncodedObjectPayload {
  contentLength: number;
  checksumSha256?: string;
  body: AsyncIterable<Uint8Array>;
}

export interface RemoteObjectRetriever {
  retrieve(
    object: ObjectReference,
    receipt: RemoteObjectReceipt,
    signal?: AbortSignal,
  ): Promise<RemoteEncodedObjectPayload>;
}

export interface LocalHydrationStore {
  has(digest: string): Promise<boolean>;
  install(
    object: ObjectReference,
    payload: RemoteEncodedObjectPayload,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface RetrievalPreview {
  objectCount: number;
  encodedBytes: number;
}

export interface RetrievalConfirmation {
  confirm(preview: RetrievalPreview): Promise<boolean>;
}
