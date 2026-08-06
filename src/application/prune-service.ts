import type { ObjectReference } from "../domain/model.js";
import type { RemoteObjectReceipt } from "../domain/replica.js";
import type { MaintenanceExclusion } from "./maintenance-exclusion.js";
import type {
  LocalCacheObject,
  LocalCacheRepository,
  PruneConfirmation,
  PrunePreview,
  RemoteReceiptPolicy,
  VerifiedReceiptReader,
} from "./prune-ports.js";

export interface PruneDependencies {
  cache: LocalCacheRepository;
  receipts: VerifiedReceiptReader;
  receiptPolicy: RemoteReceiptPolicy;
  exclusion: MaintenanceExclusion;
}

export interface PruneResult extends PrunePreview {
  confirmed: boolean;
  removedObjects: number;
  recoveredBytes: number;
  failedObjects: number;
  interrupted: boolean;
}

interface EligibleObject {
  local: LocalCacheObject;
  object: ObjectReference;
  receipt: RemoteObjectReceipt;
}

export class PruneApplicationService {
  constructor(private readonly dependencies: PruneDependencies) {}

  prune(
    targetId: string,
    confirmation?: PruneConfirmation,
    signal?: AbortSignal,
  ): Promise<PruneResult> {
    if (targetId.length === 0) throw new Error("Prune requires a selected remote target.");
    return this.dependencies.exclusion.runMaintenance(
      () => this.pruneExclusive(targetId, confirmation, signal),
      signal,
    );
  }

  private async pruneExclusive(
    targetId: string,
    confirmation?: PruneConfirmation,
    signal?: AbortSignal,
  ): Promise<PruneResult> {
    signal?.throwIfAborted();
    const [localObjects, receiptInventory] = await Promise.all([
      this.dependencies.cache.inventory(signal),
      this.dependencies.receipts.list(targetId, signal),
    ]);
    const eligible = selectEligible(
      localObjects,
      receiptInventory.receipts,
      this.dependencies.receiptPolicy,
    );
    const preview = createPreview(localObjects, eligible, receiptInventory.invalidRecords);
    if (eligible.length === 0) return emptyResult(preview, true);
    if (confirmation && !(await confirmation.confirm(preview))) {
      return emptyResult(preview, false);
    }

    let removedObjects = 0;
    let recoveredBytes = 0;
    let failedObjects = 0;
    let interrupted = false;
    for (const candidate of eligible) {
      try {
        signal?.throwIfAborted();
        recoveredBytes += await this.dependencies.cache.remove(candidate.local, signal);
        removedObjects += 1;
      } catch (error) {
        if (isAbortError(error, signal)) {
          interrupted = true;
          break;
        }
        failedObjects += 1;
      }
    }
    return {
      ...preview,
      confirmed: true,
      removedObjects,
      recoveredBytes,
      failedObjects,
      interrupted,
    };
  }
}

function selectEligible(
  localObjects: readonly LocalCacheObject[],
  receipts: readonly RemoteObjectReceipt[],
  policy: RemoteReceiptPolicy,
): EligibleObject[] {
  const byDigest = new Map<string, RemoteObjectReceipt[]>();
  for (const receipt of receipts) {
    const values = byDigest.get(receipt.object.digest) ?? [];
    values.push(receipt);
    byDigest.set(receipt.object.digest, values);
  }
  return localObjects.flatMap((local) => {
    const receipt = byDigest
      .get(local.digest)
      ?.find(
        (candidate) =>
          candidate.object.storedBytes === local.encodedBytes &&
          policy.matches(candidate.object, candidate),
      );
    return receipt ? [{ local, object: receipt.object, receipt }] : [];
  });
}

function createPreview(
  local: readonly LocalCacheObject[],
  eligible: readonly EligibleObject[],
  invalidReceiptRecords: number,
): PrunePreview {
  return {
    localObjects: local.length,
    eligibleObjects: eligible.length,
    skippedObjects: local.length - eligible.length,
    eligibleEncodedBytes: eligible.reduce((sum, item) => sum + item.local.encodedBytes, 0),
    eligibleAllocatedBytes: eligible.reduce((sum, item) => sum + item.local.allocatedBytes, 0),
    invalidReceiptRecords,
  };
}

function emptyResult(preview: PrunePreview, confirmed: boolean): PruneResult {
  return {
    ...preview,
    confirmed,
    removedObjects: 0,
    recoveredBytes: 0,
    failedObjects: 0,
    interrupted: false,
  };
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}
