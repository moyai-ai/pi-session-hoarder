import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  CheckpointCoordinator,
  type CheckpointCoordinatorOptions,
} from "../application/checkpoint-coordinator.js";
import type {
  CheckpointApplicationService,
  CheckpointSessionResult,
} from "../application/checkpoint-service.js";
import {
  ReplicationCoordinator,
  type ReplicationCoordinatorOptions,
} from "../application/replication-coordinator.js";
import type {
  ReplicateSessionResult,
  ReplicationApplicationService,
} from "../application/replication-service.js";
import type {
  ConfigLoadResult,
  ConfigurationWriter,
  S3TargetConfig,
  StorageTarget,
} from "../application/configuration.js";
import {
  categorizeS3SetupError,
  sanitizedEndpointDisplay,
  sanitizedProfileDisplay,
} from "../application/s3-setup-presentation.js";
import {
  setupDraftFromTarget,
  type S3SetupChoice,
  type S3SetupDraft,
  type S3SetupInitial,
  type S3SetupPreview,
  type S3TargetDraftValidator,
} from "../application/s3-setup.js";
import type { HoarderStatusSnapshot } from "../application/status.js";
import { uniqueObjects, type HoarderStatusQuery } from "../application/status-query.js";
import type { MaintenanceExclusion } from "../application/maintenance-exclusion.js";
import type { PruneConfirmation } from "../application/prune-ports.js";
import type { PruneApplicationService, PruneResult } from "../application/prune-service.js";
import type {
  GitWorktreeInspector,
  ProjectCatalogApplicationService,
  PublishProjectCatalogResult,
} from "../application/project-catalog.js";
import type { RepositoryIdentity } from "../domain/model.js";
import { ActiveSession, type ActiveSessionHost, type UiScheduler } from "./active-session.js";

export type { UiScheduler } from "./active-session.js";

export interface HoarderSyncResult {
  checkpoint: CheckpointSessionResult | undefined;
  replication?: ReplicateSessionResult;
  replicationError?: string;
  projection?: PublishProjectCatalogResult;
  projectionError?: string;
}

export interface CompleteS3SetupResult {
  target: string;
  verified: boolean;
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

export interface LifecycleDependencies {
  loadConfiguration(options: { cwd: string; isProjectTrusted: boolean }): Promise<ConfigLoadResult>;
  resolveRepository(cwd: string): Promise<RepositoryIdentity>;
  createCheckpointService(storageRoot: string): CheckpointApplicationService;
  createStatusQuery(storageRoot: string): HoarderStatusQuery;
  createCoordinator(options: CheckpointCoordinatorOptions): CheckpointCoordinator;
  createReplicationService(
    storageRoot: string,
    target: S3TargetConfig,
  ): ReplicationApplicationService;
  createReplicationCoordinator(options: ReplicationCoordinatorOptions): ReplicationCoordinator;
  createMaintenanceExclusion(storageRoot: string): MaintenanceExclusion;
  createProjectCatalogService(
    storageRoot: string,
    target?: S3TargetConfig,
  ): ProjectCatalogApplicationService;
  gitWorktree: GitWorktreeInspector;
  createPruneService(
    storageRoot: string,
    target: S3TargetConfig,
    exclusion: MaintenanceExclusion,
  ): PruneApplicationService;
  configurationWriter: ConfigurationWriter;
  s3TargetDraftValidator: S3TargetDraftValidator;
  draftReplicationTargetId(target: S3TargetConfig): string;
  defaultS3Region(): string;
  uiScheduler: UiScheduler;
}

/** Pi lifecycle entrypoint. It translates Pi events into application use cases only. */
export class HoarderLifecycle implements HoarderController {
  private readonly dependencies: LifecycleDependencies;
  private readonly runtimes = new Map<string, ActiveSession>();
  private readonly exclusions = new WeakMap<ActiveSession, MaintenanceExclusion>();
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
    return (
      this.currentRuntime()?.snapshot() ?? {
        checkpoint: { state: "disabled", reason: "no active session" },
      }
    );
  }

  async sync(expectedSessionId?: string): Promise<HoarderSyncResult> {
    const runtime = this.requireCurrentRuntime(expectedSessionId, "sync");
    if (!runtime.coordinator) {
      throw new Error(runtime.initializationError ?? "Session Hoarder is disabled.");
    }
    const checkpoint = await runtime.coordinator.flush("manual");
    if (!runtime.replicationCoordinator || !runtime.record) {
      return syncResultWithProjection(runtime, { checkpoint });
    }
    return this.syncRemote(runtime, checkpoint);
  }

