import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import type {
  ConfigLoadError,
  ConfigLoadOptions,
  ConfigLoadResult,
  ConfigLoadWarning,
  ConfigPaths,
  ConfigurationWriter,
  HoarderConfig,
  S3TargetConfig,
  StorageTarget,
} from "../application/configuration.js";
import type { S3SetupDraft, S3TargetDraftValidator } from "../application/s3-setup.js";
import { normalizeS3Prefix } from "../application/s3-target.js";
import { atomicWriteFile, serializeFileOperation } from "./filesystem/atomic-file.js";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  debounceMs: 30_000,
  shutdownTimeoutMs: 3_000,
  retrievalConfirmationBytes: 100 * 1024 * 1024,
  storageRoot: "~/.pi/agent/session-hoarder",
  storageTarget: "local",
  gitCatalogEnabled: false,
} satisfies HoarderConfig);

export interface ConfigDependencies {
  readTextFile(path: string): Promise<string>;
  agentDir: string;
  configDirName: string;
  homeDir: string;
}

export interface ConfigWriterDependencies {
  readTextFile(path: string): Promise<string>;
  atomicWrite(path: string, data: string): Promise<void>;
  agentDir: string;
  configDirName: string;
}

type ConfigKey = keyof HoarderConfig;
type ConfigPatch = Partial<HoarderConfig>;
type ConfigScope = "global" | "project";

const CONFIG_FILE_NAME = "session-hoarder.json";
const ALL_CONFIG_KEYS = new Set<ConfigKey>([
  "enabled",
  "debounceMs",
  "shutdownTimeoutMs",
  "retrievalConfirmationBytes",
  "storageRoot",
  "storageTarget",
  "s3",
  "gitCatalogEnabled",
]);
const GLOBAL_CONFIG_KEYS = new Set<ConfigKey>([
  "enabled",
  "debounceMs",
  "shutdownTimeoutMs",
  "retrievalConfirmationBytes",
  "storageRoot",
  "storageTarget",
  "s3",
]);
const PROJECT_CONFIG_KEYS = new Set<ConfigKey>([
  "enabled",
  "debounceMs",
  "shutdownTimeoutMs",
  "gitCatalogEnabled",
]);

const defaultDependencies: ConfigDependencies = {
  readTextFile: (path) => readFile(path, "utf8"),
  agentDir: getAgentDir(),
  configDirName: CONFIG_DIR_NAME,
  homeDir: homedir(),
};

const defaultWriterDependencies: ConfigWriterDependencies = {
  readTextFile: (path) => readFile(path, "utf8"),
  atomicWrite: atomicWriteFile,
  agentDir: getAgentDir(),
  configDirName: CONFIG_DIR_NAME,
};

export async function loadConfig(
  options: ConfigLoadOptions,
  dependencyOverrides: Partial<ConfigDependencies> = {},
): Promise<ConfigLoadResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const paths = configPaths(options.cwd, dependencies.agentDir, dependencies.configDirName);
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
    return successResult(config, paths, loadedFrom, globalResult.warning);
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

  return successResult(config, paths, loadedFrom, globalResult.warning);
}

export function createConfigurationWriter(
  dependencyOverrides: Partial<ConfigWriterDependencies> = {},
): ConfigurationWriter {
  const dependencies = { ...defaultWriterDependencies, ...dependencyOverrides };
  return {
    configureAndSelectS3: async (target) => {
      const path = join(dependencies.agentDir, CONFIG_FILE_NAME);
      const validated = validateS3TargetObject({ ...target });
      await mutateConfigFile(path, dependencies, (config) => ({
        ...config,
        s3: validated,
        storageTarget: "s3",
      }));
    },
    selectStorageTarget: async (target) => {
      const path = join(dependencies.agentDir, CONFIG_FILE_NAME);
      await mutateConfigFile(path, dependencies, (config) => ({
        ...config,
        storageTarget: target,
      }));
    },
    enableGitCatalog: async (cwd) => {
      const path = join(cwd, dependencies.configDirName, CONFIG_FILE_NAME);
      await mutateConfigFile(path, dependencies, (config) => ({
        ...config,
        gitCatalogEnabled: true,
      }));
    },
  };
}

function successResult(
  config: HoarderConfig,
  paths: ConfigPaths,
  loadedFrom: readonly string[],
  warning?: ConfigLoadWarning,
): ConfigLoadResult {
  return warning
    ? { ok: true, config, paths, loadedFrom, warning }
    : { ok: true, config, paths, loadedFrom };
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
): Promise<
  | { ok: true; patch?: ConfigPatch; warning?: ConfigLoadWarning }
  | { ok: false; error: ConfigLoadError }
