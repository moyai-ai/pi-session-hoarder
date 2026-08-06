import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { LocalCasHydrationStore } from "../../src/adapters/filesystem/local-hydration-store.js";
import { LocalFileObjectStore } from "../../src/adapters/filesystem/local-object-store.js";
import { LocalReplicationUnitOfWork } from "../../src/adapters/filesystem/local-replication-unit-of-work.js";
import { LocalSessionReplicaRepository } from "../../src/adapters/filesystem/local-session-replica-repository.js";
import { StreamingEncodedObjectVerifier } from "../../src/adapters/filesystem/streaming-encoded-object-verifier.js";
import {
  createLazyAwsS3ClientFactory,
  type S3ClientBoundaryFactory,
} from "../../src/adapters/s3/s3-client.js";
import { S3ReplicaObjectRepository } from "../../src/adapters/s3/s3-replica-object-repository.js";
import type {
  EncodedObjectPayload,
  ReplicaObjectRepository,
} from "../../src/application/replication-ports.js";
import { RetrievalApplicationService } from "../../src/application/retrieval-service.js";
import { SerializedMaintenanceExclusion } from "../../src/application/maintenance-exclusion.js";
import { createPruneApplication } from "../../src/bootstrap.js";
import type { ObjectReference } from "../../src/domain/model.js";
import { SessionReplica, type RemoteObjectReceipt } from "../../src/domain/replica.js";
import { replicaObjectRepositoryContract } from "../contracts/replica-object-repository.contract.js";
import { replicationUnitOfWorkContract } from "../contracts/replication-unit-of-work.contract.js";
import {
  createMinioEnvironment,
  headObject,
  largeFixture,
  MINIO_IMAGE,
  MINIO_PASSWORD,
  MINIO_USERNAME,
  type MinioTestEnvironment,
  overwriteObject,
  reconnectMinioEnvironment,
  smallFixture,
  waitForMinio,
} from "./minio-support.js";

let container: StartedMinioContainer;
let environment: MinioTestEnvironment;
let sequence = 0;
let temporaryRoot: string;
const originalAwsEnvironment = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  metadataDisabled: process.env.AWS_EC2_METADATA_DISABLED,
};

beforeAll(async () => {
  process.env.AWS_ACCESS_KEY_ID = MINIO_USERNAME;
  process.env.AWS_SECRET_ACCESS_KEY = MINIO_PASSWORD;
  process.env.AWS_EC2_METADATA_DISABLED = "true";
  temporaryRoot = await mkdtemp(join(tmpdir(), "session-hoarder-minio-"));
  container = await new MinioContainer(MINIO_IMAGE)
    .withUsername(MINIO_USERNAME)
    .withPassword(MINIO_PASSWORD)
    .withStartupTimeout(120_000)
    .start();
  environment = await createMinioEnvironment(container);
});

afterAll(async () => {
  environment?.rawClient.destroy();
  if (container) await container.stop();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  restoreEnvironment("AWS_ACCESS_KEY_ID", originalAwsEnvironment.accessKeyId);
  restoreEnvironment("AWS_SECRET_ACCESS_KEY", originalAwsEnvironment.secretAccessKey);
  restoreEnvironment("AWS_EC2_METADATA_DISABLED", originalAwsEnvironment.metadataDisabled);
});

replicaObjectRepositoryContract("MinIO S3ReplicaObjectRepository", async () => {
  const prefix = nextPrefix("object-contract");
  const fixture = smallFixture(Buffer.from(`contract-${prefix}`));
  return {
    repository: repository(prefix),
    object: fixture.object,
    payload: fixture.payload,
  };
});

replicationUnitOfWorkContract("MinIO LocalReplicationUnitOfWork", async () => {
  const prefix = nextPrefix("uow-contract");
  const fixture = smallFixture(Buffer.from(`uow-${prefix}`));
  const storageRoot = join(temporaryRoot, prefix);
  const identity = {
    targetId: "minio",
    repositoryId: `repository-${sequence}`,
    sessionId: `session-${sequence}`,
  };
  return {
    identity,
    object: fixture.object,
    payload: fixture.payload,
    create: () =>
      new LocalReplicationUnitOfWork(
        new LocalSessionReplicaRepository(storageRoot),
        repository(prefix),
      ),
    read: (value) => new LocalSessionReplicaRepository(storageRoot).get(value),
    removeRemote: (digest) => environment.remove(prefix, digest),
  };
});

