import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import type {
  EncodedObjectVerifier,
  RemoteObjectVerification,
  VerifiableEncodedObjectPayload,
} from "../../application/replication-ports.js";
import type { ObjectReference } from "../../domain/model.js";

/** Verifies encoded transport bytes and their uncompressed logical identity in one streaming pass. */
export class StreamingEncodedObjectVerifier implements EncodedObjectVerifier {
  async verify(
    object: ObjectReference,
    payload: VerifiableEncodedObjectPayload,
    signal?: AbortSignal,
  ): Promise<RemoteObjectVerification> {
    signal?.throwIfAborted();
    const encodedHash = createHash("sha256");
    const logicalHash = createHash("sha256");
    let encodedBytes = 0;
    let logicalBytes = 0;

    const iterator = payload.body[Symbol.asyncIterator]();
    try {
      await pipeline(
        iterableFrom(iterator),
        async function* (chunks) {
          for await (const chunk of chunks) {
            signal?.throwIfAborted();
            encodedHash.update(chunk);
            encodedBytes += chunk.byteLength;
            yield chunk;
          }
        },
        createGunzip(),
        async function* (chunks) {
          for await (const chunk of chunks) {
            signal?.throwIfAborted();
            logicalHash.update(chunk);
            logicalBytes += chunk.byteLength;
          }
        },
        { signal },
      );
    } catch (error) {
      await closeIteratorBestEffort(iterator);
      signal?.throwIfAborted();
      if (isGzipError(error)) return { valid: false };
      throw error;
    }

    if (encodedBytes !== payload.contentLength || encodedBytes !== object.storedBytes) {
      return { valid: false };
    }
    if (payload.checksumSha256 && encodedHash.digest("base64") !== payload.checksumSha256) {
      return { valid: false };
    }
    return {
      valid: logicalBytes === object.logicalBytes && logicalHash.digest("hex") === object.digest,
    };
  }
}

function iterableFrom(iterator: AsyncIterator<Uint8Array>): AsyncIterable<Uint8Array> {
  return { [Symbol.asyncIterator]: () => iterator };
}

async function closeIteratorBestEffort(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Preserve the verification failure that required cleanup.
  }
}

function isGzipError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("Z_");
}

export async function verifyGzipFileLogical(
  path: string,
  object: ObjectReference,
  signal?: AbortSignal,
): Promise<boolean> {
  const hash = createHash("sha256");
  let logicalBytes = 0;
  try {
    await pipeline(
      createReadStream(path),
      createGunzip(),
      async function* (chunks) {
        for await (const chunk of chunks) {
          signal?.throwIfAborted();
          hash.update(chunk);
          logicalBytes += chunk.byteLength;
        }
      },
      { signal },
    );
  } catch (error) {
    signal?.throwIfAborted();
    if (isGzipError(error)) return false;
    throw error;
  }
  return logicalBytes === object.logicalBytes && hash.digest("hex") === object.digest;
}