  private async syncRemote(
    runtime: ActiveSession,
    checkpoint: CheckpointSessionResult | undefined,
  ): Promise<HoarderSyncResult> {
    try {
      const replication = await runtime.replicationCoordinator!.flush(runtime.record!.revision);
      const replicationStatus = runtime.replicationCoordinator!.getStatus();
      const replicationError =
        replicationStatus.state === "error" ? replicationStatus.error.message : undefined;
      return syncResultWithProjection(runtime, {
        checkpoint,
        ...(replication ? { replication } : {}),
        ...(replicationError ? { replicationError } : {}),
      });
    } catch (error) {
      return syncResultWithProjection(runtime, {
        checkpoint,
        replicationError: errorMessage(error),
      });
    }
  }

  async selectStorageTarget(target: StorageTarget, expectedSessionId?: string): Promise<string> {
    const runtime = this.requireCurrentRuntime(expectedSessionId, "storage selection");
    this.assertStorageTargetAvailable(runtime, target);
    if (target === "local") this.cancelReplication(runtime);
    await this.persistStorageTarget(runtime, target);
    this.assertStorageSelectionCurrent(runtime);
    runtime.config = { ...runtime.config!, storageTarget: target };
    await this.refreshDurableStatus(runtime);
    this.assertStorageSelectionCurrent(runtime);
    this.activateSelectedStorage(runtime, target);
    return selectedTargetLabel(runtime, target);
  }

  private assertStorageTargetAvailable(runtime: ActiveSession, target: StorageTarget): void {
    if (!runtime.config) throw new Error("Session Hoarder configuration is unavailable.");
    if (target === "s3" && !runtime.config.s3) {
      throw new Error("No S3 target is configured in the global Session Hoarder config.");
    }
  }

  private async persistStorageTarget(runtime: ActiveSession, target: StorageTarget): Promise<void> {
    try {
      await this.dependencies.configurationWriter.selectStorageTarget(target);
    } catch (error) {
      if (target === "local" && this.isRuntimeCurrent(runtime)) {
        runtime.replication = replicationSelectionFailure(runtime, error);
        runtime.updateUi();
      }
      throw error;
    }
  }

  private assertStorageSelectionCurrent(runtime: ActiveSession): void {
    if (!this.isRuntimeCurrent(runtime)) {
      throw new Error("The active Pi session changed before storage selection could complete.");
    }
  }

  private activateSelectedStorage(runtime: ActiveSession, target: StorageTarget): void {
    if (target === "s3") this.configureReplication(runtime);
    else runtime.replication = { state: "off" };
    runtime.updateUi();
  }

  getS3SetupInitial(expectedSessionId?: string): S3SetupInitial {
    const runtime = this.requireCurrentRuntime(expectedSessionId, "S3 setup");
    if (!runtime.config || !runtime.globalConfigPath) {
      throw new Error("Session Hoarder configuration is unavailable.");
    }
    return setupDraftFromTarget(
      runtime.config.s3,
      runtime.globalConfigPath,
      this.dependencies.defaultS3Region(),
    );
  }

  async prepareS3Setup(draft: S3SetupDraft, expectedSessionId?: string): Promise<S3SetupPreview> {
    const runtime = this.requireCurrentRuntime(expectedSessionId, "S3 setup");
    if (!runtime.config) throw new Error("Session Hoarder configuration is unavailable.");
    const target = this.dependencies.s3TargetDraftValidator.validate(draft);
    if (!runtime.coordinator) {
      throw new Error(runtime.initializationError ?? "Session Hoarder is disabled.");
    }
    await runtime.coordinator.flush("s3-setup-preview");
    if (!this.isRuntimeCurrent(runtime)) {
      throw new Error("The active Pi session changed before S3 setup could continue.");
    }
    if (!runtime.record)
      throw new Error("No committed local checkpoint is available for S3 setup.");
    const objects = uniqueObjects(runtime.record);
    return {
      target: structuredClone(target),
      objectCount: objects.length,
      encodedBytes: objects.reduce((total, object) => total + object.storedBytes, 0),
      endpointDisplay: sanitizedEndpointDisplay(target.endpoint),
      profileDisplay: sanitizedProfileDisplay(target.profile),
    };
  }

