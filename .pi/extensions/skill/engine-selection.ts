/**
 * Engine selection policy for new single research runs (M7 cutover, 2026-08-18).
 *
 * TypeScript became the default owner for new runs on operator approval of the M7
 * `default-switch` readiness check. This module is deliberately dependency-free so
 * the policy can be tested without loading the extension's runtime surface.
 *
 * Three properties are load-bearing:
 *
 *  1. **Reversible.** `PENNY_ORCHESTRATION_ENGINE=python` returns new runs to the
 *     legacy engine with no code change or deployment. An explicit per-call
 *     `engine` argument outranks the environment.
 *  2. **Owner-sticky.** This resolver only chooses an owner for a run that does not
 *     yet exist. An existing run is continued by the engine that started it; the two
 *     engines use separate databases and checkpoints are never converted.
 *  3. **Fail-safe.** An unrecognized value falls back to the default rather than
 *     throwing, so a typo cannot strand research mid-workflow.
 */

export type EngineChoice = "python" | "typescript";

/** The engine that owns a new run when nothing overrides it. */
export const DEFAULT_ENGINE: EngineChoice = "typescript";

/** Environment variable that rolls new runs back to the legacy engine. */
export const ENGINE_ENV_VAR = "PENNY_ORCHESTRATION_ENGINE";

function asEngineChoice(value: string | undefined): EngineChoice | undefined {
  const normalized = value?.trim();
  return normalized === "python" || normalized === "typescript" ? normalized : undefined;
}

/**
 * Resolve the engine for a NEW single research run.
 *
 * Precedence: explicit argument → environment → default.
 */
export function resolveEngineForNewRun(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): EngineChoice {
  return asEngineChoice(explicit) ?? asEngineChoice(env[ENGINE_ENV_VAR]) ?? DEFAULT_ENGINE;
}