> {
  let text: string;
  try {
    text = await readTextFile(path);
  } catch (error) {
    if (isMissingFileError(error)) return { ok: true };
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
    const validated = validateConfig(value, scope, path, homeDir);
    return {
      ok: true,
      patch: validated.patch,
      ...(validated.warning ? { warning: validated.warning } : {}),
    };
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
): { patch: ConfigPatch; warning?: ConfigLoadWarning } {
  const config = requireConfigObject(value, scope, configPath);
  validateConfigKeys(config, scope, configPath);

  const patch = captureSettings(config, scope, configPath, homeDir);
  if (scope === "project") {
    const gitCatalogEnabled = optionalBoolean(config, "gitCatalogEnabled", scope);
    if (gitCatalogEnabled !== undefined) patch.gitCatalogEnabled = gitCatalogEnabled;
    return { patch };
  }

  try {
    const storageTarget = optionalStorageTarget(config);
    const s3 = optionalS3Target(config);
    if (storageTarget === "s3" && !s3) {
      throw new Error(
        'Global Session Hoarder config "storageTarget" cannot be "s3" without a valid "s3" target.',
      );
    }
    if (storageTarget !== undefined) patch.storageTarget = storageTarget;
    if (s3) patch.s3 = s3;
    return { patch };
  } catch (error) {
    return {
      patch: { ...patch, storageTarget: "local" },
      warning: {
        kind: "remote-validation",
        path: configPath,
        message: `${errorMessage(error)} Remote storage is disabled; local collection remains enabled.`,
      },
    };
  }
}

function captureSettings(
  config: Record<string, unknown>,
  scope: ConfigScope,
  configPath: string,
  homeDir: string,
): ConfigPatch {
  const patch: ConfigPatch = {};
  const enabled = optionalBoolean(config, "enabled", scope);
  const debounceMs = optionalMilliseconds(config, "debounceMs", scope);
  const shutdownTimeoutMs = optionalMilliseconds(config, "shutdownTimeoutMs", scope);
  const retrievalConfirmationBytes = optionalMilliseconds(
    config,
    "retrievalConfirmationBytes",
    scope,
  );
  const storageRoot = optionalStorageRoot(config, scope, configPath, homeDir);
  if (enabled !== undefined) patch.enabled = enabled;
  if (debounceMs !== undefined) patch.debounceMs = debounceMs;
  if (shutdownTimeoutMs !== undefined) patch.shutdownTimeoutMs = shutdownTimeoutMs;
  if (retrievalConfirmationBytes !== undefined)
    patch.retrievalConfirmationBytes = retrievalConfirmationBytes;
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
  const allowedKeys = scope === "global" ? GLOBAL_CONFIG_KEYS : PROJECT_CONFIG_KEYS;
  for (const key of Object.keys(config)) {
    if (!ALL_CONFIG_KEYS.has(key as ConfigKey)) {
      throw new Error(
        `${scopeLabel(scope)} config at ${configPath} contains unknown key "${key}".`,
      );
    }
    if (!allowedKeys.has(key as ConfigKey)) {
      throw new Error(
        `${scopeLabel(scope)} config at ${configPath} cannot set "${key}"; configure it ${scope === "global" ? "per trusted project" : "globally"} instead.`,
      );
    }
  }
}

function optionalBoolean(
  config: Record<string, unknown>,
  key: "enabled" | "gitCatalogEnabled",
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
  key: "debounceMs" | "shutdownTimeoutMs" | "retrievalConfirmationBytes",
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

function optionalStorageTarget(config: Record<string, unknown>): StorageTarget | undefined {
  if (!("storageTarget" in config)) return undefined;
  if (config.storageTarget !== "local" && config.storageTarget !== "s3") {
    throw new Error('Global Session Hoarder config "storageTarget" must be "local" or "s3".');
  }
  return config.storageTarget;
}

function optionalS3Target(config: Record<string, unknown>): S3TargetConfig | undefined {
  if (!("s3" in config)) return undefined;
  if (!isPlainObject(config.s3)) {
    throw new Error('Global Session Hoarder config "s3" must be a JSON object.');
  }
  return validateS3TargetObject(config.s3);
}

export function createS3TargetDraftValidator(): S3TargetDraftValidator {
  return { validate: validateS3SetupDraft };
}

export function validateS3SetupDraft(draft: S3SetupDraft): S3TargetConfig {
  return validateS3TargetObject({
    targetId: draft.targetId,
    bucket: draft.bucket,
    region: draft.region,
    prefix: draft.prefix,
    ...(draft.endpoint.trim() ? { endpoint: draft.endpoint } : {}),
    ...(draft.profile.trim() ? { profile: draft.profile } : {}),
    forcePathStyle: draft.forcePathStyle,
  });
}

function validateS3TargetObject(s3: Record<string, unknown>): S3TargetConfig {
  validateS3Keys(s3);
  const targetId = requiredString(s3, "targetId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(targetId)) {
    throw new Error(
      'Global Session Hoarder config "s3.targetId" must be a filesystem-safe name of at most 64 characters.',
    );
  }
  const bucket = safeRequiredString(s3, "bucket", 255);
  const region = safeRequiredString(s3, "region", 128);
  const endpoint = optionalEndpoint(s3);
  const profile = optionalSafeString(s3, "profile", 128);
  if (profile && !/^[A-Za-z0-9][A-Za-z0-9_+=,.@-]{0,127}$/.test(profile)) {
    throw new Error(
      'Global Session Hoarder config "s3.profile" must be a safe AWS profile name of at most 128 characters.',
    );
  }
  return {
    targetId,
    bucket,
    region,
    prefix: normalizeS3Prefix(optionalString(s3, "prefix") ?? "session-hoarder"),
    forcePathStyle: optionalBooleanField(s3, "forcePathStyle") ?? false,
    ...(endpoint ? { endpoint } : {}),
    ...(profile ? { profile } : {}),
  };
}

function validateS3Keys(config: Record<string, unknown>): void {
  const allowed = new Set([
    "targetId",
    "bucket",
    "region",
    "prefix",
    "endpoint",
    "profile",
    "forcePathStyle",
  ]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key))
      throw new Error(`Global Session Hoarder config contains unknown key "s3.${key}".`);
  }
}

