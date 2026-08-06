import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { StreamingEncodedObjectVerifier } from "../../../src/adapters/filesystem/streaming-encoded-object-verifier.js";
import type { ObjectReference } from "../../../src/domain/model.js";

function fixture(logical: Uint8Array) {
  const encoded = gzipSync(logical);
  const object: ObjectReference = {
    algorithm: "sha256",
    digest: createHash("sha256").update(logical).digest("hex"),
    encoding: "gzip",
    logicalBytes: logical.byteLength,
    storedBytes: encoded.byteLength,
  };
  return {
    object,
    encoded,
    payload: (bytes = encoded) => ({
      contentLength: bytes.byteLength,
      checksumSha256: createHash("sha256").update(bytes).digest("base64"),
      body: chunks(bytes),
    }),
  };
}

describe("StreamingEncodedObjectVerifier", () => {
  it.each([
    ["empty", Buffer.alloc(0)],
    ["text", Buffer.from("verified remote session bytes")],
    ["binary", deterministicBinary(2 * 1024 * 1024)],
  ])("streams and verifies %s gzip payloads", async (_name, logical) => {
    const value = fixture(logical);

    await expect(
      new StreamingEncodedObjectVerifier().verify(value.object, value.payload()),
    ).resolves.toEqual({
      valid: true,
    });
  });

  it("rejects corrupted gzip and valid gzip with the wrong logical identity", async () => {
    const expected = fixture(Buffer.from("expected logical bytes"));
    const wrong = fixture(Buffer.from("different logical bytes"));
    const corrupted = Buffer.from(expected.encoded);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;

    await expect(
      new StreamingEncodedObjectVerifier().verify(expected.object, expected.payload(corrupted)),
    ).resolves.toEqual({ valid: false });
    await expect(
      new StreamingEncodedObjectVerifier().verify(expected.object, wrong.payload()),
    ).resolves.toEqual({ valid: false });
  });

  it("rejects transport size and checksum mismatches", async () => {
    const value = fixture(Buffer.from("transport evidence"));

    await expect(
      new StreamingEncodedObjectVerifier().verify(value.object, {
        ...value.payload(),
        contentLength: value.encoded.byteLength + 1,
      }),
    ).resolves.toEqual({ valid: false });
    await expect(
      new StreamingEncodedObjectVerifier().verify(value.object, {
        ...value.payload(),
        checksumSha256: Buffer.alloc(32).toString("base64"),
      }),
    ).resolves.toEqual({ valid: false });
  });

  it("rethrows transport failures and explicitly closes the remote iterator", async () => {
    const value = fixture(deterministicBinary(2 * 1024 * 1024));
    let reads = 0;
    const transportError = new Error("simulated socket reset");
    const iterator: AsyncIterator<Uint8Array> = {
      next: async () => {
        reads += 1;
        if (reads === 1) return { done: false, value: value.encoded.subarray(0, 1024) };
        throw transportError;
      },
      return: vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({
        done: true,
        value: undefined,
      })),
    };

    await expect(
      new StreamingEncodedObjectVerifier().verify(value.object, {
        ...value.payload(),
        body: { [Symbol.asyncIterator]: () => iterator },
      }),
    ).rejects.toBe(transportError);
    expect(iterator.return).toHaveBeenCalled();
  });

  it("propagates cancellation while consuming the remote stream", async () => {
    const value = fixture(deterministicBinary(2 * 1024 * 1024));
    const controller = new AbortController();
    const body = (async function* () {
      yield value.encoded.subarray(0, 1024);
      controller.abort();
      yield value.encoded.subarray(1024);
    })();

    await expect(
      new StreamingEncodedObjectVerifier().verify(
        value.object,
        {
          ...value.payload(),
          body,
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
    yield bytes.subarray(offset, offset + 64 * 1024);
  }
}

function deterministicBinary(size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}
