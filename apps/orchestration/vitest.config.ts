import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const skillsDir = fileURLToPath(new URL("../../.pi/skills", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    // The package-local test cwd is not Penny's root; ignore ambient checkout overrides.
    env: { PENNY_SKILLS_DIR: skillsDir },
    include: [
      "apps/orchestration/tests/**/*.test.ts",
      "tests/**/*.test.ts",
      "smoke/kb-model-smoke-contract.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // External CPU qualification is explicit opt-in, even when bindings are ambient.
      "apps/orchestration/tests/videogen-media-cpu.test.ts",
      "tests/videogen-media-cpu.test.ts",
      // Actual native/CPU qualification has its own explicit, fail-closed entry point.
      "apps/orchestration/tests/videogen-native-production.test.ts",
      "apps/orchestration/tests/videogen-native-production-owner.test.ts",
      "tests/videogen-native-production.test.ts",
      "tests/videogen-native-production-owner.test.ts",
      "apps/orchestration/tests/videogen-default-native-flow.test.ts",
      "tests/videogen-default-native-flow.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
