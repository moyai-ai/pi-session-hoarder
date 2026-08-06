import type { HoarderConfig } from "./configuration.js";
import type { CheckpointStatus, SessionArchiveRecord } from "../domain/model.js";

export interface HoarderStatusSnapshot {
  sessionId?: string;
  repositoryId?: string;
  config?: HoarderConfig;
  checkpoint: CheckpointStatus;
  record?: SessionArchiveRecord;
  initializationError?: string;
  configurationWarning?: string;
  publishedRevision?: number;
  remoteState?: string;
}

export function formatFooterStatus(
  snapshot: HoarderStatusSnapshot,
  runningIndicator = "⠋",
): string {
  if (
    snapshot.initializationError ||
    snapshot.checkpoint.state === "error" ||
    snapshot.remoteState === "retry pending"
  )
    return "!hoard";
  if (snapshot.checkpoint.state === "disabled") return "○hoard off";
  if (snapshot.checkpoint.state === "pending") return "↑1 hoard";
  if (snapshot.checkpoint.state === "running") return `${runningIndicator}hoard`;
  if (snapshot.remoteState === "pending" || snapshot.remoteState === "synchronizing") {
    return "↑1 hoard";
  }
  return "◇hoard";
}

export function formatDetailedStatus(snapshot: HoarderStatusSnapshot): string {
  const localRevision = snapshot.record?.revision;
  const target = targetLabel(snapshot.config);
  const publishedRevision =
    snapshot.publishedRevision ??
    (snapshot.config?.storageTarget === "local" ? localRevision : undefined);
  const rows: Array<readonly [string, string]> = [
    ["Hoarder", describeState(snapshot)],
    ["Storage root", snapshot.config?.storageRoot ?? "unavailable"],
    ["Session", snapshot.sessionId ?? "none"],
    ["Local revision", formatRevision(localRevision)],
    ["Published revision", formatRevision(publishedRevision)],
    ["Target", target],
    ["Remote", snapshot.remoteState ?? defaultRemoteState(snapshot.config)],
  ];
  if (snapshot.record) {
    rows.push(
      ["Source", formatBytes(snapshot.record.source.size)],
      [
        "Stored",
        `${formatBytes(snapshot.record.sessionObject.storedBytes)} (${formatBytes(snapshot.record.sessionObject.logicalBytes)} logical)`,
      ],
      ["Artifacts", String(snapshot.record.artifacts.length)],
      ["Last success", snapshot.record.capturedAt],
    );
  }
  if (snapshot.configurationWarning) rows.push(["Config warning", snapshot.configurationWarning]);
  const error =
    snapshot.initializationError ??
    (snapshot.checkpoint.state === "error" ? snapshot.checkpoint.error.message : undefined);
  if (error) rows.push(["Last error", error]);
  return formatRows(rows);
}

function targetLabel(config: HoarderConfig | undefined): string {
  if (!config || config.storageTarget === "local") return "local";
  return config.s3 ? `s3:${config.s3.targetId}` : "s3:unconfigured";
}

function defaultRemoteState(config: HoarderConfig | undefined): string {
  if (!config || config.storageTarget === "local") return "off";
  return config.s3 ? "not synchronized" : "configuration required";
}

function formatRows(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([label]) => label.length)) + 3;
  return rows.map(([label, value]) => `${label}:`.padEnd(width) + value).join("\n");
}

function formatRevision(revision: number | undefined): string {
  return revision === undefined ? "none" : String(revision).padStart(5, "0");
}

function describeState(snapshot: HoarderStatusSnapshot): string {
  if (snapshot.initializationError) return "error";
  switch (snapshot.checkpoint.state) {
    case "disabled":
      return snapshot.checkpoint.reason ? `off (${snapshot.checkpoint.reason})` : "off";
    case "idle":
      return "ready";
    case "pending":
      return "pending";
    case "running":
      return "syncing";
    case "error":
      return "error";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}
