import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  CheckpointCoordinator,
  type CheckpointCoordinatorOptions,
} from "../application/checkpoint-coordinator.js";
import type {
  CheckpointApplicationService,
  CheckpointSessionResult,
} from "../application/checkpoint-service.js";
import type { ConfigLoadResult } from "../application/configuration.js";
import type { HoarderStatusSnapshot } from "../application/status.js";
import type { RepositoryIdentity } from "../domain/model.js";
import {
  ActiveSession,
  type ActiveSessionHost,
  type UiScheduler,
} from "./active-session.js";

export type { UiScheduler } from "./active-session.js";

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
  private readonly runtimes = new Map<string, ActiveSession>();
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
    return this.currentRuntime()?.snapshot() ?? {
      checkpoint: { state: "disabled", reason: "no active session" },
    };
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
    this.retireCurrentRuntime();
    const runtime = this.createRuntime(ctx);
    this.runtimes.set(runtime.key, runtime);
    this.currentKey = runtime.key;
    runtime.updateUi();
    await this.initializeRuntime(runtime);
  }

  private retireCurrentRuntime(): void {
    const runtime = this.currentRuntime();
    if (!runtime) return;
    runtime.coordinator?.dispose();
    runtime.stopUi();
    this.runtimes.delete(runtime.key);
    this.currentKey = undefined;
  }

  private createRuntime(ctx: ExtensionContext): ActiveSession {
    const generation = ++this.generation;
    let runtime!: ActiveSession;
    runtime = new ActiveSession(
      createActiveSessionHost(ctx),
      generation,
      this.dependencies.uiScheduler,
      () => this.isRuntimeCurrent(runtime),
    );
    return runtime;
  }

  private async initializeRuntime(runtime: ActiveSession): Promise<void> {
    try {
      const configResult = await this.dependencies.loadConfiguration({
        cwd: runtime.cwd,
        isProjectTrusted: runtime.isProjectTrusted,
      });
      runtime.config = configResult.config;
      if (!configResult.ok) {
        runtime.failConfiguration(configResult);
        runtime.updateUi();
        return;
      }
      if (!configResult.config.enabled) {
        runtime.checkpoint = { state: "disabled", reason: "disabled by configuration" };
        runtime.updateUi();
        return;
      }
      if (!runtime.sessionFile) {
        runtime.checkpoint = { state: "disabled", reason: "ephemeral Pi session" };
        runtime.updateUi();
        return;
      }

      const repository = await this.dependencies.resolveRepository(runtime.cwd);
      if (!this.isGenerationCurrent(runtime.generation)) return;
      this.activateRuntime(runtime, repository, configResult.config.storageRoot);
    } catch (error) {
      if (!this.isGenerationCurrent(runtime.generation)) return;
      runtime.failInitialization(error);
      runtime.updateUi();
    }
  }

  private activateRuntime(
    runtime: ActiveSession,
    repository: RepositoryIdentity,
    storageRoot: string,
  ): void {
    this.rekeyRuntime(runtime, repository);
    const checkpointService = this.dependencies.createCheckpointService(storageRoot);
    runtime.checkpoint = { state: "idle" };
    runtime.coordinator = this.createCoordinator(runtime, checkpointService);
    runtime.updateUi();
    void runtime.coordinator.flush("startup-recovery");
  }

  private rekeyRuntime(runtime: ActiveSession, repository: RepositoryIdentity): void {
    this.runtimes.delete(runtime.key);
    runtime.repository = repository;
    runtime.key = `${repository.repositoryId}:${runtime.sessionId}`;
    this.runtimes.set(runtime.key, runtime);
    this.currentKey = runtime.key;
  }

  private createCoordinator(
    runtime: ActiveSession,
    checkpointService: CheckpointApplicationService,
  ): CheckpointCoordinator {
    return this.dependencies.createCoordinator({
      debounceMs: runtime.config!.debounceMs,
      shutdownTimeoutMs: runtime.config!.shutdownTimeoutMs,
      isCurrent: () => this.isRuntimeCurrent(runtime),
      onStatus: (status) => {
        runtime.checkpoint = status;
        runtime.updateUi();
      },
      runner: {
        run: async (_reasons, signal) => {
          const result = await checkpointService.checkpoint(
            {
              repositoryId: runtime.repository.repositoryId,
              sessionId: runtime.sessionId,
              sessionFile: runtime.sessionFile!,
            },
            signal,
          );
          if (result && this.isRuntimeCurrent(runtime)) runtime.record = result.record;
          return result;
        },
      },
    });
  }

  private async stopSession(ctx: ExtensionContext): Promise<void> {
    const runtime = this.runtimeForContext(ctx);
    if (!runtime) return;
    await runtime.coordinator?.shutdown("shutdown");
    runtime.coordinator?.dispose();
    runtime.stopUi();
    this.runtimes.delete(runtime.key);
    if (this.currentKey !== runtime.key) return;
    this.currentKey = undefined;
    this.generation += 1;
    runtime.clearUi();
  }

  private withCurrent(ctx: ExtensionContext, action: (runtime: ActiveSession) => void): void {
    const runtime = this.runtimeForContext(ctx);
    if (runtime && this.isRuntimeCurrent(runtime)) action(runtime);
  }

  private runtimeForContext(ctx: ExtensionContext): ActiveSession | undefined {
    const current = this.currentRuntime();
    return current?.sessionId === ctx.sessionManager.getSessionId() ? current : undefined;
  }

  private currentRuntime(): ActiveSession | undefined {
    return this.currentKey ? this.runtimes.get(this.currentKey) : undefined;
  }

  private isGenerationCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  private isRuntimeCurrent(runtime: ActiveSession): boolean {
    return this.currentKey === runtime.key && this.generation === runtime.generation;
  }
}

function createActiveSessionHost(ctx: ExtensionContext): ActiveSessionHost {
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    isProjectTrusted: ctx.isProjectTrusted(),
    hasUi: ctx.hasUI,
    renderStatus: (status) => {
      ctx.ui.setStatus("session-hoarder", ctx.ui.theme.fg("dim", status));
    },
    clearStatus: () => ctx.ui.setStatus("session-hoarder", undefined),
  };
}
