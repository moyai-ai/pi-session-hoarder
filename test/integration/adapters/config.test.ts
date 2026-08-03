import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, loadConfig, type ConfigDependencies } from "../../../src/adapters/config.js";

const agentDir = "/home/test/.pi/agent";
const cwd = "/work/repository";
const homeDir = "/home/test";
const globalPath = `${agentDir}/session-hoarder.json`;
const projectPath = `${cwd}/.pi/session-hoarder.json`;

function dependencies(files: Record<string, string>): ConfigDependencies {
  return {
    agentDir,
    configDirName: ".pi",
    homeDir,
    readTextFile: vi.fn(async (path: string) => {
      if (path in files) return files[path];
      throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
    }),
  };
}

describe("loadConfig", () => {
  it("uses expanded defaults when config files are missing", async () => {
    const result = await loadConfig(
      { cwd, isProjectTrusted: true },
      dependencies({}),
    );

    expect(result).toEqual({
      ok: true,
      config: {
        ...DEFAULT_CONFIG,
        storageRoot: "/home/test/.pi/agent/session-hoarder",
      },
      paths: { global: globalPath, project: projectPath },
      loadedFrom: [],
    });
  });

  it("applies trusted project capture settings after global settings", async () => {
    const deps = dependencies({
      [globalPath]: JSON.stringify({
        enabled: false,
        debounceMs: 10_000,
        shutdownTimeoutMs: 1_000,
        storageRoot: "archives",
      }),
      [projectPath]: JSON.stringify({
        enabled: true,
        debounceMs: 250,
      }),
    });

    const result = await loadConfig({ cwd, isProjectTrusted: true }, deps);

    expect(result.ok).toBe(true);
    expect(result.config).toEqual({
      enabled: true,
      debounceMs: 250,
      shutdownTimeoutMs: 1_000,
      storageRoot: "/home/test/.pi/agent/archives",
    });
    expect(result.loadedFrom).toEqual([globalPath, projectPath]);
  });

  it.each([
    ["~", "/home/test"],
    ["~/archive", "/home/test/archive"],
    ["/var/lib/hoarder/../sessions", "/var/lib/sessions"],
  ])("expands global storageRoot %s", async (storageRoot, expected) => {
    const result = await loadConfig(
      { cwd, isProjectTrusted: false },
      dependencies({ [globalPath]: JSON.stringify({ storageRoot }) }),
    );

    expect(result.config.storageRoot).toBe(expected);
  });

  it("does not read or apply project config for an untrusted project", async () => {
    const deps = dependencies({
      [globalPath]: JSON.stringify({ debounceMs: 500 }),
      [projectPath]: "not valid JSON",
    });

    const result = await loadConfig({ cwd, isProjectTrusted: false }, deps);

    expect(result.ok).toBe(true);
    expect(result.config.debounceMs).toBe(500);
    expect(deps.readTextFile).not.toHaveBeenCalledWith(projectPath);
  });

  it("rejects storageRoot in trusted project config without discarding valid global settings", async () => {
    const result = await loadConfig(
      { cwd, isProjectTrusted: true },
      dependencies({
        [globalPath]: JSON.stringify({ storageRoot: "/safe/archive" }),
        [projectPath]: JSON.stringify({ storageRoot: "/tmp/exfiltrate" }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.config).toMatchObject({ enabled: false, storageRoot: "/safe/archive" });
    expect(result.loadedFrom).toEqual([globalPath]);
    expect(result.error.kind).toBe("validation");
    expect(result.error.message).toContain('cannot set "storageRoot"');
  });

  it.each([
    [JSON.stringify({ enabled: "yes" }), '"enabled" must be a boolean'],
    [JSON.stringify({ debounceMs: -1 }), '"debounceMs" must be a non-negative safe integer'],
    [JSON.stringify({ shutdownTimeoutMs: 1.5 }), '"shutdownTimeoutMs" must be a non-negative safe integer'],
    [JSON.stringify({ surprise: true }), 'unknown key "surprise"'],
    [JSON.stringify({ storageRoot: "~someone/archive" }), "does not support named-home expansion"],
  ])("disables collection for invalid global config", async (text, expectedMessage) => {
    const result = await loadConfig(
      { cwd, isProjectTrusted: false },
      dependencies({ [globalPath]: text }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.config.enabled).toBe(false);
    expect(result.error.kind).toBe("validation");
    expect(result.error.message).toContain(expectedMessage);
  });

  it("returns an actionable parse error", async () => {
    const result = await loadConfig(
      { cwd, isProjectTrusted: false },
      dependencies({ [globalPath]: "{" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.config.enabled).toBe(false);
    expect(result.error).toMatchObject({ kind: "parse", path: globalPath });
    expect(result.error.message).toContain(globalPath);
  });

  it("returns an actionable non-ENOENT read error", async () => {
    const deps = dependencies({});
    deps.readTextFile = vi.fn(async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    const result = await loadConfig({ cwd, isProjectTrusted: false }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.config.enabled).toBe(false);
    expect(result.error).toEqual({
      kind: "read",
      path: globalPath,
      message: `Unable to read global Session Hoarder config at ${globalPath}: permission denied`,
    });
  });
});
