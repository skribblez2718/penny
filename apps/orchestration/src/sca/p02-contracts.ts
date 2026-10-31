import { Type, type Static, type TSchema } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
  SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
  SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
  SCA_OBLIGATION_LEDGER_V2_SCHEMA,
  SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
  ScaObligationLedgerV2Schema,
  validateScaCampaignManifestCoreV1,
  validateScaCampaignManifestV2,
  validateScaObligationLedgerV2,
  validateScaP01AdmissionContextV1,
  validateScaP01AdmissionEvidenceV1,
  validateScaP01AdmissionRequestV3,
  validateScaPhaseGateRecordV2,
  validateScaPhaseQualificationRecordV2,
  type ScaCampaignManifestCoreV1,
} from "./p01-contracts.js";

const MAX_REFS = 2_048;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_OBSERVATIONS = 1_000_000;
const MAX_TEXT = 4_096;

export const SCA_P02_REQUEST_V1_SCHEMA = "penny.sca-p02-request.v1";
export const SCA_P02_RUNTIME_POLICY_V1_SCHEMA = "penny.sca-p02-runtime-policy.v1";
export const SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA = "penny.sca-p02-isolation-evidence.v1";
export const SCA_P02_INVENTORY_REQUEST_V1_SCHEMA = "penny.sca-p02-inventory-request.v1";
export const SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA = "penny.sca-p02-semgrep-php-request.v1";
export const SCA_P02_SEMGREP_JS_TS_REQUEST_V1_SCHEMA = "penny.sca-p02-semgrep-js-ts-request.v1";
export const SCA_P02_GITLEAKS_REQUEST_V1_SCHEMA = "penny.sca-p02-gitleaks-request.v1";
export const SCA_P02_OSV_COMPOSER_REQUEST_V1_SCHEMA = "penny.sca-p02-osv-composer-request.v1";
export const SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA = "penny.sca-p02-osv-npm-request.v1";
export const SCA_P02_INVENTORY_RESULT_V1_SCHEMA = "penny.sca-p02-inventory-result.v1";
export const SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA = "penny.sca-p02-semgrep-php-result.v1";
export const SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA = "penny.sca-p02-semgrep-js-ts-result.v1";
export const SCA_P02_GITLEAKS_RESULT_V1_SCHEMA = "penny.sca-p02-gitleaks-result.v1";
export const SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA = "penny.sca-p02-osv-composer-result.v1";
export const SCA_P02_OSV_NPM_RESULT_V1_SCHEMA = "penny.sca-p02-osv-npm-result.v1";
export const SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA = "penny.sca-p02-persisted-evidence.v1";
export const SCA_P02_COVERAGE_MATRIX_V1_SCHEMA = "penny.sca-p02-coverage-matrix.v1";
export const SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA = "penny.sca-p02-successor-obligation-ledger.v1";
export const SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA = "penny.sca-p02-evidence-manifest.v1";
export const SCA_P02_GATE_V1_SCHEMA = "penny.sca-p02-gate.v1";
export const SCA_M1_RECORD_V2_SCHEMA = "penny.sca-m1-record.v2";
export const SCA_P02_P03_TRANSITION_V1_SCHEMA = "penny.sca-p02-p03-transition.v1";
export const SCA_P02_CANDIDATE_PRODUCER = "host:sca-p02-candidate" as const;
export const SCA_P02_CANDIDATE_REQUEST_KIND = "sca-p02-candidate-request" as const;
export const SCA_P02_RUNTIME_POLICY_PRODUCER = "host:sca-p02-runtime-policy" as const;
export const SCA_P02_ISOLATION_EVIDENCE_PRODUCER = "host:sca-p02-isolation-qualification" as const;
export const SCA_P02_HOST_ATTESTATION_KIND = "sca-p02-host-isolation-attestation" as const;
export const SCA_P02_HOST_ATTESTATION_V1_SCHEMA =
  "penny.sca-p02-host-isolation-attestation.v1" as const;

export const SCA_P02_SOURCE_CENSUS_IDENTITY = Object.freeze({
  name: "penny-source-census",
  version: "1",
  implementation_sha256: sha256("penny.sca-p02-source-census.v1"),
});
export const SCA_P02_SOURCE_CENSUS_IDENTITY_SHA256 = sha256(
  canonicalJson(SCA_P02_SOURCE_CENSUS_IDENTITY)
);

export const SCA_P02_INPUT_SLOTS = Object.freeze({
  source_file_manifest: "source_file_manifest",
  source_custody: "source_custody",
  rule_bundle: "rule_bundle",
  selected_rule_manifest: "selected_rule_manifest",
  toolchain: "toolchain",
  tool_executable: "tool_executable",
  tool_measurement: "tool_measurement",
  isolation_evidence: "isolation_evidence",
} as const);

export const SCA_P02_OPERATION_IDS = Object.freeze({
  inventory: "sca-p02-inventory",
  semgrep_php: "sca-p02-semgrep-php",
  semgrep_js_ts: "sca-p02-semgrep-js-ts",
  gitleaks: "sca-p02-gitleaks",
  osv_composer: "sca-p02-osv-composer",
  osv_npm: "sca-p02-osv-npm",
} as const);
export type ScaP02OperationKind = keyof typeof SCA_P02_OPERATION_IDS;

/** The live aggregate binds exactly these six factory-issued operation profiles. */
export const ScaP02OperationProfilesV1Schema = Type.Object(
  {
    inventory: Sha256Schema,
    semgrep_php: Sha256Schema,
    semgrep_js_ts: Sha256Schema,
    gitleaks: Sha256Schema,
    osv_composer: Sha256Schema,
    osv_npm: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP02OperationProfilesV1 = Readonly<Static<typeof ScaP02OperationProfilesV1Schema>>;

export function validateScaP02OperationProfilesV1(value: unknown): ScaP02OperationProfilesV1 {
  const profiles = parse(ScaP02OperationProfilesV1Schema, value, "SCA P02 operation profiles");
  assertUnique(Object.values(profiles), "SCA P02 operation profile hashes");
  return profiles;
}

export function scaP02AggregateProfileSha256(profiles: ScaP02OperationProfilesV1): string {
  return sha256(canonicalJson(validateScaP02OperationProfilesV1(profiles)));
}

export const SCA_P02_ANALYZER_IDS = Object.freeze([
  "source-census",
  "tree-sitter-php",
  "tree-sitter-js-ts",
  "dependency-composer",
  "dependency-npm",
  "semgrep-php",
  "semgrep-js-ts",
  "gitleaks",
  "osv-composer",
  "osv-npm",
] as const);
export type ScaP02AnalyzerId = (typeof SCA_P02_ANALYZER_IDS)[number];

const AnalyzerIdSchema = Type.Union([
  Type.Literal("source-census"),
  Type.Literal("tree-sitter-php"),
  Type.Literal("tree-sitter-js-ts"),
  Type.Literal("dependency-composer"),
  Type.Literal("dependency-npm"),
  Type.Literal("semgrep-php"),
  Type.Literal("semgrep-js-ts"),
  Type.Literal("gitleaks"),
  Type.Literal("osv-composer"),
  Type.Literal("osv-npm"),
]);
const OperationKindSchema = Type.Union([
  Type.Literal("inventory"),
  Type.Literal("semgrep_php"),
  Type.Literal("semgrep_js_ts"),
  Type.Literal("gitleaks"),
  Type.Literal("osv_composer"),
  Type.Literal("osv_npm"),
]);
const BoundedTextSchema = Type.String({ minLength: 1, maxLength: MAX_TEXT });

const P01BindingsSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    campaign_manifest_core_ref: ArtifactRefSchema,
    admission_evidence_ref: ArtifactRefSchema,
    p01_gate_ref: ArtifactRefSchema,
    campaign_manifest_ref: ArtifactRefSchema,
    frozen_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: MAX_REFS }),
  },
  { additionalProperties: false }
);

export const ScaP02RequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_REQUEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    accepted_p01: P01BindingsSchema,
    runtime_policy_ref: ArtifactRefSchema,
    isolation_evidence_ref: ArtifactRefSchema,
    isolation_host_attestation_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    requested_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false, $id: SCA_P02_REQUEST_V1_SCHEMA }
);
export type ScaP02RequestV1 = Readonly<Static<typeof ScaP02RequestV1Schema>>;

const ExecutableBindingSchema = Type.Object(
  {
    tool_id: OpaqueIdSchema,
    executable_path: Type.String({ minLength: 1, maxLength: 4_096 }),
    executable_sha256: Sha256Schema,
    version: OpaqueIdSchema,
  },
  { additionalProperties: false }
);

export const ScaP02RuntimePolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_RUNTIME_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    policy_id: OpaqueIdSchema,
    staging_parent: Type.String({ minLength: 1, maxLength: 4_096 }),
    isolation_evidence_ref: ArtifactRefSchema,
    executables: Type.Array(ExecutableBindingSchema, { minItems: 2, maxItems: 16 }),
    operation_tools: Type.Object(
      {
        semgrep_tool_id: OpaqueIdSchema,
        gitleaks_tool_id: OpaqueIdSchema,
      },
      { additionalProperties: false }
    ),
    semgrep_max_output_bytes: Type.Integer({ minimum: 1, maximum: MAX_EVIDENCE_BYTES }),
    gitleaks_max_output_bytes: Type.Integer({ minimum: 1, maximum: MAX_EVIDENCE_BYTES }),
    process_timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
    internal_component_identities: Type.Object(
      {
        source_census_sha256: Sha256Schema,
        tree_sitter_sha256: Sha256Schema,
      },
      { additionalProperties: false }
    ),
    tree_sitter: Type.Object(
      {
        parse_timeout_micros: Type.Integer({ minimum: 1, maximum: 300_000_000 }),
        max_file_bytes: Type.Integer({ minimum: 1, maximum: 64 * 1024 * 1024 }),
        max_total_bytes: Type.Integer({ minimum: 1, maximum: 512 * 1024 * 1024 }),
        max_files: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
        max_nodes_per_file: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
        max_depth: Type.Integer({ minimum: 1, maximum: 100_000 }),
        max_diagnostics_per_file: Type.Integer({ minimum: 1, maximum: 1_024 }),
        max_symbols_per_file: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
        query_match_limit: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
      },
      { additionalProperties: false }
    ),
    gitleaks_configuration_rule_id: OpaqueIdSchema,
    osv: Type.Object(
      {
        transport_id: OpaqueIdSchema,
        max_batch_size: Type.Integer({ minimum: 1, maximum: 1_000 }),
        max_concurrency: Type.Integer({ minimum: 1, maximum: 64 }),
        timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
        max_response_bytes: Type.Integer({ minimum: 1, maximum: MAX_EVIDENCE_BYTES }),
        max_advisory_requests: Type.Integer({ minimum: 0, maximum: 10_000 }),
        freshness_max_age_seconds: Type.Integer({ minimum: 1, maximum: 31_536_000 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false, $id: SCA_P02_RUNTIME_POLICY_V1_SCHEMA }
);
export type ScaP02RuntimePolicyV1 = Readonly<Static<typeof ScaP02RuntimePolicyV1Schema>>;

const IsolationEvidenceCommon = {
  schema_id: Type.Literal(SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA),
  schema_version: Type.Literal(1),
  producer_id: Type.Literal(SCA_P02_ISOLATION_EVIDENCE_PRODUCER),
  isolation_id: OpaqueIdSchema,
  runtime_id: OpaqueIdSchema,
  implementation_identity_sha256: Sha256Schema,
  deployment_identity_sha256: Sha256Schema,
  profile_id: OpaqueIdSchema,
  profile_sha256: Sha256Schema,
  qualified_at: Rfc3339UtcSchema,
} as const;

export const ScaP02HostIsolationAttestationV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_HOST_ATTESTATION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    attestation_id: OpaqueIdSchema,
    runtime_kind: Type.Literal("host_qualified"),
    isolation_id: OpaqueIdSchema,
    runtime_id: OpaqueIdSchema,
    implementation_identity_sha256: Sha256Schema,
    deployment_identity_sha256: Sha256Schema,
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    operation_profiles: ScaP02OperationProfilesV1Schema,
    qualification_scope: Type.Literal("live_qualified"),
    qualified: Type.Literal(true),
    attested_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false, $id: SCA_P02_HOST_ATTESTATION_V1_SCHEMA }
);
export type ScaP02HostIsolationAttestationV1 = Readonly<
  Static<typeof ScaP02HostIsolationAttestationV1Schema>
>;

export const ScaP02IsolationEvidenceV1Schema = Type.Union(
  [
    Type.Object(
      {
        ...IsolationEvidenceCommon,
        evidence_kind: Type.Literal("simulated_test_seam"),
        runtime_kind: Type.Literal("simulated_test_runtime"),
        qualification_scope: Type.Literal("deterministic_test_only"),
        qualified: Type.Literal(false),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        ...IsolationEvidenceCommon,
        evidence_kind: Type.Literal("host_qualification_attestation"),
        runtime_kind: Type.Literal("host_qualified"),
        qualification_scope: Type.Literal("live_qualified"),
        qualified: Type.Literal(true),
        operation_profiles: ScaP02OperationProfilesV1Schema,
        host_attestation_id: OpaqueIdSchema,
        host_attestation_sha256: Sha256Schema,
        host_attestation_ref: ArtifactRefSchema,
      },
      { additionalProperties: false }
    ),
  ],
  { $id: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA }
);
export type ScaP02IsolationEvidenceV1 = Readonly<Static<typeof ScaP02IsolationEvidenceV1Schema>>;

export function scaP02OperationProfileSha256(
  evidence: ScaP02IsolationEvidenceV1,
  kind: ScaP02OperationKind
): string {
  return evidence.qualification_scope === "live_qualified"
    ? evidence.operation_profiles[kind]
    : evidence.profile_sha256;
}

const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);
const RuleContentBindingSchema = Type.Object(
  { rule_id: OpaqueIdSchema, content_sha256: Sha256Schema },
  { additionalProperties: false }
);

const OperationRequestCommon = {
  schema_version: Type.Literal(1),
  run_id: OpaqueIdSchema,
  operation_id: OpaqueIdSchema,
  p01_binding_sha256: Sha256Schema,
  p02_request_ref: ArtifactRefSchema,
  runtime_policy_ref: ArtifactRefSchema,
  isolation_evidence_ref: ArtifactRefSchema,
  isolation_id: OpaqueIdSchema,
  isolation_runtime_id: OpaqueIdSchema,
  isolation_runtime_kind: Type.Union([
    Type.Literal("simulated_test_runtime"),
    Type.Literal("host_qualified"),
  ]),
  isolation_qualification_scope: Type.Union([
    Type.Literal("deterministic_test_only"),
    Type.Literal("live_qualified"),
  ]),
  isolation_profile_id: OpaqueIdSchema,
  isolation_profile_sha256: Sha256Schema,
  isolation_implementation_sha256: Sha256Schema,
  isolation_deployment_sha256: Sha256Schema,
  isolation_host_attestation_id: Type.Union([OpaqueIdSchema, Type.Null()]),
  isolation_host_attestation_sha256: Type.Union([Sha256Schema, Type.Null()]),
  isolation_host_attestation_ref: NullableArtifactRefSchema,
  request_sha256: Sha256Schema,
} as const;

const SourceOperationRequestCommon = {
  ...OperationRequestCommon,
  source_snapshot_ref: ArtifactRefSchema,
  source_snapshot_sha256: Sha256Schema,
  staging_parent: Type.String({ minLength: 1, maxLength: 4_096 }),
} as const;

export const ScaP02InventoryRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_INVENTORY_REQUEST_V1_SCHEMA),
    ...SourceOperationRequestCommon,
    operation_kind: Type.Literal("inventory"),
    source_census_identity_sha256: Sha256Schema,
    tree_sitter_identity_sha256: Sha256Schema,
    tree_sitter: ScaP02RuntimePolicyV1Schema.properties.tree_sitter,
  },
  { additionalProperties: false, $id: SCA_P02_INVENTORY_REQUEST_V1_SCHEMA }
);

const ScannerRequestFields = {
  ...SourceOperationRequestCommon,
  executable: ExecutableBindingSchema,
  timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
  max_output_bytes: Type.Integer({ minimum: 1, maximum: MAX_EVIDENCE_BYTES }),
} as const;

export const ScaP02SemgrepPhpRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA),
    ...ScannerRequestFields,
    operation_id: Type.Literal(SCA_P02_OPERATION_IDS.semgrep_php),
    operation_kind: Type.Literal("semgrep_php"),
    languages: Type.Tuple([Type.Literal("php")]),
    excluded_rule_ids: Type.Array(OpaqueIdSchema, { maxItems: 16 }),
    selected_rule_bindings: Type.Array(RuleContentBindingSchema, {
      minItems: 1,
      maxItems: 1_000_000,
    }),
  },
  { additionalProperties: false, $id: SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA }
);
export const ScaP02SemgrepJsTsRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_SEMGREP_JS_TS_REQUEST_V1_SCHEMA),
    ...ScannerRequestFields,
    operation_id: Type.Literal(SCA_P02_OPERATION_IDS.semgrep_js_ts),
    operation_kind: Type.Literal("semgrep_js_ts"),
    languages: Type.Tuple([Type.Literal("javascript"), Type.Literal("typescript")]),
    excluded_rule_ids: Type.Array(OpaqueIdSchema, { maxItems: 16 }),
    selected_rule_bindings: Type.Array(RuleContentBindingSchema, {
      minItems: 1,
      maxItems: 1_000_000,
    }),
  },
  { additionalProperties: false, $id: SCA_P02_SEMGREP_JS_TS_REQUEST_V1_SCHEMA }
);
export const ScaP02GitleaksRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_GITLEAKS_REQUEST_V1_SCHEMA),
    ...ScannerRequestFields,
    operation_id: Type.Literal(SCA_P02_OPERATION_IDS.gitleaks),
    operation_kind: Type.Literal("gitleaks"),
    configuration_rule_binding: RuleContentBindingSchema,
  },
  { additionalProperties: false, $id: SCA_P02_GITLEAKS_REQUEST_V1_SCHEMA }
);

const PackageSchema = Type.Object(
  {
    ecosystem: Type.Union([Type.Literal("Packagist"), Type.Literal("npm")]),
    name: Type.String({ minLength: 1, maxLength: 512 }),
    version: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false }
);
const OsvCoordinateSchema = Type.Object(
  { query_id: OpaqueIdSchema, package: PackageSchema },
  { additionalProperties: false }
);
const OsvMappingSchema = Type.Object(
  { query_id: OpaqueIdSchema, occurrence_id: OpaqueIdSchema, package: PackageSchema },
  { additionalProperties: false }
);
const OsvRequestFields = {
  ...OperationRequestCommon,
  coordinates: Type.Array(OsvCoordinateSchema, { maxItems: 1_000_000 }),
  mappings: Type.Array(OsvMappingSchema, { maxItems: 1_000_000 }),
  transport_id: OpaqueIdSchema,
  max_batch_size: Type.Integer({ minimum: 1, maximum: 1_000 }),
  max_concurrency: Type.Integer({ minimum: 1, maximum: 64 }),
  timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
  max_response_bytes: Type.Integer({ minimum: 1, maximum: MAX_EVIDENCE_BYTES }),
  max_advisory_requests: Type.Integer({ minimum: 0, maximum: 10_000 }),
  freshness_max_age_seconds: Type.Integer({ minimum: 1, maximum: 31_536_000 }),
} as const;
export const ScaP02OsvComposerRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_OSV_COMPOSER_REQUEST_V1_SCHEMA),
    ...OsvRequestFields,
    operation_id: Type.Literal(SCA_P02_OPERATION_IDS.osv_composer),
    operation_kind: Type.Literal("osv_composer"),
    ecosystem: Type.Literal("Packagist"),
  },
  { additionalProperties: false, $id: SCA_P02_OSV_COMPOSER_REQUEST_V1_SCHEMA }
);
export const ScaP02OsvNpmRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA),
    ...OsvRequestFields,
    operation_id: Type.Literal(SCA_P02_OPERATION_IDS.osv_npm),
    operation_kind: Type.Literal("osv_npm"),
    ecosystem: Type.Literal("npm"),
  },
  { additionalProperties: false, $id: SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA }
);

