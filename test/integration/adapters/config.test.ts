import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CONFIG,
  createConfigurationWriter,
  loadConfig,
  type ConfigDependencies,
  type ConfigWriterDependencies,
} from "../../../src/adapters/config.js";

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
    const result = await loadConfig({ cwd, isProjectTrusted: true }, dependencies({}));

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
      retrievalConfirmationBytes: 100 * 1024 * 1024,
      storageRoot: "/home/test/.pi/agent/archives",
      storageTarget: "local",
      gitCatalogEnabled: false,
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

  it("loads a valid global S3 target and trusted project Git catalog enablement", async () => {
    const result = await loadConfig(
      { cwd, isProjectTrusted: true },
      dependencies({
        [globalPath]: JSON.stringify({
          storageTarget: "s3",
          s3: {
            targetId: "backup",
            bucket: "pi-sessions",
            region: "us-east-1",
            prefix: "/archives/pi/",
            endpoint: "http://localhost:9000/",
            forcePathStyle: true,
            serverSideEncryption: "AES256",
          },
        }),
        [projectPath]: JSON.stringify({ gitCatalogEnabled: true }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({
      storageTarget: "s3",
      gitCatalogEnabled: true,
      s3: {
        targetId: "backup",
        bucket: "pi-sessions",
        region: "us-east-1",
        prefix: "archives/pi",
        endpoint: "http://localhost:9000",
        forcePathStyle: true,
        serverSideEncryption: "AES256",
      },
    });
  });

  it("degrades invalid remote configuration to local without disabling collection", async () => {
    const result = await loadConfig(
      { cwd, isProjectTrusted: false },
      dependencies({
        [globalPath]: JSON.stringify({
          storageTarget: "s3",
          s3: { targetId: "bad target", bucket: "bucket", region: "us-east-1" },
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.config).toMatchObject({ enabled: true, storageTarget: "local" });
    if (!result.ok) return;
    expect(result.warning).toMatchObject({ kind: "remote-validation", path: globalPath });
    expect(result.warning?.message).toContain("Remote storage is disabled");
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

  it.each(["storageRoot", "storageTarget", "s3", "retrievalConfirmationBytes"])(
    "rejects %s in trusted project config without discarding valid global settings",
    async (key) => {
      const result = await loadConfig(
        { cwd, isProjectTrusted: true },
        dependencies({
          [globalPath]: JSON.stringify({ storageRoot: "/safe/archive" }),
          [projectPath]: JSON.stringify({ [key]: key === "s3" ? {} : "/tmp/exfiltrate" }),
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.config).toMatchObject({ enabled: false, storageRoot: "/safe/archive" });
      expect(result.loadedFrom).toEqual([globalPath]);
      expect(result.error.kind).toBe("validation");
      expect(result.error.message).toContain(`cannot set "${key}"`);
    },
  );

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
    [
      JSON.stringify({ shutdownTimeoutMs: 1.5 }),
      '"shutdownTimeoutMs" must be a non-negative safe integer',
    ],
    [
      JSON.stringify({ retrievalConfirmationBytes: -1 }),
      '"retrievalConfirmationBytes" must be a non-negative safe integer',
    ],
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

describe("configuration writer", () => {
  it("selects the global target without discarding existing settings", async () => {
    const files = new Map<string, string>([
      [globalPath, `${JSON.stringify({ enabled: false, s3: { targetId: "backup" } })}\n`],
    ]);
    const writer = createConfigurationWriter(writerDependencies(files));

    await writer.selectStorageTarget("s3");

    expect(JSON.parse(files.get(globalPath)!)).toEqual({
      enabled: false,
      s3: { targetId: "backup" },
      storageTarget: "s3",
    });
  });

  it("enables Git catalog publication only in the project config", async () => {
    const files = new Map<string, string>();
    const writer = createConfigurationWriter(writerDependencies(files));

    await writer.enableGitCatalog(cwd);

    expect(JSON.parse(files.get(projectPath)!)).toEqual({ gitCatalogEnabled: true });
    expect(files.has(globalPath)).toBe(false);
  });

  it("refuses to overwrite malformed configuration", async () => {
    const files = new Map<string, string>([[globalPath, "{"]]);
    const writer = createConfigurationWriter(writerDependencies(files));

    await expect(writer.selectStorageTarget("local")).rejects.toThrow(
      "Unable to update Session Hoarder config",
    );
    expect(files.get(globalPath)).toBe("{");
  });
});

function writerDependencies(files: Map<string, string>): ConfigWriterDependencies {
  return {
    agentDir,
    configDirName: ".pi",
    readTextFile: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value !== undefined) return value;
      throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
    }),
    atomicWrite: vi.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
  };
}
