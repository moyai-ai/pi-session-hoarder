import type {
  CheckpointCoordinator,
  CheckpointCoordinatorOptions,
} from "../application/checkpoint-coordinator.js";
import type { CheckpointApplicationService } from "../application/checkpoint-service.js";
import type {
  ConfigLoadResult,
  ConfigurationWriter,
  S3TargetConfig,
  StorageTarget,
} from "../application/configuration.js";
import type { MaintenanceExclusion } from "../application/maintenance-exclusion.js";
import type { PruneConfirmation } from "../application/prune-ports.js";
import type { PruneApplicationService, PruneResult } from "../application/prune-service.js";
import type {
  GitWorktreeInspector,
  ProjectCatalogApplicationService,
} from "../application/project-catalog.js";
import type {
  ReplicationCoordinator,
  ReplicationCoordinatorOptions,
} from "../application/replication-coordinator.js";
import type { ReplicationApplicationService } from "../application/replication-service.js";
import type {
  S3SetupChoice,
  S3SetupDraft,
  S3SetupInitial,
  S3SetupPreview,
  S3TargetDraftValidator,
} from "../application/s3-setup.js";
import {
  SessionSyncPipeline,
  type ApplicationError,
  type SessionSyncPipelineResult,
} from "../application/session-sync-pipeline.js";
import type { HoarderStatusSnapshot } from "../application/status.js";
import type { HoarderStatusQuery } from "../application/status-query.js";
import { TargetSelectionService } from "../application/target-selection-service.js";
import type { RepositoryIdentity } from "../domain/model.js";
import { ActiveSession, type ActiveSessionHost, type UiScheduler } from "./active-session.js";
import { SessionS3SetupController, type CompleteS3SetupResult } from "./session-s3-setup.js";

export type { CompleteS3SetupResult } from "./session-s3-setup.js";

export interface SessionRuntimeDependencies {
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

/** Owns all mutable state and workflows for one active lifecycle generation. */
export class HoarderSessionRuntime {
  private readonly session: ActiveSession;
  private readonly pipeline: SessionSyncPipeline;
  private exclusion?: MaintenanceExclusion;

