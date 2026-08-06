import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { LocalCacheObject, LocalCacheRepository } from "../../application/prune-ports.js";
import { serializeFileOperation } from "./atomic-file.js";
import { hasErrorCode } from "./file-errors.js";

const OBJECT_FILE = /^([a-f0-9]{64})\.gz$/;

/** Inventory/removal boundary restricted to immutable local CAS object files. */
export class LocalCasCacheRepository implements LocalCacheRepository {
  readonly objectsRoot: string;

  constructor(storageRoot: string) {
    this.objectsRoot = join(storageRoot, "objects", "sha256");
  }

  async inventory(signal?: AbortSignal): Promise<readonly LocalCacheObject[]> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(this.objectsRoot, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
    const objects: LocalCacheObject[] = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      const match = OBJECT_FILE.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const path = join(this.objectsRoot, entry.name);
      const metadata = await lstat(path);
      if (!metadata.isFile()) continue;
      objects.push({
        digest: match[1]!,
        encodedBytes: metadata.size,
        allocatedBytes: allocatedBytes(metadata.blocks, metadata.size),
      });
    }
    return objects.sort((left, right) => left.digest.localeCompare(right.digest));
  }

  remove(object: LocalCacheObject, signal?: AbortSignal): Promise<number> {
    if (!/^[a-f0-9]{64}$/.test(object.digest)) {
      throw new Error(`Invalid local CAS digest for prune: ${object.digest}.`);
    }
    const path = join(this.objectsRoot, `${object.digest}.gz`);
    return serializeFileOperation(path, async () => {
      signal?.throwIfAborted();
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return 0;
        throw error;
      }
      if (!metadata.isFile() || metadata.size !== object.encodedBytes) {
        throw new Error(`Local CAS object changed before prune: ${object.digest}.`);
      }
      await unlink(path);
      return allocatedBytes(metadata.blocks, metadata.size);
    });
  }
}

function allocatedBytes(blocks: number, size: number): number {
  return Number.isSafeInteger(blocks) && blocks > 0 ? blocks * 512 : size;
}
