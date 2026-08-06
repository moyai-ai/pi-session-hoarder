import { describe, expect, it } from "vitest";

import { formatDetailedStatus, formatFooterStatus } from "../../../src/application/status.js";

describe("status formatting", () => {
  it.each([
    [{ checkpoint: { state: "idle" as const } }, "◇hoard"],
    [{ checkpoint: { state: "pending" as const, dirtyReasons: ["message"] } }, "↑1 hoard"],
    [{ checkpoint: { state: "running" as const, startedAt: "now" } }, "⠋hoard"],
    [{ checkpoint: { state: "disabled" as const } }, "○hoard off"],
    [{ checkpoint: { state: "idle" as const }, initializationError: "bad" }, "!hoard"],
    [{ checkpoint: { state: "idle" as const }, remoteState: "retry pending" }, "!hoard"],
    [{ checkpoint: { state: "idle" as const }, remoteState: "pending" }, "↑1 hoard"],
  ])("formats compact footer state", (snapshot, expected) => {
    expect(formatFooterStatus(snapshot)).toBe(expected);
  });

  it("accepts the current animation frame for a running checkpoint", () => {
    expect(formatFooterStatus({ checkpoint: { state: "running", startedAt: "now" } }, "⠹")).toBe(
      "⠹hoard",
    );
  });

  it("aligns detailed status and pads revisions for presentation", () => {
    const digest = "a".repeat(64);
    const text = formatDetailedStatus({
      sessionId: "session",
      config: {
        enabled: true,
        debounceMs: 30_000,
        shutdownTimeoutMs: 3_000,
        storageRoot: "/archive",
        storageTarget: "s3",
        s3: {
          targetId: "backup",
          bucket: "bucket",
          region: "us-east-1",
          prefix: "session-hoarder",
          forcePathStyle: false,
        },
        gitCatalogEnabled: false,
      },
      checkpoint: { state: "idle", revision: 15 },
      publishedRevision: 14,
      remoteState: "retry pending",
      record: {
        schemaVersion: 2,
        repositoryId: "repo",
        sessionId: "session",
        revision: 15,
        source: { size: 100, mtimeMs: 1, sha256: digest },
        sessionObject: {
          algorithm: "sha256",
          digest,
          encoding: "gzip",
          logicalBytes: 100,
          storedBytes: 50,
        },
        artifacts: [],
        capturedAt: "2026-08-05T12:00:00.000Z",
        lastVerifiedAt: "2026-08-05T12:00:00.000Z",
      },
    });

    expect(text).toContain(
      [
        "Local revision:      00015",
        "Published revision:  00014",
        "Target:              s3:backup",
        "Remote:              retry pending",
      ].join("\n"),
    );
  });

  it("expands revisions beyond five digits", () => {
    const text = formatDetailedStatus({
      config: {
        enabled: true,
        debounceMs: 0,
        shutdownTimeoutMs: 0,
        storageRoot: "/archive",
        storageTarget: "local",
        gitCatalogEnabled: false,
      },
      checkpoint: { state: "idle", revision: 100_000 },
      record: {
        schemaVersion: 2,
        repositoryId: "repo",
        sessionId: "session",
        revision: 100_000,
        source: { size: 0, mtimeMs: 0, sha256: "a".repeat(64) },
        sessionObject: {
          algorithm: "sha256",
          digest: "a".repeat(64),
          encoding: "gzip",
          logicalBytes: 0,
          storedBytes: 0,
        },
        artifacts: [],
        capturedAt: "2026-08-05T12:00:00.000Z",
        lastVerifiedAt: "2026-08-05T12:00:00.000Z",
      },
    });

    expect(text).toContain("Local revision:      100000");
  });

  it("keeps error detail available on demand", () => {
    const text = formatDetailedStatus({
      sessionId: "session",
      checkpoint: {
        state: "error",
        error: { code: "ENOSPC", message: "disk full", occurredAt: "now", retryable: true },
      },
    });

    expect(text).toContain("Hoarder:             error");
    expect(text).toContain("Last error:          disk full");
  });
});