  async completeS3Setup(
    preview: S3SetupPreview,
    choice: Exclude<S3SetupChoice, "cancel">,
    expectedSessionId?: string,
  ): Promise<CompleteS3SetupResult> {
    const runtime = this.requireCurrentRuntime(expectedSessionId, "S3 setup");
    if (!runtime.config || !runtime.record) {
      throw new Error("Session Hoarder configuration or local checkpoint is unavailable.");
    }
    const target = this.dependencies.s3TargetDraftValidator.validate({
      targetId: preview.target.targetId,
      bucket: preview.target.bucket,
      region: preview.target.region,
      prefix: preview.target.prefix,
      endpoint: preview.target.endpoint ?? "",
      profile: preview.target.profile ?? "",
      forcePathStyle: preview.target.forcePathStyle,
    });
    const verified = choice === "upload-and-save";
    if (verified) await this.verifyDraftTarget(runtime, target);
    this.assertSetupRuntimeCurrent(runtime, "saved");
    await this.dependencies.configurationWriter.configureAndSelectS3(target);
    this.assertSetupRuntimeCurrent(runtime, "activated");
    await this.activateS3Target(runtime, target);
    return { target: `s3:${target.targetId}`, verified };
  }

  private async verifyDraftTarget(runtime: ActiveSession, target: S3TargetConfig): Promise<void> {
    const draftTarget = {
      ...target,
      targetId: this.dependencies.draftReplicationTargetId(target),
    };
    const service = this.dependencies.createReplicationService(
      runtime.config!.storageRoot,
      draftTarget,
    );
    let failure: string | undefined;
    try {
      const result = await this.exclusionFor(runtime).runActivity(() =>
        service.sync({
          targetId: draftTarget.targetId,
          repositoryId: runtime.repository.repositoryId,
          sessionId: runtime.sessionId,
        }),
      );
      if (!result || result.record.revision < runtime.record!.revision) {
        failure = "draft target verification did not cover the current local revision";
      }
    } catch (error) {
      failure = categorizeS3SetupError(error);
    }
    if (failure) throw new Error(`S3 target verification failed: ${failure}.`);
  }

  private assertSetupRuntimeCurrent(runtime: ActiveSession, action: string): void {
    if (!this.isRuntimeCurrent(runtime)) {
      throw new Error(`The active Pi session changed before S3 setup could be ${action}.`);
    }
  }

  private async activateS3Target(runtime: ActiveSession, target: S3TargetConfig): Promise<void> {
    runtime.config = { ...runtime.config!, storageTarget: "s3", s3: target };
    if (runtime.config.gitCatalogEnabled && runtime.isProjectTrusted) {
      runtime.projectCatalogService = this.dependencies.createProjectCatalogService(
        runtime.config.storageRoot,
        target,
      );
    }
    await this.refreshDurableStatus(runtime);
    this.assertSetupRuntimeCurrent(runtime, "activated");
    this.configureReplication(runtime);
    runtime.updateUi();
  }

  async prune(confirmation?: PruneConfirmation, expectedSessionId?: string): Promise<PruneResult> {
    const runtime = this.requireCurrentRuntime(expectedSessionId, "prune");
    if (!runtime.config || runtime.config.storageTarget !== "s3" || !runtime.config.s3) {
      throw new Error("Local cache pruning is available only while S3 storage is selected.");
    }
    const exclusion = this.exclusions.get(runtime);
    if (!exclusion) throw new Error("Session Hoarder maintenance is unavailable.");
    const result = await this.dependencies
      .createPruneService(runtime.config.storageRoot, runtime.config.s3, exclusion)
      .prune(runtime.config.s3.targetId, confirmation);
    await this.refreshDurableStatus(runtime);
    runtime.updateUi();
    return result;
  }

