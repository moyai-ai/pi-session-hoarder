import type { ObjectReference } from "../domain/model.js";
import type { RemoteObjectReceipt } from "../domain/replica.js";

export interface LocalCacheObject {
  digest: string;
  encodedBytes: number;
  allocatedBytes: number;
}

export interface LocalCacheRepository {
  inventory(signal?: AbortSignal): Promise<readonly LocalCacheObject[]>;
  remove(object: LocalCacheObject, signal?: AbortSignal): Promise<number>;
}

export interface VerifiedReceiptInventory {
  receipts: readonly RemoteObjectReceipt[];
  invalidRecords: number;
}

export interface VerifiedReceiptReader {
  list(targetId: string, signal?: AbortSignal): Promise<VerifiedReceiptInventory>;
}

export interface RemoteReceiptPolicy {
  matches(object: ObjectReference, receipt: RemoteObjectReceipt): boolean;
}

export interface PrunePreview {
  localObjects: number;
  eligibleObjects: number;
  skippedObjects: number;
  eligibleEncodedBytes: number;
  eligibleAllocatedBytes: number;
  invalidReceiptRecords: number;
}

export interface PruneConfirmation {
  confirm(preview: PrunePreview): Promise<boolean>;
}
