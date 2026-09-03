import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: [
      "tests/integration/evaluation-*.test.ts",
      "tests/integration/plan-part-b-preregistration.integration.test.ts",
    ],
    environment: "node",
    globals: true,
    testTimeout: 30000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
