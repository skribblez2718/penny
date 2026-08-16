import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/clean-machine/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
