import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerHoarderCommands } from "../../src/entrypoints/commands.js";
import type { HoarderController } from "../../src/entrypoints/lifecycle.js";
import type { SessionArchiveRecord } from "../../src/domain/model.js";

function record(): SessionArchiveRecord {
  const digest = "a".repeat(64);
  return {
    schemaVersion: 1,
    repositoryId: "repo",
    sessionId: "session",
    revision: 2,
    source: { size: 100, mtimeMs: 1, sha256: digest },
    sessionObject: {
      algorithm: "sha256",
      digest,
      encoding: "gzip",
      logicalBytes: 100,
      storedBytes: 50,
      relativePath: "objects/session.gz",
    },
    artifacts: [],
    capturedAt: "2026-08-03T12:00:00.000Z",
    lastVerifiedAt: "2026-08-03T12:00:00.000Z",
  };
}

function setup(controllerOverrides: Partial<HoarderController> = {}) {
  let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
  const api = {
    registerCommand: vi.fn((_name: string, options: typeof command) => {
      command = options;
    }),
  } as unknown as ExtensionAPI;
  const controller: HoarderController = {
    getStatusSnapshot: () => ({
      sessionId: "session",
      config: { enabled: true, debounceMs: 30_000, shutdownTimeoutMs: 3_000, storageRoot: "/archive" },
      checkpoint: { state: "idle", revision: 2 },
      record: record(),
    }),
    sync: async () => ({ changed: true, record: record() }),
    ...controllerOverrides,
  };
  registerHoarderCommands(api, controller);
  const notify = vi.fn();
  const ctx = {
    ui: { notify },
    sessionManager: { getSessionId: () => "session" },
  } as unknown as ExtensionCommandContext;
  if (!command) throw new Error("command not registered");
  return { command, notify };
}

describe("/hoarder", () => {
  it("shows detailed status by default", async () => {
    const { command, notify } = setup();

    await command.handler("", { ui: { notify }, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Revision: 2"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Storage: /archive"), "info");
  });

  it("runs an immediate sync", async () => {
    const sync = vi.fn(async () => ({ changed: true, record: record() }));
    const { command, notify } = setup({ sync });
    const ctx = { ui: { notify }, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionCommandContext;

    await command.handler("sync", ctx);

    expect(sync).toHaveBeenCalledWith("session");
    expect(notify).toHaveBeenCalledWith("Session Hoarder committed revision 2.", "info");
  });

  it("reports sync failures without throwing", async () => {
    const { command, notify } = setup({
      sync: async () => {
        throw new Error("disk full");
      },
    });
    const ctx = { ui: { notify }, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionCommandContext;

    await command.handler("sync", ctx);

    expect(notify).toHaveBeenCalledWith("Session Hoarder sync failed: disk full", "error");
  });

  it("rejects unsupported subcommands", async () => {
    const { command, notify } = setup();
    const ctx = { ui: { notify }, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionCommandContext;

    await command.handler("restore", ctx);

    expect(notify).toHaveBeenCalledWith("Usage: /hoarder status | /hoarder sync", "warning");
  });
});
