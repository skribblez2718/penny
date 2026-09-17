import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";

const MAX_MODEL_TEXT = 256;
const MAX_PROFILES = 3;

export const SCA_MODEL_REGISTRY_SCHEMA = "penny.sca-model-registry.v1";
export const SCA_MODEL_EXECUTION_REQUEST_SCHEMA = "penny.sca-model-execution-request.v1";
export const SCA_CANDIDATE_ANALYSIS_SCHEMA = "penny.sca-candidate-analysis.v1";

export const SCA_REQUIRED_MODEL_PROFILES = Object.freeze([
  "primary_a",
  "primary_b",
  "critic",
] as const);

const ScaModelProfileIdV1Schema = Type.Union([
  Type.Literal("primary_a"),
  Type.Literal("primary_b"),
  Type.Literal("critic"),
]);

const ScaModelBudgetV1Schema = Type.Object(
  {
    max_input_tokens: Type.Integer({ minimum: 1, maximum: 2_000_000 }),
    max_output_tokens: Type.Integer({ minimum: 1, maximum: 200_000 }),
    max_tool_calls: Type.Integer({ minimum: 0, maximum: 10_000 }),
    max_wall_time_ms: Type.Integer({ minimum: 1, maximum: 21_600_000 }),
  },
  { additionalProperties: false }
);

const ScaModelProfileV1Schema = Type.Object(
  {
    profile_id: ScaModelProfileIdV1Schema,
    provider_id: Type.String({ minLength: 1, maxLength: MAX_MODEL_TEXT }),
    model_id: Type.String({ minLength: 1, maxLength: MAX_MODEL_TEXT }),
    runtime_identity_sha256: Sha256Schema,
    output_schema_id: Type.Literal(SCA_CANDIDATE_ANALYSIS_SCHEMA),
    output_schema_version: Type.Literal(1),
    budget: ScaModelBudgetV1Schema,
  },
  { additionalProperties: false }
);

export const ScaModelRegistryInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_MODEL_REGISTRY_SCHEMA),
    schema_version: Type.Literal(1),
    profiles: Type.Array(ScaModelProfileV1Schema, {
      minItems: MAX_PROFILES,
      maxItems: MAX_PROFILES,
    }),
  },
  { additionalProperties: false }
);

export const ScaModelRegistryV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_MODEL_REGISTRY_SCHEMA),
    schema_version: Type.Literal(1),
    profiles: Type.Array(ScaModelProfileV1Schema, {
      minItems: MAX_PROFILES,
      maxItems: MAX_PROFILES,
    }),
    registry_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaModelExecutionRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_MODEL_EXECUTION_REQUEST_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    candidate_id: OpaqueIdSchema,
    profile_id: ScaModelProfileIdV1Schema,
    observed_provider_id: Type.String({ minLength: 1, maxLength: MAX_MODEL_TEXT }),
    observed_model_id: Type.String({ minLength: 1, maxLength: MAX_MODEL_TEXT }),
    observed_runtime_identity_sha256: Sha256Schema,
    output_schema_id: Type.Literal(SCA_CANDIDATE_ANALYSIS_SCHEMA),
    output_schema_version: Type.Literal(1),
    requested_budget: ScaModelBudgetV1Schema,
  },
  { additionalProperties: false }
);

const ScaModelExecutionAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-model-execution-admission.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    candidate_id: OpaqueIdSchema,
    profile_id: ScaModelProfileIdV1Schema,
    registry_sha256: Sha256Schema,
    provider_id: Type.String({ minLength: 1, maxLength: MAX_MODEL_TEXT }),
    model_id: Type.String({ minLength: 1, maxLength: MAX_MODEL_TEXT }),
    runtime_identity_sha256: Sha256Schema,
    output_schema_id: Type.Literal(SCA_CANDIDATE_ANALYSIS_SCHEMA),
    output_schema_version: Type.Literal(1),
    admitted_budget: ScaModelBudgetV1Schema,
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaModelRegistryInputV1 = Static<typeof ScaModelRegistryInputV1Schema>;
export type ScaModelRegistryV1 = Static<typeof ScaModelRegistryV1Schema>;
export type ScaModelExecutionRequestV1 = Static<typeof ScaModelExecutionRequestV1Schema>;
export type ScaModelExecutionAdmissionV1 = Static<typeof ScaModelExecutionAdmissionV1Schema>;

type UnsignedRegistry = Omit<ScaModelRegistryV1, "registry_sha256">;
type UnsignedAdmission = Omit<ScaModelExecutionAdmissionV1, "admission_sha256">;