export type ScaP02InventoryRequestV1 = Readonly<Static<typeof ScaP02InventoryRequestV1Schema>>;
export type ScaP02SemgrepPhpRequestV1 = Readonly<Static<typeof ScaP02SemgrepPhpRequestV1Schema>>;
export type ScaP02SemgrepJsTsRequestV1 = Readonly<Static<typeof ScaP02SemgrepJsTsRequestV1Schema>>;
export type ScaP02GitleaksRequestV1 = Readonly<Static<typeof ScaP02GitleaksRequestV1Schema>>;
export type ScaP02OsvComposerRequestV1 = Readonly<Static<typeof ScaP02OsvComposerRequestV1Schema>>;
export type ScaP02OsvNpmRequestV1 = Readonly<Static<typeof ScaP02OsvNpmRequestV1Schema>>;
export type ScaP02OperationRequestV1 =
  | ScaP02InventoryRequestV1
  | ScaP02SemgrepPhpRequestV1
  | ScaP02SemgrepJsTsRequestV1
  | ScaP02GitleaksRequestV1
  | ScaP02OsvComposerRequestV1
  | ScaP02OsvNpmRequestV1;

export const ScaP02RawEvidenceV1Schema = Type.Object(
  {
    evidence_id: Type.String({ pattern: "^p02e_[a-f0-9]{64}$" }),
    analyzer_id: AnalyzerIdSchema,
    content_schema_id: Type.String({ pattern: "^penny\\.[a-z0-9-]+\\.v[1-9][0-9]*$" }),
    content_schema_version: Type.Integer({ minimum: 1, maximum: 1_000 }),
    media_type: Type.Literal("application/json"),
    encoding: Type.Literal("base64"),
    content_base64: Type.String({ maxLength: Math.ceil((MAX_EVIDENCE_BYTES * 4) / 3) + 4 }),
    content_sha256: Sha256Schema,
    byte_length: Type.Integer({ minimum: 0, maximum: MAX_EVIDENCE_BYTES }),
    retention: Type.Union([Type.Literal("exact"), Type.Literal("minimized")]),
    original_content_sha256: Type.Union([Sha256Schema, Type.Null()]),
    original_byte_length: Type.Union([
      Type.Integer({ minimum: 0, maximum: MAX_EVIDENCE_BYTES }),
      Type.Null(),
    ]),
    raw_record_ids: Type.Array(Type.String({ pattern: "^p02raw_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: MAX_OBSERVATIONS,
    }),
  },
  { additionalProperties: false }
);
export type ScaP02RawEvidenceV1 = Readonly<Static<typeof ScaP02RawEvidenceV1Schema>>;

export const ScaP02RawRecordV1Schema = Type.Object(
  {
    raw_record_id: Type.String({ pattern: "^p02raw_[a-f0-9]{64}$" }),
    evidence_id: Type.String({ pattern: "^p02e_[a-f0-9]{64}$" }),
    analyzer_id: AnalyzerIdSchema,
    record_kind: Type.Union([
      Type.Literal("finding"),
      Type.Literal("candidate"),
      Type.Literal("context"),
      Type.Literal("summary"),
      Type.Literal("blocker"),
      Type.Literal("batch"),
      Type.Literal("mapping"),
    ]),
    source_pointer: Type.String({ maxLength: 4_096 }),
    record_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP02RawRecordV1 = Readonly<Static<typeof ScaP02RawRecordV1Schema>>;

const RawRecordIdArraySchema = Type.Array(Type.String({ pattern: "^p02raw_[a-f0-9]{64}$" }), {
  minItems: 1,
  maxItems: MAX_OBSERVATIONS,
});
const RawEvidenceIdArraySchema = Type.Array(Type.String({ pattern: "^p02e_[a-f0-9]{64}$" }), {
  minItems: 1,
  maxItems: 64,
});

export const ScaP02NormalizedObservationV1Schema = Type.Object(
  {
    observation_id: Type.String({ pattern: "^scaobs_[a-f0-9]{64}$" }),
    analyzer_id: AnalyzerIdSchema,
    category: Type.String({ minLength: 1, maxLength: 128 }),
    severity: Type.Union([
      Type.Literal("info"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("critical"),
      Type.Literal("unknown"),
    ]),
    subject: BoundedTextSchema,
    path: Type.Union([Type.String({ minLength: 1, maxLength: 4_096 }), Type.Null()]),
    start_line: Type.Union([Type.Integer({ minimum: 1, maximum: 1_000_000_000 }), Type.Null()]),
    advisory_id: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    fingerprint_sha256: Sha256Schema,
    raw_evidence_ids: RawEvidenceIdArraySchema,
    raw_record_ids: RawRecordIdArraySchema,
    correlation_id: Type.String({ pattern: "^p02corr_[a-f0-9]{64}$" }),
    duplicate_group_id: Type.Union([
      Type.String({ pattern: "^p02dup_[a-f0-9]{64}$" }),
      Type.Null(),
    ]),
    provenance_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP02NormalizedObservationV1 = Readonly<
  Static<typeof ScaP02NormalizedObservationV1Schema>
>;

export const ScaP02CorrelationRecordV1Schema = Type.Object(
  {
    correlation_id: Type.String({ pattern: "^p02corr_[a-f0-9]{64}$" }),
    analyzer_id: AnalyzerIdSchema,
    normalized_observation_id: Type.Union([
      Type.String({ pattern: "^scaobs_[a-f0-9]{64}$" }),
      Type.Null(),
    ]),
    raw_record_ids: RawRecordIdArraySchema,
    disposition: Type.Union([
      Type.Literal("normalized"),
      Type.Literal("context_only"),
      Type.Literal("blocked"),
    ]),
    disposition_code: Type.Union([
      Type.Literal("source_census_member"),
      Type.Literal("symbol_index_member"),
      Type.Literal("dependency_inventory_member"),
      Type.Null(),
    ]),
    duplicate_group_id: Type.Union([
      Type.String({ pattern: "^p02dup_[a-f0-9]{64}$" }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false }
);
export type ScaP02CorrelationRecordV1 = Readonly<Static<typeof ScaP02CorrelationRecordV1Schema>>;

const AnalyzerResultSchema = Type.Object(
  {
    analyzer_id: AnalyzerIdSchema,
    applicability: Type.Union([Type.Literal("applicable"), Type.Literal("not_applicable")]),
    status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
    fresh: Type.Union([Type.Boolean(), Type.Null()]),
    blocker_codes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type ScaP02AnalyzerResultV1 = Readonly<Static<typeof AnalyzerResultSchema>>;

const OperationResultCommon = {
  schema_version: Type.Literal(1),
  run_id: OpaqueIdSchema,
  operation_id: OpaqueIdSchema,
  request_sha256: Sha256Schema,
  source_binding_sha256: Sha256Schema,
  isolation_id: OpaqueIdSchema,
  isolation_runtime_id: OpaqueIdSchema,
  isolation_runtime_kind: Type.Union([
    Type.Literal("simulated_test_runtime"),
    Type.Literal("host_qualified"),
  ]),
  isolation_qualification_scope: Type.Union([
    Type.Literal("deterministic_test_only"),
    Type.Literal("live_qualified"),
  ]),
  isolation_profile_id: OpaqueIdSchema,
  isolation_profile_sha256: Sha256Schema,
  isolation_implementation_sha256: Sha256Schema,
  isolation_deployment_sha256: Sha256Schema,
  isolation_host_attestation_id: Type.Union([OpaqueIdSchema, Type.Null()]),
  isolation_host_attestation_sha256: Type.Union([Sha256Schema, Type.Null()]),
  isolation_host_attestation_ref: NullableArtifactRefSchema,
  status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
  analyzer_results: Type.Array(AnalyzerResultSchema, { minItems: 1, maxItems: 10 }),
  raw_evidence: Type.Array(ScaP02RawEvidenceV1Schema, { minItems: 1, maxItems: 64 }),
  raw_records: Type.Array(ScaP02RawRecordV1Schema, {
    minItems: 1,
    maxItems: MAX_OBSERVATIONS,
  }),
  normalized_observations: Type.Array(ScaP02NormalizedObservationV1Schema, {
    maxItems: MAX_OBSERVATIONS,
  }),
  correlations: Type.Array(ScaP02CorrelationRecordV1Schema, {
    minItems: 1,
    maxItems: MAX_OBSERVATIONS,
  }),
  freshness: Type.Object(
    {
      fetched_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
      max_age_seconds: Type.Union([Type.Integer({ minimum: 1, maximum: 31_536_000 }), Type.Null()]),
      expires_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
    },
    { additionalProperties: false }
  ),
  completed_at: Rfc3339UtcSchema,
} as const;

const DependencyCoordinateSchema = Type.Object(
  { query_id: OpaqueIdSchema, package: PackageSchema },
  { additionalProperties: false }
);
const DependencyMappingSchema = Type.Object(
  { query_id: OpaqueIdSchema, occurrence_id: OpaqueIdSchema, package: PackageSchema },
  { additionalProperties: false }
);
const EcosystemStateSchema = Type.Object(
  {
    ecosystem: Type.Union([Type.Literal("Packagist"), Type.Literal("npm")]),
    state: Type.Union([
      Type.Literal("supported"),
      Type.Literal("partial"),
      Type.Literal("absent"),
      Type.Literal("malformed"),
      Type.Literal("unsupported"),
    ]),
  },
  { additionalProperties: false }
);

export const ScaP02InventoryResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_INVENTORY_RESULT_V1_SCHEMA),
    ...OperationResultCommon,
    operation_id: Type.Literal(SCA_P02_OPERATION_IDS.inventory),
    operation_kind: Type.Literal("inventory"),
    dependency_coordinates: Type.Array(DependencyCoordinateSchema, { maxItems: 1_000_000 }),
    dependency_mappings: Type.Array(DependencyMappingSchema, { maxItems: 1_000_000 }),
    ecosystem_states: Type.Array(EcosystemStateSchema, { minItems: 2, maxItems: 2 }),
  },
  { additionalProperties: false, $id: SCA_P02_INVENTORY_RESULT_V1_SCHEMA }
);

function operationResultSchema<SchemaId extends string, Kind extends ScaP02OperationKind>(
  schemaId: SchemaId,
  kind: Kind
) {
  return Type.Object(
    {
      schema_id: Type.Literal(schemaId),
      ...OperationResultCommon,
      operation_id: Type.Literal(SCA_P02_OPERATION_IDS[kind]),
      operation_kind: Type.Literal(kind),
    },
    { additionalProperties: false, $id: schemaId }
  );
}

export const ScaP02SemgrepPhpResultV1Schema = operationResultSchema(
  SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
  "semgrep_php"
);
export const ScaP02SemgrepJsTsResultV1Schema = operationResultSchema(
  SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
  "semgrep_js_ts"
);
export const ScaP02GitleaksResultV1Schema = operationResultSchema(
  SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
  "gitleaks"
);
export const ScaP02OsvComposerResultV1Schema = operationResultSchema(
  SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
  "osv_composer"
);
export const ScaP02OsvNpmResultV1Schema = operationResultSchema(
  SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
  "osv_npm"
);

export type ScaP02InventoryResultV1 = Readonly<Static<typeof ScaP02InventoryResultV1Schema>>;
export type ScaP02OperationResultV1 =
  | ScaP02InventoryResultV1
  | Readonly<Static<typeof ScaP02SemgrepPhpResultV1Schema>>
  | Readonly<Static<typeof ScaP02SemgrepJsTsResultV1Schema>>
  | Readonly<Static<typeof ScaP02GitleaksResultV1Schema>>
  | Readonly<Static<typeof ScaP02OsvComposerResultV1Schema>>
  | Readonly<Static<typeof ScaP02OsvNpmResultV1Schema>>;

/**
 * Host-owned semantic authority for decoded P02 component evidence. The result, caller,
 * directive, and model cannot supply or serialize this capability.
 */
export interface ScaP02ComponentValidationAuthorityV1 {
  validateComponents(
    input: Readonly<{
      operation_kind: ScaP02OperationKind;
      request: ScaP02OperationRequestV1;
      result: ScaP02OperationResultV1;
    }>
  ): void;
}

export const ScaP02PersistedEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    operation_kind: OperationKindSchema,
    operation_result_ref: ArtifactRefSchema,
    analyzer_results: Type.Array(AnalyzerResultSchema, { minItems: 1, maxItems: 10 }),
    raw_evidence: Type.Array(ScaP02RawEvidenceV1Schema, { minItems: 1, maxItems: 64 }),
    raw_records: Type.Array(ScaP02RawRecordV1Schema, {
      minItems: 1,
      maxItems: MAX_OBSERVATIONS,
    }),
    normalized_observations: Type.Array(ScaP02NormalizedObservationV1Schema, {
      maxItems: MAX_OBSERVATIONS,
    }),
    correlations: Type.Array(ScaP02CorrelationRecordV1Schema, {
      minItems: 1,
      maxItems: MAX_OBSERVATIONS,
    }),
    freshness: OperationResultCommon.freshness,
    evidence_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA }
);
export type ScaP02PersistedEvidenceV1 = Readonly<Static<typeof ScaP02PersistedEvidenceV1Schema>>;

const CoverageEntrySchema = Type.Object(
  {
    analyzer_id: AnalyzerIdSchema,
    operation_kind: OperationKindSchema,
    applicability: Type.Union([Type.Literal("applicable"), Type.Literal("not_applicable")]),
    status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
    fresh: Type.Union([Type.Boolean(), Type.Null()]),
    blocker_codes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
    operation_result_ref: ArtifactRefSchema,
    normalized_evidence_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export const ScaP02CoverageMatrixV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_COVERAGE_MATRIX_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    p01_binding_sha256: Sha256Schema,
    entries: Type.Array(CoverageEntrySchema, { minItems: 10, maxItems: 10 }),
    coverage_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P02_COVERAGE_MATRIX_V1_SCHEMA }
);
export type ScaP02CoverageMatrixV1 = Readonly<Static<typeof ScaP02CoverageMatrixV1Schema>>;

export const SCA_P02_DISPOSITION_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-P01-ACCEPTANCE",
  "SCA-OBL-OUTPUT-SOURCE-CENSUS",
  "SCA-OBL-OUTPUT-SYNTAX-INDEX",
  "SCA-OBL-OUTPUT-SEMGREP",
  "SCA-OBL-OUTPUT-SECRET-SCAN",
  "SCA-OBL-OUTPUT-DEPENDENCY-INVENTORY",
  "SCA-OBL-OUTPUT-OSV-EVIDENCE",
  "SCA-OBL-OUTPUT-NORMALIZED-CANDIDATES",
  "SCA-OBL-P02-ACCEPTANCE",
  "SCA-OBL-M1-NONTERMINAL",
] as const);

const SuccessorDispositionSchema = Type.Object(
  {
    obligation_id: Type.Union([
      Type.Literal("SCA-OBL-P01-ACCEPTANCE"),
      Type.Literal("SCA-OBL-OUTPUT-SOURCE-CENSUS"),
      Type.Literal("SCA-OBL-OUTPUT-SYNTAX-INDEX"),
      Type.Literal("SCA-OBL-OUTPUT-SEMGREP"),
      Type.Literal("SCA-OBL-OUTPUT-SECRET-SCAN"),
      Type.Literal("SCA-OBL-OUTPUT-DEPENDENCY-INVENTORY"),
      Type.Literal("SCA-OBL-OUTPUT-OSV-EVIDENCE"),
      Type.Literal("SCA-OBL-OUTPUT-NORMALIZED-CANDIDATES"),
      Type.Literal("SCA-OBL-P02-ACCEPTANCE"),
      Type.Literal("SCA-OBL-M1-NONTERMINAL"),
    ]),
    status: Type.Union([Type.Literal("satisfied"), Type.Literal("blocked")]),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false }
);

export const ScaP02SuccessorLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    prior_p01_ledger_ref: ArtifactRefSchema,
    prior_p01_ledger_sha256: Sha256Schema,
    prior_entry_count: Type.Integer({ minimum: 1, maximum: 100_000 }),
    prior_event_count: Type.Integer({ minimum: 1, maximum: 100_000 }),
    prior_entries: ScaObligationLedgerV2Schema.properties.entries,
    prior_events: ScaObligationLedgerV2Schema.properties.events,
    p01_campaign_manifest_ref: ArtifactRefSchema,
    dispositions: Type.Array(SuccessorDispositionSchema, { minItems: 10, maxItems: 10 }),
    pending_phase_ids: Type.Tuple([
      Type.Literal("SCA-P03"),
      Type.Literal("SCA-P04"),
      Type.Literal("SCA-P05"),
      Type.Literal("SCA-P06"),
      Type.Literal("SCA-P07"),
      Type.Literal("SCA-P08"),
      Type.Literal("SCA-P09"),
      Type.Literal("SCA-P10"),
      Type.Literal("SCA-P11"),
      Type.Literal("SCA-P12"),
    ]),
    append_only: Type.Literal(true),
    campaign_completion_claimed: Type.Literal(false),
    release_eligible: Type.Literal(false),
    recorded_at: Rfc3339UtcSchema,
    ledger_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA }
);
export type ScaP02SuccessorLedgerV1 = Readonly<Static<typeof ScaP02SuccessorLedgerV1Schema>>;

const EvidenceManifestOperationSchema = Type.Object(
  {
    operation_kind: OperationKindSchema,
    operation_request_ref: ArtifactRefSchema,
    operation_result_ref: ArtifactRefSchema,
    normalized_evidence_ref: ArtifactRefSchema,
    operation_receipt_ref: ArtifactRefSchema,
    status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
    raw_evidence_ids: Type.Array(Type.String({ pattern: "^p02e_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 64,
    }),
    raw_record_ids: RawRecordIdArraySchema,
  },
  { additionalProperties: false }
);
const EvidenceManifestAnalyzerSchema = Type.Object(
  {
    analyzer_id: AnalyzerIdSchema,
    operation_kind: OperationKindSchema,
    operation_result_ref: ArtifactRefSchema,
    normalized_evidence_ref: ArtifactRefSchema,
    applicability: Type.Union([Type.Literal("applicable"), Type.Literal("not_applicable")]),
    status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
    fresh: Type.Union([Type.Boolean(), Type.Null()]),
    fetched_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
    max_age_seconds: Type.Union([Type.Integer({ minimum: 1, maximum: 31_536_000 }), Type.Null()]),
    expires_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
    unsupported: Type.Boolean(),
    truncated: Type.Boolean(),
    blocker_codes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
    raw_evidence_ids: Type.Array(Type.String({ pattern: "^p02e_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 64,
    }),
    raw_record_ids: RawRecordIdArraySchema,
  },
  { additionalProperties: false }
);
const OsvEvidenceSummarySchema = Type.Object(
  {
    analyzer_id: Type.Union([Type.Literal("osv-composer"), Type.Literal("osv-npm")]),
    operation_result_ref: ArtifactRefSchema,
    batch_evidence_ids: Type.Array(Type.String({ pattern: "^p02e_[a-f0-9]{64}$" }), {
      minItems: 1,
      maxItems: 64,
    }),
    coordinate_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_OBSERVATIONS }),
    occurrence_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_OBSERVATIONS }),
    fetched_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
    max_age_seconds: Type.Union([Type.Integer({ minimum: 1, maximum: 31_536_000 }), Type.Null()]),
    expires_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

export const ScaP02EvidenceManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    p02_request_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    isolation_evidence_ref: ArtifactRefSchema,
    isolation_host_attestation_ref: NullableArtifactRefSchema,
    p01_request_ref: ArtifactRefSchema,
    p01_campaign_manifest_core_ref: ArtifactRefSchema,
    p01_campaign_manifest_ref: ArtifactRefSchema,
    p01_predecessor_ledger_ref: ArtifactRefSchema,
    coverage_matrix_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    operations: Type.Array(EvidenceManifestOperationSchema, { minItems: 6, maxItems: 6 }),
    analyzers: Type.Array(EvidenceManifestAnalyzerSchema, { minItems: 10, maxItems: 10 }),
    symbol_evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 6 }),
    dependency_evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 6 }),
    osv_evidence: Type.Array(OsvEvidenceSummarySchema, { minItems: 2, maxItems: 2 }),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA }
);
export type ScaP02EvidenceManifestV1 = Readonly<Static<typeof ScaP02EvidenceManifestV1Schema>>;

