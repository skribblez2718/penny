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
    include: ["tests/unit/**/*.test.ts", "tests/skill.test.ts", "tests/agent-end-grace.test.ts"],
    exclude: ["tests/unit/*evaluation*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 10000,
    env: {
      PENNY_SKILLS_DIR: skillSourceRoot,
    },
  },
});
