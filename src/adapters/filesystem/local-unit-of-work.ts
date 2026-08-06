import type {
  CheckpointUnitOfWork,
  CheckpointUnitOfWorkFactory,
  ObjectStore,
} from "../../application/ports.js";
import {
  artifactRelationKey,
  sameObjectReference,
  type ArtifactRelation,
  type SessionArchiveRecord,
} from "../../domain/model.js";
import { ExplicitCommitState } from "./explicit-commit-state.js";
import { LocalFileObjectStore } from "./local-object-store.js";
import {
  LocalSessionArchiveRepository,
  type LocalArchiveRepositoryDependencies,
} from "./local-session-archive-repository.js";

/**
 * Local UoW atomicity boundary: immutable objects may be written early, but exactly one
 * aggregate catalog becomes visible only on explicit commit. Rollback publishes nothing.
 */
export class LocalCheckpointUnitOfWork implements CheckpointUnitOfWork {
  readonly archives: LocalSessionArchiveRepository;
  readonly objects: ObjectStore;
  private readonly state = new ExplicitCommitState();

  constructor(archives: LocalSessionArchiveRepository, objects: ObjectStore) {
    this.archives = archives;
    this.objects = objects;
  }

  async commit(): Promise<void> {
    this.state.assertOpen();
    const staged = this.archives.staged();
    if (staged.length !== 1) {
      throw new Error(
        `A checkpoint Unit of Work must commit exactly one aggregate; received ${staged.length}.`,
      );
    }
    const [archive] = staged;
    const record = archive!.record!;
    // The coordinator is the single writer; this prior-record read intentionally identifies
    // exact artifact relations that may have become remote-only after their earlier commit.
    const previous = await this.archives.committedRecord(archive!.identity);
    await this.assertRequiredObjectsAvailable(record, previous);
    await this.archives.persist(archive!);
    this.archives.clear();
    this.state.markCommitted();
  }

  private async assertRequiredObjectsAvailable(
    record: SessionArchiveRecord,
    previous: SessionArchiveRecord | undefined,
  ): Promise<void> {
    if (!(await this.objects.has(record.sessionObject.digest))) {
      throw new Error(
        `Archive cannot reference missing CAS object ${record.sessionObject.digest}.`,
      );
    }
    for (const artifact of record.artifacts) {
      const object = artifact.object;
      if (!object || (await this.objects.has(object.digest))) continue;
      if (isPreservedArtifact(artifact, object, previous?.artifacts ?? [])) continue;
      throw new Error(`Archive cannot reference missing CAS object ${object.digest}.`);
    }
  }

  rollback(): Promise<void> {
    return this.state.rollback(() => this.archives.clear());
  }

  dispose(): Promise<void> {
    return this.state.dispose(() => this.rollback());
  }
}

function isPreservedArtifact(
  artifact: ArtifactRelation,
  object: NonNullable<ArtifactRelation["object"]>,
  previous: readonly ArtifactRelation[],
): boolean {
  const prior = previous.find(
    (candidate) => artifactRelationKey(candidate) === artifactRelationKey(artifact),
  );
  return Boolean(
    prior?.archiveState === "captured" && prior.object && sameObjectReference(prior.object, object),
  );
}

export class LocalCheckpointUnitOfWorkFactory implements CheckpointUnitOfWorkFactory {
  readonly objectStore: LocalFileObjectStore;
  private readonly storageRoot: string;
  private readonly repositoryDependencies: Partial<LocalArchiveRepositoryDependencies>;

  constructor(
    storageRoot: string,
    repositoryDependencies: Partial<LocalArchiveRepositoryDependencies> = {},
  ) {
    this.storageRoot = storageRoot;
    this.objectStore = new LocalFileObjectStore(storageRoot);
    this.repositoryDependencies = repositoryDependencies;
  }

  create(): CheckpointUnitOfWork {
    return new LocalCheckpointUnitOfWork(
      new LocalSessionArchiveRepository(this.storageRoot, this.repositoryDependencies),
      this.objectStore,
    );
  }
}
