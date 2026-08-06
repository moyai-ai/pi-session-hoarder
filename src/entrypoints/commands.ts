import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { StorageTarget } from "../application/configuration.js";
import { formatDetailedStatus } from "../application/status.js";
import { alignRows, formatBytes } from "./formatting.js";
import type { HoarderController } from "./lifecycle.js";
import { PiS3SetupPrompter } from "./s3-setup-prompter.js";

const USAGE =
  "Usage: /hoarder status | /hoarder sync | /hoarder git enable | /hoarder storage local | /hoarder storage s3 | /hoarder prune";

export function registerHoarderCommands(pi: ExtensionAPI, controller: HoarderController): void {
  pi.registerCommand("hoarder", {
    description: "Inspect, configure, or synchronize the Session Hoarder archive",
    handler: async (args, ctx) => {
      const command = parseCommand(args);
      if (command.kind === "invalid") {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      if (command.kind === "status") {
        ctx.ui.notify(formatDetailedStatus(controller.getStatusSnapshot()), "info");
        return;
      }
      if (command.kind === "sync") {
        await runSync(controller, ctx.sessionManager.getSessionId(), ctx.ui.notify);
        return;
      }
      if (command.kind === "prune") {
        await runPrune(
          controller,
          ctx.sessionManager.getSessionId(),
          ctx.hasUI
            ? {
                confirm: (preview) =>
                  ctx.ui.confirm("Prune local Session Hoarder cache?", formatPrunePreview(preview)),
              }
            : undefined,
          ctx.ui.notify,
        );
        return;
      }
      if (command.kind === "storage") {
        if (command.target === "s3" && !controller.getStatusSnapshot().config?.s3) {
          await setupS3(controller, ctx);
        } else {
          await selectStorage(
            controller,
            command.target,
            ctx.sessionManager.getSessionId(),
            ctx.ui.notify,
          );
        }
        return;
      }
      await enableGitCatalog(controller, ctx.sessionManager.getSessionId(), ctx.ui.notify);
    },
  });
}

type ParsedCommand =
  | { kind: "status" }
  | { kind: "sync" }
  | { kind: "storage"; target: StorageTarget }
  | { kind: "git-enable" }
  | { kind: "prune" }
  | { kind: "invalid" };

function parseCommand(args: string): ParsedCommand {
  const normalized = args.trim().replace(/\s+/g, " ");
  if (normalized === "" || normalized === "status") return { kind: "status" };
  if (normalized === "sync") return { kind: "sync" };
  if (normalized === "git enable") return { kind: "git-enable" };
  if (normalized === "prune") return { kind: "prune" };
  if (normalized === "storage local") return { kind: "storage", target: "local" };
  if (normalized === "storage s3") return { kind: "storage", target: "s3" };
  return { kind: "invalid" };
}

async function runSync(
  controller: HoarderController,
  sessionId: string,
  notify: (message: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
  try {
    const result = await controller.sync(sessionId);
    if (!result.checkpoint) {
      notify("Session Hoarder did not run a checkpoint.", "warning");
    } else if (result.checkpoint.changed) {
      notify(
        `Session Hoarder committed revision ${formatRevision(result.checkpoint.record.revision)}.`,
        "info",
      );
    } else {
      notify(
        `Session Hoarder is already current at revision ${formatRevision(result.checkpoint.record.revision)}.`,
        "info",
      );
    }
    if (result.replication) {
      notify(
        `Session Hoarder published revision ${formatRevision(result.replication.record.revision)} to remote storage.`,
        "info",
      );
    } else if (result.replicationError) {
      notify(`Session Hoarder remote sync failed: ${result.replicationError}`, "error");
    }
    if (result.projection) {
      notify(
        `Session Hoarder wrote project catalog revision ${formatRevision(result.projection.revision)}.`,
        "info",
      );
    } else if (result.projectionError) {
      notify(`Session Hoarder project catalog failed: ${result.projectionError}`, "error");
    }
  } catch (error) {
    notify(`Session Hoarder sync failed: ${errorMessage(error)}`, "error");
  }
}

async function selectStorage(
  controller: HoarderController,
  target: StorageTarget,
  sessionId: string,
  notify: (message: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
  try {
    const selected = await controller.selectStorageTarget(target, sessionId);
    notify(`Session Hoarder storage target is now ${selected}.`, "info");
  } catch (error) {
    notify(`Session Hoarder storage selection failed: ${errorMessage(error)}`, "error");
  }
}

async function setupS3(controller: HoarderController, ctx: ExtensionCommandContext): Promise<void> {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!ctx.hasUI) {
    const path =
      controller.getStatusSnapshot().globalConfigPath ?? "~/.pi/agent/session-hoarder.json";
    ctx.ui.notify(
      `Interactive S3 setup requires UI. Configure the global file at ${path} with storageTarget, s3.targetId, s3.bucket, s3.region, s3.prefix, and s3.forcePathStyle, then run /hoarder storage s3 again.`,
      "error",
    );
    return;
  }
  try {
    const prompter = new PiS3SetupPrompter(ctx);
    const initial = controller.getS3SetupInitial(sessionId);
    const draft = await prompter.collect(initial);
    if (!draft) {
      ctx.ui.notify(
        "Session Hoarder S3 setup was cancelled; configuration is unchanged.",
        "warning",
      );
      return;
    }
    const preview = await controller.prepareS3Setup(draft, sessionId);
    const choice = await prompter.confirmPreview(preview);
    if (choice === "cancel") {
      ctx.ui.notify(
        "Session Hoarder S3 setup was cancelled; configuration is unchanged.",
        "warning",
      );
      return;
    }
    const result = await controller.completeS3Setup(preview, choice, sessionId);
    ctx.ui.notify(
      result.verified
        ? `Session Hoarder verified and selected ${result.target}.`
        : `Session Hoarder configured and selected ${result.target}; remote verification is pending.`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(`Session Hoarder S3 setup failed: ${errorMessage(error)}`, "error");
  }
}

async function runPrune(
  controller: HoarderController,
  sessionId: string,
  confirmation: Parameters<HoarderController["prune"]>[0],
  notify: (message: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
  try {
    const result = await controller.prune(confirmation, sessionId);
    if (!result.confirmed) {
      notify("Session Hoarder prune was cancelled.", "warning");
      return;
    }
    const level = result.failedObjects > 0 || result.interrupted ? "warning" : "info";
    notify(formatPruneResult(result), level);
  } catch (error) {
    notify(`Session Hoarder prune failed: ${errorMessage(error)}`, "error");
  }
}

function formatPrunePreview(preview: {
  eligibleObjects: number;
  skippedObjects: number;
  eligibleEncodedBytes: number;
  eligibleAllocatedBytes: number;
}): string {
  return alignRows([
    ["Eligible objects", formatRevision(preview.eligibleObjects)],
    ["Eligible encoded", formatBytes(preview.eligibleEncodedBytes)],
    ["Estimated disk", formatBytes(preview.eligibleAllocatedBytes)],
    ["Skipped objects", formatRevision(preview.skippedObjects)],
    ["After prune", "remote-only; no in-product restore command"],
  ]);
}

function formatPruneResult(result: {
  removedObjects: number;
  skippedObjects: number;
  recoveredBytes: number;
  failedObjects: number;
  invalidReceiptRecords: number;
  interrupted: boolean;
}): string {
  return alignRows([
    ["Removed objects", formatRevision(result.removedObjects)],
    ["Skipped objects", formatRevision(result.skippedObjects)],
    ["Recovered", formatBytes(result.recoveredBytes)],
    ["Failed objects", formatRevision(result.failedObjects)],
    ["Invalid receipts", formatRevision(result.invalidReceiptRecords)],
    ["Interrupted", result.interrupted ? "yes" : "no"],
  ]);
}

async function enableGitCatalog(
  controller: HoarderController,
  sessionId: string,
  notify: (message: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
  try {
    await controller.enableGitCatalog(sessionId);
    notify("Session Hoarder Git catalog publication is enabled for this project.", "info");
  } catch (error) {
    notify(`Session Hoarder Git enablement failed: ${errorMessage(error)}`, "error");
  }
}

function formatRevision(revision: number): string {
  return String(revision).padStart(5, "0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
