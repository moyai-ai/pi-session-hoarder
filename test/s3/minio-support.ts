import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StartedMinioContainer } from "@testcontainers/minio";

import type { S3TargetConfig } from "../../src/application/configuration.js";
import type { EncodedObjectPayload } from "../../src/application/replication-ports.js";
import type { ObjectReference } from "../../src/domain/model.js";

export const MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z";
export const MINIO_USERNAME = "hoarder-test-access";
export const MINIO_PASSWORD = "hoarder-test-secret-key";

export interface EncodedFixture {
  object: ObjectReference;
  payload(): EncodedObjectPayload;
}

export interface MinioTestEnvironment {
  bucket: string;
  endpoint: string;
  rawClient: S3Client;
  target(prefix: string): S3TargetConfig;
  key(prefix: string, digest: string): string;
  remove(prefix: string, digest: string): Promise<void>;
}

export async function createMinioEnvironment(
  container: StartedMinioContainer,
): Promise<MinioTestEnvironment> {
  const endpoint = container.getConnectionUrl();
  const bucket = `hoarder-${Date.now().toString(36)}`;
  const rawClient = createRawClient(endpoint);
  await rawClient.send(new CreateBucketCommand({ Bucket: bucket }));
  return buildEnvironment(endpoint, bucket, rawClient);
}

export function reconnectMinioEnvironment(
  container: StartedMinioContainer,
  bucket: string,
): MinioTestEnvironment {
  const endpoint = container.getConnectionUrl();
  return buildEnvironment(endpoint, bucket, createRawClient(endpoint));
}

function buildEnvironment(
  endpoint: string,
  bucket: string,
  rawClient: S3Client,
): MinioTestEnvironment {
  return {
    bucket,
    endpoint,
    rawClient,
    target: (prefix) => ({
      targetId: "minio",
      bucket,
      region: "us-east-1",
      prefix,
      endpoint,
      forcePathStyle: true,
    }),
    key: (prefix, digest) => `${prefix}/objects/sha256/${digest}.gz`,
    remove: async (prefix, digest) => {
      await rawClient.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: `${prefix}/objects/sha256/${digest}.gz` }),
      );
    },
  };
}

function createRawClient(endpoint: string): S3Client {
  return new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: MINIO_USERNAME,
      secretAccessKey: MINIO_PASSWORD,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export function smallFixture(logical: Uint8Array): EncodedFixture {
  const encoded = gzipSync(logical);
  const object: ObjectReference = {
    algorithm: "sha256",
    digest: createHash("sha256").update(logical).digest("hex"),
    encoding: "gzip",
    logicalBytes: logical.byteLength,
    storedBytes: encoded.byteLength,
  };
  return {
    object,
    payload: () => ({
      contentLength: encoded.byteLength,
      checksumSha256: createHash("sha256").update(encoded).digest("base64"),
      body: (async function* () {
        yield encoded;
      })(),
    }),
  };
}

export async function largeFixture(
  temporaryRoot: string,
  logicalBytes = 50 * 1024 * 1024,
): Promise<EncodedFixture> {
  await mkdir(temporaryRoot, { recursive: true });
  const path = join(temporaryRoot, `large-${logicalBytes}.gz`);
  const logicalHash = createHash("sha256");
  await pipeline(
    Readable.from(deterministicBytes(logicalBytes, logicalHash)),
    createGzip({ level: 1 }),
    createWriteStream(path),
  );
  const metadata = await stat(path);
  const checksumSha256 = await fileChecksum(path);
  const object: ObjectReference = {
    algorithm: "sha256",
    digest: logicalHash.digest("hex"),
    encoding: "gzip",
    logicalBytes,
    storedBytes: metadata.size,
  };
  return {
    object,
    payload: () => ({
      contentLength: metadata.size,
      checksumSha256,
      body: createReadStream(path),
    }),
  };
}

export async function overwriteObject(
  environment: MinioTestEnvironment,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  await environment.rawClient.send(
    new PutObjectCommand({
      Bucket: environment.bucket,
      Key: key,
      Body: bytes,
      ContentLength: bytes.byteLength,
    }),
  );
}

export async function headObject(environment: MinioTestEnvironment, key: string) {
  return environment.rawClient.send(
    new HeadObjectCommand({
      Bucket: environment.bucket,
      Key: key,
      ChecksumMode: "ENABLED",
    }),
  );
}

export async function waitForMinio(endpoint: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/minio/health/live`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("MinIO did not become healthy after restart.", { cause: lastError });
}

async function* deterministicBytes(
  totalBytes: number,
  hash: ReturnType<typeof createHash>,
): AsyncGenerator<Buffer> {
  let remaining = totalBytes;
  let state = 0x9e3779b9;
  while (remaining > 0) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining));
    for (let index = 0; index < chunk.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      chunk[index] = state & 0xff;
    }
    hash.update(chunk);
    remaining -= chunk.length;
    yield chunk;
  }
}

async function fileChecksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}
