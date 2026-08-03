import type { HoarderConfig } from "./configuration.js";
import type { CheckpointStatus, SessionArchiveRecord } from "../domain/model.js";

export interface HoarderStatusSnapshot {
  sessionId?: string;
  repositoryId?: string;
  config?: HoarderConfig;
  checkpoint: CheckpointStatus;
  record?: SessionArchiveRecord;
  initializationError?: string;
}

export function formatFooterStatus(
  snapshot: HoarderStatusSnapshot,
  runningIndicator = "⠋",
): string {
  if (snapshot.initializationError || snapshot.checkpoint.state === "error") return "!hoard";
  if (snapshot.checkpoint.state === "disabled") return "○hoard off";
  if (snapshot.checkpoint.state === "pending") return "↑1 hoard";
  if (snapshot.checkpoint.state === "running") return `${runningIndicator}hoard`;
  return "◇hoard";
}

export function formatDetailedStatus(snapshot: HoarderStatusSnapshot): string {
  const lines = [
    `Hoarder: ${describeState(snapshot)}`,
    `Storage: ${snapshot.config?.storageRoot ?? "unavailable"}`,
    `Session: ${snapshot.sessionId ?? "none"}`,
    `Revision: ${snapshot.record?.revision ?? "none"}`,
  ];
  if (snapshot.record) {
    lines.push(
      `Source: ${formatBytes(snapshot.record.source.size)}`,
      `Stored: ${formatBytes(snapshot.record.sessionObject.storedBytes)} (${formatBytes(snapshot.record.sessionObject.logicalBytes)} logical)`,
      `Artifacts: ${snapshot.record.artifacts.length}`,
      `Last success: ${snapshot.record.capturedAt}`,
    );
  }
  const error =
    snapshot.initializationError ??
    (snapshot.checkpoint.state === "error" ? snapshot.checkpoint.error.message : undefined);
  if (error) lines.push(`Last error: ${error}`);
  return lines.join("\n");
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
