import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalCheckpointApplication } from "../../src/bootstrap.js";
import { LocalSessionArchiveRepository } from "../../src/adapters/filesystem/local-session-archive-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "session-hoarder-checkpoint-"));
  temporaryDirectories.push(directory);
  const storageRoot = join(directory, "store");
  const application = createLocalCheckpointApplication(storageRoot, {
    now: () => new Date("2026-08-03T12:00:00.000Z"),
  });
  const repository = new LocalSessionArchiveRepository(storageRoot);
  return {
    directory,
    sessionFile: join(directory, "session.jsonl"),
    objectStore: application.unitOfWorkFactory.objectStore,
    repository,
    checkpoint: application.service,
    request: {
      repositoryId: "repo",
      sessionId: "session",
      sessionFile: join(directory, "session.jsonl"),
    },
  };
}

function toolResult(id: string, fullOutputPath: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-03T12:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "bash",
      content: [{ type: "text", text: "truncated" }],
      details: { fullOutputPath },
      isError: false,
      timestamp: Date.now(),
    },
  };
}

describe("CheckpointService", () => {
  it("captures a session and repeated sidecar references into verified CAS objects", async () => {
    const context = await fixture();
    const sidecar = join(context.directory, "full-output.log");
    await writeFile(sidecar, "complete output\n");
    await writeFile(
      context.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n${JSON.stringify(toolResult("one", sidecar))}\n${JSON.stringify(toolResult("two", sidecar))}\n`,
    );

    const result = required(await context.checkpoint.checkpoint(context.request));

    expect(result.changed).toBe(true);
    expect(result.record.revision).toBe(1);
    expect(result.record.artifacts).toHaveLength(2);
    expect(result.record.artifacts[0]?.object?.digest).toBe(
      result.record.artifacts[1]?.object?.digest,
    );
    expect((await context.objectStore.verify(result.record.sessionObject)).valid).toBe(true);
    expect((await context.objectStore.verify(result.record.artifacts[0]!.object!)).valid).toBe(
      true,
    );
    const persisted = await context.repository.get(context.request);
    expect(persisted?.record).toEqual(result.record);
  });

  it("does not rehash an unchanged session", async () => {
    const context = await fixture();
    await writeFile(
      context.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    const first = required(await context.checkpoint.checkpoint(context.request));

    const second = required(await context.checkpoint.checkpoint(context.request));

    expect(second).toEqual({ changed: false, record: first.record });
  });

  it("creates a later revision after an append", async () => {
    const context = await fixture();
    await writeFile(
      context.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n`,
    );
    await context.checkpoint.checkpoint(context.request);
    await appendFile(
      context.sessionFile,
      `${JSON.stringify({ type: "message", id: "next", message: { role: "user", content: "hello" } })}\n`,
    );

    const second = required(await context.checkpoint.checkpoint(context.request));

    expect(second.changed).toBe(true);
    expect(second.record.revision).toBe(2);
    const decoded: Buffer[] = [];
    for await (const chunk of context.objectStore.openDecoded(second.record.sessionObject)) {
      decoded.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(decoded).toString("utf8")).toBe(
      await readFile(context.sessionFile, "utf8"),
    );
  });

  it("preserves embedded image blocks as part of the immutable session bytes", async () => {
    const context = await fixture();
    const session = `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n${JSON.stringify(
      {
        type: "message",
        id: "image",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              data: Buffer.from("image-bytes").toString("base64"),
              mimeType: "image/png",
            },
          ],
        },
      },
    )}\n`;
    await writeFile(context.sessionFile, session);

    const result = required(await context.checkpoint.checkpoint(context.request));
    const decoded: Buffer[] = [];
    for await (const chunk of context.objectStore.openDecoded(result.record.sessionObject)) {
      decoded.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(decoded).toString("utf8")).toBe(session);
  });

  it("streams a 50+ MiB session through checkpointing", async () => {
    const context = await fixture();
    const output = createWriteStream(context.sessionFile);
    output.write(`${JSON.stringify({ type: "session", version: 3, id: "large" })}\n`);
    const content = "x".repeat(1024 * 1024);
    for (let index = 0; index < 50; index += 1) {
      const line = `${JSON.stringify({
        type: "message",
        id: `large-${index}`,
        message: { role: "custom", customType: "fixture", content, display: false },
      })}\n`;
      if (!output.write(line)) await once(output, "drain");
    }
    output.end();
    await once(output, "close");

    const result = required(await context.checkpoint.checkpoint(context.request));

    expect(result.record.sessionObject.logicalBytes).toBeGreaterThan(50 * 1024 * 1024);
    expect((await context.objectStore.verify(result.record.sessionObject)).valid).toBe(true);
    expect(await readdir(context.objectStore.temporaryRoot)).toEqual([]);
  }, 30_000);

  it("replaces a captured object when the same sidecar relation changes content", async () => {
    const context = await fixture();
    const sidecar = join(context.directory, "changing-output.log");
    await writeFile(sidecar, "first output");
    await writeFile(
      context.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n${JSON.stringify(toolResult("artifact", sidecar))}\n`,
    );
    const first = required(await context.checkpoint.checkpoint(context.request));
    const previous = first.record.artifacts[0]?.object;
    expect(previous).toBeDefined();
    await writeFile(sidecar, "replacement output");
    await appendFile(
      context.sessionFile,
      `${JSON.stringify({ type: "custom", id: "changed-sidecar" })}\n`,
    );

    const second = required(await context.checkpoint.checkpoint(context.request));
    const replacement = second.record.artifacts[0]?.object;

    expect(replacement).toBeDefined();
    expect(replacement?.digest).not.toBe(previous?.digest);
    expect(second.record.artifacts[0]).toMatchObject({
      sourceState: "present",
      archiveState: "captured",
      object: replacement,
    });
  });

  it("preserves captured sidecar identity when its source later disappears", async () => {
    const context = await fixture();
    const sidecar = join(context.directory, "full-output.log");
    await writeFile(sidecar, "complete output");
    await writeFile(
      context.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n${JSON.stringify(toolResult("artifact", sidecar))}\n`,
    );
    const first = required(await context.checkpoint.checkpoint(context.request));
    const captured = first.record.artifacts[0]?.object;
    expect(captured).toBeDefined();
    await rm(sidecar);
    await writeFile(
      context.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n${JSON.stringify(toolResult("artifact", sidecar))}\n${JSON.stringify({ type: "custom", id: "changed" })}\n`,
    );

    const second = required(await context.checkpoint.checkpoint(context.request));

    expect(second.record.artifacts[0]).toMatchObject({
      sourceEntryId: "artifact",
      sourceState: "missing",
      archiveState: "captured",
      object: captured,
    });
    expect(second.record.revision).toBe(first.record.revision + 1);

    await writeFile(
      context.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "compacted" })}\n`,
    );
    const compacted = required(await context.checkpoint.checkpoint(context.request));
    expect(compacted.record.artifacts).toEqual([]);
  });

  it("records missing sidecars without failing the session checkpoint", async () => {
    const context = await fixture();
    const missing = join(context.directory, "missing.log");
    await writeFile(
      context.sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n${JSON.stringify(toolResult("missing", missing))}\n`,
    );

    const result = required(await context.checkpoint.checkpoint(context.request));

    expect(result.changed).toBe(true);
    expect(result.record.artifacts).toHaveLength(1);
    expect(result.record.artifacts[0]).toMatchObject({
      sourceState: "missing",
      archiveState: "unavailable",
      sourceEntryId: "missing",
    });
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a persisted checkpoint");
  return value;
}
