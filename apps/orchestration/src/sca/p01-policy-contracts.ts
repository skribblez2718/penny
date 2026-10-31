import { Type, type Static, type TSchema } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  assertOpaqueId,
} from "../skill-contracts/common.js";

const MAX_FRAMEWORKS = 128;
const MAX_TOOLS = 128;
const MAX_DATA_CLASSES = 32;
const MAX_TEXT_BYTES = 2_048;
const MAX_RULE_CONTENT_BYTES = 1_048_576;

export const SCA_ANALYSIS_PROFILE_V1_SCHEMA = "penny.sca-analysis-profile.v1";
export const SCA_RULE_RELEASE_V1_SCHEMA = "penny.sca-rule-release.v1";
export const SCA_P01_RULE_BUNDLE_V1_SCHEMA = "penny.sca-p01-rule-bundle.v1";
export const SCA_RULE_PROFILE_V1_SCHEMA = "penny.sca-rule-profile.v1";
export const SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA = "penny.sca-p01-selected-rule-manifest.v1";
export const SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA = "penny.sca-toolchain-identity.v1";
export const SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA = "penny.sca-p01-tool-executable-package.v1";
export const SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA =
  "penny.sca-p01-tool-measurement-receipt.v1";
export const SCA_NETWORK_POLICY_V1_SCHEMA = "penny.sca-network-policy.v1";
export const SCA_PRIVACY_POLICY_V1_SCHEMA = "penny.sca-privacy-policy.v1";
export const SCA_MODEL_DATA_POLICY_V1_SCHEMA = "penny.sca-model-data-policy.v1";
export const SCA_RESOURCE_POLICY_V1_SCHEMA = "penny.sca-resource-policy.v1";
export const SCA_OUTPUT_POLICY_V1_SCHEMA = "penny.sca-output-policy.v1";
export const SCA_AUTHORITY_POLICY_V1_SCHEMA = "penny.sca-authority-policy.v1";

export const SCA_P01_MODEL_ALIAS = "deepseek-flash" as const;
export const SCA_P01_MODEL_PROVIDER = "ollama" as const;
export const SCA_P01_MODEL_ID = "deepseek-v4.1-flash:cloud" as const;

export const SCA_P01_TRUSTED_PRODUCERS = Object.freeze({
  profile: "host:sca-profile-authority",
  rules: "host:sca-rule-authority",
  rule_bundle: "host:sca-rule-bundle-custody",
  toolchain: "host:sca-toolchain-authority",
  tool_executable: "host:sca-tool-executable-custody",
  tool_measurement: "host:sca-tool-measurement-authority",
  policy: "host:sca-policy-authority",
  authority: "host:sca-authority",
} as const);

const ScaLanguageSchema = Type.Union([
  Type.Literal("php"),
  Type.Literal("javascript"),
  Type.Literal("typescript"),
]);
const ScaPolicyStatusSchema = Type.Union([Type.Literal("approved"), Type.Literal("denied")]);
const BoundedTextSchema = Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES });

const ScaFrameworkSupportV1Schema = Type.Object(
  {
    framework_id: OpaqueIdSchema,
    language: ScaLanguageSchema,
    support_status: Type.Union([Type.Literal("supported"), Type.Literal("unsupported")]),
  },
  { additionalProperties: false }
);

export const ScaAnalysisProfileV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_ANALYSIS_PROFILE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    profile_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    languages: Type.Array(ScaLanguageSchema, { minItems: 1, maxItems: 3 }),
    frameworks: Type.Array(ScaFrameworkSupportV1Schema, { maxItems: MAX_FRAMEWORKS }),
  },
  { additionalProperties: false, $id: SCA_ANALYSIS_PROFILE_V1_SCHEMA }
);
export type ScaAnalysisProfileV1 = Readonly<Static<typeof ScaAnalysisProfileV1Schema>>;

