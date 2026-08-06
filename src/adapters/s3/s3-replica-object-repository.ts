import type { S3TargetConfig } from "../../application/configuration.js";
import type {
  RemoteObjectObservation,
  RemoteObjectPutInput,
  RemoteObjectPutResult,
  RemoteObjectVerification,
  RemoteUntrustedObjectPayload,
  ReplicaObjectRepository,
} from "../../application/replication-ports.js";
import { sameObjectReference, type ObjectReference } from "../../domain/model.js";
import type { RemoteObjectReceipt } from "../../domain/replica.js";
import type {
  RemoteEncodedObjectPayload,
  RemoteObjectRetriever,
} from "../../application/retrieval-ports.js";
import type { RemoteReceiptPolicy } from "../../application/prune-ports.js";
import type {
  S3ClientBoundaryFactory,
  S3GetObjectOutput,
  S3HeadObjectOutput,
  S3PutObjectOutput,
  S3ResponseMetadata,
} from "./s3-client.js";

export const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;

const METADATA = Object.freeze({
  algorithm: "hoarder-algorithm",
  digest: "hoarder-logical-sha256",
  encoding: "hoarder-encoding",
  logicalBytes: "hoarder-logical-bytes",
  storedBytes: "hoarder-stored-bytes",
});

type S3Operation = "GetObject" | "HeadObject" | "PutObject";

export interface S3ReplicaErrorDetails {
  operation: S3Operation;
  targetId: string;
  bucket: string;
  key: string;
  digest: string;
  statusCode?: number;
  requestId?: string;
  sourceName?: string;
  retryable: boolean;
}

export class S3ReplicaOperationError extends Error {
  readonly details: S3ReplicaErrorDetails;

  constructor(details: S3ReplicaErrorDetails) {
    const status = details.statusCode ? ` (HTTP ${details.statusCode})` : "";
    const request = details.requestId ? `, request ${details.requestId}` : "";
    super(
      `S3 ${details.operation} failed for target ${details.targetId}, bucket ${details.bucket}, object ${details.digest} at key ${details.key}${status}${request}; retryable=${details.retryable}.`,
    );
    this.name = "S3ReplicaOperationError";
    this.details = details;
  }
}

