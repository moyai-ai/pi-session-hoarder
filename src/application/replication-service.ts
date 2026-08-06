import {
  sameObjectReference,
  type ObjectReference,
  type SessionArchiveRecord,
} from "../domain/model.js";
import {
  SessionReplica,
  type RemoteObjectReceipt,
  type SessionReplicaRecord,
} from "../domain/replica.js";
import type {
  RemoteObjectObservation,
  ReplicationApplicationDependencies,
  ReplicationUnitOfWork,
} from "./replication-ports.js";

export interface ReplicateSessionCommand {
  targetId: string;
  repositoryId: string;
  sessionId: string;
}

export interface ReplicateSessionResult {
  changed: boolean;
  record: SessionReplicaRecord;
}

/** Application service for publishing one committed local archive revision to a remote target. */
export class ReplicationApplicationService {
  private readonly dependencies: ReplicationApplicationDependencies;

  constructor(dependencies: ReplicationApplicationDependencies) {
    this.dependencies = dependencies;
  }

  async sync(
    command: ReplicateSessionCommand,
    signal?: AbortSignal,
  ): Promise<ReplicateSessionResult | undefined> {
    signal?.throwIfAborted();
    const archive = await this.dependencies.archives.get({
      repositoryId: command.repositoryId,
      sessionId: command.sessionId,
    });
    const archiveRecord = archive?.record;
    if (!archive || !archiveRecord) return undefined;

    const uow = this.dependencies.unitOfWorkFactory.create(command.targetId);
    let operationFailed = false;
    try {
      const identity = {
        targetId: command.targetId,
        repositoryId: command.repositoryId,
        sessionId: command.sessionId,
      };
      const replica = (await uow.replicas.get(identity)) ?? SessionReplica.create(identity);
      if (replica.coversRevision(archiveRecord.revision)) {
        await uow.rollback();
        return { changed: false, record: replica.record! };
      }

      const receipts = await this.replicateObjects(
        uniqueReferencedObjects(archiveRecord),
        replica.record?.objects ?? [],
        uow,
        signal,
      );
      const record = replica.recordVerifiedRevision({
        revision: archiveRecord.revision,
        objects: receipts,
        verifiedAt: this.dependencies.clock.now().toISOString(),
      });
      uow.replicas.add(replica);
      await uow.commit(signal);
      return { changed: true, record };
    } catch (error) {
      operationFailed = true;
      await uow.rollback();
      throw error;
    } finally {
      await disposeUnitOfWork(uow, operationFailed);
    }
  }

  private async replicateObjects(
    objects: readonly ObjectReference[],
    trustedReceipts: readonly RemoteObjectReceipt[],
    uow: ReplicationUnitOfWork,
    signal?: AbortSignal,
  ): Promise<RemoteObjectReceipt[]> {
    const receipts: RemoteObjectReceipt[] = [];
    for (const object of objects) {
      signal?.throwIfAborted();
      receipts.push(await this.replicateObject(object, trustedReceipts, uow, signal));
    }
    return receipts;
  }

  private async replicateObject(
    object: ObjectReference,
    trustedReceipts: readonly RemoteObjectReceipt[],
    uow: ReplicationUnitOfWork,
    signal?: AbortSignal,
  ): Promise<RemoteObjectReceipt> {
    await this.assertLocalVerified(object, signal);

    const trusted = trustedReceipts.find(
      (receipt) =>
        sameObjectReference(object, receipt.object) && uow.objects.matches(object, receipt),
    );
    if (trusted) {
      const verification = await uow.objects.verifyTrustedReceipt(object, trusted, signal);
      if (verification.valid) return trusted;
    }

    const observation = await uow.objects.inspect(object, signal);
    if (observation.state === "untrusted-present") {
      return this.verifyUntrusted(object, observation, uow, signal);
    }

    const payload = await this.dependencies.source.openEncoded(object, signal);
    if (payload.contentLength !== object.storedBytes) {
      throw new Error(
        `Encoded object size mismatch for ${object.digest}: expected ${object.storedBytes}, received ${payload.contentLength}.`,
      );
    }
    const result = await uow.objects.put({ object, ...payload }, signal);
    if (result.state === "conflict") {
      if (result.observation.state !== "untrusted-present") {
        throw new Error(`Remote upload conflict disappeared for ${object.digest}.`);
      }
      return this.verifyUntrusted(object, result.observation, uow, signal);
    }
    await assertTrustedReceiptVerified(uow, object, result.receipt, signal, "uploaded");
    return result.receipt;
  }

  private async assertLocalVerified(object: ObjectReference, signal?: AbortSignal): Promise<void> {
    const local = await this.dependencies.source.verifyLogical(object, signal);
    if (
      !local.valid ||
      local.digest !== object.digest ||
      local.logicalBytes !== object.logicalBytes
    ) {
      throw new Error(`Local object verification failed for ${object.digest}.`);
    }
  }

  private async verifyUntrusted(
    object: ObjectReference,
    observation: Extract<RemoteObjectObservation, { state: "untrusted-present" }>,
    uow: ReplicationUnitOfWork,
    signal?: AbortSignal,
  ): Promise<RemoteObjectReceipt> {
    const payload = await uow.objects.retrieveUntrusted(object, observation, signal);
    const verification = await this.dependencies.verifier.verify(object, payload, signal);
    if (!verification.valid) {
      throw new Error(`Remote untrusted object verification failed for ${object.digest}.`);
    }
    return {
      object: structuredClone(object),
      key: payload.key,
      ...(payload.etag ? { etag: payload.etag } : {}),
      ...(payload.versionId ? { versionId: payload.versionId } : {}),
      ...(payload.checksumSha256 ? { checksumSha256: payload.checksumSha256 } : {}),
    };
  }
}

async function assertTrustedReceiptVerified(
  uow: ReplicationUnitOfWork,
  object: ObjectReference,
  receipt: RemoteObjectReceipt,
  signal: AbortSignal | undefined,
  source: "uploaded",
): Promise<void> {
  if (!sameObjectReference(object, receipt.object) || !uow.objects.matches(object, receipt)) {
    throw new Error(`Remote ${source} receipt does not match object ${object.digest}.`);
  }
  const verification = await uow.objects.verifyTrustedReceipt(object, receipt, signal);
  if (!verification.valid) {
    throw new Error(`Remote ${source} object verification failed for ${object.digest}.`);
  }
}

function uniqueReferencedObjects(record: SessionArchiveRecord): readonly ObjectReference[] {
  const objects = new Map<string, ObjectReference>();
  for (const object of [
    record.sessionObject,
    ...record.artifacts.flatMap((artifact) => (artifact.object ? [artifact.object] : [])),
  ]) {
    const existing = objects.get(object.digest);
    if (existing && !sameObjectReference(existing, object)) {
      throw new Error(`Archive contains conflicting metadata for object ${object.digest}.`);
    }
    objects.set(object.digest, object);
  }
  return [...objects.values()];
}

async function disposeUnitOfWork(
  uow: ReplicationUnitOfWork,
  suppressErrors: boolean,
): Promise<void> {
  try {
    await uow.dispose();
  } catch (error) {
    if (!suppressErrors) throw error;
  }
}
