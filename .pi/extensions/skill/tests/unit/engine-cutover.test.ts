/**
 * M7 cutover — TypeScript is the default engine for new single research runs.
 *
 * Approved by the operator on 2026-08-18 (readiness check `default-switch`).
 * These tests pin the three properties that make the cutover safe to live with:
 * it is reversible by environment, an explicit argument outranks the environment,
 * and a bad flag value degrades to the default instead of stranding research.
 *
 * Owner-stickiness is NOT tested here because it is not this function's job: this
 * resolver only chooses an owner for a run that does not yet exist. Continuation of
 * an existing run is decided by the engine that started it, and the two engines use
 * separate databases (asserted in apps/orchestration research-parity.test.ts:
 * "uses a separate v2 database without mutating the legacy Python database").
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_ENGINE, ENGINE_ENV_VAR, resolveEngineForNewRun } from "../../engine-selection.js";

describe("M7 cutover: default engine for new runs", () => {
  it("defaults to TypeScript when nothing is specified", () => {
    expect(resolveEngineForNewRun(undefined, {})).toBe("typescript");
    expect(DEFAULT_ENGINE).toBe("typescript");
  });

  it("names the documented rollback environment variable", () => {
    expect(ENGINE_ENV_VAR).toBe("PENNY_ORCHESTRATION_ENGINE");
  });

  it("is reversible: PENNY_ORCHESTRATION_ENGINE=python returns new runs to Python", () => {
    expect(resolveEngineForNewRun(undefined, { PENNY_ORCHESTRATION_ENGINE: "python" })).toBe(
      "python"
    );
  });

  it("honors an explicit environment selection of typescript", () => {
    expect(resolveEngineForNewRun(undefined, { PENNY_ORCHESTRATION_ENGINE: "typescript" })).toBe(
      "typescript"
    );
  });

  it("lets an explicit per-call argument outrank the environment, both directions", () => {
    expect(resolveEngineForNewRun("python", { PENNY_ORCHESTRATION_ENGINE: "typescript" })).toBe(
      "python"
    );
    expect(resolveEngineForNewRun("typescript", { PENNY_ORCHESTRATION_ENGINE: "python" })).toBe(
      "typescript"
    );
  });

  it("fails safe: an unrecognized flag value falls back to the default", () => {
    // A typo must not strand research or throw at dispatch time.
    expect(resolveEngineForNewRun(undefined, { PENNY_ORCHESTRATION_ENGINE: "typscript" })).toBe(
      "typescript"
    );
    expect(resolveEngineForNewRun(undefined, { PENNY_ORCHESTRATION_ENGINE: "" })).toBe(
      "typescript"
    );
    expect(resolveEngineForNewRun("nonsense", {})).toBe("typescript");
  });

  it("tolerates surrounding whitespace in the environment value", () => {
    expect(resolveEngineForNewRun(undefined, { PENNY_ORCHESTRATION_ENGINE: "  python  " })).toBe(
      "python"
    );
  });
});
