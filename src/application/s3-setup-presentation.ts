export function sanitizedEndpointDisplay(endpoint: string | undefined): string {
  if (!endpoint) return "AWS default";
  try {
    return new URL(endpoint).host;
  } catch {
    return "configured endpoint";
  }
}

export function sanitizedProfileDisplay(profile: string | undefined): string {
  return profile ? "named profile" : "default credential chain";
}

export function categorizeS3SetupError(error: unknown): string {
  const details = errorDetails(error);
  const name = details?.sourceName?.toLowerCase() ?? "";
  const status = details?.statusCode;
  return (
    credentialFailure(name, status) ??
    authorizationFailure(name, status) ??
    encryptionFailure(name) ??
    regionFailure(name, status) ??
    networkFailure(name, status) ??
    serviceFailure(status) ??
    "target verification failed; check bucket, region, endpoint, profile, and bucket policy settings"
  );
}

function credentialFailure(name: string, status: number | undefined): string | undefined {
  return name.includes("credential") || name.includes("token") || status === 401
    ? "credential chain did not provide usable credentials"
    : undefined;
}

function authorizationFailure(name: string, status: number | undefined): string | undefined {
  return name.includes("accessdenied") || name.includes("forbidden") || status === 403
    ? "credentials are not authorized for the bucket or encryption policy"
    : undefined;
}

function encryptionFailure(name: string): string | undefined {
  return name.includes("kms") || name.includes("encryption")
    ? "server-side encryption or KMS settings were rejected"
    : undefined;
}

function regionFailure(name: string, status: number | undefined): string | undefined {
  return name.includes("region") || name.includes("redirect") || status === 301
    ? "bucket region does not match the configured region"
    : undefined;
}

function networkFailure(name: string, status: number | undefined): string | undefined {
  return name.includes("timeout") || name.includes("network") || status === 408
    ? "network or endpoint connection failed"
    : undefined;
}

function serviceFailure(status: number | undefined): string | undefined {
  return status !== undefined && status >= 500
    ? "S3 service is temporarily unavailable"
    : undefined;
}

function errorDetails(error: unknown): { statusCode?: number; sourceName?: string } | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) return undefined;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return undefined;
  const value = details as { statusCode?: unknown; sourceName?: unknown };
  return compactDetails(value.statusCode, value.sourceName);
}

function compactDetails(statusCode: unknown, sourceName: unknown) {
  return {
    ...(typeof statusCode === "number" ? { statusCode } : {}),
    ...(typeof sourceName === "string" ? { sourceName } : {}),
  };
}
