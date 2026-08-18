import { homedir } from "node:os";
import path from "node:path";

export const ORCHESTRATION_SCHEMA_VERSION = 2 as const;
export const TYPESCRIPT_ENGINE_OWNER = "typescript" as const;
export const DEFAULT_DB_RELATIVE_PATH = ".penny/orchestration-v2.db";
export const DEFAULT_MAX_STEPS = 96;
export const DEFAULT_WORKER_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_PARALLEL_CONCURRENCY = 4;
/** Default cap on retained terminal runs; older terminal runs are pruned. */
export const DEFAULT_MAX_RETAINED_RUNS = 500;

export interface RuntimeConfig {
  readonly projectRoot: string;
  readonly dbPath: string;
  readonly artifactRoot: string;
  readonly maxSteps: number;
  readonly workerTimeoutMs: number;
  readonly parallelConcurrency: number;
  /** Bounded retention: maximum terminal runs to keep before pruning oldest. */
  readonly maxRetainedRuns: number;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
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
  const resolvedProjectRoot = path.resolve(projectRoot);
  const configuredDbPath = env.PENNY_ORCH_V2_DB;
  if (configuredDbPath && !path.isAbsolute(configuredDbPath)) {
    throw new Error("PENNY_ORCH_V2_DB must be an absolute path");
  }
  const dbPath = configuredDbPath
    ? path.normalize(configuredDbPath)
    : path.join(resolvedProjectRoot, DEFAULT_DB_RELATIVE_PATH);
  const configuredArtifactRoot = env.PENNY_ARTIFACT_ROOT?.trim();
  const configuredStateHome = env.XDG_STATE_HOME?.trim();
  if (configuredArtifactRoot && !path.isAbsolute(configuredArtifactRoot)) {
    throw new Error("PENNY_ARTIFACT_ROOT must be an absolute path");
  }
  if (configuredStateHome && !path.isAbsolute(configuredStateHome)) {
    throw new Error("XDG_STATE_HOME must be an absolute path");
  }
  const artifactRoot = configuredArtifactRoot
    ? path.normalize(configuredArtifactRoot)
    : configuredStateHome
      ? path.join(configuredStateHome, "penny", "artifacts")
      : path.join(homedir(), ".local", "state", "penny", "artifacts");
  return {
    projectRoot: resolvedProjectRoot,
    dbPath,
    artifactRoot,
    maxSteps: parsePositiveInteger(
      env.PENNY_ORCH_V2_MAX_STEPS,
      DEFAULT_MAX_STEPS,
      "PENNY_ORCH_V2_MAX_STEPS"
    ),
    workerTimeoutMs: parsePositiveInteger(
      env.PENNY_ORCH_V2_WORKER_TIMEOUT_MS,
      DEFAULT_WORKER_TIMEOUT_MS,
      "PENNY_ORCH_V2_WORKER_TIMEOUT_MS"
    ),
    parallelConcurrency: parsePositiveInteger(
      env.PENNY_ORCH_V2_PARALLEL_CONCURRENCY,
      DEFAULT_PARALLEL_CONCURRENCY,
      "PENNY_ORCH_V2_PARALLEL_CONCURRENCY"
    ),
    maxRetainedRuns: parsePositiveInteger(
      env.PENNY_ORCH_V2_MAX_RETAINED_RUNS,
      DEFAULT_MAX_RETAINED_RUNS,
      "PENNY_ORCH_V2_MAX_RETAINED_RUNS"
    ),
  };
}
