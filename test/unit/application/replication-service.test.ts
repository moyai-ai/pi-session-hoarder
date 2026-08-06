import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ReplicationApplicationService } from "../../../src/application/replication-service.js";
import type {
  EncodedObjectPayload,
  EncodedObjectSource,
  RemoteObjectObservation,
  RemoteObjectPutResult,
  ReplicaObjectRepository,
  ReplicationUnitOfWork,
  ReplicationUnitOfWorkFactory,
  SessionArchiveReader,
  SessionReplicaRepository,
} from "../../../src/application/replication-ports.js";
import { SessionArchive, type ObjectReference } from "../../../src/domain/model.js";
import {
  SessionReplica,
  type RemoteObjectReceipt,
  type ReplicaIdentity,
} from "../../../src/domain/replica.js";
import { Failpoints } from "../../support/failpoints.js";

class FakeArchiveReader implements SessionArchiveReader {
  archive?: SessionArchive;

  async get(): Promise<SessionArchive | undefined> {
    return this.archive;
  }
}

class FakeEncodedSource implements EncodedObjectSource {
  readonly bytes = new Map<string, Uint8Array>();
  invalid = new Set<string>();

  constructor(private readonly failpoints: Failpoints) {}

  add(object: ObjectReference, contents = `encoded:${object.digest}`): void {
    this.bytes.set(object.digest, Buffer.from(contents));
  }

  async verifyLogical(object: ObjectReference) {
    this.failpoints.hit(`source:verify:${object.digest}`);
    return {
      valid: !this.invalid.has(object.digest),
      digest: object.digest,
      logicalBytes: object.logicalBytes,
    };
  }

  async openEncoded(object: ObjectReference): Promise<EncodedObjectPayload> {
    this.failpoints.hit(`source:open:${object.digest}`);
    const bytes = this.bytes.get(object.digest);
    if (!bytes) throw new Error(`missing encoded source ${object.digest}`);
    return {
      contentLength: bytes.byteLength,
      checksumSha256: createHash("sha256").update(bytes).digest("base64"),
      body: (async function* () {
        yield bytes;
      })(),
    };
  }
}

class FakeRemoteObjects implements ReplicaObjectRepository {
  readonly receipts = new Map<string, RemoteObjectReceipt>();
  readonly puts: string[] = [];
  readonly retrievals: string[] = [];
  invalid = new Set<string>();
  conflicts = new Set<string>();

  constructor(private readonly failpoints: Failpoints) {}

  async inspect(object: ObjectReference): Promise<RemoteObjectObservation> {
    this.failpoints.hit(`remote:inspect:${object.digest}`);
    const receipt = this.receipts.get(object.digest);
    return receipt
      ? {
          state: "untrusted-present",
          key: receipt.key,
          metadata: { contentLength: object.storedBytes },
        }
      : { state: "absent" };
  }

  async put(input: {
    object: ObjectReference;
    contentLength: number;
    checksumSha256: string;
    body: AsyncIterable<Uint8Array>;
  }): Promise<RemoteObjectPutResult> {
    this.failpoints.hit(`remote:put:${input.object.digest}`);
    let bytes = 0;
    for await (const chunk of input.body) bytes += chunk.byteLength;
    if (bytes !== input.contentLength) throw new Error("stream length mismatch");
    const receipt = remoteReceipt(input.object);
    this.receipts.set(input.object.digest, receipt);
    this.puts.push(input.object.digest);
    if (this.conflicts.has(input.object.digest)) {
      return {
        state: "conflict",
        observation: {
          state: "untrusted-present",
          key: receipt.key,
          metadata: { contentLength: input.object.storedBytes },
        },
      };
    }
    return { state: "uploaded", receipt };
  }

  async verifyTrustedReceipt(object: ObjectReference): Promise<{ valid: boolean }> {
    this.failpoints.hit(`remote:verify:${object.digest}`);
    return { valid: !this.invalid.has(object.digest) && this.receipts.has(object.digest) };
  }