export const ScaP02GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_GATE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    p02_request_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    isolation_evidence_ref: ArtifactRefSchema,
    isolation_host_attestation_ref: NullableArtifactRefSchema,
    coverage_matrix_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    isolation_scope: Type.Union([
      Type.Literal("deterministic_test_only"),
      Type.Literal("live_qualified"),
    ]),
    status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    blocker_codes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 1_024 }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P02_GATE_V1_SCHEMA }
);
export type ScaP02GateV1 = Readonly<Static<typeof ScaP02GateV1Schema>>;

export const ScaM1RecordV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M1_RECORD_V2_SCHEMA),
    schema_version: Type.Literal(2),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P02"),
    p02_request_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    isolation_evidence_ref: ArtifactRefSchema,
    isolation_host_attestation_ref: NullableArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    coverage_matrix_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    nonterminal: Type.Literal(true),
    release_eligible: Type.Literal(false),
    campaign_terminal: Type.Literal(false),
    model_calls: Type.Literal(0),
    model_turns: Type.Literal(0),
    blocker_codes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 1_024 }),
    transition_authorized: Type.Boolean(),
    recorded_at: Rfc3339UtcSchema,
    record_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_M1_RECORD_V2_SCHEMA }
);
export type ScaM1RecordV2 = Readonly<Static<typeof ScaM1RecordV2Schema>>;

export const ScaP02P03TransitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P02_P03_TRANSITION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    from_phase_id: Type.Literal("SCA-P02"),
    to_phase_id: Type.Literal("SCA-P03"),
    p02_request_ref: ArtifactRefSchema,
    runtime_policy_ref: ArtifactRefSchema,
    isolation_evidence_ref: ArtifactRefSchema,
    isolation_host_attestation_ref: NullableArtifactRefSchema,
    p01_request_ref: ArtifactRefSchema,
    p01_campaign_manifest_core_ref: ArtifactRefSchema,
    p01_campaign_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    p02_gate_ref: ArtifactRefSchema,
    coverage_matrix_ref: ArtifactRefSchema,
    m1_ref: ArtifactRefSchema,
    consumed_as_of: Rfc3339UtcSchema,
    qualification_claimed: Type.Literal(false),
    campaign_terminal: Type.Literal(false),
    release_eligible: Type.Literal(false),
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P02_P03_TRANSITION_V1_SCHEMA }
);
export type ScaP02P03TransitionV1 = Readonly<Static<typeof ScaP02P03TransitionV1Schema>>;

export class ScaP02ContractError extends Error {
  constructor(
    readonly code:
      | "invalid_contract"
      | "invalid_binding"
      | "duplicate_identity"
      | "incomplete_coverage"
      | "stale_evidence"
      | "malformed_evidence"
      | "invalid_gate",
    message: string
  ) {
    super(message);
    this.name = "ScaP02ContractError";
  }
}

function fail(code: ScaP02ContractError["code"], message: string): never {
  throw new ScaP02ContractError(code, message);
}

