import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const skillSourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "skills"
);

export default defineConfig({
  test: {
    include: [
      "tests/unit/*evaluation*.test.ts",
      "tests/integration/evaluation-*.test.ts",
      "tests/integration/plan-part-b-preregistration.integration.test.ts",
      "tests/e2e/*known-delta*.test.ts",
    ],
    environment: "node",
    globals: true,
    testTimeout: 60000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    env: {
      PENNY_SKILLS_DIR: skillSourceRoot,
    },
  },
});