const ScaRuleBundleEntryV1Schema = Type.Object(
  {
    rule_id: OpaqueIdSchema,
    language: ScaLanguageSchema,
    encoding: Type.Literal("base64"),
    content_base64: Type.String({ maxLength: MAX_RULE_CONTENT_BYTES }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaP01RuleBundleV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P01_RULE_BUNDLE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    bundle_id: OpaqueIdSchema,
    release_id: OpaqueIdSchema,
    immutable: Type.Literal(true),
    rules: Type.Array(ScaRuleBundleEntryV1Schema, { minItems: 1, maxItems: 1_000_000 }),
  },
  { additionalProperties: false, $id: SCA_P01_RULE_BUNDLE_V1_SCHEMA }
);
export type ScaP01RuleBundleV1 = Readonly<Static<typeof ScaP01RuleBundleV1Schema>>;

export const ScaRuleReleaseV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_RULE_RELEASE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    release_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    immutable: Type.Literal(true),
    languages: Type.Array(ScaLanguageSchema, { minItems: 1, maxItems: 3 }),
    rule_count: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    rule_bundle_ref: ArtifactRefSchema,
    rules_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_RULE_RELEASE_V1_SCHEMA }
);
export type ScaRuleReleaseV1 = Readonly<Static<typeof ScaRuleReleaseV1Schema>>;

export const ScaP01SelectedRuleManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    selection_id: OpaqueIdSchema,
    rule_profile_id: OpaqueIdSchema,
    analysis_profile_id: OpaqueIdSchema,
    rule_release_id: OpaqueIdSchema,
    rule_release_ref: ArtifactRefSchema,
    selected_rule_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 1_000_000 }),
  },
  { additionalProperties: false, $id: SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA }
);
export type ScaP01SelectedRuleManifestV1 = Readonly<
  Static<typeof ScaP01SelectedRuleManifestV1Schema>
>;

export const ScaRuleProfileV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_RULE_PROFILE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    rule_profile_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    analysis_profile_id: OpaqueIdSchema,
    rule_release_id: OpaqueIdSchema,
    rule_release_ref: ArtifactRefSchema,
    languages: Type.Array(ScaLanguageSchema, { minItems: 1, maxItems: 3 }),
    selected_rule_manifest_ref: ArtifactRefSchema,
    selection_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_RULE_PROFILE_V1_SCHEMA }
);
export type ScaRuleProfileV1 = Readonly<Static<typeof ScaRuleProfileV1Schema>>;

const ScaToolRoleSchema = Type.Union([Type.Literal("scanner"), Type.Literal("parser")]);

export const ScaP01ToolMeasurementReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    tool_id: OpaqueIdSchema,
    role: ScaToolRoleSchema,
    version: OpaqueIdSchema,
    executable_ref: ArtifactRefSchema,
    executable_sha256: Sha256Schema,
    measurement_method: Type.Literal("host-sha256"),
    measured_at: Rfc3339UtcSchema,
    status: Type.Literal("verified"),
  },
  { additionalProperties: false, $id: SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA }
);
export type ScaP01ToolMeasurementReceiptV1 = Readonly<
  Static<typeof ScaP01ToolMeasurementReceiptV1Schema>
>;

const ScaToolIdentityV1Schema = Type.Object(
  {
    tool_id: OpaqueIdSchema,
    role: ScaToolRoleSchema,
    version: OpaqueIdSchema,
    executable_ref: ArtifactRefSchema,
    executable_sha256: Sha256Schema,
    measurement_receipt_ref: ArtifactRefSchema,
    languages: Type.Array(ScaLanguageSchema, { minItems: 1, maxItems: 3 }),
    target_execution: Type.Literal("forbidden"),
    network_access: Type.Literal("denied"),
    acquisition: Type.Literal("preinstalled-only"),
  },
  { additionalProperties: false }
);

export const ScaToolchainIdentityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    toolchain_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    analysis_profile_id: OpaqueIdSchema,
    source_posture: Type.Literal("read-only"),
    package_acquisition: Type.Literal("forbidden"),
    target_startup: Type.Literal("forbidden"),
    tools: Type.Array(ScaToolIdentityV1Schema, { minItems: 2, maxItems: MAX_TOOLS }),
  },
  { additionalProperties: false, $id: SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA }
);
export type ScaToolchainIdentityV1 = Readonly<Static<typeof ScaToolchainIdentityV1Schema>>;