function parse<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string
): Static<Schema> {
  try {
    return validateContract(schema, value, label);
  } catch (error) {
    fail("invalid_contract", error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function refKey(ref: ArtifactRef): string {
  return canonicalJson(ref);
}
function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return refKey(left) === refKey(right);
}

function assertArtifactContract(
  ref: ArtifactRef,
  expected: Readonly<{
    kind: string;
    schema_id: string;
    schema_version: number;
    producer?: string;
    run_id?: string;
  }>,
  label: string
): void {
  if (
    ref.kind !== expected.kind ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== expected.schema_id ||
    ref.content_schema.schema_version !== expected.schema_version ||
    (expected.producer !== undefined && ref.producer !== expected.producer) ||
    (expected.run_id !== undefined && ref.run_id !== expected.run_id) ||
    ref.content_digest !== ref.store_ref.replace("artifact://sha256/", "")
  ) {
    fail("invalid_binding", `${label} has an invalid exact artifact contract`);
  }
}

function assertP02AuthorityRefs(input: {
  readonly run_id: string;
  readonly p02_request_ref: ArtifactRef;
  readonly runtime_policy_ref: ArtifactRef;
  readonly isolation_evidence_ref: ArtifactRef;
  readonly isolation_host_attestation_ref: ArtifactRef | null;
}): void {
  assertArtifactContract(
    input.p02_request_ref,
    {
      kind: SCA_P02_CANDIDATE_REQUEST_KIND,
      schema_id: SCA_P02_REQUEST_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P02_CANDIDATE_PRODUCER,
      run_id: input.run_id,
    },
    "P02 request ref"
  );
  assertArtifactContract(
    input.runtime_policy_ref,
    {
      kind: "sca-p02-runtime-policy",
      schema_id: SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P02_RUNTIME_POLICY_PRODUCER,
      run_id: input.run_id,
    },
    "P02 runtime policy ref"
  );
  assertArtifactContract(
    input.isolation_evidence_ref,
    {
      kind: "sca-p02-isolation-evidence",
      schema_id: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
      schema_version: 1,
      producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      run_id: input.run_id,
    },
    "P02 isolation evidence ref"
  );
  if (input.isolation_host_attestation_ref !== null) {
    assertArtifactContract(
      input.isolation_host_attestation_ref,
      {
        kind: SCA_P02_HOST_ATTESTATION_KIND,
        schema_id: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
        schema_version: 1,
        producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
        run_id: input.run_id,
      },
      "P02 isolation host attestation ref"
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail("duplicate_identity", `${label} must be unique`);
}
function assertSelfDigest<Field extends string>(
  value: Readonly<Record<Field, unknown>>,
  field: Field,
  label: string
): void {
  const observed = value[field];
  const unsigned = { ...value };
  Reflect.deleteProperty(unsigned, field);
  if (typeof observed !== "string" || sha256(canonicalJson(unsigned)) !== observed) {
    fail("invalid_binding", `${label} digest is invalid`);
  }
}

export function scaP02FrozenRefs(core: ScaCampaignManifestCoreV1): readonly ArtifactRef[] {
  const frozen = core.frozen_refs;
  return [
    frozen.source_snapshot_ref,
    frozen.source_file_manifest_ref,
    frozen.source_custody_ref,
    frozen.source_provenance_ref,
    ...(frozen.variant_capture_manifest_ref === undefined
      ? []
      : [frozen.variant_capture_manifest_ref]),
    frozen.analysis_profile_ref,
    frozen.rule_release_ref,
    frozen.rule_bundle_ref,
    frozen.rule_profile_ref,
    frozen.selected_rule_manifest_ref,
    frozen.toolchain_ref,
    ...frozen.tool_executable_refs,
    ...frozen.tool_measurement_receipt_refs,
    frozen.network_policy_ref,
    frozen.privacy_policy_ref,
    frozen.model_data_policy_ref,
    frozen.resource_policy_ref,
    frozen.output_policy_ref,
    frozen.authority_policy_ref,
    frozen.p01_qualification_ref,
    frozen.qualification_source_file_manifest_ref,
    frozen.qualification_source_custody_ref,
    frozen.implementation_source_ref,
    frozen.implementation_build_ref,
  ];
}

export function validateScaP02RequestV1(value: unknown): ScaP02RequestV1 {
  const request = parse(ScaP02RequestV1Schema, value, "SCA P02 request");
  if (request.isolation_host_attestation_ref !== null) {
    assertArtifactContract(
      request.isolation_host_attestation_ref,
      {
        kind: SCA_P02_HOST_ATTESTATION_KIND,
        schema_id: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
        schema_version: 1,
        producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
        run_id: request.run_id,
      },
      "P02 request host isolation attestation ref"
    );
  }
  assertUnique(
    request.accepted_p01.frozen_refs.map((ref) => refKey(ref)),
    "P02 frozen refs"
  );
  return request;
}

export const validateScaP02RuntimePolicyV1 = (value: unknown): ScaP02RuntimePolicyV1 => {
  const policy = parse(ScaP02RuntimePolicyV1Schema, value, "SCA P02 runtime policy");
  assertUnique(
    policy.executables.map((entry) => entry.tool_id),
    "runtime executable tool IDs"
  );
  assertUnique(
    policy.executables.map((entry) => entry.executable_path),
    "runtime executable paths"
  );
  const toolIds = new Set(policy.executables.map((entry) => entry.tool_id));
  if (
    !toolIds.has(policy.operation_tools.semgrep_tool_id) ||
    !toolIds.has(policy.operation_tools.gitleaks_tool_id) ||
    policy.operation_tools.semgrep_tool_id === policy.operation_tools.gitleaks_tool_id
  ) {
    fail("invalid_binding", "runtime operation tool bindings are missing or ambiguous");
  }
  if (policy.osv.max_batch_size !== 128 || policy.osv.max_concurrency !== 2) {
    fail(
      "invalid_contract",
      "runtime OSV policy must use the admitted v2 batch and concurrency caps"
    );
  }
  if (
    policy.internal_component_identities.source_census_sha256 !==
    SCA_P02_SOURCE_CENSUS_IDENTITY_SHA256
  ) {
    fail("invalid_binding", "runtime source-census identity is not the canonical implementation");
  }
  return policy;
};
export const validateScaP02HostIsolationAttestationV1 = (
  value: unknown
): ScaP02HostIsolationAttestationV1 => {
  const attestation = parse(
    ScaP02HostIsolationAttestationV1Schema,
    value,
    "SCA P02 host isolation attestation"
  );
  if (attestation.profile_sha256 !== scaP02AggregateProfileSha256(attestation.operation_profiles)) {
    fail("invalid_binding", "P02 host isolation attestation aggregate profile is invalid");
  }
  return attestation;
};

export const validateScaP02IsolationEvidenceV1 = (value: unknown): ScaP02IsolationEvidenceV1 => {
  const evidence = parse(ScaP02IsolationEvidenceV1Schema, value, "SCA P02 isolation evidence");
  if (evidence.qualification_scope === "live_qualified") {
    if (evidence.profile_sha256 !== scaP02AggregateProfileSha256(evidence.operation_profiles)) {
      fail("invalid_binding", "P02 isolation evidence aggregate profile is invalid");
    }
    assertArtifactContract(
      evidence.host_attestation_ref,
      {
        kind: SCA_P02_HOST_ATTESTATION_KIND,
        schema_id: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
        schema_version: 1,
        producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
        run_id: evidence.host_attestation_ref.run_id,
      },
      "P02 host isolation attestation ref"
    );
    if (evidence.host_attestation_sha256 !== evidence.host_attestation_ref.content_digest) {
      fail("invalid_binding", "P02 host isolation attestation digest is not exact");
    }
  }
  return evidence;
};

function assertExactIsolationHostAttestationRef(input: {
  readonly observed: ArtifactRef | null;
  readonly expected: ArtifactRef | null;
  readonly isolation: ScaP02IsolationEvidenceV1;
  readonly label: string;
}): void {
  const isolationRef =
    input.isolation.qualification_scope === "live_qualified"
      ? input.isolation.host_attestation_ref
      : null;
  if (
    (input.observed === null) !== (input.expected === null) ||
    (input.observed === null) !== (isolationRef === null) ||
    (input.observed !== null &&
      input.expected !== null &&
      isolationRef !== null &&
      (!sameRef(input.observed, input.expected) || !sameRef(input.observed, isolationRef)))
  ) {
    fail("invalid_binding", `${input.label} host isolation attestation ref is not exact`);
  }
}

export function validateScaP02AcceptedP01(input: {
  readonly request: ScaP02RequestV1;
  readonly p01_request: unknown;
  readonly ledger: unknown;
  readonly core: unknown;
  readonly qualification: unknown;
  readonly admission_evidence: unknown;
  readonly gate: unknown;
  readonly manifest: unknown;
}): void {
  const request = validateScaP02RequestV1(input.request);
  const p01Request = validateScaP01AdmissionRequestV3(input.p01_request);
  const ledger = validateScaObligationLedgerV2(input.ledger);
  const core = validateScaCampaignManifestCoreV1(input.core);
  const qualification = validateScaPhaseQualificationRecordV2(input.qualification);
  const admissionEvidence = validateScaP01AdmissionEvidenceV1(input.admission_evidence);
  const gate = validateScaPhaseGateRecordV2(input.gate);
  const manifest = validateScaCampaignManifestV2(input.manifest);
  validateScaP01AdmissionContextV1({
    request: p01Request,
    request_ref: request.accepted_p01.request_ref,
    ledger,
    ledger_ref: request.accepted_p01.obligation_ledger_ref,
    core,
    core_ref: request.accepted_p01.campaign_manifest_core_ref,
    frozen_material_refs: core.frozen_refs,
    qualification,
    qualification_ref: core.frozen_refs.p01_qualification_ref,
    admission_evidence: admissionEvidence,
    admission_evidence_ref: request.accepted_p01.admission_evidence_ref,
    gate,
    gate_ref: request.accepted_p01.p01_gate_ref,
    manifest,
  });
  if (
    request.tenant_id !== p01Request.tenant_id ||
    request.project_id !== p01Request.project_id ||
    request.run_id !== p01Request.run_id ||
    !sameRef(request.accepted_p01.obligation_ledger_ref, core.obligation_ledger_ref)
  ) {
    fail("invalid_binding", "P02 request identity or accepted ledger drifted from P01");
  }
  const expectedFrozen = scaP02FrozenRefs(core).map(refKey).sort();
  const observedFrozen = request.accepted_p01.frozen_refs.map(refKey).sort();
  if (canonicalJson(expectedFrozen) !== canonicalJson(observedFrozen)) {
    fail("invalid_binding", "P02 request does not bind every exact P01 frozen reference");
  }
}

const RESULT_SCHEMA_IDS: Readonly<Record<ScaP02OperationKind, string>> = Object.freeze({
  inventory: SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
  semgrep_php: SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
  semgrep_js_ts: SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
  gitleaks: SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
  osv_composer: SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
  osv_npm: SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
});

function validateOperationRequestCommon(
  kind: ScaP02OperationKind,
  request: ScaP02OperationRequestV1
): void {
  if (request.operation_id !== SCA_P02_OPERATION_IDS[kind]) {
    fail("invalid_binding", `SCA P02 ${kind} operation ID is invalid`);
  }
  assertSelfDigest(request, "request_sha256", `SCA P02 ${kind} request`);
  assertP02AuthorityRefs(request);
  const liveIsolation = request.isolation_qualification_scope === "live_qualified";
  if (
    liveIsolation !== (request.isolation_runtime_kind === "host_qualified") ||
    liveIsolation !== (request.isolation_host_attestation_id !== null) ||
    liveIsolation !== (request.isolation_host_attestation_sha256 !== null) ||
    liveIsolation !== (request.isolation_host_attestation_ref !== null) ||
    (request.isolation_host_attestation_ref !== null &&
      request.isolation_host_attestation_sha256 !==
        request.isolation_host_attestation_ref.content_digest)
  ) {
    fail("invalid_binding", `${kind} isolation runtime and attestation binding is inconsistent`);
  }
  if (request.isolation_host_attestation_ref !== null) {
    assertArtifactContract(
      request.isolation_host_attestation_ref,
      {
        kind: SCA_P02_HOST_ATTESTATION_KIND,
        schema_id: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
        schema_version: 1,
        producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      },
      `${kind} host isolation attestation ref`
    );
  }
  if ("source_snapshot_ref" in request) {
    assertArtifactContract(
      request.source_snapshot_ref,
      {
        kind: "source-snapshot",
        schema_id: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
        schema_version: 2,
      },
      `${kind} source snapshot ref`
    );
    if (request.source_snapshot_ref.content_digest !== request.source_snapshot_sha256) {
      fail("invalid_binding", `${kind} source snapshot ref and digest disagree`);
    }
  }
  if (request.operation_kind === "inventory") {
    if (request.source_census_identity_sha256 !== SCA_P02_SOURCE_CENSUS_IDENTITY_SHA256) {
      fail("invalid_binding", "inventory source-census identity is not canonical");
    }
  }
  if (request.operation_kind === "semgrep_php" || request.operation_kind === "semgrep_js_ts") {
    assertSortedUnique(request.excluded_rule_ids, `${kind} excluded rule IDs`);
    assertSortedUnique(
      request.selected_rule_bindings.map((binding) => binding.rule_id),
      `${kind} selected rule IDs`
    );
  }
  if (request.operation_kind === "osv_composer" || request.operation_kind === "osv_npm") {
    const osv = request;
    assertUnique(
      osv.coordinates.map((entry) => entry.query_id),
      `${kind} query IDs`
    );
    assertUnique(
      osv.mappings.map((entry) => entry.occurrence_id),
      `${kind} occurrence IDs`
    );
    const coordinateIds = new Set(osv.coordinates.map((entry) => entry.query_id));
    if (osv.mappings.some((entry) => !coordinateIds.has(entry.query_id))) {
      fail("invalid_binding", `${kind} mapping references an absent coordinate`);
    }
    const packages = new Map(
      osv.coordinates.map((entry) => [entry.query_id, canonicalJson(entry.package)])
    );
    if (
      osv.mappings.some((entry) => packages.get(entry.query_id) !== canonicalJson(entry.package))
    ) {
      fail("invalid_binding", `${kind} mapping package drifts from its coordinate`);
    }
    if (
      osv.coordinates.some((entry) => entry.package.ecosystem !== osv.ecosystem) ||
      osv.mappings.some((entry) => entry.package.ecosystem !== osv.ecosystem)
    ) {
      fail("invalid_binding", `${kind} request mixes ecosystems`);
    }
  }
}

export function validateScaP02OperationRequestV1(
  kind: ScaP02OperationKind,
  value: unknown
): ScaP02OperationRequestV1 {
  let request: ScaP02OperationRequestV1;
  switch (kind) {
    case "inventory":
      request = parse(ScaP02InventoryRequestV1Schema, value, "SCA P02 inventory request");
      break;
    case "semgrep_php":
      request = parse(ScaP02SemgrepPhpRequestV1Schema, value, "SCA P02 semgrep_php request");
      break;
    case "semgrep_js_ts":
      request = parse(ScaP02SemgrepJsTsRequestV1Schema, value, "SCA P02 semgrep_js_ts request");
      break;
    case "gitleaks":
      request = parse(ScaP02GitleaksRequestV1Schema, value, "SCA P02 gitleaks request");
      break;
    case "osv_composer":
      request = parse(ScaP02OsvComposerRequestV1Schema, value, "SCA P02 osv_composer request");
      break;
    case "osv_npm":
      request = parse(ScaP02OsvNpmRequestV1Schema, value, "SCA P02 osv_npm request");
      break;
  }
  validateOperationRequestCommon(kind, request);
  return request;
}

interface RawRecordSeed {
  readonly record_kind: ScaP02RawRecordV1["record_kind"];
  readonly source_pointer: string;
  readonly value: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayMember(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) return [];
  const member = Reflect.get(value, key);
  return Array.isArray(member) ? member : [];
}

function recordMember(value: unknown, key: string): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  const member = Reflect.get(value, key);
  return isRecord(member) ? member : null;
}

function rawRecordSeeds(analyzerId: ScaP02AnalyzerId, value: unknown): RawRecordSeed[] {
  if (!isRecord(value)) fail("malformed_evidence", "raw component result must be an object");
  const schemaId = Reflect.get(value, "schema_id");
  if (schemaId === "penny.sca-p02-adapter-blocker.v1") {
    const codes = arrayMember(value, "blocker_codes");
    return codes.length === 0
      ? [{ record_kind: "summary", source_pointer: "/blocker_codes", value: codes }]
      : codes.map((code, index) => ({
          record_kind: "blocker" as const,
          source_pointer: `/blocker_codes/${index}`,
          value: code,
        }));
  }
  if (schemaId === "penny.sca-source-census-result.v1") {
    return arrayMember(value, "entries").map((entry, index) => ({
      record_kind: "candidate" as const,
      source_pointer: `/entries/${index}`,
      value: entry,
    }));
  }
  if (schemaId === "penny.sca-p02-custody-summary.v1") {
    return [{ record_kind: "context", source_pointer: "", value }];
  }
  if (schemaId === "penny.sca-tree-sitter-index-result.v2") {
    const files = arrayMember(value, "files");
    const relevant = files.flatMap<RawRecordSeed>((file, fileIndex) => {
      if (!isRecord(file)) return [];
      const language = Reflect.get(file, "admitted_language");
      const included =
        analyzerId === "tree-sitter-php"
          ? language === "php"
          : analyzerId === "tree-sitter-js-ts" && language !== "php";
      if (!included) return [];
      const symbols = arrayMember(file, "symbols");
      return symbols.length === 0
        ? [
            {
              record_kind: "context" as const,
              source_pointer: `/files/${fileIndex}`,
              value: file,
            },
          ]
        : symbols.map((symbol, symbolIndex) => ({
            record_kind: "candidate" as const,
            source_pointer: `/files/${fileIndex}/symbols/${symbolIndex}`,
            value: symbol,
          }));
    });
    return relevant.length === 0
      ? [
          {
            record_kind: "summary",
            source_pointer: "/counts",
            value: recordMember(value, "counts"),
          },
        ]
      : relevant;
  }
  if (schemaId === "penny.sca-dependency-inventory-result.v2") {
    const ecosystem = analyzerId === "dependency-composer" ? "Packagist" : "npm";
    const occurrences = arrayMember(value, "occurrences").flatMap<RawRecordSeed>((entry, index) =>
      isRecord(entry) && Reflect.get(entry, "ecosystem") === ecosystem
        ? [
            {
              record_kind: "candidate" as const,
              source_pointer: `/occurrences/${index}`,
              value: entry,
            },
          ]
        : []
    );
    if (occurrences.length > 0) return occurrences;
    const ecosystems = arrayMember(value, "ecosystems");
    const index = ecosystems.findIndex(
      (entry) => isRecord(entry) && Reflect.get(entry, "ecosystem") === ecosystem
    );
    return [
      {
        record_kind: "summary",
        source_pointer: index < 0 ? "/ecosystems" : `/ecosystems/${index}`,
        value: index < 0 ? ecosystems : ecosystems[index],
      },
    ];
  }
  if (schemaId === "penny.sca-semgrep-result.v1") {
    const stdout = Reflect.get(value, "raw_stdout");
    let parsedStdout: unknown = null;
    if (typeof stdout === "string") {
      try {
        parsedStdout = JSON.parse(stdout);
      } catch {
        parsedStdout = null;
      }
    }
    const findings = arrayMember(parsedStdout, "results");
    if (findings.length > 0) {
      return findings.map((entry, index) => ({
        record_kind: "finding",
        source_pointer: `/raw_stdout/results/${index}`,
        value: entry,
      }));
    }
    const errors = arrayMember(parsedStdout, "errors");
    return errors.length > 0
      ? errors.map((entry, index) => ({
          record_kind: "blocker" as const,
          source_pointer: `/raw_stdout/errors/${index}`,
          value: entry,
        }))
      : [
          {
            record_kind: "summary",
            source_pointer: "/status",
            value: Reflect.get(value, "status"),
          },
        ];
  }
  if (schemaId === "penny.sca-p02-gitleaks-minimized-result.v1") {
    const findings = arrayMember(value, "findings");
    return findings.length > 0
      ? findings.map((entry, index) => ({
          record_kind: "finding" as const,
          source_pointer: `/findings/${index}`,
          value: entry,
        }))
      : [
          {
            record_kind: "summary",
            source_pointer: "/status",
            value: Reflect.get(value, "status"),
          },
        ];
  }
  if (schemaId === "penny.sca-osv-plan.v2") {
    const batches = arrayMember(value, "batches");
    return batches.length > 0
      ? batches.map((entry, index) => ({
          record_kind: "batch" as const,
          source_pointer: `/batches/${index}`,
          value: entry,
        }))
      : [{ record_kind: "summary", source_pointer: "/batches", value: batches }];
  }
  if (schemaId === "penny.sca-osv-result.v2") {
    const findings = arrayMember(value, "advisory_occurrences");
    if (findings.length > 0) {
      return findings.map((entry, index) => ({
        record_kind: "finding",
        source_pointer: `/advisory_occurrences/${index}`,
        value: entry,
      }));
    }
    const mappings = arrayMember(value, "coordinate_results");
    return mappings.length > 0
      ? mappings.map((entry, index) => ({
          record_kind: "mapping" as const,
          source_pointer: `/coordinate_results/${index}`,
          value: entry,
        }))
      : [
          {
            record_kind: "summary",
            source_pointer: "/status",
            value: Reflect.get(value, "status"),
          },
        ];
  }
  fail("malformed_evidence", `raw component schema '${String(schemaId)}' is not admitted`);
}

function buildRawRecords(
  evidenceId: string,
  analyzerId: ScaP02AnalyzerId,
  value: unknown
): ScaP02RawRecordV1[] {
  return rawRecordSeeds(analyzerId, value).map((seed) => {
    const body = {
      evidence_id: evidenceId,
      analyzer_id: analyzerId,
      record_kind: seed.record_kind,
      source_pointer: seed.source_pointer,
      record_sha256: sha256(canonicalJson(seed.value)),
    };
    return { raw_record_id: `p02raw_${sha256(canonicalJson(body))}`, ...body };
  });
}

export function buildScaP02RawEvidenceV1(input: {
  readonly analyzer_id: ScaP02AnalyzerId;
  readonly value: Readonly<Record<string, unknown>>;
  readonly retention?: "exact" | "minimized";
  readonly original_content_sha256?: string;
  readonly original_byte_length?: number;
}): { readonly evidence: ScaP02RawEvidenceV1; readonly raw_records: readonly ScaP02RawRecordV1[] } {
  const bytes = Buffer.from(canonicalJson(input.value), "utf8");
  const contentSha256 = sha256(bytes);
  const evidenceId = `p02e_${sha256(
    canonicalJson({ analyzer_id: input.analyzer_id, content_sha256: contentSha256 })
  )}`;
  const rawRecords = buildRawRecords(evidenceId, input.analyzer_id, input.value);
  const evidence = parse(
    ScaP02RawEvidenceV1Schema,
    {
      evidence_id: evidenceId,
      analyzer_id: input.analyzer_id,
      content_schema_id: String(input.value.schema_id),
      content_schema_version: Number(input.value.schema_version),
      media_type: "application/json",
      encoding: "base64",
      content_base64: bytes.toString("base64"),
      content_sha256: contentSha256,
      byte_length: bytes.byteLength,
      retention: input.retention ?? "exact",
      original_content_sha256: input.original_content_sha256 ?? null,
      original_byte_length: input.original_byte_length ?? null,
      raw_record_ids: rawRecords.map((record) => record.raw_record_id),
    },
    "SCA P02 raw evidence"
  );
  return { evidence, raw_records: rawRecords };
}

export function decodeScaP02RawEvidenceV1(evidence: ScaP02RawEvidenceV1): {
  readonly value: unknown;
  readonly raw_records: readonly ScaP02RawRecordV1[];
} {
  const bytes = Buffer.from(evidence.content_base64, "base64");
  if (
    bytes.toString("base64") !== evidence.content_base64 ||
    bytes.byteLength !== evidence.byte_length ||
    sha256(bytes) !== evidence.content_sha256
  ) {
    fail("malformed_evidence", `raw evidence '${evidence.evidence_id}' bytes are malformed`);
  }
  const expectedEvidenceId = `p02e_${sha256(
    canonicalJson({
      analyzer_id: evidence.analyzer_id,
      content_sha256: evidence.content_sha256,
    })
  )}`;
  if (evidence.evidence_id !== expectedEvidenceId) {
    fail("invalid_binding", `raw evidence '${evidence.evidence_id}' identity is invalid`);
  }
  const text = bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("malformed_evidence", `raw evidence '${evidence.evidence_id}' is not JSON`);
  }
  if (canonicalJson(parsed) !== text) {
    fail("malformed_evidence", `raw evidence '${evidence.evidence_id}' is not canonical JSON`);
  }
  if (
    !isRecord(parsed) ||
    Reflect.get(parsed, "schema_id") !== evidence.content_schema_id ||
    Reflect.get(parsed, "schema_version") !== evidence.content_schema_version
  ) {
    fail("malformed_evidence", `raw evidence '${evidence.evidence_id}' schema identity is invalid`);
  }
  if (
    evidence.retention === "exact" &&
    (evidence.original_content_sha256 !== null || evidence.original_byte_length !== null)
  ) {
    fail("malformed_evidence", "exact raw evidence cannot carry original-byte redaction metadata");
  }
  if (
    evidence.retention === "minimized" &&
    (evidence.original_content_sha256 === null || evidence.original_byte_length === null)
  ) {
    fail("malformed_evidence", "minimized evidence must bind the original process bytes");
  }
  const rawRecords = buildRawRecords(evidence.evidence_id, evidence.analyzer_id, parsed);
  if (
    canonicalJson(evidence.raw_record_ids) !==
    canonicalJson(rawRecords.map((record) => record.raw_record_id))
  ) {
    fail("invalid_binding", `raw evidence '${evidence.evidence_id}' record set is invalid`);
  }
  return { value: parsed, raw_records: rawRecords };
}

const EXPECTED_OPERATION_ANALYZERS: Readonly<
  Record<ScaP02OperationKind, readonly ScaP02AnalyzerId[]>
> = Object.freeze({
  inventory: [
    "source-census",
    "tree-sitter-php",
    "tree-sitter-js-ts",
    "dependency-composer",
    "dependency-npm",
  ],
  semgrep_php: ["semgrep-php"],
  semgrep_js_ts: ["semgrep-js-ts"],
  gitleaks: ["gitleaks"],
  osv_composer: ["osv-composer"],
  osv_npm: ["osv-npm"],
});

export interface ScaP02ObservationCandidateV1 {
  readonly analyzer_id: ScaP02AnalyzerId;
  readonly category: string;
  readonly severity: ScaP02NormalizedObservationV1["severity"];
  readonly subject: string;
  readonly path: string | null;
  readonly start_line: number | null;
  readonly advisory_id: string | null;
  readonly raw_record_ids: readonly string[];
}

function observationSemantics(input: {
  readonly analyzer_id: ScaP02AnalyzerId;
  readonly category: string;
  readonly severity: ScaP02NormalizedObservationV1["severity"];
  readonly subject: string;
  readonly path: string | null;
  readonly start_line: number | null;
  readonly advisory_id: string | null;
}) {
  return {
    analyzer_id: input.analyzer_id,
    category: input.category,
    severity: input.severity,
    subject: input.subject,
    path: input.path,
    start_line: input.start_line,
    advisory_id: input.advisory_id,
  };
}

function correlationIdentity(value: Omit<ScaP02CorrelationRecordV1, "correlation_id">): string {
  return `p02corr_${sha256(canonicalJson(value))}`;
}

export function buildScaP02ProvenanceV1(input: {
  readonly raw_evidence: readonly ScaP02RawEvidenceV1[];
  readonly raw_records: readonly ScaP02RawRecordV1[];
  readonly candidates: readonly ScaP02ObservationCandidateV1[];
}): {
  readonly normalized_observations: readonly ScaP02NormalizedObservationV1[];
  readonly correlations: readonly ScaP02CorrelationRecordV1[];
} {
  const records = new Map(input.raw_records.map((record) => [record.raw_record_id, record]));
  if (records.size !== input.raw_records.length) {
    fail("duplicate_identity", "raw record identities must be unique");
  }
  const evidence = new Map(input.raw_evidence.map((entry) => [entry.evidence_id, entry]));
  if (evidence.size !== input.raw_evidence.length) {
    fail("duplicate_identity", "raw evidence identities must be unique");
  }
  const groups = new Map<
    string,
    { readonly semantics: ReturnType<typeof observationSemantics>; readonly raw_ids: Set<string> }
  >();
  for (const candidate of input.candidates) {
    const semantics = observationSemantics(candidate);
    const fingerprint = sha256(canonicalJson(semantics));
    const current = groups.get(fingerprint) ?? { semantics, raw_ids: new Set<string>() };
    for (const id of candidate.raw_record_ids) {
      const record = records.get(id);
      if (record === undefined || record.analyzer_id !== candidate.analyzer_id) {
        fail("invalid_binding", "normalized candidate references an absent or foreign raw record");
      }
      current.raw_ids.add(id);
    }
    if (current.raw_ids.size === 0) {
      fail("invalid_binding", "normalized candidate must reference raw records");
    }
    groups.set(fingerprint, current);
  }

  const consumed = new Set<string>();
  const normalized: ScaP02NormalizedObservationV1[] = [];
  const correlations: ScaP02CorrelationRecordV1[] = [];
  for (const [fingerprint, group] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const rawIds = [...group.raw_ids].sort();
    for (const id of rawIds) consumed.add(id);
    const rawEvidenceIds = [
      ...new Set(
        rawIds.map((id) => {
          const record = records.get(id);
          if (record === undefined) fail("invalid_binding", "raw record disappeared");
          if (!evidence.has(record.evidence_id)) {
            fail("invalid_binding", "raw record references absent evidence");
          }
          return record.evidence_id;
        })
      ),
    ].sort();
    const duplicateGroupId =
      rawIds.length > 1
        ? `p02dup_${sha256(
            canonicalJson({
              analyzer_id: group.semantics.analyzer_id,
              fingerprint,
              raw_ids: rawIds,
            })
          )}`
        : null;
    const observationId = `scaobs_${fingerprint}`;
    const correlationUnsigned = {
      analyzer_id: group.semantics.analyzer_id,
      normalized_observation_id: observationId,
      raw_record_ids: rawIds,
      disposition: "normalized" as const,
      disposition_code: null,
      duplicate_group_id: duplicateGroupId,
    };
    const correlationId = correlationIdentity(correlationUnsigned);
    correlations.push({ correlation_id: correlationId, ...correlationUnsigned });
    const provenance = {
      fingerprint_sha256: fingerprint,
      raw_evidence_ids: rawEvidenceIds,
      raw_record_ids: rawIds,
      correlation_id: correlationId,
      duplicate_group_id: duplicateGroupId,
    };
    normalized.push({
      observation_id: observationId,
      ...group.semantics,
      ...provenance,
      provenance_sha256: sha256(canonicalJson(provenance)),
    });
  }
  for (const record of [...input.raw_records].sort((left, right) =>
    left.raw_record_id.localeCompare(right.raw_record_id)
  )) {
    if (consumed.has(record.raw_record_id)) continue;
    if (record.record_kind === "finding") {
      fail(
        "incomplete_coverage",
        `security finding '${record.raw_record_id}' was not emitted by the canonical normalizer`
      );
    }
    let disposition: "blocked" | "context_only";
    let dispositionCode:
      | "source_census_member"
      | "symbol_index_member"
      | "dependency_inventory_member"
      | null = null;
    if (record.record_kind === "blocker") {
      disposition = "blocked";
    } else {
      disposition = "context_only";
      if (record.record_kind === "candidate") {
        dispositionCode =
          record.analyzer_id === "source-census"
            ? "source_census_member"
            : record.analyzer_id === "tree-sitter-php" || record.analyzer_id === "tree-sitter-js-ts"
              ? "symbol_index_member"
              : record.analyzer_id === "dependency-composer" ||
                  record.analyzer_id === "dependency-npm"
                ? "dependency_inventory_member"
                : fail(
                    "invalid_binding",
                    `candidate '${record.raw_record_id}' has no admitted context disposition`
                  );
      }
    }
    const unsigned = {
      analyzer_id: record.analyzer_id,
      normalized_observation_id: null,
      raw_record_ids: [record.raw_record_id],
      disposition,
      disposition_code: dispositionCode,
      duplicate_group_id: null,
    };
    correlations.push({ correlation_id: correlationIdentity(unsigned), ...unsigned });
  }
  return {
    normalized_observations: normalized,
    correlations: correlations.sort((left, right) =>
      left.correlation_id.localeCompare(right.correlation_id)
    ),
  };
}

function decodedRecordsForEvidence(input: {
  readonly evidence: ScaP02RawEvidenceV1;
  readonly raw_records: readonly ScaP02RawRecordV1[];
}): readonly ScaP02RawRecordV1[] {
  const records = input.raw_records.filter(
    (record) => record.evidence_id === input.evidence.evidence_id
  );
  if (
    canonicalJson(records.map((record) => record.raw_record_id)) !==
    canonicalJson(input.evidence.raw_record_ids)
  ) {
    fail("invalid_binding", "decoded evidence raw-record order is not exact");
  }
  return records;
}

function deriveObservationCandidates(input: {
  readonly raw_evidence: readonly ScaP02RawEvidenceV1[];
  readonly raw_records: readonly ScaP02RawRecordV1[];
}): ScaP02ObservationCandidateV1[] {
  const decoded = input.raw_evidence.map((evidence) => ({
    evidence,
    value: decodeScaP02RawEvidenceV1(evidence).value,
    records: decodedRecordsForEvidence({ evidence, raw_records: input.raw_records }),
  }));
  const candidates: ScaP02ObservationCandidateV1[] = [];

  const census = decoded.find(
    (entry) =>
      entry.evidence.analyzer_id === "source-census" &&
      isRecord(entry.value) &&
      Reflect.get(entry.value, "schema_id") === "penny.sca-source-census-result.v1"
  );
  const custody = decoded.find(
    (entry) =>
      entry.evidence.analyzer_id === "source-census" &&
      isRecord(entry.value) &&
      Reflect.get(entry.value, "schema_id") === "penny.sca-p02-custody-summary.v1"
  );
  if (census !== undefined && custody !== undefined && isRecord(census.value)) {
    const counts = recordMember(census.value, "counts");
    const custodyRecord = custody.records[0];
    const files = counts === null ? undefined : Reflect.get(counts, "files");
    const bytes = counts === null ? undefined : Reflect.get(counts, "bytes");
    if (
      custodyRecord === undefined ||
      custodyRecord.record_kind !== "context" ||
      typeof files !== "number" ||
      typeof bytes !== "number"
    ) {
      fail("malformed_evidence", "inventory summary inputs are incomplete");
    }
    candidates.push({
      analyzer_id: "source-census",
      category: "inventory-summary",
      severity: "info",
      subject: `files=${String(files)};bytes=${String(bytes)}`,
      path: null,
      start_line: null,
      advisory_id: null,
      raw_record_ids: [
        ...census.records.map((record) => record.raw_record_id),
        custodyRecord.raw_record_id,
      ],
    });
  }

  for (const entry of decoded) {
    if (!isRecord(entry.value)) continue;
    const schemaId = Reflect.get(entry.value, "schema_id");
    if (schemaId === "penny.sca-semgrep-result.v1") {
      const stdout = Reflect.get(entry.value, "raw_stdout");
      let parsed: unknown = null;
      if (typeof stdout === "string") {
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = null;
        }
      }
      for (const [index, finding] of arrayMember(parsed, "results").entries()) {
        const record = entry.records[index];
        if (!isRecord(finding) || record === undefined || record.record_kind !== "finding") {
          fail("malformed_evidence", "Semgrep finding and raw-record mapping is incomplete");
        }
        const extra = recordMember(finding, "extra") ?? {};
        const start = recordMember(finding, "start") ?? {};
        const checkId = Reflect.get(finding, "check_id");
        const message = Reflect.get(extra, "message");
        const path = Reflect.get(finding, "path");
        const line = Reflect.get(start, "line");
        if (
          typeof checkId !== "string" ||
          checkId.length === 0 ||
          typeof message !== "string" ||
          message.length === 0 ||
          typeof path !== "string" ||
          path.length === 0 ||
          typeof line !== "number" ||
          !Number.isInteger(line) ||
          line <= 0
        ) {
          fail("malformed_evidence", "Semgrep finding fields are incomplete");
        }
        candidates.push({
          analyzer_id:
            entry.evidence.analyzer_id === "semgrep-php"
              ? "semgrep-php"
              : entry.evidence.analyzer_id === "semgrep-js-ts"
                ? "semgrep-js-ts"
                : fail("invalid_binding", "Semgrep evidence has a foreign analyzer"),
          category: checkId.slice(0, 128),
          severity: "unknown",
          subject: message.slice(0, MAX_TEXT),
          path,
          start_line: line,
          advisory_id: null,
          raw_record_ids: [record.raw_record_id],
        });
      }
    } else if (schemaId === "penny.sca-p02-gitleaks-minimized-result.v1") {
      for (const [index, finding] of arrayMember(entry.value, "findings").entries()) {
        const record = entry.records[index];
        if (!isRecord(finding) || record === undefined || record.record_kind !== "finding") {
          fail("malformed_evidence", "Gitleaks finding and raw-record mapping is incomplete");
        }
        const ruleId = Reflect.get(finding, "rule_id");
        const fingerprint = Reflect.get(finding, "original_fingerprint_sha256");
        const path = Reflect.get(finding, "file");
        const line = Reflect.get(finding, "start_line");
        const endLine = Reflect.get(finding, "end_line");
        if (
          typeof ruleId !== "string" ||
          ruleId.length === 0 ||
          typeof fingerprint !== "string" ||
          !/^[a-f0-9]{64}$/u.test(fingerprint) ||
          (path !== null && typeof path !== "string") ||
          (line !== null && (typeof line !== "number" || !Number.isInteger(line) || line <= 0)) ||
          (endLine !== null &&
            (typeof endLine !== "number" || !Number.isInteger(endLine) || endLine <= 0))
        ) {
          fail("malformed_evidence", "Gitleaks finding fields are incomplete");
        }
        candidates.push({
          analyzer_id: "gitleaks",
          category: ruleId.slice(0, 128),
          severity: "high",
          subject: `Secret finding ${fingerprint}`,
          path,
          start_line: line,
          advisory_id: null,
          raw_record_ids: [record.raw_record_id],
        });
      }
    } else if (schemaId === "penny.sca-osv-result.v2") {
      for (const [index, finding] of arrayMember(entry.value, "advisory_occurrences").entries()) {
        const record = entry.records[index];
        if (!isRecord(finding) || record === undefined || record.record_kind !== "finding") {
          fail("malformed_evidence", "OSV finding and raw-record mapping is incomplete");
        }
        const advisoryId = Reflect.get(finding, "advisory_id");
        const occurrenceIds = arrayMember(finding, "occurrence_ids");
        if (
          typeof advisoryId !== "string" ||
          advisoryId.length === 0 ||
          occurrenceIds.length === 0 ||
          occurrenceIds.some(
            (occurrenceId) => typeof occurrenceId !== "string" || occurrenceId.length === 0
          ) ||
          new Set(occurrenceIds).size !== occurrenceIds.length
        ) {
          fail("malformed_evidence", "OSV advisory occurrence identity is incomplete");
        }
        candidates.push({
          analyzer_id:
            entry.evidence.analyzer_id === "osv-composer"
              ? "osv-composer"
              : entry.evidence.analyzer_id === "osv-npm"
                ? "osv-npm"
                : fail("invalid_binding", "OSV evidence has a foreign analyzer"),
          category: "vulnerability",
          severity: "unknown",
          subject: `${advisoryId}:${String(occurrenceIds.length)}`,
          path: null,
          start_line: null,
          advisory_id: advisoryId,
          raw_record_ids: [record.raw_record_id],
        });
      }
    }
  }
  return candidates;
}

export function deriveScaP02ProvenanceV1(input: {
  readonly raw_evidence: readonly ScaP02RawEvidenceV1[];
  readonly raw_records: readonly ScaP02RawRecordV1[];
}): {
  readonly normalized_observations: readonly ScaP02NormalizedObservationV1[];
  readonly correlations: readonly ScaP02CorrelationRecordV1[];
} {
  return buildScaP02ProvenanceV1({
    ...input,
    candidates: deriveObservationCandidates(input),
  });
}

function validateObservation(observation: ScaP02NormalizedObservationV1): void {
  const semantics = observationSemantics(observation);
  const fingerprint = sha256(canonicalJson(semantics));
  const provenance = {
    fingerprint_sha256: fingerprint,
    raw_evidence_ids: observation.raw_evidence_ids,
    raw_record_ids: observation.raw_record_ids,
    correlation_id: observation.correlation_id,
    duplicate_group_id: observation.duplicate_group_id,
  };
  if (
    observation.fingerprint_sha256 !== fingerprint ||
    observation.observation_id !== `scaobs_${fingerprint}` ||
    observation.provenance_sha256 !== sha256(canonicalJson(provenance))
  ) {
    fail("invalid_binding", `observation '${observation.observation_id}' identity is invalid`);
  }
  assertSortedUnique(observation.raw_evidence_ids, "observation raw evidence IDs");
  assertSortedUnique(observation.raw_record_ids, "observation raw record IDs");
}

function validateProvenanceGraph(input: {
  readonly raw_evidence: readonly ScaP02RawEvidenceV1[];
  readonly raw_records: readonly ScaP02RawRecordV1[];
  readonly normalized_observations: readonly ScaP02NormalizedObservationV1[];
  readonly correlations: readonly ScaP02CorrelationRecordV1[];
}): void {
  const evidence = new Map(input.raw_evidence.map((entry) => [entry.evidence_id, entry]));
  const records = new Map(input.raw_records.map((entry) => [entry.raw_record_id, entry]));
  const observations = new Map(
    input.normalized_observations.map((entry) => [entry.observation_id, entry])
  );
  assertUnique([...evidence.keys()], "raw evidence IDs");
  assertUnique([...records.keys()], "raw record IDs");
  assertUnique([...observations.keys()], "normalized observation IDs");
  assertUnique(
    input.correlations.map((entry) => entry.correlation_id),
    "correlation IDs"
  );
  const expectedRecords = input.raw_evidence.flatMap((entry) => entry.raw_record_ids).sort();
  if (
    canonicalJson(expectedRecords) !== canonicalJson([...records.keys()].sort()) ||
    input.raw_records.some(
      (record) => evidence.get(record.evidence_id)?.analyzer_id !== record.analyzer_id
    )
  ) {
    fail("invalid_binding", "raw evidence and raw record sets are not equal");
  }
  const correlated: string[] = [];
  for (const correlation of input.correlations) {
    assertSortedUnique(correlation.raw_record_ids, "correlation raw record IDs");
    const expectedId = correlationIdentity({
      analyzer_id: correlation.analyzer_id,
      normalized_observation_id: correlation.normalized_observation_id,
      raw_record_ids: correlation.raw_record_ids,
      disposition: correlation.disposition,
      disposition_code: correlation.disposition_code,
      duplicate_group_id: correlation.duplicate_group_id,
    });
    if (
      expectedId !== correlation.correlation_id ||
      correlation.raw_record_ids.some(
        (id) => records.get(id)?.analyzer_id !== correlation.analyzer_id
      ) ||
      (correlation.disposition === "normalized") !==
        (correlation.normalized_observation_id !== null)
    ) {
      fail("invalid_binding", `correlation '${correlation.correlation_id}' is inconsistent`);
    }
    for (const rawId of correlation.raw_record_ids) {
      const record = records.get(rawId);
      if (record === undefined) fail("invalid_binding", "correlation raw record is absent");
      const expectedCode =
        record.record_kind !== "candidate"
          ? null
          : record.analyzer_id === "source-census"
            ? "source_census_member"
            : record.analyzer_id === "tree-sitter-php" || record.analyzer_id === "tree-sitter-js-ts"
              ? "symbol_index_member"
              : record.analyzer_id === "dependency-composer" ||
                  record.analyzer_id === "dependency-npm"
                ? "dependency_inventory_member"
                : fail("invalid_binding", "candidate analyzer has no context disposition");
      const canonicalDisposition =
        correlation.disposition === "normalized"
          ? correlation.disposition_code === null
          : record.record_kind === "finding"
            ? false
            : record.record_kind === "blocker"
              ? correlation.disposition === "blocked" && correlation.disposition_code === null
              : correlation.disposition === "context_only" &&
                correlation.disposition_code === expectedCode;
      if (!canonicalDisposition) {
        fail("invalid_binding", "correlation disposition is not canonical for its raw record");
      }
    }
    correlated.push(...correlation.raw_record_ids);
    if (correlation.normalized_observation_id !== null) {
      const observation = observations.get(correlation.normalized_observation_id);
      const rawEvidenceIds = [
        ...new Set(
          correlation.raw_record_ids.map((id) => {
            const record = records.get(id);
            if (record === undefined) fail("invalid_binding", "correlation raw record is absent");
            return record.evidence_id;
          })
        ),
      ].sort();
      if (
        observation === undefined ||
        observation.correlation_id !== correlation.correlation_id ||
        observation.analyzer_id !== correlation.analyzer_id ||
        canonicalJson(observation.raw_record_ids) !== canonicalJson(correlation.raw_record_ids) ||
        canonicalJson(observation.raw_evidence_ids) !== canonicalJson(rawEvidenceIds) ||
        observation.duplicate_group_id !== correlation.duplicate_group_id
      ) {
        fail("invalid_binding", "normalized observation provenance contradicts correlation");
      }
    }
  }
  if (
    canonicalJson(correlated.sort()) !== canonicalJson([...records.keys()].sort()) ||
    [...observations.values()].some(
      (observation) =>
        !input.correlations.some(
          (correlation) => correlation.correlation_id === observation.correlation_id
        )
    )
  ) {
    fail(
      "invalid_binding",
      "every raw record and normalized observation must have exactly one correlation disposition"
    );
  }
  const expected = deriveScaP02ProvenanceV1({
    raw_evidence: input.raw_evidence,
    raw_records: input.raw_records,
  });
  if (
    canonicalJson(input.normalized_observations) !==
      canonicalJson(expected.normalized_observations) ||
    canonicalJson(input.correlations) !== canonicalJson(expected.correlations)
  ) {
    fail(
      "invalid_binding",
      "normalized observations and correlations do not equal canonical decoded component semantics"
    );
  }
}

function assertSortedUnique(values: readonly string[], label: string): void {
  assertUnique(values, label);
  if (canonicalJson(values) !== canonicalJson([...values].sort())) {
    fail("invalid_contract", `${label} must be sorted`);
  }
}

const ADMITTED_RAW_SCHEMAS: Readonly<Record<ScaP02AnalyzerId, readonly string[]>> = Object.freeze({
  "source-census": [
    "penny.sca-source-census-result.v1",
    "penny.sca-p02-custody-summary.v1",
    "penny.sca-p02-adapter-blocker.v1",
  ],
  "tree-sitter-php": ["penny.sca-tree-sitter-index-result.v2", "penny.sca-p02-adapter-blocker.v1"],
  "tree-sitter-js-ts": [
    "penny.sca-tree-sitter-index-result.v2",
    "penny.sca-p02-adapter-blocker.v1",
  ],
  "dependency-composer": [
    "penny.sca-dependency-inventory-result.v2",
    "penny.sca-p02-adapter-blocker.v1",
  ],
  "dependency-npm": [
    "penny.sca-dependency-inventory-result.v2",
    "penny.sca-p02-adapter-blocker.v1",
  ],
  "semgrep-php": ["penny.sca-semgrep-result.v1", "penny.sca-p02-adapter-blocker.v1"],
  "semgrep-js-ts": ["penny.sca-semgrep-result.v1", "penny.sca-p02-adapter-blocker.v1"],
  gitleaks: ["penny.sca-p02-gitleaks-minimized-result.v1", "penny.sca-p02-adapter-blocker.v1"],
  "osv-composer": [
    "penny.sca-osv-plan.v2",
    "penny.sca-osv-result.v2",
    "penny.sca-p02-adapter-blocker.v1",
  ],
  "osv-npm": [
    "penny.sca-osv-plan.v2",
    "penny.sca-osv-result.v2",
    "penny.sca-p02-adapter-blocker.v1",
  ],
});

function rawSelfDigest(value: unknown, field: string): boolean {
  if (!isRecord(value) || typeof Reflect.get(value, field) !== "string") return false;
  const unsigned = { ...value };
  const observed = Reflect.get(unsigned, field);
  Reflect.deleteProperty(unsigned, field);
  return observed === sha256(canonicalJson(unsigned));
}

function blockerCodes(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.flatMap((value) =>
        isRecord(value) && Reflect.get(value, "schema_id") === "penny.sca-p02-adapter-blocker.v1"
          ? arrayMember(value, "blocker_codes").filter(
              (code): code is string => typeof code === "string"
            )
          : []
      )
    ),
  ].sort();
}

