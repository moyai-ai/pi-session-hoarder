import type { S3TargetConfig } from "../application/configuration.js";
import type { MaintenanceExclusion } from "../application/maintenance-exclusion.js";
import type { ReplicationApplicationService } from "../application/replication-service.js";
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
import { uniqueObjects } from "../application/status-query.js";
import type { ActiveSession } from "./active-session.js";

export interface CompleteS3SetupResult {
  target: string;
  verified: boolean;
}

export interface SessionS3SetupDependencies {
  configurationWriter: {
    configureAndSelectS3(target: S3TargetConfig): Promise<void>;
  };
  s3TargetDraftValidator: S3TargetDraftValidator;
  draftReplicationTargetId(target: S3TargetConfig): string;
  defaultS3Region(): string;
  createReplicationService(
    storageRoot: string,
    target: S3TargetConfig,
  ): ReplicationApplicationService;
}

/** Interactive S3 draft verification and activation for one session runtime. */
export class SessionS3SetupController {
  constructor(
    private readonly session: ActiveSession,
    private readonly dependencies: SessionS3SetupDependencies,
    private readonly exclusion: () => MaintenanceExclusion,
    private readonly assertCurrent: (operation: string) => void,
    private readonly activate: (target: S3TargetConfig) => Promise<void>,
  ) {}

  initial(): S3SetupInitial {
    if (!this.session.config || !this.session.globalConfigPath) {
      throw new Error("Session Hoarder configuration is unavailable.");
    }
    return setupDraftFromTarget(
      this.session.config.s3,
      this.session.globalConfigPath,
      this.dependencies.defaultS3Region(),
    );
  }

  async prepare(draft: S3SetupDraft): Promise<S3SetupPreview> {
    if (!this.session.config) throw new Error("Session Hoarder configuration is unavailable.");
    const target = this.dependencies.s3TargetDraftValidator.validate(draft);
    if (!this.session.coordinator) {
      throw new Error(this.session.initializationError ?? "Session Hoarder is disabled.");
    }
    await this.session.coordinator.flush("s3-setup-preview");
    this.assertCurrent("before S3 setup could continue.");
    if (!this.session.record)
      throw new Error("No committed local checkpoint is available for S3 setup.");
    const objects = uniqueObjects(this.session.record);
    return {
      target: structuredClone(target),
      objectCount: objects.length,
      encodedBytes: objects.reduce((total, object) => total + object.storedBytes, 0),
      endpointDisplay: sanitizedEndpointDisplay(target.endpoint),
      profileDisplay: sanitizedProfileDisplay(target.profile),
    };
  }

  async complete(
    preview: S3SetupPreview,
    choice: Exclude<S3SetupChoice, "cancel">,
  ): Promise<CompleteS3SetupResult> {
    if (!this.session.config || !this.session.record) {
      throw new Error("Session Hoarder configuration or local checkpoint is unavailable.");
    }
    const target = this.dependencies.s3TargetDraftValidator.validate({
      ...preview.target,
      endpoint: preview.target.endpoint ?? "",
      profile: preview.target.profile ?? "",
    });
    const verified = choice === "upload-and-save";
    if (verified) await this.verify(target);
    this.assertCurrent("before S3 setup could be saved.");
    await this.dependencies.configurationWriter.configureAndSelectS3(target);
    this.assertCurrent("before S3 setup could be activated.");
    await this.activate(target);
    return { target: `s3:${target.targetId}`, verified };
  }

  private async verify(target: S3TargetConfig): Promise<void> {
    const draft = { ...target, targetId: this.dependencies.draftReplicationTargetId(target) };
    const service = this.dependencies.createReplicationService(
      this.session.config!.storageRoot,
      draft,
    );
    let failure: string | undefined;
    try {
      const result = await this.exclusion().runActivity(() =>
        service.sync({
          targetId: draft.targetId,
          repositoryId: this.session.repository.repositoryId,
          sessionId: this.session.sessionId,
        }),
      );
      if (!result || result.record.revision < this.session.record!.revision) {
        failure = "draft target verification did not cover the current local revision";
      }
    } catch (error) {
      failure = categorizeS3SetupError(error);
    }
    if (failure) throw new Error(`S3 target verification failed: ${failure}.`);
  }
}
