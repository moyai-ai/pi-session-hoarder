import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  CheckpointCoordinator,
  type CheckpointCoordinatorOptions,
} from "../application/checkpoint-coordinator.js";
import type {
  CheckpointApplicationService,
  CheckpointSessionResult,
} from "../application/checkpoint-service.js";
import type {
  ConfigLoadResult,
  HoarderConfig,
} from "../application/configuration.js";
import type {
  CheckpointStatus,
  RepositoryIdentity,
  SessionArchiveRecord,
} from "../domain/model.js";
import { formatFooterStatus, type HoarderStatusSnapshot } from "../application/status.js";

interface SessionRuntime {
  key: string;
  generation: number;
  sessionId: string;
  repository: RepositoryIdentity;
  sessionFile?: string;
  config?: HoarderConfig;
  checkpoint: CheckpointStatus;
  record?: SessionArchiveRecord;
  initializationError?: string;
  coordinator?: CheckpointCoordinator;
  spinnerHandle?: unknown;
  spinnerFrame: number;
}

export interface UiScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 200;

export interface HoarderController {
  getStatusSnapshot(): HoarderStatusSnapshot;
  sync(expectedSessionId?: string): Promise<CheckpointSessionResult | undefined>;
}

export interface LifecycleDependencies {
  loadConfiguration(options: {
    cwd: string;
    isProjectTrusted: boolean;
  }): Promise<ConfigLoadResult>;
  resolveRepository(cwd: string): Promise<RepositoryIdentity>;
  createCheckpointService(storageRoot: string): CheckpointApplicationService;
  createCoordinator(options: CheckpointCoordinatorOptions): CheckpointCoordinator;
  uiScheduler: UiScheduler;
}

/** Pi lifecycle entrypoint. It translates Pi events into application use cases only. */
export class HoarderLifecycle implements HoarderController {
  private readonly dependencies: LifecycleDependencies;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private currentKey?: string;
  private generation = 0;

  constructor(dependencies: LifecycleDependencies) {
    this.dependencies = dependencies;
  }

  register(pi: ExtensionAPI): void {
    pi.on("session_start", async (_event, ctx) => this.startSession(ctx));
    pi.on("message_end", (_event, ctx) => {
      this.withCurrent(ctx, (runtime) => runtime.coordinator?.markDirty("message"));
    });
    pi.on("agent_settled", (_event, ctx) => {
      this.withCurrent(ctx, (runtime) => void runtime.coordinator?.flush("agent-settled"));
    });
    pi.on("session_info_changed", (_event, ctx) => {
      this.withCurrent(ctx, (runtime) => runtime.coordinator?.markDirty("metadata"));
    });
    pi.on("session_compact", (_event, ctx) => {
      this.withCurrent(ctx, (runtime) => void runtime.coordinator?.flush("compaction"));
    });
    pi.on("session_tree", (_event, ctx) => {
      this.withCurrent(ctx, (runtime) => void runtime.coordinator?.flush("tree"));
    });
    pi.on("session_shutdown", async (_event, ctx) => this.stopSession(ctx));
  }

  getStatusSnapshot(): HoarderStatusSnapshot {
    const runtime = this.currentRuntime();
    if (!runtime) return { checkpoint: { state: "disabled", reason: "no active session" } };
    return structuredClone({
      sessionId: runtime.sessionId,
      repositoryId: runtime.repository.repositoryId,
      config: runtime.config,
      checkpoint: runtime.checkpoint,
      record: runtime.record,
      initializationError: runtime.initializationError,
    });
  }

  async sync(expectedSessionId?: string): Promise<CheckpointSessionResult | undefined> {
    const runtime = this.currentRuntime();
    if (!runtime) throw new Error("No active Session Hoarder runtime.");
    if (expectedSessionId && runtime.sessionId !== expectedSessionId) {
      throw new Error("The active Pi session changed before sync could start.");
    }
    if (!runtime.coordinator) {
      throw new Error(runtime.initializationError ?? "Session Hoarder is disabled.");
    }
    return runtime.coordinator.flush("manual");
  }

