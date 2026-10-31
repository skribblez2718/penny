import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["smoke/imagegen-canary.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
});
