import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/s3/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
