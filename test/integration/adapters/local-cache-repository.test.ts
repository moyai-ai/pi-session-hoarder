import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCasCacheRepository } from "../../../src/adapters/filesystem/local-cache-repository.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hoarder-prune-cache-"));
  roots.push(root);
  const objects = join(root, "objects", "sha256");
  await mkdir(objects, { recursive: true });
  return { root, objects, repository: new LocalCasCacheRepository(root) };
}

describe("LocalCasCacheRepository", () => {
  it("inventories and removes only regular canonical CAS gzip objects", async () => {
    const context = await setup();
    const digest = "a".repeat(64);
    await writeFile(join(context.objects, `${digest}.gz`), Buffer.alloc(17));
    await writeFile(join(context.objects, "not-an-object.txt"), "keep");
    await symlink(
      join(context.objects, "not-an-object.txt"),
      join(context.objects, `${"b".repeat(64)}.gz`),
    );

    const inventory = await context.repository.inventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({ digest, encodedBytes: 17 });
    expect(inventory[0]!.allocatedBytes).toBeGreaterThanOrEqual(17);
    await expect(context.repository.remove(inventory[0]!)).resolves.toBeGreaterThanOrEqual(17);
    await expect(context.repository.inventory()).resolves.toEqual([]);
    await expect(writeFile(join(context.objects, "still-present"), "ok")).resolves.toBeUndefined();
  });

  it("refuses deletion when an inventoried object changed", async () => {
    const context = await setup();
    const digest = "c".repeat(64);
    const path = join(context.objects, `${digest}.gz`);
    await writeFile(path, "old");
    const [entry] = await context.repository.inventory();
    await writeFile(path, "changed-size");
    await expect(context.repository.remove(entry!)).rejects.toThrow("changed before prune");
  });

  it("treats absent roots and already removed objects as empty/idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoarder-prune-cache-empty-"));
    roots.push(root);
    const repository = new LocalCasCacheRepository(root);
    await expect(repository.inventory()).resolves.toEqual([]);
    await expect(
      repository.remove({ digest: "d".repeat(64), encodedBytes: 1, allocatedBytes: 1 }),
    ).resolves.toBe(0);
  });
});
