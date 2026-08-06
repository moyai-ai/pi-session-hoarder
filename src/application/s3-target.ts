export function normalizeS3Prefix(prefix: string): string {
  if (/\p{Cc}/u.test(prefix) || prefix.includes("\\")) {
    throw new Error("S3 object prefix must not contain control characters or backslashes.");
  }
  const segments = prefix
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.some(isUnsafePathSegment)) {
    throw new Error('S3 object prefix must not contain "." or ".." path segments.');
  }
  return segments.join("/");
}

function isUnsafePathSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}
