import { randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { unlinkIfExists } from "./file-errors.js";

const fileOperationQueues = new Map<string, Promise<unknown>>();

export async function atomicWriteFile(
  destinationPath: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const directory = dirname(destinationPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, data, { flag: "wx", mode });
    const handle = await open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, destinationPath);
    await syncDirectoryBestEffort(directory);
  } catch (error) {
    await unlinkIfExists(temporaryPath);
    throw error;
  }
}

export function serializeFileOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileOperationQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  fileOperationQueues.set(path, next);
  const cleanup = () => {
    if (fileOperationQueues.get(path) === next) fileOperationQueues.delete(path);
  };
  void next.then(cleanup, cleanup);
  return next;
}

export async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms do not support opening or syncing directories.
  }
}
