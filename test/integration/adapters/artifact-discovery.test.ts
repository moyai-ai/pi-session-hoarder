import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PiSessionArtifactDiscovery } from "../../../src/adapters/filesystem/artifact-discovery.js";

const temporaryDirectories: string[] = [];
const discovery = new PiSessionArtifactDiscovery();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(lines: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "session-hoarder-artifacts-"));
  temporaryDirectories.push(directory);
  const session = join(directory, "session.jsonl");
  await writeFile(session, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return { directory, session };
}

function toolResult(id: string, details: Record<string, unknown>, toolName = "bash") {
  return {
    type: "message",
    id,
    message: { role: "toolResult", toolName, details },
  };
}

describe("discoverArtifacts", () => {
  it("discovers only allowlisted Bash fullOutputPath fields", async () => {
    const { directory, session } = await fixture([]);
    const output = join(directory, "bash-output.log");
    await writeFile(output, "complete output");
    await writeFile(
      session,
      [
        JSON.stringify({ type: "session", version: 3 }),
        JSON.stringify(toolResult("allowed", { fullOutputPath: output, unrelatedPath: "/secret" })),
        JSON.stringify(toolResult("wrong-tool", { fullOutputPath: "/secret" }, "read")),
        JSON.stringify({ type: "message", id: "custom", message: { role: "custom", details: { fullOutputPath: "/secret" } } }),
        JSON.stringify(toolResult("nested", { nested: { fullOutputPath: "/secret" } })),
      ].join("\n") + "\n",
    );

    const artifacts = await discovery.discover(session);

    expect(artifacts).toEqual([
      {
        path: output,
        relation: {
          kind: "pi-bash-full-output",
          sourceEntryId: "allowed",
          sourceField: "message.details.fullOutputPath",
          state: "captured",
        },
      },
    ]);
  });

  it("records missing and non-file sidecars as warnings", async () => {
    const { directory, session } = await fixture([]);
    const missing = join(directory, "missing.log");
    const notFile = join(directory, "folder");
    await mkdir(notFile);
    await writeFile(
      session,
      `${JSON.stringify(toolResult("missing", { fullOutputPath: missing }))}\n${JSON.stringify(toolResult("invalid", { fullOutputPath: notFile }))}\n`,
    );

    const artifacts = await discovery.discover(session);

    expect(artifacts.map((artifact) => artifact.relation.state)).toEqual(["missing", "invalid"]);
    expect(artifacts[0]?.relation.warning).toContain(missing);
    expect(artifacts[1]?.relation.warning).toContain("not a regular file");
  });

  it("keeps repeated references so their source-entry relations remain visible", async () => {
    const { directory, session } = await fixture([]);
    const output = join(directory, "output.log");
    await writeFile(output, "same output");
    await writeFile(
      session,
      `${JSON.stringify(toolResult("first", { fullOutputPath: output }))}\n${JSON.stringify(toolResult("second", { fullOutputPath: output }))}\n`,
    );

    const artifacts = await discovery.discover(session);

    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.path)).toEqual([output, output]);
  });

  it("fails explicitly for invalid JSONL", async () => {
    const { session } = await fixture([]);
    await writeFile(session, "{\n");

    await expect(discovery.discover(session)).rejects.toThrow("line 1");
  });
});
