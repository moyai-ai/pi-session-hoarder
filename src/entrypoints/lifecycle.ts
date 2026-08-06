import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { StorageTarget } from "../application/configuration.js";
import type { PruneConfirmation } from "../application/prune-ports.js";
import type { PruneResult } from "../application/prune-service.js";
import type {
  S3SetupChoice,
  S3SetupDraft,
  S3SetupInitial,
  S3SetupPreview,
} from "../application/s3-setup.js";
import type { HoarderStatusSnapshot } from "../application/status.js";
import type { ActiveSessionHost } from "./active-session.js";
import {
  HoarderSessionRuntime,
  type CompleteS3SetupResult,
  type SessionRuntimeDependencies,
} from "./session-runtime.js";

export type { UiScheduler } from "./active-session.js";
export type { CompleteS3SetupResult, SessionRuntimeDependencies } from "./session-runtime.js";
export type LifecycleDependencies = SessionRuntimeDependencies;

export interface HoarderSyncResult {
  checkpoint: Awaited<ReturnType<HoarderSessionRuntime["sync"]>>["checkpoint"];
  replication?: Awaited<ReturnType<HoarderSessionRuntime["sync"]>>["replication"];
  replicationError?: string;
  projection?: Awaited<ReturnType<HoarderSessionRuntime["sync"]>>["projection"];
  projectionError?: string;
}

export interface HoarderController {
  getStatusSnapshot(): HoarderStatusSnapshot;
  sync(expectedSessionId?: string): Promise<HoarderSyncResult>;
  selectStorageTarget(target: StorageTarget, expectedSessionId?: string): Promise<string>;
  getS3SetupInitial(expectedSessionId?: string): S3SetupInitial;
  prepareS3Setup(draft: S3SetupDraft, expectedSessionId?: string): Promise<S3SetupPreview>;
  completeS3Setup(
    preview: S3SetupPreview,
    choice: Exclude<S3SetupChoice, "cancel">,
    expectedSessionId?: string,
  ): Promise<CompleteS3SetupResult>;
  enableGitCatalog(expectedSessionId?: string): Promise<void>;
  prune(confirmation?: PruneConfirmation, expectedSessionId?: string): Promise<PruneResult>;
}

/** Pi event adapter. Per-generation workflows are delegated to HoarderSessionRuntime. */
export class HoarderLifecycle implements HoarderController {
  private current?: HoarderSessionRuntime;
  private generation = 0;

  constructor(private readonly dependencies: LifecycleDependencies) {}

  register(pi: ExtensionAPI): void {
    pi.on("session_start", async (_event, ctx) => this.startSession(ctx));
    pi.on("message_end", (_event, ctx) =>
      this.withCurrent(ctx, (runtime) => runtime.markDirty("message")),
    );
    pi.on("agent_settled", (_event, ctx) =>
      this.withCurrent(ctx, (runtime) => void runtime.flush("agent-settled")),
    );
    pi.on("session_info_changed", (_event, ctx) =>
      this.withCurrent(ctx, (runtime) => runtime.markDirty("metadata")),
    );
    pi.on("session_compact", (_event, ctx) =>
      this.withCurrent(ctx, (runtime) => void runtime.flush("compaction")),
    );
    pi.on("session_tree", (_event, ctx) =>
      this.withCurrent(ctx, (runtime) => void runtime.flush("tree")),
    );
    pi.on("session_shutdown", async (_event, ctx) => this.stopSession(ctx));
  }

  getStatusSnapshot(): HoarderStatusSnapshot {
    return (
      this.current?.snapshot() ?? {
        checkpoint: { state: "disabled", reason: "no active session" },
      }
    );
  }

  async sync(expectedSessionId?: string): Promise<HoarderSyncResult> {
    const result = await this.requireCurrent(expectedSessionId, "sync").sync();
    return {
      checkpoint: result.checkpoint,
      ...(result.replication ? { replication: result.replication } : {}),
      ...(result.replicationError ? { replicationError: result.replicationError.message } : {}),
      ...(result.projection ? { projection: result.projection } : {}),
      ...(result.projectionError ? { projectionError: result.projectionError.message } : {}),
    };
  }

  selectStorageTarget(target: StorageTarget, expectedSessionId?: string): Promise<string> {
    return this.requireCurrent(expectedSessionId, "storage selection").selectStorageTarget(target);
  }

  getS3SetupInitial(expectedSessionId?: string): S3SetupInitial {
    return this.requireCurrent(expectedSessionId, "S3 setup").getS3SetupInitial();
  }

  prepareS3Setup(draft: S3SetupDraft, expectedSessionId?: string): Promise<S3SetupPreview> {
    return this.requireCurrent(expectedSessionId, "S3 setup").prepareS3Setup(draft);
  }

  completeS3Setup(
    preview: S3SetupPreview,
    choice: Exclude<S3SetupChoice, "cancel">,
    expectedSessionId?: string,
  ): Promise<CompleteS3SetupResult> {
    return this.requireCurrent(expectedSessionId, "S3 setup").completeS3Setup(preview, choice);
  }

  enableGitCatalog(expectedSessionId?: string): Promise<void> {
    return this.requireCurrent(expectedSessionId, "Git catalog enablement").enableGitCatalog();
  }

  prune(confirmation?: PruneConfirmation, expectedSessionId?: string): Promise<PruneResult> {
    return this.requireCurrent(expectedSessionId, "prune").prune(confirmation);
  }

  private async startSession(ctx: ExtensionContext): Promise<void> {
    this.retireCurrent();
    const generation = ++this.generation;
    let runtime!: HoarderSessionRuntime;
    runtime = new HoarderSessionRuntime(
      createActiveSessionHost(ctx),
      generation,
      this.dependencies,
      () => this.current === runtime && this.generation === generation,
    );
    this.current = runtime;
    runtime.updateUi();
    await runtime.initialize();
  }

  private retireCurrent(): void {
    this.current?.cancel();
    this.current = undefined;
  }

  private async stopSession(ctx: ExtensionContext): Promise<void> {
    const runtime = this.runtimeForContext(ctx);
    if (!runtime) return;
    await runtime.shutdown();
    if (this.current !== runtime) return;
    this.current = undefined;
    this.generation += 1;
    runtime.clearUi();
  }

  private withCurrent(
    ctx: ExtensionContext,
    action: (runtime: HoarderSessionRuntime) => void,
  ): void {
    const runtime = this.runtimeForContext(ctx);
    if (runtime && runtime === this.current) action(runtime);
  }

  private runtimeForContext(ctx: ExtensionContext): HoarderSessionRuntime | undefined {
    return this.current?.sessionId === ctx.sessionManager.getSessionId() ? this.current : undefined;
  }

  private requireCurrent(
    expectedSessionId: string | undefined,
    operation: string,
  ): HoarderSessionRuntime {
    if (!this.current) throw new Error("No active Session Hoarder runtime.");
    if (expectedSessionId && this.current.sessionId !== expectedSessionId) {
      throw new Error(`The active Pi session changed before ${operation} could start.`);
    }
    return this.current;
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
