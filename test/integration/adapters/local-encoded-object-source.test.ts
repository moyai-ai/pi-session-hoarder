import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { LocalEncodedObjectSource } from "../../../src/adapters/filesystem/local-encoded-object-source.js";
import { LocalFileObjectStore } from "../../../src/adapters/filesystem/local-object-store.js";
import type { ObjectReference } from "../../../src/domain/model.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(contents: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), "session-hoarder-encoded-source-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "source.bin");
  await writeFile(sourcePath, contents);
  const objects = new LocalFileObjectStore(join(directory, "store"));
  const stored = await objects.putFile(sourcePath);
  return {
    contents,
    object: stored.object,
    objects,
    source: new LocalEncodedObjectSource(objects),
  };
}

describe("LocalEncodedObjectSource", () => {
  it("streams encoded local CAS bytes that decode to the logical object", async () => {
    const context = await fixture(randomBytes(512 * 1024));
    const payload = await context.source.openEncoded(context.object);
    const hash = createHash("sha256");
    let logicalBytes = 0;

    await pipeline(Readable.from(payload.body), createGunzip(), async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        logicalBytes += chunk.byteLength;
      }
    });

    expect(payload.contentLength).toBe(context.object.storedBytes);
    const encoded = await readFile(context.objects.objectPath(context.object.digest));
    expect(payload.checksumSha256).toBe(createHash("sha256").update(encoded).digest("base64"));
    expect(hash.digest("hex")).toBe(context.object.digest);
    expect(logicalBytes).toBe(context.object.logicalBytes);
    await expect(context.source.verifyLogical(context.object)).resolves.toMatchObject({
      valid: true,
    });
  });

  it("does not buffer a large object into the payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-hoarder-large-encoded-source-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.bin");
    const output = createWriteStream(sourcePath);
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    for (let index = 0; index < 50; index += 1) {
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await once(output, "close");
    const objects = new LocalFileObjectStore(join(directory, "store"));
    const stored = await objects.putFile(sourcePath);
    const source = new LocalEncodedObjectSource(objects);

    const payload = await source.openEncoded(stored.object);
    let encodedBytes = 0;
    for await (const encodedChunk of payload.body) encodedBytes += encodedChunk.byteLength;

    expect(encodedBytes).toBe(stored.object.storedBytes);
    expect(payload.body).not.toBeInstanceOf(Uint8Array);
  }, 30_000);

  it("honors cancellation before opening encoded bytes", async () => {
    const context = await fixture(Buffer.from("cancelled"));
    const controller = new AbortController();
    controller.abort();

    await expect(
      context.source.openEncoded(context.object, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails explicitly for a missing local CAS object", async () => {
    const context = await fixture(Buffer.from("present"));
    const missing: ObjectReference = { ...context.object, digest: "b".repeat(64) };

    await expect(context.source.openEncoded(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
