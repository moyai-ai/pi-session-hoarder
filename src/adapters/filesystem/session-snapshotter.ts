import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type {
  CapturedSessionSnapshot,
  SessionSnapshotter,
  SourceBoundary,
} from "../../application/ports.js";
import { hasErrorCode, unlinkIfExists } from "./file-errors.js";

export interface LocalSessionSnapshotterDependencies {
  afterBoundaryCaptured?(size: number): Promise<void> | void;
}

/** Filesystem adapter that materializes an immutable view of Pi's append-only journal. */
export class LocalSessionSnapshotter implements SessionSnapshotter {
  private readonly temporaryRoot: string;
  private readonly dependencies: LocalSessionSnapshotterDependencies;

  constructor(temporaryRoot: string, dependencies: LocalSessionSnapshotterDependencies = {}) {
    this.temporaryRoot = temporaryRoot;
    this.dependencies = dependencies;
  }

  async inspect(sourcePath: string): Promise<SourceBoundary | undefined> {
    try {
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile()) throw new Error(`Pi session is not a regular file: ${sourcePath}`);
      return { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs };
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async capture(
    sourcePath: string,
    boundary: SourceBoundary,
    signal?: AbortSignal,
  ): Promise<CapturedSessionSnapshot> {
    signal?.throwIfAborted();
    await this.dependencies.afterBoundaryCaptured?.(boundary.size);
    await mkdir(this.temporaryRoot, { recursive: true });
    const snapshotPath = join(this.temporaryRoot, `${randomUUID()}.session.jsonl.tmp`);
    try {
      if (boundary.size === 0) {
        const handle = await open(snapshotPath, "wx", 0o600);
        await handle.close();
      } else {
        await pipeline(
          createReadStream(sourcePath, { start: 0, end: boundary.size - 1 }),
          createWriteStream(snapshotPath, { flags: "wx", mode: 0o600 }),
          { signal },
        );
      }
      const snapshotStat = await stat(snapshotPath);
      if (snapshotStat.size !== boundary.size) {
        throw new Error(
          `Pi session changed while capturing a stable boundary: expected ${boundary.size} bytes, captured ${snapshotStat.size}.`,
        );
      }
      return {
        path: snapshotPath,
        sourcePath,
        ...boundary,
        dispose: () => unlinkIfExists(snapshotPath),
      };
    } catch (error) {
      await unlinkIfExists(snapshotPath);
      throw error;
    }
  }
}

