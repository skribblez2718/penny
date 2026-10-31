import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["smoke/imagegen-security-inspection.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 10 * 60_000,
    hookTimeout: 60_000,
  },
});
