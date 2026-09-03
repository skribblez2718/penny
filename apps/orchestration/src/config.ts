import path from "node:path";

import { resolvePennyRuntimeState } from "./state/setup.js";

export const ORCHESTRATION_SCHEMA_VERSION = 2 as const;
export const TYPESCRIPT_ENGINE_OWNER = "typescript" as const;
export const DEFAULT_MAX_STEPS = 96;
export const DEFAULT_WORKER_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_PARALLEL_CONCURRENCY = 4;
/** Default cap on retained terminal run cohorts and their correlated worker sessions. */
export const DEFAULT_MAX_RETAINED_RUNS = 500;

const RETIRED_PATH_SELECTORS = [
  "PENNY_ORCH_DB",
  "PENNY_ORCH_V2_DB",
  "PENNY_ARTIFACT_ROOT",
  "PI_OBSERVABILITY_URL",
  "PI_OBSERVABILITY_DATA_DIR",
] as const;
const RETIRED_VERSIONED_LIMITS = [
  "PENNY_ORCH_V2_MAX_STEPS",
  "PENNY_ORCH_V2_WORKER_TIMEOUT_MS",
  "PENNY_ORCH_V2_PARALLEL_CONCURRENCY",
  "PENNY_ORCH_V2_MAX_RETAINED_RUNS",
] as const;

export interface RuntimeConfig {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly dbPath: string;
  readonly receiptKeyPath: string;
  readonly artifactRoot: string;
  readonly subagentSessionRoot: string;
  readonly maxSteps: number;
  readonly workerTimeoutMs: number;
  readonly parallelConcurrency: number;
  /** Bounded retention: maximum terminal run cohorts to keep before pruning oldest. */
  readonly maxRetainedRuns: number;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function rejectRetiredConfiguration(
  env: Readonly<Record<string, string | undefined>>
): void {
  for (const name of [...RETIRED_PATH_SELECTORS, ...RETIRED_VERSIONED_LIMITS]) {
    if (env[name]?.trim()) {
      throw new Error(
        `${name} is retired; initialize the Pi-native Penny state root and use unversioned configuration`
      );
    }
  }
}

export function assertSupportedRuntime(): void {
  if (process.release.name !== "node") {
    throw new Error("TypeScript orchestration requires the Node.js runtime");
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isSafeInteger(major) || major < 22) {
    throw new Error("TypeScript orchestration requires Node.js 22 or newer");
  }
}

export function loadRuntimeConfig(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  assertSupportedRuntime();
  rejectRetiredConfiguration(env);
  const resolved = resolvePennyRuntimeState(path.resolve(projectRoot), { env });
  return {
    projectId: resolved.projectId,
    projectRoot: resolved.canonicalProjectRoot,
    stateRoot: resolved.state.root,
    dbPath: resolved.paths.orchestration.database,
    receiptKeyPath: resolved.paths.orchestration.receiptKey,
    artifactRoot: resolved.paths.artifacts.root,
    subagentSessionRoot: resolved.paths.subagentSessions,
    maxSteps: parsePositiveInteger(
      env.PENNY_ORCHESTRATION_MAX_STEPS,
      DEFAULT_MAX_STEPS,
      "PENNY_ORCHESTRATION_MAX_STEPS"
    ),
    workerTimeoutMs: parsePositiveInteger(
      env.PENNY_ORCHESTRATION_WORKER_TIMEOUT_MS,
      DEFAULT_WORKER_TIMEOUT_MS,
      "PENNY_ORCHESTRATION_WORKER_TIMEOUT_MS"
    ),
    parallelConcurrency: parsePositiveInteger(
      env.PENNY_ORCHESTRATION_PARALLEL_CONCURRENCY,
      DEFAULT_PARALLEL_CONCURRENCY,
      "PENNY_ORCHESTRATION_PARALLEL_CONCURRENCY"
    ),
    maxRetainedRuns: parsePositiveInteger(
      env.PENNY_ORCHESTRATION_MAX_RETAINED_RUNS,
      DEFAULT_MAX_RETAINED_RUNS,
      "PENNY_ORCHESTRATION_MAX_RETAINED_RUNS"
    ),
  };
}
