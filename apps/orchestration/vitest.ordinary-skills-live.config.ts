import { defineConfig } from "vitest/config";
import {
  COHORT_ENV,
  LIVE_GATE,
  parseCohortSelection,
  EXPECTED_GENERATION_ENV,
  requireExpectedGeneration,
} from "./smoke/ordinary-skills-live-contract.js";

// Validate selection before test collection/SDK creation, including unknown ambient selections.
if (process.env[LIVE_GATE] === "1" || process.env[COHORT_ENV] !== undefined)
  parseCohortSelection(process.env[COHORT_ENV]);
if (process.env[LIVE_GATE] === "1") requireExpectedGeneration(process.env[EXPECTED_GENERATION_ENV]);

export default defineConfig({
  test: {
    include: ["smoke/ordinary-skills-live.test.ts"],
    // Explicit cohort + live opt-in + parent source-freeze attestation in the test.
    // No elapsed deadline for productive provider work.
    testTimeout: 0,
    hookTimeout: 0,
    fileParallelism: false,
    // Production factories use process.cwd(); the disposable project needs a process-local cwd.
    pool: "forks",
  },
});