export const ScaNetworkPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_NETWORK_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    policy_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    default_action: Type.Literal("deny"),
    scanner_posture: Type.Literal("offline"),
    parser_posture: Type.Literal("offline"),
    package_acquisition: Type.Literal("forbidden"),
    target_startup: Type.Literal("forbidden"),
    dependency_coordinate_lookup: Type.Literal("separate-admission-required"),
  },
  { additionalProperties: false, $id: SCA_NETWORK_POLICY_V1_SCHEMA }
);
export type ScaNetworkPolicyV1 = Readonly<Static<typeof ScaNetworkPolicyV1Schema>>;

export const ScaPrivacyPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PRIVACY_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    policy_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    source_classification: Type.Union([
      Type.Literal("public"),
      Type.Literal("internal"),
      Type.Literal("confidential"),
    ]),
    local_retention_days: Type.Integer({ minimum: 0, maximum: 36_500 }),
    secrets_treatment: Type.Literal("redact-and-deny-disclosure"),
    personal_data_treatment: Type.Literal("minimize-and-require-explicit-disclosure"),
  },
  { additionalProperties: false, $id: SCA_PRIVACY_POLICY_V1_SCHEMA }
);
export type ScaPrivacyPolicyV1 = Readonly<Static<typeof ScaPrivacyPolicyV1Schema>>;

const ScaModelDataClassTreatmentV1Schema = Type.Object(
  {
    data_class: Type.Union([
      Type.Literal("source-code"),
      Type.Literal("scanner-evidence"),
      Type.Literal("dependency-coordinates"),
      Type.Literal("secrets"),
      Type.Literal("personal-data"),
    ]),
    treatment: Type.Union([
      Type.Literal("deny"),
      Type.Literal("allow-minimized"),
      Type.Literal("allow-redacted"),
    ]),
  },
  { additionalProperties: false }
);

export const ScaModelDataPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_MODEL_DATA_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    policy_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    model_alias: Type.Literal(SCA_P01_MODEL_ALIAS),
    provider: Type.Literal(SCA_P01_MODEL_PROVIDER),
    model: Type.Literal(SCA_P01_MODEL_ID),
    destination_class: Type.Literal("cloud"),
    provider_retention_status: Type.Literal("known"),
    provider_retention_days: Type.Integer({ minimum: 0, maximum: 36_500 }),
    provider_training_use: Type.Union([
      Type.Literal("prohibited"),
      Type.Literal("allowed-by-explicit-authority"),
    ]),
    data_classes: Type.Array(ScaModelDataClassTreatmentV1Schema, {
      minItems: 5,
      maxItems: MAX_DATA_CLASSES,
    }),
    payload_limit_bytes: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
  },
  { additionalProperties: false, $id: SCA_MODEL_DATA_POLICY_V1_SCHEMA }
);
export type ScaModelDataPolicyV1 = Readonly<Static<typeof ScaModelDataPolicyV1Schema>>;

export const ScaResourcePolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_RESOURCE_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    policy_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    cpu_millis: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
    memory_bytes: Type.Integer({ minimum: 1, maximum: 1_099_511_627_776 }),
    process_count: Type.Integer({ minimum: 1, maximum: 65_536 }),
    storage_bytes: Type.Integer({ minimum: 1, maximum: 1_099_511_627_776 }),
    output_bytes: Type.Integer({ minimum: 1, maximum: 1_099_511_627_776 }),
    concurrency: Type.Integer({ minimum: 1, maximum: 4_096 }),
    operation_inactivity_ms: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  },
  { additionalProperties: false, $id: SCA_RESOURCE_POLICY_V1_SCHEMA }
);
export type ScaResourcePolicyV1 = Readonly<Static<typeof ScaResourcePolicyV1Schema>>;

export const ScaOutputPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_OUTPUT_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    policy_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    report_namespace: OpaqueIdSchema,
    namespace_owner: Type.Literal("caller"),
    overwrite: Type.Literal("deny"),
    symbolic_links: Type.Literal("deny"),
    source_overlap: Type.Literal("deny"),
  },
  { additionalProperties: false, $id: SCA_OUTPUT_POLICY_V1_SCHEMA }
);
export type ScaOutputPolicyV1 = Readonly<Static<typeof ScaOutputPolicyV1Schema>>;

