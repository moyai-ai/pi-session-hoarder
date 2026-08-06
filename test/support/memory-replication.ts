import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type {
  RemoteObjectObservation,
  RemoteObjectPutInput,
  RemoteObjectPutResult,
  RemoteUntrustedObjectPayload,
  ReplicaObjectRepository,
} from "../../src/application/replication-ports.js";
import { sameObjectReference, type ObjectReference } from "../../src/domain/model.js";
import type { RemoteObjectReceipt } from "../../src/domain/replica.js";

export class MemoryRemoteObjects implements ReplicaObjectRepository {
  readonly objects = new Map<string, { bytes: Uint8Array; receipt: RemoteObjectReceipt }>();

  async inspect(object: ObjectReference, signal?: AbortSignal): Promise<RemoteObjectObservation> {
    signal?.throwIfAborted();
    const stored = this.objects.get(object.digest);
    return stored
      ? {
          state: "untrusted-present",
          key: stored.receipt.key,
          metadata: {
            contentLength: stored.bytes.byteLength,
            ...(stored.receipt.checksumSha256
              ? { checksumSha256: stored.receipt.checksumSha256 }
              : {}),
          },
        }
      : { state: "absent" };
  }

  async put(input: RemoteObjectPutInput, signal?: AbortSignal): Promise<RemoteObjectPutResult> {
    signal?.throwIfAborted();
    const existing = this.objects.get(input.object.digest);
    if (existing) {
      return { state: "conflict", observation: await this.inspect(input.object, signal) };
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of input.body) {
      signal?.throwIfAborted();
      chunks.push(chunk);
      length += chunk.byteLength;
    }
    if (length !== input.contentLength) throw new Error("encoded length mismatch");
    const bytes = Buffer.concat(chunks);
    const checksumSha256 = createHash("sha256").update(bytes).digest("base64");
    if (checksumSha256 !== input.checksumSha256) throw new Error("encoded checksum mismatch");
    const receipt = {
      object: structuredClone(input.object),
      key: `objects/sha256/${input.object.digest}.gz`,
      checksumSha256,
    };
    this.objects.set(input.object.digest, { bytes, receipt });
    return { state: "uploaded", receipt: structuredClone(receipt) };
  }

  async verifyTrustedReceipt(
    object: ObjectReference,
    receipt: RemoteObjectReceipt,
    signal?: AbortSignal,
  ): Promise<{ valid: boolean }> {
    signal?.throwIfAborted();
    const stored = this.objects.get(object.digest);
    return {
      valid:
        stored !== undefined &&
        stored.receipt.key === receipt.key &&
        sameObjectReference(stored.receipt.object, object) &&
        sameObjectReference(receipt.object, object) &&
        stored.receipt.checksumSha256 === receipt.checksumSha256,
    };
  }

  async retrieveUntrusted(
    object: ObjectReference,
    observation: Extract<RemoteObjectObservation, { state: "untrusted-present" }>,
    signal?: AbortSignal,
  ): Promise<RemoteUntrustedObjectPayload> {
    signal?.throwIfAborted();
    const stored = this.objects.get(object.digest);
    if (!stored || stored.receipt.key !== observation.key) throw new Error("remote object missing");
    return {
      key: stored.receipt.key,
      contentLength: stored.bytes.byteLength,
      checksumSha256: stored.receipt.checksumSha256,
      body: (async function* () {
        signal?.throwIfAborted();
        yield stored.bytes;
      })(),
    };
  }

  matches(object: ObjectReference, receipt: RemoteObjectReceipt): boolean {
    return (
      sameObjectReference(object, receipt.object) &&
      receipt.key === `objects/sha256/${object.digest}.gz`
    );
  }
}

export function replicaObjectFixture() {
  const logical = Buffer.from("logical replica object");
  const encoded = gzipSync(logical);
  const object: ObjectReference = {
    algorithm: "sha256",
    digest: createHash("sha256").update(logical).digest("hex"),
    encoding: "gzip",
    logicalBytes: logical.byteLength,
    storedBytes: encoded.byteLength,
  };
  const payload = () => ({
    contentLength: encoded.byteLength,
    checksumSha256: createHash("sha256").update(encoded).digest("base64"),
    body: (async function* () {
      yield encoded;
    })(),
  });
  return { object, payload };
}
