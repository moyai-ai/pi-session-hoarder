import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type {
  EncodedObjectPayload,
  EncodedObjectSource,
} from "../../application/replication-ports.js";
import type { ObjectStoreVerification } from "../../application/ports.js";
import type { ObjectReference } from "../../domain/model.js";
import { LocalFileObjectStore } from "./local-object-store.js";

/** Streams verified encoded bytes from the mandatory local CAS into replication workflows. */
export class LocalEncodedObjectSource implements EncodedObjectSource {
  constructor(private readonly objects: LocalFileObjectStore) {}

  verifyLogical(object: ObjectReference, signal?: AbortSignal): Promise<ObjectStoreVerification> {
    return this.objects.verify(object, signal);
  }

  async openEncoded(object: ObjectReference, signal?: AbortSignal): Promise<EncodedObjectPayload> {
    signal?.throwIfAborted();
    const path = this.objects.objectPath(object.digest);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Local CAS object is not a regular file: ${path}`);
    signal?.throwIfAborted();
    return {
      contentLength: metadata.size,
      checksumSha256: await encodedChecksum(path, signal),
      body: createReadStream(path, { signal }),
    };
  }
}

async function encodedChecksum(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest("base64");
}
