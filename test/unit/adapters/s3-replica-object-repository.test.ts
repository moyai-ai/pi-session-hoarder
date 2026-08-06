import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { S3TargetConfig } from "../../../src/application/configuration.js";
import type { ObjectReference } from "../../../src/domain/model.js";
import {
  MAX_SINGLE_PUT_BYTES,
  normalizeS3Prefix,
  S3ReplicaObjectRepository,
  S3ReplicaOperationError,
} from "../../../src/adapters/s3/s3-replica-object-repository.js";
import type {
  S3ClientBoundary,
  S3GetObjectInput,
  S3GetObjectOutput,
  S3HeadObjectInput,
  S3HeadObjectOutput,
  S3PutObjectInput,
  S3PutObjectOutput,
} from "../../../src/adapters/s3/s3-client.js";
import { replicaObjectRepositoryContract } from "../../contracts/replica-object-repository.contract.js";
import { replicaObjectFixture } from "../../support/memory-replication.js";

const config: S3TargetConfig = {
  targetId: "backup",
  bucket: "archive-bucket",
  region: "us-east-1",
  prefix: "//team//sessions//",
  forcePathStyle: false,
};

class StatefulS3Client implements S3ClientBoundary {
  readonly objects = new Map<
    string,
    {
      bytes: Buffer;
      metadata: Record<string, string>;
      etag: string;
      checksum: string;
      versionId: string;
    }
  >();

  async headObject(input: S3HeadObjectInput, signal?: AbortSignal): Promise<S3HeadObjectOutput> {
    signal?.throwIfAborted();
    const stored = this.objects.get(input.Key);
    if (!stored) throw awsError("NotFound", 404);
    return {
      ContentLength: stored.bytes.byteLength,
      ETag: stored.etag,
      VersionId: stored.versionId,
      ChecksumSHA256: stored.checksum,
      Metadata: { ...stored.metadata },
      $metadata: { httpStatusCode: 200, requestId: "head-request" },
    };
  }

