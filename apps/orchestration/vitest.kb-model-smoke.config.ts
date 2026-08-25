import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["smoke/kb-model-smoke.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 65 * 60_000,
    hookTimeout: 60_000,
  },
});
