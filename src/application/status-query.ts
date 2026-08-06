import {
  sameObjectReference,
  type ObjectReference,
  type SessionArchiveRecord,
} from "../domain/model.js";
import type { ReplicaIdentity, SessionReplica } from "../domain/replica.js";
import type { HoarderConfig } from "./configuration.js";
import type { SessionArchiveReader } from "./replication-ports.js";

export type DurableStatusTarget = "local" | `s3:${string}`;
export type LazyRetrievalStatus = "enabled" | "unavailable" | "off";

export interface HoarderDurableStatus {
  archive?: SessionArchiveRecord;
  localRevision?: number;
  publishedRevision?: number;
  target: DurableStatusTarget;
  referencedObjects: number;
  localObjects: number;
  remoteVerifiedObjects: number;
  remoteOnlyObjects: number;
  remoteOnlyStoredBytes: number;
  lazyRetrieval: LazyRetrievalStatus;
  warnings: readonly string[];
}

export interface HoarderStatusQueryCommand {
  repositoryId: string;
  sessionId: string;
  config: HoarderConfig;
}

export interface HoarderStatusQuery {
  read(command: HoarderStatusQueryCommand): Promise<HoarderDurableStatus>;
}

export interface StatusSessionReplicaReader {
  get(identity: ReplicaIdentity): Promise<SessionReplica | undefined>;
}

export interface StatusLocalObjectPresence {
  has(digest: string): Promise<boolean>;
}

export interface HoarderStatusQueryDependencies {
  archives: SessionArchiveReader;
  replicas: StatusSessionReplicaReader;
  local: StatusLocalObjectPresence;
}

/** Builds a bounded, local-only status view from committed archive and replica state. */
export class LocalHoarderStatusQuery implements HoarderStatusQuery {
  constructor(private readonly dependencies: HoarderStatusQueryDependencies) {}

  async read(command: HoarderStatusQueryCommand): Promise<HoarderDurableStatus> {
    const warnings: string[] = [];
    const archive = await this.readArchive(command, warnings);
    const objects = archive ? uniqueObjects(archive) : [];
    const localPresence = await this.readLocalPresence(objects, warnings);
    const replica = await this.readReplica(command, warnings);
    const trustedReplica = reconcileReplica(archive, replica, warnings);
    const remoteDigests = trustedReplica
      ? matchingRemoteDigests(objects, trustedReplica.record?.objects ?? [])
      : new Set<string>();
    const remoteOnly = objects.filter(
      (object, index) => localPresence[index] === false && remoteDigests.has(object.digest),
    );

    return {
      ...(archive ? { archive: structuredClone(archive), localRevision: archive.revision } : {}),
      ...publishedRevision(command.config, archive, trustedReplica),
      target: targetLabel(command.config),
      referencedObjects: objects.length,
      localObjects: localPresence.filter((present) => present === true).length,
      remoteVerifiedObjects: remoteDigests.size,
      remoteOnlyObjects: remoteOnly.length,
      remoteOnlyStoredBytes: remoteOnly.reduce((total, object) => total + object.storedBytes, 0),
      lazyRetrieval: lazyRetrieval(command.config),
      warnings,
    };
  }

  private async readArchive(
    command: HoarderStatusQueryCommand,
    warnings: string[],
  ): Promise<SessionArchiveRecord | undefined> {
    try {
      return (
        await this.dependencies.archives.get({
          repositoryId: command.repositoryId,
          sessionId: command.sessionId,
        })
      )?.record;
    } catch {
      warnings.push("The durable local archive record is invalid or unavailable.");
      return undefined;
    }
  }

  private async readReplica(
    command: HoarderStatusQueryCommand,
    warnings: string[],
  ): Promise<SessionReplica | undefined> {
    if (command.config.storageTarget !== "s3" || !command.config.s3) return undefined;
    try {
      return await this.dependencies.replicas.get({
        targetId: command.config.s3.targetId,
        repositoryId: command.repositoryId,
        sessionId: command.sessionId,
      });
    } catch {
      warnings.push("The selected-target replica record is invalid or unavailable.");
      return undefined;
    }
  }

  private async readLocalPresence(
    objects: readonly ObjectReference[],
    warnings: string[],
  ): Promise<readonly (boolean | undefined)[]> {
    const results = await Promise.allSettled(
      objects.map((object) => this.dependencies.local.has(object.digest)),
    );
    if (results.some((result) => result.status === "rejected")) {
      warnings.push("Some local object presence checks could not be completed.");
    }
    return results.map((result) => (result.status === "fulfilled" ? result.value : undefined));
  }
}

function reconcileReplica(
  archive: SessionArchiveRecord | undefined,
  replica: SessionReplica | undefined,
  warnings: string[],
): SessionReplica | undefined {
  const record = replica?.record;
  if (!record) return undefined;
  if (!archive) {
    warnings.push("A selected-target replica exists without a readable local archive record.");
    return undefined;
  }
  if (record.revision > archive.revision) {
    warnings.push("The selected-target replica is ahead of the local archive and was ignored.");
    return undefined;
  }
  if (record.revision === archive.revision && !replicaExactlyCovers(archive, record.objects)) {
    warnings.push("The selected-target replica does not exactly cover the current local revision.");
    return undefined;
  }
  return replica;
}

function replicaExactlyCovers(
  archive: SessionArchiveRecord,
  receipts: NonNullable<SessionReplica["record"]>["objects"],
): boolean {
  const objects = uniqueObjects(archive);
  return (
    receipts.length === objects.length &&
    objects.every((object) =>
      receipts.some((receipt) => sameObjectReference(object, receipt.object)),
    )
  );
}

function matchingRemoteDigests(
  objects: readonly ObjectReference[],
  receipts: NonNullable<SessionReplica["record"]>["objects"],
): Set<string> {
  return new Set(
    objects
      .filter((object) => receipts.some((receipt) => sameObjectReference(object, receipt.object)))
      .map((object) => object.digest),
  );
}

function publishedRevision(
  config: HoarderConfig,
  archive: SessionArchiveRecord | undefined,
  replica: SessionReplica | undefined,
): { publishedRevision?: number } {
  if (config.storageTarget === "local") {
    return archive ? { publishedRevision: archive.revision } : {};
  }
  const revision = replica?.record?.revision;
  return revision === undefined ? {} : { publishedRevision: revision };
}

function targetLabel(config: HoarderConfig): DurableStatusTarget {
  if (config.storageTarget === "local") return "local";
  return config.s3 ? `s3:${config.s3.targetId}` : "s3:unconfigured";
}

function lazyRetrieval(config: HoarderConfig): LazyRetrievalStatus {
  if (config.storageTarget === "local") return "off";
  return config.s3 ? "enabled" : "unavailable";
}

export function uniqueObjects(record: SessionArchiveRecord): readonly ObjectReference[] {
  const objects = new Map<string, ObjectReference>();
  objects.set(record.sessionObject.digest, record.sessionObject);
  for (const artifact of record.artifacts) {
    if (artifact.object) objects.set(artifact.object.digest, artifact.object);
  }
  return [...objects.values()].map((object) => structuredClone(object));
}
