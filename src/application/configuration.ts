export type StorageTarget = "local" | "s3";

export type ServerSideEncryption = "AES256" | "aws:kms";

export interface S3TargetConfig {
  targetId: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  profile?: string;
  forcePathStyle: boolean;
  serverSideEncryption?: ServerSideEncryption;
  kmsKeyId?: string;
}

export interface HoarderConfig {
  enabled: boolean;
  debounceMs: number;
  shutdownTimeoutMs: number;
  retrievalConfirmationBytes?: number;
  storageRoot: string;
  storageTarget: StorageTarget;
  s3?: S3TargetConfig;
  gitCatalogEnabled: boolean;
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

export interface ConfigLoadWarning {
  kind: "remote-validation";
  path: string;
  message: string;
}

export type ConfigLoadResult =
  | {
      ok: true;
      config: HoarderConfig;
      paths: ConfigPaths;
      loadedFrom: readonly string[];
      warning?: ConfigLoadWarning;
    }
  | {
      ok: false;
      config: HoarderConfig;
      paths: ConfigPaths;
      loadedFrom: readonly string[];
      error: ConfigLoadError;
    };

export interface ConfigurationWriter {
  selectStorageTarget(target: StorageTarget): Promise<void>;
  enableGitCatalog(cwd: string): Promise<void>;
}
