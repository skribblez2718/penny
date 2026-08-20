import type { TextToolResult, ToolResultBudget } from "../lib/tool-result-budget.js";

export const ARTIFACT_SCHEMA_VERSION = 1 as const;
export const ARTIFACT_OPERATION = "artifact_read" as const;

export type ArtifactErrorCode =
  | "ARTIFACT_CONFIG_INVALID"
  | "ARTIFACT_NOT_GRANTED"
  | "ARTIFACT_WRONG_RUN"
  | "ARTIFACT_WRONG_CONSUMER"
  | "ARTIFACT_STALE"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_ENCODING_INVALID"
  | "ARTIFACT_RANGE_INVALID"
  | "ARTIFACT_CURSOR_INVALID"
  | "ARTIFACT_CURSOR_EXPIRED"
  | "ARTIFACT_RESULT_BUDGET_EXCEEDED"
  | "ARTIFACT_MATERIALIZATION_FAILED";

/** Exact schema-v1 transport reference accepted by the artifact plane. */
export interface ArtifactRef {
  schema_version: 1;
  artifact_id: string;
  run_id: string;
  phase: string;
  branch_id: string | null;
  kind: string;
  operation_id: string;
  version: number;
  producer: string;
  consumer_scope: string[];
  media_type: string;
  byte_length: number;
  content_digest: string;
  store_ref: string;
}

/** Exact schema-v1 manifest envelope accepted by the artifact plane. */
export interface ArtifactEnvelope extends ArtifactRef {
  created_at: string;
  parent_ref: ArtifactRef | null;
  upstream_refs: ArtifactRef[];
}

export interface ArtifactGrant {
  artifact: ArtifactRef;
  expires_at: string;
}

export interface ArtifactCaller {
  run_id: string;
  consumer_ref: string;
  invocation_id: string;
}

export interface ArtifactInvocation {
  schema_version: 1;
  caller: ArtifactCaller;
  grants: ArtifactGrant[];
}

export type ArtifactLocator = string | ArtifactRef;

export interface ArtifactReadParams {
  artifact: ArtifactLocator;
  range?: {
    start: number;
    end?: number;
  };
  cursor?: string;
}

export interface ArtifactRuntimeConfig {
  artifactRoot: string;
  invocationJson?: string;
  invocationFile?: string;
  cursorKey: Buffer;
  cursorTtlMs: number;
  budget: ToolResultBudget;
  materialization: {
    enabled: boolean;
    thresholdBytes: number;
    ttlMs: number;
  };
}

export interface ArtifactTelemetry {
  info(event: string, context: Record<string, unknown>): void;
  warn(event: string, context: Record<string, unknown>): void;
}

export interface ArtifactRuntimeDependencies {
  now?: () => number;
  telemetry?: ArtifactTelemetry;
  /**
   * Owner-side resolution of one exact artifact ID for runtimes that have no
   * process-environment invocation snapshot (the unmarked primary runtime).
   * Returning `undefined` is `ARTIFACT_NOT_GRANTED`; the resolver never
   * enumerates and is never reachable from model arguments.
   */
  invocationResolver?: (artifactId: string) => Promise<ArtifactInvocation | undefined>;
}

export interface ArtifactExecution {
  result: TextToolResult;
  code: "OK" | ArtifactErrorCode;
}

export class ArtifactReadError extends Error {
  constructor(
    readonly code: ArtifactErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ArtifactReadError";
  }
}
