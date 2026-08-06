import type { CheckpointSessionResult } from "./checkpoint-service.js";
import type { PublishProjectCatalogResult } from "./project-catalog.js";
import type { ReplicateSessionResult } from "./replication-service.js";

export interface ApplicationError {
  message: string;
}

export interface SessionSyncPipelineResult {
  checkpoint?: CheckpointSessionResult;
  replication?: ReplicateSessionResult;
  replicationError?: ApplicationError;
  projection?: PublishProjectCatalogResult;
  projectionError?: ApplicationError;
}

export interface SessionSyncPipelinePorts {
  checkpoint(reason: string): Promise<CheckpointSessionResult | undefined>;
  currentRevision(): number | undefined;
  replication():
    | {
        queue(revision: number): void;
        flush(revision: number): Promise<ReplicateSessionResult | undefined>;
        error(): ApplicationError | undefined;
      }
    | undefined;
  projection?: {
    publish(): Promise<void>;
    current(): PublishProjectCatalogResult | undefined;
    error(): ApplicationError | undefined;
  };
}

/** Orders local checkpoint, exact-revision replication, and eligible projection publication. */
export class SessionSyncPipeline {
  constructor(private readonly ports: SessionSyncPipelinePorts) {}

  async sync(reason = "manual"): Promise<SessionSyncPipelineResult> {
    const checkpointStage = await this.runCheckpoint(reason);
    const replicationStage = await this.runReplication();
    return {
      ...(checkpointStage.checkpoint ? { checkpoint: checkpointStage.checkpoint } : {}),
      ...(replicationStage.replication ? { replication: replicationStage.replication } : {}),
      ...(replicationStage.error ? { replicationError: replicationStage.error } : {}),
      ...this.projectionOutcome(
        replicationStage.projectionError ?? checkpointStage.projectionError,
      ),
    };
  }

  async afterCheckpoint(result: CheckpointSessionResult): Promise<void> {
    const remote = this.ports.replication();
    if (remote) {
      remote.queue(result.record.revision);
      return;
    }
    await this.publishProjection();
  }

  async afterReplication(result: ReplicateSessionResult): Promise<void> {
    if (result.record.revision !== this.ports.currentRevision()) return;
    await this.publishProjection();
  }

  private async runCheckpoint(reason: string): Promise<{
    checkpoint?: CheckpointSessionResult;
    projectionError?: ApplicationError;
  }> {
    const checkpoint = await this.ports.checkpoint(reason);
    if (!checkpoint) return {};
    try {
      await this.afterCheckpoint(checkpoint);
      return { checkpoint };
    } catch (error) {
      return { checkpoint, projectionError: applicationError(error) };
    }
  }

  private async runReplication(): Promise<{
    replication?: ReplicateSessionResult;
    error?: ApplicationError;
    projectionError?: ApplicationError;
  }> {
    const revision = this.ports.currentRevision();
    const remote = this.ports.replication();
    if (revision === undefined || !remote) return {};
    try {
      const replication = await remote.flush(revision);
      const error = remote.error();
      if (!replication) return error ? { error } : {};
      try {
        await this.afterReplication(replication);
        return { replication, ...(error ? { error } : {}) };
      } catch (projectionFailure) {
        return {
          replication,
          ...(error ? { error } : {}),
          projectionError: applicationError(projectionFailure),
        };
      }
    } catch (error) {
      return { error: applicationError(error) };
    }
  }

  private async publishProjection(): Promise<void> {
    if (!this.ports.projection) return;
    await this.ports.projection.publish();
  }

  private projectionOutcome(
    pipelineError?: ApplicationError,
  ): Pick<SessionSyncPipelineResult, "projection" | "projectionError"> {
    const projection = this.ports.projection?.current();
    const projectionError = pipelineError ?? this.ports.projection?.error();
    return {
      ...(projection ? { projection } : {}),
      ...(projectionError ? { projectionError } : {}),
    };
  }
}

function applicationError(error: unknown): ApplicationError {
  return { message: error instanceof Error ? error.message : String(error) };
}
