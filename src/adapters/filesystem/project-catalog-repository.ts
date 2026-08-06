import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  ProjectCatalogWriter,
  ProjectSessionCatalog,
} from "../../application/project-catalog.js";
import { atomicWriteFile } from "./atomic-file.js";
import { hasErrorCode, validatePathSegment } from "./file-errors.js";

export class WorktreeProjectCatalogRepository implements ProjectCatalogWriter {
  async write(
    worktreeRoot: string,
    sessionId: string,
    catalog: ProjectSessionCatalog,
  ): Promise<string> {
    validatePathSegment(sessionId, "sessionId", "project catalog");
    if (catalog.sessionId !== sessionId) {
      throw new Error("Project catalog session identity does not match its destination.");
    }
    const path = join(worktreeRoot, ".pi", "session-hoarder", "catalog", `${sessionId}.json`);
    const existing = await readExistingCatalog(path);
    if (existing?.revision === catalog.revision) {
      if (isDeepStrictEqual(existing.value, catalog)) return path;
      throw new Error(
        `Project catalog revision ${catalog.revision} is immutable and differs from the requested projection.`,
      );
    }
    if (existing !== undefined && existing.revision > catalog.revision) {
      throw new Error(
        `Project catalog revision would move backward from ${existing.revision} to ${catalog.revision}.`,
      );
    }
    await atomicWriteFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
    return path;
  }
}

async function readExistingCatalog(
  path: string,
): Promise<{ revision: number; value: unknown } | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Existing project catalog contains invalid JSON: ${path}.`);
  }
  const revision =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as { revision?: unknown }).revision
      : undefined;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new Error(`Existing project catalog has an invalid revision: ${path}.`);
  }
  return { revision: revision as number, value };
}
