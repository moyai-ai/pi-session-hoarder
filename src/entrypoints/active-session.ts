import type { CheckpointCoordinator } from "../application/checkpoint-coordinator.js";
import type {
  ReplicationCoordinator,
  ReplicationStatus,
} from "../application/replication-coordinator.js";
import type { ConfigLoadResult, HoarderConfig } from "../application/configuration.js";
import type {
  ProjectCatalogApplicationService,
  PublishProjectCatalogResult,
} from "../application/project-catalog.js";
import { formatFooterStatus, type HoarderStatusSnapshot } from "../application/status.js";
import type {
  CheckpointStatus,
  RepositoryIdentity,
  SessionArchiveRecord,
} from "../domain/model.js";

export interface UiScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Narrow host boundary implemented by the Pi lifecycle adapter. */
export interface ActiveSessionHost {
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  isProjectTrusted: boolean;
  hasUi: boolean;
  renderStatus(status: string): void;
  clearStatus(): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 200;

/** Mutable state and UI presentation for exactly one Pi session generation. */
export class ActiveSession {
  key: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  repository: RepositoryIdentity;
  config?: HoarderConfig;
  globalConfigPath?: string;
  checkpoint: CheckpointStatus = { state: "pending", dirtyReasons: ["initializing"] };
  record?: SessionArchiveRecord;
  initializationError?: string;
  configurationWarning?: string;
  coordinator?: CheckpointCoordinator;
  replicationCoordinator?: ReplicationCoordinator;
  replication: ReplicationStatus = { state: "off" };
  projectCatalogService?: ProjectCatalogApplicationService;
  projectCatalog?: PublishProjectCatalogResult;
  projectCatalogError?: string;

  private readonly host: ActiveSessionHost;
  private readonly scheduler: UiScheduler;
  private readonly isCurrent: () => boolean;
  private spinnerHandle?: unknown;
  private spinnerFrame = 0;

  constructor(
    host: ActiveSessionHost,
    generation: number,
    scheduler: UiScheduler,
    isCurrent: () => boolean,
  ) {
    this.host = host;
    this.generation = generation;
    this.sessionId = host.sessionId;
    this.sessionFile = host.sessionFile;
    this.repository = {
      kind: "cwd",
      canonicalValue: host.cwd,
      repositoryId: "initializing",
    };
    this.key = `initializing:${this.sessionId}:${generation}`;
    this.scheduler = scheduler;
    this.isCurrent = isCurrent;
  }

  get cwd(): string {
    return this.host.cwd;
  }

  get isProjectTrusted(): boolean {
    return this.host.isProjectTrusted;
  }

  snapshot(): HoarderStatusSnapshot {
    return structuredClone({
      sessionId: this.sessionId,
      repositoryId: this.repository.repositoryId,
      config: this.config,
      globalConfigPath: this.globalConfigPath,
      checkpoint: this.checkpoint,
      record: this.record,
      initializationError: this.initializationError,
      configurationWarning: this.configurationWarning,
      publishedRevision: publishedRevision(this.replication),
      remoteState: remoteState(this.replication),
    });
  }

  failConfiguration(result: Extract<ConfigLoadResult, { ok: false }>): void {
    this.initializationError = result.error.message;
    this.checkpoint = {
      state: "error",
      error: {
        code: `CONFIG_${result.error.kind.toUpperCase()}`,
        message: result.error.message,
        occurredAt: new Date().toISOString(),
        retryable: true,
      },
    };
  }

  failInitialization(error: unknown): void {
    this.initializationError = errorMessage(error);
    this.checkpoint = {
      state: "error",
      error: {
        code: "INITIALIZATION_FAILED",
        message: this.initializationError,
        occurredAt: new Date().toISOString(),
        retryable: true,
      },
    };
  }

  updateUi(): void {
    if (!this.host.hasUi || !this.isCurrent()) {
      this.stopSpinner();
      return;
    }
    if (this.checkpoint.state === "running") this.startSpinner();
    else this.stopSpinner();
    this.renderStatus();
  }

  stopUi(): void {
    this.stopSpinner();
  }

  clearUi(): void {
    this.stopUi();
    if (this.host.hasUi) this.host.clearStatus();
  }

  private startSpinner(): void {
    if (this.spinnerHandle !== undefined) return;
    this.spinnerFrame = 0;
    this.spinnerHandle = this.scheduler.setInterval(() => {
      if (!this.isCurrent() || this.checkpoint.state !== "running") {
        this.stopSpinner();
        return;
      }
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.renderStatus();
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerHandle === undefined) return;
    this.scheduler.clearInterval(this.spinnerHandle);
    this.spinnerHandle = undefined;
    this.spinnerFrame = 0;
  }

  private renderStatus(): void {
    const frame = SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0];
    this.host.renderStatus(formatFooterStatus(this.snapshot(), frame));
  }
}

function publishedRevision(status: ReplicationStatus): number | undefined {
  return "publishedRevision" in status ? status.publishedRevision : undefined;
}

function remoteState(status: ReplicationStatus): string {
  switch (status.state) {
    case "off":
      return "off";
    case "idle":
      return status.publishedRevision ? "synchronized" : "not synchronized";
    case "pending":
      return "pending";
    case "running":
      return "synchronizing";
    case "error":
      return "retry pending";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
