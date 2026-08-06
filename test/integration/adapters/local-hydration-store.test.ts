import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCasHydrationStore } from "../../../src/adapters/filesystem/local-hydration-store.js";
import { LocalFileObjectStore } from "../../../src/adapters/filesystem/local-object-store.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

function fixture(logical = Buffer.from("hydrated bytes")) {
  const encoded = gzipSync(logical);
  const object = {
    algorithm: "sha256" as const,
    digest: createHash("sha256").update(logical).digest("hex"),
    encoding: "gzip" as const,
    logicalBytes: logical.length,
    storedBytes: encoded.length,
  };
  return {
    object,
    encoded,
    payload: () => ({
      contentLength: encoded.length,
      checksumSha256: createHash("sha256").update(encoded).digest("base64"),
      body: (async function* () {
        yield encoded;
      })(),
    }),
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hoarder-hydration-"));
  roots.push(root);
  const objects = new LocalFileObjectStore(root);
  return { objects, store: new LocalCasHydrationStore(objects) };
}

describe("LocalCasHydrationStore", () => {
  it("verifies and atomically installs encoded remote bytes", async () => {
    const context = await setup();
    const value = fixture();
    await context.store.install(value.object, value.payload());
    await expect(context.objects.verify(value.object)).resolves.toMatchObject({ valid: true });
  });

  it("removes temporary data after corruption or cancellation", async () => {
    const context = await setup();
    const value = fixture();
    const corrupt = { ...value.payload(), checksumSha256: Buffer.alloc(32).toString("base64") };
    await expect(context.store.install(value.object, corrupt)).rejects.toThrow("checksum mismatch");
    await expect(context.objects.has(value.object.digest)).resolves.toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      context.store.install(value.object, value.payload(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(context.objects.temporaryRoot)).toEqual([]);
  });

  it("converges duplicate installs", async () => {
    const context = await setup();
    const value = fixture();
    await Promise.all([
      context.store.install(value.object, value.payload()),
      context.store.install(value.object, value.payload()),
    ]);
    await expect(context.objects.verify(value.object)).resolves.toMatchObject({ valid: true });
  });
});
