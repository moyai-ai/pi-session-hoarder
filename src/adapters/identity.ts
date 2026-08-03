import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { RepositoryIdentity, SessionIdentity } from "../domain/model.js";

const execFileAsync = promisify(execFile);

export interface IdentityDependencies {
  canonicalPath(path: string): Promise<string>;
  git(cwd: string, args: readonly string[]): Promise<string>;
}

const defaultDependencies: IdentityDependencies = {
  canonicalPath: realpath,
  async git(cwd, args) {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return result.stdout.trim();
  },
};

export async function resolveRepositoryIdentity(
  cwd: string,
  dependencyOverrides: Partial<IdentityDependencies> = {},
): Promise<RepositoryIdentity> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const canonicalCwd = await canonicalizeOrResolve(cwd, dependencies.canonicalPath);

  const gitRoot = await tryGit(dependencies, canonicalCwd, ["rev-parse", "--show-toplevel"]);
  if (gitRoot) {
    const canonicalRoot = await canonicalizeOrResolve(gitRoot, dependencies.canonicalPath);
    const remote = await tryGit(dependencies, canonicalRoot, ["remote", "get-url", "origin"]);
    if (remote) {
      const canonicalRemote = normalizeGitRemote(remote);
      return createRepositoryIdentity("git-remote", canonicalRemote);
    }
    return createRepositoryIdentity("git-root", canonicalRoot);
  }

  return createRepositoryIdentity("cwd", canonicalCwd);
}

export function createSessionIdentity(
  repositoryId: string,
  sessionId: string,
): SessionIdentity {
  if (repositoryId.length === 0) throw new Error("repositoryId must not be empty.");
  if (sessionId.length === 0) throw new Error("sessionId must not be empty.");
  return { repositoryId, sessionId };
}

export function normalizeGitRemote(remote: string): string {
  const trimmed = remote.trim();
  if (trimmed.length === 0) throw new Error("Git remote must not be empty.");

  const scpLike = trimmed.match(/^(?:([^@/]+)@)?([^:/]+):(.+)$/);
  if (scpLike && !trimmed.includes("://")) {
    return normalizeRemoteParts(scpLike[2], scpLike[3]);
  }

  try {
    const url = new URL(trimmed);
    return normalizeRemoteParts(url.hostname, url.pathname);
  } catch {
    return normalizeLocalRemote(trimmed);
  }
}

function createRepositoryIdentity(
  kind: RepositoryIdentity["kind"],
  canonicalValue: string,
): RepositoryIdentity {
  return {
    kind,
    canonicalValue,
    repositoryId: createHash("sha256").update(`${kind}\0${canonicalValue}`).digest("hex"),
  };
}

function normalizeRemoteParts(host: string, rawPath: string): string {
  const path = stripGitSuffix(rawPath.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (path.length === 0) throw new Error("Git remote repository path must not be empty.");
  return `${host.toLowerCase()}/${path}`;
}

function normalizeLocalRemote(remote: string): string {
  return stripGitSuffix(remote.replace(/\\/g, "/").replace(/\/+$/, ""));
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

async function canonicalizeOrResolve(
  path: string,
  canonicalPath: IdentityDependencies["canonicalPath"],
): Promise<string> {
  try {
    return await canonicalPath(path);
  } catch {
    return resolve(path);
  }
}

async function tryGit(
  dependencies: IdentityDependencies,
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const value = await dependencies.git(cwd, args);
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