describe("MinIO S3 compatibility", () => {
  it.each([
    ["empty", Buffer.alloc(0)],
    ["text", Buffer.from("Pi Session Hoarder remote durability")],
    ["binary", deterministicBinary(2 * 1024 * 1024)],
  ])("round-trips %s encoded objects with SHA-256 and metadata", async (_name, logical) => {
    const prefix = nextPrefix("round-trip");
    const fixture = smallFixture(logical);
    const objects = repository(prefix);

    const receipt = await putReceipt(objects, fixture.object, fixture.payload());
    const remote = await headObject(environment, receipt.key);

    expect(remote.ContentLength).toBe(fixture.object.storedBytes);
    expect(remote.ChecksumSHA256).toBe(fixture.payload().checksumSha256);
    expect(remote.Metadata).toMatchObject({
      "hoarder-logical-sha256": fixture.object.digest,
      "hoarder-encoding": "gzip",
    });
    await expect(objects.verifyTrustedReceipt(fixture.object, receipt)).resolves.toEqual({
      valid: true,
    });
  });

  it("logically verifies untrusted pre-existing objects instead of trusting HEAD metadata", async () => {
    const prefix = nextPrefix("untrusted-correctness");
    const fixture = smallFixture(Buffer.from("untrusted remote correctness path"));
    const objects = repository(prefix);
    const receipt = await putReceipt(objects, fixture.object, fixture.payload());
    const observation = await objects.inspect(fixture.object);
    if (observation.state !== "untrusted-present") throw new Error("expected remote object");
    const verifier = new StreamingEncodedObjectVerifier();

    await expect(
      verifier.verify(fixture.object, await objects.retrieveUntrusted(fixture.object, observation)),
    ).resolves.toEqual({ valid: true });

    const corrupted = await encodedBytes(fixture.payload());
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    await overwriteObject(environment, receipt.key, corrupted);
    const corruptedObservation = await objects.inspect(fixture.object);
    if (corruptedObservation.state !== "untrusted-present") {
      throw new Error("expected corrupted remote object");
    }
    await expect(
      verifier.verify(
        fixture.object,
        await objects.retrieveUntrusted(fixture.object, corruptedObservation),
      ),
    ).resolves.toEqual({ valid: false });
  });

  it("cancels streamed logical verification of an untrusted GET", async () => {
    const prefix = nextPrefix("untrusted-cancel");
    const fixture = smallFixture(deterministicBinary(2 * 1024 * 1024));
    const objects = repository(prefix);
    await putReceipt(objects, fixture.object, fixture.payload());
    const observation = await objects.inspect(fixture.object);
    if (observation.state !== "untrusted-present") throw new Error("expected remote object");
    const payload = await objects.retrieveUntrusted(fixture.object, observation);
    const controller = new AbortController();

    await expect(
      new StreamingEncodedObjectVerifier().verify(
        fixture.object,
        { ...payload, body: abortAfterFirstChunk(payload.body, controller) },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const retryObservation = await objects.inspect(fixture.object);
    if (retryObservation.state !== "untrusted-present") {
      throw new Error("expected remote object after cancelled GET");
    }
    await expect(
      new StreamingEncodedObjectVerifier().verify(
        fixture.object,
        await objects.retrieveUntrusted(fixture.object, retryObservation),
      ),
    ).resolves.toEqual({ valid: true });
  });

  it("converges concurrent conditional PutObject requests", async () => {
    const prefix = nextPrefix("concurrent");
    const fixture = smallFixture(deterministicBinary(4 * 1024 * 1024));
    let conditionalConflicts = 0;
    const config = environment.target(prefix);
    const baseFactory = createLazyAwsS3ClientFactory(config);
    const observedFactory: S3ClientBoundaryFactory = async () => {
      const client = await baseFactory();
      return {
        headObject: (input, signal) => client.headObject(input, signal),
        getObject: (input, signal) => client.getObject!(input, signal),
        putObject: async (input, signal) => {
          try {
            return await client.putObject(input, signal);
          } catch (error) {
            if (isConditionalConflict(error)) conditionalConflicts += 1;
            throw error;
          }
        },
      };
    };
    const objects = new S3ReplicaObjectRepository(config, observedFactory);

    const [left, right] = await Promise.all([
      objects.put({ object: fixture.object, ...fixture.payload() }),
      objects.put({ object: fixture.object, ...fixture.payload() }),
    ]);

    expect([left.state, right.state].sort()).toEqual(["conflict", "uploaded"]);
    expect(conditionalConflicts).toBeGreaterThanOrEqual(1);
    const uploaded =
      left.state === "uploaded"
        ? left.receipt
        : right.state === "uploaded"
          ? right.receipt
          : undefined;
    expect(uploaded).toBeDefined();
    await expect(objects.verifyTrustedReceipt(fixture.object, uploaded!)).resolves.toEqual({
      valid: true,
    });
    const conflict =
      left.state === "conflict" ? left : right.state === "conflict" ? right : undefined;
    expect(conflict?.observation.state).toBe("untrusted-present");
    if (!conflict || conflict.observation.state !== "untrusted-present") {
      throw new Error("expected conditional conflict observation");
    }
    await expect(
      new StreamingEncodedObjectVerifier().verify(
        fixture.object,
        await objects.retrieveUntrusted(fixture.object, conflict.observation),
      ),
    ).resolves.toEqual({ valid: true });
  });

  it("cancels a 50 MiB streaming upload without publishing a partial object", async () => {
    const prefix = nextPrefix("cancel-large");
    const fixture = await largeFixture(join(temporaryRoot, prefix));
    expect(fixture.object.logicalBytes).toBe(50 * 1024 * 1024);
    expect(fixture.object.storedBytes).toBeGreaterThan(49 * 1024 * 1024);
    const objects = repository(prefix);
    const controller = new AbortController();
    const payload = fixture.payload();

    await expect(
      objects.put(
        {
          object: fixture.object,
          ...payload,
          body: abortAfterFirstChunk(payload.body, controller),
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(objects.inspect(fixture.object)).resolves.toEqual({ state: "absent" });

    const receipt = await putReceipt(objects, fixture.object, fixture.payload());
    await expect(objects.verifyTrustedReceipt(fixture.object, receipt)).resolves.toEqual({
      valid: true,
    });
    const observation = await objects.inspect(fixture.object);
    if (observation.state !== "untrusted-present") throw new Error("expected large remote object");
    await expect(
      new StreamingEncodedObjectVerifier().verify(
        fixture.object,
        await objects.retrieveUntrusted(fixture.object, observation),
      ),
    ).resolves.toEqual({ valid: true });
  }, 120_000);

  it("lazily retrieves, verifies, and installs exactly one demanded object", async () => {
    const prefix = nextPrefix("retrieval");
    const fixture = smallFixture(Buffer.from("explicit remote retrieval"));
    const remote = repository(prefix) as S3ReplicaObjectRepository;
    const receipt = await putReceipt(remote, fixture.object, fixture.payload());
    const localObjects = new LocalFileObjectStore(join(temporaryRoot, `${prefix}-local`));
    const confirm = vi.fn(async () => true);
    const service = new RetrievalApplicationService({
      local: new LocalCasHydrationStore(localObjects),
      remote,
      confirmation: { confirm },
      confirmationThresholdBytes: 1,
      exclusion: new SerializedMaintenanceExclusion(),
    });

    await expect(service.hydrate({ object: fixture.object, receipt })).resolves.toMatchObject({
      hydrated: true,
    });
    await expect(localObjects.verify(fixture.object)).resolves.toMatchObject({ valid: true });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("prunes only durable remote-backed CAS bytes and hydrates them again", async () => {
    const prefix = nextPrefix("prune-recovery");
    const storageRoot = join(temporaryRoot, `${prefix}-local`);
    const fixture = smallFixture(Buffer.from("prune and recover through MinIO"));
    const remote = repository(prefix) as S3ReplicaObjectRepository;
    const receipt = await putReceipt(remote, fixture.object, fixture.payload());
    const localObjects = new LocalFileObjectStore(storageRoot);
    const localPath = localObjects.objectPath(fixture.object.digest);
    await mkdir(join(storageRoot, "objects", "sha256"), { recursive: true });
    const chunks: Buffer[] = [];
    for await (const chunk of fixture.payload().body) chunks.push(Buffer.from(chunk));
    await writeFile(localPath, Buffer.concat(chunks));
    const replica = SessionReplica.create({
      targetId: "minio",
      repositoryId: "repo",
      sessionId: "session",
    });
    replica.recordVerifiedRevision({
      revision: 1,
      objects: [receipt],
      verifiedAt: "2026-08-06T12:00:00.000Z",
    });
    await new LocalSessionReplicaRepository(storageRoot).persist(replica);
    const exclusion = new SerializedMaintenanceExclusion();
    const prune = createPruneApplication(storageRoot, environment.target(prefix), exclusion);

    await expect(prune.prune("minio", { confirm: async () => true })).resolves.toMatchObject({
      eligibleObjects: 1,
      removedObjects: 1,
      failedObjects: 0,
    });
    await expect(localObjects.has(fixture.object.digest)).resolves.toBe(false);
    await expect(remote.verifyTrustedReceipt(fixture.object, receipt)).resolves.toEqual({
      valid: true,
    });

    const retrieval = new RetrievalApplicationService({
      local: new LocalCasHydrationStore(localObjects),
      remote,
      confirmation: { confirm: async () => true },
      confirmationThresholdBytes: Number.MAX_SAFE_INTEGER,
      exclusion,
    });
    await retrieval.hydrate({ object: fixture.object, receipt });
    await expect(localObjects.verify(fixture.object)).resolves.toMatchObject({ valid: true });
  });

  it("detects out-of-band corruption instead of trusting a stale receipt", async () => {
    const prefix = nextPrefix("corruption");
    const fixture = smallFixture(Buffer.from("original immutable bytes"));
    const objects = repository(prefix);
    const receipt = await putReceipt(objects, fixture.object, fixture.payload());

    await overwriteObject(environment, receipt.key, Buffer.from("corrupt"));

    await expect(objects.verifyTrustedReceipt(fixture.object, receipt)).resolves.toEqual({
      valid: false,
    });
  });

  it("re-verifies durable receipts after the MinIO container restarts", async () => {
    const prefix = nextPrefix("restart");
    const fixture = smallFixture(Buffer.from("survives service restart"));
    const objects = repository(prefix);
    const receipt = await putReceipt(objects, fixture.object, fixture.payload());

    const bucket = environment.bucket;
    environment.rawClient.destroy();
    await container.restart({ timeout: 30_000 });
    environment = reconnectMinioEnvironment(container, bucket);
    await waitForMinio(environment.endpoint);
    const recoveredObjects = repository(prefix);

    await expect(recoveredObjects.verifyTrustedReceipt(fixture.object, receipt)).resolves.toEqual({
      valid: true,
    });
    await expect(recoveredObjects.inspect(fixture.object)).resolves.toMatchObject({
      state: "untrusted-present",
      key: receipt.key,
    });
  }, 120_000);
});

async function encodedBytes(payload: EncodedObjectPayload): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of payload.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function putReceipt(
  objects: ReplicaObjectRepository,
  object: ObjectReference,
  payload: EncodedObjectPayload,
): Promise<RemoteObjectReceipt> {
  const result = await objects.put({ object, ...payload });
  if (result.state !== "uploaded") throw new Error("expected fresh remote upload");
  return result.receipt;
}

function repository(prefix: string): ReplicaObjectRepository {
  const config = environment.target(prefix);
  return new S3ReplicaObjectRepository(config, createLazyAwsS3ClientFactory(config));
}

function nextPrefix(label: string): string {
  sequence += 1;
  return `step-6/${label}-${sequence}`;
}

function deterministicBinary(size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let state = 0x12345678;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

async function* abortAfterFirstChunk(
  body: AsyncIterable<Uint8Array>,
  controller: AbortController,
): AsyncGenerator<Uint8Array> {
  let first = true;
  for await (const chunk of body) {
    if (!first) controller.abort();
    first = false;
    yield chunk;
  }
}

function isConditionalConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    value.$metadata?.httpStatusCode === 409 ||
    value.$metadata?.httpStatusCode === 412 ||
    value.name === "ConditionalRequestConflict" ||
    value.name === "PreconditionFailed"
  );
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