  async retrieveUntrusted(
    object: ObjectReference,
    observation: Extract<RemoteObjectObservation, { state: "untrusted-present" }>,
  ) {
    this.failpoints.hit(`remote:retrieve:${object.digest}`);
    this.retrievals.push(object.digest);
    return {
      key: observation.key,
      contentLength: object.storedBytes,
      body: (async function* () {
        yield Buffer.alloc(object.storedBytes);
      })(),
    };
  }

  matches(object: ObjectReference, receipt: RemoteObjectReceipt): boolean {
    return receipt.object.digest === object.digest && receipt.key === remoteReceipt(object).key;
  }
}

class FakeEncodedVerifier {
  invalid = new Set<string>();

  async verify(object: ObjectReference): Promise<{ valid: boolean }> {
    return { valid: !this.invalid.has(object.digest) };
  }
}

class FakeReplicaRepository implements SessionReplicaRepository {
  stored?: SessionReplica;
  staged?: SessionReplica;

  async get(_identity: ReplicaIdentity): Promise<SessionReplica | undefined> {
    return this.stored;
  }

  add(replica: SessionReplica): void {
    this.staged = replica;
  }
}

class FakeReplicationUnitOfWork implements ReplicationUnitOfWork {
  committed = false;
  rolledBack = false;
  disposed = false;

  constructor(
    readonly replicas: FakeReplicaRepository,
    readonly objects: FakeRemoteObjects,
    private readonly failpoints: Failpoints,
  ) {}

  async commit(): Promise<void> {
    this.failpoints.hit("uow:commit");
    if (!this.replicas.staged) throw new Error("nothing staged");
    this.replicas.stored = this.replicas.staged;
    this.replicas.staged = undefined;
    this.committed = true;
  }

  async rollback(): Promise<void> {
    this.replicas.staged = undefined;
    this.rolledBack = true;
  }

  async dispose(): Promise<void> {
    this.failpoints.hit("uow:dispose");
    this.disposed = true;
  }
}

class FakeReplicationUnitOfWorkFactory implements ReplicationUnitOfWorkFactory {
  readonly replicas = new FakeReplicaRepository();
  readonly objects: FakeRemoteObjects;
  readonly created: FakeReplicationUnitOfWork[] = [];

  constructor(private readonly failpoints: Failpoints) {
    this.objects = new FakeRemoteObjects(failpoints);
  }

  create(): ReplicationUnitOfWork {
    const uow = new FakeReplicationUnitOfWork(this.replicas, this.objects, this.failpoints);
    this.created.push(uow);
    return uow;
  }
}

function object(contents: string): ObjectReference {
  const digest = createHash("sha256").update(contents).digest("hex");
  return {
    algorithm: "sha256",
    digest,
    encoding: "gzip",
    logicalBytes: contents.length,
    storedBytes: Buffer.byteLength(`encoded:${digest}`),
  };
}

function archiveWith(
  sessionObject: ObjectReference,
  artifactObject?: ObjectReference,
): SessionArchive {
  const archive = SessionArchive.create({ repositoryId: "repo", sessionId: "session" });
  archive.recordCheckpoint({
    source: { size: sessionObject.logicalBytes, mtimeMs: 1, sha256: sessionObject.digest },
    sessionObject,
    artifacts: artifactObject
      ? [
          {
            kind: "pi-bash-full-output",
            sourceEntryId: "artifact-one",
            sourceField: "message.details.fullOutputPath",
            sourceState: "present",
            archiveState: "captured",
            object: artifactObject,
          },
          {
            kind: "pi-bash-full-output",
            sourceEntryId: "artifact-two",
            sourceField: "message.details.fullOutputPath",
            sourceState: "present",
            archiveState: "captured",
            object: artifactObject,
          },
        ]
      : [],
    capturedAt: "2026-08-05T12:00:00.000Z",
    lastVerifiedAt: "2026-08-05T12:00:00.000Z",
  });
  return archive;
}

function remoteReceipt(value: ObjectReference): RemoteObjectReceipt {
  return {
    object: structuredClone(value),
    key: `session-hoarder/objects/sha256/${value.digest}.gz`,
    etag: `etag-${value.digest.slice(0, 8)}`,
  };
}

