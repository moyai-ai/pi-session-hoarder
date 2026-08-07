import { spawnSync } from "node:child_process";

import { defineConfig } from "vitest/config";

const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const dockerAvailable = docker.status === 0;

if (!dockerAvailable) {
  process.stdout.write(
    "Skipping S3 container tests: a reachable Docker daemon is not available.\n",
  );
}

export default defineConfig({
  test: {
    include: dockerAvailable ? ["test/s3/**/*.test.ts"] : [],
    passWithNoTests: !dockerAvailable,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
