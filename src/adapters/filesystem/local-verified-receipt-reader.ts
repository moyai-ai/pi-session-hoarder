import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  VerifiedReceiptInventory,
  VerifiedReceiptReader,
} from "../../application/prune-ports.js";
import type { RemoteObjectReceipt } from "../../domain/replica.js";
import { decodeSessionReplicaRecord } from "./replica-codec.js";
import { hasErrorCode, validatePathSegment } from "./file-errors.js";

interface ReceiptScan {
  receipts: RemoteObjectReceipt[];
  invalidRecords: number;
}

/** Reads all private, durably committed replica revision records for one configured target. */
export class LocalVerifiedReceiptReader implements VerifiedReceiptReader {
  private readonly replicasRoot: string;

  constructor(storageRoot: string) {
    this.replicasRoot = join(storageRoot, "replicas");
  }

  async list(targetId: string, signal?: AbortSignal): Promise<VerifiedReceiptInventory> {
    validatePathSegment(targetId, "targetId", "replica");
    signal?.throwIfAborted();
    const targetRoot = join(this.replicasRoot, targetId);
    const repositories = await readOptionalDirectory(targetRoot);
    const scans = await Promise.all(
      repositories
        .filter((entry) => entry.isDirectory())
        .map((entry) => scanRepository(join(targetRoot, entry.name), targetId, signal)),
    );
    return {
      receipts: deduplicate(scans.flatMap((scan) => scan.receipts)),
      invalidRecords: scans.reduce((sum, scan) => sum + scan.invalidRecords, 0),
    };
  }
}

async function scanRepository(
  repositoryRoot: string,
  targetId: string,
  signal?: AbortSignal,
): Promise<ReceiptScan> {
  signal?.throwIfAborted();
  const entries = await readdir(repositoryRoot, { withFileTypes: true });
  const legacyRecords = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readReceiptRecord(join(repositoryRoot, entry.name), targetId, signal));
  const revisionHistories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => scanRevisionHistory(join(repositoryRoot, entry.name), targetId, signal));
  return combineScans(await Promise.all([...legacyRecords, ...revisionHistories]));
}

async function scanRevisionHistory(
  historyRoot: string,
  targetId: string,
  signal?: AbortSignal,
): Promise<ReceiptScan> {
  signal?.throwIfAborted();
  const records = await readdir(historyRoot, { withFileTypes: true });
  return combineScans(
    await Promise.all(
      records
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => readReceiptRecord(join(historyRoot, entry.name), targetId, signal)),
    ),
  );
}

async function readReceiptRecord(
  path: string,
  targetId: string,
  signal?: AbortSignal,
): Promise<ReceiptScan> {
  signal?.throwIfAborted();
  try {
    const decoded = decodeSessionReplicaRecord(await readFile(path, "utf8"), path);
    return decoded.targetId === targetId
      ? { receipts: [...decoded.objects], invalidRecords: 0 }
      : { receipts: [], invalidRecords: 1 };
  } catch {
    signal?.throwIfAborted();
    return { receipts: [], invalidRecords: 1 };
  }
}

async function readOptionalDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

function combineScans(scans: readonly ReceiptScan[]): ReceiptScan {
  return {
    receipts: scans.flatMap((scan) => scan.receipts),
    invalidRecords: scans.reduce((sum, scan) => sum + scan.invalidRecords, 0),
  };
}

function deduplicate(receipts: readonly RemoteObjectReceipt[]): RemoteObjectReceipt[] {
  const unique = new Map<string, RemoteObjectReceipt>();
  for (const receipt of receipts) {
    const key = `${receipt.object.digest}\0${receipt.key}\0${receipt.etag ?? ""}\0${receipt.versionId ?? ""}`;
    unique.set(key, receipt);
  }
  return [...unique.values()];
}