function setup() {
  const failpoints = new Failpoints();
  const archives = new FakeArchiveReader();
  const source = new FakeEncodedSource(failpoints);
  const verifier = new FakeEncodedVerifier();
  const unitOfWorkFactory = new FakeReplicationUnitOfWorkFactory(failpoints);
  const service = new ReplicationApplicationService({
    archives,
    source,
    verifier,
    unitOfWorkFactory,
    clock: { now: () => new Date("2026-08-05T13:00:00.000Z") },
  });
  return { service, archives, source, verifier, unitOfWorkFactory, failpoints };
}

const command = { targetId: "backup", repositoryId: "repo", sessionId: "session" };

describe("ReplicationApplicationService", () => {
  it("uploads unique objects, verifies them, and commits one replica aggregate", async () => {
    const context = setup();
    const session = object("session");
    const artifact = object("artifact");
    context.archives.archive = archiveWith(session, artifact);
    context.source.add(session);
    context.source.add(artifact);

    const result = await context.service.sync(command);

    expect(result).toMatchObject({ changed: true, record: { revision: 1 } });
    expect(context.unitOfWorkFactory.objects.puts).toEqual([session.digest, artifact.digest]);
    expect(result?.record.objects).toHaveLength(2);
    expect(context.unitOfWorkFactory.created[0]).toMatchObject({
      committed: true,
      disposed: true,
    });
  });

  it("logically verifies an untrusted pre-existing remote object without uploading", async () => {
    const context = setup();
    const session = object("session");
    context.archives.archive = archiveWith(session);
    context.source.add(session);
    context.unitOfWorkFactory.objects.receipts.set(session.digest, remoteReceipt(session));

    const result = await context.service.sync(command);

    expect(result?.changed).toBe(true);
    expect(context.unitOfWorkFactory.objects.puts).toEqual([]);
    expect(context.unitOfWorkFactory.objects.retrievals).toEqual([session.digest]);
  });

  it("uses the trusted receipt fast path only for an exact durable prior receipt", async () => {
    const context = setup();
    const session = object("trusted-session");
    const archive = archiveWith(session);
    const previous = archive.record!;
    archive.recordCheckpoint({
      source: { ...previous.source, mtimeMs: 2 },
      sessionObject: previous.sessionObject,
      artifacts: previous.artifacts,
      capturedAt: "2026-08-05T12:01:00.000Z",
      lastVerifiedAt: "2026-08-05T12:01:00.000Z",
    });
    context.archives.archive = archive;
    context.source.add(session);
    const receipt = remoteReceipt(session);
    context.unitOfWorkFactory.objects.receipts.set(session.digest, receipt);
    const replica = SessionReplica.create(command);
    replica.recordVerifiedRevision({
      revision: 1,
      objects: [receipt],
      verifiedAt: "2026-08-05T12:30:00.000Z",
    });
    context.unitOfWorkFactory.replicas.stored = replica;

    const result = await context.service.sync(command);

    expect(result?.record.revision).toBe(2);
    expect(context.unitOfWorkFactory.objects.retrievals).toEqual([]);
    expect(context.unitOfWorkFactory.objects.puts).toEqual([]);
  });

  it("carries an exact trusted receipt for a preserved remote-only artifact into a new revision", async () => {
    const context = setup();
    const session = object("current-session");
    const artifact = object("remote-only-artifact");
    const archive = archiveWith(session, artifact);
    archive.recordCheckpoint({
      source: { size: session.logicalBytes, mtimeMs: 2, sha256: session.digest },
      sessionObject: session,
      artifacts: [
        {
          kind: "pi-bash-full-output",
          sourceEntryId: "artifact-one",
          sourceField: "message.details.fullOutputPath",
          sourceState: "missing",
          archiveState: "captured",
          object: artifact,
          warning: "source disappeared",
        },
      ],
      capturedAt: "2026-08-05T12:01:00.000Z",
      lastVerifiedAt: "2026-08-05T12:01:00.000Z",
    });
    context.archives.archive = archive;
    context.source.add(session);
    const receipts = [session, artifact].map(remoteReceipt);
    for (const receipt of receipts) {
      context.unitOfWorkFactory.objects.receipts.set(receipt.object.digest, receipt);
    }
    const replica = SessionReplica.create(command);
    replica.recordVerifiedRevision({
      revision: 1,
      objects: receipts,
      verifiedAt: "2026-08-05T12:30:00.000Z",
    });
    context.unitOfWorkFactory.replicas.stored = replica;
    context.failpoints.arm(`source:verify:${artifact.digest}`);

    const result = await context.service.sync(command);

    expect(result?.record).toMatchObject({ revision: 2, objects: receipts });
    expect(context.unitOfWorkFactory.objects.puts).toEqual([]);
    expect(context.unitOfWorkFactory.objects.retrievals).toEqual([]);
  });

  it("uses the verified remote receipt as durability truth even when local bytes are corrupt", async () => {
    const context = setup();
    const session = object("trusted-over-corrupt-local");
    const archive = archiveWith(session);
    archive.recordCheckpoint({
      source: { size: session.logicalBytes, mtimeMs: 2, sha256: session.digest },
      sessionObject: session,
      artifacts: [],
      capturedAt: "2026-08-05T12:01:00.000Z",
      lastVerifiedAt: "2026-08-05T12:01:00.000Z",
    });
    context.archives.archive = archive;
    context.source.add(session);
    context.source.invalid.add(session.digest);
    const receipt = remoteReceipt(session);
    context.unitOfWorkFactory.objects.receipts.set(session.digest, receipt);
    const replica = SessionReplica.create(command);
    replica.recordVerifiedRevision({
      revision: 1,
      objects: [receipt],
      verifiedAt: "2026-08-05T12:30:00.000Z",
    });
    context.unitOfWorkFactory.replicas.stored = replica;

    await expect(context.service.sync(command)).resolves.toMatchObject({
      changed: true,
      record: { revision: 2, objects: [receipt] },
    });
  });

  it("does not let a stale unrelated durable receipt authorize another object", async () => {
    const context = setup();
    const session = object("current-session");
    const unrelated = object("unrelated-session");
    const archive = archiveWith(session);
    const previous = archive.record!;
    archive.recordCheckpoint({
      source: { ...previous.source, mtimeMs: 2 },
      sessionObject: previous.sessionObject,
      artifacts: previous.artifacts,
      capturedAt: "2026-08-05T12:01:00.000Z",
      lastVerifiedAt: "2026-08-05T12:01:00.000Z",
    });
    context.archives.archive = archive;
    context.source.add(session);
    context.unitOfWorkFactory.objects.receipts.set(session.digest, remoteReceipt(session));
    const replica = SessionReplica.create(command);
    replica.recordVerifiedRevision({
      revision: 1,
      objects: [remoteReceipt(unrelated)],
      verifiedAt: "2026-08-05T12:30:00.000Z",
    });
    context.unitOfWorkFactory.replicas.stored = replica;

    await context.service.sync(command);

    expect(context.unitOfWorkFactory.objects.retrievals).toEqual([session.digest]);
  });

  it("returns a safe no-op when the same revision is already verified", async () => {
    const context = setup();
    const session = object("session");
    context.archives.archive = archiveWith(session);
    const replica = SessionReplica.create(command);
    replica.recordVerifiedRevision({
      revision: 1,
      objects: [remoteReceipt(session)],
      verifiedAt: "2026-08-05T12:30:00.000Z",
    });
    context.unitOfWorkFactory.replicas.stored = replica;

    const result = await context.service.sync(command);

    expect(result).toEqual({ changed: false, record: replica.record });
    expect(context.unitOfWorkFactory.created[0]).toMatchObject({
      rolledBack: true,
      committed: false,
      disposed: true,
    });
  });

  it("does not create a Unit of Work when no committed local archive exists", async () => {
    const context = setup();

    await expect(context.service.sync(command)).resolves.toBeUndefined();
    expect(context.unitOfWorkFactory.created).toEqual([]);
  });

  it("rolls back publication after failures at every remote workflow phase", async () => {
    for (const phase of [
      "source:verify",
      "remote:inspect",
      "source:open",
      "remote:put",
      "remote:verify",
      "uow:commit",
    ]) {
      const context = setup();
      const session = object(phase);
      context.archives.archive = archiveWith(session);
      context.source.add(session);
      context.failpoints.arm(phase === "uow:commit" ? phase : `${phase}:${session.digest}`);

      await expect(context.service.sync(command)).rejects.toThrow("Injected failure");
      expect(context.unitOfWorkFactory.created[0]).toMatchObject({
        rolledBack: true,
        committed: false,
        disposed: true,
      });
      expect(context.unitOfWorkFactory.replicas.stored).toBeUndefined();
    }
  });

  it("rejects invalid local and remote verification", async () => {
    const localFailure = setup();
    const localObject = object("local-invalid");
    localFailure.archives.archive = archiveWith(localObject);
    localFailure.source.add(localObject);
    localFailure.source.invalid.add(localObject.digest);

    await expect(localFailure.service.sync(command)).rejects.toThrow(
      "Local object verification failed",
    );

    const remoteFailure = setup();
    const remoteObject = object("remote-invalid");
    remoteFailure.archives.archive = archiveWith(remoteObject);
    remoteFailure.source.add(remoteObject);
    remoteFailure.unitOfWorkFactory.objects.invalid.add(remoteObject.digest);

    await expect(remoteFailure.service.sync(command)).rejects.toThrow(
      "Remote uploaded object verification failed",
    );
  });

  it("publishes no receipt when untrusted logical verification fails", async () => {
    const context = setup();
    const session = object("forged-metadata");
    context.archives.archive = archiveWith(session);
    context.source.add(session);
    context.unitOfWorkFactory.objects.receipts.set(session.digest, remoteReceipt(session));
    context.verifier.invalid.add(session.digest);

    await expect(context.service.sync(command)).rejects.toThrow(
      "Remote untrusted object verification failed",
    );
    expect(context.unitOfWorkFactory.replicas.stored).toBeUndefined();
    expect(context.unitOfWorkFactory.created[0]).toMatchObject({
      rolledBack: true,
      committed: false,
    });
  });

  it("follows a conditional upload conflict with untrusted GET verification", async () => {
    const context = setup();
    const session = object("conditional-conflict");
    context.archives.archive = archiveWith(session);
    context.source.add(session);
    context.unitOfWorkFactory.objects.conflicts.add(session.digest);

    await expect(context.service.sync(command)).resolves.toMatchObject({ changed: true });
    expect(context.unitOfWorkFactory.objects.puts).toEqual([session.digest]);
    expect(context.unitOfWorkFactory.objects.retrievals).toEqual([session.digest]);
  });

  it("re-verifies an uncommitted remote object after restart instead of trusting metadata", async () => {
    const context = setup();
    const session = object("interrupted-before-receipt-commit");
    context.archives.archive = archiveWith(session);
    context.source.add(session);
    context.failpoints.arm("uow:commit");

    await expect(context.service.sync(command)).rejects.toThrow("Injected failure");
    expect(context.unitOfWorkFactory.replicas.stored).toBeUndefined();
    context.failpoints.arm("disabled");

    await expect(context.service.sync(command)).resolves.toMatchObject({ changed: true });
    expect(context.unitOfWorkFactory.objects.retrievals).toEqual([session.digest]);
  });

  it("honors cancellation before replication starts", async () => {
    const context = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(context.service.sync(command, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(context.unitOfWorkFactory.created).toEqual([]);
  });

  it("disposes the Unit of Work after a workflow failure", async () => {
    const context = setup();
    const session = object("dispose-after-failure");
    context.archives.archive = archiveWith(session);
    context.source.add(session);
    context.failpoints.arm(`remote:put:${session.digest}`);

    await expect(context.service.sync(command)).rejects.toThrow("remote:put");
    expect(context.unitOfWorkFactory.created[0]?.disposed).toBe(true);
  });
});
