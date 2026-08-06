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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    getS3SetupInitial: () => ({
      globalConfigPath: "/home/test/.pi/agent/session-hoarder.json",
      targetId: "backup",
      bucket: "",
      region: "us-east-1",
      prefix: "session-hoarder",
      endpoint: "",
      profile: "",
      forcePathStyle: false,
    }),
    prepareS3Setup: async () => {
      throw new Error("not configured for this test");
    },
    completeS3Setup: async () => ({ target: "s3:backup", verified: false }),
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

function configuredS3Status() {
  return {
    sessionId: "session",
    globalConfigPath: "/home/test/.pi/agent/session-hoarder.json",
    config: {
      enabled: true,
      debounceMs: 30_000,
      shutdownTimeoutMs: 3_000,
      storageRoot: "/archive",
      storageTarget: "local" as const,
      s3: {
        targetId: "backup",
        bucket: "private-bucket",
        region: "us-east-1",
        prefix: "session-hoarder",
        forcePathStyle: false,
      },
      gitCatalogEnabled: false,
    },
    checkpoint: { state: "idle" as const, revision: 2 },
    record: record(),
  };
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

  it("selects local storage directly", async () => {
    const selectStorageTarget = vi.fn(async () => "local");
    const { command, notify } = setup({ selectStorageTarget });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("storage local", ctx);

    expect(selectStorageTarget).toHaveBeenCalledWith("local", "session");
    expect(notify).toHaveBeenCalledWith("Session Hoarder storage target is now local.", "info");
  });

  it("selects an existing configured S3 target directly", async () => {
    const selectStorageTarget = vi.fn(async () => "s3:backup");
    const { command, notify } = setup({
      selectStorageTarget,
      getStatusSnapshot: () => configuredS3Status(),
    });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("storage s3", ctx);

    expect(selectStorageTarget).toHaveBeenCalledWith("s3", "session");
    expect(notify).toHaveBeenCalledWith("Session Hoarder storage target is now s3:backup.", "info");
  });

  it("reports local selection only after transition completion", async () => {
    const selection = deferred<string>();
    const selectStorageTarget = vi.fn(() => selection.promise);
    const { command, notify } = setup({ selectStorageTarget });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    const handling = command.handler("storage local", ctx);
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    selection.resolve("local");
    await handling;

    expect(notify).toHaveBeenCalledWith("Session Hoarder storage target is now local.", "info");
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
      "Eligible objects: 00002\nEligible encoded: 1.5 KiB\nEstimated disk  : 4.0 KiB\nSkipped objects : 00001\nAfter prune     : remote-only; no in-product restore command",
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
      getStatusSnapshot: () => configuredS3Status(),
      selectStorageTarget: async () => {
        throw new Error("configured target unavailable");
      },
    });
    const ctx = {
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext;

    await command.handler("storage s3", ctx);

    expect(notify).toHaveBeenCalledWith(
      "Session Hoarder storage selection failed: configured target unavailable",
      "error",
    );
  });

  it("gives headless setup instructions without prompting or preparing remote work", async () => {
    const prepareS3Setup = vi.fn();
    const { command, notify } = setup({
      prepareS3Setup,
      getStatusSnapshot: () => ({
        ...configuredS3Status(),
        config: { ...configuredS3Status().config, s3: undefined },
        globalConfigPath: "/custom/agent/session-hoarder.json",
      }),
    });
    await command.handler("storage s3", {
      hasUI: false,
      ui: { notify },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext);

    expect(prepareS3Setup).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Configure the global file at /custom/agent/session-hoarder.json"),
      "error",
    );
  });

  it("runs the interactive setup preview and verified-upload choice", async () => {
    const preview = {
      target: {
        targetId: "backup",
        bucket: "private-bucket",
        region: "us-east-1",
        prefix: "session-hoarder",
        forcePathStyle: false,
      },
      objectCount: 1,
      encodedBytes: 50,
      endpointDisplay: "AWS default",
      profileDisplay: "default credential chain",
    };
    const prepareS3Setup = vi.fn(async () => preview);
    const completeS3Setup = vi.fn(async () => ({ target: "s3:backup", verified: true }));
    const { command, notify } = setup({ prepareS3Setup, completeS3Setup });
    const inputs = ["private-bucket", "us-east-1"];
    const input = vi.fn(async () => inputs.shift());
    const select = vi
      .fn()
      .mockResolvedValueOnce("AWS S3")
      .mockResolvedValueOnce("Default AWS credential chain")
      .mockResolvedValueOnce("Use default target name and object prefix")
      .mockResolvedValueOnce("Upload current session objects, verify, and save");
    const confirm = vi.fn(async () => true);

    await command.handler("storage s3", {
      hasUI: true,
      ui: { notify, input, select, confirm },
      sessionManager: { getSessionId: () => "session" },
    } as unknown as ExtensionCommandContext);

    expect(prepareS3Setup).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "private-bucket" }),
      "session",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Upload test: 1 object(s), 50 B"),
      "info",
    );
    expect(confirm).toHaveBeenCalledWith(
      "Upload private Session Hoarder data?",
      expect.stringContaining("private Pi session and allowlisted sidecar bytes"),
    );
    expect(completeS3Setup).toHaveBeenCalledWith(preview, "upload-and-save", "session");
    expect(notify).toHaveBeenCalledWith("Session Hoarder verified and selected s3:backup.", "info");
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