  constructor(
    host: ActiveSessionHost,
    generation: number,
    private readonly dependencies: SessionRuntimeDependencies,
    private readonly isCurrent: () => boolean,
  ) {
    this.session = new ActiveSession(host, generation, dependencies.uiScheduler, isCurrent);
    this.pipeline = new SessionSyncPipeline({
      checkpoint: (reason) => this.checkpoint(reason),
      currentRevision: () => this.session.record?.revision,
      replication: () => this.replicationPort(),
      projection: {
        publish: () => this.publishProjectCatalog(),
        current: () => this.session.projectCatalog,
        error: () =>
          this.session.projectCatalogError
            ? { message: this.session.projectCatalogError }
            : undefined,
      },
    });
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  snapshot(): HoarderStatusSnapshot {
    return this.session.snapshot();
  }

  updateUi(): void {
    this.session.updateUi();
  }

  clearUi(): void {
    this.session.clearUi();
  }

  async initialize(): Promise<void> {
    try {
      const result = await this.dependencies.loadConfiguration({
        cwd: this.session.cwd,
        isProjectTrusted: this.session.isProjectTrusted,
      });
      this.applyConfiguration(result);
      if (!result.ok || !result.config.enabled || !this.session.sessionFile) return;
      const repository = await this.dependencies.resolveRepository(this.session.cwd);
      if (!this.isCurrent()) return;
      await this.activate(repository, result.config.storageRoot);
    } catch (error) {
      if (!this.isCurrent()) return;
      this.session.failInitialization(error);
      this.session.updateUi();
    }
  }

  markDirty(reason: string): void {
    this.session.coordinator?.markDirty(reason);
  }

  flush(reason: string): Promise<unknown> {
    return this.session.coordinator?.flush(reason) ?? Promise.resolve(undefined);
  }

  async sync(): Promise<SessionSyncPipelineResult> {
    if (!this.session.coordinator) {
      throw new Error(this.session.initializationError ?? "Session Hoarder is disabled.");
    }
    return this.pipeline.sync("manual");
  }

  selectStorageTarget(target: StorageTarget): Promise<string> {
    return new TargetSelectionService({
      config: () => this.session.config,
      cancelReplication: () => this.cancelReplication(),
      persist: (selected) => this.dependencies.configurationWriter.selectStorageTarget(selected),
      apply: (selected) => {
        this.session.config = { ...this.session.config!, storageTarget: selected };
      },
      refreshDurableStatus: () => this.refreshDurableStatus(),
      activate: (selected) => this.activateSelectedStorage(selected),
      assertCurrent: () => this.assertCurrent("before storage selection could complete."),
      recordLocalSelectionFailure: (error) => this.recordLocalSelectionFailure(error),
    }).select(target);
  }

  getS3SetupInitial(): S3SetupInitial {
    return this.s3Setup().initial();
  }

  prepareS3Setup(draft: S3SetupDraft): Promise<S3SetupPreview> {
    return this.s3Setup().prepare(draft);
  }

  completeS3Setup(
    preview: S3SetupPreview,
    choice: Exclude<S3SetupChoice, "cancel">,
  ): Promise<CompleteS3SetupResult> {
    return this.s3Setup().complete(preview, choice);
  }

  async prune(confirmation?: PruneConfirmation): Promise<PruneResult> {
    const config = this.session.config;
    if (!config || config.storageTarget !== "s3" || !config.s3) {
      throw new Error("Local cache pruning is available only while S3 storage is selected.");
    }
    const result = await this.dependencies
      .createPruneService(config.storageRoot, config.s3, this.exclusionFor())
      .prune(config.s3.targetId, confirmation);
    await this.refreshDurableStatus();
    this.session.updateUi();
    return result;
  }

  async enableGitCatalog(): Promise<void> {
    if (!this.session.isProjectTrusted) {
      throw new Error("Git catalog publication can be enabled only for a trusted project.");
    }
    if (!this.session.config) throw new Error("Session Hoarder configuration is unavailable.");
    const git = await this.dependencies.gitWorktree.inspect(this.session.cwd);
    if (!git) throw new Error("Git catalog publication requires a Git worktree.");
    await this.dependencies.configurationWriter.enableGitCatalog(git.worktreeRoot);
    this.session.config = { ...this.session.config, gitCatalogEnabled: true };
    this.session.projectCatalogService = this.dependencies.createProjectCatalogService(
      this.session.config.storageRoot,
      this.session.config.s3,
    );
    if (this.session.record) {
      await this.exclusionFor().runActivity(() => this.publishProjectCatalog());
      if (this.session.projectCatalogError) throw new Error(this.session.projectCatalogError);
    }
    this.session.updateUi();
  }

  cancel(): void {
    this.session.coordinator?.dispose();
    this.cancelReplication();
    this.session.stopUi();
  }

  async shutdown(): Promise<void> {
    await this.session.coordinator?.shutdown("shutdown");
    await this.session.replicationCoordinator?.shutdownAndDrain();
    this.session.coordinator?.dispose();
    this.session.replicationCoordinator?.dispose();
    this.session.stopUi();
  }

  private applyConfiguration(result: ConfigLoadResult): void {
    this.session.config = result.config;
    this.session.globalConfigPath = result.paths.global;
    this.session.configurationWarning = result.ok ? result.warning?.message : undefined;
    if (!result.ok) this.session.failConfiguration(result);
    else if (!result.config.enabled)
      this.session.checkpoint = { state: "disabled", reason: "disabled by configuration" };
    else if (!this.session.sessionFile)
      this.session.checkpoint = { state: "disabled", reason: "ephemeral Pi session" };
    this.session.updateUi();
  }

  private async activate(repository: RepositoryIdentity, storageRoot: string): Promise<void> {
    this.session.repository = repository;
    this.session.key = `${repository.repositoryId}:${this.session.sessionId}`;
    this.exclusion = this.dependencies.createMaintenanceExclusion(storageRoot);
    this.session.statusQuery = this.dependencies.createStatusQuery(storageRoot);
    await this.refreshDurableStatus();
    if (!this.isCurrent()) return;
    if (this.session.config?.gitCatalogEnabled && this.session.isProjectTrusted) {
      this.session.projectCatalogService = this.dependencies.createProjectCatalogService(
        storageRoot,
        this.session.config.s3,
      );
    }
    this.session.checkpoint = { state: "idle" };
    this.session.coordinator = this.createCheckpointCoordinator(
      this.dependencies.createCheckpointService(storageRoot),
    );
    this.configureReplication();
    this.session.updateUi();
    void this.session.coordinator.flush("startup-recovery");
  }

  private createCheckpointCoordinator(
    service: CheckpointApplicationService,
  ): CheckpointCoordinator {
    return this.dependencies.createCoordinator({
      debounceMs: this.session.config!.debounceMs,
      shutdownTimeoutMs: this.session.config!.shutdownTimeoutMs,
      isCurrent: this.isCurrent,
      onStatus: (status) => {
        this.session.checkpoint = status;
        this.session.updateUi();
      },
      runner: {
        run: async (_reasons, signal) =>
          this.exclusionFor().runActivity(async () => {
            const result = await service.checkpoint(
              {
                repositoryId: this.session.repository.repositoryId,
                sessionId: this.session.sessionId,
                sessionFile: this.session.sessionFile!,
              },
              signal,
            );
            if (result && this.isCurrent()) {
              this.session.record = result.record;
              await this.refreshDurableStatus();
              if (this.isCurrent()) await this.pipeline.afterCheckpoint(result);
            }
            return result;
          }, signal),
      },
    });
  }

  private configureReplication(): void {
    this.cancelReplication();
    const config = this.session.config;
    if (config?.storageTarget !== "s3" || !config.s3) {
      this.session.replication = { state: "off" };
      return;
    }
    const target = config.s3;
    const service = this.dependencies.createReplicationService(config.storageRoot, target);
    this.session.replication = { state: "idle" };
    let coordinator!: ReplicationCoordinator;
    coordinator = this.dependencies.createReplicationCoordinator({
      debounceMs: config.debounceMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
      isCurrent: () => this.isReplicationCurrent(coordinator, target.targetId),
      onStatus: (status) => {
        if (!this.isReplicationCurrent(coordinator, target.targetId)) return;
        this.session.replication = status;
        this.session.updateUi();
      },
      runner: {
        run: (signal) =>
          this.exclusionFor().runActivity(async () => {
            const result = await service.sync(
              {
                targetId: target.targetId,
                repositoryId: this.session.repository.repositoryId,
                sessionId: this.session.sessionId,
              },
              signal,
            );
            if (result && this.isReplicationCurrent(coordinator, target.targetId)) {
              await this.refreshDurableStatus();
              if (this.isReplicationCurrent(coordinator, target.targetId)) {
                await this.pipeline.afterReplication(result);
              }
            }
            return result;
          }, signal),
      },
    });
    this.session.replicationCoordinator = coordinator;
    if (this.session.record) coordinator.markRevision(this.session.record.revision);
  }

  private replicationPort() {
    const coordinator = this.session.replicationCoordinator;
    if (!coordinator || !this.session.record) return undefined;
    return {
      queue: (revision: number) => coordinator.markRevision(revision),
      flush: (revision: number) => coordinator.flush(revision),
      error: (): ApplicationError | undefined => {
        const status = coordinator.getStatus();
        return status.state === "error" ? { message: status.error.message } : undefined;
      },
    };
  }

  private checkpoint(reason: string) {
    if (!this.session.coordinator) {
      throw new Error(this.session.initializationError ?? "Session Hoarder is disabled.");
    }
    return this.session.coordinator.flush(reason);
  }

  private async publishProjectCatalog(): Promise<void> {
    const session = this.session;
    if (
      !session.config?.gitCatalogEnabled ||
      !session.isProjectTrusted ||
      !session.record ||
      !session.projectCatalogService ||
      session.projectCatalog?.revision === session.record.revision
    )
      return;
    try {
      session.projectCatalog = await session.projectCatalogService.publish({
        cwd: session.cwd,
        trusted: session.isProjectTrusted,
        archive: session.record,
        storageTarget: session.config.storageTarget,
        ...(session.config.s3 ? { s3: session.config.s3 } : {}),
      });
      session.projectCatalogError = undefined;
    } catch (error) {
      session.projectCatalogError = errorMessage(error);
    }
  }

  private async refreshDurableStatus(): Promise<void> {
    if (!this.session.statusQuery || !this.session.config) return;
    const sequence = this.session.beginStatusRefresh();
    const durable = await this.session.statusQuery.read({
      repositoryId: this.session.repository.repositoryId,
      sessionId: this.session.sessionId,
      config: this.session.config,
    });
    if (!this.isCurrent()) return;
    this.session.applyDurableStatus(sequence, durable);
  }

  private s3Setup(): SessionS3SetupController {
    return new SessionS3SetupController(
      this.session,
      this.dependencies,
      () => this.exclusionFor(),
      (message) => this.assertCurrent(message),
      (target) => this.activateS3Target(target),
    );
  }

  private async activateS3Target(target: S3TargetConfig): Promise<void> {
    this.session.config = { ...this.session.config!, storageTarget: "s3", s3: target };
    if (this.session.config.gitCatalogEnabled && this.session.isProjectTrusted) {
      this.session.projectCatalogService = this.dependencies.createProjectCatalogService(
        this.session.config.storageRoot,
        target,
      );
    }
    await this.refreshDurableStatus();
    this.assertCurrent("before S3 setup could be activated.");
    this.configureReplication();
    this.session.updateUi();
  }

  private activateSelectedStorage(target: StorageTarget): void {
    if (target === "s3") this.configureReplication();
    else this.session.replication = { state: "off" };
    this.session.updateUi();
  }

  private cancelReplication(): void {
    const coordinator = this.session.replicationCoordinator;
    this.session.replicationCoordinator = undefined;
    coordinator?.cancelWithoutDrain();
  }

  private recordLocalSelectionFailure(error: unknown): void {
    if (!this.isCurrent()) return;
    const previous = this.session.replication;
    const localRevision =
      this.session.record?.revision ?? ("localRevision" in previous ? previous.localRevision : 0);
    const publishedRevision =
      "publishedRevision" in previous ? previous.publishedRevision : undefined;
    this.session.replication = {
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
    this.session.updateUi();
  }

  private exclusionFor(): MaintenanceExclusion {
    if (!this.exclusion) throw new Error("Session Hoarder maintenance is unavailable.");
    return this.exclusion;
  }

  private assertCurrent(message: string): void {
    if (!this.isCurrent()) throw new Error(`The active Pi session changed ${message}`);
  }

  private isReplicationCurrent(coordinator: ReplicationCoordinator, targetId: string): boolean {
    return (
      this.isCurrent() &&
      this.session.replicationCoordinator === coordinator &&
      this.session.config?.storageTarget === "s3" &&
      this.session.config.s3?.targetId === targetId
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
