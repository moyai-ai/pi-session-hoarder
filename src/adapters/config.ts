import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import type {
  ConfigLoadError,
  ConfigLoadOptions,
  ConfigLoadResult,
  ConfigPaths,
  HoarderConfig,
} from "../application/configuration.js";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  debounceMs: 30_000,
  shutdownTimeoutMs: 3_000,
  storageRoot: "~/.pi/agent/session-hoarder",
} satisfies HoarderConfig);

export interface ConfigDependencies {
  readTextFile(path: string): Promise<string>;
  agentDir: string;
  configDirName: string;
  homeDir: string;
}

type ConfigKey = keyof HoarderConfig;
type ConfigPatch = Partial<HoarderConfig>;
type ConfigScope = "global" | "project";

const CONFIG_FILE_NAME = "session-hoarder.json";
const CONFIG_KEYS = new Set<ConfigKey>([
  "enabled",
  "debounceMs",
  "shutdownTimeoutMs",
  "storageRoot",
]);
const PROJECT_CONFIG_KEYS = new Set<ConfigKey>([
  "enabled",
  "debounceMs",
  "shutdownTimeoutMs",
]);

const defaultDependencies: ConfigDependencies = {
  readTextFile: (path) => readFile(path, "utf8"),
  agentDir: getAgentDir(),
  configDirName: CONFIG_DIR_NAME,
  homeDir: homedir(),
};

export async function loadConfig(
  options: ConfigLoadOptions,
  dependencyOverrides: Partial<ConfigDependencies> = {},
): Promise<ConfigLoadResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const paths = {
    global: join(dependencies.agentDir, CONFIG_FILE_NAME),
    project: join(options.cwd, dependencies.configDirName, CONFIG_FILE_NAME),
  };
  const loadedFrom: string[] = [];

  const defaultConfig = resolveConfigPaths(DEFAULT_CONFIG, paths.global, dependencies.homeDir);
  let config = defaultConfig;

  const globalResult = await readConfigFile(
    paths.global,
    "global",
    dependencies.readTextFile,
    dependencies.homeDir,
  );
  if (!globalResult.ok) {
    return failureResult(config, paths, loadedFrom, globalResult.error);
  }
  if (globalResult.patch) {
    config = { ...config, ...globalResult.patch };
    loadedFrom.push(paths.global);
  }

  if (!options.isProjectTrusted) {
    return { ok: true, config, paths, loadedFrom };
  }

  const projectResult = await readConfigFile(
    paths.project,
    "project",
    dependencies.readTextFile,
    dependencies.homeDir,
  );
  if (!projectResult.ok) {
    return failureResult(config, paths, loadedFrom, projectResult.error);
  }
  if (projectResult.patch) {
    config = { ...config, ...projectResult.patch };
    loadedFrom.push(paths.project);
  }

  return { ok: true, config, paths, loadedFrom };
}

function failureResult(
  effectiveConfig: HoarderConfig,
  paths: ConfigPaths,
  loadedFrom: readonly string[],
  error: ConfigLoadError,
): ConfigLoadResult {
  return {
    ok: false,
    config: { ...effectiveConfig, enabled: false },
    paths,
    loadedFrom,
    error,
  };
}

async function readConfigFile(
  path: string,
  scope: ConfigScope,
  readTextFile: ConfigDependencies["readTextFile"],
  homeDir: string,
): Promise<{ ok: true; patch?: ConfigPatch } | { ok: false; error: ConfigLoadError }> {
  let text: string;
  try {
    text = await readTextFile(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { ok: true };
    }
    return {
      ok: false,
      error: {
        kind: "read",
        path,
        message: `Unable to read ${scope} Session Hoarder config at ${path}: ${errorMessage(error)}`,
      },
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "parse",
        path,
        message: `Invalid JSON in ${scope} Session Hoarder config at ${path}: ${errorMessage(error)}`,
      },
    };
  }

  try {
    return { ok: true, patch: validateConfig(value, scope, path, homeDir) };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "validation",
        path,
        message: errorMessage(error),
      },
    };
  }
}

