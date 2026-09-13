import { canonicalJson, sha256 } from "./checkpointer.js";
import type { ChildWorkflowProgressLeaseBindingV1 } from "./contracts.js";

export const LIVENESS_CALIBRATION_ID = "cw05-local-orchestration-telemetry-2026-09-11" as const;
export const LIVENESS_CALIBRATION_SHA256 =
  "762125b57761bebac1893387be194ca873c83fddc555886fe33e45fac501c38f" as const;
export const LIVENESS_LEASE_REGISTRY_ID = "penny-inactivity-leases-v1" as const;

export type LeaseExecutionPurposeV1 = "phase" | "routing_repair";

interface WorkerLeaseProfileDefinitionV1 {
  readonly schema_version: 1;
  readonly profile_id: string;
  readonly profile_version: 1;
  readonly provider_id: string;
  readonly model_id: string;
  readonly operation_class: "worker";
  readonly execution_purpose: LeaseExecutionPurposeV1;
  readonly inactivity_interval_ms: number;
  readonly renewal_policy: "trusted_host_activity_or_convergence_v1";
  readonly calibration_id: typeof LIVENESS_CALIBRATION_ID;
  readonly calibration_sha256: typeof LIVENESS_CALIBRATION_SHA256;
  readonly selector: "exact" | "unknown_provider_fallback";
}

export interface WorkerLeaseProfileV1 extends WorkerLeaseProfileDefinitionV1 {
  readonly profile_sha256: string;
}

function defineProfile(definition: WorkerLeaseProfileDefinitionV1): Readonly<WorkerLeaseProfileV1> {
  return Object.freeze({
    ...definition,
    profile_sha256: sha256(canonicalJson(definition)),
  });
}

/**
 * Immutable CW-05 worker profiles. The ignored calibration evidence retains only timing and
 * counter aggregates; these public definitions retain no prompt, message, thinking, tool,
 * evidence, credential, identifier, or path bodies.
 */
export const WORKER_LEASE_PROFILES_V1 = Object.freeze([
  defineProfile({
    schema_version: 1,
    profile_id: "openai-codex-gpt-5-6-sol-worker-phase-v1",
    profile_version: 1,
    provider_id: "openai-codex",
    model_id: "gpt-5.6-sol",
    operation_class: "worker",
    execution_purpose: "phase",
    inactivity_interval_ms: 360_000,
    renewal_policy: "trusted_host_activity_or_convergence_v1",
    calibration_id: LIVENESS_CALIBRATION_ID,
    calibration_sha256: LIVENESS_CALIBRATION_SHA256,
    selector: "exact",
  }),
  defineProfile({
    schema_version: 1,
    profile_id: "ollama-qwen3-8-worker-phase-v1",
    profile_version: 1,
    provider_id: "ollama",
    model_id: "qwen3.8:latest",
    operation_class: "worker",
    execution_purpose: "phase",
    inactivity_interval_ms: 360_000,
    renewal_policy: "trusted_host_activity_or_convergence_v1",
    calibration_id: LIVENESS_CALIBRATION_ID,
    calibration_sha256: LIVENESS_CALIBRATION_SHA256,
    selector: "exact",
  }),
  defineProfile({
    schema_version: 1,
    profile_id: "openai-codex-gpt-5-6-sol-worker-routing-repair-v1",
    profile_version: 1,
    provider_id: "openai-codex",
    model_id: "gpt-5.6-sol",
    operation_class: "worker",
    execution_purpose: "routing_repair",
    inactivity_interval_ms: 60_000,
    renewal_policy: "trusted_host_activity_or_convergence_v1",
    calibration_id: LIVENESS_CALIBRATION_ID,
    calibration_sha256: LIVENESS_CALIBRATION_SHA256,
    selector: "exact",
  }),
  defineProfile({
    schema_version: 1,
    profile_id: "unknown-provider-worker-phase-fallback-v1",
    profile_version: 1,
    provider_id: "unknown-provider",
    model_id: "unknown-model",
    operation_class: "worker",
    execution_purpose: "phase",
    inactivity_interval_ms: 600_000,
    renewal_policy: "trusted_host_activity_or_convergence_v1",
    calibration_id: LIVENESS_CALIBRATION_ID,
    calibration_sha256: LIVENESS_CALIBRATION_SHA256,
    selector: "unknown_provider_fallback",
  }),
  defineProfile({
    schema_version: 1,
    profile_id: "unknown-provider-worker-routing-repair-fallback-v1",
    profile_version: 1,
    provider_id: "unknown-provider",
    model_id: "unknown-model",
    operation_class: "worker",
    execution_purpose: "routing_repair",
    inactivity_interval_ms: 180_000,
    renewal_policy: "trusted_host_activity_or_convergence_v1",
    calibration_id: LIVENESS_CALIBRATION_ID,
    calibration_sha256: LIVENESS_CALIBRATION_SHA256,
    selector: "unknown_provider_fallback",
  }),
] as const);

