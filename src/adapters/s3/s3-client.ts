import { Readable } from "node:stream";

import type { S3TargetConfig } from "../../application/configuration.js";
import type { RemoteEncodedObjectPayload } from "../../application/retrieval-ports.js";

export interface S3ResponseMetadata {
  httpStatusCode?: number;
  requestId?: string;
  attempts?: number;
}

export interface S3HeadObjectInput {
  Bucket: string;
  Key: string;
  ChecksumMode: "ENABLED";
}

export interface S3HeadObjectOutput {
  ContentLength?: number;
  ETag?: string;
  VersionId?: string;
  ChecksumSHA256?: string;
  Metadata?: Record<string, string>;
  $metadata?: S3ResponseMetadata;
}

export interface S3PutObjectInput {
  Bucket: string;
  Key: string;
  Body: AsyncIterable<Uint8Array>;
  ContentLength: number;
  ContentType: "application/gzip";
  IfNoneMatch: "*";
  ChecksumSHA256: string;
  Metadata: Record<string, string>;
  ServerSideEncryption?: "AES256" | "aws:kms";
  SSEKMSKeyId?: string;
}

export interface S3GetObjectInput {
  Bucket: string;
  Key: string;
  ChecksumMode: "ENABLED";
}

export interface S3GetObjectOutput extends Omit<
  RemoteEncodedObjectPayload,
  "contentLength" | "body"
> {
  Body?: AsyncIterable<Uint8Array>;
  ContentLength?: number;
  ChecksumSHA256?: string;
  ETag?: string;
  VersionId?: string;
  Metadata?: Record<string, string>;
  $metadata?: S3ResponseMetadata;
}

export interface S3PutObjectOutput {
  ETag?: string;
  VersionId?: string;
  ChecksumSHA256?: string;
  $metadata?: S3ResponseMetadata;
}

export interface S3ClientBoundary {
  headObject(input: S3HeadObjectInput, signal?: AbortSignal): Promise<S3HeadObjectOutput>;
  getObject?(input: S3GetObjectInput, signal?: AbortSignal): Promise<S3GetObjectOutput>;
  putObject(input: S3PutObjectInput, signal?: AbortSignal): Promise<S3PutObjectOutput>;
}

export type S3ClientBoundaryFactory = () => Promise<S3ClientBoundary>;

export interface AwsSendClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface AwsSdkModule {
  createClient(config: Record<string, unknown>): AwsSendClient;
  createHeadObjectCommand(input: S3HeadObjectInput): unknown;
  createGetObjectCommand?(input: S3GetObjectInput): unknown;
  createPutObjectCommand(input: Omit<S3PutObjectInput, "Body"> & { Body: Readable }): unknown;
}

export interface AwsSdkLoaderResult {
  sdk: AwsSdkModule;
  defaultProvider: (options?: { profile?: string }) => unknown;
}

export type AwsSdkLoader = () => Promise<AwsSdkLoaderResult>;

export function createLazyAwsS3ClientFactory(
  config: S3TargetConfig,
  loadSdk: AwsSdkLoader = loadAwsSdk,
): S3ClientBoundaryFactory {
  let clientPromise: Promise<S3ClientBoundary> | undefined;
  return () => (clientPromise ??= createClient(config, loadSdk));
}

async function createClient(
  config: S3TargetConfig,
  loadSdk: AwsSdkLoader,
): Promise<S3ClientBoundary> {
  const { sdk, defaultProvider } = await loadSdk();
  const client = sdk.createClient({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.profile ? { credentials: defaultProvider({ profile: config.profile }) } : {}),
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  return {
    headObject: async (input, signal) =>
      (await client.send(
        sdk.createHeadObjectCommand(input),
        signal ? { abortSignal: signal } : {},
      )) as S3HeadObjectOutput,
    getObject: async (input, signal) => {
      if (!sdk.createGetObjectCommand) throw new Error("S3 GetObject command is unavailable.");
      return (await client.send(
        sdk.createGetObjectCommand(input),
        signal ? { abortSignal: signal } : {},
      )) as S3GetObjectOutput;
    },
    putObject: async (input, signal) => {
      const { Body, ...request } = input;
      return (await client.send(
        sdk.createPutObjectCommand({ ...request, Body: Readable.from(Body) }),
        signal ? { abortSignal: signal } : {},
      )) as S3PutObjectOutput;
    },
  };
}

async function loadAwsSdk(): Promise<AwsSdkLoaderResult> {
  const [sdk, credentials] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/credential-provider-node"),
  ]);
  return {
    sdk: {
      createClient: (config) => new sdk.S3Client(config),
      createHeadObjectCommand: (input) => new sdk.HeadObjectCommand(input),
      createGetObjectCommand: (input) => new sdk.GetObjectCommand(input),
      createPutObjectCommand: (input) => new sdk.PutObjectCommand(input),
    },
    defaultProvider: credentials.defaultProvider,
  };
}
