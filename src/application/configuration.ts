export interface HoarderConfig {
  enabled: boolean;
  debounceMs: number;
  shutdownTimeoutMs: number;
  storageRoot: string;
}

export interface ConfigLoadOptions {
  cwd: string;
  isProjectTrusted: boolean;
}

export interface ConfigPaths {
  global: string;
  project: string;
}

export interface ConfigLoadError {
  kind: "read" | "parse" | "validation";
  path: string;
  message: string;
}

export type ConfigLoadResult =
  | {
      ok: true;
      config: HoarderConfig;
      paths: ConfigPaths;
      loadedFrom: readonly string[];
    }
  | {
      ok: false;
      config: HoarderConfig;
      paths: ConfigPaths;
      loadedFrom: readonly string[];
      error: ConfigLoadError;
    };

