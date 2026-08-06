import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { LocalGitWorktreeInspector } from "../../../src/adapters/git-worktree.js";
import { WorktreeProjectCatalogRepository } from "../../../src/adapters/filesystem/project-catalog-repository.js";
import type { ProjectSessionCatalog } from "../../../src/application/project-catalog.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function catalog(revision = 1): ProjectSessionCatalog {
  return {
    schemaVersion: 2,
    repositoryId: "repo",
    sessionId: "session",
    revision,
    capturedAt: "2026-08-06T12:00:00.000Z",
    git: { head: "a".repeat(40), branch: "main", detached: false, dirty: false },
    sessionObject: {
      algorithm: "sha256",
      digest: "b".repeat(64),
      encoding: "gzip",
      logicalBytes: 10,
      storedBytes: 8,
      locations: [{ kind: "local-cas" }],
    },
    artifacts: [],
  };
}

describe("Git worktree project catalog adapters", () => {
  it("writes an atomic source diff without staging or changing the Git index", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoarder-project-catalog-"));
    roots.push(root);
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "Session Hoarder Test");
    await writeFile(join(root, "tracked.txt"), "base\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "-m", "base");
    const beforeIndex = await git(root, "diff", "--cached", "--name-only");
    const observation = await new LocalGitWorktreeInspector().inspect(join(root, "."));
    const canonicalRoot = await realpath(root);
    expect(observation).toMatchObject({
      worktreeRoot: canonicalRoot,
      branch: "main",
      detached: false,
      dirty: false,
    });

    const repository = new WorktreeProjectCatalogRepository();
    const path = await repository.write(observation!.worktreeRoot, "session", catalog());

    expect(path).toBe(join(canonicalRoot, ".pi", "session-hoarder", "catalog", "session.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(catalog());
    expect(await git(root, "diff", "--cached", "--name-only")).toBe(beforeIndex);
    expect(await git(root, "status", "--short")).toContain("?? .pi/");

    await expect(repository.write(observation!.worktreeRoot, "session", catalog())).resolves.toBe(
      path,
    );
    await expect(
      repository.write(observation!.worktreeRoot, "session", {
        ...catalog(),
        capturedAt: "2026-08-06T13:00:00.000Z",
      }),
    ).rejects.toThrow("immutable");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(catalog());

    await repository.write(observation!.worktreeRoot, "session", catalog(2));
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ revision: 2 });
    await expect(
      repository.write(observation!.worktreeRoot, "session", catalog(1)),
    ).rejects.toThrow("move backward");
    expect(await git(root, "diff", "--cached", "--name-only")).toBe(beforeIndex);
  });

  it("does not treat a non-worktree directory as a project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hoarder-not-git-"));
    roots.push(root);
    await expect(new LocalGitWorktreeInspector().inspect(root)).resolves.toBeUndefined();
  });
});
