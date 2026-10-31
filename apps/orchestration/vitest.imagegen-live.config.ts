import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["smoke/imagegen-backend-live-smoke.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
  },
});