const ScaAuthorityGrantV1Schema = Type.Object(
  {
    authority_id: OpaqueIdSchema,
    lineage_id: OpaqueIdSchema,
    role: Type.Union([
      Type.Literal("execution"),
      Type.Literal("release"),
      Type.Literal("promotion"),
    ]),
    posture: Type.Union([Type.Literal("separate-gate-required"), Type.Literal("denied")]),
    scope: Type.Union([
      Type.Literal("sca-execution-policy-binding"),
      Type.Literal("sca-campaign-release"),
      Type.Literal("sca-rule-promotion"),
    ]),
  },
  { additionalProperties: false }
);

export const ScaAuthorityPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_AUTHORITY_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    policy_id: OpaqueIdSchema,
    trust_status: Type.Literal("host-declared"),
    status: ScaPolicyStatusSchema,
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    admission_authority_id: OpaqueIdSchema,
    admission_lineage_id: OpaqueIdSchema,
    admission_decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    grants: Type.Array(ScaAuthorityGrantV1Schema, { minItems: 3, maxItems: 3 }),
    rationale: BoundedTextSchema,
  },
  { additionalProperties: false, $id: SCA_AUTHORITY_POLICY_V1_SCHEMA }
);
export type ScaAuthorityPolicyV1 = Readonly<Static<typeof ScaAuthorityPolicyV1Schema>>;

export interface ScaP01InlineProfileBinding {
  readonly profile_id: string;
  readonly languages: readonly ScaAnalysisProfileV1["languages"][number][];
  readonly frameworks: readonly {
    readonly framework_id: string;
    readonly language: ScaAnalysisProfileV1["languages"][number];
  }[];
}

export interface ScaP01InlineAuthorityBinding {
  readonly execution_authority_id: string;
  readonly release_authority_id: string;
  readonly promotion_authority_id: string;
}

export interface ScaP01PolicyBundle {
  readonly analysis_profile: ScaAnalysisProfileV1;
  readonly rule_release: ScaRuleReleaseV1;
  readonly rule_profile: ScaRuleProfileV1;
  readonly toolchain: ScaToolchainIdentityV1;
  readonly network_policy: ScaNetworkPolicyV1;
  readonly privacy_policy: ScaPrivacyPolicyV1;
  readonly model_data_policy: ScaModelDataPolicyV1;
  readonly resource_policy: ScaResourcePolicyV1;
  readonly output_policy: ScaOutputPolicyV1;
  readonly authority_policy: ScaAuthorityPolicyV1;
}

export interface ScaP01PolicyMaterial {
  readonly rule_release_ref: ArtifactRef;
  readonly rule_bundle_ref: ArtifactRef;
  readonly rule_bundle: ScaP01RuleBundleV1;
  readonly selected_rule_manifest_ref: ArtifactRef;
  readonly selected_rule_manifest: ScaP01SelectedRuleManifestV1;
  readonly tools: readonly {
    readonly executable_ref: ArtifactRef;
    readonly measurement_receipt_ref: ArtifactRef;
    readonly measurement_receipt: ScaP01ToolMeasurementReceiptV1;
  }[];
}

export class ScaP01PolicyContractError extends Error {
  constructor(
    readonly code:
      | "invalid_policy_contract"
      | "denied_policy"
      | "profile_mismatch"
      | "rule_binding_mismatch"
      | "unsafe_toolchain"
      | "unsafe_network_policy"
      | "model_policy_mismatch"
      | "unsafe_output_policy"
      | "authority_denied"
      | "authority_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaP01PolicyContractError";
  }
}

function fail(code: ScaP01PolicyContractError["code"], message: string): never {
  throw new ScaP01PolicyContractError(code, message);
}

function parsePolicy<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string
): Static<Schema> {
  try {
    return validateContract(schema, value, label);
  } catch (error) {
    fail("invalid_policy_contract", error instanceof Error ? error.message : `${label} is invalid`);
  }
}

export const validateScaAnalysisProfileV1 = (value: unknown): ScaAnalysisProfileV1 =>
  parsePolicy(ScaAnalysisProfileV1Schema, value, "SCA analysis profile");