function assertComponentDigests(values: readonly unknown[]): void {
  for (const value of values) {
    if (!isRecord(value)) fail("malformed_evidence", "raw component result is not an object");
    const schemaId = Reflect.get(value, "schema_id");
    const digestField =
      schemaId === "penny.sca-source-census-result.v1"
        ? "census_sha256"
        : schemaId === "penny.sca-tree-sitter-index-result.v2"
          ? "index_sha256"
          : schemaId === "penny.sca-dependency-inventory-result.v2"
            ? "inventory_sha256"
            : schemaId === "penny.sca-osv-plan.v2"
              ? "plan_sha256"
              : schemaId === "penny.sca-osv-result.v2"
                ? "result_sha256"
                : null;
    if (digestField !== null && !rawSelfDigest(value, digestField)) {
      fail("malformed_evidence", `raw component '${String(schemaId)}' digest is invalid`);
    }
    if (schemaId === "penny.sca-semgrep-result.v1") {
      const stdout = Reflect.get(value, "raw_stdout");
      const stderr = Reflect.get(value, "raw_stderr");
      if (
        typeof stdout !== "string" ||
        typeof stderr !== "string" ||
        Reflect.get(value, "raw_stdout_sha256") !== sha256(stdout) ||
        Reflect.get(value, "raw_stderr_sha256") !== sha256(stderr)
      ) {
        fail("malformed_evidence", "Semgrep component raw stream digests are invalid");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      const successful = ["succeeded", "findings"].includes(String(Reflect.get(value, "status")));
      if (
        (successful && !isRecord(parsed)) ||
        (isRecord(parsed) &&
          (Reflect.get(value, "finding_count") !== arrayMember(parsed, "results").length ||
            Reflect.get(value, "engine_error_count") !== arrayMember(parsed, "errors").length))
      ) {
        fail("malformed_evidence", "Semgrep component counts contradict raw output");
      }
    }
    if (schemaId === "penny.sca-p02-gitleaks-minimized-result.v1") {
      const findings = arrayMember(value, "findings");
      const count = Reflect.get(value, "finding_count");
      const status = Reflect.get(value, "status");
      const errorCode = Reflect.get(value, "error_code");
      if (
        count !== findings.length ||
        (status === "findings") !== (findings.length > 0 && errorCode === "none") ||
        (status === "succeeded") !== (findings.length === 0 && errorCode === "none")
      ) {
        fail("malformed_evidence", "Gitleaks component counts or status contradict findings");
      }
    }
  }
}

const RAW_COMPONENT_SCHEMA_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  "penny.sca-p02-adapter-blocker.v1": 1,
  "penny.sca-source-census-result.v1": 1,
  "penny.sca-p02-custody-summary.v1": 1,
  "penny.sca-tree-sitter-index-result.v2": 2,
  "penny.sca-dependency-inventory-result.v2": 2,
  "penny.sca-semgrep-result.v1": 1,
  "penny.sca-p02-gitleaks-minimized-result.v1": 1,
  "penny.sca-osv-plan.v2": 2,
  "penny.sca-osv-result.v2": 2,
});

function assertExactDecodedEvidenceSet(
  request: ScaP02OperationRequestV1,
  decodedByAnalyzer: ReadonlyMap<ScaP02AnalyzerId, readonly unknown[]>
): void {
  for (const analyzerId of EXPECTED_OPERATION_ANALYZERS[request.operation_kind]) {
    const values = decodedByAnalyzer.get(analyzerId) ?? [];
    const schemas = values.map((value) => {
      if (!isRecord(value)) fail("malformed_evidence", `${analyzerId} component is not an object`);
      const schemaId = Reflect.get(value, "schema_id");
      const schemaVersion = Reflect.get(value, "schema_version");
      if (
        typeof schemaId !== "string" ||
        schemaVersion !== RAW_COMPONENT_SCHEMA_VERSIONS[schemaId]
      ) {
        fail("malformed_evidence", `${analyzerId} component schema version is not admitted`);
      }
      return schemaId;
    });
    const blockerCount = schemas.filter(
      (schemaId) => schemaId === "penny.sca-p02-adapter-blocker.v1"
    ).length;
    if (blockerCount > 0) {
      if (values.length !== 1 || blockerCount !== 1) {
        fail("incomplete_coverage", `${analyzerId} blocker evidence must be exclusive`);
      }
      continue;
    }
    const expected =
      analyzerId === "source-census"
        ? ["penny.sca-source-census-result.v1", "penny.sca-p02-custody-summary.v1"]
        : analyzerId === "tree-sitter-php" || analyzerId === "tree-sitter-js-ts"
          ? ["penny.sca-tree-sitter-index-result.v2"]
          : analyzerId === "dependency-composer" || analyzerId === "dependency-npm"
            ? ["penny.sca-dependency-inventory-result.v2"]
            : analyzerId === "semgrep-php" || analyzerId === "semgrep-js-ts"
              ? Array.from(
                  {
                    length:
                      request.operation_kind === "semgrep_php" ||
                      request.operation_kind === "semgrep_js_ts"
                        ? request.selected_rule_bindings.length
                        : 0,
                  },
                  () => "penny.sca-semgrep-result.v1"
                )
              : analyzerId === "gitleaks"
                ? ["penny.sca-p02-gitleaks-minimized-result.v1"]
                : ["penny.sca-osv-plan.v2", "penny.sca-osv-result.v2"];
    if (canonicalJson([...schemas].sort()) !== canonicalJson([...expected].sort())) {
      fail("incomplete_coverage", `${analyzerId} decoded component set is incomplete or excessive`);
    }
  }
}

