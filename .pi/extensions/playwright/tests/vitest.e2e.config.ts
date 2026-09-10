import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 60000,
    retry: 0,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
