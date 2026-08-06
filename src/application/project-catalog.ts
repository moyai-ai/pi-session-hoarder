import type { S3TargetConfig, StorageTarget } from "./configuration.js";
import type { SessionArchiveRecord, ObjectReference, ArtifactRelation } from "../domain/model.js";
import type { RemoteObjectReceipt, ReplicaIdentity, SessionReplica } from "../domain/replica.js";
import type { RemoteReceiptPolicy } from "./prune-ports.js";

export interface GitObservation {
  worktreeRoot: string;
  head?: string;
  branch?: string;
  detached: boolean;
  dirty: boolean;
}

export interface GitWorktreeInspector {
  inspect(cwd: string): Promise<GitObservation | undefined>;
}

export type ProjectObjectLocation =
  | { kind: "local-cas" }
  | {
      kind: "s3";
      targetId: string;
      bucket: string;
      region: string;
      key: string;
      etag?: string;
      versionId?: string;
      checksumSha256?: string;
    };

export interface ProjectObjectReference extends ObjectReference {
  locations: readonly ProjectObjectLocation[];
}

export interface ProjectArtifactRelation extends Omit<ArtifactRelation, "object" | "warning"> {
  object?: ProjectObjectReference;
}

export interface ProjectSessionCatalog {
  schemaVersion: 2;
  repositoryId: string;
  sessionId: string;
  revision: number;
  capturedAt: string;
  git: Omit<GitObservation, "worktreeRoot">;
  sessionObject: ProjectObjectReference;
  artifacts: readonly ProjectArtifactRelation[];
}

export interface ProjectCatalogWriter {
  write(worktreeRoot: string, sessionId: string, catalog: ProjectSessionCatalog): Promise<string>;
}

export interface LocalObjectPresence {
  has(digest: string): Promise<boolean>;
}

export interface SessionReplicaReader {
  get(identity: ReplicaIdentity): Promise<SessionReplica | undefined>;
}

export interface ProjectCatalogDependencies {
  git: GitWorktreeInspector;
  writer: ProjectCatalogWriter;
  local: LocalObjectPresence;
  replicas: SessionReplicaReader;
  remotePolicy?: RemoteReceiptPolicy;
}

export interface PublishProjectCatalogCommand {
  cwd: string;
  trusted: boolean;
  archive: SessionArchiveRecord;
  storageTarget: StorageTarget;
  s3?: S3TargetConfig;
}

export interface PublishProjectCatalogResult {
  revision: number;
  path: string;
}

export class ProjectCatalogApplicationService {
  constructor(private readonly dependencies: ProjectCatalogDependencies) {}

  async publish(command: PublishProjectCatalogCommand): Promise<PublishProjectCatalogResult> {
    if (!command.trusted)
      throw new Error("Project catalog publication requires a trusted project.");
    const git = await this.dependencies.git.inspect(command.cwd);
    if (!git) throw new Error("Project catalog publication requires a Git worktree.");
    const remote = await this.loadRemoteContext(command);
    const catalog = await this.buildCatalog(command.archive, git, remote, command.storageTarget);
    const path = await this.dependencies.writer.write(
      git.worktreeRoot,
      command.archive.sessionId,
      catalog,
    );
    return { revision: command.archive.revision, path };
  }

  private async loadRemoteContext(command: PublishProjectCatalogCommand): Promise<RemoteContext> {
    if (!command.s3) return {};
    const replica = await this.dependencies.replicas.get({
      targetId: command.s3.targetId,
      repositoryId: command.archive.repositoryId,
      sessionId: command.archive.sessionId,
    });
    if (command.storageTarget === "s3" && replica?.revision !== command.archive.revision) {
      throw new Error(
        `Project catalog revision ${command.archive.revision} requires a matching verified S3 replica.`,
      );
    }
    return { target: command.s3, replica };
  }

  private async buildCatalog(
    archive: SessionArchiveRecord,
    git: GitObservation,
    remote: RemoteContext,
    selectedTarget: StorageTarget,
  ): Promise<ProjectSessionCatalog> {
    const sessionObject = await this.projectObject(archive.sessionObject, remote, selectedTarget);
    const artifacts = await Promise.all(
      archive.artifacts.map((artifact) => this.projectArtifact(artifact, remote, selectedTarget)),
    );
    const { worktreeRoot: _privatePath, ...safeGit } = git;
    return {
      schemaVersion: 2,
      repositoryId: archive.repositoryId,
      sessionId: archive.sessionId,
      revision: archive.revision,
      capturedAt: archive.capturedAt,
      git: safeGit,
      sessionObject,
      artifacts,
    };
  }

  private async projectArtifact(
    artifact: ArtifactRelation,
    remote: RemoteContext,
    selectedTarget: StorageTarget,
  ): Promise<ProjectArtifactRelation> {
    return {
      kind: artifact.kind,
      sourceEntryId: artifact.sourceEntryId,
      sourceField: artifact.sourceField,
      sourceState: artifact.sourceState,
      archiveState: artifact.archiveState,
      ...(artifact.object
        ? { object: await this.projectObject(artifact.object, remote, selectedTarget) }
        : {}),
    };
  }

  private async projectObject(
    object: ObjectReference,
    remote: RemoteContext,
    selectedTarget: StorageTarget,
  ): Promise<ProjectObjectReference> {
    const locations: ProjectObjectLocation[] = [];
    if (await this.dependencies.local.has(object.digest)) locations.push({ kind: "local-cas" });
    const receipt = findReceipt(object, remote.replica, this.dependencies.remotePolicy);
    if (receipt && remote.target) locations.push(remoteLocation(remote.target, receipt));
    if (
      selectedTarget === "local" &&
      !locations.some((location) => location.kind === "local-cas")
    ) {
      throw new Error(`Local project catalog object is unavailable: ${object.digest}.`);
    }
    if (selectedTarget === "s3" && !locations.some((location) => location.kind === "s3")) {
      throw new Error(`Verified S3 project catalog object is unavailable: ${object.digest}.`);
    }
    return { ...object, locations };
  }
}

interface RemoteContext {
  target?: S3TargetConfig;
  replica?: SessionReplica;
}

function findReceipt(
  object: ObjectReference,
  replica: SessionReplica | undefined,
  policy: RemoteReceiptPolicy | undefined,
): RemoteObjectReceipt | undefined {
  return replica?.record?.objects.find(
    (receipt) => receipt.object.digest === object.digest && policy?.matches(object, receipt),
  );
}

function remoteLocation(
  target: S3TargetConfig,
  receipt: RemoteObjectReceipt,
): Extract<ProjectObjectLocation, { kind: "s3" }> {
  return {
    kind: "s3",
    targetId: target.targetId,
    bucket: target.bucket,
    region: target.region,
    key: receipt.key,
    ...(receipt.etag ? { etag: receipt.etag } : {}),
    ...(receipt.versionId ? { versionId: receipt.versionId } : {}),
    ...(receipt.checksumSha256 ? { checksumSha256: receipt.checksumSha256 } : {}),
  };
}