function validateDecodedComponentBindings(
  request: ScaP02OperationRequestV1,
  decodedByAnalyzer: ReadonlyMap<ScaP02AnalyzerId, readonly unknown[]>
): void {
  const values = [...decodedByAnalyzer.values()].flat();
  const components = values.filter(
    (value) =>
      isRecord(value) && Reflect.get(value, "schema_id") !== "penny.sca-p02-adapter-blocker.v1"
  );
  if ("source_snapshot_sha256" in request) {
    for (const component of components) {
      if (!isRecord(component)) continue;
      const schemaId = Reflect.get(component, "schema_id");
      if (
        [
          "penny.sca-source-census-result.v1",
          "penny.sca-tree-sitter-index-result.v2",
          "penny.sca-dependency-inventory-result.v2",
          "penny.sca-semgrep-result.v1",
          "penny.sca-p02-gitleaks-minimized-result.v1",
        ].includes(String(schemaId)) &&
        Reflect.get(component, "source_snapshot_sha256") !== request.source_snapshot_sha256
      ) {
        fail("invalid_binding", `${request.operation_kind} component source snapshot is stale`);
      }
    }
  }
  if (request.operation_kind === "inventory") {
    for (const component of components) {
      if (!isRecord(component)) continue;
      const schemaId = Reflect.get(component, "schema_id");
      if (
        schemaId === "penny.sca-source-census-result.v1" &&
        sha256(canonicalJson(Reflect.get(component, "tool"))) !==
          request.source_census_identity_sha256
      ) {
        fail("invalid_binding", "source census component identity is stale");
      }
      if (
        schemaId === "penny.sca-tree-sitter-index-result.v2" &&
        sha256(canonicalJson(Reflect.get(component, "tool"))) !==
          request.tree_sitter_identity_sha256
      ) {
        fail("invalid_binding", "tree-sitter component identity is stale");
      }
    }
    return;
  }
  if (request.operation_kind === "semgrep_php" || request.operation_kind === "semgrep_js_ts") {
    const outputs = components.flatMap<Readonly<Record<string, unknown>>>((component) =>
      isRecord(component) && Reflect.get(component, "schema_id") === "penny.sca-semgrep-result.v1"
        ? [component]
        : []
    );
    if (outputs.length === 0) return;
    const expectedHashes = request.selected_rule_bindings
      .map((binding) => binding.content_sha256)
      .sort();
    const observedHashes = outputs
      .map((output) => String(Reflect.get(output, "rule_config_sha256")))
      .sort();
    const runtimeSha256 = sha256(canonicalJson(request.executable));
    if (
      canonicalJson(observedHashes) !== canonicalJson(expectedHashes) ||
      outputs.some(
        (output) =>
          Reflect.get(output, "tool_version") !== request.executable.version ||
          Reflect.get(output, "runtime_identity") !== request.executable.tool_id ||
          Reflect.get(output, "runtime_sha256") !== runtimeSha256
      )
    ) {
      fail("invalid_binding", `${request.operation_kind} component tool or rule binding is stale`);
    }
    return;
  }
  if (request.operation_kind === "gitleaks") {
    const outputs = components.flatMap<Readonly<Record<string, unknown>>>((component) =>
      isRecord(component) &&
      Reflect.get(component, "schema_id") === "penny.sca-p02-gitleaks-minimized-result.v1"
        ? [component]
        : []
    );
    if (outputs.length === 0) return;
    const runtimeSha256 = sha256(canonicalJson(request.executable));
    if (
      outputs.length !== 1 ||
      outputs.some(
        (output) =>
          Reflect.get(output, "configuration_sha256") !==
            request.configuration_rule_binding.content_sha256 ||
          Reflect.get(output, "tool_version") !== request.executable.version ||
          Reflect.get(output, "runtime_identity") !== request.executable.tool_id ||
          Reflect.get(output, "runtime_sha256") !== runtimeSha256
      )
    ) {
      fail("invalid_binding", "Gitleaks component tool or configuration binding is stale");
    }
  }
}

function expectedAnalyzerSemantics(
  analyzerId: ScaP02AnalyzerId,
  values: readonly unknown[],
  resultFreshness: ScaP02OperationResultV1["freshness"]
): ScaP02AnalyzerResultV1 {
  const blockers = blockerCodes(values);
  if (blockers.length > 0) {
    return {
      analyzer_id: analyzerId,
      applicability: "applicable",
      status: "blocked",
      fresh: false,
      blocker_codes: blockers,
    };
  }
  if (analyzerId === "source-census") {
    const census = values.find(
      (value) =>
        isRecord(value) && Reflect.get(value, "schema_id") === "penny.sca-source-census-result.v1"
    );
    if (!isRecord(census)) fail("incomplete_coverage", "source census raw result is absent");
    return analyzerResult(analyzerId, "applicable", []);
  }
  if (analyzerId === "tree-sitter-php" || analyzerId === "tree-sitter-js-ts") {
    const tree = values.find(
      (value) =>
        isRecord(value) &&
        Reflect.get(value, "schema_id") === "penny.sca-tree-sitter-index-result.v2"
    );
    if (!isRecord(tree)) fail("incomplete_coverage", `${analyzerId} raw result is absent`);
    const files = arrayMember(tree, "files").filter((file) => {
      if (!isRecord(file)) return false;
      const language = Reflect.get(file, "admitted_language");
      return analyzerId === "tree-sitter-php" ? language === "php" : language !== "php";
    });
    if (files.length === 0) return analyzerResult(analyzerId, "not_applicable", []);
    const incomplete = files.some(
      (file) =>
        !isRecord(file) ||
        Reflect.get(file, "status") !== "parsed" ||
        Reflect.get(file, "truncated") === true
    );
    return analyzerResult(analyzerId, "applicable", incomplete ? ["tree_sitter_incomplete"] : []);
  }
  if (analyzerId === "dependency-composer" || analyzerId === "dependency-npm") {
    const inventory = values.find(
      (value) =>
        isRecord(value) &&
        Reflect.get(value, "schema_id") === "penny.sca-dependency-inventory-result.v2"
    );
    if (!isRecord(inventory)) fail("incomplete_coverage", `${analyzerId} raw result is absent`);
    const ecosystem = analyzerId === "dependency-composer" ? "Packagist" : "npm";
    const aggregate = arrayMember(inventory, "ecosystems").find(
      (entry) => isRecord(entry) && Reflect.get(entry, "ecosystem") === ecosystem
    );
    if (!isRecord(aggregate)) fail("malformed_evidence", `${ecosystem} aggregate is absent`);
    const state = Reflect.get(aggregate, "state");
    if (state === "absent") return analyzerResult(analyzerId, "not_applicable", []);
    return analyzerResult(
      analyzerId,
      "applicable",
      state === "supported" ? [] : [`dependency_${String(state)}`]
    );
  }
  if (analyzerId === "semgrep-php" || analyzerId === "semgrep-js-ts") {
    const outputs = values.filter(
      (value) =>
        isRecord(value) && Reflect.get(value, "schema_id") === "penny.sca-semgrep-result.v1"
    );
    if (outputs.length === 0) fail("incomplete_coverage", `${analyzerId} raw result is absent`);
    const incomplete = outputs.some(
      (value) =>
        !isRecord(value) ||
        Reflect.get(value, "truncated") === true ||
        Reflect.get(value, "error_code") !== "none" ||
        !["succeeded", "findings"].includes(String(Reflect.get(value, "status")))
    );
    return analyzerResult(analyzerId, "applicable", incomplete ? ["semgrep_incomplete"] : []);
  }
  if (analyzerId === "gitleaks") {
    const minimized = values.find(
      (value) =>
        isRecord(value) &&
        Reflect.get(value, "schema_id") === "penny.sca-p02-gitleaks-minimized-result.v1"
    );
    if (!isRecord(minimized)) fail("incomplete_coverage", "Gitleaks raw result is absent");
    const incomplete =
      Reflect.get(minimized, "truncated") === true ||
      Reflect.get(minimized, "error_code") !== "none" ||
      !["succeeded", "findings"].includes(String(Reflect.get(minimized, "status")));
    return analyzerResult(analyzerId, "applicable", incomplete ? ["gitleaks_incomplete"] : []);
  }
  const osvResult = values.find(
    (value) => isRecord(value) && Reflect.get(value, "schema_id") === "penny.sca-osv-result.v2"
  );
  if (!isRecord(osvResult)) {
    const emptyMarker = values.some(
      (value) =>
        isRecord(value) &&
        Reflect.get(value, "schema_id") === "penny.sca-p02-adapter-blocker.v1" &&
        arrayMember(value, "blocker_codes").length === 0
    );
    if (emptyMarker) return analyzerResult(analyzerId, "not_applicable", []);
    fail("incomplete_coverage", `${analyzerId} OSV result is absent`);
  }
  const complete =
    Reflect.get(osvResult, "status") === "succeeded" &&
    Reflect.get(osvResult, "error_code") === "none" &&
    Reflect.get(osvResult, "freshness_at_completion") === "fresh";
  const stale = Reflect.get(osvResult, "freshness_at_completion") === "stale";
  const derived = analyzerResult(
    analyzerId,
    "applicable",
    complete ? [] : [stale ? "osv_stale" : "osv_incomplete"]
  );
  return { ...derived, fresh: resultFreshness.fetched_at !== null && complete };
}

function analyzerResult(
  analyzerId: ScaP02AnalyzerId,
  applicability: "applicable" | "not_applicable",
  blockers: readonly string[]
): ScaP02AnalyzerResultV1 {
  return {
    analyzer_id: analyzerId,
    applicability,
    status: blockers.length === 0 ? "complete" : "blocked",
    fresh: blockers.length === 0,
    blocker_codes: [...blockers].sort(),
  };
}

export function validateScaP02OperationResultV1(
  kind: ScaP02OperationKind,
  requestValue: unknown,
  value: unknown
): ScaP02OperationResultV1 {
  const request = validateScaP02OperationRequestV1(kind, requestValue);
  let result: ScaP02OperationResultV1;
  switch (kind) {
    case "inventory":
      result = parse(ScaP02InventoryResultV1Schema, value, "SCA P02 inventory result");
      break;
    case "semgrep_php":
      result = parse(ScaP02SemgrepPhpResultV1Schema, value, "SCA P02 semgrep_php result");
      break;
    case "semgrep_js_ts":
      result = parse(ScaP02SemgrepJsTsResultV1Schema, value, "SCA P02 semgrep_js_ts result");
      break;
    case "gitleaks":
      result = parse(ScaP02GitleaksResultV1Schema, value, "SCA P02 gitleaks result");
      break;
    case "osv_composer":
      result = parse(ScaP02OsvComposerResultV1Schema, value, "SCA P02 osv_composer result");
      break;
    case "osv_npm":
      result = parse(ScaP02OsvNpmResultV1Schema, value, "SCA P02 osv_npm result");
      break;
  }
  if (
    result.run_id !== request.run_id ||
    result.operation_id !== request.operation_id ||
    result.operation_kind !== request.operation_kind ||
    result.request_sha256 !== request.request_sha256 ||
    result.source_binding_sha256 !==
      ("source_snapshot_sha256" in request
        ? request.source_snapshot_sha256
        : request.p01_binding_sha256) ||
    result.isolation_id !== request.isolation_id ||
    result.isolation_runtime_id !== request.isolation_runtime_id ||
    result.isolation_runtime_kind !== request.isolation_runtime_kind ||
    result.isolation_qualification_scope !== request.isolation_qualification_scope ||
    result.isolation_profile_id !== request.isolation_profile_id ||
    result.isolation_profile_sha256 !== request.isolation_profile_sha256 ||
    result.isolation_implementation_sha256 !== request.isolation_implementation_sha256 ||
    result.isolation_deployment_sha256 !== request.isolation_deployment_sha256 ||
    result.isolation_host_attestation_id !== request.isolation_host_attestation_id ||
    result.isolation_host_attestation_sha256 !== request.isolation_host_attestation_sha256 ||
    canonicalJson(result.isolation_host_attestation_ref) !==
      canonicalJson(request.isolation_host_attestation_ref)
  ) {
    fail("invalid_binding", `${kind} result does not bind the exact accepted request`);
  }
  const analyzerIds = result.analyzer_results.map((entry) => entry.analyzer_id);
  if (canonicalJson(analyzerIds) !== canonicalJson(EXPECTED_OPERATION_ANALYZERS[kind])) {
    fail("incomplete_coverage", `${kind} result must contain its exact ordered analyzer set`);
  }
  assertUnique(
    result.raw_evidence.map((entry) => entry.evidence_id),
    `${kind} raw evidence IDs`
  );
  assertUnique(
    result.normalized_observations.map((entry) => entry.observation_id),
    `${kind} normalized observation IDs`
  );
  const decodedByAnalyzer = new Map<ScaP02AnalyzerId, unknown[]>();
  const rebuiltRecords: ScaP02RawRecordV1[] = [];
  for (const evidence of result.raw_evidence) {
    if (
      !EXPECTED_OPERATION_ANALYZERS[kind].includes(evidence.analyzer_id) ||
      !ADMITTED_RAW_SCHEMAS[evidence.analyzer_id].includes(evidence.content_schema_id)
    ) {
      fail("malformed_evidence", `${kind} raw evidence schema is not admitted for its analyzer`);
    }
    const decoded = decodeScaP02RawEvidenceV1(evidence);
    rebuiltRecords.push(...decoded.raw_records);
    const values = decodedByAnalyzer.get(evidence.analyzer_id) ?? [];
    values.push(decoded.value);
    decodedByAnalyzer.set(evidence.analyzer_id, values);
  }
  if (
    canonicalJson(rebuiltRecords) !== canonicalJson(result.raw_records) ||
    EXPECTED_OPERATION_ANALYZERS[kind].some(
      (analyzerId) => (decodedByAnalyzer.get(analyzerId)?.length ?? 0) === 0
    )
  ) {
    fail("incomplete_coverage", `${kind} raw record set or analyzer evidence is incomplete`);
  }
  assertExactDecodedEvidenceSet(request, decodedByAnalyzer);
  assertComponentDigests([...decodedByAnalyzer.values()].flat());
  validateDecodedComponentBindings(request, decodedByAnalyzer);
  for (const observation of result.normalized_observations) validateObservation(observation);
  validateProvenanceGraph(result);
  for (const analyzer of result.analyzer_results) {
    assertSortedUnique(analyzer.blocker_codes, `${analyzer.analyzer_id} blocker codes`);
    const expected = expectedAnalyzerSemantics(
      analyzer.analyzer_id,
      decodedByAnalyzer.get(analyzer.analyzer_id) ?? [],
      result.freshness
    );
    if (canonicalJson(analyzer) !== canonicalJson(expected)) {
      fail(
        "invalid_contract",
        `analyzer result '${analyzer.analyzer_id}' contradicts canonical raw semantics`
      );
    }
  }
  const osv = kind === "osv_composer" || kind === "osv_npm";
  if (!osv) {
    if (
      result.freshness.fetched_at !== null ||
      result.freshness.max_age_seconds !== null ||
      result.freshness.expires_at !== null
    ) {
      fail("invalid_contract", `${kind} cannot claim OSV freshness evidence`);
    }
  } else {
    if (request.operation_kind !== "osv_composer" && request.operation_kind !== "osv_npm") {
      fail("invalid_binding", "OSV result request kind did not narrow exactly");
    }
    const osvRaw = (
      decodedByAnalyzer.get(kind === "osv_composer" ? "osv-composer" : "osv-npm") ?? []
    ).find(
      (entry) => isRecord(entry) && Reflect.get(entry, "schema_id") === "penny.sca-osv-result.v2"
    );
    if (isRecord(osvRaw)) {
      const fetchedAt = Reflect.get(osvRaw, "fetched_at");
      const maxAge = Reflect.get(osvRaw, "max_age_seconds");
      const expiresAt =
        typeof fetchedAt === "string" && typeof maxAge === "number"
          ? new Date(Date.parse(fetchedAt) + maxAge * 1_000).toISOString()
          : null;
      if (
        result.freshness.fetched_at !== fetchedAt ||
        result.freshness.max_age_seconds !== maxAge ||
        result.freshness.expires_at !== expiresAt ||
        maxAge !== request.freshness_max_age_seconds
      ) {
        fail("stale_evidence", `${kind} freshness contract contradicts trusted OSV evidence`);
      }
    } else if (
      result.freshness.fetched_at !== null ||
      result.freshness.max_age_seconds !== null ||
      result.freshness.expires_at !== null
    ) {
      fail("stale_evidence", `${kind} cannot claim freshness without fetched OSV evidence`);
    }
  }
  const blocked = result.analyzer_results.some((entry) => entry.status === "blocked");
  if ((blocked && result.status !== "blocked") || (!blocked && result.status !== "complete")) {
    fail("invalid_contract", `${kind} aggregate status is inconsistent`);
  }
  if (result.operation_kind === "inventory") {
    assertUnique(
      result.dependency_coordinates.map((entry) => entry.query_id),
      "inventory dependency coordinates"
    );
    assertUnique(
      result.dependency_mappings.map((entry) => entry.occurrence_id),
      "inventory dependency occurrences"
    );
    const coordinateById = new Map(
      result.dependency_coordinates.map((entry) => [entry.query_id, entry.package])
    );
    if (
      result.dependency_mappings.some(
        (entry) =>
          canonicalJson(coordinateById.get(entry.query_id)) !== canonicalJson(entry.package)
      )
    ) {
      fail("invalid_binding", "inventory dependency mapping is absent or package-mismatched");
    }
    if (
      canonicalJson(result.ecosystem_states.map((entry) => entry.ecosystem)) !==
      canonicalJson(["Packagist", "npm"])
    ) {
      fail("invalid_contract", "inventory ecosystem states must use the exact ordered set");
    }
    const dependency = (decodedByAnalyzer.get("dependency-npm") ?? []).find(
      (entry) =>
        isRecord(entry) &&
        Reflect.get(entry, "schema_id") === "penny.sca-dependency-inventory-result.v2"
    );
    if (!isRecord(dependency)) {
      if (
        result.status !== "blocked" ||
        result.dependency_coordinates.length !== 0 ||
        result.dependency_mappings.length !== 0
      ) {
        fail("incomplete_coverage", "inventory dependency component result is absent");
      }
      return result;
    }
    const expectedCoordinates = arrayMember(dependency, "coordinates").flatMap((entry) =>
      isRecord(entry) &&
      typeof Reflect.get(entry, "coordinate_id") === "string" &&
      typeof Reflect.get(entry, "ecosystem") === "string" &&
      typeof Reflect.get(entry, "name") === "string" &&
      typeof Reflect.get(entry, "version") === "string"
        ? [
            {
              query_id: Reflect.get(entry, "coordinate_id"),
              package: {
                ecosystem: Reflect.get(entry, "ecosystem"),
                name: Reflect.get(entry, "name"),
                version: Reflect.get(entry, "version"),
              },
            },
          ]
        : []
    );
    const expectedMappings = arrayMember(dependency, "occurrences").flatMap((entry) =>
      isRecord(entry) &&
      typeof Reflect.get(entry, "coordinate_id") === "string" &&
      typeof Reflect.get(entry, "occurrence_id") === "string" &&
      typeof Reflect.get(entry, "ecosystem") === "string" &&
      typeof Reflect.get(entry, "name") === "string" &&
      typeof Reflect.get(entry, "version") === "string"
        ? [
            {
              query_id: Reflect.get(entry, "coordinate_id"),
              occurrence_id: Reflect.get(entry, "occurrence_id"),
              package: {
                ecosystem: Reflect.get(entry, "ecosystem"),
                name: Reflect.get(entry, "name"),
                version: Reflect.get(entry, "version"),
              },
            },
          ]
        : []
    );
    if (
      canonicalJson(result.dependency_coordinates) !== canonicalJson(expectedCoordinates) ||
      canonicalJson(result.dependency_mappings) !== canonicalJson(expectedMappings)
    ) {
      fail("invalid_binding", "inventory coordinate handoff contradicts dependency raw records");
    }
  } else if (result.operation_kind === "osv_composer" || result.operation_kind === "osv_npm") {
    if (request.operation_kind !== "osv_composer" && request.operation_kind !== "osv_npm") {
      fail("invalid_binding", "OSV result request kind did not narrow exactly");
    }
    const analyzerId = result.operation_kind === "osv_composer" ? "osv-composer" : "osv-npm";
    const values = decodedByAnalyzer.get(analyzerId) ?? [];
    const plan = values.find(
      (entry) => isRecord(entry) && Reflect.get(entry, "schema_id") === "penny.sca-osv-plan.v2"
    );
    const osvResult = values.find(
      (entry) => isRecord(entry) && Reflect.get(entry, "schema_id") === "penny.sca-osv-result.v2"
    );
    if (request.coordinates.length > 0) {
      if (!isRecord(plan) || !isRecord(osvResult)) {
        if (result.status === "blocked") return result;
        fail("incomplete_coverage", "OSV plan and result raw evidence are required");
      }
      const plannedIds = arrayMember(plan, "batches").flatMap((batch) =>
        isRecord(batch)
          ? arrayMember(batch, "coordinate_ids").filter(
              (id): id is string => typeof id === "string"
            )
          : []
      );
      const requestIds = request.coordinates.map((entry) => entry.query_id);
      const inventoryDigest = sha256(
        canonicalJson({ coordinates: request.coordinates, mappings: request.mappings })
      );
      if (
        canonicalJson(plannedIds) !== canonicalJson(requestIds) ||
        Reflect.get(plan, "dependency_inventory_sha256") !== inventoryDigest ||
        Reflect.get(osvResult, "dependency_inventory_sha256") !== inventoryDigest ||
        Reflect.get(osvResult, "source_snapshot_sha256") !==
          sha256(canonicalJson(request.coordinates)) ||
        Reflect.get(osvResult, "plan_sha256") !== Reflect.get(plan, "plan_sha256")
      ) {
        fail("invalid_binding", "OSV evidence does not exactly bind inventory coordinates");
      }
    }
  }
  return result;
}

