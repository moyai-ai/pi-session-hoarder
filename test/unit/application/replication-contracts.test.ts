import type {
  ReplicationUnitOfWork,
  SessionReplicaRepository,
} from "../../../src/application/replication-ports.js";
import { SessionReplica, type ReplicaIdentity } from "../../../src/domain/replica.js";
import { replicaObjectRepositoryContract } from "../../contracts/replica-object-repository.contract.js";
import { replicationUnitOfWorkContract } from "../../contracts/replication-unit-of-work.contract.js";
import { MemoryRemoteObjects, replicaObjectFixture } from "../../support/memory-replication.js";

class MemoryReplicaRepository implements SessionReplicaRepository {
  staged?: SessionReplica;

  constructor(private readonly stored: Map<string, SessionReplica>) {}

  async get(identity: ReplicaIdentity): Promise<SessionReplica | undefined> {
    const replica = this.stored.get(identityKey(identity));
    return replica?.record ? SessionReplica.rehydrate(replica.record) : undefined;
  }

  add(replica: SessionReplica): void {
    this.staged = replica;
  }

  clear(): void {
    this.staged = undefined;
  }
}

class MemoryReplicationUnitOfWork implements ReplicationUnitOfWork {
  readonly replicas: MemoryReplicaRepository;
  private committed = false;
  private disposed = false;
  private readonly stored: Map<string, SessionReplica>;

  constructor(
    stored: Map<string, SessionReplica>,
    readonly objects: MemoryRemoteObjects,
  ) {
    this.replicas = new MemoryReplicaRepository(stored);
    this.stored = stored;
  }

  async commit(signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    signal?.throwIfAborted();
    const staged = this.replicas.staged;
    if (!staged?.record) throw new Error("replication Unit of Work requires one staged replica");
    for (const receipt of staged.record.objects) {
      if (!(await this.objects.verifyTrustedReceipt(receipt.object, receipt, signal)).valid) {
        throw new Error(
          `Replica cannot reference unverified remote object ${receipt.object.digest}.`,
        );
      }
    }
    this.stored.set(identityKey(staged.identity), SessionReplica.rehydrate(staged.record));
    this.replicas.clear();
    this.committed = true;
  }

  async rollback(): Promise<void> {
    if (!this.disposed) this.replicas.clear();
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

replicaObjectRepositoryContract("MemoryRemoteObjects", async () => {
  const fixture = replicaObjectFixture();
  return {
    repository: new MemoryRemoteObjects(),
    object: fixture.object,
    payload: fixture.payload,
  };
});

replicationUnitOfWorkContract("MemoryReplicationUnitOfWork", async () => {
  const fixture = replicaObjectFixture();
  const objects = new MemoryRemoteObjects();
  const stored = new Map<string, SessionReplica>();
  const identity = { targetId: "backup", repositoryId: "repo", sessionId: "session" };
  return {
    identity,
    object: fixture.object,
    payload: fixture.payload,
    create: () => new MemoryReplicationUnitOfWork(stored, objects),
    read: async (value) => {
      const replica = stored.get(identityKey(value));
      return replica?.record ? SessionReplica.rehydrate(replica.record) : undefined;
    },
    removeRemote: async (digest) => {
      objects.objects.delete(digest);
    },
  };
});

function identityKey(identity: ReplicaIdentity): string {
  return `${identity.targetId}\0${identity.repositoryId}\0${identity.sessionId}`;
}
