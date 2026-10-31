import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/orchestration/tests/videogen-native-production.test.ts",
      "apps/orchestration/tests/videogen-native-production-owner.test.ts",
      "tests/videogen-native-production.test.ts",
      "tests/videogen-native-production-owner.test.ts",
      "apps/orchestration/tests/videogen-default-native-flow.test.ts",
      "tests/videogen-default-native-flow.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 30_000,
  },
});