  async putObject(input: S3PutObjectInput, signal?: AbortSignal): Promise<S3PutObjectOutput> {
    signal?.throwIfAborted();
    if (this.objects.has(input.Key)) throw awsError("PreconditionFailed", 412);
    const chunks: Buffer[] = [];
    for await (const chunk of input.Body) {
      signal?.throwIfAborted();
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const checksum = createHash("sha256").update(bytes).digest("base64");
    const stored = {
      bytes,
      metadata: { ...input.Metadata },
      etag: '"etag-1"',
      checksum,
      versionId: "version-1",
    };
    this.objects.set(input.Key, stored);
    return {
      ETag: stored.etag,
      VersionId: stored.versionId,
      ChecksumSHA256: checksum,
      $metadata: { httpStatusCode: 200, requestId: "put-request" },
    };
  }
}

replicaObjectRepositoryContract("S3ReplicaObjectRepository", async () => {
  const fixture = replicaObjectFixture();
  const client = new StatefulS3Client();
  return {
    repository: new S3ReplicaObjectRepository(config, async () => client),
    object: fixture.object,
    payload: fixture.payload,
  };
});

describe("S3ReplicaObjectRepository", () => {
  it("matches durable receipts only under the configured object-key policy", () => {
    const fixture = replicaObjectFixture();
    const expected = new S3ReplicaObjectRepository(config, async () => new StatefulS3Client());
    const receipt = {
      object: fixture.object,
      key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
    };

    expect(expected.matches(fixture.object, receipt)).toBe(true);
    expect(
      new S3ReplicaObjectRepository(
        { ...config, prefix: "different-prefix" },
        async () => new StatefulS3Client(),
      ).matches(fixture.object, receipt),
    ).toBe(false);
    expect(
      expected.matches({ ...fixture.object, storedBytes: fixture.object.storedBytes + 1 }, receipt),
    ).toBe(false);
  });

  it("maps a conditional streaming PutObject request and receipt exactly", async () => {
    const fixture = replicaObjectFixture();
    const putObject = vi.fn(
      async (_input: S3PutObjectInput, _signal?: AbortSignal): Promise<S3PutObjectOutput> => ({
        ETag: '"etag"',
        VersionId: "v2",
        ChecksumSHA256: "encoded-checksum",
      }),
    );
    const client: S3ClientBoundary = {
      headObject: vi.fn(),
      putObject,
    };
    const repository = new S3ReplicaObjectRepository(config, async () => client);
    const signal = new AbortController().signal;

    const result = await repository.put({ object: fixture.object, ...fixture.payload() }, signal);

    expect(putObject).toHaveBeenCalledOnce();
    const [request, receivedSignal] = putObject.mock.calls[0]!;
    expect(request).toEqual({
      Bucket: "archive-bucket",
      Key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
      Body: expect.anything(),
      ContentLength: fixture.object.storedBytes,
      ContentType: "application/gzip",
      IfNoneMatch: "*",
      ChecksumSHA256: fixture.payload().checksumSha256,
      Metadata: {
        "hoarder-algorithm": "sha256",
        "hoarder-logical-sha256": fixture.object.digest,
        "hoarder-encoding": "gzip",
        "hoarder-logical-bytes": String(fixture.object.logicalBytes),
        "hoarder-stored-bytes": String(fixture.object.storedBytes),
      },
    });
    expect(receivedSignal).toBe(signal);
    expect(result).toEqual({
      state: "uploaded",
      receipt: {
        object: fixture.object,
        key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
        etag: '"etag"',
        versionId: "v2",
        checksumSha256: "encoded-checksum",
      },
    });
  });

  it("maps a verified GetObject request without consuming its stream", async () => {
    const fixture = replicaObjectFixture();
    const body = fixture.payload().body;
    const getObject = vi.fn(async (_input: S3GetObjectInput): Promise<S3GetObjectOutput> => ({
      Body: body,
      ContentLength: fixture.object.storedBytes,
      ChecksumSHA256: "encoded-checksum",
      ETag: '"etag"',
      Metadata: headOutput(fixture.object).Metadata,
    }));
    const repository = new S3ReplicaObjectRepository(config, async () => ({
      headObject: vi.fn(),
      getObject,
      putObject: vi.fn(),
    }));
    const receipt = {
      object: fixture.object,
      key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
      etag: '"etag"',
      checksumSha256: "encoded-checksum",
    };
    const signal = new AbortController().signal;

    await expect(repository.retrieve(fixture.object, receipt, signal)).resolves.toEqual({
      body,
      contentLength: fixture.object.storedBytes,
      checksumSha256: "encoded-checksum",
    });
    expect(getObject).toHaveBeenCalledWith(
      {
        Bucket: "archive-bucket",
        Key: receipt.key,
        ChecksumMode: "ENABLED",
      },
      signal,
    );
  });

  it("maps an untrusted GetObject without turning HeadObject metadata into a receipt", async () => {
    const fixture = replicaObjectFixture();
    const body = fixture.payload().body;
    const getObject = vi.fn(async (): Promise<S3GetObjectOutput> => ({
      Body: body,
      ContentLength: fixture.object.storedBytes,
      ChecksumSHA256: fixture.payload().checksumSha256,
      ETag: '"untrusted"',
      VersionId: "untrusted-version",
      Metadata: headOutput(fixture.object).Metadata,
    }));
    const repository = new S3ReplicaObjectRepository(config, async () => ({
      headObject: vi.fn(),
      getObject,
      putObject: vi.fn(),
    }));
    const observation = {
      state: "untrusted-present" as const,
      key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
      metadata: { contentLength: fixture.object.storedBytes },
    };

    await expect(repository.retrieveUntrusted(fixture.object, observation)).resolves.toEqual({
      key: observation.key,
      body,
      contentLength: fixture.object.storedBytes,
      checksumSha256: fixture.payload().checksumSha256,
      etag: '"untrusted"',
      versionId: "untrusted-version",
    });
    expect(getObject).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "size",
      (output: S3GetObjectOutput) => {
        output.ContentLength = 1;
      },
    ],
    [
      "identity",
      (output: S3GetObjectOutput) => {
        output.Metadata = {};
      },
    ],
    [
      "etag",
      (output: S3GetObjectOutput) => {
        output.ETag = '"changed"';
      },
    ],
    [
      "checksum",
      (output: S3GetObjectOutput) => {
        output.ChecksumSHA256 = "changed";
      },
    ],
  ])("rejects unsafe GetObject %s changes", async (_name, mutate) => {
    const fixture = replicaObjectFixture();
    const output: S3GetObjectOutput = {
      Body: fixture.payload().body,
      ContentLength: fixture.object.storedBytes,
      ChecksumSHA256: "encoded-checksum",
      ETag: '"etag"',
      Metadata: headOutput(fixture.object).Metadata,
    };
    mutate(output);
    const repository = new S3ReplicaObjectRepository(config, async () => ({
      headObject: vi.fn(),
      getObject: async () => output,
      putObject: vi.fn(),
    }));
    await expect(
      repository.retrieve(fixture.object, {
        object: fixture.object,
        key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
        etag: '"etag"',
        checksumSha256: "encoded-checksum",
      }),
    ).rejects.toMatchObject({ name: "S3ReplicaOperationError" });
  });

  it("rejects a receipt for a different key before constructing an S3 client", async () => {
    const fixture = replicaObjectFixture();
    const factory = vi.fn();
    const repository = new S3ReplicaObjectRepository(config, factory);
    await expect(
      repository.retrieve(fixture.object, {
        object: fixture.object,
        key: "untrusted/objects/sha256/elsewhere.gz",
      }),
    ).rejects.toThrow("does not match");
    expect(factory).not.toHaveBeenCalled();
  });

  it("maps HeadObject inspection without manufacturing a trusted receipt", async () => {
    const fixture = replicaObjectFixture();
    const output = headOutput(fixture.object);
    const headObject = vi.fn(async () => output);
    const repository = new S3ReplicaObjectRepository(config, async () => ({
      headObject,
      putObject: vi.fn(),
    }));
    const signal = new AbortController().signal;

    const observation = await repository.inspect(fixture.object, signal);

    expect(headObject).toHaveBeenCalledOnce();
    expect(headObject).toHaveBeenNthCalledWith(
      1,
      {
        Bucket: "archive-bucket",
        Key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
        ChecksumMode: "ENABLED",
      },
      signal,
    );
    expect(observation).toEqual({
      state: "untrusted-present",
      key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
      metadata: {
        contentLength: fixture.object.storedBytes,
        etag: '"existing"',
        versionId: "existing-version",
        checksumSha256: "existing-checksum",
      },
    });
  });

  it("maps HeadObject missing variants to undefined but never treats access denial as absence", async () => {
    const fixture = replicaObjectFixture();
    for (const error of [awsError("NotFound", 404), awsError("NoSuchKey", 400)]) {
      const repository = new S3ReplicaObjectRepository(config, async () => ({
        headObject: async () => {
          throw error;
        },
        putObject: vi.fn(),
      }));
      await expect(repository.inspect(fixture.object)).resolves.toEqual({ state: "absent" });
    }

    const denied = new S3ReplicaObjectRepository(config, async () => ({
      headObject: async () => {
        throw awsError("AccessDenied", 403);
      },
      putObject: vi.fn(),
    }));
    await expect(denied.inspect(fixture.object)).rejects.toMatchObject({
      name: "S3ReplicaOperationError",
      details: { statusCode: 403, sourceName: "AccessDenied" },
    });
  });

  it("returns false for invalid receipts or metadata", async () => {
    const fixture = replicaObjectFixture();
    const headObject = vi.fn(async () => ({
      ...headOutput(fixture.object),
      Metadata: { "hoarder-logical-sha256": "wrong" },
    }));
    const repository = new S3ReplicaObjectRepository(config, async () => ({
      headObject,
      putObject: vi.fn(),
    }));
    await expect(
      repository.verifyTrustedReceipt(fixture.object, {
        object: fixture.object,
        key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
      }),
    ).resolves.toEqual({ valid: false });
    await expect(
      repository.verifyTrustedReceipt(fixture.object, {
        object: { ...fixture.object, logicalBytes: fixture.object.logicalBytes + 1 },
        key: "wrong",
      }),
    ).resolves.toEqual({ valid: false });
    expect(headObject).toHaveBeenCalledOnce();
  });

  it("resolves a concurrent conditional conflict by inspecting the existing object", async () => {
    const fixture = replicaObjectFixture();
    const headObject = vi.fn(async () => ({
      ...headOutput(fixture.object),
      ChecksumSHA256: fixture.payload().checksumSha256,
    }));
    const repository = new S3ReplicaObjectRepository(config, async () => ({
      putObject: async () => {
        throw awsError("PreconditionFailed", 412);
      },
      headObject,
    }));

    await expect(
      repository.put({ object: fixture.object, ...fixture.payload() }),
    ).resolves.toMatchObject({
      state: "conflict",
      observation: {
        state: "untrusted-present",
        key: `team/sessions/objects/sha256/${fixture.object.digest}.gz`,
      },
    });
    expect(headObject).toHaveBeenCalledOnce();
  });

  it("does not trust conflicting object metadata even when its checksum differs", async () => {
    const fixture = replicaObjectFixture();
    const repository = new S3ReplicaObjectRepository(config, async () => ({
      putObject: async () => {
        throw awsError("ConditionalRequestConflict", 409);
      },
      headObject: async () => headOutput(fixture.object),
    }));

    await expect(
      repository.put({ object: fixture.object, ...fixture.payload() }),
    ).resolves.toMatchObject({
      state: "conflict",
      observation: { state: "untrusted-present" },
    });
  });

  it("rejects oversize and mismatched lengths before constructing a client", async () => {
    const fixture = replicaObjectFixture();
    const factory = vi.fn(async () => new StatefulS3Client());
    const repository = new S3ReplicaObjectRepository(config, factory);
    const oversized = {
      ...fixture.object,
      storedBytes: MAX_SINGLE_PUT_BYTES + 1,
    };

    await expect(
      repository.put({
        object: oversized,
        contentLength: oversized.storedBytes,
        checksumSha256: Buffer.alloc(32).toString("base64"),
        body: emptyBody(),
      }),
    ).rejects.toThrow(/5 GiB.*multipart upload is not implemented/i);
    await expect(
      repository.put({
        object: fixture.object,
        contentLength: 1,
        checksumSha256: Buffer.alloc(32).toString("base64"),
        body: emptyBody(),
      }),
    ).rejects.toThrow(/size mismatch/i);
    expect(factory).not.toHaveBeenCalled();
  });

  it("propagates cancellation before and during every AWS request", async () => {
    const fixture = replicaObjectFixture();
    const factory = vi.fn(async () => new StatefulS3Client());
    const repository = new S3ReplicaObjectRepository(config, factory);
    const preAborted = new AbortController();
    preAborted.abort();

    await expect(repository.inspect(fixture.object, preAborted.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(
      repository.put({ object: fixture.object, ...fixture.payload() }, preAborted.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).not.toHaveBeenCalled();

    const remoteAbort = new S3ReplicaObjectRepository(config, async () => ({
      headObject: async (_input, signal) => {
        expect(signal).toBeDefined();
        throw Object.assign(new Error("signed-url-secret"), { name: "AbortError" });
      },
      putObject: vi.fn(),
    }));
    await expect(
      remoteAbort.inspect(fixture.object, new AbortController().signal),
    ).rejects.toMatchObject({ name: "AbortError", message: "S3 operation was aborted." });
  });

  it("sanitizes AWS failures while preserving safe diagnostic context", async () => {
    const fixture = replicaObjectFixture();
    const leaked =
      "Authorization=Bearer super-secret X-Amz-Credential=AKIA... https://secret.internal/path?X-Amz-Signature=token";
    const repository = new S3ReplicaObjectRepository(config, async () => ({
      headObject: async () => {
        throw Object.assign(new Error(leaked), {
          name: "AccessDenied<script>",
          $metadata: {
            httpStatusCode: 503,
            requestId: "request-123\nAuthorization: secret",
            extendedRequestId: leaked,
          },
          $retryable: { throttling: true },
          authorization: leaked,
        });
      },
      putObject: vi.fn(),
    }));

    let caught: unknown;
    try {
      await repository.inspect(fixture.object);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(S3ReplicaOperationError);
    const sanitized = caught as S3ReplicaOperationError;
    expect(sanitized.details).toMatchObject({
      operation: "HeadObject",
      targetId: "backup",
      bucket: "archive-bucket",
      digest: fixture.object.digest,
      statusCode: 503,
      sourceName: "AccessDeniedscript",
      retryable: true,
    });
    expect(sanitized.message).not.toContain("super-secret");
    expect(sanitized.message).not.toContain("secret.internal");
    expect(JSON.stringify(sanitized.details)).not.toContain("Authorization");
    expect("cause" in sanitized).toBe(false);
  });
});

describe("normalizeS3Prefix", () => {
  it("normalizes separators without allowing path-like unsafe segments", () => {
    expect(normalizeS3Prefix(" /alpha// beta/ ")).toBe("alpha/beta");
    expect(normalizeS3Prefix("///")).toBe("");
    expect(() => normalizeS3Prefix("alpha/../beta")).toThrow(/path segments/);
    expect(() => normalizeS3Prefix("alpha\\beta")).toThrow(/backslashes/);
    expect(() => normalizeS3Prefix("alpha\nbeta")).toThrow(/control/);
  });
});

function headOutput(object: ObjectReference): S3HeadObjectOutput {
  return {
    ContentLength: object.storedBytes,
    ETag: '"existing"',
    VersionId: "existing-version",
    ChecksumSHA256: "existing-checksum",
    Metadata: {
      "hoarder-algorithm": object.algorithm,
      "hoarder-logical-sha256": object.digest,
      "hoarder-encoding": object.encoding,
      "hoarder-logical-bytes": String(object.logicalBytes),
      "hoarder-stored-bytes": String(object.storedBytes),
    },
  };
}

function awsError(name: string, status: number): Error {
  return Object.assign(new Error("unsafe remote message"), {
    name,
    $metadata: { httpStatusCode: status, requestId: `${name}-request` },
  });
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return (async function* () {})();
}
