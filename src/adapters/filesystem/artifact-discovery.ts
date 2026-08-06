import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { ArtifactDiscovery, DiscoveredArtifact } from "../../application/ports.js";

export interface LocalArtifactDiscoveryDependencies {
  statPath(path: string): Promise<{ isFile(): boolean }>;
}

const defaultDependencies: LocalArtifactDiscoveryDependencies = { statPath: stat };

/** Schema-driven adapter for the single S1 sidecar allowlist entry. */
export class PiSessionArtifactDiscovery implements ArtifactDiscovery {
  private readonly dependencies: LocalArtifactDiscoveryDependencies;

  constructor(dependencyOverrides: Partial<LocalArtifactDiscoveryDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides };
  }

  async discover(sessionSnapshotPath: string): Promise<readonly DiscoveredArtifact[]> {
    const input = createReadStream(sessionSnapshotPath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const artifacts: DiscoveredArtifact[] = [];
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (line.trim().length === 0) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `Invalid Pi session JSONL at line ${lineNumber}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
        const candidate = getBashFullOutputCandidate(entry);
        if (!candidate) continue;
        const relationBase = {
          kind: "pi-bash-full-output" as const,
          sourceEntryId: candidate.sourceEntryId,
          sourceField: "message.details.fullOutputPath" as const,
        };
        try {
          const pathStat = await this.dependencies.statPath(candidate.path);
          if (!pathStat.isFile()) {
            artifacts.push({
              relation: {
                ...relationBase,
                state: "invalid",
                warning: `Bash full output path is not a regular file: ${candidate.path}`,
              },
            });
          } else {
            artifacts.push({
              path: candidate.path,
              relation: { ...relationBase, state: "captured" },
            });
          }
        } catch (error) {
          artifacts.push({
            relation: {
              ...relationBase,
              state: "missing",
              warning: `Bash full output path is unavailable: ${candidate.path} (${errorMessage(error)})`,
            },
          });
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return artifacts;
  }
}

function getBashFullOutputCandidate(
  value: unknown,
): { sourceEntryId: string; path: string } | undefined {
  const entry = getMessageEntry(value);
  if (!entry) return undefined;
  const path = getBashFullOutputPath(entry.message);
  return path ? { sourceEntryId: entry.id, path } : undefined;
}

function getMessageEntry(
  value: unknown,
): { id: string; message: Record<string, unknown> } | undefined {
  if (!isRecord(value) || value.type !== "message" || typeof value.id !== "string")
    return undefined;
  return isRecord(value.message) ? { id: value.id, message: value.message } : undefined;
}

function getBashFullOutputPath(message: Record<string, unknown>): string | undefined {
  if (message.role !== "toolResult" || message.toolName !== "bash") return undefined;
  const details = message.details;
  if (!isRecord(details) || typeof details.fullOutputPath !== "string") return undefined;
  return details.fullOutputPath.length > 0 ? details.fullOutputPath : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
