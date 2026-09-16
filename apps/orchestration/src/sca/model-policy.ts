import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ContractValidationError, validateContract } from "../contracts.js";
import type { AgentInvocation } from "../model-client.js";
import { OpaqueIdSchema, assertOpaqueId } from "../skill-contracts/common.js";

const MAX_MODEL_POLICY_BYTES = 32_768;

export const SCA_MODEL_ALIAS = "deepseek-flash" as const;
export const SCA_MODEL_PROVIDER = "ollama" as const;
export const SCA_MODEL_ID = "deepseek-v4.1-flash:cloud" as const;
export const SCA_MODEL_OVERRIDE = `${SCA_MODEL_PROVIDER}/${SCA_MODEL_ID}` as const;

const SCA_ALLOWED_MODEL_DATA_CLASSES = [
  "content_free_run_metadata",
  "nonsensitive_synthetic_fixture",
  "normalized_public_dependency_fact",
  "public_policy_reference",
  "redacted_public_snapshot_excerpt",
] as const;

const SCA_DENIED_MODEL_DATA_CLASSES = [
  "credential_or_secret",
  "environment_or_browser_state",
  "evaluator_oracle",
  "private_path",
  "private_repository",
  "protected_runtime_configuration",
  "raw_crash_or_memory_dump",
  "target_service_credential",
  "undeclared_file",
  "unredacted_pii",
  "unrestricted_application_log",
] as const;

const ScaModelAliasV1Schema = Type.Object(
  {
    alias: Type.Literal(SCA_MODEL_ALIAS),
    model_override: Type.Literal(SCA_MODEL_OVERRIDE),
    resolved: Type.Object(
      {
        provider: Type.Literal(SCA_MODEL_PROVIDER),
        model: Type.Literal(SCA_MODEL_ID),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const ScaExternalCapabilityStatusSchema = Type.Union([
  Type.Literal("qualification_required"),
  Type.Literal("disabled"),
]);

export const ScaProviderCapabilityV1Schema = Type.Object(
  {
    capability_id: OpaqueIdSchema,
    status: ScaExternalCapabilityStatusSchema,
    binding_ref: Type.Null(),
    binding_sha256: Type.Null(),
  },
  { additionalProperties: false }
);

export const ScaModelPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-model-policy.v1"),
    schema_version: Type.Literal(1),
    scope: Type.Literal("run_local"),
    aliases: Type.Array(ScaModelAliasV1Schema, { minItems: 1, maxItems: 1 }),
    fallback: Type.Null(),
    per_agent_overrides: Type.Array(Type.Never(), { maxItems: 0 }),
    process_global_override: Type.Literal(false),
    per_request_limits: Type.Object(
      {
        input_tokens: Type.Integer({ minimum: 1, maximum: 128_000 }),
        output_tokens: Type.Integer({ minimum: 1, maximum: 32_000 }),
      },
      { additionalProperties: false }
    ),
    provider_capability: ScaProviderCapabilityV1Schema,
    provider_data_policy: Type.Object(
      {
        training_use: Type.Literal("disabled"),
        retention_max_days: Type.Integer({ minimum: 0, maximum: 30 }),
        attestation_status: Type.Literal("qualification_required"),
        allowed_data_classes: Type.Array(
          Type.Union(SCA_ALLOWED_MODEL_DATA_CLASSES.map((value) => Type.Literal(value))),
          {
            minItems: SCA_ALLOWED_MODEL_DATA_CLASSES.length,
            maxItems: SCA_ALLOWED_MODEL_DATA_CLASSES.length,
          }
        ),
        denied_data_classes: Type.Array(
          Type.Union(SCA_DENIED_MODEL_DATA_CLASSES.map((value) => Type.Literal(value))),
          {
            minItems: SCA_DENIED_MODEL_DATA_CLASSES.length,
            maxItems: SCA_DENIED_MODEL_DATA_CLASSES.length,
          }
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export type ScaModelPolicyV1 = Readonly<Static<typeof ScaModelPolicyV1Schema>>;
export type ScaResolvedModelIdentity = Parameters<
  NonNullable<AgentInvocation["admitResolvedModel"]>
>[0];

function fail(issue: string): never {
  throw new ContractValidationError("SCA model policy", [issue]);
}

function assertExactOrderedValues(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(`${label} must equal the canonical ordered set`);
  }
}

export function validateScaModelPolicy(value: unknown): ScaModelPolicyV1 {
  const policy = validateContract(ScaModelPolicyV1Schema, value, "SCA model policy");
  assertOpaqueId(policy.provider_capability.capability_id, "SCA model provider capability_id");
  assertExactOrderedValues(
    policy.provider_data_policy.allowed_data_classes,
    SCA_ALLOWED_MODEL_DATA_CLASSES,
    "allowed_data_classes"
  );
  assertExactOrderedValues(
    policy.provider_data_policy.denied_data_classes,
    SCA_DENIED_MODEL_DATA_CLASSES,
    "denied_data_classes"
  );
  if (Buffer.byteLength(canonicalJson(policy), "utf8") > MAX_MODEL_POLICY_BYTES) {
    fail(`canonical value exceeds ${MAX_MODEL_POLICY_BYTES} UTF-8 bytes`);
  }
  return policy;
}

/** Canonical semantic digest of an accepted model policy, independent of object key order. */
export function scaModelPolicySha256(value: unknown): string {
  return sha256(canonicalJson(validateScaModelPolicy(value)));
}

/** Exact existing model-client override value for the single admitted SCA alias. */
export function scaModelOverride(value: unknown): NonNullable<AgentInvocation["modelOverride"]> {
  const policy = validateScaModelPolicy(value);
  const alias = policy.aliases[0];
  if (alias === undefined) fail("the canonical model alias is absent");
  return alias.model_override;
}

/** Validate a model identity supplied through the existing model-client admission hook contract. */
export function validateScaResolvedModel(
  policyValue: unknown,
  resolved: ScaResolvedModelIdentity
): ScaResolvedModelIdentity {
  const policy = validateScaModelPolicy(policyValue);
  const alias = policy.aliases[0];
  if (alias === undefined) fail("the canonical model alias is absent");
  if (resolved.provider !== alias.resolved.provider || resolved.model !== alias.resolved.model) {
    fail("resolved model must equal ollama/deepseek-v4.1-flash:cloud");
  }
  return resolved;
}