/**
 * Aggregate depth-one child execution fallback. Exact provider/model worker leases remain active
 * inside the child; this outer lease covers orchestration gaps between worker sessions.
 */
const CHILD_EXECUTION_LEASE_PROFILE_DEFINITION_V1 = Object.freeze({
  schema_version: 1 as const,
  profile_id: "penny-orchestration-registered-child-execution-v1",
  profile_version: 1 as const,
  calibration_id: LIVENESS_CALIBRATION_ID,
  calibration_sha256: LIVENESS_CALIBRATION_SHA256,
  provider_id: "penny-orchestration",
  model_id: "registered-child-run",
  operation_class: "child_execution" as const,
  inactivity_interval_ms: 600_000,
  renewal_policy: "trusted_host_activity_or_convergence_v1" as const,
});

export const CHILD_EXECUTION_LEASE_PROFILE_V1 = Object.freeze({
  ...CHILD_EXECUTION_LEASE_PROFILE_DEFINITION_V1,
  profile_sha256: sha256(canonicalJson(CHILD_EXECUTION_LEASE_PROFILE_DEFINITION_V1)),
});

export const LIVENESS_LEASE_REGISTRY_SHA256 = sha256(
  canonicalJson({
    schema_version: 1,
    registry_id: LIVENESS_LEASE_REGISTRY_ID,
    profiles: [...WORKER_LEASE_PROFILES_V1, CHILD_EXECUTION_LEASE_PROFILE_V1],
  })
);

export function childExecutionProgressLeaseBinding(): ChildWorkflowProgressLeaseBindingV1 {
  return { ...CHILD_EXECUTION_LEASE_PROFILE_V1 };
}

export function fallbackWorkerLeaseProfile(
  purpose: LeaseExecutionPurposeV1
): Readonly<WorkerLeaseProfileV1> {
  const profile = WORKER_LEASE_PROFILES_V1.find(
    (candidate) =>
      candidate.selector === "unknown_provider_fallback" && candidate.execution_purpose === purpose
  );
  if (profile === undefined) throw new Error(`missing worker lease fallback for '${purpose}'`);
  return profile;
}

export function resolveWorkerLeaseProfile(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly purpose: LeaseExecutionPurposeV1;
}): Readonly<WorkerLeaseProfileV1> {
  return (
    WORKER_LEASE_PROFILES_V1.find(
      (profile) =>
        profile.selector === "exact" &&
        profile.provider_id === input.providerId &&
        profile.model_id === input.modelId &&
        profile.execution_purpose === input.purpose
    ) ?? fallbackWorkerLeaseProfile(input.purpose)
  );
}

/** Bind the selected immutable profile to the model identity the host actually resolved. */
export function workerProgressLeaseBinding(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly purpose: LeaseExecutionPurposeV1;
}): ChildWorkflowProgressLeaseBindingV1 {
  const profile = resolveWorkerLeaseProfile(input);
  return {
    schema_version: 1,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    profile_sha256: profile.profile_sha256,
    calibration_id: profile.calibration_id,
    calibration_sha256: profile.calibration_sha256,
    provider_id: input.providerId,
    model_id: input.modelId,
    operation_class: "worker",
    inactivity_interval_ms: profile.inactivity_interval_ms,
    renewal_policy: profile.renewal_policy,
  };
}
