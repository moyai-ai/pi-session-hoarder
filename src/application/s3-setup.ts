import type { S3TargetConfig } from "./configuration.js";

export interface S3SetupDraft {
  targetId: string;
  bucket: string;
  region: string;
  prefix: string;
  endpoint: string;
  profile: string;
  forcePathStyle: boolean;
}

export interface S3SetupInitial extends S3SetupDraft {
  globalConfigPath: string;
}

export interface S3SetupPreview {
  target: S3TargetConfig;
  objectCount: number;
  encodedBytes: number;
  endpointDisplay: string;
  profileDisplay: string;
}

export type S3SetupChoice = "upload-and-save" | "save-without-test" | "cancel";

export interface S3SetupPrompter {
  collect(initial: S3SetupInitial): Promise<S3SetupDraft | undefined>;
  confirmPreview(preview: S3SetupPreview): Promise<S3SetupChoice>;
}

export interface S3TargetDraftValidator {
  validate(draft: S3SetupDraft): S3TargetConfig;
}

export function setupDraftFromTarget(
  target: S3TargetConfig | undefined,
  globalConfigPath: string,
  defaultRegion = "us-east-1",
): S3SetupInitial {
  const initial = defaultSetupDraft(globalConfigPath, defaultRegion);
  return target ? { ...initial, ...draftFromTarget(target) } : initial;
}

function defaultSetupDraft(globalConfigPath: string, region: string): S3SetupInitial {
  return {
    globalConfigPath,
    targetId: "backup",
    bucket: "",
    region,
    prefix: "session-hoarder",
    endpoint: "",
    profile: "",
    forcePathStyle: false,
  };
}

function draftFromTarget(target: S3TargetConfig): S3SetupDraft {
  return {
    targetId: target.targetId,
    bucket: target.bucket,
    region: target.region,
    prefix: target.prefix,
    endpoint: optionalText(target.endpoint),
    profile: optionalText(target.profile),
    forcePathStyle: target.forcePathStyle,
  };
}

function optionalText(value: string | undefined): string {
  return value ?? "";
}
