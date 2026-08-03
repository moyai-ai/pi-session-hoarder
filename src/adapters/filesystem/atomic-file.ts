import { randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { unlinkIfExists } from "./file-errors.js";

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

async function syncDirectoryBestEffort(directory: string): Promise<void> {
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

