import type {
  ReplicaObjectRepository,
  ReplicationUnitOfWork,
  ReplicationUnitOfWorkFactory,
} from "../../application/replication-ports.js";
import { ExplicitCommitState } from "./explicit-commit-state.js";
import {
  LocalSessionReplicaRepository,
  type LocalReplicaRepositoryDependencies,
} from "./local-session-replica-repository.js";

/**
 * Remote objects may be written early; the local verified replica record becomes visible only
 * after explicit commit confirms every receipt still verifies at the target.
 */
export class LocalReplicationUnitOfWork implements ReplicationUnitOfWork {
  private readonly state = new ExplicitCommitState();

  constructor(
    readonly replicas: LocalSessionReplicaRepository,
    readonly objects: ReplicaObjectRepository,
  ) {}

  async commit(signal?: AbortSignal): Promise<void> {
    this.state.assertOpen();
    signal?.throwIfAborted();
    const staged = this.replicas.staged();
    const record = staged?.record;
    if (!staged || !record) {
      throw new Error("A replication Unit of Work must commit exactly one replica aggregate.");
    }
    for (const receipt of record.objects) {
      const verification = await this.objects.verifyTrustedReceipt(receipt.object, receipt, signal);
      if (!verification.valid) {
        throw new Error(
          `Replica cannot reference unverified remote object ${receipt.object.digest}.`,
        );
      }
    }
    await this.replicas.persist(staged);
    this.replicas.clear();
    this.state.markCommitted();
  }

  rollback(): Promise<void> {
    return this.state.rollback(() => this.replicas.clear());
  }

  dispose(): Promise<void> {
    return this.state.dispose(() => this.rollback());
  }
}

export class LocalReplicationUnitOfWorkFactory implements ReplicationUnitOfWorkFactory {
  private readonly storageRoot: string;
  private readonly createObjects: (targetId: string) => ReplicaObjectRepository;
  private readonly repositoryDependencies: Partial<LocalReplicaRepositoryDependencies>;

  constructor(
    storageRoot: string,
    createObjects: (targetId: string) => ReplicaObjectRepository,
    repositoryDependencies: Partial<LocalReplicaRepositoryDependencies> = {},
  ) {
    this.storageRoot = storageRoot;
    this.createObjects = createObjects;
    this.repositoryDependencies = repositoryDependencies;
  }

  create(targetId: string): ReplicationUnitOfWork {
    return new LocalReplicationUnitOfWork(
      new LocalSessionReplicaRepository(this.storageRoot, this.repositoryDependencies),
      this.createObjects(targetId),
    );
  }
}