export const validateScaP01RuleBundleV1 = (value: unknown): ScaP01RuleBundleV1 => {
  const bundle = parsePolicy(ScaP01RuleBundleV1Schema, value, "SCA P01 rule bundle");
  assertCanonicalUnique(
    bundle.rules.map((rule) => rule.rule_id),
    "rule bundle rule IDs"
  );
  for (const rule of bundle.rules) {
    const bytes = Buffer.from(rule.content_base64, "base64");
    if (bytes.toString("base64") !== rule.content_base64 || sha256(bytes) !== rule.content_sha256) {
      fail("invalid_policy_contract", `rule '${rule.rule_id}' content digest is invalid`);
    }
  }
  return bundle;
};
export const validateScaRuleReleaseV1 = (value: unknown): ScaRuleReleaseV1 => {
  const release = parsePolicy(ScaRuleReleaseV1Schema, value, "SCA rule release");
  if (release.rules_sha256 !== release.rule_bundle_ref.content_digest) {
    fail("invalid_policy_contract", "rule release digest does not bind its exact rule bundle ref");
  }
  return release;
};
export const validateScaP01SelectedRuleManifestV1 = (
  value: unknown
): ScaP01SelectedRuleManifestV1 => {
  const manifest = parsePolicy(
    ScaP01SelectedRuleManifestV1Schema,
    value,
    "SCA P01 selected-rule manifest"
  );
  assertCanonicalUnique(manifest.selected_rule_ids, "selected rule IDs");
  return manifest;
};
export const validateScaRuleProfileV1 = (value: unknown): ScaRuleProfileV1 => {
  const profile = parsePolicy(ScaRuleProfileV1Schema, value, "SCA rule profile");
  if (profile.selection_sha256 !== profile.selected_rule_manifest_ref.content_digest) {
    fail(
      "invalid_policy_contract",
      "rule profile selection digest does not bind its exact selected-rule manifest"
    );
  }
  return profile;
};
export const validateScaToolchainIdentityV1 = (value: unknown): ScaToolchainIdentityV1 =>
  parsePolicy(ScaToolchainIdentityV1Schema, value, "SCA toolchain identity");
export const validateScaP01ToolMeasurementReceiptV1 = (
  value: unknown
): ScaP01ToolMeasurementReceiptV1 => {
  const receipt = parsePolicy(
    ScaP01ToolMeasurementReceiptV1Schema,
    value,
    "SCA P01 tool measurement receipt"
  );
  if (receipt.executable_sha256 !== receipt.executable_ref.content_digest) {
    fail(
      "invalid_policy_contract",
      "tool measurement digest does not bind the exact executable package ref"
    );
  }
  return receipt;
};
export const validateScaNetworkPolicyV1 = (value: unknown): ScaNetworkPolicyV1 =>
  parsePolicy(ScaNetworkPolicyV1Schema, value, "SCA network policy");
export const validateScaPrivacyPolicyV1 = (value: unknown): ScaPrivacyPolicyV1 =>
  parsePolicy(ScaPrivacyPolicyV1Schema, value, "SCA privacy policy");
export const validateScaModelDataPolicyV1 = (value: unknown): ScaModelDataPolicyV1 =>
  parsePolicy(ScaModelDataPolicyV1Schema, value, "SCA model-data policy");
export const validateScaResourcePolicyV1 = (value: unknown): ScaResourcePolicyV1 =>
  parsePolicy(ScaResourcePolicyV1Schema, value, "SCA resource policy");
export const validateScaOutputPolicyV1 = (value: unknown): ScaOutputPolicyV1 =>
  parsePolicy(ScaOutputPolicyV1Schema, value, "SCA output policy");
export const validateScaAuthorityPolicyV1 = (value: unknown): ScaAuthorityPolicyV1 =>
  parsePolicy(ScaAuthorityPolicyV1Schema, value, "SCA authority policy");

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertCanonicalUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail("invalid_policy_contract", `${label} must be unique`);
  }
  if (canonicalJson([...values].sort(compareUtf8)) !== canonicalJson(values)) {
    fail("invalid_policy_contract", `${label} must use canonical UTF-8 ordering`);
  }
}

