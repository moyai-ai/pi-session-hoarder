import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, rename, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import type {
  ObjectStore,
  ObjectStorePutResult,
  ObjectStoreVerification,
} from "../../application/ports.js";
import type { ObjectReference } from "../../domain/model.js";
import { hasErrorCode, unlinkIfExists } from "./file-errors.js";

/** Filesystem adapter for immutable, content-addressed binary objects. */
export class LocalFileObjectStore implements ObjectStore {
  readonly root: string;
  readonly objectsRoot: string;
  readonly temporaryRoot: string;

  constructor(root: string) {
    this.root = root;
    this.objectsRoot = join(root, "objects", "sha256");
    this.temporaryRoot = join(root, "tmp");
  }

  async putFile(sourcePath: string, signal?: AbortSignal): Promise<ObjectStorePutResult> {
    signal?.throwIfAborted();
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error(`CAS source is not a regular file: ${sourcePath}`);

    await mkdir(this.temporaryRoot, { recursive: true });
    const temporaryPath = join(this.temporaryRoot, `${randomUUID()}.gz.tmp`);
    const hashing = createSha256Transform(true);

    try {
      await pipeline(
        createReadStream(sourcePath),
        hashing.stream,
        createGzip(),
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      await syncFile(temporaryPath);
      const { digest, logicalBytes } = hashing.result();
      const destinationPath = this.objectPath(digest);
      await mkdir(dirname(destinationPath), { recursive: true });
      if (await pathExists(destinationPath)) {
        await unlinkIfExists(temporaryPath);
      } else {
        try {
          await rename(temporaryPath, destinationPath);
        } catch (error) {
          if (isAlreadyExistsError(error) || (await pathExists(destinationPath))) {
            await unlinkIfExists(temporaryPath);
          } else {
            throw error;
          }
        }
      }
      const stored = await stat(destinationPath);
      return {
        object: {
          algorithm: "sha256",
          digest,
          encoding: "gzip",
          logicalBytes,
          storedBytes: stored.size,
          relativePath: relative(this.root, destinationPath),
        },
        absolutePath: destinationPath,
      };
    } catch (error) {
      await unlinkIfExists(temporaryPath);
      throw error;
    }
  }

  has(digest: string): Promise<boolean> {
    return pathExists(this.objectPath(digest));
  }

  async verify(object: ObjectReference, signal?: AbortSignal): Promise<ObjectStoreVerification> {
    signal?.throwIfAborted();
    const hashing = createSha256Transform(false);
    await pipeline(this.openDecoded(object), hashing.stream, { signal });
    const { digest, logicalBytes } = hashing.result();
    return {
      valid: digest === object.digest && logicalBytes === object.logicalBytes,
      digest,
      logicalBytes,
    };
  }

  openDecoded(object: ObjectReference): Readable {
    return createReadStream(this.objectPath(object.digest)).pipe(createGunzip());
  }

  objectPath(digest: string): string {
    validateDigest(digest);
    return join(this.objectsRoot, `${digest}.gz`);
  }
}

function createSha256Transform(passThrough: boolean): {
  stream: Transform;
  result(): { digest: string; logicalBytes: number };
} {
  const hash = createHash("sha256");
  let logicalBytes = 0;
  return {
    stream: new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        logicalBytes += chunk.byteLength;
        callback(null, passThrough ? chunk : undefined);
      },
    }),
    result: () => ({ digest: hash.digest("hex"), logicalBytes }),
  };
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function validateDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid SHA-256 digest: ${digest}`);
}

function isAlreadyExistsError(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY");
}