/**
 * Authorizing P02 operation-result admission. Structural parsing is deliberately separate;
 * every service/playbook acceptance path must call this function with host-owned authority.
 */
export function admitScaP02OperationResultV1(
  kind: ScaP02OperationKind,
  requestValue: unknown,
  value: unknown,
  authority: ScaP02ComponentValidationAuthorityV1
): ScaP02OperationResultV1 {
  if (authority === undefined || typeof authority.validateComponents !== "function") {
    fail("invalid_binding", "SCA P02 component validation authority is absent");
  }
  const request = validateScaP02OperationRequestV1(kind, requestValue);
  const result = validateScaP02OperationResultV1(kind, request, value);
  authority.validateComponents({ operation_kind: kind, request, result });
  return result;
}

export function validateScaP02PersistedEvidenceV1(value: unknown): ScaP02PersistedEvidenceV1 {
  const evidence = parse(ScaP02PersistedEvidenceV1Schema, value, "SCA P02 persisted evidence");
  const analyzerIds = evidence.analyzer_results.map((entry) => entry.analyzer_id);
  if (
    canonicalJson(analyzerIds) !==
    canonicalJson(EXPECTED_OPERATION_ANALYZERS[evidence.operation_kind])
  ) {
    fail("incomplete_coverage", "persisted evidence does not contain the operation analyzer set");
  }
  const expectedResultKind = `sca-p02-${evidence.operation_kind.replaceAll("_", "-")}-result`;
  if (
    evidence.operation_result_ref.run_id !== evidence.run_id ||
    evidence.operation_result_ref.kind !== expectedResultKind ||
    evidence.operation_result_ref.content_schema?.schema_id !==
      RESULT_SCHEMA_IDS[evidence.operation_kind] ||
    evidence.operation_result_ref.content_schema.schema_version !== 1
  ) {
    fail("invalid_binding", "persisted evidence does not bind its exact operation result contract");
  }
  assertUnique(
    evidence.raw_evidence.map((entry) => entry.evidence_id),
    "persisted raw evidence IDs"
  );
  assertUnique(
    evidence.normalized_observations.map((entry) => entry.observation_id),
    "persisted observation IDs"
  );
  const rebuiltRecords = evidence.raw_evidence.flatMap(
    (raw) => decodeScaP02RawEvidenceV1(raw).raw_records
  );
  if (canonicalJson(rebuiltRecords) !== canonicalJson(evidence.raw_records)) {
    fail("invalid_binding", "persisted evidence raw record set is invalid");
  }
  for (const observation of evidence.normalized_observations) validateObservation(observation);
  validateProvenanceGraph(evidence);
  assertSelfDigest(evidence, "evidence_sha256", "SCA P02 persisted evidence");
  return evidence;
}

const EXPECTED_ANALYZER_OPERATION: Readonly<Record<ScaP02AnalyzerId, ScaP02OperationKind>> =
  Object.freeze({
    "source-census": "inventory",
    "tree-sitter-php": "inventory",
    "tree-sitter-js-ts": "inventory",
    "dependency-composer": "inventory",
    "dependency-npm": "inventory",
    "semgrep-php": "semgrep_php",
    "semgrep-js-ts": "semgrep_js_ts",
    gitleaks: "gitleaks",
    "osv-composer": "osv_composer",
    "osv-npm": "osv_npm",
  });

export function validateScaP02CoverageMatrixV1(value: unknown): ScaP02CoverageMatrixV1 {
  const matrix = parse(ScaP02CoverageMatrixV1Schema, value, "SCA P02 coverage matrix");
  const ids = matrix.entries.map((entry) => entry.analyzer_id);
  if (canonicalJson(ids) !== canonicalJson(SCA_P02_ANALYZER_IDS)) {
    fail("incomplete_coverage", "coverage matrix must contain the exact ordered analyzer set");
  }
  for (const entry of matrix.entries) {
    if (entry.operation_kind !== EXPECTED_ANALYZER_OPERATION[entry.analyzer_id]) {
      fail("invalid_binding", `coverage entry '${entry.analyzer_id}' has the wrong operation`);
    }
    const expectedResultKind = `sca-p02-${entry.operation_kind.replaceAll("_", "-")}-result`;
    if (
      entry.operation_result_ref.run_id !== matrix.run_id ||
      entry.operation_result_ref.kind !== expectedResultKind ||
      entry.operation_result_ref.content_schema?.schema_id !==
        RESULT_SCHEMA_IDS[entry.operation_kind] ||
      entry.operation_result_ref.content_schema.schema_version !== 1 ||
      entry.normalized_evidence_ref.run_id !== matrix.run_id ||
      entry.normalized_evidence_ref.kind !== "sca-p02-persisted-evidence" ||
      entry.normalized_evidence_ref.content_schema?.schema_id !==
        SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA ||
      entry.normalized_evidence_ref.content_schema.schema_version !== 1
    ) {
      fail("invalid_binding", `coverage entry '${entry.analyzer_id}' has invalid evidence refs`);
    }
    assertSortedUnique(entry.blocker_codes, `${entry.analyzer_id} coverage blocker codes`);
    if (
      (entry.status === "complete" && entry.blocker_codes.length !== 0) ||
      (entry.status === "blocked" && entry.blocker_codes.length === 0) ||
      (entry.applicability === "not_applicable" &&
        (entry.status !== "complete" || entry.fresh !== true))
    ) {
      fail("incomplete_coverage", `coverage entry '${entry.analyzer_id}' is inconsistent`);
    }
  }
  assertSelfDigest(matrix, "coverage_sha256", "SCA P02 coverage matrix");
  return matrix;
}

interface SuccessorEvidenceDescriptor {
  readonly kind: string;
  readonly operation_id?: string;
  readonly schema_id: string;
  readonly schema_version: number;
}

function operationEvidenceDescriptors(
  kind: ScaP02OperationKind
): readonly SuccessorEvidenceDescriptor[] {
  const suffix = kind.replaceAll("_", "-");
  return [
    {
      kind: `sca-p02-${suffix}-result`,
      schema_id: RESULT_SCHEMA_IDS[kind],
      schema_version: 1,
    },
    {
      kind: "sca-p02-persisted-evidence",
      operation_id: `sca-p02-evidence-${suffix}`,
      schema_id: SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA,
      schema_version: 1,
    },
  ];
}

function successorEvidenceDescriptors(
  obligationId: (typeof SCA_P02_DISPOSITION_OBLIGATION_IDS)[number]
): readonly SuccessorEvidenceDescriptor[] {
  const inventory = operationEvidenceDescriptors("inventory");
  const semgrep = [
    ...operationEvidenceDescriptors("semgrep_php"),
    ...operationEvidenceDescriptors("semgrep_js_ts"),
  ];
  const secret = operationEvidenceDescriptors("gitleaks");
  const osv = [
    ...operationEvidenceDescriptors("osv_composer"),
    ...operationEvidenceDescriptors("osv_npm"),
  ];
  const allOperations = [...inventory, ...semgrep, ...secret, ...osv];
  const allEvidence = allOperations.filter(
    (descriptor) => descriptor.kind === "sca-p02-persisted-evidence"
  );
  switch (obligationId) {
    case "SCA-OBL-P01-ACCEPTANCE":
      return [
        {
          kind: "sca-p01-candidate-gate",
          operation_id: "sca-p01-candidate-gate",
          schema_id: "penny.sca-phase-gate-record.v2",
          schema_version: 2,
        },
        {
          kind: "sca-p01-candidate-campaign-manifest",
          operation_id: "sca-p01-candidate-campaign-manifest",
          schema_id: SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
          schema_version: 2,
        },
      ];
    case "SCA-OBL-OUTPUT-SOURCE-CENSUS":
    case "SCA-OBL-OUTPUT-SYNTAX-INDEX":
    case "SCA-OBL-OUTPUT-DEPENDENCY-INVENTORY":
      return inventory;
    case "SCA-OBL-OUTPUT-SEMGREP":
      return semgrep;
    case "SCA-OBL-OUTPUT-SECRET-SCAN":
      return secret;
    case "SCA-OBL-OUTPUT-OSV-EVIDENCE":
      return osv;
    case "SCA-OBL-OUTPUT-NORMALIZED-CANDIDATES":
      return allEvidence;
    case "SCA-OBL-P02-ACCEPTANCE":
      return [
        {
          kind: "sca-p02-coverage-matrix",
          operation_id: "sca-p02-coverage-matrix",
          schema_id: SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
          schema_version: 1,
        },
        ...allOperations,
      ];
    case "SCA-OBL-M1-NONTERMINAL":
      return [
        {
          kind: "sca-p02-coverage-matrix",
          operation_id: "sca-p02-coverage-matrix",
          schema_id: SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
          schema_version: 1,
        },
        ...allEvidence,
      ];
  }
}

function validateSuccessorEvidenceRefs(
  runId: string,
  obligationId: (typeof SCA_P02_DISPOSITION_OBLIGATION_IDS)[number],
  refs: readonly ArtifactRef[]
): void {
  const expected = successorEvidenceDescriptors(obligationId);
  if (
    refs.length !== expected.length ||
    refs.some((ref, index) => {
      const descriptor = expected[index];
      return (
        descriptor === undefined ||
        ref.run_id !== runId ||
        ref.kind !== descriptor.kind ||
        (descriptor.operation_id !== undefined && ref.operation_id !== descriptor.operation_id) ||
        ref.content_schema?.schema_id !== descriptor.schema_id ||
        ref.content_schema.schema_version !== descriptor.schema_version ||
        ref.media_type !== "application/json"
      );
    })
  ) {
    fail("invalid_binding", `${obligationId} evidence refs are not the exact required set`);
  }
  assertUnique(refs.map(refKey), `${obligationId} disposition evidence refs`);
}

export function validateScaP02SuccessorLedgerV1(value: unknown): ScaP02SuccessorLedgerV1 {
  const ledger = parse(ScaP02SuccessorLedgerV1Schema, value, "SCA P02 successor obligation ledger");
  if (
    canonicalJson(ledger.dispositions.map((entry) => entry.obligation_id)) !==
      canonicalJson(SCA_P02_DISPOSITION_OBLIGATION_IDS) ||
    ledger.dispositions[0]?.status !== "satisfied" ||
    ledger.dispositions[8]?.status !== ledger.dispositions[9]?.status
  ) {
    fail("invalid_contract", "P02 successor ledger dispositions are incomplete or unordered");
  }
  for (const disposition of ledger.dispositions) {
    validateSuccessorEvidenceRefs(
      ledger.run_id,
      disposition.obligation_id,
      disposition.evidence_refs
    );
  }
  assertSelfDigest(ledger, "ledger_sha256", "SCA P02 successor obligation ledger");
  return ledger;
}

export function validateScaP02SuccessorLedgerAgainstP01V1(input: {
  readonly successor: unknown;
  readonly prior_ledger: unknown;
  readonly prior_ledger_ref: ArtifactRef;
  readonly p01_campaign_manifest_ref: ArtifactRef;
}): ScaP02SuccessorLedgerV1 {
  const successor = validateScaP02SuccessorLedgerV1(input.successor);
  const prior = validateScaObligationLedgerV2(input.prior_ledger);
  if (
    !sameRef(successor.prior_p01_ledger_ref, input.prior_ledger_ref) ||
    successor.prior_p01_ledger_sha256 !== prior.ledger_sha256 ||
    successor.prior_entry_count !== prior.entries.length ||
    successor.prior_event_count !== prior.events.length ||
    canonicalJson(successor.prior_entries) !== canonicalJson(prior.entries) ||
    canonicalJson(successor.prior_events) !== canonicalJson(prior.events) ||
    successor.run_id !== prior.run_id ||
    !sameRef(successor.p01_campaign_manifest_ref, input.p01_campaign_manifest_ref)
  ) {
    fail("invalid_binding", "P02 successor ledger does not append the exact P01 ledger lineage");
  }
  const effective = new Map<string, (typeof prior.entries)[number]>();
  for (const entry of prior.entries) effective.set(entry.obligation_id, entry);
  const expectedPhases = new Map<string, string>([
    ["SCA-OBL-P01-ACCEPTANCE", "SCA-P01"],
    ["SCA-OBL-OUTPUT-SOURCE-CENSUS", "SCA-P02"],
    ["SCA-OBL-OUTPUT-SYNTAX-INDEX", "SCA-P02"],
    ["SCA-OBL-OUTPUT-SEMGREP", "SCA-P02"],
    ["SCA-OBL-OUTPUT-SECRET-SCAN", "SCA-P02"],
    ["SCA-OBL-OUTPUT-DEPENDENCY-INVENTORY", "SCA-P02"],
    ["SCA-OBL-OUTPUT-OSV-EVIDENCE", "SCA-P02"],
    ["SCA-OBL-OUTPUT-NORMALIZED-CANDIDATES", "SCA-P02"],
    ["SCA-OBL-P02-ACCEPTANCE", "SCA-P02"],
    ["SCA-OBL-M1-NONTERMINAL", "M1"],
  ]);
  if (
    SCA_P02_DISPOSITION_OBLIGATION_IDS.some(
      (id) => effective.get(id)?.semantic_phase_id !== expectedPhases.get(id)
    )
  ) {
    fail(
      "invalid_binding",
      "P02 successor dispositions do not resolve exact prior-ledger obligations and phases"
    );
  }
  return successor;
}

export function validateScaP02EvidenceManifestV1(value: unknown): ScaP02EvidenceManifestV1 {
  const manifest = parse(ScaP02EvidenceManifestV1Schema, value, "SCA P02 evidence manifest");
  assertP02AuthorityRefs(manifest);
  const p01Refs = [
    [manifest.p01_request_ref, "sca-p01-candidate-request", SCA_P01_ADMISSION_REQUEST_V3_SCHEMA, 3],
    [
      manifest.p01_campaign_manifest_core_ref,
      "sca-p01-candidate-manifest-core",
      SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
      1,
    ],
    [
      manifest.p01_campaign_manifest_ref,
      "sca-p01-candidate-campaign-manifest",
      SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
      2,
    ],
    [
      manifest.p01_predecessor_ledger_ref,
      "sca-p01-candidate-obligation-ledger",
      SCA_OBLIGATION_LEDGER_V2_SCHEMA,
      2,
    ],
  ] as const;
  if (
    p01Refs.some(
      ([ref, kind, schemaId, schemaVersion]) =>
        ref.run_id !== manifest.run_id ||
        ref.kind !== kind ||
        ref.content_schema?.schema_id !== schemaId ||
        ref.content_schema.schema_version !== schemaVersion
    )
  ) {
    fail("invalid_binding", "P02 evidence manifest P01 lineage refs are invalid");
  }
  const operationOrder = [
    "inventory",
    "semgrep_php",
    "semgrep_js_ts",
    "gitleaks",
    "osv_composer",
    "osv_npm",
  ];
  if (
    canonicalJson(manifest.operations.map((entry) => entry.operation_kind)) !==
      canonicalJson(operationOrder) ||
    canonicalJson(manifest.analyzers.map((entry) => entry.analyzer_id)) !==
      canonicalJson(SCA_P02_ANALYZER_IDS) ||
    canonicalJson(manifest.osv_evidence.map((entry) => entry.analyzer_id)) !==
      canonicalJson(["osv-composer", "osv-npm"])
  ) {
    fail("incomplete_coverage", "P02 evidence manifest has an incomplete ordered evidence set");
  }
  const requestSchemas: Readonly<Record<ScaP02OperationKind, string>> = {
    inventory: SCA_P02_INVENTORY_REQUEST_V1_SCHEMA,
    semgrep_php: SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA,
    semgrep_js_ts: SCA_P02_SEMGREP_JS_TS_REQUEST_V1_SCHEMA,
    gitleaks: SCA_P02_GITLEAKS_REQUEST_V1_SCHEMA,
    osv_composer: SCA_P02_OSV_COMPOSER_REQUEST_V1_SCHEMA,
    osv_npm: SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA,
  };
  const resultSchemas: Readonly<Record<ScaP02OperationKind, string>> = {
    inventory: SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
    semgrep_php: SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
    semgrep_js_ts: SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
    gitleaks: SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
    osv_composer: SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
    osv_npm: SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
  };
  for (const operation of manifest.operations) {
    assertSortedUnique(operation.raw_evidence_ids, "manifest operation raw evidence IDs");
    assertSortedUnique(operation.raw_record_ids, "manifest operation raw record IDs");
    const suffix = operation.operation_kind.replaceAll("_", "-");
    if (
      operation.operation_request_ref.run_id !== manifest.run_id ||
      operation.operation_request_ref.kind !== `sca-p02-${suffix}-request` ||
      operation.operation_request_ref.content_schema?.schema_id !==
        requestSchemas[operation.operation_kind] ||
      operation.operation_request_ref.content_schema.schema_version !== 1 ||
      operation.operation_result_ref.run_id !== manifest.run_id ||
      operation.operation_result_ref.kind !== `sca-p02-${suffix}-result` ||
      operation.operation_result_ref.content_schema?.schema_id !==
        resultSchemas[operation.operation_kind] ||
      operation.operation_result_ref.content_schema.schema_version !== 1 ||
      operation.normalized_evidence_ref.run_id !== manifest.run_id ||
      operation.normalized_evidence_ref.kind !== "sca-p02-persisted-evidence" ||
      operation.normalized_evidence_ref.content_schema?.schema_id !==
        SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA ||
      operation.normalized_evidence_ref.content_schema.schema_version !== 1 ||
      operation.operation_receipt_ref.run_id !== manifest.run_id ||
      operation.operation_receipt_ref.kind !== "host-operation-receipt" ||
      operation.operation_receipt_ref.producer !== "host:host-operation-owner" ||
      operation.operation_receipt_ref.content_schema?.schema_id !==
        "penny.host-operation-receipt.v1" ||
      operation.operation_receipt_ref.content_schema.schema_version !== 1
    ) {
      fail("invalid_binding", "P02 evidence manifest operation refs are invalid");
    }
  }
  const operations = new Map(
    manifest.operations.map((operation) => [operation.operation_kind, operation])
  );
  for (const analyzer of manifest.analyzers) {
    assertSortedUnique(analyzer.raw_evidence_ids, "manifest analyzer raw evidence IDs");
    assertSortedUnique(analyzer.raw_record_ids, "manifest analyzer raw record IDs");
    const operation = operations.get(analyzer.operation_kind);
    if (
      analyzer.operation_kind !== EXPECTED_ANALYZER_OPERATION[analyzer.analyzer_id] ||
      operation === undefined ||
      !sameRef(analyzer.operation_result_ref, operation.operation_result_ref) ||
      !sameRef(analyzer.normalized_evidence_ref, operation.normalized_evidence_ref) ||
      analyzer.raw_evidence_ids.some((id) => !operation.raw_evidence_ids.includes(id)) ||
      analyzer.raw_record_ids.some((id) => !operation.raw_record_ids.includes(id)) ||
      (analyzer.expires_at === null) !==
        (analyzer.fetched_at === null || analyzer.max_age_seconds === null)
    ) {
      fail("invalid_binding", "P02 evidence manifest analyzer detail is invalid");
    }
  }
  for (const entry of manifest.osv_evidence) {
    const kind = entry.analyzer_id === "osv-composer" ? "osv_composer" : "osv_npm";
    const operation = operations.get(kind);
    assertSortedUnique(entry.batch_evidence_ids, "manifest OSV batch evidence IDs");
    assertUnique(entry.coordinate_ids, "manifest OSV coordinate IDs");
    assertUnique(entry.occurrence_ids, "manifest OSV occurrence IDs");
    if (
      operation === undefined ||
      !sameRef(entry.operation_result_ref, operation.operation_result_ref) ||
      entry.batch_evidence_ids.some((id) => !operation.raw_evidence_ids.includes(id)) ||
      (entry.expires_at === null) !== (entry.fetched_at === null || entry.max_age_seconds === null)
    ) {
      fail("invalid_binding", "P02 evidence manifest OSV detail is invalid");
    }
  }
  assertSelfDigest(manifest, "manifest_sha256", "SCA P02 evidence manifest");
  return manifest;
}