function requiredString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Global Session Hoarder config "s3.${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(config: Record<string, unknown>, key: string): string | undefined {
  if (!(key in config)) return undefined;
  const value = config[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Global Session Hoarder config "s3.${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function safeRequiredString(
  config: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = requiredString(config, key);
  assertSafeS3String(value, key, maxLength);
  return value;
}

function optionalSafeString(
  config: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = optionalString(config, key);
  if (!value) return undefined;
  assertSafeS3String(value, key, maxLength);
  return value;
}

function assertSafeS3String(value: string, key: string, maxLength: number): void {
  if (value.length > maxLength || /\p{Cc}/u.test(value)) {
    throw new Error(
      `Global Session Hoarder config "s3.${key}" must not contain control characters and must be at most ${maxLength} characters.`,
    );
  }
}

function optionalBooleanField(config: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in config)) return undefined;
  if (typeof config[key] !== "boolean") {
    throw new Error(`Global Session Hoarder config "s3.${key}" must be a boolean.`);
  }
  return config[key];
}

function optionalEndpoint(config: Record<string, unknown>): string | undefined {
  const value = optionalString(config, "endpoint");
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Global Session Hoarder config "s3.endpoint" must be an absolute HTTP(S) URL.');
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error('Global Session Hoarder config "s3.endpoint" must be an absolute HTTP(S) URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Global Session Hoarder config "s3.endpoint" must not contain userinfo, query parameters, or a fragment.',
    );
  }
  return url.toString().replace(/\/$/, "");
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
  if (value === "~") return normalize(homeDir);
  if (value.startsWith("~/")) return normalize(join(homeDir, value.slice(2)));
  if (value.startsWith("~")) {
    throw new Error(`Config "storageRoot" does not support named-home expansion: "${value}".`);
  }
  if (isAbsolute(value)) return normalize(value);
  return resolve(dirname(configPath), value);
}

async function mutateConfigFile(
  path: string,
  dependencies: ConfigWriterDependencies,
  mutate: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await serializeFileOperation(path, async () => {
    let config: Record<string, unknown> = {};
    try {
      const text = await dependencies.readTextFile(path);
      const value: unknown = JSON.parse(text);
      if (!isPlainObject(value)) {
        throw new Error(`Session Hoarder config at ${path} must be a JSON object.`);
      }
      config = value;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(
          `Unable to update Session Hoarder config at ${path}: ${errorMessage(error)}`,
          {
            cause: error,
          },
        );
      }
    }
    await dependencies.atomicWrite(path, `${JSON.stringify(mutate(config), null, 2)}\n`);
  });
}

function configPaths(cwd: string, agentDir: string, configDirName: string): ConfigPaths {
  return {
    global: join(agentDir, CONFIG_FILE_NAME),
    project: join(cwd, configDirName, CONFIG_FILE_NAME),
  };
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
