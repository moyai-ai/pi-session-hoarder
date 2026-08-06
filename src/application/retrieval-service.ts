import { sameObjectReference, type ObjectReference } from "../domain/model.js";
import type { RemoteObjectReceipt } from "../domain/replica.js";
import type { MaintenanceExclusion } from "./maintenance-exclusion.js";
import type {
  LocalHydrationStore,
  RemoteObjectRetriever,
  RetrievalConfirmation,
} from "./retrieval-ports.js";

export interface HydrateObjectCommand {
  object: ObjectReference;
  receipt: RemoteObjectReceipt;
}

export interface HydrateObjectResult {
  hydrated: boolean;
  alreadyLocal: boolean;
  declined: boolean;
}

export interface RetrievalDependencies {
  local: LocalHydrationStore;
  remote: RemoteObjectRetriever;
  confirmation: RetrievalConfirmation;
  confirmationThresholdBytes: number;
  exclusion: MaintenanceExclusion;
}

/** Explicit-demand, concurrency-convergent lazy hydration. */
export class RetrievalApplicationService {
  private readonly inFlight = new Map<string, Promise<HydrateObjectResult>>();

  constructor(private readonly dependencies: RetrievalDependencies) {}

  hydrate(command: HydrateObjectCommand, signal?: AbortSignal): Promise<HydrateObjectResult> {
    signal?.throwIfAborted();
    assertReceipt(command.object, command.receipt);
    const existing = this.inFlight.get(command.object.digest);
    if (existing) return existing;
    const operation = this.dependencies.exclusion
      .runActivity(() => this.hydrateOnce(command, signal), signal)
      .finally(() => {
        if (this.inFlight.get(command.object.digest) === operation) {
          this.inFlight.delete(command.object.digest);
        }
      });
    this.inFlight.set(command.object.digest, operation);
    return operation;
  }

  private async hydrateOnce(
    command: HydrateObjectCommand,
    signal?: AbortSignal,
  ): Promise<HydrateObjectResult> {
    if (await this.dependencies.local.has(command.object.digest)) {
      return { hydrated: false, alreadyLocal: true, declined: false };
    }
    if (command.object.storedBytes > this.dependencies.confirmationThresholdBytes) {
      const confirmed = await this.dependencies.confirmation.confirm({
        objectCount: 1,
        encodedBytes: command.object.storedBytes,
      });
      if (!confirmed) return { hydrated: false, alreadyLocal: false, declined: true };
    }
    signal?.throwIfAborted();
    const payload = await this.dependencies.remote.retrieve(
      command.object,
      command.receipt,
      signal,
    );
    await this.dependencies.local.install(command.object, payload, signal);
    return { hydrated: true, alreadyLocal: false, declined: false };
  }
}

function assertReceipt(object: ObjectReference, receipt: RemoteObjectReceipt): void {
  if (!sameObjectReference(object, receipt.object)) {
    throw new Error(`Remote retrieval receipt does not match object ${object.digest}.`);
  }
}
