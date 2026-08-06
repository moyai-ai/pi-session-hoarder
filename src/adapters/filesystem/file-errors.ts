import { unlink } from "node:fs/promises";

export async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export async function readOptionalTextRecord(
  path: string,
  readTextFile: (path: string) => Promise<string>,
  description: string,
): Promise<string | undefined> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw new Error(`Unable to read ${description} ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

export function validatePathSegment(value: string, name: string, description: string): void {
  if (value.length === 0 || value === "." || value === ".." || /[\\/\0]/.test(value)) {
    throw new Error(`Invalid ${description} ${name}: ${JSON.stringify(value)}.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
