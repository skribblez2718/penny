import { defineConfig } from "vitest/config";

// External CPU qualification only; the suite refuses absent/invalid caller bindings.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/orchestration/tests/videogen-media-cpu.test.ts",
      "tests/videogen-media-cpu.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
