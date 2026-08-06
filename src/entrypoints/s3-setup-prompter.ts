import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type {
  S3SetupChoice,
  S3SetupDraft,
  S3SetupInitial,
  S3SetupPreview,
  S3SetupPrompter,
} from "../application/s3-setup.js";
import { alignRows, formatBytes } from "./formatting.js";

export class PiS3SetupPrompter implements S3SetupPrompter {
  private readonly ctx: ExtensionCommandContext;

  constructor(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) throw new Error("Interactive S3 setup requires a UI.");
    this.ctx = ctx;
  }

  async collect(initial: S3SetupInitial): Promise<S3SetupDraft | undefined> {
    const service = await this.selectService(initial);
    if (!service) return undefined;
    const bucket = await this.input("S3 bucket", initial.bucket);
    if (bucket === undefined) return undefined;
    const region = await this.input("S3 region", initial.region);
    if (region === undefined) return undefined;
    const connection = await this.collectConnection(service, initial);
    if (!connection) return undefined;
    const profile = await this.collectCredentialProfile(initial.profile);
    if (profile === undefined) return undefined;
    const advanced = await this.collectAdvanced(initial);
    if (!advanced) return undefined;
    return {
      ...advanced,
      bucket,
      region,
      ...connection,
      profile,
    };
  }

  async confirmPreview(preview: S3SetupPreview): Promise<S3SetupChoice> {
    this.ctx.ui.notify(formatS3SetupPreview(preview), "info");
    const choice = await this.ctx.ui.select("Configure this S3 target?", [
      "Upload current session objects, verify, and save",
      "Save without upload test and begin normal synchronization",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return "cancel";
    if (choice === "Save without upload test and begin normal synchronization") {
      return "save-without-test";
    }
    const confirmed = await this.ctx.ui.confirm(
      "Upload private Session Hoarder data?",
      "This sends the current private Pi session and allowlisted sidecar bytes to the configured bucket. Uploaded content-addressed objects will not be deleted automatically. Continue?",
    );
    return confirmed ? "upload-and-save" : "cancel";
  }

  private async selectService(initial: S3SetupInitial): Promise<"aws" | "compatible" | undefined> {
    const aws = "AWS S3";
    const compatible = "S3-compatible service (MinIO, RustFS, etc.)";
    const selected = await this.ctx.ui.select(
      "Storage service",
      initial.endpoint ? [compatible, aws] : [aws, compatible],
    );
    if (selected === aws) return "aws";
    if (selected === compatible) return "compatible";
    return undefined;
  }

  private async collectConnection(
    service: "aws" | "compatible",
    initial: S3SetupInitial,
  ): Promise<Pick<S3SetupDraft, "endpoint" | "forcePathStyle"> | undefined> {
    if (service === "aws") return { endpoint: "", forcePathStyle: false };
    const endpoint = await this.input("S3-compatible endpoint", initial.endpoint);
    if (endpoint === undefined) return undefined;
    const forcePathStyle = await this.selectBoolean(
      "Force path-style S3 addressing?",
      initial.endpoint ? initial.forcePathStyle : true,
    );
    return forcePathStyle === undefined ? undefined : { endpoint, forcePathStyle };
  }

  private async collectCredentialProfile(current: string): Promise<string | undefined> {
    const defaultChain = "Default AWS credential chain";
    const namedProfile = "Named AWS profile";
    const selected = await this.ctx.ui.select(
      "AWS credentials (configure access keys or SSO with the AWS CLI; Hoarder stores no secrets)",
      current ? [namedProfile, defaultChain] : [defaultChain, namedProfile],
    );
    if (selected === defaultChain) return "";
    if (selected !== namedProfile) return undefined;
    return this.input("AWS profile name", current);
  }

  private async collectAdvanced(
    initial: S3SetupInitial,
  ): Promise<Pick<S3SetupDraft, "targetId" | "prefix"> | undefined> {
    const defaults = "Use default target name and object prefix";
    const configure = "Configure target name and object prefix";
    const selected = await this.ctx.ui.select("Advanced settings", [defaults, configure, "Cancel"]);
    if (!selected || selected === "Cancel") return undefined;
    if (selected === defaults) {
      return { targetId: initial.targetId, prefix: initial.prefix };
    }
    const targetId = await this.input("S3 target name", initial.targetId);
    if (targetId === undefined) return undefined;
    const prefix = await this.input("S3 object prefix", initial.prefix);
    return prefix === undefined ? undefined : { targetId, prefix };
  }

  private input(label: string, current: string): Promise<string | undefined> {
    return this.ctx.ui.input(label, current);
  }

  private async selectBoolean(label: string, current: boolean): Promise<boolean | undefined> {
    const yes = current ? "yes (current)" : "yes";
    const no = current ? "no" : "no (current)";
    const selected = await this.ctx.ui.select(label, [yes, no]);
    if (!selected) return undefined;
    return selected.startsWith("yes");
  }
}

export function formatS3SetupPreview(preview: S3SetupPreview): string {
  const target = preview.target;
  return alignRows([
    ["Target", `s3:${target.targetId}`],
    ["Bucket", target.bucket],
    ["Region", target.region],
    ["Prefix", target.prefix],
    ["Endpoint", preview.endpointDisplay],
    ["Profile", preview.profileDisplay],
    ["Path style", target.forcePathStyle ? "yes" : "no"],
    ["Encryption", "bucket settings"],
    ["Upload test", `${preview.objectCount} object(s), ${formatBytes(preview.encodedBytes)}`],
  ]);
}
