import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigLoadResult } from "../../src/application/configuration.js";
import { CheckpointCoordinator } from "../../src/application/checkpoint-coordinator.js";
import type { CheckpointApplicationService } from "../../src/application/checkpoint-service.js";
import { ReplicationCoordinator } from "../../src/application/replication-coordinator.js";
import { SerializedMaintenanceExclusion } from "../../src/application/maintenance-exclusion.js";
import type { ReplicationApplicationService } from "../../src/application/replication-service.js";
import { createLocalCheckpointApplication } from "../../src/bootstrap.js";
import {
  HoarderLifecycle,
  type LifecycleDependencies,
  type UiScheduler,
} from "../../src/entrypoints/lifecycle.js";

const temporaryDirectories: string[] = [];
type Handler = (...args: never[]) => unknown;

class ManualUiScheduler implements UiScheduler {
  private nextId = 0;
  private readonly callbacks = new Map<number, () => void>();

  setInterval(callback: () => void, _intervalMs: number): unknown {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  tick(): void {
    for (const callback of this.callbacks.values()) callback();
  }

  get activeCount(): number {
    return this.callbacks.size;
  }
}

function fakePi() {
  const handlers = new Map<string, Handler>();
  const api = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
  };
  return { handlers, api: api as unknown as ExtensionAPI };
}