function assertOpaque(value: string, label: string): void {
  try {
    assertOpaqueId(value, label);
  } catch (error) {
    fail("invalid_policy_contract", error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function assertApproved(bundle: ScaP01PolicyBundle): void {
  const statuses: readonly (readonly [string, "approved" | "denied"])[] = [
    ["analysis_profile", bundle.analysis_profile.status],
    ["rule_release", bundle.rule_release.status],
    ["rule_profile", bundle.rule_profile.status],
    ["toolchain", bundle.toolchain.status],
    ["network_policy", bundle.network_policy.status],
    ["privacy_policy", bundle.privacy_policy.status],
    ["model_data_policy", bundle.model_data_policy.status],
    ["resource_policy", bundle.resource_policy.status],
    ["output_policy", bundle.output_policy.status],
    ["authority_policy", bundle.authority_policy.status],
  ];
  for (const [label, status] of statuses) {
    if (status !== "approved") fail("denied_policy", `${label} is not approved`);
  }
}

export function validateScaP01PolicyBundle(input: {
  readonly bundle: ScaP01PolicyBundle;
  readonly material: ScaP01PolicyMaterial;
  readonly inline_profile: ScaP01InlineProfileBinding;
  readonly inline_authorities: ScaP01InlineAuthorityBinding;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly report_namespace: string;
}): ScaP01PolicyBundle {
  const bundle: ScaP01PolicyBundle = {
    analysis_profile: validateScaAnalysisProfileV1(input.bundle.analysis_profile),
    rule_release: validateScaRuleReleaseV1(input.bundle.rule_release),
    rule_profile: validateScaRuleProfileV1(input.bundle.rule_profile),
    toolchain: validateScaToolchainIdentityV1(input.bundle.toolchain),
    network_policy: validateScaNetworkPolicyV1(input.bundle.network_policy),
    privacy_policy: validateScaPrivacyPolicyV1(input.bundle.privacy_policy),
    model_data_policy: validateScaModelDataPolicyV1(input.bundle.model_data_policy),
    resource_policy: validateScaResourcePolicyV1(input.bundle.resource_policy),
    output_policy: validateScaOutputPolicyV1(input.bundle.output_policy),
    authority_policy: validateScaAuthorityPolicyV1(input.bundle.authority_policy),
  };
  assertApproved(bundle);

  assertOpaque(input.inline_profile.profile_id, "inline profile_id");
  const inlineFrameworks = input.inline_profile.frameworks.map((framework) => ({
    ...framework,
    support_status: "supported" as const,
  }));
  if (
    bundle.analysis_profile.profile_id !== input.inline_profile.profile_id ||
    canonicalJson(bundle.analysis_profile.languages) !==
      canonicalJson(input.inline_profile.languages) ||
    canonicalJson(bundle.analysis_profile.frameworks) !== canonicalJson(inlineFrameworks) ||
    bundle.analysis_profile.frameworks.some((framework) => framework.support_status !== "supported")
  ) {
    fail(
      "profile_mismatch",
      "inline languages/frameworks do not match the approved analysis profile"
    );
  }
  assertCanonicalUnique(bundle.analysis_profile.languages, "analysis profile languages");
  assertCanonicalUnique(
    bundle.analysis_profile.frameworks.map(
      (framework) => `${framework.language}:${framework.framework_id}`
    ),
    "analysis profile frameworks"
  );

  const ruleBundle = validateScaP01RuleBundleV1(input.material.rule_bundle);
  const selectedRuleManifest = validateScaP01SelectedRuleManifestV1(
    input.material.selected_rule_manifest
  );
  const selectedRules = new Set(selectedRuleManifest.selected_rule_ids);
  const bundleRules = new Map(ruleBundle.rules.map((rule) => [rule.rule_id, rule]));
  if (
    bundle.rule_profile.analysis_profile_id !== bundle.analysis_profile.profile_id ||
    bundle.rule_profile.rule_release_id !== bundle.rule_release.release_id ||
    !sameRef(bundle.rule_release.rule_bundle_ref, input.material.rule_bundle_ref) ||
    bundle.rule_release.rules_sha256 !== input.material.rule_bundle_ref.content_digest ||
    ruleBundle.release_id !== bundle.rule_release.release_id ||
    bundle.rule_release.rule_count !== ruleBundle.rules.length ||
    !sameRef(bundle.rule_profile.rule_release_ref, input.material.rule_release_ref) ||
    !sameRef(selectedRuleManifest.rule_release_ref, input.material.rule_release_ref) ||
    !sameRef(
      bundle.rule_profile.selected_rule_manifest_ref,
      input.material.selected_rule_manifest_ref
    ) ||
    bundle.rule_profile.selection_sha256 !==
      input.material.selected_rule_manifest_ref.content_digest ||
    selectedRuleManifest.rule_profile_id !== bundle.rule_profile.rule_profile_id ||
    selectedRuleManifest.analysis_profile_id !== bundle.analysis_profile.profile_id ||
    selectedRuleManifest.rule_release_id !== bundle.rule_release.release_id ||
    canonicalJson(bundle.rule_profile.languages) !==
      canonicalJson(bundle.analysis_profile.languages) ||
    canonicalJson(bundle.rule_release.languages) !==
      canonicalJson(bundle.analysis_profile.languages) ||
    ruleBundle.rules.some((rule) => !bundle.rule_release.languages.includes(rule.language)) ||
    [...selectedRules].some((ruleId) => !bundleRules.has(ruleId)) ||
    !bundle.rule_profile.languages.every((language) =>
      [...selectedRules].some((ruleId) => bundleRules.get(ruleId)?.language === language)
    )
  ) {
    fail(
      "rule_binding_mismatch",
      "rule release, immutable bundle, selected-rule manifest, and analysis profile are misbound"
    );
  }

  if (
    bundle.toolchain.analysis_profile_id !== bundle.analysis_profile.profile_id ||
    bundle.toolchain.source_posture !== "read-only" ||
    bundle.toolchain.package_acquisition !== "forbidden" ||
    bundle.toolchain.target_startup !== "forbidden" ||
    !bundle.toolchain.tools.some((tool) => tool.role === "scanner") ||
    !bundle.toolchain.tools.some((tool) => tool.role === "parser")
  ) {
    fail(
      "unsafe_toolchain",
      "toolchain does not enforce the non-executing offline scanner/parser posture"
    );
  }
  assertCanonicalUnique(
    bundle.toolchain.tools.map((tool) => tool.tool_id),
    "toolchain tool IDs"
  );
  assertCanonicalUnique(
    bundle.toolchain.tools.map(
      (tool) => `${tool.tool_id}:${tool.role}:${tool.version}:${tool.executable_sha256}`
    ),
    "toolchain exact executable identities"
  );
  if (input.material.tools.length !== bundle.toolchain.tools.length) {
    fail("unsafe_toolchain", "each tool identity requires exactly one measured executable package");
  }
  assertCanonicalUnique(
    input.material.tools.map((material) => material.executable_ref.artifact_id).sort(compareUtf8),
    "tool executable package refs"
  );
  assertCanonicalUnique(
    input.material.tools
      .map((material) => material.measurement_receipt_ref.artifact_id)
      .sort(compareUtf8),
    "tool measurement receipt refs"
  );
  for (const tool of bundle.toolchain.tools) {
    assertCanonicalUnique(tool.languages, `toolchain ${tool.tool_id} languages`);
    const material = input.material.tools.find((candidate) =>
      sameRef(candidate.measurement_receipt_ref, tool.measurement_receipt_ref)
    );
    if (material === undefined) {
      fail("unsafe_toolchain", `tool '${tool.tool_id}' has no exact host measurement receipt`);
    }
    const receipt = validateScaP01ToolMeasurementReceiptV1(material.measurement_receipt);
    if (
      !sameRef(tool.executable_ref, material.executable_ref) ||
      !sameRef(receipt.executable_ref, material.executable_ref) ||
      tool.executable_sha256 !== material.executable_ref.content_digest ||
      receipt.executable_sha256 !== tool.executable_sha256 ||
      receipt.tool_id !== tool.tool_id ||
      receipt.role !== tool.role ||
      receipt.version !== tool.version
    ) {
      fail(
        "unsafe_toolchain",
        `tool '${tool.tool_id}' identity, package, and host measurement are misbound`
      );
    }
  }
  for (const language of bundle.analysis_profile.languages) {
    for (const role of ["scanner", "parser"] as const) {
      if (
        !bundle.toolchain.tools.some(
          (tool) => tool.role === role && tool.languages.includes(language)
        )
      ) {
        fail("unsafe_toolchain", `toolchain has no approved ${role} identity for ${language}`);
      }
    }
  }
  if (
    bundle.toolchain.tools.some(
      (tool) =>
        tool.target_execution !== "forbidden" ||
        tool.network_access !== "denied" ||
        tool.acquisition !== "preinstalled-only"
    )
  ) {
    fail("unsafe_toolchain", "toolchain permits network, acquisition, or target execution");
  }

  if (
    bundle.network_policy.default_action !== "deny" ||
    bundle.network_policy.scanner_posture !== "offline" ||
    bundle.network_policy.parser_posture !== "offline" ||
    bundle.network_policy.package_acquisition !== "forbidden" ||
    bundle.network_policy.target_startup !== "forbidden" ||
    bundle.network_policy.dependency_coordinate_lookup !== "separate-admission-required"
  ) {
    fail("unsafe_network_policy", "network policy is not default-deny and scanner-offline");
  }

  if (
    bundle.model_data_policy.model_alias !== SCA_P01_MODEL_ALIAS ||
    bundle.model_data_policy.provider !== SCA_P01_MODEL_PROVIDER ||
    bundle.model_data_policy.model !== SCA_P01_MODEL_ID ||
    bundle.model_data_policy.provider_retention_status !== "known"
  ) {
    fail(
      "model_policy_mismatch",
      "model-data policy does not bind the fixed SCA cognition identity"
    );
  }
  const expectedDataClasses = [
    "dependency-coordinates",
    "personal-data",
    "scanner-evidence",
    "secrets",
    "source-code",
  ];
  assertCanonicalUnique(
    bundle.model_data_policy.data_classes.map((entry) => entry.data_class),
    "model-data classes"
  );
  if (
    canonicalJson(bundle.model_data_policy.data_classes.map((entry) => entry.data_class)) !==
    canonicalJson(expectedDataClasses)
  ) {
    fail(
      "model_policy_mismatch",
      "model-data policy must declare every required data-class treatment"
    );
  }

  if (bundle.output_policy.report_namespace !== input.report_namespace) {
    fail("unsafe_output_policy", "output policy does not bind the requested safe report namespace");
  }

  const authority = bundle.authority_policy;
  if (authority.admission_decision !== "allow" || authority.status !== "approved") {
    fail("authority_denied", "P01 admission authority denied the campaign");
  }
  if (authority.tenant_id !== input.tenant_id || authority.project_id !== input.project_id) {
    fail("authority_mismatch", "authority policy belongs to another tenant or project");
  }
  const expectedGrants = [
    {
      authority_id: input.inline_authorities.execution_authority_id,
      role: "execution",
      posture: "separate-gate-required",
      scope: "sca-execution-policy-binding",
    },
    {
      authority_id: input.inline_authorities.promotion_authority_id,
      role: "promotion",
      posture: "separate-gate-required",
      scope: "sca-rule-promotion",
    },
    {
      authority_id: input.inline_authorities.release_authority_id,
      role: "release",
      posture: "separate-gate-required",
      scope: "sca-campaign-release",
    },
  ] as const;
  const observedGrants = authority.grants.map((grant) => ({
    authority_id: grant.authority_id,
    role: grant.role,
    posture: grant.posture,
    scope: grant.scope,
  }));
  if (authority.grants.some((grant) => grant.posture === "denied")) {
    fail("authority_denied", "a required later consequence authority is denied");
  }
  if (canonicalJson(observedGrants) !== canonicalJson(expectedGrants)) {
    fail(
      "authority_mismatch",
      "authority postures do not exactly identify separate execution, promotion, and release gates"
    );
  }
  assertCanonicalUnique(
    authority.grants.map((grant) => grant.authority_id.toLowerCase()),
    "authority IDs"
  );
  assertCanonicalUnique(
    [authority.admission_lineage_id, ...authority.grants.map((grant) => grant.lineage_id)].sort(
      compareUtf8
    ),
    "authority lineages"
  );
  return bundle;
}