export class S3ReplicaObjectRepository
  implements ReplicaObjectRepository, RemoteObjectRetriever, RemoteReceiptPolicy
{
  private readonly bucket: string;
  private readonly targetId: string;
  private readonly prefix: string;
  private readonly encryption: Pick<S3TargetConfig, "serverSideEncryption" | "kmsKeyId">;
  private readonly clientFactory: S3ClientBoundaryFactory;

  constructor(config: S3TargetConfig, clientFactory: S3ClientBoundaryFactory) {
    this.bucket = config.bucket;
    this.targetId = config.targetId;
    this.prefix = normalizeS3Prefix(config.prefix);
    this.encryption = {
      ...(config.serverSideEncryption ? { serverSideEncryption: config.serverSideEncryption } : {}),
      ...(config.kmsKeyId ? { kmsKeyId: config.kmsKeyId } : {}),
    };
    this.clientFactory = clientFactory;
  }

  async inspect(object: ObjectReference, signal?: AbortSignal): Promise<RemoteObjectObservation> {
    signal?.throwIfAborted();
    const key = this.keyFor(object);
    try {
      const output = await this.headObject(key, signal);
      return {
        state: "untrusted-present",
        key,
        metadata: remoteMetadata(output),
      };
    } catch (error) {
      if (isMissingObject(error)) return { state: "absent" };
      throw sanitizeS3Error(error, this.errorContext("HeadObject", object, key));
    }
  }

  matches(object: ObjectReference, receipt: RemoteObjectReceipt): boolean {
    return sameObjectReference(object, receipt.object) && receipt.key === this.keyFor(object);
  }

  async retrieve(
    object: ObjectReference,
    receipt: RemoteObjectReceipt,
    signal?: AbortSignal,
  ): Promise<RemoteEncodedObjectPayload> {
    signal?.throwIfAborted();
    const key = this.keyFor(object);
    if (!this.matches(object, receipt)) {
      throw new Error(`Remote retrieval receipt does not match object ${object.digest}.`);
    }
    return this.getObject(
      object,
      key,
      (output) => retrievalPayload(object, receipt, output),
      signal,
    );
  }

  async put(input: RemoteObjectPutInput, signal?: AbortSignal): Promise<RemoteObjectPutResult> {
    signal?.throwIfAborted();
    validatePutInput(input);
    const key = this.keyFor(input.object);
    try {
      const client = await this.clientFactory();
      signal?.throwIfAborted();
      const output = await client.putObject(
        {
          Bucket: this.bucket,
          Key: key,
          Body: input.body,
          ContentLength: input.contentLength,
          ContentType: "application/gzip",
          IfNoneMatch: "*",
          ChecksumSHA256: input.checksumSha256,
          Metadata: objectMetadata(input.object),
          ...(this.encryption.serverSideEncryption
            ? { ServerSideEncryption: this.encryption.serverSideEncryption }
            : {}),
          ...(this.encryption.kmsKeyId ? { SSEKMSKeyId: this.encryption.kmsKeyId } : {}),
        },
        signal,
      );
      return { state: "uploaded", receipt: receiptFromPut(input.object, key, output) };
    } catch (error) {
      if (isConditionalConflict(error)) {
        return {
          state: "conflict",
          observation: await this.inspectConditionalConflict(input.object, key, signal),
        };
      }
      throw sanitizeS3Error(error, this.errorContext("PutObject", input.object, key));
    }
  }

  async verifyTrustedReceipt(
    object: ObjectReference,
    receipt: RemoteObjectReceipt,
    signal?: AbortSignal,
  ): Promise<RemoteObjectVerification> {
    signal?.throwIfAborted();
    const key = this.keyFor(object);
    if (!sameObjectReference(object, receipt.object) || receipt.key !== key) {
      return { valid: false };
    }
    try {
      const output = await this.headObject(key, signal);
      return { valid: headMatches(object, receipt, output) };
    } catch (error) {
      if (isMissingObject(error)) return { valid: false };
      throw sanitizeS3Error(error, this.errorContext("HeadObject", object, key));
    }
  }

  async retrieveUntrusted(
    object: ObjectReference,
    observation: Extract<RemoteObjectObservation, { state: "untrusted-present" }>,
    signal?: AbortSignal,
  ): Promise<RemoteUntrustedObjectPayload> {
    signal?.throwIfAborted();
    const key = this.keyFor(object);
    if (observation.key !== key) {
      throw new Error(`Remote observation does not match object ${object.digest}.`);
    }
    return this.getObject(object, key, (output) => untrustedPayload(object, key, output), signal);
  }

  private async getObject<Result>(
    object: ObjectReference,
    key: string,
    map: (output: S3GetObjectOutput) => Result,
    signal?: AbortSignal,
  ): Promise<Result> {
    try {
      const client = await this.clientFactory();
      if (!client.getObject) throw new Error("S3 GetObject is unavailable.");
      const output = await client.getObject(
        { Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED" },
        signal,
      );
      return map(output);
    } catch (error) {
      throw sanitizeS3Error(error, this.errorContext("GetObject", object, key));
    }
  }

  private async inspectConditionalConflict(
    object: ObjectReference,
    key: string,
    signal?: AbortSignal,
  ): Promise<RemoteObjectObservation> {
    try {
      const output = await this.headObject(key, signal);
      return {
        state: "untrusted-present",
        key,
        metadata: remoteMetadata(output),
      };
    } catch (error) {
      if (isMissingObject(error)) return { state: "absent" };
      if (error instanceof S3ReplicaOperationError) throw error;
      throw sanitizeS3Error(error, this.errorContext("HeadObject", object, key));
    }
  }

  private async headObject(key: string, signal?: AbortSignal): Promise<S3HeadObjectOutput> {
    const client = await this.clientFactory();
    signal?.throwIfAborted();
    return client.headObject({ Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED" }, signal);
  }

  private keyFor(object: ObjectReference): string {
    const suffix = `objects/sha256/${object.digest}.gz`;
    return this.prefix.length > 0 ? `${this.prefix}/${suffix}` : suffix;
  }

  private errorContext(
    operation: S3Operation,
    object: ObjectReference,
    key: string,
  ): Omit<S3ReplicaErrorDetails, "retryable"> {
    return {
      operation,
      targetId: this.targetId,
      bucket: this.bucket,
      key,
      digest: object.digest,
    };
  }
}

function untrustedPayload(
  object: ObjectReference,
  key: string,
  output: S3GetObjectOutput,
): RemoteUntrustedObjectPayload {
  if (!output.Body || output.ContentLength !== object.storedBytes) {
    throw new Error(`Remote untrusted object size mismatch for ${object.digest}.`);
  }
  return {
    key,
    body: output.Body,
    contentLength: output.ContentLength,
    ...(output.ChecksumSHA256 ? { checksumSha256: output.ChecksumSHA256 } : {}),
    ...(output.ETag ? { etag: output.ETag } : {}),
    ...(output.VersionId ? { versionId: output.VersionId } : {}),
  };
}

function retrievalPayload(
  object: ObjectReference,
  receipt: RemoteObjectReceipt,
  output: S3GetObjectOutput,
): RemoteEncodedObjectPayload {
  if (!output.Body || output.ContentLength !== object.storedBytes) {
    throw new Error(`Remote retrieval metadata mismatch for ${object.digest}.`);
  }
  if (!metadataMatches(object, output.Metadata)) {
    throw new Error(`Remote retrieval object identity mismatch for ${object.digest}.`);
  }
  if (receipt.etag && output.ETag !== receipt.etag) {
    throw new Error(`Remote retrieval ETag mismatch for ${object.digest}.`);
  }
  if (
    receipt.checksumSha256 &&
    output.ChecksumSHA256 &&
    receipt.checksumSha256 !== output.ChecksumSHA256
  ) {
    throw new Error(`Remote retrieval checksum metadata mismatch for ${object.digest}.`);
  }
  const checksumSha256 = output.ChecksumSHA256 ?? receipt.checksumSha256;
  return {
    body: output.Body,
    contentLength: output.ContentLength,
    ...(checksumSha256 ? { checksumSha256 } : {}),
  };
}

export function normalizeS3Prefix(prefix: string): string {
  if (/\p{Cc}/u.test(prefix) || prefix.includes("\\")) {
    throw new Error("S3 object prefix must not contain control characters or backslashes.");
  }
  const segments = prefix
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error('S3 object prefix must not contain "." or ".." path segments.');
  }
  return segments.join("/");
}

function validatePutInput(input: RemoteObjectPutInput): void {
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0) {
    throw new Error("Encoded S3 object Content-Length must be a non-negative safe integer.");
  }
  if (input.contentLength !== input.object.storedBytes) {
    throw new Error(
      `Encoded S3 object size mismatch for ${input.object.digest}: expected ${input.object.storedBytes}, received ${input.contentLength}.`,
    );
  }
  if (input.contentLength > MAX_SINGLE_PUT_BYTES) {
    throw new Error(
      `Encoded object ${input.object.digest} is ${input.contentLength} bytes, exceeding the 5 GiB single-request PutObject limit; multipart upload is not implemented. Keep the object local or reduce its size.`,
    );
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(input.checksumSha256)) {
    throw new Error(
      `Encoded S3 object ${input.object.digest} requires a base64-encoded SHA-256 checksum.`,
    );
  }
}

function objectMetadata(object: ObjectReference): Record<string, string> {
  return {
    [METADATA.algorithm]: object.algorithm,
    [METADATA.digest]: object.digest,
    [METADATA.encoding]: object.encoding,
    [METADATA.logicalBytes]: String(object.logicalBytes),
    [METADATA.storedBytes]: String(object.storedBytes),
  };
}

function receiptFromPut(
  object: ObjectReference,
  key: string,
  output: S3PutObjectOutput,
): RemoteObjectReceipt {
  return compactReceipt(object, key, output);
}

function compactReceipt(
  object: ObjectReference,
  key: string,
  output: Pick<S3HeadObjectOutput, "ETag" | "VersionId" | "ChecksumSHA256">,
): RemoteObjectReceipt {
  return {
    object: structuredClone(object),
    key,
    ...(output.ETag ? { etag: output.ETag } : {}),
    ...(output.VersionId ? { versionId: output.VersionId } : {}),
    ...(output.ChecksumSHA256 ? { checksumSha256: output.ChecksumSHA256 } : {}),
  };
}

function remoteMetadata(output: S3HeadObjectOutput): {
  contentLength?: number;
  etag?: string;
  versionId?: string;
  checksumSha256?: string;
} {
  return {
    ...(output.ContentLength !== undefined ? { contentLength: output.ContentLength } : {}),
    ...(output.ETag ? { etag: output.ETag } : {}),
    ...(output.VersionId ? { versionId: output.VersionId } : {}),
    ...(output.ChecksumSHA256 ? { checksumSha256: output.ChecksumSHA256 } : {}),
  };
}

function headMatches(
  object: ObjectReference,
  receipt: RemoteObjectReceipt,
  output: S3HeadObjectOutput,
): boolean {
  if (output.ContentLength !== object.storedBytes) return false;
  if (!metadataMatches(object, output.Metadata)) return false;
  if (receipt.etag !== undefined && output.ETag !== receipt.etag) return false;
  if (receipt.versionId !== undefined && output.VersionId !== receipt.versionId) return false;
  if (receipt.checksumSha256 !== undefined && output.ChecksumSHA256 !== receipt.checksumSha256) {
    return false;
  }
  return true;
}

function metadataMatches(
  object: ObjectReference,
  metadata: Record<string, string> | undefined,
): boolean {
  if (!metadata) return false;
  const normalized = Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return (
    normalized[METADATA.algorithm] === object.algorithm &&
    normalized[METADATA.digest] === object.digest &&
    normalized[METADATA.encoding] === object.encoding &&
    normalized[METADATA.logicalBytes] === String(object.logicalBytes) &&
    normalized[METADATA.storedBytes] === String(object.storedBytes)
  );
}

function isMissingObject(error: unknown): boolean {
  const status = errorMetadata(error)?.httpStatusCode;
  const name = errorName(error);
  return status === 404 || name === "NotFound" || name === "NoSuchKey";
}

function isConditionalConflict(error: unknown): boolean {
  const status = errorMetadata(error)?.httpStatusCode;
  const name = errorName(error);
  return (
    status === 409 ||
    status === 412 ||
    name === "ConditionalRequestConflict" ||
    name === "PreconditionFailed"
  );
}

function sanitizeS3Error(error: unknown, context: Omit<S3ReplicaErrorDetails, "retryable">): Error {
  if (isAbortError(error)) return new DOMException("S3 operation was aborted.", "AbortError");
  const metadata = errorMetadata(error);
  const sourceName = safeErrorName(errorName(error));
  const requestId = safeRequestId(metadata?.requestId);
  const statusCode = metadata?.httpStatusCode;
  return new S3ReplicaOperationError({
    ...context,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(sourceName ? { sourceName } : {}),
    retryable: isRetryable(error, statusCode, sourceName),
  });
}

function errorMetadata(error: unknown): S3ResponseMetadata | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return undefined;
  const metadata = (error as { $metadata?: unknown }).$metadata;
  return typeof metadata === "object" && metadata !== null
    ? (metadata as S3ResponseMetadata)
    : undefined;
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) return undefined;
  return typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : undefined;
}

function isAbortError(error: unknown): boolean {
  return errorName(error) === "AbortError";
}

function isRetryable(
  error: unknown,
  statusCode: number | undefined,
  sourceName: string | undefined,
): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "$retryable" in error &&
    Boolean((error as { $retryable?: unknown }).$retryable)
  ) {
    return true;
  }
  if (statusCode === 408 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
    return true;
  }
  return sourceName === "Throttling" || sourceName === "SlowDown";
}

function safeErrorName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64);
  return sanitized.length > 0 ? sanitized : undefined;
}

function safeRequestId(value: string | undefined): string | undefined {
  if (!value || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) return undefined;
  return value;
}
