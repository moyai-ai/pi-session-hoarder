import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createConfigurationWriter, loadConfig } from "./adapters/config.js";
import { resolveRepositoryIdentity } from "./adapters/identity.js";
import { LocalGitWorktreeInspector } from "./adapters/git-worktree.js";
import { PiSessionArtifactDiscovery } from "./adapters/filesystem/artifact-discovery.js";
import { LocalEncodedObjectSource } from "./adapters/filesystem/local-encoded-object-source.js";
import { LocalCasCacheRepository } from "./adapters/filesystem/local-cache-repository.js";
import { LocalVerifiedReceiptReader } from "./adapters/filesystem/local-verified-receipt-reader.js";
import { WorktreeProjectCatalogRepository } from "./adapters/filesystem/project-catalog-repository.js";
import { LocalFileObjectStore } from "./adapters/filesystem/local-object-store.js";
import { LocalReplicationUnitOfWorkFactory } from "./adapters/filesystem/local-replication-unit-of-work.js";
import { LocalSessionArchiveRepository } from "./adapters/filesystem/local-session-archive-repository.js";
import { LocalSessionReplicaRepository } from "./adapters/filesystem/local-session-replica-repository.js";
import { LocalSessionSnapshotter } from "./adapters/filesystem/session-snapshotter.js";
import { StreamingEncodedObjectVerifier } from "./adapters/filesystem/streaming-encoded-object-verifier.js";
import { LocalCheckpointUnitOfWorkFactory } from "./adapters/filesystem/local-unit-of-work.js";
import { createLazyAwsS3ClientFactory } from "./adapters/s3/s3-client.js";
import { S3ReplicaObjectRepository } from "./adapters/s3/s3-replica-object-repository.js";
import { CheckpointCoordinator } from "./application/checkpoint-coordinator.js";
import { CheckpointApplicationService } from "./application/checkpoint-service.js";
import type { S3TargetConfig } from "./application/configuration.js";
import type { Clock } from "./application/ports.js";
import { ReplicationCoordinator } from "./application/replication-coordinator.js";
import { ReplicationApplicationService } from "./application/replication-service.js";
import { SerializedMaintenanceExclusion } from "./application/maintenance-exclusion.js";
import type { MaintenanceExclusion } from "./application/maintenance-exclusion.js";
import { PruneApplicationService } from "./application/prune-service.js";
import { ProjectCatalogApplicationService } from "./application/project-catalog.js";
import { registerHoarderCommands } from "./entrypoints/commands.js";
import { HoarderLifecycle } from "./entrypoints/lifecycle.js";

export interface LocalCheckpointApplication {
  service: CheckpointApplicationService;
  unitOfWorkFactory: LocalCheckpointUnitOfWorkFactory;
}

export function createLocalCheckpointApplication(
  storageRoot: string,
  clock: Clock = { now: () => new Date() },
): LocalCheckpointApplication {
  const unitOfWorkFactory = new LocalCheckpointUnitOfWorkFactory(storageRoot);
  return {
    unitOfWorkFactory,
    service: new CheckpointApplicationService({
      unitOfWorkFactory,
      snapshotter: new LocalSessionSnapshotter(join(storageRoot, "tmp")),
      artifactDiscovery: new PiSessionArtifactDiscovery(),
      clock,
    }),
  };
}

function createS3ReplicationApplication(
  storageRoot: string,
  target: S3TargetConfig,
  clock: Clock = { now: () => new Date() },
): ReplicationApplicationService {
  const localObjects = new LocalFileObjectStore(storageRoot);
  const remoteObjects = new S3ReplicaObjectRepository(target, createLazyAwsS3ClientFactory(target));
  return new ReplicationApplicationService({
    archives: new LocalSessionArchiveRepository(storageRoot),
    source: new LocalEncodedObjectSource(localObjects),
    verifier: new StreamingEncodedObjectVerifier(),
    unitOfWorkFactory: new LocalReplicationUnitOfWorkFactory(storageRoot, () => remoteObjects),
    clock,
  });
}

function createProjectCatalogApplication(
  storageRoot: string,
  target?: S3TargetConfig,
): ProjectCatalogApplicationService {
  const remote = target
    ? new S3ReplicaObjectRepository(target, createLazyAwsS3ClientFactory(target))
    : undefined;
  return new ProjectCatalogApplicationService({
    git: new LocalGitWorktreeInspector(),
    writer: new WorktreeProjectCatalogRepository(),
    local: new LocalFileObjectStore(storageRoot),
    replicas: new LocalSessionReplicaRepository(storageRoot),
    ...(remote ? { remotePolicy: remote } : {}),
  });
}

export function createPruneApplication(
  storageRoot: string,
  target: S3TargetConfig,
  exclusion: MaintenanceExclusion,
): PruneApplicationService {
  const remote = new S3ReplicaObjectRepository(target, createLazyAwsS3ClientFactory(target));
  return new PruneApplicationService({
    cache: new LocalCasCacheRepository(storageRoot),
    receipts: new LocalVerifiedReceiptReader(storageRoot),
    receiptPolicy: remote,
    exclusion,
  });
}

/** Composition root: the only place concrete adapters are wired to Pi entrypoints. */
export function bootstrapSessionHoarder(pi: ExtensionAPI): void {
  const maintenanceByRoot = new Map<string, SerializedMaintenanceExclusion>();
  const lifecycle = new HoarderLifecycle({
    loadConfiguration: loadConfig,
    resolveRepository: resolveRepositoryIdentity,
    createCheckpointService: (storageRoot) => createLocalCheckpointApplication(storageRoot).service,
    createCoordinator: (options) => new CheckpointCoordinator(options),
    createReplicationService: createS3ReplicationApplication,
    createReplicationCoordinator: (options) => new ReplicationCoordinator(options),
    createProjectCatalogService: createProjectCatalogApplication,
    gitWorktree: new LocalGitWorktreeInspector(),
    createMaintenanceExclusion: (storageRoot) => {
      const existing = maintenanceByRoot.get(storageRoot);
      if (existing) return existing;
      const created = new SerializedMaintenanceExclusion();
      maintenanceByRoot.set(storageRoot, created);
      return created;
    },
    createPruneService: createPruneApplication,
    configurationWriter: createConfigurationWriter(),
    uiScheduler: {
      setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    },
  });
  lifecycle.register(pi);
  registerHoarderCommands(pi, lifecycle);
}
