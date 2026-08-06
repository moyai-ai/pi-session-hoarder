import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

async function importsUnder(directory: string): Promise<Array<{ path: string; source: string }>> {
  const results: Array<{ path: string; source: string }> = [];
  for (const path of await sourceFiles(directory)) {
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
      results.push({ path, source: match[1]! });
    }
  }
  return results;
}

describe("architectural dependency rules", () => {
  it("keeps the domain independent of application, adapters, Pi, and Node I/O", async () => {
    const imports = await importsUnder("src/domain");
    const domainRoot = `${resolve("src/domain")}${sep}`;
    const forbidden = imports.filter(({ path, source }) => {
      if (!source.startsWith(".")) return true;
      return !resolve(dirname(path), source).startsWith(domainRoot);
    });

    expect(forbidden).toEqual([]);
  });

  it("keeps the application layer independent of adapters and Pi entrypoints", async () => {
    const imports = await importsUnder("src/application");
    const forbidden = imports.filter(
      ({ source }) =>
        source.includes("/adapters/") ||
        source.includes("/entrypoints/") ||
        source.includes("bootstrap") ||
        source === "@earendil-works/pi-coding-agent",
    );

    expect(forbidden).toEqual([]);
  });

  it("keeps concrete adapter construction out of Pi entrypoints", async () => {
    const imports = await importsUnder("src/entrypoints");
    const forbidden = imports.filter(({ source }) => source.includes("/adapters/"));

    expect(forbidden).toEqual([]);
  });

  it("keeps active session state independent of the Pi host API", async () => {
    const imports = await importsUnder("src/entrypoints");
    const forbidden = imports.filter(
      ({ path, source }) =>
        path.endsWith("active-session.ts") && source === "@earendil-works/pi-coding-agent",
    );

    expect(forbidden).toEqual([]);
  });
});
