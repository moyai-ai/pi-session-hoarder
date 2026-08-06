import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerHoarderCommands } from "../../src/entrypoints/commands.js";
import type { HoarderController } from "../../src/entrypoints/lifecycle.js";
import type { SessionArchiveRecord } from "../../src/domain/model.js";

function record(): SessionArchiveRecord {
  const digest = "a".repeat(64);
  return {
    schemaVersion: 2,
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
      config: {
        enabled: true,
        debounceMs: 30_000,
        shutdownTimeoutMs: 3_000,
        storageRoot: "/archive",
        storageTarget: "local",
        gitCatalogEnabled: false,
      },
      checkpoint: { state: "idle", revision: 2 },
      record: record(),
    }),
    sync: async () => ({ checkpoint: { changed: true, record: record() } }),
    selectStorageTarget: async (target) => target,
    enableGitCatalog: async () => undefined,
    prune: async () => ({
      localObjects: 0,
      eligibleObjects: 0,
      skippedObjects: 0,
      eligibleEncodedBytes: 0,
      eligibleAllocatedBytes: 0,
      invalidReceiptRecords: 0,
      confirmed: true,
      removedObjects: 0,
      recoveredBytes: 0,
      failedObjects: 0,
      interrupted: false,
    }),
    ...controllerOverrides,
  };
  registerHoarderCommands(api, controller);
  const notify = vi.fn();
  if (!command) throw new Error("command not registered");
  return { command, notify };
}

describe("/hoarder", () => {
  it("shows detailed status by default", async () => {
    const { command, notify } = setup();

    await command.handler("", {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Local revision:      00002"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Storage root:        /archive"),
      "info",
    );
  });

  it("runs an immediate sync", async () => {
    const sync = vi.fn(async () => ({
      checkpoint: { changed: true, record: record() },
    }));
    const { command, notify } = setup({ sync });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("sync", ctx);

    expect(sync).toHaveBeenCalledWith("session");
    expect(notify).toHaveBeenCalledWith("Session Hoarder committed revision 00002.", "info");
  });

  it("reports local and remote sync outcomes independently", async () => {
    const replica = {
      schemaVersion: 1 as const,
      targetId: "backup",
      repositoryId: "repo",
      sessionId: "session",
      revision: 2,
      objects: [{ object: record().sessionObject, key: "objects/session.gz" }],
      verifiedAt: "2026-08-05T12:00:00.000Z",
    };
    const { command, notify } = setup({
      sync: async () => ({
        checkpoint: { changed: false, record: record() },
        replication: { changed: true, record: replica },
        projection: { revision: 2, path: "/worktree/.pi/session-hoarder/catalog/session.json" },
      }),
    });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("sync", ctx);

    expect(notify).toHaveBeenCalledWith(
      "Session Hoarder is already current at revision 00002.",
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      "Session Hoarder published revision 00002 to remote storage.",
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      "Session Hoarder wrote project catalog revision 00002.",
      "info",
    );
  });

  it("reports sync failures without throwing", async () => {
    const { command, notify } = setup({
      sync: async () => {
        throw new Error("disk full");
      },
    });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("sync", ctx);

    expect(notify).toHaveBeenCalledWith("Session Hoarder sync failed: disk full", "error");
  });

  it.each([
    ["storage local", "local"],
    ["storage s3", "s3"],
  ] as const)("selects storage with %s", async (args, target) => {
    const selectStorageTarget = vi.fn(async () => (target === "s3" ? "s3:backup" : "local"));
    const { command, notify } = setup({ selectStorageTarget });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler(args, ctx);

    expect(selectStorageTarget).toHaveBeenCalledWith(target, "session");
    expect(notify).toHaveBeenCalledWith(
      `Session Hoarder storage target is now ${target === "s3" ? "s3:backup" : "local"}.`,
      "info",
    );
  });

  it("previews and reports confirmed prune results with aligned output", async () => {
    const prune = vi.fn(async (confirmation) => {
      const preview = {
        localObjects: 3,
        eligibleObjects: 2,
        skippedObjects: 1,
        eligibleEncodedBytes: 1536,
        eligibleAllocatedBytes: 4096,
        invalidReceiptRecords: 0,
      };
      const confirmed = await confirmation!.confirm(preview);
      return {
        ...preview,
        confirmed,
        removedObjects: confirmed ? 2 : 0,
        recoveredBytes: confirmed ? 4096 : 0,
        failedObjects: 0,
        interrupted: false,
      };
    });
    const { command, notify } = setup({ prune });
    const confirm = vi.fn(async () => true);
    const ctx = {
      hasUI: true,
      ui: { notify, confirm },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("prune", ctx);

    expect(prune).toHaveBeenCalledWith(expect.anything(), "session");
    expect(confirm).toHaveBeenCalledWith(
      "Prune local Session Hoarder cache?",
      "Eligible objects: 00002\nEligible encoded: 1.5 KiB\nEstimated disk  : 4.0 KiB\nSkipped objects : 00001",
    );
    expect(notify).toHaveBeenCalledWith(
      "Removed objects : 00002\nSkipped objects : 00001\nRecovered       : 4.0 KiB\nFailed objects  : 00000\nInvalid receipts: 00000\nInterrupted     : no",
      "info",
    );
  });

  it("reports a declined prune without deleting", async () => {
    const prune = vi.fn(async (confirmation) => ({
      localObjects: 1,
      eligibleObjects: 1,
      skippedObjects: 0,
      eligibleEncodedBytes: 10,
      eligibleAllocatedBytes: 512,
      invalidReceiptRecords: 0,
      confirmed: await confirmation!.confirm({
        localObjects: 1,
        eligibleObjects: 1,
        skippedObjects: 0,
        eligibleEncodedBytes: 10,
        eligibleAllocatedBytes: 512,
        invalidReceiptRecords: 0,
      }),
      removedObjects: 0,
      recoveredBytes: 0,
      failedObjects: 0,
      interrupted: false,
    }));
    const { command, notify } = setup({ prune });
    await command.handler("prune", {
      hasUI: true,
      ui: { notify, confirm: async () => false },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith("Session Hoarder prune was cancelled.", "warning");
  });

  it("enables Git catalog publication explicitly", async () => {
    const enableGitCatalog = vi.fn(async () => undefined);
    const { command, notify } = setup({ enableGitCatalog });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("git enable", ctx);

    expect(enableGitCatalog).toHaveBeenCalledWith("session");
    expect(notify).toHaveBeenCalledWith(
      "Session Hoarder Git catalog publication is enabled for this project.",
      "info",
    );
  });

  it("reports storage selection failures", async () => {
    const { command, notify } = setup({
      selectStorageTarget: async () => {
        throw new Error("No S3 target is configured");
      },
    });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("storage s3", ctx);

    expect(notify).toHaveBeenCalledWith(
      "Session Hoarder storage selection failed: No S3 target is configured",
      "error",
    );
  });

  it("rejects unsupported subcommands", async () => {
    const { command, notify } = setup();
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("restore", ctx);

    expect(notify).toHaveBeenCalledWith(
      "Usage: /hoarder status | /hoarder sync | /hoarder git enable | /hoarder storage local | /hoarder storage s3 | /hoarder prune",
      "warning",
    );
  });
});
