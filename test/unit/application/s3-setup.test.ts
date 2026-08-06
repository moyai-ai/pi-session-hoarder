import { describe, expect, it } from "vitest";

import {
  categorizeS3SetupError,
  sanitizedEndpointDisplay,
  sanitizedProfileDisplay,
} from "../../../src/application/s3-setup-presentation.js";
import { setupDraftFromTarget } from "../../../src/application/s3-setup.js";
import { fingerprintDraftTarget } from "../../../src/bootstrap.js";

describe("S3 setup presentation", () => {
  it("builds credential-free defaults without exposing environment values", () => {
    expect(setupDraftFromTarget(undefined, "/global/session-hoarder.json", "eu-west-1")).toEqual({
      globalConfigPath: "/global/session-hoarder.json",
      targetId: "backup",
      bucket: "",
      region: "eu-west-1",
      prefix: "session-hoarder",
      endpoint: "",
      profile: "",
      forcePathStyle: false,
    });
  });

  it("sanitizes endpoint and profile previews", () => {
    expect(
      sanitizedEndpointDisplay("https://user:secret@objects.example.test/path?token=secret"),
    ).toBe("objects.example.test");
    expect(sanitizedEndpointDisplay(undefined)).toBe("AWS default");
    expect(sanitizedProfileDisplay("private-profile-name")).toBe("named profile");
    expect(sanitizedProfileDisplay(undefined)).toBe("default credential chain");
  });

  it("isolates draft receipts when routing changes under the same user-facing target ID", () => {
    const base = {
      targetId: "backup",
      bucket: "bucket-a",
      region: "us-east-1",
      prefix: "session-hoarder",
      forcePathStyle: false,
    };
    expect(fingerprintDraftTarget(base)).toMatch(/^setup-[a-f0-9]{32}$/);
    expect(fingerprintDraftTarget(base)).not.toBe(
      fingerprintDraftTarget({ ...base, bucket: "bucket-b" }),
    );
  });

  it.each([
    [{ statusCode: 401, sourceName: "CredentialsProviderError" }, "credential chain"],
    [{ statusCode: 403, sourceName: "AccessDenied" }, "not authorized"],
    [{ statusCode: 301, sourceName: "PermanentRedirect" }, "region"],
    [{ statusCode: 503, sourceName: "ServiceUnavailable" }, "temporarily unavailable"],
  ])("maps unsafe remote failures to actionable categories", (details, expected) => {
    const error = Object.assign(new Error("Authorization=Bearer secret"), { details });
    const message = categorizeS3SetupError(error);
    expect(message).toContain(expected);
    expect(message).not.toContain("secret");
  });
});
