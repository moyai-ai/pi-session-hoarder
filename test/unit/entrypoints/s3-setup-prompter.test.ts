import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { S3SetupInitial } from "../../../src/application/s3-setup.js";
import {
  formatS3SetupPreview,
  PiS3SetupPrompter,
} from "../../../src/entrypoints/s3-setup-prompter.js";

const initial: S3SetupInitial = {
  globalConfigPath: "/global/session-hoarder.json",
  targetId: "backup",
  bucket: "bucket",
  region: "us-east-1",
  prefix: "session-hoarder",
  endpoint: "",
  profile: "",
  forcePathStyle: false,
};

function context(inputValues: Array<string | undefined>, selectValues: Array<string | undefined>) {
  return {
    hasUI: true,
    ui: {
      input: vi.fn(async () => inputValues.shift()),
      select: vi.fn(async () => selectValues.shift()),
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
}

describe("PiS3SetupPrompter", () => {
  it("collects the short AWS S3 path using the default credential chain", async () => {
    const ctx = context(
      ["private-bucket", "us-west-2"],
      ["AWS S3", "Default AWS credential chain", "Use default target name and object prefix"],
    );

    await expect(new PiS3SetupPrompter(ctx).collect(initial)).resolves.toEqual({
      targetId: "backup",
      bucket: "private-bucket",
      region: "us-west-2",
      prefix: "session-hoarder",
      endpoint: "",
      profile: "",
      forcePathStyle: false,
    });
    expect(ctx.ui.input).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(ctx.ui.input).mock.calls)).not.toMatch(
      /access key|secret|token|encryption|kms/i,
    );
    expect(JSON.stringify(vi.mocked(ctx.ui.select).mock.calls)).not.toMatch(/encryption|kms/i);
  });

  it("collects a named profile without ever requesting its credentials", async () => {
    const ctx = context(
      ["private-bucket", "us-east-1", "company-sso"],
      ["AWS S3", "Named AWS profile", "Use default target name and object prefix"],
    );

    await expect(new PiS3SetupPrompter(ctx).collect(initial)).resolves.toMatchObject({
      profile: "company-sso",
    });
    expect(ctx.ui.input).toHaveBeenLastCalledWith("AWS profile name", "");
  });

  it("collects the required connection settings for an S3-compatible service", async () => {
    const ctx = context(
      ["minio-bucket", "us-east-1", "http://127.0.0.1:9000"],
      [
        "S3-compatible service (MinIO, RustFS, etc.)",
        "yes (current)",
        "Default AWS credential chain",
        "Use default target name and object prefix",
      ],
    );

    await expect(new PiS3SetupPrompter(ctx).collect(initial)).resolves.toMatchObject({
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
    });
  });

  it("collects advanced target settings only when selected", async () => {
    const ctx = context(
      ["bucket", "us-east-1", "archive", "team/sessions"],
      ["AWS S3", "Default AWS credential chain", "Configure target name and object prefix"],
    );

    await expect(new PiS3SetupPrompter(ctx).collect(initial)).resolves.toMatchObject({
      targetId: "archive",
      prefix: "team/sessions",
    });
  });

  it.each([
    [[], [undefined]],
    [[undefined], ["AWS S3"]],
    [["bucket", undefined], ["AWS S3"]],
    [
      ["bucket", "us-east-1"],
      ["AWS S3", undefined],
    ],
    [
      ["bucket", "us-east-1"],
      ["AWS S3", "Default AWS credential chain", "Cancel"],
    ],
  ])("cancels without producing a draft", async (inputs, selections) => {
    await expect(
      new PiS3SetupPrompter(context([...inputs], [...selections])).collect(initial),
    ).resolves.toBeUndefined();
  });

  it("cancels the compatible path when endpoint or path-style selection is dismissed", async () => {
    await expect(
      new PiS3SetupPrompter(
        context(
          ["bucket", "us-east-1", undefined],
          ["S3-compatible service (MinIO, RustFS, etc.)"],
        ),
      ).collect(initial),
    ).resolves.toBeUndefined();
    await expect(
      new PiS3SetupPrompter(
        context(
          ["bucket", "us-east-1", "http://127.0.0.1:9000"],
          ["S3-compatible service (MinIO, RustFS, etc.)", undefined],
        ),
      ).collect(initial),
    ).resolves.toBeUndefined();
  });

  it("requires a second explicit privacy confirmation for upload verification", async () => {
    const ctx = context([], ["Upload current session objects, verify, and save"]);
    ctx.ui.confirm = vi.fn(async () => false);
    const prompter = new PiS3SetupPrompter(ctx);
    await expect(
      prompter.confirmPreview({
        target: {
          targetId: "backup",
          bucket: "bucket",
          region: "us-east-1",
          prefix: "session-hoarder",
          forcePathStyle: false,
        },
        objectCount: 2,
        encodedBytes: 1024,
        endpointDisplay: "AWS default",
        profileDisplay: "default credential chain",
      }),
    ).resolves.toBe("cancel");
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Upload private Session Hoarder data?",
      expect.stringContaining("will not be deleted automatically"),
    );
  });

  it("formats only sanitized target details and bucket encryption settings in the preview", () => {
    const text = formatS3SetupPreview({
      target: {
        targetId: "backup",
        bucket: "bucket",
        region: "us-east-1",
        prefix: "session-hoarder",
        endpoint: "https://user:secret@example.test/?token=secret",
        profile: "private-profile",
        forcePathStyle: true,
      },
      objectCount: 1,
      encodedBytes: 50,
      endpointDisplay: "example.test",
      profileDisplay: "named profile",
    });
    expect(text).toContain("Endpoint   : example.test");
    expect(text).toContain("Profile    : named profile");
    expect(text).toContain("Encryption : bucket settings");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("private-profile");
  });
});
