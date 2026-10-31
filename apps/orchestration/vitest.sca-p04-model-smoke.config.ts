import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["smoke/sca-p04-deepseek-smoke.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
