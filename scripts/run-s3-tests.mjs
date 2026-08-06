import { spawnSync } from "node:child_process";

const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (docker.status !== 0) {
  process.stdout.write(
    "Skipping S3 container tests: a reachable Docker daemon is not available.\n",
  );
  process.exit(0);
}

const vitest = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.s3.config.ts"],
  { stdio: "inherit" },
);

if (vitest.error) throw vitest.error;
process.exit(vitest.status ?? 1);
