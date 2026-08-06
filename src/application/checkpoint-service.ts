import type { ArtifactRelation, SessionArchiveRecord, SessionIdentity } from "../domain/model.js";
import { artifactRelationKey, SessionArchive } from "../domain/model.js";
import type {
  ArtifactDiscovery,
  CheckpointUnitOfWork,
  CheckpointUnitOfWorkFactory,
  Clock,
  DiscoveredArtifact,
  ObjectStorePutResult,
  SessionSnapshotter,
} from "./ports.js";

export interface CheckpointSessionCommand extends SessionIdentity {
  sessionFile: string;
}

export interface CheckpointSessionResult {
  changed: boolean;
  record: SessionArchiveRecord;
}

export interface CheckpointApplicationDependencies {
  unitOfWorkFactory: CheckpointUnitOfWorkFactory;
  snapshotter: SessionSnapshotter;
  artifactDiscovery: ArtifactDiscovery;
  clock: Clock;
}

/** Application service for the checkpoint-session use case. */
export class CheckpointApplicationService {
  private readonly dependencies: CheckpointApplicationDependencies;

  constructor(dependencies: CheckpointApplicationDependencies) {
    this.dependencies = dependencies;
  }

  async checkpoint(
    command: CheckpointSessionCommand,
    signal?: AbortSignal,
  ): Promise<CheckpointSessionResult | undefined> {
    signal?.throwIfAborted();
    const uow = this.dependencies.unitOfWorkFactory.create();
    let snapshot: Awaited<ReturnType<SessionSnapshotter["capture"]>> | undefined;
    let operationFailed = false;

    try {
      const identity = {
        repositoryId: command.repositoryId,
        sessionId: command.sessionId,
      };
      const archive = (await uow.archives.get(identity)) ?? SessionArchive.create(identity);
      const boundary = await this.dependencies.snapshotter.inspect(command.sessionFile);
      if (!boundary) {
        await uow.rollback();
        return undefined;
      }
      if (archive.isSourceCurrent(boundary)) {
        await uow.rollback();
        return { changed: false, record: archive.record! };
      }

      snapshot = await this.dependencies.snapshotter.capture(command.sessionFile, boundary, signal);
      const discovered = await this.dependencies.artifactDiscovery.discover(snapshot.path);
      const sessionObject = await putVerified(uow, snapshot.path, signal);
      const artifacts = reconcileArtifacts(
        await captureArtifacts(uow, discovered, signal),
        archive.record?.artifacts ?? [],
      );

      const timestamp = this.dependencies.clock.now().toISOString();
      const record = archive.recordCheckpoint({
        source: {
          size: snapshot.size,
          mtimeMs: snapshot.mtimeMs,
          sha256: sessionObject.object.digest,
        },
        sessionObject: sessionObject.object,
        artifacts,
        capturedAt: timestamp,
        lastVerifiedAt: timestamp,
      });
      uow.archives.add(archive);
      await uow.commit();
      return { changed: true, record };
    } catch (error) {
      operationFailed = true;
      await uow.rollback();
      throw error;
    } finally {
      await disposeResources(snapshot, uow, operationFailed);
    }
  }
}

async function disposeResources(
  snapshot: Awaited<ReturnType<SessionSnapshotter["capture"]>> | undefined,
  uow: CheckpointUnitOfWork,
  suppressErrors: boolean,
): Promise<void> {
  const results = await Promise.allSettled([snapshot?.dispose(), uow.dispose()]);
  if (suppressErrors) return;
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

async function captureArtifacts(
  uow: CheckpointUnitOfWork,
  discovered: readonly DiscoveredArtifact[],
  signal?: AbortSignal,
): Promise<ArtifactRelation[]> {
  const objectPromises = new Map<string, Promise<ObjectStorePutResult>>();
  const relations: ArtifactRelation[] = [];
  for (const artifact of discovered) {
    relations.push(await captureArtifact(uow, artifact, objectPromises, signal));
  }
  return relations;
}

async function captureArtifact(
  uow: CheckpointUnitOfWork,
  artifact: DiscoveredArtifact,
  objectPromises: Map<string, Promise<ObjectStorePutResult>>,
  signal?: AbortSignal,
): Promise<ArtifactRelation> {
  if (!artifact.path) return structuredClone(artifact.relation);
  try {
    let objectPromise = objectPromises.get(artifact.path);
    if (!objectPromise) {
      objectPromise = putVerified(uow, artifact.path, signal);
      objectPromises.set(artifact.path, objectPromise);
    }
    const captured = await objectPromise;
    return {
      ...structuredClone(artifact.relation),
      sourceState: "present",
      archiveState: "captured",
      object: captured.object,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...structuredClone(artifact.relation),
      sourceState: "present",
      archiveState: "unavailable",
      object: undefined,
      warning: `Unable to capture Bash full output: ${errorMessage(error)}`,
    };
  }
}

function reconcileArtifacts(
  current: readonly ArtifactRelation[],
  previous: readonly ArtifactRelation[],
): ArtifactRelation[] {
  const previouslyCaptured = new Map(
    previous
      .filter(
        (
          relation,
        ): relation is ArtifactRelation & { object: NonNullable<ArtifactRelation["object"]> } =>
          relation.archiveState === "captured" && relation.object !== undefined,
      )
      .map((relation) => [artifactRelationKey(relation), relation]),
  );
  return current.map((relation) => {
    if (relation.archiveState === "captured") return structuredClone(relation);
    const prior = previouslyCaptured.get(artifactRelationKey(relation));
    return prior
      ? {
          ...structuredClone(relation),
          archiveState: "captured",
          object: structuredClone(prior.object),
        }
      : structuredClone(relation);
  });
}

async function putVerified(
  uow: CheckpointUnitOfWork,
  path: string,
  signal?: AbortSignal,
): Promise<ObjectStorePutResult> {
  const result = await uow.objects.putFile(path, signal);
  const verification = await uow.objects.verify(result.object, signal);
  if (!verification.valid) {
    throw new Error(`CAS verification failed for ${result.object.digest}.`);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