function validateConfig(
  value: unknown,
  scope: ConfigScope,
  configPath: string,
  homeDir: string,
): ConfigPatch {
  const config = requireConfigObject(value, scope, configPath);
  validateConfigKeys(config, scope, configPath);

  const patch: ConfigPatch = {};
  const enabled = optionalBoolean(config, "enabled", scope);
  const debounceMs = optionalMilliseconds(config, "debounceMs", scope);
  const shutdownTimeoutMs = optionalMilliseconds(config, "shutdownTimeoutMs", scope);
  const storageRoot = optionalStorageRoot(config, scope, configPath, homeDir);
  if (enabled !== undefined) patch.enabled = enabled;
  if (debounceMs !== undefined) patch.debounceMs = debounceMs;
  if (shutdownTimeoutMs !== undefined) patch.shutdownTimeoutMs = shutdownTimeoutMs;
  if (storageRoot !== undefined) patch.storageRoot = storageRoot;
  return patch;
}

function requireConfigObject(
  value: unknown,
  scope: ConfigScope,
  configPath: string,
): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  throw new Error(`${scopeLabel(scope)} config at ${configPath} must be a JSON object.`);
}

function validateConfigKeys(
  config: Record<string, unknown>,
  scope: ConfigScope,
  configPath: string,
): void {
  const allowedKeys = scope === "global" ? CONFIG_KEYS : PROJECT_CONFIG_KEYS;
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key as ConfigKey)) {
      throw new Error(`${scopeLabel(scope)} config at ${configPath} contains unknown key "${key}".`);
    }
    if (!allowedKeys.has(key as ConfigKey)) {
      throw new Error(
        `${scopeLabel(scope)} config at ${configPath} cannot set "${key}"; configure it globally instead.`,
      );
    }
  }
}

function optionalBoolean(
  config: Record<string, unknown>,
  key: "enabled",
  scope: ConfigScope,
): boolean | undefined {
  if (!(key in config)) return undefined;
  if (typeof config[key] !== "boolean") {
    throw new Error(`${scopeLabel(scope)} config "${key}" must be a boolean.`);
  }
  return config[key];
}

function optionalMilliseconds(
  config: Record<string, unknown>,
  key: "debounceMs" | "shutdownTimeoutMs",
  scope: ConfigScope,
): number | undefined {
  if (!(key in config)) return undefined;
  return validateMilliseconds(config[key], key, scope);
}

function optionalStorageRoot(
  config: Record<string, unknown>,
  scope: ConfigScope,
  configPath: string,
  homeDir: string,
): string | undefined {
  if (!("storageRoot" in config)) return undefined;
  const value = config.storageRoot;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${scopeLabel(scope)} config "storageRoot" must be a non-empty string.`);
  }
  if (value.includes("\0")) {
    throw new Error(`${scopeLabel(scope)} config "storageRoot" must not contain a null byte.`);
  }
  return expandStorageRoot(value, configPath, homeDir);
}

function validateMilliseconds(value: unknown, key: string, scope: ConfigScope): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${scopeLabel(scope)} config "${key}" must be a non-negative safe integer.`);
  }
  return value as number;
}

function resolveConfigPaths(
  config: HoarderConfig,
  configPath: string,
  homeDir: string,
): HoarderConfig {
  return {
    ...config,
    storageRoot: expandStorageRoot(config.storageRoot, configPath, homeDir),
  };
}

function expandStorageRoot(value: string, configPath: string, homeDir: string): string {
  if (value === "~") {
    return normalize(homeDir);
  }
  if (value.startsWith("~/")) {
    return normalize(join(homeDir, value.slice(2)));
  }
  if (value.startsWith("~")) {
    throw new Error(`Config "storageRoot" does not support named-home expansion: "${value}".`);
  }
  if (isAbsolute(value)) {
    return normalize(value);
  }
  return resolve(dirname(configPath), value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeLabel(scope: ConfigScope): string {
  return scope === "global" ? "Global Session Hoarder" : "Project Session Hoarder";
}