  async enableGitCatalog(expectedSessionId?: string): Promise<void> {
    const runtime = this.requireCurrentRuntime(expectedSessionId, "Git catalog enablement");
    if (!runtime.isProjectTrusted) {
      throw new Error("Git catalog publication can be enabled only for a trusted project.");
    }
    if (!runtime.config) throw new Error("Session Hoarder configuration is unavailable.");
    const git = await this.dependencies.gitWorktree.inspect(runtime.cwd);
    if (!git) throw new Error("Git catalog publication requires a Git worktree.");
    await this.dependencies.configurationWriter.enableGitCatalog(git.worktreeRoot);
    runtime.config = { ...runtime.config, gitCatalogEnabled: true };
    runtime.projectCatalogService = this.dependencies.createProjectCatalogService(
      runtime.config.storageRoot,
      runtime.config.s3,
    );
    if (runtime.record) {
      await this.exclusionFor(runtime).runActivity(() => this.publishProjectCatalog(runtime));
      if (runtime.projectCatalogError) throw new Error(runtime.projectCatalogError);
    }
    runtime.updateUi();
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
    this.cancelReplication(runtime);
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
      runtime.globalConfigPath = configResult.paths.global;
      runtime.configurationWarning = configResult.ok ? configResult.warning?.message : undefined;
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
      await this.activateRuntime(runtime, repository, configResult.config.storageRoot);
    } catch (error) {
      if (!this.isGenerationCurrent(runtime.generation)) return;
      runtime.failInitialization(error);
      runtime.updateUi();
    }
  }

  private async activateRuntime(
    runtime: ActiveSession,
    repository: RepositoryIdentity,
    storageRoot: string,
  ): Promise<void> {
    this.rekeyRuntime(runtime, repository);
    this.exclusions.set(runtime, this.dependencies.createMaintenanceExclusion(storageRoot));
    runtime.statusQuery = this.dependencies.createStatusQuery(storageRoot);
    await this.refreshDurableStatus(runtime);
    if (!this.isRuntimeCurrent(runtime)) return;
    const checkpointService = this.dependencies.createCheckpointService(storageRoot);
    if (runtime.config?.gitCatalogEnabled && runtime.isProjectTrusted) {
      runtime.projectCatalogService = this.dependencies.createProjectCatalogService(
        storageRoot,
        runtime.config.s3,
      );
    }
    runtime.checkpoint = { state: "idle" };
    runtime.coordinator = this.createCoordinator(runtime, checkpointService);
    this.configureReplication(runtime);
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
        run: async (_reasons, signal) =>
          this.exclusionFor(runtime).runActivity(async () => {
            const result = await checkpointService.checkpoint(
              {
                repositoryId: runtime.repository.repositoryId,
                sessionId: runtime.sessionId,
                sessionFile: runtime.sessionFile!,
              },
              signal,
            );
            if (result && this.isRuntimeCurrent(runtime)) {
              runtime.record = result.record;
              await this.refreshDurableStatus(runtime);
              if (!this.isRuntimeCurrent(runtime)) return result;
              runtime.replicationCoordinator?.markRevision(result.record.revision);
              if (runtime.config?.storageTarget === "local") {
                await this.publishProjectCatalog(runtime);
              }
            }
            return result;
          }, signal),
      },
    });
  }

  private configureReplication(runtime: ActiveSession): void {
    this.cancelReplication(runtime);
    if (runtime.config?.storageTarget !== "s3" || !runtime.config.s3) {
      runtime.replication = { state: "off" };
      return;
    }

    const target = runtime.config.s3;
    const service = this.dependencies.createReplicationService(runtime.config.storageRoot, target);
    runtime.replication = { state: "idle" };
    let coordinator!: ReplicationCoordinator;
    coordinator = this.dependencies.createReplicationCoordinator({
      debounceMs: runtime.config.debounceMs,
      shutdownTimeoutMs: runtime.config.shutdownTimeoutMs,
      isCurrent: () => this.isReplicationCurrent(runtime, coordinator, target.targetId),
      onStatus: (status) => {
        if (!this.isReplicationCurrent(runtime, coordinator, target.targetId)) return;
        runtime.replication = status;
        runtime.updateUi();
      },
      runner: {
        run: (signal) =>
          this.exclusionFor(runtime).runActivity(async () => {
            const result = await service.sync(
              {
                targetId: target.targetId,
                repositoryId: runtime.repository.repositoryId,
                sessionId: runtime.sessionId,
              },
              signal,
            );
            if (result && this.isReplicationCurrent(runtime, coordinator, target.targetId)) {
              await this.refreshDurableStatus(runtime);
              if (this.isReplicationCurrent(runtime, coordinator, target.targetId)) {
                await this.publishProjectCatalog(runtime);
              }
            }
            return result;
          }, signal),
      },
    });
    runtime.replicationCoordinator = coordinator;
    if (runtime.record) coordinator.markRevision(runtime.record.revision);
  }

  private cancelReplication(runtime: ActiveSession): void {
    const coordinator = runtime.replicationCoordinator;
    runtime.replicationCoordinator = undefined;
    coordinator?.cancelWithoutDrain();
  }

  private async stopSession(ctx: ExtensionContext): Promise<void> {
    const runtime = this.runtimeForContext(ctx);
    if (!runtime) return;
    await runtime.coordinator?.shutdown("shutdown");
    await runtime.replicationCoordinator?.shutdownAndDrain();
    runtime.coordinator?.dispose();
    runtime.replicationCoordinator?.dispose();
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

  private requireCurrentRuntime(
    expectedSessionId: string | undefined,
    operation: string,
  ): ActiveSession {
    const runtime = this.currentRuntime();
    if (!runtime) throw new Error("No active Session Hoarder runtime.");
    if (expectedSessionId && runtime.sessionId !== expectedSessionId) {
      throw new Error(`The active Pi session changed before ${operation} could start.`);
    }
    return runtime;
  }

  private async publishProjectCatalog(runtime: ActiveSession): Promise<void> {
    if (
      !runtime.config?.gitCatalogEnabled ||
      !runtime.isProjectTrusted ||
      !runtime.record ||
      !runtime.projectCatalogService ||
      runtime.projectCatalog?.revision === runtime.record.revision
    )
      return;
    try {
      runtime.projectCatalog = await runtime.projectCatalogService.publish({
        cwd: runtime.cwd,
        trusted: runtime.isProjectTrusted,
        archive: runtime.record,
        storageTarget: runtime.config.storageTarget,
        ...(runtime.config.s3 ? { s3: runtime.config.s3 } : {}),
      });
      runtime.projectCatalogError = undefined;
    } catch (error) {
      runtime.projectCatalogError = errorMessage(error);
    }
  }

  private async refreshDurableStatus(runtime: ActiveSession): Promise<void> {
    if (!runtime.statusQuery || !runtime.config) return;
    const sequence = runtime.beginStatusRefresh();
    const durable = await runtime.statusQuery.read({
      repositoryId: runtime.repository.repositoryId,
      sessionId: runtime.sessionId,
      config: runtime.config,
    });
    if (!this.isRuntimeCurrent(runtime)) return;
    runtime.applyDurableStatus(sequence, durable);
  }

  private exclusionFor(runtime: ActiveSession): MaintenanceExclusion {
    const exclusion = this.exclusions.get(runtime);
    if (!exclusion) throw new Error("Session Hoarder maintenance is unavailable.");
    return exclusion;
  }

  private isGenerationCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  private isRuntimeCurrent(runtime: ActiveSession): boolean {
    return this.currentKey === runtime.key && this.generation === runtime.generation;
  }

  private isReplicationCurrent(
    runtime: ActiveSession,
    coordinator: ReplicationCoordinator,
    targetId: string,
  ): boolean {
    return (
      this.isRuntimeCurrent(runtime) &&
      runtime.replicationCoordinator === coordinator &&
      runtime.config?.storageTarget === "s3" &&
      runtime.config.s3?.targetId === targetId
    );
  }
}

function replicationSelectionFailure(
  runtime: ActiveSession,
  error: unknown,
): ActiveSession["replication"] {
  const previous = runtime.replication;
  const localRevision =
    runtime.record?.revision ?? ("localRevision" in previous ? previous.localRevision : 0);
  const publishedRevision =
    "publishedRevision" in previous ? previous.publishedRevision : undefined;
  return {
    state: "error",
    localRevision,
    ...(publishedRevision ? { publishedRevision } : {}),
    error: {
      code: "STORAGE_SELECTION_FAILED",
      message: `Local selection failed; remote replication is paused: ${errorMessage(error)}`,
      occurredAt: new Date().toISOString(),
      retryable: true,
    },
  };
}

function syncResultWithProjection(
  runtime: ActiveSession,
  result: HoarderSyncResult,
): HoarderSyncResult {
  return {
    ...result,
    ...(runtime.projectCatalog ? { projection: runtime.projectCatalog } : {}),
    ...(runtime.projectCatalogError ? { projectionError: runtime.projectCatalogError } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedTargetLabel(runtime: ActiveSession, target: StorageTarget): string {
  return target === "s3" ? `s3:${runtime.config!.s3!.targetId}` : "local";
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
