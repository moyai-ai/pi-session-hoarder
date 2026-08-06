import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitObservation, GitWorktreeInspector } from "../application/project-catalog.js";

const execFileAsync = promisify(execFile);

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<string | undefined>;
}

const defaultRunner: GitCommandRunner = {
  run: async (cwd, args) => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      return undefined;
    }
  },
};

export class LocalGitWorktreeInspector implements GitWorktreeInspector {
  constructor(private readonly runner: GitCommandRunner = defaultRunner) {}

  async inspect(cwd: string): Promise<GitObservation | undefined> {
    const worktreeRoot = await this.runner.run(cwd, ["rev-parse", "--show-toplevel"]);
    if (!worktreeRoot) return undefined;
    const [head, branch, status] = await Promise.all([
      this.runner.run(worktreeRoot, ["rev-parse", "--verify", "HEAD"]),
      this.runner.run(worktreeRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.runner.run(worktreeRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    ]);
    return {
      worktreeRoot,
      ...(head ? { head } : {}),
      ...(branch ? { branch } : {}),
      detached: !branch,
      dirty: Boolean(status),
    };
  }
}
