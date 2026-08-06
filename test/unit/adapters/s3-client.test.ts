import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { S3TargetConfig } from "../../../src/application/configuration.js";
import {
  createLazyAwsS3ClientFactory,
  type AwsSdkLoader,
  type S3GetObjectInput,
  type S3HeadObjectInput,
  type S3PutObjectInput,
} from "../../../src/adapters/s3/s3-client.js";

const config: S3TargetConfig = {
  targetId: "backup",
  bucket: "bucket",
  region: "us-west-2",
  prefix: "prefix",
  endpoint: "http://127.0.0.1:9000",
  profile: "archive-profile",
  forcePathStyle: true,
};

describe("createLazyAwsS3ClientFactory", () => {
  it("loads and constructs the SDK client lazily exactly once", async () => {
    const send = vi.fn(async (command: unknown) => command);
    const createClient = vi.fn(() => ({ send }));
    const defaultProviderResult = vi.fn(async () => ({
      accessKeyId: "test",
      secretAccessKey: "test",
    }));
    const defaultProvider = vi.fn(() => defaultProviderResult);
    const loadSdk: AwsSdkLoader = vi.fn(async () => ({
      sdk: {
        createClient,
        createHeadObjectCommand: (input: S3HeadObjectInput) => ({ kind: "head", input }),
        createGetObjectCommand: (input: S3GetObjectInput) => ({ kind: "get", input }),
        createPutObjectCommand: (input: Omit<S3PutObjectInput, "Body"> & { Body: Readable }) => ({
          kind: "put",
          input,
        }),
      },
      defaultProvider,
    }));

    const factory = createLazyAwsS3ClientFactory(config, loadSdk);
    expect(loadSdk).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([factory(), factory()]);
    expect(first).toBe(second);
    expect(loadSdk).toHaveBeenCalledOnce();
    expect(defaultProvider).toHaveBeenCalledWith({ profile: "archive-profile" });
    expect(createClient).toHaveBeenCalledWith({
      region: "us-west-2",
      forcePathStyle: true,
      endpoint: "http://127.0.0.1:9000",
      credentials: defaultProviderResult,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  });

  it("maps command inputs, streaming bodies, outputs, and AbortSignal", async () => {
    const commands: unknown[] = [];
    const options: unknown[] = [];
    const send = vi.fn(async (command: unknown, requestOptions?: unknown) => {
      commands.push(command);
      options.push(requestOptions);
      return "output";
    });
    const loadSdk: AwsSdkLoader = async () => ({
      sdk: {
        createClient: () => ({ send }),
        createHeadObjectCommand: (input: S3HeadObjectInput) => ({ kind: "head", input }),
        createGetObjectCommand: (input: S3GetObjectInput) => ({ kind: "get", input }),
        createPutObjectCommand: (input: Omit<S3PutObjectInput, "Body"> & { Body: Readable }) => ({
          kind: "put",
          input,
        }),
      },
      defaultProvider: vi.fn(),
    });
    const client = await createLazyAwsS3ClientFactory(
      { ...config, profile: undefined, endpoint: undefined },
      loadSdk,
    )();
    const signal = new AbortController().signal;
    const head: S3HeadObjectInput = {
      Bucket: "bucket",
      Key: "key",
      ChecksumMode: "ENABLED",
    };
    const get: S3GetObjectInput = {
      Bucket: "bucket",
      Key: "key",
      ChecksumMode: "ENABLED",
    };
    const put: S3PutObjectInput = {
      Bucket: "bucket",
      Key: "key",
      Body: (async function* () {
        yield Buffer.from("encoded");
      })(),
      ContentLength: 7,
      ContentType: "application/gzip",
      IfNoneMatch: "*",
      ChecksumSHA256: "ZW5jb2RlZC1jaGVja3N1bQAAAAAAAAAAAAAAAAAAAAA=",
      Metadata: { digest: "value" },
    };

    await expect(client.headObject(head, signal)).resolves.toBe("output");
    await expect(client.getObject!(get, signal)).resolves.toBe("output");
    await expect(client.putObject(put, signal)).resolves.toBe("output");

    expect(commands[0]).toEqual({ kind: "head", input: head });
    expect(commands[1]).toEqual({ kind: "get", input: get });
    expect(options).toEqual([
      { abortSignal: signal },
      { abortSignal: signal },
      { abortSignal: signal },
    ]);
    const putCommand = commands[2] as {
      kind: string;
      input: Omit<S3PutObjectInput, "Body"> & { Body: Readable };
    };
    expect(putCommand.kind).toBe("put");
    expect(putCommand.input).toMatchObject({
      Bucket: "bucket",
      Key: "key",
      ContentLength: 7,
      ContentType: "application/gzip",
      IfNoneMatch: "*",
      ChecksumSHA256: "ZW5jb2RlZC1jaGVja3N1bQAAAAAAAAAAAAAAAAAAAAA=",
      Metadata: { digest: "value" },
    });
    expect(putCommand.input.Body).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const chunk of putCommand.input.Body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("encoded");
  });
});
