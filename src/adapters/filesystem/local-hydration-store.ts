import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { LocalHydrationStore } from "../../application/retrieval-ports.js";
import type { RemoteEncodedObjectPayload } from "../../application/retrieval-ports.js";
import type { ObjectReference } from "../../domain/model.js";
import { serializeFileOperation, syncDirectoryBestEffort } from "./atomic-file.js";
import { unlinkIfExists } from "./file-errors.js";
import { LocalFileObjectStore } from "./local-object-store.js";
import { verifyGzipFileLogical } from "./streaming-encoded-object-verifier.js";

export class LocalCasHydrationStore implements LocalHydrationStore {
  constructor(private readonly objects: LocalFileObjectStore) {}

  has(digest: string): Promise<boolean> {
    return this.objects.has(digest);
  }

  install(
    object: ObjectReference,
    payload: RemoteEncodedObjectPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    return serializeFileOperation(this.objects.objectPath(object.digest), () =>
      this.installExclusive(object, payload, signal),
    );
  }

  private async installExclusive(
    object: ObjectReference,
    payload: RemoteEncodedObjectPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    if (await this.objects.has(object.digest)) return;
    signal?.throwIfAborted();
    await mkdir(this.objects.temporaryRoot, { recursive: true });
    const temporaryPath = join(this.objects.temporaryRoot, `${randomUUID()}.hydrate.gz.tmp`);
    try {
      const encoded = createHash("sha256");
      let encodedBytes = 0;
      await pipeline(
        payload.body,
        async function* (chunks) {
          for await (const chunk of chunks) {
            signal?.throwIfAborted();
            encoded.update(chunk);
            encodedBytes += chunk.byteLength;
            yield chunk;
          }
        },
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      if (encodedBytes !== payload.contentLength || encodedBytes !== object.storedBytes) {
        throw new Error(`Hydrated encoded size mismatch for ${object.digest}.`);
      }
      const encodedChecksum = encoded.digest("base64");
      if (payload.checksumSha256 && encodedChecksum !== payload.checksumSha256) {
        throw new Error(`Hydrated transport checksum mismatch for ${object.digest}.`);
      }
      if (!(await verifyGzipFileLogical(temporaryPath, object, signal))) {
        throw new Error(`Hydrated logical verification failed for ${object.digest}.`);
      }
      await syncFile(temporaryPath);
      const destination = this.objects.objectPath(object.digest);
      await mkdir(dirname(destination), { recursive: true });
      await rename(temporaryPath, destination);
      await syncDirectoryBestEffort(dirname(destination));
    } catch (error) {
      await unlinkIfExists(temporaryPath);
      throw error;
    }
  }
}

async function syncFile(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Hydration temporary path is not a file: ${path}`);
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
