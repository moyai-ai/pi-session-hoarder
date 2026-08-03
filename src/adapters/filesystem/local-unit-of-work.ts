import type {
  CheckpointUnitOfWork,
  CheckpointUnitOfWorkFactory,
  ObjectStore,
} from "../../application/ports.js";
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
  private committed = false;
  private disposed = false;

  constructor(archives: LocalSessionArchiveRepository, objects: ObjectStore) {
    this.archives = archives;
    this.objects = objects;
  }

  async commit(): Promise<void> {
    this.assertOpen();
    const staged = this.archives.staged();
    if (staged.length !== 1) {
      throw new Error(`A checkpoint Unit of Work must commit exactly one aggregate; received ${staged.length}.`);
    }
    const [archive] = staged;
    for (const object of archive!.referencedObjects()) {
      if (!(await this.objects.has(object.digest))) {
        throw new Error(`Archive cannot reference missing CAS object ${object.digest}.`);
      }
    }
    await this.archives.persist(archive!);
    this.archives.clear();
    this.committed = true;
  }

  async rollback(): Promise<void> {
    if (this.disposed) return;
    this.archives.clear();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (!this.committed) await this.rollback();
    this.disposed = true;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Unit of Work is already disposed.");
    if (this.committed) throw new Error("Unit of Work is already committed.");
  }
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
