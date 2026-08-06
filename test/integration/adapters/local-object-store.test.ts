import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { LocalFileObjectStore } from "../../../src/adapters/filesystem/local-object-store.js";
import { objectStoreContract } from "../../contracts/object-store.contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  directory: string;
  source: string;
  cas: LocalFileObjectStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "session-hoarder-cas-"));
  temporaryDirectories.push(directory);
  const source = join(directory, "source.bin");
  return { directory, source, cas: new LocalFileObjectStore(join(directory, "store")) };
}

async function decodedBytes(
  cas: LocalFileObjectStore,
  object: Parameters<LocalFileObjectStore["openDecoded"]>[0],
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of cas.openDecoded(object)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

objectStoreContract("LocalFileObjectStore", async () => {
  const { source, cas } = await fixture();
  return {
    store: cas,
    writeSource: async (contents) => {
      await writeFile(source, contents);
      return source;
    },
  };
});

describe("LocalFileObjectStore", () => {
  it.each([
    ["empty", Buffer.alloc(0)],
    ["text", Buffer.from("session hoarder\n".repeat(100))],
    ["binary", randomBytes(256 * 1024)],
  ])("round trips %s input", async (_name, input) => {
    const { source, cas } = await fixture();
    await writeFile(source, input);

    const result = await cas.putFile(source);

    expect(result.object.digest).toBe(createHash("sha256").update(input).digest("hex"));
    expect(result.object.logicalBytes).toBe(input.byteLength);
    expect(await decodedBytes(cas, result.object)).toEqual(input);
    expect(await cas.verify(result.object)).toEqual({
      valid: true,
      digest: result.object.digest,
      logicalBytes: input.byteLength,
    });
  });

  it("deduplicates repeated input", async () => {
    const { source, cas } = await fixture();
    await writeFile(source, "same bytes");

    const first = await cas.putFile(source);
    const second = await cas.putFile(source);

    expect(second.object).toEqual(first.object);
    expect(await readdir(cas.objectsRoot)).toEqual([`${first.object.digest}.gz`]);
    expect(cas.objectPath(first.object.digest)).toBe(
      join(cas.objectsRoot, `${first.object.digest}.gz`),
    );
  });

  it("converges concurrent writes of the same input", async () => {
    const { source, cas } = await fixture();
    await writeFile(source, randomBytes(1024 * 1024));

    const results = await Promise.all(Array.from({ length: 4 }, () => cas.putFile(source)));

    expect(new Set(results.map((result) => result.object.digest))).toHaveLength(1);
    expect(await readdir(cas.temporaryRoot)).toEqual([]);
  });

  it("removes temporary output when cancelled", async () => {
    const { source, cas } = await fixture();
    await writeFile(source, randomBytes(1024 * 1024));
    const controller = new AbortController();
    controller.abort();

    await expect(cas.putFile(source, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await mkdir(cas.temporaryRoot, { recursive: true });
    expect(await readdir(cas.temporaryRoot)).toEqual([]);
  });

  it("rejects non-regular files", async () => {
    const { directory, cas } = await fixture();
    await expect(cas.putFile(directory)).rejects.toThrow("not a regular file");
  });

  it("streams a 50 MiB fixture without collecting it in memory", async () => {
    const { source, cas } = await fixture();
    const output = createWriteStream(source);
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    for (let index = 0; index < 50; index += 1) {
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await once(output, "close");

    const result = await cas.putFile(source);
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      cas.openDecoded(result.object),
      new Writable({
        write(data: Buffer, _encoding, callback) {
          hash.update(data);
          bytes += data.byteLength;
          callback();
        },
      }),
    );

    expect(bytes).toBe(50 * 1024 * 1024);
    expect(hash.digest("hex")).toBe(result.object.digest);
    expect(result.object.storedBytes).toBeLessThan(result.object.logicalBytes);
  }, 30_000);

  it("detects reference mismatches during verification", async () => {
    const { source, cas } = await fixture();
    await writeFile(source, "verify me");
    const result = await cas.putFile(source);

    const verification = await cas.verify({ ...result.object, logicalBytes: 1 });

    expect(verification.valid).toBe(false);
  });
});