function fakeContext(
  sessionId: string,
  sessionFile: string | undefined,
  cwd: string,
  hasUI = true,
  isProjectTrusted = true,
) {
  const setStatus = vi.fn();
  const fg = vi.fn((_color: string, text: string) => text);
  const context = {
    cwd,
    hasUI,
    isProjectTrusted: () => isProjectTrusted,
    ui: { setStatus, notify: vi.fn(), theme: { fg } },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext;
  return { context, setStatus, fg };
}

async function fixture(
  enabled = true,
  storageTarget: "local" | "s3" = "local",
  configureS3 = storageTarget === "s3",
) {
  const directory = await mkdtemp(join(tmpdir(), "session-hoarder-lifecycle-"));
  temporaryDirectories.push(directory);
  const storageRoot = join(directory, "store");
  const config: ConfigLoadResult = {
    ok: true,
    config: {
      enabled,
      debounceMs: 0,
      shutdownTimeoutMs: 100,
      storageRoot,
      storageTarget,
      ...(configureS3
        ? {
            s3: {
              targetId: "backup",
              bucket: "bucket",
              region: "us-east-1",
              prefix: "session-hoarder",
              forcePathStyle: false,
            },
          }
        : {}),
      gitCatalogEnabled: false,
    },
    paths: { global: join(directory, "global.json"), project: join(directory, "project.json") },
    loadedFrom: [],
  };
  const uiScheduler = new ManualUiScheduler();
  const dependencies: LifecycleDependencies = {
    loadConfiguration: async () => config,
    resolveRepository: async () => ({
      kind: "git-remote",
      canonicalValue: "github.com/example/repo",
      repositoryId: "repo-id",
    }),
    createCheckpointService: (root) => createLocalCheckpointApplication(root).service,
    createCoordinator: (options) => new CheckpointCoordinator(options),
    createReplicationService: vi.fn(
      () =>
        ({
          sync: vi.fn(async () => undefined),
        }) as unknown as ReplicationApplicationService,
    ),
    createReplicationCoordinator: (options) => new ReplicationCoordinator(options),
    createProjectCatalogService: vi.fn(
      () =>
        ({
          publish: vi.fn(async () => ({
            revision: 1,
            path: join(directory, ".pi/session-hoarder/catalog/session.json"),
          })),
        }) as never,
    ),
    gitWorktree: {
      inspect: vi.fn(async () => ({
        worktreeRoot: directory,
        head: "a".repeat(40),
        branch: "main",
        detached: false,
        dirty: false,
      })),
    },
    createMaintenanceExclusion: () => new SerializedMaintenanceExclusion(),
    createPruneService: vi.fn(() => ({ prune: vi.fn() }) as never),
    configurationWriter: {
      selectStorageTarget: vi.fn(async () => undefined),
      enableGitCatalog: vi.fn(async () => undefined),
    },
    uiScheduler,
  };
  return { directory, storageRoot, config, dependencies, uiScheduler };
}

async function invoke(
  handler: Handler | undefined,
  event: unknown,
  ctx: ExtensionContext,
): Promise<void> {
  if (!handler) throw new Error("handler was not registered");
  await handler(event as never, ctx as never);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

describe("HoarderLifecycle", () => {
  it("recovers on startup, checkpoints dirty messages, and flushes on shutdown", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session-1" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context, setStatus } = fakeContext("session-1", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    const startup = await lifecycle.sync("session-1");
    expect(startup.checkpoint?.record.revision).toBe(1);
    expect(lifecycle.getStatusSnapshot()).toMatchObject({
      sessionId: "session-1",
      record: { revision: 1 },
      checkpoint: { state: "idle" },
    });

    await appendFile(
      sessionFile,
      `${JSON.stringify({ type: "message", id: "next", message: { role: "user", content: "hello" } })}\n`,
    );
    await invoke(handlers.get("message_end"), { message: {} }, context);
    const second = await lifecycle.sync("session-1");
    expect(second.checkpoint?.record.revision).toBe(2);

    await invoke(handlers.get("session_shutdown"), { reason: "quit" }, context);
    expect(lifecycle.getStatusSnapshot().checkpoint).toEqual({
      state: "disabled",
      reason: "no active session",
    });
    expect(setStatus).toHaveBeenCalledWith("session-hoarder", undefined);
  });

  it("animates only while a checkpoint is running and stops after completion", async () => {
    const { directory, dependencies, uiScheduler } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    let finishCheckpoint!: () => void;
    const checkpoint = new Promise<undefined>((resolve) => {
      finishCheckpoint = () => resolve(undefined);
    });
    dependencies.createCheckpointService = () =>
      ({
        checkpoint: vi.fn(() => checkpoint),
      }) as unknown as CheckpointApplicationService;
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context, setStatus } = fakeContext("session", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);

    expect(uiScheduler.activeCount).toBe(1);
    expect(setStatus).toHaveBeenLastCalledWith("session-hoarder", "⠋hoard");
    uiScheduler.tick();
    expect(setStatus).toHaveBeenLastCalledWith("session-hoarder", "⠙hoard");

    finishCheckpoint();
    await lifecycle.sync("session");

    expect(uiScheduler.activeCount).toBe(0);
    expect(setStatus).toHaveBeenLastCalledWith("session-hoarder", "◇hoard");
  });

  it("disposes a displaced runtime and stops its running spinner", async () => {
    const { directory, dependencies, uiScheduler } = await fixture();
    const dispose = vi.spyOn(CheckpointCoordinator.prototype, "dispose");
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "first" })}\n`,
    );
    dependencies.createCheckpointService = () =>
      ({
        checkpoint: vi.fn(() => new Promise<undefined>(() => undefined)),
      }) as unknown as CheckpointApplicationService;
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const first = fakeContext("first", sessionFile, directory);
    const replacement = fakeContext("second", undefined, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, first.context);
    expect(uiScheduler.activeCount).toBe(1);
    const oldStatusCalls = first.setStatus.mock.calls.length;

    await invoke(handlers.get("session_start"), { reason: "resume" }, replacement.context);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(uiScheduler.activeCount).toBe(0);
    uiScheduler.tick();

    expect(first.setStatus).toHaveBeenCalledTimes(oldStatusCalls);
  });

  it("flushes immediately when the agent has fully settled", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const flush = vi.fn(async () => undefined);
    const coordinator = {
      markDirty: vi.fn(),
      flush,
      shutdown: vi.fn(async () => undefined),
      dispose: vi.fn(),
    } as unknown as CheckpointCoordinator;
    dependencies.createCoordinator = () => coordinator;
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    flush.mockClear();

    await invoke(handlers.get("agent_settled"), {}, context);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("agent-settled");
  });

  it("flushes immediately for compaction and tree navigation", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    await lifecycle.sync("session");

    await appendFile(sessionFile, `${JSON.stringify({ type: "compaction", id: "compact" })}\n`);
    await invoke(handlers.get("session_compact"), { reason: "manual" }, context);
    expect((await lifecycle.sync("session")).checkpoint?.record.revision).toBe(2);

    await appendFile(sessionFile, `${JSON.stringify({ type: "branch_summary", id: "tree" })}\n`);
    await invoke(handlers.get("session_tree"), { newLeafId: "tree" }, context);
    expect((await lifecycle.sync("session")).checkpoint?.record.revision).toBe(3);
  });

  it("keeps replacement sessions isolated from stale contexts", async () => {
    const { directory, dependencies } = await fixture();
    const firstFile = join(directory, "first.jsonl");
    const secondFile = join(directory, "second.jsonl");
    await writeFile(firstFile, `${JSON.stringify({ type: "session", version: 3, id: "first" })}\n`);
    await writeFile(
      secondFile,
      `${JSON.stringify({ type: "session", version: 3, id: "second" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const first = fakeContext("first", firstFile, directory);
    const second = fakeContext("second", secondFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, first.context);
    await invoke(handlers.get("session_start"), { reason: "resume" }, second.context);
    await invoke(handlers.get("message_end"), { message: {} }, first.context);
    await lifecycle.sync("second");

    expect(lifecycle.getStatusSnapshot().sessionId).toBe("second");
    await expect(lifecycle.sync("first")).rejects.toThrow("active Pi session changed");
  });

  it("supports headless ephemeral sessions without UI calls or storage work", async () => {
    const { directory, dependencies, uiScheduler } = await fixture();
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context, setStatus } = fakeContext("ephemeral", undefined, directory, false);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);

    expect(lifecycle.getStatusSnapshot().checkpoint).toEqual({
      state: "disabled",
      reason: "ephemeral Pi session",
    });
    expect(setStatus).not.toHaveBeenCalled();
    expect(uiScheduler.activeCount).toBe(0);
  });

  it("surfaces disabled configuration without creating a coordinator", async () => {
    const { directory, dependencies } = await fixture(false);
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(sessionFile, "");
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);

    expect(lifecycle.getStatusSnapshot().checkpoint).toEqual({
      state: "disabled",
      reason: "disabled by configuration",
    });
    await expect(lifecycle.sync("session")).rejects.toThrow("disabled");
  });

  it("switches to local storage by updating configuration only", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, context);

    const selected = await lifecycle.selectStorageTarget("local", "session");

    expect(selected).toBe("local");
    expect(dependencies.configurationWriter.selectStorageTarget).toHaveBeenCalledWith("local");
    expect(lifecycle.getStatusSnapshot().config?.storageTarget).toBe("local");
  });

  it("constructs remote behavior only when switching to a configured S3 target", async () => {
    const { directory, dependencies } = await fixture(true, "local", true);
    const remoteSync = vi.fn(async () => undefined);
    dependencies.createReplicationService = vi.fn(
      () =>
        ({
          sync: remoteSync,
        }) as unknown as ReplicationApplicationService,
    );
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    await lifecycle.sync("session");
    expect(dependencies.createReplicationService).not.toHaveBeenCalled();

    await lifecycle.selectStorageTarget("s3", "session");
    await lifecycle.sync("session");

    expect(dependencies.createReplicationService).toHaveBeenCalledTimes(1);
    expect(remoteSync).toHaveBeenCalled();
    await lifecycle.selectStorageTarget("local", "session");
    expect(lifecycle.getStatusSnapshot().remoteState).toBe("off");
  });

  it("refuses to select S3 before a global target is configured", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, context);

    await expect(lifecycle.selectStorageTarget("s3", "session")).rejects.toThrow(
      "No S3 target is configured",
    );
    expect(dependencies.configurationWriter.selectStorageTarget).not.toHaveBeenCalled();
  });

  it("enables Git catalogs only for a trusted project", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const untrusted = fakeContext("session", sessionFile, directory, true, false);
    await invoke(handlers.get("session_start"), { reason: "startup" }, untrusted.context);

    await expect(lifecycle.enableGitCatalog("session")).rejects.toThrow("trusted project");
    expect(dependencies.configurationWriter.enableGitCatalog).not.toHaveBeenCalled();
  });

  it("refuses Git catalog enablement outside a worktree", async () => {
    const { directory, dependencies } = await fixture();
    dependencies.gitWorktree.inspect = vi.fn(async () => undefined);
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const trusted = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, trusted.context);

    await expect(lifecycle.enableGitCatalog("session")).rejects.toThrow("Git worktree");
    expect(dependencies.configurationWriter.enableGitCatalog).not.toHaveBeenCalled();
  });

  it("persists Git catalog enablement for a trusted project", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const trusted = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, trusted.context);

    await lifecycle.enableGitCatalog("session");

    expect(dependencies.configurationWriter.enableGitCatalog).toHaveBeenCalledWith(directory);
    expect(lifecycle.getStatusSnapshot().config?.gitCatalogEnabled).toBe(true);
  });

  it("publishes enabled local project catalogs only after a verified checkpoint", async () => {
    const { directory, config, dependencies } = await fixture();
    config.config.gitCatalogEnabled = true;
    const publish = vi.fn(async ({ archive }) => ({
      revision: archive.revision,
      path: join(directory, ".pi/session-hoarder/catalog/session.json"),
    }));
    dependencies.createProjectCatalogService = vi.fn(() => ({ publish }) as never);
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    const result = await lifecycle.sync("session");

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        trusted: true,
        storageTarget: "local",
        archive: expect.objectContaining({ revision: 1 }),
      }),
    );
    expect(result.projection).toMatchObject({ revision: 1 });
  });

  it("does not construct project catalog behavior while disabled", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    await lifecycle.sync("session");
    expect(dependencies.createProjectCatalogService).not.toHaveBeenCalled();
  });

  it("publishes S3 project catalogs only after matching replication succeeds", async () => {
    const { directory, config, dependencies } = await fixture(true, "s3");
    config.config.gitCatalogEnabled = true;
    const replicated = {
      changed: true,
      record: {
        schemaVersion: 1 as const,
        targetId: "backup",
        repositoryId: "repo-id",
        sessionId: "session",
        revision: 1,
        objects: [],
        verifiedAt: "2026-08-06T12:00:00.000Z",
      },
    };
    dependencies.createReplicationService = vi.fn(
      () =>
        ({
          sync: vi.fn(async () => replicated),
        }) as unknown as ReplicationApplicationService,
    );
    const publish = vi.fn(async ({ archive }) => ({
      revision: archive.revision,
      path: "catalog.json",
    }));
    dependencies.createProjectCatalogService = vi.fn(() => ({ publish }) as never);
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    await lifecycle.sync("session");

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ storageTarget: "s3" }));
  });

  it("constructs no remote service and performs zero remote work in local mode", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    await lifecycle.sync("session");

    expect(dependencies.createReplicationService).not.toHaveBeenCalled();
  });

  it("refuses prune in local mode without constructing prune behavior", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, context);

    await expect(lifecycle.prune(undefined, "session")).rejects.toThrow("only while S3");
    expect(dependencies.createPruneService).not.toHaveBeenCalled();
  });

  it("runs prune only for the selected S3 target", async () => {
    const { directory, storageRoot, dependencies } = await fixture(true, "s3");
    const result = {
      localObjects: 1,
      eligibleObjects: 1,
      skippedObjects: 0,
      eligibleEncodedBytes: 10,
      eligibleAllocatedBytes: 512,
      invalidReceiptRecords: 0,
      confirmed: true,
      removedObjects: 1,
      recoveredBytes: 512,
      failedObjects: 0,
      interrupted: false,
    };
    const prune = vi.fn(async () => result);
    dependencies.createPruneService = vi.fn(() => ({ prune }) as never);
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    const confirmation = { confirm: vi.fn(async () => true) };

    await expect(lifecycle.prune(confirmation, "session")).resolves.toEqual(result);
    expect(dependencies.createPruneService).toHaveBeenCalledWith(
      storageRoot,
      expect.objectContaining({ targetId: "backup" }),
      expect.any(SerializedMaintenanceExclusion),
    );
    expect(prune).toHaveBeenCalledWith("backup", confirmation);
  });

  it("keeps local checkpoint success authoritative when S3 replication fails", async () => {
    const { directory, dependencies } = await fixture(true, "s3");
    const remoteSync = vi.fn(async () => {
      throw new Error("remote unavailable");
    });
    dependencies.createReplicationService = vi.fn(
      () =>
        ({
          sync: remoteSync,
        }) as unknown as ReplicationApplicationService,
    );
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    const result = await lifecycle.sync("session");

    expect(result.checkpoint?.record.revision).toBe(1);
    expect(result.replicationError).toBe("remote unavailable");
    expect(lifecycle.getStatusSnapshot()).toMatchObject({
      record: { revision: 1 },
      checkpoint: { state: "idle" },
      remoteState: "retry pending",
    });
    expect(remoteSync).toHaveBeenCalled();
  });

  it("retries an unpublished unchanged local revision after restart", async () => {
    const { directory, config, dependencies } = await fixture(true, "local", true);
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const firstLifecycle = new HoarderLifecycle(dependencies);
    const firstPi = fakePi();
    firstLifecycle.register(firstPi.api);
    const first = fakeContext("session", sessionFile, directory);
    await invoke(firstPi.handlers.get("session_start"), { reason: "startup" }, first.context);
    expect((await firstLifecycle.sync("session")).checkpoint?.record.revision).toBe(1);
    await invoke(firstPi.handlers.get("session_shutdown"), { reason: "reload" }, first.context);

    config.config.storageTarget = "s3";
    const remoteSync = vi.fn(async () => undefined);
    dependencies.createReplicationService = vi.fn(
      () =>
        ({
          sync: remoteSync,
        }) as unknown as ReplicationApplicationService,
    );
    const secondLifecycle = new HoarderLifecycle(dependencies);
    const secondPi = fakePi();
    secondLifecycle.register(secondPi.api);
    const second = fakeContext("session", sessionFile, directory);

    await invoke(secondPi.handlers.get("session_start"), { reason: "reload" }, second.context);
    const result = await secondLifecycle.sync("session");

    expect(result.checkpoint).toMatchObject({ changed: false, record: { revision: 1 } });
    expect(remoteSync).toHaveBeenCalled();
  });

  it("publishes the latest local revision on manual S3 sync", async () => {
    const { directory, dependencies } = await fixture(true, "s3");
    const remoteSync = vi.fn(async () => ({
      changed: true,
      record: {
        schemaVersion: 1 as const,
        targetId: "backup",
        repositoryId: "repo-id",
        sessionId: "session",
        revision: 1,
        objects: [
          {
            object: {
              algorithm: "sha256" as const,
              digest: "a".repeat(64),
              encoding: "gzip" as const,
              logicalBytes: 1,
              storedBytes: 1,
            },
            key: "session-hoarder/objects/sha256/object.gz",
          },
        ],
        verifiedAt: "2026-08-05T12:00:00.000Z",
      },
    }));
    dependencies.createReplicationService = vi.fn(
      () =>
        ({
          sync: remoteSync,
        }) as unknown as ReplicationApplicationService,
    );
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    const result = await lifecycle.sync("session");

    expect(result.replication?.record.revision).toBe(1);
    expect(lifecycle.getStatusSnapshot()).toMatchObject({
      publishedRevision: 1,
      remoteState: "synchronized",
    });
  });

  it("surfaces malformed configuration as an error rather than off", async () => {
    const { directory, dependencies } = await fixture();
    dependencies.loadConfiguration = async () => ({
      ok: false,
      config: {
        enabled: false,
        debounceMs: 30_000,
        shutdownTimeoutMs: 3_000,
        storageRoot: join(directory, "store"),
        storageTarget: "local",
        gitCatalogEnabled: false,
      },
      paths: { global: "global", project: "project" },
      loadedFrom: [],
      error: { kind: "validation", path: "global", message: "bad config" },
    });
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(sessionFile, "");
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context, setStatus, fg } = fakeContext("session", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);

    expect(lifecycle.getStatusSnapshot()).toMatchObject({
      initializationError: "bad config",
      checkpoint: { state: "error" },
    });
    expect(fg).toHaveBeenLastCalledWith("dim", "!hoard");
    expect(setStatus).toHaveBeenLastCalledWith("session-hoarder", "!hoard");
  });
});