  private async startSession(ctx: ExtensionContext): Promise<void> {
    const previousRuntime = this.currentRuntime();
    if (previousRuntime) this.stopSpinner(previousRuntime);
    const generation = ++this.generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const runtime: SessionRuntime = {
      key: `initializing:${sessionId}:${generation}`,
      generation,
      sessionId,
      repository: { kind: "cwd", canonicalValue: ctx.cwd, repositoryId: "initializing" },
      sessionFile: ctx.sessionManager.getSessionFile(),
      checkpoint: { state: "pending", dirtyReasons: ["initializing"] },
      spinnerFrame: 0,
    };
    this.runtimes.set(runtime.key, runtime);
    this.currentKey = runtime.key;
    this.updateUi(runtime, ctx);

    try {
      const configResult = await this.dependencies.loadConfiguration({
        cwd: ctx.cwd,
        isProjectTrusted: ctx.isProjectTrusted(),
      });
      runtime.config = configResult.config;
      if (!configResult.ok) {
        this.disableForConfigError(runtime, configResult);
        this.updateUi(runtime, ctx);
        return;
      }
      if (!configResult.config.enabled) {
        runtime.checkpoint = { state: "disabled", reason: "disabled by configuration" };
        this.updateUi(runtime, ctx);
        return;
      }
      if (!runtime.sessionFile) {
        runtime.checkpoint = { state: "disabled", reason: "ephemeral Pi session" };
        this.updateUi(runtime, ctx);
        return;
      }

      const repository = await this.dependencies.resolveRepository(ctx.cwd);
      if (!this.isGenerationCurrent(generation)) return;
      runtime.repository = repository;
      const key = `${repository.repositoryId}:${sessionId}`;
      this.runtimes.delete(runtime.key);
      runtime.key = key;
      this.runtimes.set(key, runtime);
      this.currentKey = key;

      const checkpointService = this.dependencies.createCheckpointService(
        configResult.config.storageRoot,
      );
      runtime.checkpoint = { state: "idle" };
      runtime.coordinator = this.dependencies.createCoordinator({
        debounceMs: configResult.config.debounceMs,
        shutdownTimeoutMs: configResult.config.shutdownTimeoutMs,
        isCurrent: () => this.isRuntimeCurrent(runtime),
        onStatus: (status) => {
          runtime.checkpoint = status;
          this.updateUi(runtime, ctx);
        },
        runner: {
          run: async (_reasons, signal) => {
            const result = await checkpointService.checkpoint(
              {
                repositoryId: repository.repositoryId,
                sessionId,
                sessionFile: runtime.sessionFile!,
              },
              signal,
            );
            if (result && this.isRuntimeCurrent(runtime)) runtime.record = result.record;
            return result;
          },
        },
      });
      this.updateUi(runtime, ctx);
      void runtime.coordinator.flush("startup-recovery");
    } catch (error) {
      if (!this.isGenerationCurrent(generation)) return;
      runtime.initializationError = errorMessage(error);
      runtime.checkpoint = {
        state: "error",
        error: {
          code: "INITIALIZATION_FAILED",
          message: runtime.initializationError,
          occurredAt: new Date().toISOString(),
          retryable: true,
        },
      };
      this.updateUi(runtime, ctx);
    }
  }

  private async stopSession(ctx: ExtensionContext): Promise<void> {
    const runtime = this.runtimeForContext(ctx);
    if (!runtime) return;
    await runtime.coordinator?.shutdown("shutdown");
    runtime.coordinator?.dispose();
    this.stopSpinner(runtime);
    this.runtimes.delete(runtime.key);
    if (this.currentKey === runtime.key) {
      this.currentKey = undefined;
      this.generation += 1;
      if (ctx.hasUI) ctx.ui.setStatus("session-hoarder", undefined);
    }
  }

  private disableForConfigError(
    runtime: SessionRuntime,
    result: Extract<ConfigLoadResult, { ok: false }>,
  ): void {
    runtime.initializationError = result.error.message;
    runtime.checkpoint = {
      state: "error",
      error: {
        code: `CONFIG_${result.error.kind.toUpperCase()}`,
        message: result.error.message,
        occurredAt: new Date().toISOString(),
        retryable: true,
      },
    };
  }

  private withCurrent(ctx: ExtensionContext, action: (runtime: SessionRuntime) => void): void {
    const runtime = this.runtimeForContext(ctx);
    if (runtime && this.isRuntimeCurrent(runtime)) action(runtime);
  }

  private runtimeForContext(ctx: ExtensionContext): SessionRuntime | undefined {
    const current = this.currentRuntime();
    return current?.sessionId === ctx.sessionManager.getSessionId() ? current : undefined;
  }

  private currentRuntime(): SessionRuntime | undefined {
    return this.currentKey ? this.runtimes.get(this.currentKey) : undefined;
  }

  private isGenerationCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  private isRuntimeCurrent(runtime: SessionRuntime): boolean {
    return this.currentKey === runtime.key && this.generation === runtime.generation;
  }

  private updateUi(runtime: SessionRuntime, ctx: ExtensionContext): void {
    if (!ctx.hasUI || !this.isRuntimeCurrent(runtime)) {
      this.stopSpinner(runtime);
      return;
    }
    if (runtime.checkpoint.state === "running") {
      this.startSpinner(runtime, ctx);
    } else {
      this.stopSpinner(runtime);
    }
    this.renderStatus(runtime, ctx);
  }

  private startSpinner(runtime: SessionRuntime, ctx: ExtensionContext): void {
    if (runtime.spinnerHandle !== undefined) return;
    runtime.spinnerFrame = 0;
    runtime.spinnerHandle = this.dependencies.uiScheduler.setInterval(() => {
      if (!this.isRuntimeCurrent(runtime) || runtime.checkpoint.state !== "running") {
        this.stopSpinner(runtime);
        return;
      }
      runtime.spinnerFrame = (runtime.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.renderStatus(runtime, ctx);
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(runtime: SessionRuntime): void {
    if (runtime.spinnerHandle === undefined) return;
    this.dependencies.uiScheduler.clearInterval(runtime.spinnerHandle);
    runtime.spinnerHandle = undefined;
    runtime.spinnerFrame = 0;
  }

  private renderStatus(runtime: SessionRuntime, ctx: ExtensionContext): void {
    const frame = SPINNER_FRAMES[runtime.spinnerFrame] ?? SPINNER_FRAMES[0];
    const status = formatFooterStatus(this.getStatusSnapshot(), frame);
    ctx.ui.setStatus("session-hoarder", ctx.ui.theme.fg("dim", status));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