export function validateScaP02GateV1(value: unknown): ScaP02GateV1 {
  const gate = parse(ScaP02GateV1Schema, value, "SCA P02 gate");
  assertP02AuthorityRefs(gate);
  if (
    (gate.isolation_scope === "live_qualified") !==
      (gate.isolation_host_attestation_ref !== null) ||
    (gate.status === "passed" && gate.blocker_codes.length !== 0) ||
    (gate.status === "blocked" && gate.blocker_codes.length === 0)
  ) {
    fail("invalid_gate", "P02 gate status and blockers disagree");
  }
  assertSelfDigest(gate, "gate_sha256", "SCA P02 gate");
  return gate;
}

export function validateScaM1RecordV2(value: unknown): ScaM1RecordV2 {
  const record = parse(ScaM1RecordV2Schema, value, "SCA M1 record v2");
  assertP02AuthorityRefs(record);
  if (
    (record.status === "passed" &&
      (record.blocker_codes.length !== 0 || record.transition_authorized !== true)) ||
    (record.status === "blocked" &&
      (record.blocker_codes.length === 0 || record.transition_authorized !== false))
  ) {
    fail("invalid_gate", "M1 status, blockers, and transition binding disagree");
  }
  assertSelfDigest(record, "record_sha256", "SCA M1 record v2");
  return record;
}

export function validateScaP02GateAgainstCoverageV1(input: {
  readonly gate: unknown;
  readonly coverage: unknown;
  readonly coverage_ref: ArtifactRef;
  readonly successor_ledger_ref: ArtifactRef;
  readonly evidence_manifest_ref: ArtifactRef;
  readonly evidence_manifest: unknown;
  readonly successor_ledger: unknown;
  readonly p02_request_ref: ArtifactRef;
  readonly runtime_policy_ref: ArtifactRef;
  readonly isolation_evidence_ref: ArtifactRef;
  readonly isolation_host_attestation_ref: ArtifactRef | null;
  readonly isolation_evidence: unknown;
}): { readonly gate: ScaP02GateV1; readonly coverage: ScaP02CoverageMatrixV1 } {
  const gate = validateScaP02GateV1(input.gate);
  const coverage = validateScaP02CoverageMatrixV1(input.coverage);
  const manifest = validateScaP02EvidenceManifestV1(input.evidence_manifest);
  const successor = validateScaP02SuccessorLedgerV1(input.successor_ledger);
  const isolation = validateScaP02IsolationEvidenceV1(input.isolation_evidence);
  assertExactIsolationHostAttestationRef({
    observed: gate.isolation_host_attestation_ref,
    expected: input.isolation_host_attestation_ref,
    isolation,
    label: "P02 gate",
  });
  assertExactIsolationHostAttestationRef({
    observed: manifest.isolation_host_attestation_ref,
    expected: input.isolation_host_attestation_ref,
    isolation,
    label: "P02 evidence manifest",
  });
  if (
    !sameRef(gate.p02_request_ref, input.p02_request_ref) ||
    !sameRef(gate.runtime_policy_ref, input.runtime_policy_ref) ||
    !sameRef(gate.isolation_evidence_ref, input.isolation_evidence_ref) ||
    !sameRef(manifest.p02_request_ref, input.p02_request_ref) ||
    !sameRef(manifest.runtime_policy_ref, input.runtime_policy_ref) ||
    !sameRef(manifest.isolation_evidence_ref, input.isolation_evidence_ref) ||
    !sameRef(gate.coverage_matrix_ref, input.coverage_ref) ||
    !sameRef(gate.successor_ledger_ref, input.successor_ledger_ref) ||
    !sameRef(gate.evidence_manifest_ref, input.evidence_manifest_ref) ||
    gate.run_id !== coverage.run_id ||
    manifest.run_id !== gate.run_id ||
    successor.run_id !== gate.run_id ||
    !sameRef(manifest.coverage_matrix_ref, input.coverage_ref) ||
    !sameRef(manifest.successor_ledger_ref, input.successor_ledger_ref) ||
    gate.isolation_scope !== isolation.qualification_scope ||
    input.coverage_ref.run_id !== coverage.run_id ||
    input.coverage_ref.kind !== "sca-p02-coverage-matrix" ||
    input.coverage_ref.content_schema?.schema_id !== SCA_P02_COVERAGE_MATRIX_V1_SCHEMA ||
    input.coverage_ref.content_schema.schema_version !== 1 ||
    input.successor_ledger_ref.run_id !== coverage.run_id ||
    input.successor_ledger_ref.kind !== "sca-p02-successor-obligation-ledger" ||
    input.successor_ledger_ref.content_schema?.schema_id !== SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA ||
    input.successor_ledger_ref.content_schema.schema_version !== 1 ||
    input.evidence_manifest_ref.run_id !== coverage.run_id ||
    input.evidence_manifest_ref.kind !== "sca-p02-evidence-manifest" ||
    input.evidence_manifest_ref.content_schema?.schema_id !== SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA ||
    input.evidence_manifest_ref.content_schema.schema_version !== 1
  ) {
    fail("invalid_binding", "P02 gate does not bind exact coverage, ledger, and isolation");
  }
  for (const coverageEntry of coverage.entries) {
    const detail = manifest.analyzers.find(
      (entry) => entry.analyzer_id === coverageEntry.analyzer_id
    );
    if (
      detail === undefined ||
      detail.operation_kind !== coverageEntry.operation_kind ||
      detail.applicability !== coverageEntry.applicability ||
      detail.status !== coverageEntry.status ||
      detail.fresh !== coverageEntry.fresh ||
      canonicalJson(detail.blocker_codes) !== canonicalJson(coverageEntry.blocker_codes) ||
      !sameRef(detail.operation_result_ref, coverageEntry.operation_result_ref) ||
      !sameRef(detail.normalized_evidence_ref, coverageEntry.normalized_evidence_ref)
    ) {
      fail("invalid_binding", "P02 gate manifest details contradict coverage");
    }
  }
  const evaluatedAt = Date.parse(gate.evaluated_at);
  const expiryBlockers = manifest.osv_evidence.flatMap((entry) =>
    entry.expires_at !== null && evaluatedAt > Date.parse(entry.expires_at)
      ? [`${entry.analyzer_id}:stale_at_gate`]
      : []
  );
  const blockers = [
    ...new Set([
      ...coverage.entries.flatMap((entry) => [
        ...entry.blocker_codes.map((code) => `${entry.analyzer_id}:${code}`),
        ...(entry.status !== "complete" ? [`${entry.analyzer_id}:incomplete`] : []),
        ...(entry.applicability === "applicable" && entry.fresh !== true
          ? [`${entry.analyzer_id}:stale`]
          : []),
      ]),
      ...expiryBlockers,
      ...(isolation.qualification_scope === "live_qualified" && isolation.qualified
        ? []
        : ["isolation:not_live_qualified"]),
    ]),
  ].sort();
  const expectedDispositionStatus = blockers.length === 0 ? "satisfied" : "blocked";
  if (
    canonicalJson(blockers) !== canonicalJson([...gate.blocker_codes].sort()) ||
    gate.status !== (blockers.length === 0 ? "passed" : "blocked") ||
    successor.dispositions
      .slice(1)
      .some((disposition) => disposition.status !== expectedDispositionStatus)
  ) {
    fail(
      "invalid_gate",
      "P02 gate does not exactly reflect live isolation and gate-time fresh analyzer coverage"
    );
  }
  return { gate, coverage };
}

export function validateScaM1AgainstGateV2(input: {
  readonly m1: unknown;
  readonly gate: unknown;
  readonly gate_ref: ArtifactRef;
  readonly coverage_ref: ArtifactRef;
  readonly successor_ledger_ref: ArtifactRef;
  readonly evidence_manifest_ref: ArtifactRef;
  readonly p02_request_ref: ArtifactRef;
  readonly runtime_policy_ref: ArtifactRef;
  readonly isolation_evidence_ref: ArtifactRef;
  readonly isolation_host_attestation_ref: ArtifactRef | null;
}): ScaM1RecordV2 {
  const m1 = validateScaM1RecordV2(input.m1);
  const gate = validateScaP02GateV1(input.gate);
  if (
    !sameRef(m1.p02_request_ref, input.p02_request_ref) ||
    !sameRef(m1.runtime_policy_ref, input.runtime_policy_ref) ||
    !sameRef(m1.isolation_evidence_ref, input.isolation_evidence_ref) ||
    canonicalJson(m1.isolation_host_attestation_ref) !==
      canonicalJson(input.isolation_host_attestation_ref) ||
    !sameRef(gate.p02_request_ref, input.p02_request_ref) ||
    !sameRef(gate.runtime_policy_ref, input.runtime_policy_ref) ||
    !sameRef(gate.isolation_evidence_ref, input.isolation_evidence_ref) ||
    canonicalJson(gate.isolation_host_attestation_ref) !==
      canonicalJson(input.isolation_host_attestation_ref) ||
    !sameRef(m1.gate_ref, input.gate_ref) ||
    !sameRef(m1.coverage_matrix_ref, input.coverage_ref) ||
    !sameRef(m1.successor_ledger_ref, input.successor_ledger_ref) ||
    !sameRef(m1.evidence_manifest_ref, input.evidence_manifest_ref) ||
    !sameRef(gate.evidence_manifest_ref, input.evidence_manifest_ref) ||
    m1.run_id !== gate.run_id ||
    input.gate_ref.run_id !== m1.run_id ||
    input.gate_ref.kind !== "sca-p02-gate" ||
    input.gate_ref.content_schema?.schema_id !== SCA_P02_GATE_V1_SCHEMA ||
    input.gate_ref.content_schema.schema_version !== 1 ||
    input.coverage_ref.run_id !== m1.run_id ||
    input.coverage_ref.kind !== "sca-p02-coverage-matrix" ||
    input.coverage_ref.content_schema?.schema_id !== SCA_P02_COVERAGE_MATRIX_V1_SCHEMA ||
    input.coverage_ref.content_schema.schema_version !== 1 ||
    input.successor_ledger_ref.kind !== "sca-p02-successor-obligation-ledger" ||
    input.successor_ledger_ref.content_schema?.schema_id !== SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA ||
    input.successor_ledger_ref.content_schema.schema_version !== 1 ||
    input.evidence_manifest_ref.kind !== "sca-p02-evidence-manifest" ||
    input.evidence_manifest_ref.content_schema?.schema_id !== SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA ||
    input.evidence_manifest_ref.content_schema.schema_version !== 1 ||
    m1.status !== gate.status ||
    canonicalJson(m1.blocker_codes) !== canonicalJson(gate.blocker_codes) ||
    m1.transition_authorized !== (gate.status === "passed")
  ) {
    fail("invalid_gate", "M1 does not exactly bind the P02 gate outcome");
  }
  return m1;
}

export function validateScaP02P03TransitionV1(value: unknown): ScaP02P03TransitionV1 {
  const transition = parse(ScaP02P03TransitionV1Schema, value, "SCA P02 to P03 transition");
  assertP02AuthorityRefs(transition);
  assertSelfDigest(transition, "transition_sha256", "SCA P02 to P03 transition");
  return transition;
}

export function validateScaP02TransitionAgainstM1V1(input: {
  readonly transition: unknown;
  readonly m1: unknown;
  readonly m1_ref: ArtifactRef;
  readonly gate_ref: ArtifactRef;
  readonly coverage_ref: ArtifactRef;
  readonly successor_ledger_ref: ArtifactRef;
  readonly evidence_manifest_ref: ArtifactRef;
  readonly evidence_manifest: unknown;
  readonly p01_request_ref: ArtifactRef;
  readonly p01_campaign_manifest_core_ref: ArtifactRef;
  readonly p01_campaign_manifest_ref: ArtifactRef;
  readonly p01_predecessor_ledger_ref: ArtifactRef;
  readonly p02_request_ref: ArtifactRef;
  readonly runtime_policy_ref: ArtifactRef;
  readonly isolation_evidence_ref: ArtifactRef;
  readonly isolation_host_attestation_ref: ArtifactRef | null;
}): ScaP02P03TransitionV1 {
  const transition = validateScaP02P03TransitionV1(input.transition);
  const m1 = validateScaM1RecordV2(input.m1);
  const manifest = validateScaP02EvidenceManifestV1(input.evidence_manifest);
  if (
    m1.status !== "passed" ||
    m1.transition_authorized !== true ||
    transition.run_id !== m1.run_id ||
    input.m1_ref.run_id !== m1.run_id ||
    input.m1_ref.kind !== "sca-m1-record" ||
    input.m1_ref.content_schema?.schema_id !== SCA_M1_RECORD_V2_SCHEMA ||
    input.m1_ref.content_schema.schema_version !== 2 ||
    input.gate_ref.run_id !== m1.run_id ||
    input.gate_ref.kind !== "sca-p02-gate" ||
    input.gate_ref.content_schema?.schema_id !== SCA_P02_GATE_V1_SCHEMA ||
    input.gate_ref.content_schema.schema_version !== 1 ||
    input.coverage_ref.run_id !== m1.run_id ||
    input.coverage_ref.kind !== "sca-p02-coverage-matrix" ||
    input.coverage_ref.content_schema?.schema_id !== SCA_P02_COVERAGE_MATRIX_V1_SCHEMA ||
    input.coverage_ref.content_schema.schema_version !== 1 ||
    !sameRef(transition.p02_request_ref, input.p02_request_ref) ||
    !sameRef(transition.runtime_policy_ref, input.runtime_policy_ref) ||
    !sameRef(transition.isolation_evidence_ref, input.isolation_evidence_ref) ||
    canonicalJson(transition.isolation_host_attestation_ref) !==
      canonicalJson(input.isolation_host_attestation_ref) ||
    !sameRef(m1.p02_request_ref, input.p02_request_ref) ||
    !sameRef(m1.runtime_policy_ref, input.runtime_policy_ref) ||
    !sameRef(m1.isolation_evidence_ref, input.isolation_evidence_ref) ||
    canonicalJson(m1.isolation_host_attestation_ref) !==
      canonicalJson(input.isolation_host_attestation_ref) ||
    !sameRef(manifest.p02_request_ref, input.p02_request_ref) ||
    !sameRef(manifest.runtime_policy_ref, input.runtime_policy_ref) ||
    !sameRef(manifest.isolation_evidence_ref, input.isolation_evidence_ref) ||
    canonicalJson(manifest.isolation_host_attestation_ref) !==
      canonicalJson(input.isolation_host_attestation_ref) ||
    !sameRef(transition.m1_ref, input.m1_ref) ||
    !sameRef(transition.p02_gate_ref, input.gate_ref) ||
    !sameRef(transition.coverage_matrix_ref, input.coverage_ref) ||
    !sameRef(transition.successor_ledger_ref, input.successor_ledger_ref) ||
    !sameRef(transition.evidence_manifest_ref, input.evidence_manifest_ref) ||
    !sameRef(transition.p01_request_ref, input.p01_request_ref) ||
    !sameRef(manifest.p01_request_ref, input.p01_request_ref) ||
    !sameRef(transition.p01_campaign_manifest_core_ref, input.p01_campaign_manifest_core_ref) ||
    !sameRef(manifest.p01_campaign_manifest_core_ref, input.p01_campaign_manifest_core_ref) ||
    !sameRef(transition.p01_campaign_manifest_ref, input.p01_campaign_manifest_ref) ||
    !sameRef(manifest.p01_campaign_manifest_ref, input.p01_campaign_manifest_ref) ||
    !sameRef(manifest.p01_predecessor_ledger_ref, input.p01_predecessor_ledger_ref) ||
    !sameRef(m1.successor_ledger_ref, input.successor_ledger_ref) ||
    !sameRef(m1.evidence_manifest_ref, input.evidence_manifest_ref) ||
    !sameRef(manifest.successor_ledger_ref, input.successor_ledger_ref) ||
    !sameRef(manifest.coverage_matrix_ref, input.coverage_ref)
  ) {
    fail(
      "invalid_gate",
      "P02 to P03 transition is not structurally authorized by exact lineage and M1 evidence"
    );
  }
  return transition;
}

export function scaP02P01BindingSha256(request: ScaP02RequestV1): string {
  return sha256(canonicalJson(request.accepted_p01));
}

export function withScaP02Digest<T extends Readonly<Record<string, unknown>>>(
  value: T,
  field:
    | "request_sha256"
    | "evidence_sha256"
    | "coverage_sha256"
    | "ledger_sha256"
    | "manifest_sha256"
    | "gate_sha256"
    | "record_sha256"
    | "transition_sha256"
): T {
  const unsigned = structuredClone(value);
  Reflect.deleteProperty(unsigned, field);
  Reflect.set(unsigned, field, sha256(canonicalJson(unsigned)));
  return unsigned;
}
