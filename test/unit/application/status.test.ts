import { describe, expect, it } from "vitest";

import {
  formatDetailedStatus,
  formatFooterStatus,
} from "../../../src/application/status.js";

describe("status formatting", () => {
  it.each([
    [{ checkpoint: { state: "idle" as const } }, "◇hoard"],
    [{ checkpoint: { state: "pending" as const, dirtyReasons: ["message"] } }, "↑1 hoard"],
    [{ checkpoint: { state: "running" as const, startedAt: "now" } }, "⠋hoard"],
    [{ checkpoint: { state: "disabled" as const } }, "○hoard off"],
    [{ checkpoint: { state: "idle" as const }, initializationError: "bad" }, "!hoard"],
  ])("formats compact footer state", (snapshot, expected) => {
    expect(formatFooterStatus(snapshot)).toBe(expected);
  });

  it("accepts the current animation frame for a running checkpoint", () => {
    expect(
      formatFooterStatus(
        { checkpoint: { state: "running", startedAt: "now" } },
        "⠹",
      ),
    ).toBe("⠹hoard");
  });

  it("keeps error detail available on demand", () => {
    const text = formatDetailedStatus({
      sessionId: "session",
      checkpoint: {
        state: "error",
        error: { code: "ENOSPC", message: "disk full", occurredAt: "now", retryable: true },
      },
    });

    expect(text).toContain("Hoarder: error");
    expect(text).toContain("Last error: disk full");
  });
});
