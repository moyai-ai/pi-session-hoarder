import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalSessionSnapshotter } from "../../../src/adapters/filesystem/session-snapshotter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "session-hoarder-snapshot-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    source: join(directory, "session.jsonl"),
    temporaryRoot: join(directory, "tmp"),
  };
}

describe("LocalSessionSnapshotter", () => {
  it("captures an immutable size boundary and leaves later appends for another checkpoint", async () => {
    const { source, temporaryRoot } = await fixture();
    const original = '{"type":"session","version":3}\n';
    const appended = '{"type":"message","id":"later"}\n';
    await writeFile(source, original);
    const snapshotter = new LocalSessionSnapshotter(temporaryRoot, {
      afterBoundaryCaptured: async () => appendFile(source, appended),
    });
    const boundary = await snapshotter.inspect(source);
    if (!boundary) throw new Error("expected source boundary");

    const snapshot = await snapshotter.capture(source, boundary);

    expect(await readFile(snapshot.path, "utf8")).toBe(original);
    expect(await readFile(source, "utf8")).toBe(original + appended);
    expect(snapshot.size).toBe(Buffer.byteLength(original));
    await snapshot.dispose();
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it("supports an empty persisted session", async () => {
    const { source, temporaryRoot } = await fixture();
    await writeFile(source, "");
    const snapshotter = new LocalSessionSnapshotter(temporaryRoot);
    const boundary = await snapshotter.inspect(source);
    if (!boundary) throw new Error("expected source boundary");

    const snapshot = await snapshotter.capture(source, boundary);

    expect(snapshot.size).toBe(0);
    expect(await readFile(snapshot.path)).toHaveLength(0);
    await snapshot.dispose();
  });

  it("returns undefined for a not-yet-persisted Pi session", async () => {
    const { source, temporaryRoot } = await fixture();
    const snapshotter = new LocalSessionSnapshotter(temporaryRoot);

    await expect(snapshotter.inspect(source)).resolves.toBeUndefined();
  });

  it("rejects non-file sources", async () => {
    const { directory, temporaryRoot } = await fixture();
    const snapshotter = new LocalSessionSnapshotter(temporaryRoot);

    await expect(snapshotter.inspect(directory)).rejects.toThrow("not a regular file");
  });

  it("does not leave a temporary file when already cancelled", async () => {
    const { source, temporaryRoot } = await fixture();
    await writeFile(source, "session\n");
    const snapshotter = new LocalSessionSnapshotter(temporaryRoot);
    const boundary = await snapshotter.inspect(source);
    if (!boundary) throw new Error("expected source boundary");
    const controller = new AbortController();
    controller.abort();

    await expect(snapshotter.capture(source, boundary, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
