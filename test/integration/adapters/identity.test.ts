import { describe, expect, it, vi } from "vitest";

import {
  createSessionIdentity,
  normalizeGitRemote,
  resolveRepositoryIdentity,
  type IdentityDependencies,
} from "../../../src/adapters/identity.js";

function dependencies(
  git: IdentityDependencies["git"],
  canonicalPath: IdentityDependencies["canonicalPath"] = async (path) => path,
): IdentityDependencies {
  return { git, canonicalPath };
}

describe("normalizeGitRemote", () => {
  it.each([
    ["git@github.com:moyai-ai/pi-session-hoarder.git", "github.com/moyai-ai/pi-session-hoarder"],
    [
      "ssh://git@github.com/moyai-ai/pi-session-hoarder.git",
      "github.com/moyai-ai/pi-session-hoarder",
    ],
    [
      "https://github.com/moyai-ai/pi-session-hoarder.git",
      "github.com/moyai-ai/pi-session-hoarder",
    ],
    [
      "https://user:token@GitHub.com/moyai-ai/pi-session-hoarder/",
      "github.com/moyai-ai/pi-session-hoarder",
    ],
  ])("normalizes %s", (remote, expected) => {
    expect(normalizeGitRemote(remote)).toBe(expected);
  });
});

describe("resolveRepositoryIdentity", () => {
  it("prefers a canonical origin remote", async () => {
    const git = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === "rev-parse") return "/canonical/repo";
      return "git@github.com:moyai-ai/pi-session-hoarder.git";
    });

    const identity = await resolveRepositoryIdentity(
      "/work/repo/subdir",
      dependencies(git, async (path) =>
        path.replace("/work/repo/subdir", "/canonical/repo/subdir"),
      ),
    );

    expect(identity).toMatchObject({
      kind: "git-remote",
      canonicalValue: "github.com/moyai-ai/pi-session-hoarder",
    });
    expect(identity.repositoryId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("falls back to the canonical Git root when origin is unavailable", async () => {
    const git = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === "rev-parse") return "/real/repo";
      throw new Error("no origin");
    });

    const identity = await resolveRepositoryIdentity("/work/repo", dependencies(git));

    expect(identity).toMatchObject({ kind: "git-root", canonicalValue: "/real/repo" });
  });

  it("falls back to canonical cwd outside Git", async () => {
    const identity = await resolveRepositoryIdentity(
      "/work/plain",
      dependencies(
        async () => {
          throw new Error("not git");
        },
        async () => "/real/plain",
      ),
    );

    expect(identity).toMatchObject({ kind: "cwd", canonicalValue: "/real/plain" });
  });

  it("does not expose the canonical path in the filesystem-safe repository id", async () => {
    const identity = await resolveRepositoryIdentity(
      "/secret/project",
      dependencies(async () => {
        throw new Error("not git");
      }),
    );

    expect(identity.repositoryId).not.toContain("secret");
    expect(identity.repositoryId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps separate repositories from colliding", async () => {
    const noGit = async () => {
      throw new Error("not git");
    };
    const first = await resolveRepositoryIdentity("/repo/a", dependencies(noGit));
    const second = await resolveRepositoryIdentity("/repo/b", dependencies(noGit));

    expect(first.repositoryId).not.toBe(second.repositoryId);
  });
});

describe("createSessionIdentity", () => {
  it("combines repository and Pi session ids", () => {
    expect(createSessionIdentity("repo", "session")).toEqual({
      repositoryId: "repo",
      sessionId: "session",
    });
  });
});