export class ScaAgentModelError extends Error {
  constructor(
    readonly code:
      | "invalid_registry"
      | "profile_collision"
      | "profile_set_mismatch"
      | "registry_digest_mismatch"
      | "invalid_execution_request"
      | "runtime_identity_mismatch"
      | "schema_mismatch"
      | "budget_exceeded",
    message: string
  ) {
    super(message);
    this.name = "ScaAgentModelError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function registryDigest(value: UnsignedRegistry): string {
  return sha256(canonicalJson(value));
}

function admissionDigest(value: UnsignedAdmission): string {
  return sha256(canonicalJson(value));
}

export function buildScaModelRegistryV1(value: unknown): ScaModelRegistryV1 {
  let input: ScaModelRegistryInputV1;
  try {
    input = validateContract(ScaModelRegistryInputV1Schema, value, "SCA model registry input");
  } catch (error) {
    throw new ScaAgentModelError(
      "invalid_registry",
      error instanceof Error ? error.message : "SCA model registry is invalid"
    );
  }
  const profileIds = input.profiles.map((profile) => profile.profile_id);
  if (new Set(profileIds).size !== profileIds.length) {
    throw new ScaAgentModelError("profile_collision", "SCA model profile IDs must be unique");
  }
  const sortedIds = [...profileIds].sort(compareUtf8);
  const requiredIds = [...SCA_REQUIRED_MODEL_PROFILES].sort(compareUtf8);
  if (canonicalJson(sortedIds) !== canonicalJson(requiredIds)) {
    throw new ScaAgentModelError(
      "profile_set_mismatch",
      "SCA model registry must contain exactly two primary profiles and one critic"
    );
  }
  const unsigned: UnsignedRegistry = {
    schema_id: SCA_MODEL_REGISTRY_SCHEMA,
    schema_version: 1,
    profiles: [...input.profiles].sort((left, right) =>
      compareUtf8(left.profile_id, right.profile_id)
    ),
  };
  return validateContract(
    ScaModelRegistryV1Schema,
    { ...unsigned, registry_sha256: registryDigest(unsigned) },
    "SCA model registry"
  );
}

export function validateScaModelRegistryV1(value: unknown): ScaModelRegistryV1 {
  const registry = validateContract(ScaModelRegistryV1Schema, value, "SCA model registry");
  const { registry_sha256: observedDigest, ...unsigned } = registry;
  if (registryDigest(unsigned) !== observedDigest) {
    throw new ScaAgentModelError("registry_digest_mismatch", "SCA model registry digest mismatch");
  }
  return registry;
}

function budgetWithin(
  requested: ScaModelExecutionRequestV1["requested_budget"],
  configured: ScaModelRegistryV1["profiles"][number]["budget"]
): boolean {
  return (
    requested.max_input_tokens <= configured.max_input_tokens &&
    requested.max_output_tokens <= configured.max_output_tokens &&
    requested.max_tool_calls <= configured.max_tool_calls &&
    requested.max_wall_time_ms <= configured.max_wall_time_ms
  );
}

export function admitScaModelExecutionV1(
  registryValue: unknown,
  requestValue: unknown
): ScaModelExecutionAdmissionV1 {
  const registry = validateScaModelRegistryV1(registryValue);
  let request: ScaModelExecutionRequestV1;
  try {
    request = validateContract(
      ScaModelExecutionRequestV1Schema,
      requestValue,
      "SCA model execution request"
    );
  } catch (error) {
    throw new ScaAgentModelError(
      "invalid_execution_request",
      error instanceof Error ? error.message : "SCA model execution request is invalid"
    );
  }
  const profile = registry.profiles.find((entry) => entry.profile_id === request.profile_id);
  if (profile === undefined) {
    throw new ScaAgentModelError("profile_set_mismatch", "SCA model profile is not registered");
  }
  if (
    request.observed_provider_id !== profile.provider_id ||
    request.observed_model_id !== profile.model_id ||
    request.observed_runtime_identity_sha256 !== profile.runtime_identity_sha256
  ) {
    throw new ScaAgentModelError(
      "runtime_identity_mismatch",
      "observed SCA model runtime does not match the pinned profile"
    );
  }
  if (
    request.output_schema_id !== profile.output_schema_id ||
    request.output_schema_version !== profile.output_schema_version
  ) {
    throw new ScaAgentModelError("schema_mismatch", "SCA model output schema drift refused");
  }
  if (!budgetWithin(request.requested_budget, profile.budget)) {
    throw new ScaAgentModelError("budget_exceeded", "SCA model execution budget exceeds profile");
  }

  const unsigned: UnsignedAdmission = {
    schema_id: "penny.sca-model-execution-admission.v1",
    schema_version: 1,
    run_id: request.run_id,
    candidate_id: request.candidate_id,
    profile_id: request.profile_id,
    registry_sha256: registry.registry_sha256,
    provider_id: profile.provider_id,
    model_id: profile.model_id,
    runtime_identity_sha256: profile.runtime_identity_sha256,
    output_schema_id: profile.output_schema_id,
    output_schema_version: profile.output_schema_version,
    admitted_budget: request.requested_budget,
  };
  return validateContract(
    ScaModelExecutionAdmissionV1Schema,
    { ...unsigned, admission_sha256: admissionDigest(unsigned) },
    "SCA model execution admission"
  );
}
