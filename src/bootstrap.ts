import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./adapters/config.js";
import { resolveRepositoryIdentity } from "./adapters/identity.js";
import { PiSessionArtifactDiscovery } from "./adapters/filesystem/artifact-discovery.js";
import { LocalSessionSnapshotter } from "./adapters/filesystem/session-snapshotter.js";
import { LocalCheckpointUnitOfWorkFactory } from "./adapters/filesystem/local-unit-of-work.js";
import { CheckpointCoordinator } from "./application/checkpoint-coordinator.js";
import { CheckpointApplicationService } from "./application/checkpoint-service.js";
import type { Clock } from "./application/ports.js";
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

/** Composition root: the only place concrete adapters are wired to Pi entrypoints. */
export function bootstrapSessionHoarder(pi: ExtensionAPI): void {
  const lifecycle = new HoarderLifecycle({
    loadConfiguration: loadConfig,
    resolveRepository: resolveRepositoryIdentity,
    createCheckpointService: (storageRoot) =>
      createLocalCheckpointApplication(storageRoot).service,
    createCoordinator: (options) => new CheckpointCoordinator(options),
    uiScheduler: {
      setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    },
  });
  lifecycle.register(pi);
  registerHoarderCommands(pi, lifecycle);
}
