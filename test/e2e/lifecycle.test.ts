import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigLoadResult } from "../../src/application/configuration.js";
import { CheckpointCoordinator } from "../../src/application/checkpoint-coordinator.js";
import type { CheckpointApplicationService } from "../../src/application/checkpoint-service.js";
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
    for (const callback of [...this.callbacks.values()]) callback();
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

function fakeContext(sessionId: string, sessionFile: string | undefined, cwd: string, hasUI = true) {
  const setStatus = vi.fn();
  const fg = vi.fn((_color: string, text: string) => text);
  const context = {
    cwd,
    hasUI,
    isProjectTrusted: () => true,
    ui: { setStatus, notify: vi.fn(), theme: { fg } },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext;
  return { context, setStatus, fg };
}

async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "session-hoarder-lifecycle-"));
  temporaryDirectories.push(directory);
  const storageRoot = join(directory, "store");
  const config: ConfigLoadResult = {
    ok: true,
    config: { enabled, debounceMs: 0, shutdownTimeoutMs: 100, storageRoot },
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
    uiScheduler,
  };
  return { directory, storageRoot, dependencies, uiScheduler };
}

async function invoke(handler: Handler | undefined, event: unknown, ctx: ExtensionContext): Promise<void> {
  if (!handler) throw new Error("handler was not registered");
  await handler(event as never, ctx as never);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HoarderLifecycle", () => {
  it("recovers on startup, checkpoints dirty messages, and flushes on shutdown", async () => {
    const { directory, dependencies } = await fixture();
    const sessionFile = join(directory, "session.jsonl");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session-1" })}\n`);
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context, setStatus } = fakeContext("session-1", sessionFile, directory);

    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    const startup = await lifecycle.sync("session-1");
    expect(startup?.record.revision).toBe(1);
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
    expect(second?.record.revision).toBe(2);

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
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`);
    let finishCheckpoint!: () => void;
    const checkpoint = new Promise<undefined>((resolve) => {
      finishCheckpoint = () => resolve(undefined);
    });
    dependencies.createCheckpointService = () => ({
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
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "first" })}\n`);
    dependencies.createCheckpointService = () => ({
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
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`);
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
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`);
    const lifecycle = new HoarderLifecycle(dependencies);
    const { handlers, api } = fakePi();
    lifecycle.register(api);
    const { context } = fakeContext("session", sessionFile, directory);
    await invoke(handlers.get("session_start"), { reason: "startup" }, context);
    await lifecycle.sync("session");

    await appendFile(sessionFile, `${JSON.stringify({ type: "compaction", id: "compact" })}\n`);
    await invoke(handlers.get("session_compact"), { reason: "manual" }, context);
    expect((await lifecycle.sync("session"))?.record.revision).toBe(2);

    await appendFile(sessionFile, `${JSON.stringify({ type: "branch_summary", id: "tree" })}\n`);
    await invoke(handlers.get("session_tree"), { newLeafId: "tree" }, context);
    expect((await lifecycle.sync("session"))?.record.revision).toBe(3);
  });

  it("keeps replacement sessions isolated from stale contexts", async () => {
    const { directory, dependencies } = await fixture();
    const firstFile = join(directory, "first.jsonl");
    const secondFile = join(directory, "second.jsonl");
    await writeFile(firstFile, `${JSON.stringify({ type: "session", version: 3, id: "first" })}\n`);
    await writeFile(secondFile, `${JSON.stringify({ type: "session", version: 3, id: "second" })}\n`);
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

  it("surfaces malformed configuration as an error rather than off", async () => {
    const { directory, dependencies } = await fixture();
    dependencies.loadConfiguration = async () => ({
      ok: false,
      config: {
        enabled: false,
        debounceMs: 30_000,
        shutdownTimeoutMs: 3_000,
        storageRoot: join(directory, "store"),
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
