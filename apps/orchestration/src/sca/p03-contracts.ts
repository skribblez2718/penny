import { Type, type Static, type TSchema } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";
import { SCA_P01_MAX_SCOPE_ITEMS } from "./p01-contracts.js";

const MAX_REFS = 2_048;
/** P03 inherits P01's exact admitted source-file cardinality ceiling. */
export const SCA_P03_MAX_FILES = SCA_P01_MAX_SCOPE_ITEMS;
const MAX_FILES = SCA_P03_MAX_FILES;
const MAX_TEXT = 4_096;
export const SCA_P03_MAX_GRAPH_BYTES = 128 * 1024 * 1024;
/**
 * Covers a maximum graph after Base64 encoding plus the complete admitted 100,000-file result
 * ledger and canonical envelope. Recovery must accept every result that initial publication accepts.
 */
export const SCA_P03_MAX_GRAPH_OPERATION_BYTES = 384 * 1024 * 1024;
export const SCA_P03_MAX_QUERY_OUTPUT_BYTES = 64 * 1024 * 1024;
export const SCA_P03_MAX_QUERY_ITEMS = 10_000;
export const SCA_P03_MAX_PAGE_ITEMS = 1_000;
export const SCA_P03_MAX_PAGES_PER_QUERY = 10;
export const SCA_P03_MAX_QUERY_PAGES = 70;
export const SCA_P03_MAX_PATH_HOPS = 64;
/** Qualification flow search budget; the general path schema remains capped at 64. */
export const SCA_P03_QUALIFICATION_DATAFLOW_MAX_HOPS = 16;

export const SCA_P03_SOURCE_ORACLE_SCHEMA = "penny.sca-p03-source-oracle.v2";
export const SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA = "penny.sca-p03-source-oracle-validation.v1";
export const SCA_P03_SOURCE_ORACLE_VALIDATOR = "host:sca-p03-source-oracle-validator";
export const SCA_P03_SOURCE_ORACLE_PRODUCER = "host:sca-p03-source-oracle-authority";
export const SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER = "host:sca-p03-source-oracle-review";
export const SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA = "penny.sca-p03-source-oracle-review.v1";
export const SCA_P03_MAX_ORACLE_BYTES = 1024 * 1024;

export const SCA_P03_REQUEST_V2_SCHEMA = "penny.sca-p03-request.v2";
export const SCA_P03_ENTRY_ADMISSION_V2_SCHEMA = "penny.sca-p03-entry-admission.v2";
export const SCA_P03_RUNTIME_POLICY_V1_SCHEMA = "penny.sca-p03-runtime-policy.v1";
export const SCA_P03_JOERN_RUNTIME_IDENTITY_V1_SCHEMA = "penny.sca-p03-joern-runtime-identity.v1";
export const SCA_P03_ISOLATION_EVIDENCE_V1_SCHEMA = "penny.sca-p03-isolation-evidence.v1";
export const SCA_P03_HOST_ATTESTATION_V1_SCHEMA = "penny.sca-p03-host-isolation-attestation.v1";
export const SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA = "penny.sca-p03-implementation-identity.v1";
export const SCA_P03_QUALIFICATION_PROFILE_V1_SCHEMA = "penny.sca-p03-qualification-profile.v1";
export const SCA_P03_QUALIFICATION_PROFILE_V2_SCHEMA = "penny.sca-p03-qualification-profile.v2";
export const SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V1_SCHEMA =
  "penny.sca-p03-qualification-fixture-corpus.v1";
export const SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V2_SCHEMA =
  "penny.sca-p03-qualification-fixture-corpus.v2";
export const SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA =
  "penny.sca-p03-qualification-fixture-content.v1";
export const SCA_P03_FIDELITY_COMPLEMENT_V1_SCHEMA =
  "penny.sca-p03-fidelity-complement-evidence.v1";
export const SCA_P03_FIDELITY_COMPLEMENT_V2_SCHEMA =
  "penny.sca-p03-fidelity-complement-evidence.v2";
export const SCA_P03_QUERY_SCRIPT_V1_SCHEMA = "penny.sca-p03-query-script.v1";
export const SCA_P03_QUERY_SCRIPT_V2_SCHEMA = "penny.sca-p03-query-script.v2";
export const SCA_P03_QUERY_BINDING_V1_SCHEMA = "penny.sca-p03-query-binding.v1";
export const SCA_P03_QUERY_BINDING_V2_SCHEMA = "penny.sca-p03-query-binding.v2";
export const SCA_P03_QUERY_PLAN_V1_SCHEMA = "penny.sca-p03-query-plan.v1";
export const SCA_P03_QUERY_PLAN_V2_SCHEMA = "penny.sca-p03-query-plan.v2";
export const SCA_P03_BASELINE_QUERY_SET_V1_SCHEMA = "penny.sca-p03-baseline-query-set.v1";
export const SCA_P03_BASELINE_QUERY_SET_V2_SCHEMA = "penny.sca-p03-baseline-query-set.v2";
export const SCA_P03_QUALIFICATION_REQUEST_V1_SCHEMA = "penny.sca-p03-qualification-request.v1";
export const SCA_P03_QUALIFICATION_REQUEST_V2_SCHEMA = "penny.sca-p03-qualification-request.v2";
export const SCA_P03_QUALIFICATION_RESULT_V1_SCHEMA = "penny.sca-p03-qualification-result.v1";
export const SCA_P03_QUALIFICATION_RESULT_V2_SCHEMA = "penny.sca-p03-qualification-result.v2";
export const SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA = "penny.sca-p03-graph-build-request.v1";
export const SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA = "penny.sca-p03-graph-build-result.v1";
export const SCA_P03_GRAPH_COMPONENT_V1_SCHEMA = "penny.sca-p03-graph-component.v1";
export const SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V1_SCHEMA =
  "penny.sca-p03-baseline-query-batch-request.v1";
export const SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA =
  "penny.sca-p03-baseline-query-batch-request.v2";
export const SCA_P03_BASELINE_QUERY_PAGE_V1_SCHEMA = "penny.sca-p03-baseline-query-page.v1";
export const SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA = "penny.sca-p03-baseline-query-page.v2";
export const SCA_P03_BASELINE_QUERY_BATCH_RESULT_V1_SCHEMA =
  "penny.sca-p03-baseline-query-batch-result.v1";
export const SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA =
  "penny.sca-p03-baseline-query-batch-result.v2";
export const SCA_P03_GRAPH_PROVENANCE_V1_SCHEMA = "penny.sca-p03-graph-provenance.v1";
export const SCA_P03_GRAPH_MANIFEST_V1_SCHEMA = "penny.sca-p03-graph-manifest.v1";
export const SCA_P03_GRAPH_SUPPORT_MATRIX_V1_SCHEMA = "penny.sca-p03-graph-support-matrix.v1";
export const SCA_P03_GRAPH_SUPPORT_MATRIX_V2_SCHEMA = "penny.sca-p03-graph-support-matrix.v2";
export const SCA_P03_BASELINE_QUERY_AGGREGATE_V1_SCHEMA =
  "penny.sca-p03-baseline-query-aggregate.v1";
export const SCA_P03_BASELINE_QUERY_AGGREGATE_V2_SCHEMA =
  "penny.sca-p03-baseline-query-aggregate.v2";
export const SCA_P03_GRAPH_CANDIDATE_PACKET_V1_SCHEMA = "penny.sca-p03-graph-candidate-packet.v1";
export const SCA_P03_GRAPH_CANDIDATE_PACKET_V2_SCHEMA = "penny.sca-p03-graph-candidate-packet.v2";
export const SCA_P03_COVERAGE_MATRIX_V1_SCHEMA = "penny.sca-p03-coverage-matrix.v1";
export const SCA_P03_OPERATION_LOG_V1_SCHEMA = "penny.sca-p03-operation-log.v1";
export const SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA = "penny.sca-p03-qualification-evidence.v1";
export const SCA_P03_QUALIFICATION_RECORD_V2_SCHEMA = "penny.sca-p03-qualification-record.v2";
export const SCA_P03_EVIDENCE_MANIFEST_V2_SCHEMA = "penny.sca-p03-evidence-manifest.v2";
export const SCA_P03_ZERO_MODEL_EVIDENCE_V1_SCHEMA = "penny.sca-p03-zero-model-evidence.v1";
export const SCA_P03_SUCCESSOR_LEDGER_V1_SCHEMA = "penny.sca-p03-successor-obligation-ledger.v1";
export const SCA_P03_GATE_V1_SCHEMA = "penny.sca-p03-gate.v1";
export const SCA_P03_P04_TRANSITION_V2_SCHEMA = "penny.sca-p03-p04-transition.v2";
export const SCA_P03_TERMINAL_V2_SCHEMA = "penny.sca-p03-terminal.v2";

export const SCA_P03_CANDIDATE_PRODUCER = "host:sca-p03-candidate" as const;
export const SCA_P03_RUNTIME_POLICY_PRODUCER = "host:sca-p03-runtime-policy" as const;
export const SCA_P03_RUNTIME_IDENTITY_PRODUCER = "host:sca-p03-runtime-identity" as const;
export const SCA_P03_ISOLATION_PRODUCER = "host:sca-p03-isolation-qualification" as const;
export const SCA_P03_IMPLEMENTATION_PRODUCER = "host:sca-p03-implementation-identity" as const;
export const SCA_P03_QUERY_AUTHORITY_PRODUCER = "host:sca-p03-query-authority" as const;
export const SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER =
  "host:sca-p03-qualification-authority" as const;

/** Issuing-time contracts for exact inputs shared by bootstrap proof and production P03.
 * Bootstrap records, reviews, bindings, attempts and cleanup keep their separate custody roles.
 */
export const SCA_P03_PRODUCTION_INPUT_CONTRACTS = Object.freeze({
  runtime_policy: {
    kind: "sca-p03-runtime-policy",
    producer: SCA_P03_RUNTIME_POLICY_PRODUCER,
    content_schema: { schema_id: SCA_P03_RUNTIME_POLICY_V1_SCHEMA, schema_version: 1 },
  },
  runtime_identity: {
    kind: "sca-p03-joern-runtime-identity",
    producer: SCA_P03_RUNTIME_IDENTITY_PRODUCER,
    content_schema: { schema_id: SCA_P03_JOERN_RUNTIME_IDENTITY_V1_SCHEMA, schema_version: 1 },
  },
  implementation_identity: {
    kind: "sca-p03-implementation-identity",
    producer: SCA_P03_IMPLEMENTATION_PRODUCER,
    content_schema: { schema_id: SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA, schema_version: 1 },
  },
  qualification_profile: {
    kind: "sca-p03-qualification-profile",
    producer: SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
    content_schema: { schema_id: SCA_P03_QUALIFICATION_PROFILE_V2_SCHEMA, schema_version: 2 },
  },
  fixture_corpus: {
    kind: "sca-p03-qualification-fixture-corpus",
    producer: SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
    content_schema: {
      schema_id: SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V2_SCHEMA,
      schema_version: 2,
    },
  },
  fixture_content: {
    kind: "sca-p03-qualification-fixture-content",
    producer: SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
    content_schema: {
      schema_id: SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
      schema_version: 1,
    },
  },
  baseline_query_set: {
    kind: "sca-p03-baseline-query-set",
    producer: SCA_P03_QUERY_AUTHORITY_PRODUCER,
    content_schema: { schema_id: SCA_P03_BASELINE_QUERY_SET_V2_SCHEMA, schema_version: 2 },
  },
  query_script: {
    kind: "sca-p03-query-script",
    producer: SCA_P03_QUERY_AUTHORITY_PRODUCER,
    content_schema: { schema_id: SCA_P03_QUERY_SCRIPT_V2_SCHEMA, schema_version: 2 },
  },
  query_plan: {
    kind: "sca-p03-query-plan",
    producer: SCA_P03_QUERY_AUTHORITY_PRODUCER,
    content_schema: { schema_id: SCA_P03_QUERY_PLAN_V2_SCHEMA, schema_version: 2 },
  },
  host_attestation: {
    kind: "sca-p03-host-isolation-attestation",
    producer: SCA_P03_ISOLATION_PRODUCER,
    content_schema: { schema_id: SCA_P03_HOST_ATTESTATION_V1_SCHEMA, schema_version: 1 },
  },
} as const);

export const SCA_P03_QUERY_IDS = Object.freeze([
  "p03.graph-integrity.v2",
  "p03.symbol-entrypoint-index.v2",
  "p03.call-resolution.v2",
  "p03.control-guard.v2",
  "p03.dataflow-source-sink.v2",
  "p03.framework-dispatch.v2",
  "p03.unsupported-surface.v2",
] as const);
export type ScaP03QueryId = (typeof SCA_P03_QUERY_IDS)[number];

export const SCA_P03_PARTITIONS = Object.freeze(["php", "javascript_typescript"] as const);
export type ScaP03Partition = (typeof SCA_P03_PARTITIONS)[number];

/** Fixed Joern 4.0.627 frontend identity, not a caller-selectable language alias. */
export function scaP03FrontendLanguageV1(
  language: "php" | "javascript" | "typescript" | ScaP03Partition
): "PHP" | "JSSRC" {
  return language === "php" ? "PHP" : "JSSRC";
}

export const SCA_P03_OPERATION_IDS = Object.freeze({
  qualify: "sca-p03-qualify-joern",
  build_php: "sca-p03-build-source-graph-php",
  build_javascript_typescript: "sca-p03-build-source-graph-javascript-typescript",
  query_php: "sca-p03-baseline-query-batch-php",
  query_javascript_typescript: "sca-p03-baseline-query-batch-javascript-typescript",
} as const);

export const SCA_P03_COVERAGE_IDS = Object.freeze([
  "graph:php",
  "graph:javascript_typescript",
  ...SCA_P03_QUERY_IDS.map((queryId) => `query:${queryId}` as const),
]);

export const SCA_P03_OBLIGATION_IDS = Object.freeze([
  "SCA-OBL-OUTPUT-SOURCE-BOUND-GRAPH",
  "SCA-OBL-OUTPUT-BASELINE-GRAPH-QUERIES",
  "SCA-OBL-OUTPUT-GRAPH-CANDIDATES",
  "SCA-OBL-P03-ACCEPTANCE",
] as const);

export const SCA_P03_INPUT_SLOTS = Object.freeze({
  source_file_manifest: "source_file_manifest",
  source_custody: "source_custody",
  runtime_policy: "runtime_policy",
  runtime_identity: "runtime_identity",
  isolation_evidence: "isolation_evidence",
  host_attestation: "host_attestation",
  implementation_identity: "implementation_identity",
  qualification_profile: "qualification_profile",
  fixture_corpus: "fixture_corpus",
  source_oracle: "source_oracle",
  source_oracle_validation: "source_oracle_validation",
  source_oracle_review: "source_oracle_review",
  baseline_query_set: "baseline_query_set",
  graph_component: "graph_component",
  graph_build_request: "graph_build_request",
  graph_build_result: "graph_build_result",
} as const);

const QueryIdSchema = Type.Union([
  Type.Literal("p03.graph-integrity.v2"),
  Type.Literal("p03.symbol-entrypoint-index.v2"),
  Type.Literal("p03.call-resolution.v2"),
  Type.Literal("p03.control-guard.v2"),
  Type.Literal("p03.dataflow-source-sink.v2"),
  Type.Literal("p03.framework-dispatch.v2"),
  Type.Literal("p03.unsupported-surface.v2"),
]);
const PartitionSchema = Type.Union([Type.Literal("php"), Type.Literal("javascript_typescript")]);
const QualificationScopeSchema = Type.Union([
  Type.Literal("deterministic_test_only"),
  Type.Literal("live_qualified"),
]);
const RuntimeKindSchema = Type.Union([
  Type.Literal("simulated_joern_test_runtime"),
  Type.Literal("host_qualified_joern"),
]);
const BlockerCodeSchema = Type.String({ pattern: "^[a-z][a-z0-9_:-]{1,127}$" });
const RepositoryPathSchema = Type.String({ minLength: 1, maxLength: MAX_TEXT });
const NullableArtifactRefSchema = Type.Union([ArtifactRefSchema, Type.Null()]);

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

const P02BindingsSchema = Type.Object(
  {
    transition_ref: ArtifactRefSchema,
    p02_request_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    qualification_definition_ref: ArtifactRefSchema,
    qualification_gate_ref: ArtifactRefSchema,
    m1_ref: ArtifactRefSchema,
    coverage_matrix_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 26, maxItems: 64 }),
  },
  { additionalProperties: false }
);

export const ScaP03RequestV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_REQUEST_V2_SCHEMA),
    schema_version: Type.Literal(2),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P03"),
    accepted_p01: P01BindingsSchema,
    accepted_p02: P02BindingsSchema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    runtime_policy_ref: ArtifactRefSchema,
    joern_runtime_identity_ref: ArtifactRefSchema,
    isolation_evidence_ref: ArtifactRefSchema,
    host_isolation_attestation_ref: NullableArtifactRefSchema,
    implementation_identity_ref: ArtifactRefSchema,
    qualification_profile_ref: ArtifactRefSchema,
    fixture_corpus_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    fixture_content_refs: Type.Array(ArtifactRefSchema, { minItems: 3, maxItems: 256 }),
    fidelity_complement_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    baseline_query_set_ref: ArtifactRefSchema,
    query_script_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    query_plan_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    runtime_package_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
    bootstrap_verification: Type.Optional(
      Type.Object(
        {
          purpose: Type.Literal("sealed_bootstrap_verification"),
          manifest_sha256: Sha256Schema,
          sealed_inputs_ref: ArtifactRefSchema,
          backend_resource_sha256: Sha256Schema,
          input_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 512 }),
        },
        { additionalProperties: false }
      )
    ),
    p01_binding_sha256: Sha256Schema,
    p02_binding_sha256: Sha256Schema,
    p03_runtime_binding_sha256: Sha256Schema,
    requested_at: Rfc3339UtcSchema,
    request_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_REQUEST_V2_SCHEMA }
);
export type ScaP03RequestV2 = Readonly<Static<typeof ScaP03RequestV2Schema>>;

export const ScaP03RuntimePolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_RUNTIME_POLICY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    policy_id: OpaqueIdSchema,
    /** SHA-256 of the exact private staging-parent UTF-8 string; never the host path. */
    staging_parent_sha256: Sha256Schema,
    source_posture: Type.Literal("read_only"),
    network_access: Type.Literal("denied"),
    package_acquisition: Type.Literal("forbidden"),
    target_execution: Type.Literal("forbidden"),
    shell_execution: Type.Literal("forbidden"),
    joern_server: Type.Literal("forbidden"),
    process_timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
    max_graph_bytes: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_GRAPH_BYTES }),
    max_query_output_bytes: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_OUTPUT_BYTES }),
    max_query_items: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_ITEMS }),
    max_page_items: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_PAGE_ITEMS }),
    max_pages_per_query: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_PAGES_PER_QUERY }),
    max_ast_depth: Type.Integer({ minimum: 1, maximum: 32 }),
    max_ast_nodes: Type.Integer({ minimum: 1, maximum: 256 }),
    max_num_def: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  },
  { additionalProperties: false, $id: SCA_P03_RUNTIME_POLICY_V1_SCHEMA }
);
export type ScaP03RuntimePolicyV1 = Readonly<Static<typeof ScaP03RuntimePolicyV1Schema>>;

export const ScaP03JoernRuntimeIdentityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_JOERN_RUNTIME_IDENTITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    runtime_id: OpaqueIdSchema,
    runtime_kind: RuntimeKindSchema,
    qualification_scope: QualificationScopeSchema,
    root_tool_id: OpaqueIdSchema,
    root_executable_ref: ArtifactRefSchema,
    root_measurement_ref: ArtifactRefSchema,
    toolchain_ref: ArtifactRefSchema,
    runtime_package_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
    runtime_tree_sha256: Sha256Schema,
    joern_version: Type.String({ minLength: 1, maxLength: 256 }),
    php_frontend_version: Type.String({ minLength: 1, maxLength: 256 }),
    javascript_frontend_version: Type.String({ minLength: 1, maxLength: 256 }),
    jvm_version: Type.String({ minLength: 1, maxLength: 256 }),
    php_runtime_version: Type.String({ minLength: 1, maxLength: 256 }),
    helper_version: Type.String({ minLength: 1, maxLength: 256 }),
    identity_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_JOERN_RUNTIME_IDENTITY_V1_SCHEMA }
);
export type ScaP03JoernRuntimeIdentityV1 = Readonly<
  Static<typeof ScaP03JoernRuntimeIdentityV1Schema>
>;

export const ScaP03HostIsolationAttestationV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_HOST_ATTESTATION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    attestation_id: OpaqueIdSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    parser_identity_sha256: Sha256Schema,
    runtime_kind: Type.Literal("host_qualified_joern"),
    runtime_id: OpaqueIdSchema,
    isolation_id: OpaqueIdSchema,
    implementation_identity_sha256: Sha256Schema,
    deployment_identity_sha256: Sha256Schema,
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    runtime_tree_sha256: Sha256Schema,
    qualification_scope: Type.Literal("live_qualified"),
    qualified: Type.Literal(true),
    attested_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false, $id: SCA_P03_HOST_ATTESTATION_V1_SCHEMA }
);
export type ScaP03HostIsolationAttestationV1 = Readonly<
  Static<typeof ScaP03HostIsolationAttestationV1Schema>
>;

const IsolationCommon = {
  schema_id: Type.Literal(SCA_P03_ISOLATION_EVIDENCE_V1_SCHEMA),
  schema_version: Type.Literal(1),
  producer_id: Type.Literal(SCA_P03_ISOLATION_PRODUCER),
  runtime_id: OpaqueIdSchema,
  isolation_id: OpaqueIdSchema,
  implementation_identity_sha256: Sha256Schema,
  deployment_identity_sha256: Sha256Schema,
  profile_id: OpaqueIdSchema,
  profile_sha256: Sha256Schema,
  runtime_tree_sha256: Sha256Schema,
  qualified_at: Rfc3339UtcSchema,
} as const;

export const ScaP03IsolationEvidenceV1Schema = Type.Union(
  [
    Type.Object(
      {
        ...IsolationCommon,
        evidence_kind: Type.Literal("simulated_joern_test_seam"),
        runtime_kind: Type.Literal("simulated_joern_test_runtime"),
        qualification_scope: Type.Literal("deterministic_test_only"),
        qualified: Type.Literal(false),
        simulation_label: Type.Literal("simulated_joern_test_seam"),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        ...IsolationCommon,
        evidence_kind: Type.Literal("host_qualification_attestation"),
        runtime_kind: Type.Literal("host_qualified_joern"),
        qualification_scope: Type.Literal("live_qualified"),
        qualified: Type.Literal(true),
        host_attestation_id: OpaqueIdSchema,
        host_attestation_sha256: Sha256Schema,
        host_attestation_ref: ArtifactRefSchema,
      },
      { additionalProperties: false }
    ),
  ],
  { $id: SCA_P03_ISOLATION_EVIDENCE_V1_SCHEMA }
);
export type ScaP03IsolationEvidenceV1 = Readonly<Static<typeof ScaP03IsolationEvidenceV1Schema>>;

export const ScaP03ImplementationIdentityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    implementation_id: OpaqueIdSchema,
    implementation_revision: OpaqueIdSchema,
    source_sha256: Sha256Schema,
    build_sha256: Sha256Schema,
    normalizer_sha256: Sha256Schema,
    query_runner_sha256: Sha256Schema,
    implementation_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA }
);
export type ScaP03ImplementationIdentityV1 = Readonly<
  Static<typeof ScaP03ImplementationIdentityV1Schema>
>;

const FidelityDimensionSchema = Type.Union([
  Type.Literal("language"),
  Type.Literal("framework"),
  Type.Literal("edge_class"),
  Type.Literal("surface"),
]);
const FidelityRequirementSchema = Type.Object(
  {
    requirement_id: OpaqueIdSchema,
    dimension: FidelityDimensionSchema,
    subject: Type.String({ minLength: 1, maxLength: 256 }),
    partition: PartitionSchema,
    materiality: Type.Union([Type.Literal("material"), Type.Literal("non_material")]),
    complement_evidence_ref: NullableArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type ScaP03FidelityRequirementV1 = Readonly<Static<typeof FidelityRequirementSchema>>;

export const ScaP03QualificationProfileV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUALIFICATION_PROFILE_V2_SCHEMA),
    schema_version: Type.Literal(2),
    profile_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P03"),
    required_languages: Type.Tuple([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    required_query_ids: Type.Array(QueryIdSchema, { minItems: 7, maxItems: 7 }),
    fidelity_requirements: Type.Array(FidelityRequirementSchema, { minItems: 6, maxItems: 256 }),
    requires_live_runtime: Type.Literal(true),
    criterion_ids: Type.Tuple([
      Type.Literal("AC-P03.graph-construction"),
      Type.Literal("AC-P03.baseline-queries"),
      Type.Literal("AC-P03.recovery-cancellation"),
      Type.Literal("AC-P03.zero-model-ordering"),
    ]),
    profile_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_QUALIFICATION_PROFILE_V2_SCHEMA }
);
export type ScaP03QualificationProfileV2 = Readonly<
  Static<typeof ScaP03QualificationProfileV2Schema>
>;

export const ScaP03FidelityComplementEvidenceV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_FIDELITY_COMPLEMENT_V2_SCHEMA),
    schema_version: Type.Literal(2),
    complement_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    requirement_id: OpaqueIdSchema,
    partition: PartitionSchema,
    qualification_scope: Type.Literal("live_qualified"),
    support: Type.Literal("supported"),
    method_id: OpaqueIdSchema,
    method_version: Type.String({ minLength: 1, maxLength: 128 }),
    producer_id: OpaqueIdSchema,
    source_snapshot_ref: ArtifactRefSchema,
    graph_component_ref: ArtifactRefSchema,
    baseline_query_set_ref: ArtifactRefSchema,
    fixture_oracle_ref: ArtifactRefSchema,
    observed_link_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
    independent_review_ref: ArtifactRefSchema,
    max_hops: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_PATH_HOPS }),
    max_results: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_ITEMS }),
    max_bytes: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_OUTPUT_BYTES }),
    complement_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_FIDELITY_COMPLEMENT_V2_SCHEMA }
);
export type ScaP03FidelityComplementEvidenceV2 = Readonly<
  Static<typeof ScaP03FidelityComplementEvidenceV2Schema>
>;

export const ScaP03QualificationFixtureContentV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    fixture_id: OpaqueIdSchema,
    language: Type.Union([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    path: RepositoryPathSchema,
    encoding: Type.Literal("base64"),
    content_base64: Type.String({ maxLength: 16 * 1024 * 1024 }),
    byte_length: Type.Integer({ minimum: 0, maximum: 12 * 1024 * 1024 }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA }
);
export type ScaP03QualificationFixtureContentV1 = Readonly<
  Static<typeof ScaP03QualificationFixtureContentV1Schema>
>;

const CandidateKindSchema = Type.Union([
  Type.Literal("symbol_or_entrypoint"),
  Type.Literal("route_or_framework_surface"),
  Type.Literal("call_or_unresolved_call"),
  Type.Literal("guard_or_control_relationship"),
  Type.Literal("source_to_sink_flow"),
  Type.Literal("trust_boundary_candidate"),
  Type.Literal("unsupported_or_unresolved_surface"),
]);

const PathRoleSchema = Type.Union([
  Type.Literal("symbol"),
  Type.Literal("call_site"),
  Type.Literal("callee"),
  Type.Literal("guard"),
  Type.Literal("action"),
  Type.Literal("source"),
  Type.Literal("sink"),
  Type.Literal("registration"),
  Type.Literal("handler"),
  Type.Literal("unknown"),
]);
const PathVertexSchema = Type.Object(
  {
    node_id: Type.String({ minLength: 1, maxLength: 128 }),
    role: PathRoleSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
    full_name: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]),
    path: Type.Union([RepositoryPathSchema, Type.Null()]),
    line: Type.Union([Type.Integer({ minimum: 1, maximum: 100_000_000 }), Type.Null()]),
    column: Type.Union([Type.Integer({ minimum: 1, maximum: 100_000_000 }), Type.Null()]),
    location_provenance: Type.Union([
      Type.Literal("direct"),
      Type.Literal("containing_method"),
      Type.Literal("external_unaccounted"),
      Type.Literal("qualified_source_oracle"),
    ]),
    // Only qualified complements may use a reviewed location instead of the CPG line.
    // The direct CPG line and exact approved receipt remain visible separately.
    source_location_ref: Type.Optional(ArtifactRefSchema),
    cpg_line: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000_000 })),
    location_owner_node_id: Type.Union([
      Type.String({ minLength: 1, maxLength: 128 }),
      Type.Null(),
    ]),
    // Explicit observed CONTAINS witness; an owner outside the relationship path is not
    // silently promoted to a path vertex or assumed to be the callee.
    location_evidence: Type.Union([
      Type.Object(
        {
          owner_node_id: Type.String({ minLength: 1, maxLength: 128 }),
          owner_label: Type.Union([
            Type.Literal("method"),
            Type.Literal("type"),
            Type.Literal("file"),
          ]),
          owner_path: RepositoryPathSchema,
          edge_kind: Type.Literal("contains"),
          edge_src_node_id: Type.String({ minLength: 1, maxLength: 128 }),
          edge_dst_node_id: Type.String({ minLength: 1, maxLength: 128 }),
        },
        { additionalProperties: false }
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false }
);
const PathEdgeSchema = Type.Object(
  {
    src_index: Type.Integer({ minimum: 0, maximum: SCA_P03_MAX_PATH_HOPS }),
    dst_index: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_PATH_HOPS }),
    src_node_id: Type.String({ minLength: 1, maxLength: 128 }),
    dst_node_id: Type.String({ minLength: 1, maxLength: 128 }),
    kind: Type.Union([
      Type.Literal("ast"),
      Type.Literal("call"),
      Type.Literal("cfg"),
      Type.Literal("reaching_def"),
      Type.Literal("contains"),
      Type.Literal("dispatch"),
    ]),
    direction: Type.Literal("forward"),
    provenance: Type.Union([
      Type.Literal("observed_cpg"),
      Type.Literal("joern_semantic"),
      Type.Literal("qualified_complement"),
    ]),
    branch_orientation: Type.Union([Type.Literal("true"), Type.Literal("false"), Type.Null()]),
    complement_ref: NullableArtifactRefSchema,
  },
  { additionalProperties: false }
);

export const ScaP03QueryCandidateV2Schema = Type.Object(
  {
    candidate_id: Type.String({ pattern: "^p03c_[a-f0-9]{64}$" }),
    candidate_kind: CandidateKindSchema,
    query_id: QueryIdSchema,
    disposition: Type.Union([
      Type.Literal("supported"),
      Type.Literal("unresolved"),
      Type.Literal("unsupported"),
    ]),
    reason_code: Type.Union([BlockerCodeSchema, Type.Null()]),
    claim: Type.Union([
      Type.Literal("observation"),
      Type.Literal("call_resolution"),
      Type.Literal("control_reachability"),
      Type.Literal("reaching_definition"),
      Type.Literal("framework_dispatch"),
      Type.Literal("unsupported_surface"),
    ]),
    source_selector: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    sink_selector: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    framework: Type.Union([
      Type.Literal("express"),
      Type.Literal("nestjs"),
      Type.Literal("wordpress"),
      Type.Null(),
    ]),
    registration_form: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    callback_resolution: Type.Union([
      Type.Literal("observed"),
      Type.Literal("dynamic"),
      Type.Literal("unproven"),
      Type.Null(),
    ]),
    assumptions: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 8 }),
    graph_component_sha256: Sha256Schema,
    source_snapshot_sha256: Sha256Schema,
    query_release_sha256: Sha256Schema,
    vertices: Type.Array(PathVertexSchema, { minItems: 1, maxItems: SCA_P03_MAX_PATH_HOPS + 1 }),
    edges: Type.Array(PathEdgeSchema, { maxItems: SCA_P03_MAX_PATH_HOPS }),
    hop_count: Type.Integer({ minimum: 0, maximum: SCA_P03_MAX_PATH_HOPS }),
    serialized_bytes: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_OUTPUT_BYTES }),
    truncated: Type.Boolean(),
    // The first vertex can be external/generated. Null is allowed only for an explicitly
    // unresolved path_location_unaccounted trace; it is never an invented repository anchor.
    path: Type.Union([RepositoryPathSchema, Type.Null()]),
    line: Type.Union([Type.Integer({ minimum: 1, maximum: 100_000_000 }), Type.Null()]),
    stable_locator: Type.String({ minLength: 1, maxLength: 1_024 }),
    summary: Type.String({ minLength: 1, maxLength: 2_048 }),
  },
  { additionalProperties: false }
);
export type ScaP03QueryCandidateV2 = Readonly<Static<typeof ScaP03QueryCandidateV2Schema>>;

/** Candidate observations remain small enough for the existing 8 MiB qualification cache. */
export const SCA_P03_MAX_QUALIFICATION_CASE_BYTES = 256 * 1024;
export const SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES = 4 * 1024 * 1024;
export const SCA_P03_MAX_QUALIFICATION_OBSERVATIONS = 1_000;

const OracleVertexSelectorSchema = Type.Object(
  {
    path: RepositoryPathSchema,
    name: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    line: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    role: PathRoleSchema,
  },
  { additionalProperties: false }
);
const OracleEdgeSelectorSchema = Type.Object(
  {
    kind: PathEdgeSchema.properties.kind,
    provenance: PathEdgeSchema.properties.provenance,
    branch_orientation: PathEdgeSchema.properties.branch_orientation,
  },
  { additionalProperties: false }
);
export const ScaP03OracleAssertionV2Schema = Type.Object(
  {
    expectation: Type.Union([Type.Literal("present"), Type.Literal("absent")]),
    candidate_kind: CandidateKindSchema,
    claim: ScaP03QueryCandidateV2Schema.properties.claim,
    disposition: ScaP03QueryCandidateV2Schema.properties.disposition,
    start: Type.Optional(OracleVertexSelectorSchema),
    via: Type.Optional(
      Type.Array(OracleVertexSelectorSchema, { minItems: 1, maxItems: SCA_P03_MAX_PATH_HOPS - 1 })
    ),
    end: Type.Optional(OracleVertexSelectorSchema),
    edge: Type.Optional(OracleEdgeSelectorSchema),
    framework: Type.Optional(ScaP03QueryCandidateV2Schema.properties.framework),
    registration_form: Type.Optional(ScaP03QueryCandidateV2Schema.properties.registration_form),
    callback_resolution: Type.Optional(ScaP03QueryCandidateV2Schema.properties.callback_resolution),
    source_selector: Type.Optional(ScaP03QueryCandidateV2Schema.properties.source_selector),
    sink_selector: Type.Optional(ScaP03QueryCandidateV2Schema.properties.sink_selector),
    reason_code: Type.Optional(ScaP03QueryCandidateV2Schema.properties.reason_code),
  },
  { additionalProperties: false }
);
export type ScaP03OracleAssertionV2 = Readonly<Static<typeof ScaP03OracleAssertionV2Schema>>;

const QualificationExpectedCaseSchema = Type.Object(
  {
    case_id: OpaqueIdSchema,
    language: Type.Union([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    query_id: QueryIdSchema,
    // Null until an independently reviewed observation has actually been measured.
    expected_observed_sha256: Type.Union([Sha256Schema, Type.Null()]),
    oracle_assertions: Type.Array(ScaP03OracleAssertionV2Schema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false }
);

export const ScaP03QualificationFixtureCorpusV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V2_SCHEMA),
    schema_version: Type.Literal(2),
    corpus_id: OpaqueIdSchema,
    fixture_content_refs: Type.Array(ArtifactRefSchema, { minItems: 3, maxItems: 256 }),
    fixture_ids: Type.Array(OpaqueIdSchema, { minItems: 3, maxItems: 256 }),
    languages: Type.Tuple([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    expected_cases: Type.Array(QualificationExpectedCaseSchema, {
      minItems: 21,
      maxItems: 21,
    }),
    corpus_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V2_SCHEMA }
);
export type ScaP03QualificationFixtureCorpusV2 = Readonly<
  Static<typeof ScaP03QualificationFixtureCorpusV2Schema>
>;

/** Campaign queries bind the same frozen executors/plans without fixture selectors. */
export function scaP03QueryReleaseSha256V2(
  input: Pick<
    Parameters<typeof scaP03OracleBoundReleaseSha256V2>[0],
    "query_set_id" | "release_id" | "query_set_sha256" | "queries"
  >
): string {
  return sha256(
    canonicalJson({
      query_set_id: input.query_set_id,
      release_id: input.release_id,
      query_set_sha256: input.query_set_sha256,
      queries: input.queries.map((entry) => ({
        query_id: entry.query_id,
        script_id: entry.script_id,
        script_sha256: entry.script_sha256,
        binding: entry.binding,
        plan_sha256: entry.plan.plan_sha256,
      })),
    })
  );
}

/** Qualification release binds frozen executors and plans to an exact persisted oracle corpus. */
export function scaP03OracleBoundReleaseSha256V2(input: {
  readonly query_set_id: string;
  readonly release_id: string;
  readonly query_set_sha256: string;
  readonly queries: readonly Readonly<{
    query_id: ScaP03QueryId;
    script_id: string;
    script_sha256: string;
    binding: ScaP03QueryBindingV2;
    plan: ScaP03QueryPlanV2;
  }>[];
  readonly oracle_ref: ArtifactRef;
  readonly oracle: ScaP03QualificationFixtureCorpusV2;
}): string {
  return sha256(
    canonicalJson({
      query_set_id: input.query_set_id,
      release_id: input.release_id,
      query_set_sha256: input.query_set_sha256,
      queries: input.queries.map((entry) => ({
        query_id: entry.query_id,
        script_id: entry.script_id,
        script_sha256: entry.script_sha256,
        binding: entry.binding,
        plan: entry.plan,
      })),
      oracle_ref: input.oracle_ref,
      oracle_sha256: input.oracle.corpus_sha256,
      selectors: input.oracle.expected_cases.map((entry) => ({
        case_id: entry.case_id,
        language: entry.language,
        query_id: entry.query_id,
        oracle_assertions: entry.oracle_assertions,
      })),
    })
  );
}

export const ScaP03QueryBindingV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUERY_BINDING_V2_SCHEMA),
    schema_version: Type.Literal(2),
    release_id: OpaqueIdSchema,
    query_id: QueryIdSchema,
    executor_id: QueryIdSchema,
    plan_id: OpaqueIdSchema,
    plan_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_QUERY_BINDING_V2_SCHEMA }
);
export type ScaP03QueryBindingV2 = Readonly<Static<typeof ScaP03QueryBindingV2Schema>>;

export const ScaP03QueryScriptV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUERY_SCRIPT_V2_SCHEMA),
    schema_version: Type.Literal(2),
    query_id: QueryIdSchema,
    script_id: OpaqueIdSchema,
    language: Type.Literal("penny_typed_query_binding_v2"),
    review_status: Type.Literal("host_reviewed_frozen"),
    encoding: Type.Literal("base64"),
    content_base64: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
    byte_length: Type.Integer({ minimum: 1, maximum: 12 * 1024 }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_QUERY_SCRIPT_V2_SCHEMA }
);
export type ScaP03QueryScriptV2 = Readonly<Static<typeof ScaP03QueryScriptV2Schema>>;

const QueryPlanStepSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("select_node"),
      node_class: Type.Union([
        Type.Literal("method"),
        Type.Literal("call"),
        Type.Literal("control_structure"),
        Type.Literal("identifier"),
        Type.Literal("literal"),
      ]),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("filter_property"),
      property: Type.Union([
        Type.Literal("name"),
        Type.Literal("full_name"),
        Type.Literal("file_name"),
        Type.Literal("line_number"),
      ]),
      operator: Type.Union([Type.Literal("equals"), Type.Literal("present")]),
      value: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("traverse_edge"),
      edge: Type.Union([
        Type.Literal("ast"),
        Type.Literal("call"),
        Type.Literal("cfg"),
        Type.Literal("reaching_def"),
        Type.Literal("contains"),
      ]),
      max_hops: Type.Integer({ minimum: 1, maximum: 64 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("project"),
      fields: Type.Array(
        Type.Union([
          Type.Literal("node_id"),
          Type.Literal("name"),
          Type.Literal("full_name"),
          Type.Literal("file_name"),
          Type.Literal("line_number"),
          Type.Literal("edge_kind"),
        ]),
        { minItems: 1, maxItems: 6 }
      ),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("limit"),
      max_items: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_ITEMS }),
    },
    { additionalProperties: false }
  ),
]);

export const ScaP03QueryPlanV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUERY_PLAN_V2_SCHEMA),
    schema_version: Type.Literal(2),
    plan_id: OpaqueIdSchema,
    query_id: QueryIdSchema,
    steps: Type.Array(QueryPlanStepSchema, { minItems: 1, maxItems: 32 }),
    max_ast_depth: Type.Integer({ minimum: 1, maximum: 32 }),
    max_ast_nodes: Type.Integer({ minimum: 1, maximum: 256 }),
    plan_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_QUERY_PLAN_V2_SCHEMA }
);
export type ScaP03QueryPlanV2 = Readonly<Static<typeof ScaP03QueryPlanV2Schema>>;

const QuerySetEntrySchema = Type.Object(
  {
    query_id: QueryIdSchema,
    script_ref: ArtifactRefSchema,
    script_sha256: Sha256Schema,
    plan_ref: ArtifactRefSchema,
    plan_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaP03BaselineQuerySetV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_BASELINE_QUERY_SET_V2_SCHEMA),
    schema_version: Type.Literal(2),
    query_set_id: OpaqueIdSchema,
    release_id: OpaqueIdSchema,
    ordered_queries: Type.Array(QuerySetEntrySchema, { minItems: 7, maxItems: 7 }),
    native_query_authorized: Type.Literal(false),
    query_set_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_BASELINE_QUERY_SET_V2_SCHEMA }
);
export type ScaP03BaselineQuerySetV2 = Readonly<Static<typeof ScaP03BaselineQuerySetV2Schema>>;

const OperationCommon = {
  schema_version: Type.Literal(1),
  tenant_id: OpaqueIdSchema,
  project_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  phase_id: Type.Literal("SCA-P03"),
  operation_id: OpaqueIdSchema,
  p01_binding_sha256: Sha256Schema,
  p02_binding_sha256: Sha256Schema,
  p03_runtime_binding_sha256: Sha256Schema,
  source_snapshot_ref: ArtifactRefSchema,
  source_snapshot_sha256: Sha256Schema,
  p03_request_ref: ArtifactRefSchema,
  backend_resource_sha256: Type.Optional(Sha256Schema),
  runtime_policy_ref: ArtifactRefSchema,
  joern_runtime_identity_ref: ArtifactRefSchema,
  isolation_evidence_ref: ArtifactRefSchema,
  host_isolation_attestation_ref: NullableArtifactRefSchema,
  implementation_identity_ref: ArtifactRefSchema,
  qualification_profile_ref: ArtifactRefSchema,
  baseline_query_set_ref: ArtifactRefSchema,
  runtime_id: OpaqueIdSchema,
  runtime_kind: RuntimeKindSchema,
  qualification_scope: QualificationScopeSchema,
  runtime_tree_sha256: Sha256Schema,
  isolation_id: OpaqueIdSchema,
  isolation_profile_sha256: Sha256Schema,
  request_sha256: Sha256Schema,
} as const;

export const ScaP03QualificationRequestV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUALIFICATION_REQUEST_V2_SCHEMA),
    ...OperationCommon,
    schema_version: Type.Literal(2),
    operation_id: Type.Literal(SCA_P03_OPERATION_IDS.qualify),
    operation_kind: Type.Literal("qualify_joern"),
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    fixture_corpus_ref: ArtifactRefSchema,
    fixture_content_refs: Type.Array(ArtifactRefSchema, { minItems: 3, maxItems: 256 }),
    query_script_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    query_plan_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
  },
  { additionalProperties: false, $id: SCA_P03_QUALIFICATION_REQUEST_V2_SCHEMA }
);
export type ScaP03QualificationRequestV2 = Readonly<
  Static<typeof ScaP03QualificationRequestV2Schema>
>;

const ExpectedFileSchema = Type.Object(
  {
    path: RepositoryPathSchema,
    content_sha256: Sha256Schema,
    role: Type.Union([Type.Literal("primary"), Type.Literal("contextual")]),
  },
  { additionalProperties: false }
);

export const ScaP03GraphBuildRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA),
    ...OperationCommon,
    operation_kind: Type.Literal("build_source_graph"),
    partition: PartitionSchema,
    frontend_language: Type.Union([Type.Literal("PHP"), Type.Literal("JSSRC")]),
    source_file_manifest_ref: ArtifactRefSchema,
    source_custody_ref: ArtifactRefSchema,
    expected_files: Type.Array(ExpectedFileSchema, { minItems: 1, maxItems: MAX_FILES }),
    max_num_def: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    max_graph_bytes: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_GRAPH_BYTES }),
  },
  { additionalProperties: false, $id: SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA }
);
export type ScaP03GraphBuildRequestV1 = Readonly<Static<typeof ScaP03GraphBuildRequestV1Schema>>;

export const ScaP03BaselineQueryBatchRequestV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA),
    ...OperationCommon,
    schema_version: Type.Literal(2),
    operation_kind: Type.Literal("run_baseline_query_batch"),
    partition: PartitionSchema,
    graph_component_ref: ArtifactRefSchema,
    graph_component_sha256: Sha256Schema,
    graph_build_request_ref: ArtifactRefSchema,
    graph_build_result_ref: ArtifactRefSchema,
    ordered_query_ids: Type.Array(QueryIdSchema, { minItems: 7, maxItems: 7 }),
    fidelity_requirements: Type.Array(FidelityRequirementSchema, { minItems: 1, maxItems: 256 }),
    query_script_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    query_plan_refs: Type.Array(ArtifactRefSchema, { minItems: 7, maxItems: 7 }),
    max_query_output_bytes: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_OUTPUT_BYTES }),
    max_query_items: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_ITEMS }),
    max_page_items: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_PAGE_ITEMS }),
    max_pages_per_query: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_PAGES_PER_QUERY }),
  },
  { additionalProperties: false, $id: SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA }
);
export type ScaP03BaselineQueryBatchRequestV2 = Readonly<
  Static<typeof ScaP03BaselineQueryBatchRequestV2Schema>
>;

export type ScaP03OperationRequestV1 =
  | ScaP03QualificationRequestV2
  | ScaP03GraphBuildRequestV1
  | ScaP03BaselineQueryBatchRequestV2;
export type ScaP03OperationKind = ScaP03OperationRequestV1["operation_kind"];

const OperationResultCommon = {
  schema_version: Type.Literal(1),
  tenant_id: OpaqueIdSchema,
  project_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  phase_id: Type.Literal("SCA-P03"),
  operation_id: OpaqueIdSchema,
  request_sha256: Sha256Schema,
  p01_binding_sha256: Sha256Schema,
  p02_binding_sha256: Sha256Schema,
  p03_runtime_binding_sha256: Sha256Schema,
  source_snapshot_ref: ArtifactRefSchema,
  source_snapshot_sha256: Sha256Schema,
  runtime_id: OpaqueIdSchema,
  runtime_kind: RuntimeKindSchema,
  qualification_scope: QualificationScopeSchema,
  runtime_tree_sha256: Sha256Schema,
  isolation_id: OpaqueIdSchema,
  isolation_profile_sha256: Sha256Schema,
  status: Type.Union([
    Type.Literal("complete"),
    Type.Literal("blocked"),
    Type.Literal("partial"),
    Type.Literal("truncated"),
    Type.Literal("cancelled"),
  ]),
  blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
  completed_at: Rfc3339UtcSchema,
  result_sha256: Sha256Schema,
} as const;

// Public, content-free diagnoses for fixture qualification. Never serialize exception messages or stdout.
export const ScaP03QualificationBlockerCodeV2Schema = Type.Union([
  Type.Literal("joern_runtime_unavailable"),
  Type.Literal("joern_qualification_failed"),
  Type.Literal("operation_timeout"),
  Type.Literal("p03_qualification_runtime_failed"),
  Type.Literal("p03_fixture_parse_failed"),
  Type.Literal("p03_fixture_inventory_failed"),
  Type.Literal("p03_graph_frontend_mismatch"),
  Type.Literal("p03_fixture_not_in_graph"),
  Type.Literal("p03_fixture_nodes_absent"),
  Type.Literal("p03_fixture_observations_absent"),
  Type.Literal("p03_oracle_assertion_mismatch"),
  Type.Literal("p03_inventory_invalid"),
  Type.Literal("p03_inventory_encoding"),
  Type.Literal("p03_inventory_graph_invalid"),
  Type.Literal("p03_inventory_limit"),
  Type.Literal("p03_fixture_custody_invalid"),
  Type.Literal("p03_query_release_invalid"),
  Type.Literal("p03_query_binding_invalid"),
  Type.Literal("p03_query_semantics_unsupported"),
  Type.Literal("p03_plan_unsupported"),
  Type.Literal("p03_plan_unbounded"),
  Type.Literal("p03_trace_invalid"),
  Type.Literal("p03_graph_edge_invalid"),
  Type.Literal("p03_query_limit_reached"),
  Type.Literal("p03_traversal_limit_reached"),
  Type.Literal("p03_output_invalid"),
  Type.Literal("p03_output_encoding_invalid"),
  Type.Literal("p03_workspace_limit"),
  Type.Literal("docker_timeout"),
  Type.Literal("docker_output_limit"),
]);
export type ScaP03QualificationBlockerCodeV2 = Static<
  typeof ScaP03QualificationBlockerCodeV2Schema
>;

export const ScaP03QualificationCaseV2Schema = Type.Object(
  {
    case_id: OpaqueIdSchema,
    language: Type.Union([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    query_id: QueryIdSchema,
    frontend_language: Type.Union([Type.Literal("PHP"), Type.Literal("JSSRC")]),
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("blocked")]),
    blocker_code: Type.Union([ScaP03QualificationBlockerCodeV2Schema, Type.Null()]),
    fixture_id: Type.Union([OpaqueIdSchema, Type.Null()]),
    fixture_sha256: Type.Union([Sha256Schema, Type.Null()]),
    observation_count: Type.Integer({
      minimum: 0,
      maximum: SCA_P03_MAX_QUALIFICATION_OBSERVATIONS,
    }),
    observations: Type.Array(ScaP03QueryCandidateV2Schema, {
      maxItems: SCA_P03_MAX_QUALIFICATION_OBSERVATIONS,
    }),
    observed_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP03QualificationCaseV2 = Readonly<Static<typeof ScaP03QualificationCaseV2Schema>>;

export const ScaP03QualificationResultV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUALIFICATION_RESULT_V2_SCHEMA),
    ...OperationResultCommon,
    schema_version: Type.Literal(2),
    operation_id: Type.Literal(SCA_P03_OPERATION_IDS.qualify),
    operation_kind: Type.Literal("qualify_joern"),
    qualified: Type.Boolean(),
    executed_query_release_sha256: Type.Union([Sha256Schema, Type.Null()]),
    cases: Type.Array(ScaP03QualificationCaseV2Schema, { minItems: 21, maxItems: 21 }),
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    parser_identity_sha256: Type.Union([Sha256Schema, Type.Null()]),
    fixture_corpus_ref: ArtifactRefSchema,
    baseline_query_set_ref: ArtifactRefSchema,
  },
  { additionalProperties: false, $id: SCA_P03_QUALIFICATION_RESULT_V2_SCHEMA }
);
export type ScaP03QualificationResultV2 = Readonly<
  Static<typeof ScaP03QualificationResultV2Schema>
>;

const GraphDescriptorSchema = Type.Object(
  {
    media_type: Type.Literal("application/vnd.penny.joern-cpg"),
    content_schema_id: Type.Literal(SCA_P03_GRAPH_COMPONENT_V1_SCHEMA),
    byte_length: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_GRAPH_BYTES }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const AccountedFileSchema = Type.Object(
  {
    path: RepositoryPathSchema,
    content_sha256: Sha256Schema,
    disposition: Type.Union([
      Type.Literal("parsed"),
      Type.Literal("contextual"),
      Type.Literal("unsupported"),
      Type.Literal("failed"),
    ]),
    reason_code: Type.Union([BlockerCodeSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

const GraphCleanupEvidenceSchema = Type.Object(
  {
    workspace_removed: Type.Boolean(),
    graph_handles_closed: Type.Boolean(),
    process_exit_observed: Type.Boolean(),
    cleanup_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP03GraphCleanupEvidenceV1 = Readonly<Static<typeof GraphCleanupEvidenceSchema>>;

export const ScaP03GraphBuildResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA),
    ...OperationResultCommon,
    operation_kind: Type.Literal("build_source_graph"),
    partition: PartitionSchema,
    frontend_language: Type.Union([Type.Literal("PHP"), Type.Literal("JSSRC")]),
    graph: Type.Union([GraphDescriptorSchema, Type.Null()]),
    graph_build_key_sha256: Sha256Schema,
    graph_id: Type.Union([OpaqueIdSchema, Type.Null()]),
    accounted_files: Type.Array(AccountedFileSchema, { minItems: 1, maxItems: MAX_FILES }),
    graph_opened: Type.Boolean(),
    cleanup_status: Type.Union([Type.Literal("proven"), Type.Literal("unproven")]),
    cleanup_evidence: GraphCleanupEvidenceSchema,
    complete: Type.Boolean(),
  },
  { additionalProperties: false, $id: SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA }
);
export type ScaP03GraphBuildResultV1 = Readonly<Static<typeof ScaP03GraphBuildResultV1Schema>>;

export const ScaP03BaselineQueryPageV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA),
    schema_version: Type.Literal(2),
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P03"),
    partition: PartitionSchema,
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    graph_component_ref: ArtifactRefSchema,
    graph_component_sha256: Sha256Schema,
    baseline_query_set_ref: ArtifactRefSchema,
    query_release_sha256: Sha256Schema,
    accounted_paths: Type.Array(RepositoryPathSchema, { minItems: 1, maxItems: MAX_FILES }),
    query_id: QueryIdSchema,
    page_number: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_PAGES_PER_QUERY }),
    items: Type.Array(ScaP03QueryCandidateV2Schema, { maxItems: SCA_P03_MAX_PAGE_ITEMS }),
    item_count: Type.Integer({ minimum: 0, maximum: SCA_P03_MAX_PAGE_ITEMS }),
    complete: Type.Boolean(),
    page_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA }
);
export type ScaP03BaselineQueryPageV2 = Readonly<Static<typeof ScaP03BaselineQueryPageV2Schema>>;

const QueryPageDescriptorSchema = Type.Object(
  {
    query_id: QueryIdSchema,
    page_number: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_PAGES_PER_QUERY }),
    item_count: Type.Integer({ minimum: 0, maximum: SCA_P03_MAX_PAGE_ITEMS }),
    byte_length: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_OUTPUT_BYTES }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const QueryFooterSchema = Type.Object(
  {
    query_id: QueryIdSchema,
    item_count: Type.Integer({ minimum: 0, maximum: SCA_P03_MAX_QUERY_ITEMS }),
    byte_count: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_QUERY_OUTPUT_BYTES }),
    page_count: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_PAGES_PER_QUERY }),
    complete: Type.Boolean(),
  },
  { additionalProperties: false }
);

const FidelityObservationSchema = Type.Object(
  {
    requirement_id: OpaqueIdSchema,
    support: Type.Union([
      Type.Literal("supported"),
      Type.Literal("partial"),
      Type.Literal("unsupported"),
    ]),
    reason_code: Type.Union([BlockerCodeSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ScaP03FidelityObservationV2 = Readonly<Static<typeof FidelityObservationSchema>>;

export const ScaP03BaselineQueryBatchResultV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA),
    ...OperationResultCommon,
    schema_version: Type.Literal(2),
    operation_kind: Type.Literal("run_baseline_query_batch"),
    partition: PartitionSchema,
    graph_component_ref: ArtifactRefSchema,
    graph_component_sha256: Sha256Schema,
    graph_build_result_ref: ArtifactRefSchema,
    baseline_query_set_ref: ArtifactRefSchema,
    executed_query_release_sha256: Type.Union([Sha256Schema, Type.Null()]),
    page_descriptors: Type.Array(QueryPageDescriptorSchema, { maxItems: SCA_P03_MAX_QUERY_PAGES }),
    query_footers: Type.Array(QueryFooterSchema, { maxItems: SCA_P03_QUERY_IDS.length }),
    fidelity_observations: Type.Array(FidelityObservationSchema, { maxItems: 256 }),
    complete: Type.Boolean(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false, $id: SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA }
);
export type ScaP03BaselineQueryBatchResultV2 = Readonly<
  Static<typeof ScaP03BaselineQueryBatchResultV2Schema>
>;

export type ScaP03OperationResultV1 =
  | ScaP03QualificationResultV2
  | ScaP03GraphBuildResultV1
  | ScaP03BaselineQueryBatchResultV2;

const BoundCommon = {
  tenant_id: OpaqueIdSchema,
  project_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  phase_id: Type.Literal("SCA-P03"),
  p01_binding_sha256: Sha256Schema,
  p02_binding_sha256: Sha256Schema,
  p03_runtime_binding_sha256: Sha256Schema,
  source_snapshot_ref: ArtifactRefSchema,
  source_snapshot_sha256: Sha256Schema,
} as const;

export const ScaP03EntryAdmissionV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_ENTRY_ADMISSION_V2_SCHEMA),
    schema_version: Type.Literal(2),
    ...BoundCommon,
    p03_request_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    p02_transition_ref: ArtifactRefSchema,
    p02_m1_ref: ArtifactRefSchema,
    p01_manifest_ref: ArtifactRefSchema,
    admitted_at: Rfc3339UtcSchema,
    admission_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_ENTRY_ADMISSION_V2_SCHEMA }
);
export type ScaP03EntryAdmissionV2 = Readonly<Static<typeof ScaP03EntryAdmissionV2Schema>>;

export const ScaP03GraphProvenanceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_GRAPH_PROVENANCE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    ...BoundCommon,
    partition: PartitionSchema,
    frontend_language: Type.Union([Type.Literal("PHP"), Type.Literal("JSSRC")]),
    graph_component_ref: ArtifactRefSchema,
    graph_build_request_ref: ArtifactRefSchema,
    graph_build_result_ref: ArtifactRefSchema,
    runtime_tree_sha256: Sha256Schema,
    graph_build_key_sha256: Sha256Schema,
    graph_id: OpaqueIdSchema,
    expected_files: Type.Array(ExpectedFileSchema, { minItems: 1, maxItems: MAX_FILES }),
    accounted_files: Type.Array(AccountedFileSchema, { minItems: 1, maxItems: MAX_FILES }),
    graph_opened: Type.Literal(true),
    cleanup_status: Type.Literal("proven"),
    provenance_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_GRAPH_PROVENANCE_V1_SCHEMA }
);
export type ScaP03GraphProvenanceV1 = Readonly<Static<typeof ScaP03GraphProvenanceV1Schema>>;

const GraphManifestEntrySchema = Type.Object(
  {
    partition: PartitionSchema,
    graph_component_ref: NullableArtifactRefSchema,
    graph_build_result_ref: ArtifactRefSchema,
    graph_provenance_ref: NullableArtifactRefSchema,
    graph_id: Type.Union([OpaqueIdSchema, Type.Null()]),
    status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("blocked"),
    ]),
  },
  { additionalProperties: false }
);

export const ScaP03GraphManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_GRAPH_MANIFEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    ...BoundCommon,
    components: Type.Array(GraphManifestEntrySchema, { minItems: 2, maxItems: 2 }),
    complete: Type.Boolean(),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_GRAPH_MANIFEST_V1_SCHEMA }
);
export type ScaP03GraphManifestV1 = Readonly<Static<typeof ScaP03GraphManifestV1Schema>>;

const GraphSupportEntrySchema = Type.Object(
  {
    requirement_id: OpaqueIdSchema,
    dimension: FidelityDimensionSchema,
    subject: Type.String({ minLength: 1, maxLength: 256 }),
    partition: PartitionSchema,
    materiality: Type.Union([Type.Literal("material"), Type.Literal("non_material")]),
    support: Type.Union([
      Type.Literal("supported"),
      Type.Literal("partial"),
      Type.Literal("unsupported"),
      Type.Literal("complemented"),
    ]),
    material_gap: Type.Boolean(),
    qualification_scope: QualificationScopeSchema,
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    graph_component_ref: NullableArtifactRefSchema,
    complement_evidence_ref: NullableArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false }
);
export type ScaP03GraphSupportEntryV1 = Readonly<Static<typeof GraphSupportEntrySchema>>;

export const ScaP03GraphSupportMatrixV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_GRAPH_SUPPORT_MATRIX_V2_SCHEMA),
    schema_version: Type.Literal(2),
    ...BoundCommon,
    profile_ref: ArtifactRefSchema,
    entries: Type.Array(GraphSupportEntrySchema, { minItems: 6, maxItems: 256 }),
    complete: Type.Boolean(),
    matrix_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_GRAPH_SUPPORT_MATRIX_V2_SCHEMA }
);
export type ScaP03GraphSupportMatrixV2 = Readonly<Static<typeof ScaP03GraphSupportMatrixV2Schema>>;

const BaselineAggregateEntrySchema = Type.Object(
  {
    partition: PartitionSchema,
    graph_component_ref: ArtifactRefSchema,
    query_batch_request_ref: ArtifactRefSchema,
    query_batch_result_ref: ArtifactRefSchema,
    page_refs: Type.Array(ArtifactRefSchema, {
      minItems: SCA_P03_QUERY_IDS.length,
      maxItems: SCA_P03_MAX_QUERY_PAGES,
    }),
    ordered_query_ids: Type.Array(QueryIdSchema, {
      minItems: SCA_P03_QUERY_IDS.length,
      maxItems: SCA_P03_QUERY_IDS.length,
    }),
    complete: Type.Boolean(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const ScaP03BaselineQueryAggregateV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_BASELINE_QUERY_AGGREGATE_V2_SCHEMA),
    schema_version: Type.Literal(2),
    ...BoundCommon,
    baseline_query_set_ref: ArtifactRefSchema,
    batches: Type.Array(BaselineAggregateEntrySchema, { maxItems: 2 }),
    complete: Type.Boolean(),
    aggregate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_BASELINE_QUERY_AGGREGATE_V2_SCHEMA }
);
export type ScaP03BaselineQueryAggregateV2 = Readonly<
  Static<typeof ScaP03BaselineQueryAggregateV2Schema>
>;

const PacketCandidateSchema = Type.Object(
  {
    ...ScaP03QueryCandidateV2Schema.properties,
    partition: PartitionSchema,
    accounted_paths: Type.Array(RepositoryPathSchema, { minItems: 1, maxItems: MAX_FILES }),
    graph_component_ref: ArtifactRefSchema,
    page_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);

export const ScaP03GraphCandidatePacketV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_GRAPH_CANDIDATE_PACKET_V2_SCHEMA),
    schema_version: Type.Literal(2),
    ...BoundCommon,
    baseline_query_set_ref: ArtifactRefSchema,
    graph_manifest_ref: ArtifactRefSchema,
    candidates: Type.Array(PacketCandidateSchema, { maxItems: SCA_P03_MAX_QUERY_ITEMS }),
    complete: Type.Boolean(),
    source_bound: Type.Boolean(),
    packet_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_GRAPH_CANDIDATE_PACKET_V2_SCHEMA }
);
export type ScaP03GraphCandidatePacketV2 = Readonly<
  Static<typeof ScaP03GraphCandidatePacketV2Schema>
>;

const CoverageEntrySchema = Type.Object(
  {
    coverage_id: Type.String({ minLength: 3, maxLength: 128 }),
    status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("blocked"),
    ]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false }
);

export const ScaP03CoverageMatrixV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_COVERAGE_MATRIX_V1_SCHEMA),
    schema_version: Type.Literal(1),
    ...BoundCommon,
    entries: Type.Array(CoverageEntrySchema, {
      minItems: SCA_P03_COVERAGE_IDS.length,
      maxItems: SCA_P03_COVERAGE_IDS.length,
    }),
    coverage_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_COVERAGE_MATRIX_V1_SCHEMA }
);
export type ScaP03CoverageMatrixV1 = Readonly<Static<typeof ScaP03CoverageMatrixV1Schema>>;

const OperationLogEntrySchema = Type.Object(
  {
    operation_id: OpaqueIdSchema,
    operation_kind: Type.Union([
      Type.Literal("qualify_joern"),
      Type.Literal("build_source_graph"),
      Type.Literal("run_baseline_query_batch"),
    ]),
    request_ref: ArtifactRefSchema,
    result_ref: ArtifactRefSchema,
    receipt_ref: ArtifactRefSchema,
    output_refs: Type.Array(ArtifactRefSchema, { maxItems: SCA_P03_MAX_QUERY_PAGES }),
    status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("blocked"),
      Type.Literal("partial"),
      Type.Literal("truncated"),
      Type.Literal("cancelled"),
    ]),
  },
  { additionalProperties: false }
);

export const ScaP03OperationLogV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_OPERATION_LOG_V1_SCHEMA),
    schema_version: Type.Literal(1),
    ...BoundCommon,
    operations: Type.Array(OperationLogEntrySchema, { minItems: 3, maxItems: 5 }),
    log_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_OPERATION_LOG_V1_SCHEMA }
);
export type ScaP03OperationLogV1 = Readonly<Static<typeof ScaP03OperationLogV1Schema>>;

export const ScaP03QualificationEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    ...BoundCommon,
    qualification_request_ref: ArtifactRefSchema,
    qualification_result_ref: ArtifactRefSchema,
    operation_receipt_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    parser_identity_sha256: Type.Union([Sha256Schema, Type.Null()]),
    qualification_scope: QualificationScopeSchema,
    qualified: Type.Boolean(),
    evidence_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA }
);
export type ScaP03QualificationEvidenceV1 = Readonly<
  Static<typeof ScaP03QualificationEvidenceV1Schema>
>;

export const ScaP03QualificationRecordV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_QUALIFICATION_RECORD_V2_SCHEMA),
    schema_version: Type.Literal(2),
    ...BoundCommon,
    implementation_identity_ref: ArtifactRefSchema,
    joern_runtime_identity_ref: ArtifactRefSchema,
    isolation_evidence_ref: ArtifactRefSchema,
    host_isolation_attestation_ref: NullableArtifactRefSchema,
    qualification_profile_ref: ArtifactRefSchema,
    fixture_corpus_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    parser_identity_sha256: Type.Union([Sha256Schema, Type.Null()]),
    baseline_query_set_ref: ArtifactRefSchema,
    qualification_evidence_ref: ArtifactRefSchema,
    operation_log_ref: ArtifactRefSchema,
    review_identity: OpaqueIdSchema,
    status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    live_qualified: Type.Boolean(),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    record_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_QUALIFICATION_RECORD_V2_SCHEMA }
);
export type ScaP03QualificationRecordV2 = Readonly<
  Static<typeof ScaP03QualificationRecordV2Schema>
>;

export const ScaP03ZeroModelEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_ZERO_MODEL_EVIDENCE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    ...BoundCommon,
    registration_sha256: Sha256Schema,
    worker_kind: Type.Literal("none"),
    worker_phase_count: Type.Literal(0),
    invoke_agent_directives: Type.Literal(0),
    child_workflow_directives: Type.Literal(0),
    provider_calls: Type.Literal(0),
    model_calls: Type.Literal(0),
    model_turns: Type.Literal(0),
    passed: Type.Literal(true),
    evidence_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_ZERO_MODEL_EVIDENCE_V1_SCHEMA }
);
export type ScaP03ZeroModelEvidenceV1 = Readonly<Static<typeof ScaP03ZeroModelEvidenceV1Schema>>;

const EvidenceManifestOperationSchema = Type.Object(
  {
    operation_id: OpaqueIdSchema,
    request_ref: ArtifactRefSchema,
    result_ref: ArtifactRefSchema,
    receipt_ref: ArtifactRefSchema,
    output_refs: Type.Array(ArtifactRefSchema, { maxItems: SCA_P03_MAX_QUERY_PAGES }),
  },
  { additionalProperties: false }
);

export const ScaP03EvidenceManifestV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_EVIDENCE_MANIFEST_V2_SCHEMA),
    schema_version: Type.Literal(2),
    ...BoundCommon,
    p03_request_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    entry_admission_ref: ArtifactRefSchema,
    qualification_record_ref: ArtifactRefSchema,
    graph_manifest_ref: ArtifactRefSchema,
    graph_support_matrix_ref: ArtifactRefSchema,
    baseline_query_aggregate_ref: ArtifactRefSchema,
    candidate_packet_ref: ArtifactRefSchema,
    coverage_matrix_ref: ArtifactRefSchema,
    zero_model_evidence_ref: ArtifactRefSchema,
    operation_log_ref: ArtifactRefSchema,
    operations: Type.Array(EvidenceManifestOperationSchema, { minItems: 3, maxItems: 5 }),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_EVIDENCE_MANIFEST_V2_SCHEMA }
);
export type ScaP03EvidenceManifestV2 = Readonly<Static<typeof ScaP03EvidenceManifestV2Schema>>;

const LedgerDispositionSchema = Type.Object(
  {
    obligation_id: Type.Union([
      Type.Literal("SCA-OBL-P03-ACCEPTANCE"),
      Type.Literal("SCA-OBL-OUTPUT-SOURCE-BOUND-GRAPH"),
      Type.Literal("SCA-OBL-OUTPUT-BASELINE-GRAPH-QUERIES"),
      Type.Literal("SCA-OBL-OUTPUT-GRAPH-CANDIDATES"),
    ]),
    status: Type.Union([Type.Literal("satisfied"), Type.Literal("blocked")]),
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128 }),
  },
  { additionalProperties: false }
);

export const ScaP03SuccessorLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_SUCCESSOR_LEDGER_V1_SCHEMA),
    schema_version: Type.Literal(1),
    ...BoundCommon,
    prior_p02_ledger_ref: ArtifactRefSchema,
    prior_p02_ledger_sha256: Sha256Schema,
    dispositions: Type.Array(LedgerDispositionSchema, { minItems: 4, maxItems: 4 }),
    pending_phase_ids: Type.Tuple([
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
  { additionalProperties: false, $id: SCA_P03_SUCCESSOR_LEDGER_V1_SCHEMA }
);
export type ScaP03SuccessorLedgerV1 = Readonly<Static<typeof ScaP03SuccessorLedgerV1Schema>>;

export const ScaP03GateV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_GATE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    ...BoundCommon,
    p03_request_ref: ArtifactRefSchema,
    entry_admission_ref: ArtifactRefSchema,
    qualification_record_ref: ArtifactRefSchema,
    graph_manifest_ref: ArtifactRefSchema,
    graph_support_matrix_ref: ArtifactRefSchema,
    baseline_query_aggregate_ref: ArtifactRefSchema,
    candidate_packet_ref: ArtifactRefSchema,
    coverage_matrix_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    zero_model_evidence_ref: ArtifactRefSchema,
    isolation_scope: QualificationScopeSchema,
    status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_GATE_V1_SCHEMA }
);
export type ScaP03GateV1 = Readonly<Static<typeof ScaP03GateV1Schema>>;

export const ScaP03P04TransitionV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_P04_TRANSITION_V2_SCHEMA),
    schema_version: Type.Literal(2),
    ...BoundCommon,
    from_phase_id: Type.Literal("SCA-P03"),
    to_phase_id: Type.Literal("SCA-P04"),
    p03_request_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    p02_m1_ref: ArtifactRefSchema,
    p02_evidence_manifest_ref: ArtifactRefSchema,
    entry_admission_ref: ArtifactRefSchema,
    qualification_record_ref: ArtifactRefSchema,
    graph_manifest_ref: ArtifactRefSchema,
    graph_support_matrix_ref: ArtifactRefSchema,
    baseline_query_aggregate_ref: ArtifactRefSchema,
    candidate_packet_ref: ArtifactRefSchema,
    coverage_matrix_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    zero_model_evidence_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    p04_entry_authorized: Type.Literal(true),
    campaign_terminal: Type.Literal(false),
    release_eligible: Type.Literal(false),
    transitioned_at: Rfc3339UtcSchema,
    transition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_P04_TRANSITION_V2_SCHEMA }
);
export type ScaP03P04TransitionV2 = Readonly<Static<typeof ScaP03P04TransitionV2Schema>>;

export const ScaP03TerminalV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_TERMINAL_V2_SCHEMA),
    schema_version: Type.Literal(2),
    phase_id: Type.Literal("SCA-P03"),
    boundary: Type.Union([Type.Literal("p04"), Type.Literal("blocked_at_p03")]),
    gate_status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    p03_request_ref: ArtifactRefSchema,
    source_oracle_ref: ArtifactRefSchema,
    source_oracle_validation_ref: ArtifactRefSchema,
    graph_manifest_ref: ArtifactRefSchema,
    baseline_query_aggregate_ref: ArtifactRefSchema,
    candidate_packet_ref: ArtifactRefSchema,
    coverage_matrix_ref: ArtifactRefSchema,
    evidence_manifest_ref: ArtifactRefSchema,
    successor_ledger_ref: ArtifactRefSchema,
    gate_ref: ArtifactRefSchema,
    transition_ref: NullableArtifactRefSchema,
    blocker_codes: Type.Array(BlockerCodeSchema, { maxItems: 128 }),
    campaign_terminal: Type.Literal(false),
    release_eligible: Type.Literal(false),
    model_calls: Type.Literal(0),
    model_turns: Type.Literal(0),
  },
  { additionalProperties: false, $id: SCA_P03_TERMINAL_V2_SCHEMA }
);
export type ScaP03TerminalV2 = Readonly<Static<typeof ScaP03TerminalV2Schema>>;

export class ScaP03ContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScaP03ContractError";
  }
}

function parse<TSchemaValue extends TSchema>(schema: TSchemaValue, value: unknown, label: string) {
  try {
    return validateContract(schema, value, label);
  } catch (error) {
    throw new ScaP03ContractError(error instanceof Error ? error.message : `${label} is invalid`, {
      cause: error,
    });
  }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new ScaP03ContractError(`${label} must be unique`);
  }
}

function assertExactOrder(observed: readonly string[], expected: readonly string[], label: string) {
  if (!same(observed, expected)) {
    throw new ScaP03ContractError(`${label} must equal the exact ordered set`);
  }
}

function assertRepositoryPath(value: string, label: string): void {
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ScaP03ContractError(`${label} must be a normalized repository-relative path`);
  }
}

function assertSelfDigest(value: Readonly<Record<string, unknown>>, field: string, label: string) {
  const observed = value[field];
  if (typeof observed !== "string") throw new ScaP03ContractError(`${label} lacks ${field}`);
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  if (observed !== sha256(canonicalJson(unsigned))) {
    throw new ScaP03ContractError(`${label} ${field} diverges from canonical content`);
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScaP03ContractError("digest-bearing artifact is not an object");
  }
  return Object.fromEntries(Object.entries(value));
}

export function withScaP03Digest<T extends Readonly<Record<string, unknown>>>(
  value: T,
  field: string
): T & Readonly<Record<string, string>> {
  return { ...value, [field]: sha256(canonicalJson(value)) };
}

export function scaP03P01BindingSha256(request: Pick<ScaP03RequestV2, "accepted_p01">): string {
  return sha256(canonicalJson(request.accepted_p01));
}

export function scaP03P02BindingSha256(request: {
  readonly accepted_p02: Pick<
    ScaP03RequestV2["accepted_p02"],
    | "transition_ref"
    | "p02_request_ref"
    | "gate_ref"
    | "m1_ref"
    | "coverage_matrix_ref"
    | "evidence_manifest_ref"
    | "successor_ledger_ref"
    | "evidence_refs"
  >;
}): string {
  return sha256(canonicalJson(request.accepted_p02));
}

export function scaP03RuntimeBindingSha256(
  request: Pick<
    ScaP03RequestV2,
    | "runtime_policy_ref"
    | "joern_runtime_identity_ref"
    | "isolation_evidence_ref"
    | "host_isolation_attestation_ref"
    | "implementation_identity_ref"
    | "qualification_profile_ref"
    | "fixture_corpus_ref"
    | "source_oracle_ref"
    | "source_oracle_validation_ref"
    | "baseline_query_set_ref"
  >
): string {
  return sha256(
    canonicalJson({
      runtime_policy_ref: request.runtime_policy_ref,
      joern_runtime_identity_ref: request.joern_runtime_identity_ref,
      isolation_evidence_ref: request.isolation_evidence_ref,
      host_isolation_attestation_ref: request.host_isolation_attestation_ref,
      implementation_identity_ref: request.implementation_identity_ref,
      qualification_profile_ref: request.qualification_profile_ref,
      fixture_corpus_ref: request.fixture_corpus_ref,
      source_oracle_ref: request.source_oracle_ref,
      source_oracle_validation_ref: request.source_oracle_validation_ref,
      baseline_query_set_ref: request.baseline_query_set_ref,
    })
  );
}

export function validateScaP03RequestV2(value: unknown): ScaP03RequestV2 {
  const request = parse(ScaP03RequestV2Schema, value, "SCA P03 request");
  for (const [ref, kind, schema, version] of [
    [
      request.accepted_p02.qualification_definition_ref,
      "sca-p02-v3-definition-snapshot",
      "penny.sca-p02-v3-definition-snapshot.v1",
      1,
    ],
    [
      request.accepted_p02.qualification_gate_ref,
      "sca-p02-phase-gate-v3",
      "penny.sca-phase-gate-record.v3",
      3,
    ],
  ] as const) {
    if (
      ref.kind !== kind ||
      ref.content_schema?.schema_id !== schema ||
      ref.content_schema.schema_version !== version ||
      ref.producer !== "host:sca-p02-qualification-authority" ||
      ref.media_type !== "application/json" ||
      ref.phase !== "SCA-P02"
    ) {
      throw new ScaP03ContractError("SCA P03 P02 qualification ref contract mismatch");
    }
  }
  if (request.bootstrap_verification !== undefined) {
    const binding = request.bootstrap_verification;
    if (
      binding.sealed_inputs_ref.kind !== "sca-p03-sealed-bootstrap-inputs" ||
      binding.sealed_inputs_ref.producer !== "host:sca-p03-initial-authorization" ||
      binding.sealed_inputs_ref.content_schema?.schema_id !==
        "penny.sca-p03-sealed-bootstrap-inputs.v1" ||
      binding.input_refs.some(
        (ref, i) => i > 0 && ref.artifact_id <= (binding.input_refs[i - 1]?.artifact_id ?? "")
      )
    )
      throw new ScaP03ContractError("SCA P03 sealed verification operands invalid");
  }
  assertSelfDigest(asRecord(request), "request_sha256", "SCA P03 request");
  if (request.source_snapshot_sha256 !== request.source_snapshot_ref.content_digest) {
    throw new ScaP03ContractError("SCA P03 request source snapshot digest is stale");
  }
  if (
    request.p01_binding_sha256 !== scaP03P01BindingSha256(request) ||
    request.p02_binding_sha256 !== scaP03P02BindingSha256(request) ||
    request.p03_runtime_binding_sha256 !== scaP03RuntimeBindingSha256(request)
  ) {
    throw new ScaP03ContractError("SCA P03 request lineage or runtime binding diverges");
  }
  assertUnique(
    request.fixture_content_refs.map((ref) => canonicalJson(ref)),
    "fixture refs"
  );
  assertUnique(
    request.runtime_package_refs.map((ref) => canonicalJson(ref)),
    "runtime package refs"
  );
  assertUnique(
    request.fidelity_complement_refs.map((ref) => canonicalJson(ref)),
    "fidelity complement refs"
  );
  assertUnique(
    request.query_script_refs.map((ref) => canonicalJson(ref)),
    "query script refs"
  );
  assertUnique(
    request.query_plan_refs.map((ref) => canonicalJson(ref)),
    "query plan refs"
  );
  return request;
}

export const validateScaP03RuntimePolicyV1 = (value: unknown): ScaP03RuntimePolicyV1 =>
  parse(ScaP03RuntimePolicyV1Schema, value, "SCA P03 runtime policy");

export function validateScaP03JoernRuntimeIdentityV1(value: unknown): ScaP03JoernRuntimeIdentityV1 {
  const identity = parse(
    ScaP03JoernRuntimeIdentityV1Schema,
    value,
    "SCA P03 Joern runtime identity"
  );
  assertSelfDigest(asRecord(identity), "identity_sha256", "SCA P03 Joern runtime identity");
  assertUnique(
    identity.runtime_package_refs.map((ref) => canonicalJson(ref)),
    "SCA P03 runtime package closure"
  );
  return identity;
}

export const validateScaP03HostIsolationAttestationV1 = (
  value: unknown
): ScaP03HostIsolationAttestationV1 =>
  parse(ScaP03HostIsolationAttestationV1Schema, value, "SCA P03 host isolation attestation");

export function validateScaP03IsolationEvidenceV1(value: unknown): ScaP03IsolationEvidenceV1 {
  const evidence = parse(ScaP03IsolationEvidenceV1Schema, value, "SCA P03 isolation evidence");
  if (
    evidence.qualification_scope === "deterministic_test_only" &&
    evidence.runtime_kind !== "simulated_joern_test_runtime"
  ) {
    throw new ScaP03ContractError("deterministic P03 isolation has the wrong runtime kind");
  }
  if (
    evidence.qualification_scope === "live_qualified" &&
    evidence.runtime_kind !== "host_qualified_joern"
  ) {
    throw new ScaP03ContractError("live P03 isolation has the wrong runtime kind");
  }
  return evidence;
}

export function validateScaP03ImplementationIdentityV1(
  value: unknown
): ScaP03ImplementationIdentityV1 {
  const identity = parse(
    ScaP03ImplementationIdentityV1Schema,
    value,
    "SCA P03 implementation identity"
  );
  assertSelfDigest(asRecord(identity), "implementation_sha256", "SCA P03 implementation identity");
  return identity;
}

export function validateScaP03QualificationProfileV2(value: unknown): ScaP03QualificationProfileV2 {
  const profile = parse(ScaP03QualificationProfileV2Schema, value, "SCA P03 qualification profile");
  assertExactOrder(profile.required_query_ids, SCA_P03_QUERY_IDS, "qualification query IDs");
  assertUnique(
    profile.fidelity_requirements.map((entry) => entry.requirement_id),
    "qualification fidelity requirement IDs"
  );
  const dimensions = new Set(profile.fidelity_requirements.map((entry) => entry.dimension));
  for (const dimension of ["language", "framework", "edge_class", "surface"] as const) {
    if (!dimensions.has(dimension)) {
      throw new ScaP03ContractError(`SCA P03 qualification profile lacks ${dimension} fidelity`);
    }
  }
  const languageRequirements = profile.fidelity_requirements
    .filter((entry) => entry.dimension === "language" && entry.materiality === "material")
    .map((entry) => entry.subject);
  assertExactOrder(
    languageRequirements,
    profile.required_languages,
    "qualification material language fidelity"
  );
  for (const partition of ["php", "javascript_typescript"] as const) {
    for (const dimension of ["framework", "edge_class", "surface"] as const) {
      if (
        !profile.fidelity_requirements.some(
          (entry) => entry.partition === partition && entry.dimension === dimension
        )
      ) {
        throw new ScaP03ContractError(
          `SCA P03 qualification profile lacks ${partition} ${dimension} fidelity`
        );
      }
    }
  }
  for (const requirement of profile.fidelity_requirements) {
    const expectedPartition =
      requirement.dimension === "language" && requirement.subject === "php"
        ? "php"
        : requirement.dimension === "language" &&
            (requirement.subject === "javascript" || requirement.subject === "typescript")
          ? "javascript_typescript"
          : requirement.partition;
    if (requirement.partition !== expectedPartition) {
      throw new ScaP03ContractError("SCA P03 language fidelity partition is inconsistent");
    }
  }
  assertSelfDigest(asRecord(profile), "profile_sha256", "SCA P03 qualification profile");
  return profile;
}

export function validateScaP03FidelityComplementEvidenceV2(
  value: unknown
): ScaP03FidelityComplementEvidenceV2 {
  const complement = validateBoundArtifact(
    ScaP03FidelityComplementEvidenceV2Schema,
    value,
    "SCA P03 fidelity complement evidence",
    "complement_sha256"
  );
  // The inactive candidate has no independent complement-review authority. Merely carrying
  // reviewer/method refs in self-declared bytes does not authenticate the review or its scope.
  throw new ScaP03ContractError(
    `SCA P03 complement '${complement.complement_id}' has no approved independent review boundary`
  );
}

export function validateScaP03QualificationFixtureContentV1(
  value: unknown
): ScaP03QualificationFixtureContentV1 {
  const fixture = parse(
    ScaP03QualificationFixtureContentV1Schema,
    value,
    "SCA P03 qualification fixture content"
  );
  assertRepositoryPath(fixture.path, "qualification fixture path");
  const bytes = Buffer.from(fixture.content_base64, "base64");
  if (
    bytes.byteLength !== fixture.byte_length ||
    sha256(bytes) !== fixture.content_sha256 ||
    bytes.toString("base64") !== fixture.content_base64
  ) {
    throw new ScaP03ContractError("SCA P03 fixture bytes or digest diverge");
  }
  return fixture;
}

export function validateScaP03QualificationFixtureCorpusV2(
  value: unknown
): ScaP03QualificationFixtureCorpusV2 {
  const corpus = parse(
    ScaP03QualificationFixtureCorpusV2Schema,
    value,
    "SCA P03 qualification fixture corpus"
  );
  assertUnique(corpus.fixture_ids, "qualification fixture IDs");
  assertUnique(
    corpus.fixture_content_refs.map((ref) => canonicalJson(ref)),
    "fixture corpus refs"
  );
  const expectedCaseKeys = ["php", "javascript", "typescript"].flatMap((language) =>
    SCA_P03_QUERY_IDS.map((queryId) => `${language}\u0000${queryId}`)
  );
  assertExactOrder(
    corpus.expected_cases.map((entry) => `${entry.language}\u0000${entry.query_id}`),
    expectedCaseKeys,
    "qualification expected cases"
  );
  assertUnique(
    corpus.expected_cases.map((entry) => entry.case_id),
    "qualification expected case IDs"
  );
  for (const entry of corpus.expected_cases) {
    const assertionKeys = entry.oracle_assertions.map((assertion) => canonicalJson(assertion));
    assertUnique(assertionKeys, "oracle assertions");
    assertExactOrder(assertionKeys, [...assertionKeys].sort(), "oracle assertion ordering");
    if (
      !entry.oracle_assertions.some((assertion) => assertion.expectation === "present") ||
      entry.oracle_assertions.some(
        (assertion) =>
          assertion.expectation === "present" &&
          (assertion.start === undefined || assertion.start.name === null)
      )
    )
      throw new ScaP03ContractError("SCA P03 case lacks a positive start selector");
    const relationship = [
      "p03.call-resolution.v2",
      "p03.control-guard.v2",
      "p03.dataflow-source-sink.v2",
      "p03.framework-dispatch.v2",
    ].includes(entry.query_id);
    if (
      relationship &&
      !entry.oracle_assertions.some(
        (assertion) => assertion.expectation === "present" && assertion.edge !== undefined
      )
    )
      throw new ScaP03ContractError("SCA P03 material case lacks a positive edge oracle");
    for (const assertion of entry.oracle_assertions) {
      for (const selector of [assertion.start, ...(assertion.via ?? []), assertion.end]) {
        if (selector !== undefined) assertRepositoryPath(selector.path, "oracle vertex path");
      }
    }
  }
  assertSelfDigest(asRecord(corpus), "corpus_sha256", "SCA P03 qualification fixture corpus");
  return corpus;
}

export function validateScaP03QueryScriptV2(value: unknown): ScaP03QueryScriptV2 {
  const script = parse(ScaP03QueryScriptV2Schema, value, "SCA P03 query script");
  const bytes = Buffer.from(script.content_base64, "base64");
  if (
    bytes.byteLength !== script.byte_length ||
    sha256(bytes) !== script.content_sha256 ||
    bytes.toString("base64") !== script.content_base64
  ) {
    throw new ScaP03ContractError("SCA P03 query script bytes or digest diverge");
  }
  decodeScaP03QueryBindingV2(script);
  return script;
}

export function decodeScaP03QueryBindingV2(script: ScaP03QueryScriptV2): ScaP03QueryBindingV2 {
  const text = Buffer.from(script.content_base64, "base64").toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ScaP03ContractError("SCA P03 query script is not a typed binding", {
      cause: error,
    });
  }
  if (canonicalJson(value) !== text) {
    throw new ScaP03ContractError("SCA P03 query script binding is not canonical JSON");
  }
  const binding = parse(ScaP03QueryBindingV2Schema, value, "SCA P03 query script binding");
  if (binding.query_id !== script.query_id || binding.executor_id !== script.query_id) {
    throw new ScaP03ContractError("SCA P03 query script binding authorizes the wrong executor");
  }
  return binding;
}

export function validateScaP03QueryBindingAgainstPlanV2(input: {
  readonly release_id: string;
  readonly query_id: ScaP03QueryId;
  readonly script: ScaP03QueryScriptV2;
  readonly plan: ScaP03QueryPlanV2;
}): ScaP03QueryBindingV2 {
  const binding = decodeScaP03QueryBindingV2(input.script);
  if (
    input.script.query_id !== input.query_id ||
    input.plan.query_id !== input.query_id ||
    binding.release_id !== input.release_id ||
    binding.query_id !== input.query_id ||
    binding.plan_id !== input.plan.plan_id ||
    binding.plan_sha256 !== input.plan.plan_sha256
  ) {
    throw new ScaP03ContractError("SCA P03 typed query binding is substituted or plan-drifted");
  }
  return binding;
}

export function validateScaP03QueryPlanV2(value: unknown): ScaP03QueryPlanV2 {
  const plan = parse(ScaP03QueryPlanV2Schema, value, "SCA P03 query plan");
  assertSelfDigest(asRecord(plan), "plan_sha256", "SCA P03 query plan");
  if (plan.steps.length > plan.max_ast_nodes) {
    throw new ScaP03ContractError("SCA P03 query plan exceeds its AST node bound");
  }
  const requiredEdge =
    plan.query_id === "p03.call-resolution.v2" || plan.query_id === "p03.framework-dispatch.v2"
      ? "call"
      : plan.query_id === "p03.control-guard.v2"
        ? "cfg"
        : plan.query_id === "p03.dataflow-source-sink.v2"
          ? "reaching_def"
          : null;
  if (
    requiredEdge !== null &&
    !plan.steps.some((step) => step.kind === "traverse_edge" && step.edge === requiredEdge)
  ) {
    throw new ScaP03ContractError("SCA P03 query plan lacks its required relationship traversal");
  }
  return plan;
}

export function validateScaP03BaselineQuerySetV2(value: unknown): ScaP03BaselineQuerySetV2 {
  const set = parse(ScaP03BaselineQuerySetV2Schema, value, "SCA P03 baseline query set");
  assertExactOrder(
    set.ordered_queries.map((entry) => entry.query_id),
    SCA_P03_QUERY_IDS,
    "baseline query IDs"
  );
  for (const entry of set.ordered_queries) {
    if (
      entry.script_sha256 !== entry.script_ref.content_digest ||
      entry.plan_sha256 !== entry.plan_ref.content_digest
    ) {
      throw new ScaP03ContractError("SCA P03 query set contains a stale script or plan digest");
    }
  }
  assertSelfDigest(asRecord(set), "query_set_sha256", "SCA P03 baseline query set");
  return set;
}

function validateOperationRequestCommon(request: ScaP03OperationRequestV1): void {
  assertSelfDigest(asRecord(request), "request_sha256", "SCA P03 operation request");
  if (request.source_snapshot_sha256 !== request.source_snapshot_ref.content_digest) {
    throw new ScaP03ContractError("SCA P03 operation request source snapshot is stale");
  }
  const live = request.qualification_scope === "live_qualified";
  if (live !== (request.host_isolation_attestation_ref !== null)) {
    throw new ScaP03ContractError("SCA P03 operation host attestation binding is inconsistent");
  }
}

export function validateScaP03OperationRequestV1(
  kind: "qualify_joern",
  value: unknown
): ScaP03QualificationRequestV2;
export function validateScaP03OperationRequestV1(
  kind: "build_source_graph",
  value: unknown
): ScaP03GraphBuildRequestV1;
export function validateScaP03OperationRequestV1(
  kind: "run_baseline_query_batch",
  value: unknown
): ScaP03BaselineQueryBatchRequestV2;
export function validateScaP03OperationRequestV1(
  kind: ScaP03OperationKind,
  value: unknown
): ScaP03OperationRequestV1;
export function validateScaP03OperationRequestV1(
  kind: ScaP03OperationKind,
  value: unknown
): ScaP03OperationRequestV1 {
  const request =
    kind === "qualify_joern"
      ? parse(ScaP03QualificationRequestV2Schema, value, "SCA P03 qualification request")
      : kind === "build_source_graph"
        ? parse(ScaP03GraphBuildRequestV1Schema, value, "SCA P03 graph build request")
        : parse(ScaP03BaselineQueryBatchRequestV2Schema, value, "SCA P03 baseline query request");
  validateOperationRequestCommon(request);
  if (request.operation_kind !== kind) {
    throw new ScaP03ContractError("SCA P03 operation request kind diverges");
  }
  if (request.operation_kind === "qualify_joern") {
    assertUnique(
      request.fixture_content_refs.map((ref) => canonicalJson(ref)),
      "qualification fixture refs"
    );
    assertUnique(
      request.query_script_refs.map((ref) => canonicalJson(ref)),
      "qualification query script refs"
    );
    assertUnique(
      request.query_plan_refs.map((ref) => canonicalJson(ref)),
      "qualification query plan refs"
    );
  } else if (request.operation_kind === "build_source_graph") {
    const expectedFrontend = scaP03FrontendLanguageV1(request.partition);
    if (request.frontend_language !== expectedFrontend) {
      throw new ScaP03ContractError("SCA P03 graph partition uses the wrong explicit frontend");
    }
    const paths = request.expected_files.map((file) => file.path);
    assertUnique(paths, "graph expected file paths");
    for (const path of paths) assertRepositoryPath(path, "graph expected file path");
  } else {
    assertExactOrder(request.ordered_query_ids, SCA_P03_QUERY_IDS, "baseline batch query IDs");
    if (request.graph_component_sha256 !== request.graph_component_ref.content_digest) {
      throw new ScaP03ContractError("SCA P03 baseline batch graph digest is stale");
    }
    assertUnique(
      request.fidelity_requirements.map((entry) => entry.requirement_id),
      "baseline batch fidelity requirement IDs"
    );
    if (request.fidelity_requirements.some((entry) => entry.partition !== request.partition)) {
      throw new ScaP03ContractError("SCA P03 baseline batch carries cross-partition fidelity");
    }
    assertUnique(
      request.query_script_refs.map((ref) => canonicalJson(ref)),
      "baseline batch query script refs"
    );
    assertUnique(
      request.query_plan_refs.map((ref) => canonicalJson(ref)),
      "baseline batch query plan refs"
    );
  }
  return request;
}

function assertResultBinding(
  request: ScaP03OperationRequestV1,
  result: ScaP03OperationResultV1
): void {
  for (const key of [
    "tenant_id",
    "project_id",
    "run_id",
    "phase_id",
    "operation_id",
    "p01_binding_sha256",
    "p02_binding_sha256",
    "p03_runtime_binding_sha256",
    "source_snapshot_sha256",
    "runtime_id",
    "runtime_kind",
    "qualification_scope",
    "runtime_tree_sha256",
    "isolation_id",
    "isolation_profile_sha256",
  ] as const) {
    if (request[key] !== result[key]) {
      throw new ScaP03ContractError(`SCA P03 operation result drifts at ${key}`);
    }
  }
  if (
    !same(request.source_snapshot_ref, result.source_snapshot_ref) ||
    result.request_sha256 !== request.request_sha256
  ) {
    throw new ScaP03ContractError("SCA P03 operation result has stale request/source binding");
  }
  assertSelfDigest(asRecord(result), "result_sha256", "SCA P03 operation result");
  const positive = result.status === "complete";
  if (positive !== (result.blocker_codes.length === 0)) {
    throw new ScaP03ContractError("SCA P03 operation status contradicts blocker codes");
  }
}

function validateGraphResultAgainstRequest(
  request: ScaP03GraphBuildRequestV1,
  result: ScaP03GraphBuildResultV1
): void {
  if (
    request.partition !== result.partition ||
    request.frontend_language !== result.frontend_language
  ) {
    throw new ScaP03ContractError("SCA P03 graph result partition/frontend drifted");
  }
  const expected = new Map(request.expected_files.map((file) => [file.path, file]));
  if (result.accounted_files.length !== expected.size) {
    throw new ScaP03ContractError("SCA P03 graph result file accounting is incomplete");
  }
  assertUnique(
    result.accounted_files.map((file) => file.path),
    "graph accounted file paths"
  );
  for (const file of result.accounted_files) {
    const expectedFile = expected.get(file.path);
    if (expectedFile === undefined || expectedFile.content_sha256 !== file.content_sha256) {
      throw new ScaP03ContractError("SCA P03 graph result contains a cross-snapshot file");
    }
    if (
      (file.disposition === "unsupported" || file.disposition === "failed") !==
      (file.reason_code !== null)
    ) {
      throw new ScaP03ContractError("SCA P03 graph file disposition contradicts its reason");
    }
  }
  assertSelfDigest(asRecord(result.cleanup_evidence), "cleanup_sha256", "SCA P03 graph cleanup");
  const cleanupProven =
    result.cleanup_evidence.workspace_removed &&
    result.cleanup_evidence.graph_handles_closed &&
    result.cleanup_evidence.process_exit_observed;
  if ((result.cleanup_status === "proven") !== cleanupProven) {
    throw new ScaP03ContractError("SCA P03 graph cleanup status lacks exact cleanup evidence");
  }
  if (result.graph !== null && result.graph.byte_length > request.max_graph_bytes) {
    throw new ScaP03ContractError("SCA P03 graph output exceeds the accepted graph byte limit");
  }
  const complete =
    result.status === "complete" &&
    result.graph !== null &&
    result.graph_opened &&
    cleanupProven &&
    result.accounted_files.every(
      (file) => file.disposition === "parsed" || file.disposition === "contextual"
    );
  if (result.complete !== complete) {
    throw new ScaP03ContractError("SCA P03 graph result completeness is inconsistent");
  }
  if ((result.graph === null) !== (result.graph_id === null)) {
    throw new ScaP03ContractError("SCA P03 graph descriptor and graph ID disagree");
  }
  if (result.graph !== null) {
    const expectedGraphId = `p03graph_${sha256(
      canonicalJson({
        graph_build_key_sha256: result.graph_build_key_sha256,
        content_sha256: result.graph.content_sha256,
      })
    )}`;
    if (result.graph_id !== expectedGraphId) {
      throw new ScaP03ContractError("SCA P03 graph ID does not bind graph bytes");
    }
  }
}

function validateQueryResultAgainstRequest(
  request: ScaP03BaselineQueryBatchRequestV2,
  result: ScaP03BaselineQueryBatchResultV2
): void {
  if (
    request.partition !== result.partition ||
    !same(request.graph_component_ref, result.graph_component_ref) ||
    request.graph_component_sha256 !== result.graph_component_sha256 ||
    !same(request.graph_build_result_ref, result.graph_build_result_ref) ||
    !same(request.baseline_query_set_ref, result.baseline_query_set_ref)
  ) {
    throw new ScaP03ContractError("SCA P03 baseline query result has stale graph/query binding");
  }
  const blocked = result.status === "blocked" || result.status === "cancelled";
  if (blocked) {
    if (
      result.page_descriptors.length !== 0 ||
      result.query_footers.length !== 0 ||
      result.fidelity_observations.length !== 0 ||
      result.executed_query_release_sha256 !== null
    ) {
      throw new ScaP03ContractError("blocked P03 baseline query result cannot carry observations");
    }
  } else {
    if (result.executed_query_release_sha256 === null) {
      throw new ScaP03ContractError("P03 baseline query result lacks its executed frozen release");
    }
    const footerIds = result.query_footers.map((footer) => footer.query_id);
    assertExactOrder(footerIds, SCA_P03_QUERY_IDS, "baseline query footers");
    let totalItems = 0;
    let totalBytes = 0;
    for (const queryId of SCA_P03_QUERY_IDS) {
      const descriptors = result.page_descriptors.filter((page) => page.query_id === queryId);
      const footer = result.query_footers.find((entry) => entry.query_id === queryId);
      const expectedPageNumbers = Array.from(
        { length: descriptors.length },
        (_, index) => index + 1
      );
      if (
        footer === undefined ||
        descriptors.length === 0 ||
        descriptors.length > request.max_pages_per_query ||
        !same(
          descriptors.map((page) => page.page_number),
          expectedPageNumbers
        ) ||
        descriptors.some((page) => page.item_count > request.max_page_items) ||
        descriptors.length !== footer.page_count ||
        descriptors.reduce((sum, page) => sum + page.item_count, 0) !== footer.item_count ||
        descriptors.reduce((sum, page) => sum + page.byte_length, 0) !== footer.byte_count
      ) {
        throw new ScaP03ContractError(
          `SCA P03 query '${queryId}' pages are not contiguous, unique, or bounded`
        );
      }
      totalItems += footer.item_count;
      totalBytes += footer.byte_count;
    }
    if (
      result.page_descriptors.length > SCA_P03_MAX_QUERY_PAGES ||
      totalItems > request.max_query_items ||
      totalBytes > request.max_query_output_bytes
    ) {
      throw new ScaP03ContractError("SCA P03 baseline query aggregate exceeds accepted limits");
    }
    assertExactOrder(
      result.fidelity_observations.map((entry) => entry.requirement_id),
      request.fidelity_requirements.map((entry) => entry.requirement_id),
      "baseline fidelity observations"
    );
    for (const observation of result.fidelity_observations) {
      if ((observation.support === "supported") !== (observation.reason_code === null)) {
        throw new ScaP03ContractError("SCA P03 fidelity support contradicts its reason code");
      }
    }
  }
  const clean =
    result.status === "complete" &&
    !result.truncated &&
    result.query_footers.every((footer) => footer.complete);
  if (result.complete !== clean) {
    throw new ScaP03ContractError("SCA P03 baseline query completion/truncation is inconsistent");
  }
}

/** One canonical digest binds exact V2 observations to the fixture and frozen release. */
export function scaP03QualificationObservationSha256V2(input: {
  readonly fixture_id: string | null;
  readonly fixture_sha256: string | null;
  readonly query_id: ScaP03QueryId;
  readonly frontend_language: "PHP" | "JSSRC";
  readonly release_sha256: string | null;
  readonly blocker_code: ScaP03QualificationBlockerCodeV2 | null;
  readonly observations: readonly ScaP03QueryCandidateV2[];
}): string {
  return sha256(canonicalJson(input));
}

function matchesOracle(
  candidate: ScaP03QueryCandidateV2,
  assertion: ScaP03OracleAssertionV2
): boolean {
  const vertexMatches = (
    selector: ScaP03OracleAssertionV2["start"],
    vertex: ScaP03QueryCandidateV2["vertices"][number] | undefined
  ) =>
    selector === undefined ||
    (vertex !== undefined &&
      vertex.path === selector.path &&
      vertex.name === selector.name &&
      vertex.line === selector.line &&
      vertex.role === selector.role);
  // Source-level milestones need not be adjacent in a frontend's raw CPG. They
  // must still occur strictly between the exact endpoints, in their declared order.
  const viaMatches = (): boolean => {
    if (assertion.via === undefined) return true;
    if (assertion.claim !== "reaching_definition")
      return (
        candidate.vertices.length === assertion.via.length + 2 &&
        assertion.via.every((selector, index) =>
          vertexMatches(selector, candidate.vertices[index + 1])
        )
      );
    let next = 1;
    for (const selector of assertion.via) {
      while (
        next < candidate.vertices.length - 1 &&
        !vertexMatches(selector, candidate.vertices[next])
      )
        next++;
      if (next >= candidate.vertices.length - 1) return false;
      next++;
    }
    return true;
  };
  return (
    candidate.candidate_kind === assertion.candidate_kind &&
    candidate.claim === assertion.claim &&
    candidate.disposition === assertion.disposition &&
    vertexMatches(assertion.start, candidate.vertices[0]) &&
    vertexMatches(assertion.end, candidate.vertices.at(-1)) &&
    (assertion.claim !== "reaching_definition" ||
      (candidate.hop_count > 0 &&
        candidate.hop_count <= SCA_P03_QUALIFICATION_DATAFLOW_MAX_HOPS &&
        candidate.hop_count === candidate.edges.length)) &&
    viaMatches() &&
    (assertion.edge === undefined ||
      (candidate.edges.length === candidate.vertices.length - 1 &&
        candidate.edges.every(
          (edge, index) =>
            edge.src_index === index &&
            edge.dst_index === index + 1 &&
            edge.src_node_id === candidate.vertices[index]?.node_id &&
            edge.dst_node_id === candidate.vertices[index + 1]?.node_id &&
            edge.direction === "forward" &&
            edge.kind === assertion.edge?.kind &&
            edge.provenance === assertion.edge.provenance &&
            edge.branch_orientation === assertion.edge.branch_orientation
        ))) &&
    (assertion.framework === undefined || candidate.framework === assertion.framework) &&
    (assertion.registration_form === undefined ||
      candidate.registration_form === assertion.registration_form) &&
    (assertion.callback_resolution === undefined ||
      candidate.callback_resolution === assertion.callback_resolution) &&
    (assertion.source_selector === undefined ||
      candidate.source_selector === assertion.source_selector) &&
    (assertion.sink_selector === undefined ||
      candidate.sink_selector === assertion.sink_selector) &&
    (assertion.reason_code === undefined || candidate.reason_code === assertion.reason_code)
  );
}

/** The positive start defines qualification scope; absent assertions cannot expand or shrink it.
 * Keep every observed relationship from that start, even when its endpoint is unexpected.
 */
export function projectScaP03OracleTargetObservationsV2(
  observations: readonly ScaP03QueryCandidateV2[],
  assertions: readonly ScaP03OracleAssertionV2[]
): ScaP03QueryCandidateV2[] {
  return observations.filter((candidate) =>
    assertions.some(
      (assertion) =>
        assertion.expectation === "present" &&
        assertion.start !== undefined &&
        candidate.vertices[0]?.path === assertion.start.path &&
        candidate.vertices[0].line === assertion.start.line &&
        candidate.vertices[0].role === assertion.start.role &&
        candidate.vertices[0].name === assertion.start.name
    )
  );
}

/** A retained case cannot carry candidates outside the persisted positive start domain. */
export function validateScaP03QualificationCaseProjectionV2(
  entry: ScaP03QualificationCaseV2,
  expected: ScaP03QualificationFixtureCorpusV2["expected_cases"][number]
): void {
  if (
    entry.case_id !== expected.case_id ||
    entry.language !== expected.language ||
    entry.query_id !== expected.query_id ||
    projectScaP03OracleTargetObservationsV2(entry.observations, expected.oracle_assertions)
      .length !== entry.observations.length
  ) {
    throw new ScaP03ContractError("SCA P03 qualification retained foreign oracle targets");
  }
}

/** After structural result validation, recheck every retained case against the persisted corpus. */
export function validateScaP03QualificationResultProjectionV2(
  result: ScaP03QualificationResultV2,
  expectedCases: ScaP03QualificationFixtureCorpusV2["expected_cases"],
  approvedComplementRef?: ArtifactRef
): void {
  if (result.cases.length !== expectedCases.length)
    throw new ScaP03ContractError("SCA P03 qualification case roster drift");
  for (const [index, entry] of result.cases.entries()) {
    const expected = expectedCases[index];
    if (expected === undefined) throw new ScaP03ContractError("SCA P03 oracle case missing");
    validateScaP03QualificationCaseProjectionV2(entry, expected);
    for (const candidate of entry.observations) {
      if (
        candidate.edges.some((edge) => edge.provenance === "qualified_complement") &&
        !expected.oracle_assertions.some(
          (assertion) =>
            assertion.expectation === "present" &&
            assertion.edge?.provenance === "qualified_complement" &&
            candidate.vertices.length === 2 + (assertion.via?.length ?? 0) &&
            matchesOracle(candidate, assertion)
        )
      )
        throw new ScaP03ContractError("SCA P03 complement is not exact reviewed source truth");
    }
    validateScaP03QualificationCaseObservationsV2(
      entry,
      result.executed_query_release_sha256,
      undefined,
      approvedComplementRef
    );
    const matches = scaP03QualificationAssertionsMatchV2(
      entry.observations,
      expected.oracle_assertions
    );
    if (
      (entry.status === "passed" && !matches) ||
      (entry.blocker_code === "p03_oracle_assertion_mismatch" && matches)
    )
      throw new ScaP03ContractError(
        "SCA P03 qualification oracle verdict contradicts observations"
      );
  }
}

export function scaP03QualificationCaseMatchesV2(
  entry: ScaP03QualificationCaseV2,
  expected: ScaP03QualificationFixtureCorpusV2["expected_cases"][number],
  fixture: { readonly fixture_id: string; readonly content_sha256: string; readonly path: string },
  release_sha256: string,
  approvedComplementRef?: ArtifactRef
): boolean {
  if (
    entry.case_id !== expected.case_id ||
    entry.language !== expected.language ||
    entry.query_id !== expected.query_id ||
    entry.fixture_id !== fixture.fixture_id ||
    entry.fixture_sha256 !== fixture.content_sha256 ||
    entry.status !== "passed" ||
    entry.blocker_code !== null ||
    (expected.expected_observed_sha256 !== null &&
      entry.observed_sha256 !== expected.expected_observed_sha256)
  )
    return false;
  try {
    validateScaP03QualificationCaseObservationsV2(
      entry,
      release_sha256,
      [fixture.path],
      approvedComplementRef
    );
    validateScaP03QualificationCaseProjectionV2(entry, expected);
    if (
      entry.observations.some(
        (candidate) =>
          candidate.edges.some((edge) => edge.provenance === "qualified_complement") &&
          !expected.oracle_assertions.some(
            (assertion) =>
              assertion.expectation === "present" &&
              assertion.edge?.provenance === "qualified_complement" &&
              candidate.vertices.length === 2 + (assertion.via?.length ?? 0) &&
              matchesOracle(candidate, assertion)
          )
      )
    )
      return false;
  } catch {
    return false;
  }
  return scaP03QualificationAssertionsMatchV2(entry.observations, expected.oracle_assertions);
}

/** Material oracle truth is evaluated before (and independently of) observation digests.
 * All relationships from reviewed starts remain visible; only declared assertions decide the verdict.
 */
export function scaP03QualificationAssertionsMatchV2(
  observations: readonly ScaP03QueryCandidateV2[],
  assertions: readonly ScaP03OracleAssertionV2[]
): boolean {
  return (
    assertions.some((assertion) => assertion.expectation === "present") &&
    assertions.every(
      (assertion) =>
        observations.some((candidate) => matchesOracle(candidate, assertion)) ===
        (assertion.expectation === "present")
    )
  );
}

export function validateScaP03QualificationCaseObservationsV2(
  entry: ScaP03QualificationCaseV2,
  release_sha256: string | null,
  accounted_paths?: readonly string[],
  approvedComplementRef?: ArtifactRef
): void {
  if (
    entry.frontend_language !== scaP03FrontendLanguageV1(entry.language) ||
    entry.observation_count !== entry.observations.length ||
    Buffer.byteLength(canonicalJson(entry.observations), "utf8") >
      SCA_P03_MAX_QUALIFICATION_CASE_BYTES ||
    (entry.fixture_id === null) !== (entry.fixture_sha256 === null) ||
    (entry.status === "passed") !== (entry.blocker_code === null) ||
    (release_sha256 !== null && entry.fixture_id === null && entry.observations.length > 0) ||
    entry.observed_sha256 !==
      scaP03QualificationObservationSha256V2({
        fixture_id: entry.fixture_id,
        fixture_sha256: entry.fixture_sha256,
        query_id: entry.query_id,
        frontend_language: entry.frontend_language,
        release_sha256,
        blocker_code: entry.blocker_code,
        observations: entry.observations,
      })
  )
    throw new ScaP03ContractError("SCA P03 qualification observations or digest diverge");
  assertExactOrder(
    entry.observations.map((item) => item.candidate_id),
    [...entry.observations.map((item) => item.candidate_id)].sort(),
    "qualification candidate ordering"
  );
  assertUnique(
    entry.observations.map((item) => item.candidate_id),
    "qualification candidate IDs"
  );
  for (const item of entry.observations) {
    validateScaP03QueryCandidateV2(item, {
      approved_complement_ref: approvedComplementRef,
      query_id: entry.query_id,
      graph_component_sha256: item.graph_component_sha256,
      source_snapshot_sha256: entry.fixture_sha256 ?? "",
      query_release_sha256: release_sha256 ?? "",
      accounted_paths:
        accounted_paths ??
        (entry.fixture_id === null
          ? []
          : [
              ...new Set(
                item.vertices.flatMap((vertex) => (vertex.path === null ? [] : [vertex.path]))
              ),
            ]),
    });
  }
}

export function validateScaP03OperationResultV1(
  kind: "qualify_joern",
  requestValue: unknown,
  resultValue: unknown
): ScaP03QualificationResultV2;
export function validateScaP03OperationResultV1(
  kind: "build_source_graph",
  requestValue: unknown,
  resultValue: unknown
): ScaP03GraphBuildResultV1;
export function validateScaP03OperationResultV1(
  kind: "run_baseline_query_batch",
  requestValue: unknown,
  resultValue: unknown
): ScaP03BaselineQueryBatchResultV2;
export function validateScaP03OperationResultV1(
  kind: ScaP03OperationKind,
  requestValue: unknown,
  resultValue: unknown
): ScaP03OperationResultV1;
export function validateScaP03OperationResultV1(
  kind: ScaP03OperationKind,
  requestValue: unknown,
  resultValue: unknown
): ScaP03OperationResultV1 {
  if (kind === "qualify_joern") {
    const request = validateScaP03OperationRequestV1(kind, requestValue);
    const result = parse(
      ScaP03QualificationResultV2Schema,
      resultValue,
      "SCA P03 qualification result"
    );
    assertResultBinding(request, result);
    if (
      !same(result.source_oracle_ref, request.source_oracle_ref) ||
      !same(result.source_oracle_validation_ref, request.source_oracle_validation_ref) ||
      !same(result.fixture_corpus_ref, request.fixture_corpus_ref) ||
      !same(result.baseline_query_set_ref, request.baseline_query_set_ref)
    ) {
      throw new ScaP03ContractError("SCA P03 qualification result authority refs drifted");
    }
    const caseKeys = result.cases.map((entry) => `${entry.language}\u0000${entry.query_id}`);
    const expectedKeys = ["php", "javascript", "typescript"].flatMap((language) =>
      SCA_P03_QUERY_IDS.map((queryId) => `${language}\u0000${queryId}`)
    );
    assertExactOrder(caseKeys, expectedKeys, "qualification cases");
    const observedRelease = result.executed_query_release_sha256 !== null;
    if (
      result.status === "complete" &&
      result.cases.some(
        (entry) =>
          entry.status !== "passed" ||
          entry.fixture_id === null ||
          ([
            "p03.call-resolution.v2",
            "p03.control-guard.v2",
            "p03.dataflow-source-sink.v2",
            "p03.framework-dispatch.v2",
          ].includes(entry.query_id) &&
            !entry.observations.some((candidate) => candidate.edges.length > 0))
      )
    )
      throw new ScaP03ContractError("SCA P03 complete qualification lacks material observations");
    if (
      Buffer.byteLength(canonicalJson(result.cases.map((entry) => entry.observations)), "utf8") >
      SCA_P03_MAX_QUALIFICATION_TOTAL_BYTES
    )
      throw new ScaP03ContractError("SCA P03 qualification observations exceed total bound");
    for (const entry of result.cases) {
      validateScaP03QualificationCaseObservationsV2(
        entry,
        result.executed_query_release_sha256,
        undefined,
        request.source_oracle_validation_ref
      );
      if (entry.status === "passed" && !observedRelease)
        throw new ScaP03ContractError("SCA P03 passed case lacks a release");
      if (!observedRelease && (entry.fixture_id !== null || entry.observation_count !== 0))
        throw new ScaP03ContractError("SCA P03 blocked qualification fabricated observations");
    }
    if (
      (result.qualified &&
        (result.status !== "complete" ||
          !observedRelease ||
          request.qualification_scope !== "live_qualified")) ||
      observedRelease !== (result.parser_identity_sha256 !== null)
    ) {
      throw new ScaP03ContractError("SCA P03 qualification result overstates qualification");
    }
    return result;
  }
  if (kind === "build_source_graph") {
    const request = validateScaP03OperationRequestV1(kind, requestValue);
    const result = parse(ScaP03GraphBuildResultV1Schema, resultValue, "SCA P03 graph build result");
    assertResultBinding(request, result);
    validateGraphResultAgainstRequest(request, result);
    return result;
  }
  const request = validateScaP03OperationRequestV1(kind, requestValue);
  const result = parse(
    ScaP03BaselineQueryBatchResultV2Schema,
    resultValue,
    "SCA P03 baseline query result"
  );
  assertResultBinding(request, result);
  validateQueryResultAgainstRequest(request, result);
  return result;
}

export function makeScaP03QueryCandidateV2(
  core: Omit<ScaP03QueryCandidateV2, "candidate_id" | "serialized_bytes">
): ScaP03QueryCandidateV2 {
  const serialized_bytes = Buffer.byteLength(canonicalJson(core), "utf8");
  return {
    ...core,
    serialized_bytes,
    candidate_id: `p03c_${sha256(canonicalJson({ ...core, serialized_bytes }))}`,
  };
}

export function validateScaP03QueryCandidateV2(
  candidate: ScaP03QueryCandidateV2,
  binding: {
    readonly approved_complement_ref?: ArtifactRef | undefined;
    readonly query_id: ScaP03QueryId;
    readonly graph_component_sha256: string;
    readonly source_snapshot_sha256: string;
    readonly query_release_sha256: string;
    readonly accounted_paths: readonly string[];
  }
): void {
  validateContract(ScaP03QueryCandidateV2Schema, candidate, "SCA P03 query candidate");
  const { candidate_id, serialized_bytes, ...core } = candidate;
  if (
    candidate_id !== `p03c_${sha256(canonicalJson({ ...core, serialized_bytes }))}` ||
    serialized_bytes !== Buffer.byteLength(canonicalJson(core), "utf8") ||
    candidate.query_id !== binding.query_id ||
    candidate.graph_component_sha256 !== binding.graph_component_sha256 ||
    candidate.source_snapshot_sha256 !== binding.source_snapshot_sha256 ||
    candidate.query_release_sha256 !== binding.query_release_sha256 ||
    candidate.hop_count !== candidate.edges.length ||
    candidate.hop_count > SCA_P03_MAX_PATH_HOPS ||
    candidate.serialized_bytes > SCA_P03_MAX_QUERY_OUTPUT_BYTES ||
    candidate.vertices.length !== candidate.edges.length + 1 ||
    candidate.truncated ||
    candidate.path !== candidate.vertices[0]?.path ||
    candidate.line !== candidate.vertices[0]?.line
  )
    throw new ScaP03ContractError("SCA P03 path identity, binding, or bounds diverge");
  const files = new Set(binding.accounted_paths);
  const ids = new Set<string>();
  let unlocated = 0;
  for (const vertex of candidate.vertices) {
    if (ids.has(vertex.node_id)) throw new ScaP03ContractError("SCA P03 path has duplicate vertex");
    ids.add(vertex.node_id);
    if (vertex.line === null && vertex.column !== null)
      throw new ScaP03ContractError("SCA P03 column cannot outlive its source line");
    if (vertex.location_provenance === "qualified_source_oracle") {
      if (
        vertex.path === null ||
        vertex.line === null ||
        vertex.cpg_line === undefined ||
        vertex.location_owner_node_id !== null ||
        vertex.location_evidence !== null ||
        (vertex.role !== "handler" && vertex.cpg_line !== vertex.line) ||
        vertex.cpg_line > vertex.line ||
        vertex.source_location_ref?.kind !== "sca-p03-source-oracle-validation" ||
        vertex.source_location_ref.content_schema?.schema_id !==
          SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA ||
        vertex.source_location_ref.producer !== SCA_P03_SOURCE_ORACLE_VALIDATOR ||
        !same(vertex.source_location_ref, binding.approved_complement_ref) ||
        binding.approved_complement_ref === undefined
      )
        throw new ScaP03ContractError("SCA P03 reviewed location lacks exact CPG/receipt binding");
    } else if (vertex.source_location_ref !== undefined || vertex.cpg_line !== undefined) {
      throw new ScaP03ContractError("SCA P03 observed vertex claims source-oracle location");
    }
    if (vertex.path === null) {
      if (
        vertex.location_provenance !== "external_unaccounted" ||
        vertex.location_owner_node_id !== null ||
        vertex.location_evidence !== null ||
        vertex.line !== null ||
        vertex.column !== null ||
        vertex.name !== null ||
        vertex.full_name !== null
      )
        throw new ScaP03ContractError("SCA P03 unlocated vertex claims repository material");
      unlocated++;
    } else {
      if (!files.has(vertex.path))
        throw new ScaP03ContractError("SCA P03 path has foreign-file vertex");
      assertRepositoryPath(vertex.path, "path vertex location");
      const evidence = vertex.location_evidence;
      if (
        vertex.location_provenance === "direct" ||
        vertex.location_provenance === "qualified_source_oracle"
      ) {
        if (vertex.location_owner_node_id !== null || evidence !== null)
          throw new ScaP03ContractError("SCA P03 direct vertex carries forged ownership");
      } else if (
        vertex.location_provenance !== "containing_method" ||
        evidence === null ||
        vertex.location_owner_node_id === null ||
        vertex.location_owner_node_id === vertex.node_id ||
        evidence.owner_node_id !== vertex.location_owner_node_id ||
        evidence.owner_path !== vertex.path ||
        evidence.edge_src_node_id !== evidence.owner_node_id ||
        evidence.edge_dst_node_id !== vertex.node_id ||
        (candidate.vertices.find((v) => v.node_id === evidence.owner_node_id) !== undefined &&
          !candidate.vertices.some(
            (v) =>
              v.node_id === evidence.owner_node_id &&
              v.location_provenance === "direct" &&
              v.path === evidence.owner_path &&
              v.label === evidence.owner_label
          ))
      ) {
        throw new ScaP03ContractError("SCA P03 location ownership is unproven or inconsistent");
      }
    }
  }
  if (
    unlocated > 0 !== (candidate.reason_code === "path_location_unaccounted") ||
    (unlocated > 0 && candidate.disposition !== "unresolved")
  )
    throw new ScaP03ContractError("SCA P03 incomplete path must remain unresolved");
  const complemented = candidate.edges.some((edge) => edge.provenance === "qualified_complement");
  if (
    complemented &&
    (candidate.vertices.some(
      (vertex) =>
        !/^[1-9][0-9]*$/.test(vertex.node_id) ||
        vertex.location_provenance !== "qualified_source_oracle"
    ) ||
      binding.approved_complement_ref === undefined ||
      candidate.disposition !== "supported" ||
      candidate.assumptions.length !== 0 ||
      candidate.edges.some(
        (edge) =>
          edge.provenance !== "qualified_complement" ||
          !same(edge.complement_ref, binding.approved_complement_ref)
      ))
  )
    throw new ScaP03ContractError("SCA P03 complement lacks exact approved receipt");
  if (
    !complemented &&
    candidate.vertices.some((vertex) => vertex.location_provenance === "qualified_source_oracle")
  )
    throw new ScaP03ContractError("SCA P03 source location requires a complemented edge");
  for (const [index, edge] of candidate.edges.entries()) {
    if (
      edge.src_index !== index ||
      edge.dst_index !== index + 1 ||
      edge.src_node_id !== candidate.vertices[index]?.node_id ||
      edge.dst_node_id !== candidate.vertices[index + 1]?.node_id ||
      (edge.provenance === "qualified_complement"
        ? edge.complement_ref === null
        : edge.complement_ref !== null) ||
      (edge.branch_orientation !== null &&
        !(complemented ? edge.kind === "dispatch" : edge.kind === "cfg"))
    )
      throw new ScaP03ContractError(
        "SCA P03 path is disconnected, reversed, or carries unapproved provenance"
      );
  }
  if ((candidate.disposition === "supported") !== (candidate.reason_code === null))
    throw new ScaP03ContractError("SCA P03 path disposition lacks a reason");
  const start = candidate.vertices[0];
  const end = candidate.vertices.at(-1);
  if (start === undefined || end === undefined)
    throw new ScaP03ContractError("SCA P03 path lacks endpoints");
  if (candidate.disposition === "supported") {
    const call =
      candidate.claim === "call_resolution" &&
      candidate.query_id === "p03.call-resolution.v2" &&
      start.role === "call_site" &&
      start.label === "call" &&
      end.role === "callee" &&
      end.label === "method" &&
      candidate.edges.length > 0 &&
      start.line !== null &&
      candidate.edges.every((edge) => edge.kind === "call" && edge.provenance === "observed_cpg") &&
      candidate.assumptions.length === 0 &&
      !complemented;
    const definition =
      candidate.claim === "reaching_definition" &&
      candidate.query_id === "p03.dataflow-source-sink.v2" &&
      start.role === "source" &&
      (start.label === "identifier" || (complemented && start.label === "method_parameter_in")) &&
      end.role === "sink" &&
      end.label === "identifier" &&
      start.name !== null &&
      end.name !== null &&
      candidate.source_selector === start.name &&
      candidate.sink_selector === end.name &&
      candidate.edges.length > 0 &&
      candidate.edges.every(
        (edge) =>
          edge.kind === "reaching_def" &&
          edge.branch_orientation === null &&
          (complemented || edge.provenance === "observed_cpg")
      ) &&
      (!complemented ||
        candidate.vertices
          .slice(1, -1)
          .every((vertex) => vertex.role === "unknown" && vertex.label === "identifier")) &&
      candidate.assumptions.length === 0;
    const presence =
      candidate.claim === "observation" &&
      (candidate.query_id === "p03.graph-integrity.v2" ||
        candidate.query_id === "p03.symbol-entrypoint-index.v2") &&
      candidate.vertices.length === 1 &&
      candidate.edges.length === 0 &&
      start.role === "symbol" &&
      start.label === "method" &&
      start.name !== null &&
      candidate.assumptions.length === 0 &&
      !complemented;
    // A CFG edge does not encode branch orientation/control dependence. A registration
    // CALL edge cannot alone resolve dynamic framework callback dispatch.
    const control =
      complemented &&
      candidate.query_id === "p03.control-guard.v2" &&
      candidate.claim === "control_reachability" &&
      start.role === "guard" &&
      start.label === "control_structure" &&
      end.role === "action" &&
      candidate.edges.length > 0 &&
      candidate.edges.every(
        (edge) =>
          edge.kind === "dispatch" &&
          edge.branch_orientation !== null &&
          edge.branch_orientation === candidate.edges[0]?.branch_orientation
      );
    const framework =
      complemented &&
      candidate.query_id === "p03.framework-dispatch.v2" &&
      candidate.claim === "framework_dispatch" &&
      start.role === "registration" &&
      start.label === "call" &&
      end.role === "handler" &&
      end.label === "method" &&
      candidate.callback_resolution === "observed" &&
      candidate.registration_form !== null &&
      candidate.framework !== null &&
      candidate.edges.length > 0 &&
      candidate.edges.every((edge) => edge.kind === "dispatch" && edge.branch_orientation === null);
    if (!call && !definition && !presence && !control && !framework)
      throw new ScaP03ContractError("SCA P03 path overstates relationship fidelity");
    if (
      candidate.vertices.some(
        (vertex) => vertex.path === null || vertex.line === null || vertex.name === null
      )
    )
      throw new ScaP03ContractError("SCA P03 supported path has unaccounted vertices");
  }
  if (
    (candidate.claim === "reaching_definition" &&
      (candidate.source_selector === null || candidate.sink_selector === null)) ||
    (candidate.claim === "framework_dispatch" && candidate.callback_resolution === null) ||
    (candidate.disposition === "supported" &&
      candidate.claim === "framework_dispatch" &&
      candidate.framework === null)
  )
    throw new ScaP03ContractError("SCA P03 path lacks declared semantics");
}

export function validateScaP03BaselineQueryPageV2(value: unknown): ScaP03BaselineQueryPageV2 {
  const page = parse(ScaP03BaselineQueryPageV2Schema, value, "SCA P03 baseline query page");
  assertUnique(page.accounted_paths, "query page accounted paths");
  for (const path of page.accounted_paths) assertRepositoryPath(path, "accounted path");
  assertUnique(
    page.items.map((item) => item.candidate_id),
    "query page candidate IDs"
  );
  for (const item of page.items) validateScaP03QueryCandidateV2(item, page);
  if (
    page.item_count !== page.items.length ||
    page.graph_component_sha256 !== page.graph_component_ref.content_digest
  ) {
    throw new ScaP03ContractError("SCA P03 query page count or graph digest diverges");
  }
  assertSelfDigest(asRecord(page), "page_sha256", "SCA P03 baseline query page");
  return page;
}

function validateBoundArtifact<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  value: unknown,
  label: string,
  digestField: string
): Readonly<Static<TSchemaValue>> {
  const validated = parse(schema, value, label);
  assertSelfDigest(asRecord(validated), digestField, label);
  return validated;
}

export const validateScaP03EntryAdmissionV2 = (value: unknown): ScaP03EntryAdmissionV2 =>
  validateBoundArtifact(
    ScaP03EntryAdmissionV2Schema,
    value,
    "SCA P03 entry admission",
    "admission_sha256"
  );
export const validateScaP03GraphProvenanceV1 = (value: unknown): ScaP03GraphProvenanceV1 =>
  validateBoundArtifact(
    ScaP03GraphProvenanceV1Schema,
    value,
    "SCA P03 graph provenance",
    "provenance_sha256"
  );

export function validateScaP03GraphManifestV1(value: unknown): ScaP03GraphManifestV1 {
  const manifest = validateBoundArtifact(
    ScaP03GraphManifestV1Schema,
    value,
    "SCA P03 graph manifest",
    "manifest_sha256"
  );
  assertExactOrder(
    manifest.components.map((entry) => entry.partition),
    SCA_P03_PARTITIONS,
    "graph manifest partitions"
  );
  if (manifest.complete !== manifest.components.every((entry) => entry.status === "complete")) {
    throw new ScaP03ContractError("SCA P03 graph manifest completeness is inconsistent");
  }
  return manifest;
}

export function validateScaP03GraphSupportMatrixV2(value: unknown): ScaP03GraphSupportMatrixV2 {
  const matrix = validateBoundArtifact(
    ScaP03GraphSupportMatrixV2Schema,
    value,
    "SCA P03 graph support matrix",
    "matrix_sha256"
  );
  assertUnique(
    matrix.entries.map((entry) => entry.requirement_id),
    "graph support requirement IDs"
  );
  for (const entry of matrix.entries) {
    const supported = entry.support === "supported" || entry.support === "complemented";
    if (
      entry.evidence_refs.length !==
        new Set(entry.evidence_refs.map((ref) => canonicalJson(ref))).size ||
      supported !== (entry.blocker_codes.length === 0) ||
      (supported &&
        (entry.qualification_scope !== "live_qualified" || entry.graph_component_ref === null)) ||
      entry.material_gap !== (entry.materiality === "material" && !supported) ||
      (entry.support === "complemented") !== (entry.complement_evidence_ref !== null)
    ) {
      throw new ScaP03ContractError("SCA P03 graph support entry overstates fidelity");
    }
  }
  if (matrix.complete !== matrix.entries.every((entry) => !entry.material_gap)) {
    throw new ScaP03ContractError("SCA P03 graph support completeness is inconsistent");
  }
  return matrix;
}

export function deriveScaP03GraphSupportEntriesV1(input: {
  readonly requirements: readonly ScaP03FidelityRequirementV1[];
  readonly observations: readonly ScaP03FidelityObservationV2[];
  readonly qualification_scope: ScaP03GraphSupportEntryV1["qualification_scope"];
  readonly graph_component_refs: Readonly<Record<ScaP03Partition, ArtifactRef | undefined>>;
  readonly evidence_refs: Readonly<Record<ScaP03Partition, readonly ArtifactRef[]>>;
  readonly qualified_complement_requirement_ids: ReadonlySet<string>;
}): readonly ScaP03GraphSupportEntryV1[] {
  if (input.qualified_complement_requirement_ids.size !== 0)
    throw new ScaP03ContractError("SCA P03 cannot promote unverified complement declarations");
  const observations = new Map(input.observations.map((entry) => [entry.requirement_id, entry]));
  if (observations.size !== input.observations.length) {
    throw new ScaP03ContractError("SCA P03 fidelity observations must be unique");
  }
  return input.requirements.map((requirement) => {
    const observation = observations.get(requirement.requirement_id);
    // Live scope comes from the guarded operation path, not a complement declaration.
    // Deterministic observations exercise contracts but cannot establish live fidelity.
    const supported =
      observation?.support === "supported" && input.qualification_scope === "live_qualified";
    const support =
      observation?.support === "supported" && !supported
        ? ("partial" as const)
        : (observation?.support ?? ("unsupported" as const));
    const reason =
      observation === undefined
        ? "fidelity_observation_missing"
        : observation.support === "supported"
          ? "isolation_unqualified"
          : (observation.reason_code ?? "fidelity_requirement_unsupported");
    const blockerCodes = supported ? [] : [reason];
    const partitionEvidence = input.evidence_refs[requirement.partition];
    if (partitionEvidence.length === 0) {
      throw new ScaP03ContractError(
        `SCA P03 fidelity requirement '${requirement.requirement_id}' lacks runtime evidence`
      );
    }
    return {
      requirement_id: requirement.requirement_id,
      dimension: requirement.dimension,
      subject: requirement.subject,
      partition: requirement.partition,
      materiality: requirement.materiality,
      support,
      material_gap: requirement.materiality === "material" && !supported,
      qualification_scope: input.qualification_scope,
      blocker_codes: blockerCodes,
      graph_component_ref: input.graph_component_refs[requirement.partition] ?? null,
      complement_evidence_ref: null,
      evidence_refs: [...partitionEvidence],
    };
  });
}

export function validateScaP03BaselineQueryAggregateV2(
  value: unknown
): ScaP03BaselineQueryAggregateV2 {
  const aggregate = validateBoundArtifact(
    ScaP03BaselineQueryAggregateV2Schema,
    value,
    "SCA P03 baseline query aggregate",
    "aggregate_sha256"
  );
  assertExactOrder(
    aggregate.batches.map((entry) => entry.partition),
    SCA_P03_PARTITIONS.slice(0, aggregate.batches.length),
    "baseline aggregate partitions"
  );
  for (const batch of aggregate.batches) {
    assertExactOrder(batch.ordered_query_ids, SCA_P03_QUERY_IDS, "aggregate query IDs");
  }
  if (
    aggregate.complete !== aggregate.batches.every((entry) => entry.complete && !entry.truncated)
  ) {
    throw new ScaP03ContractError("SCA P03 baseline aggregate completeness is inconsistent");
  }
  return aggregate;
}

export function validateScaP03GraphCandidatePacketV2(value: unknown): ScaP03GraphCandidatePacketV2 {
  const packet = validateBoundArtifact(
    ScaP03GraphCandidatePacketV2Schema,
    value,
    "SCA P03 graph candidate packet",
    "packet_sha256"
  );
  assertUnique(
    packet.candidates.map((entry) => entry.candidate_id),
    "graph candidate IDs"
  );
  for (const candidate of packet.candidates) {
    if (
      candidate.graph_component_sha256 !== candidate.graph_component_ref.content_digest ||
      candidate.page_ref.content_schema?.schema_id !== SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA
    )
      throw new ScaP03ContractError("SCA P03 packet candidate is not bound to a V2 page/graph");
    const {
      partition: _partition,
      accounted_paths: _paths,
      graph_component_ref: _graph,
      page_ref: _page,
      ...item
    } = candidate;
    validateScaP03QueryCandidateV2(item, {
      query_id: candidate.query_id,
      graph_component_sha256: candidate.graph_component_ref.content_digest,
      source_snapshot_sha256: packet.source_snapshot_sha256,
      query_release_sha256: candidate.query_release_sha256,
      accounted_paths: candidate.accounted_paths,
    });
  }
  if (packet.complete && !packet.source_bound) {
    throw new ScaP03ContractError("complete P03 candidate packet must be source-bound");
  }
  return packet;
}

/** Exhaustive extraction/accounting, not a safety verdict or all-supported disposition test.
 * Callers exact-read/validate pages and reconcile them to the query-result descriptors first.
 * No self-digest can authorize omission, duplication, modification or relabelling of a row.
 */
export function validateScaP03PacketAgainstQueryPagesV2(input: {
  readonly packet: ScaP03GraphCandidatePacketV2;
  readonly aggregate: ScaP03BaselineQueryAggregateV2;
  readonly graph_manifest: ScaP03GraphManifestV1;
  readonly pages: readonly {
    readonly ref: ArtifactRef;
    readonly page: ScaP03BaselineQueryPageV2;
  }[];
}): void {
  const { packet, aggregate, graph_manifest: graph, pages } = input;
  for (const key of [
    "tenant_id",
    "project_id",
    "run_id",
    "phase_id",
    "p01_binding_sha256",
    "p02_binding_sha256",
    "p03_runtime_binding_sha256",
    "source_snapshot_ref",
    "source_snapshot_sha256",
  ] as const) {
    if (!same(packet[key], aggregate[key]) || !same(packet[key], graph[key]))
      throw new ScaP03ContractError("SCA P03 packet/query/graph cohort mismatch");
  }
  if (!same(packet.baseline_query_set_ref, aggregate.baseline_query_set_ref))
    throw new ScaP03ContractError("SCA P03 packet query release mismatch");
  const expectedRefs = aggregate.batches.flatMap((batch) => batch.page_refs);
  assertUnique(
    expectedRefs.map((ref) => ref.artifact_id),
    "packet source page refs"
  );
  if (
    !same(
      pages.map((entry) => entry.ref),
      expectedRefs
    )
  )
    throw new ScaP03ContractError(
      "SCA P03 packet source pages are missing, duplicated or reordered"
    );
  const expected = aggregate.batches
    .flatMap((batch) => {
      const component = graph.components.find((entry) => entry.partition === batch.partition);
      if (
        component === undefined ||
        !same(component.graph_component_ref, batch.graph_component_ref)
      )
        throw new ScaP03ContractError("SCA P03 packet graph partition mismatch");
      return batch.page_refs.flatMap((ref) => {
        const entry = pages.find((entry) => entry.ref.artifact_id === ref.artifact_id);
        if (entry === undefined)
          throw new ScaP03ContractError("SCA P03 packet source page missing");
        const page = entry.page;
        if (
          page.run_id !== packet.run_id ||
          page.partition !== batch.partition ||
          !same(page.source_snapshot_ref, packet.source_snapshot_ref) ||
          page.source_snapshot_sha256 !== packet.source_snapshot_sha256 ||
          !same(page.baseline_query_set_ref, packet.baseline_query_set_ref) ||
          !same(page.graph_component_ref, batch.graph_component_ref)
        )
          throw new ScaP03ContractError("SCA P03 packet source page binding mismatch");
        return page.items.map((item) => ({
          ...item,
          partition: batch.partition,
          accounted_paths: page.accounted_paths,
          graph_component_ref: batch.graph_component_ref,
          page_ref: ref,
        }));
      });
    })
    .sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
  assertUnique(
    expected.map((item) => item.candidate_id),
    "packet source candidate IDs"
  );
  if (!same(packet.candidates, expected))
    throw new ScaP03ContractError("SCA P03 packet candidates differ from exact query pages");
  const sourceBound = graph.complete && aggregate.complete;
  if (
    packet.source_bound !== sourceBound ||
    packet.complete !== (sourceBound && expected.every((item) => !item.truncated))
  )
    throw new ScaP03ContractError(
      "SCA P03 packet completeness differs from full extraction/accounting"
    );
}

export function validateScaP03CoverageMatrixV1(value: unknown): ScaP03CoverageMatrixV1 {
  const matrix = validateBoundArtifact(
    ScaP03CoverageMatrixV1Schema,
    value,
    "SCA P03 coverage matrix",
    "coverage_sha256"
  );
  assertExactOrder(
    matrix.entries.map((entry) => entry.coverage_id),
    SCA_P03_COVERAGE_IDS,
    "P03 coverage IDs"
  );
  for (const entry of matrix.entries) {
    if ((entry.status === "complete") !== (entry.blocker_codes.length === 0)) {
      throw new ScaP03ContractError("P03 coverage status contradicts blockers");
    }
  }
  return matrix;
}

export function validateScaP03OperationLogV1(value: unknown): ScaP03OperationLogV1 {
  const log = validateBoundArtifact(
    ScaP03OperationLogV1Schema,
    value,
    "SCA P03 operation log",
    "log_sha256"
  );
  const expected = [
    SCA_P03_OPERATION_IDS.qualify,
    SCA_P03_OPERATION_IDS.build_php,
    SCA_P03_OPERATION_IDS.build_javascript_typescript,
    SCA_P03_OPERATION_IDS.query_php,
    SCA_P03_OPERATION_IDS.query_javascript_typescript,
  ];
  assertExactOrder(
    log.operations.map((entry) => entry.operation_id),
    expected.slice(0, log.operations.length),
    "P03 operation log"
  );
  return log;
}

export const validateScaP03QualificationEvidenceV1 = (
  value: unknown
): ScaP03QualificationEvidenceV1 =>
  validateBoundArtifact(
    ScaP03QualificationEvidenceV1Schema,
    value,
    "SCA P03 qualification evidence",
    "evidence_sha256"
  );

export function validateScaP03QualificationRecordV2(value: unknown): ScaP03QualificationRecordV2 {
  const record = validateBoundArtifact(
    ScaP03QualificationRecordV2Schema,
    value,
    "SCA P03 qualification record",
    "record_sha256"
  );
  if (
    (record.status === "passed") !==
    (record.live_qualified && record.blocker_codes.length === 0)
  ) {
    throw new ScaP03ContractError("SCA P03 qualification record overstates live qualification");
  }
  return record;
}

export const validateScaP03ZeroModelEvidenceV1 = (value: unknown): ScaP03ZeroModelEvidenceV1 =>
  validateBoundArtifact(
    ScaP03ZeroModelEvidenceV1Schema,
    value,
    "SCA P03 zero-model evidence",
    "evidence_sha256"
  );

export function validateScaP03EvidenceManifestV2(value: unknown): ScaP03EvidenceManifestV2 {
  const manifest = validateBoundArtifact(
    ScaP03EvidenceManifestV2Schema,
    value,
    "SCA P03 evidence manifest",
    "manifest_sha256"
  );
  const expected = [
    SCA_P03_OPERATION_IDS.qualify,
    SCA_P03_OPERATION_IDS.build_php,
    SCA_P03_OPERATION_IDS.build_javascript_typescript,
    SCA_P03_OPERATION_IDS.query_php,
    SCA_P03_OPERATION_IDS.query_javascript_typescript,
  ];
  assertExactOrder(
    manifest.operations.map((entry) => entry.operation_id),
    expected.slice(0, manifest.operations.length),
    "P03 evidence operations"
  );
  return manifest;
}

export function validateScaP03SuccessorLedgerV1(value: unknown): ScaP03SuccessorLedgerV1 {
  const ledger = validateBoundArtifact(
    ScaP03SuccessorLedgerV1Schema,
    value,
    "SCA P03 successor ledger",
    "ledger_sha256"
  );
  assertExactOrder(
    ledger.dispositions.map((entry) => entry.obligation_id),
    SCA_P03_OBLIGATION_IDS,
    "P03 successor obligations"
  );
  if (ledger.prior_p02_ledger_sha256 !== ledger.prior_p02_ledger_ref.content_digest) {
    throw new ScaP03ContractError("P03 successor ledger predecessor digest is stale");
  }
  return ledger;
}

export function validateScaP03GateV1(value: unknown): ScaP03GateV1 {
  const gate = validateBoundArtifact(ScaP03GateV1Schema, value, "SCA P03 gate", "gate_sha256");
  if (
    (gate.status === "passed") !==
    (gate.isolation_scope === "live_qualified" && gate.blocker_codes.length === 0)
  ) {
    throw new ScaP03ContractError("SCA P03 gate pass/blocker/isolation status is inconsistent");
  }
  return gate;
}

export function validateScaP03P04TransitionV2(value: unknown): ScaP03P04TransitionV2 {
  const transition = validateBoundArtifact(
    ScaP03P04TransitionV2Schema,
    value,
    "SCA P03 to P04 transition",
    "transition_sha256"
  );
  return transition;
}

export function validateScaP03TransitionAgainstGateV1(input: {
  readonly transition: unknown;
  readonly gate: unknown;
  readonly gate_ref: ArtifactRef;
  readonly request_ref: ArtifactRef;
  readonly p02_m1_ref: ArtifactRef;
  readonly p02_evidence_manifest_ref: ArtifactRef;
}): ScaP03P04TransitionV2 {
  const transition = validateScaP03P04TransitionV2(input.transition);
  const gate = validateScaP03GateV1(input.gate);
  if (
    gate.status !== "passed" ||
    gate.blocker_codes.length !== 0 ||
    gate.isolation_scope !== "live_qualified" ||
    !same(transition.gate_ref, input.gate_ref) ||
    !same(transition.p03_request_ref, input.request_ref) ||
    !same(transition.p02_m1_ref, input.p02_m1_ref) ||
    !same(transition.p02_evidence_manifest_ref, input.p02_evidence_manifest_ref) ||
    !same(transition.p03_request_ref, gate.p03_request_ref) ||
    !same(transition.entry_admission_ref, gate.entry_admission_ref) ||
    !same(transition.qualification_record_ref, gate.qualification_record_ref) ||
    !same(transition.graph_manifest_ref, gate.graph_manifest_ref) ||
    !same(transition.graph_support_matrix_ref, gate.graph_support_matrix_ref) ||
    !same(transition.baseline_query_aggregate_ref, gate.baseline_query_aggregate_ref) ||
    !same(transition.candidate_packet_ref, gate.candidate_packet_ref) ||
    !same(transition.coverage_matrix_ref, gate.coverage_matrix_ref) ||
    !same(transition.evidence_manifest_ref, gate.evidence_manifest_ref) ||
    !same(transition.successor_ledger_ref, gate.successor_ledger_ref) ||
    !same(transition.zero_model_evidence_ref, gate.zero_model_evidence_ref) ||
    transition.p01_binding_sha256 !== gate.p01_binding_sha256 ||
    transition.p02_binding_sha256 !== gate.p02_binding_sha256 ||
    transition.p03_runtime_binding_sha256 !== gate.p03_runtime_binding_sha256 ||
    !same(transition.source_snapshot_ref, gate.source_snapshot_ref) ||
    transition.source_snapshot_sha256 !== gate.source_snapshot_sha256
  ) {
    throw new ScaP03ContractError("P04 transition requires the exact positive P03 gate");
  }
  return transition;
}

export const validateScaP03TerminalV2 = (value: unknown): ScaP03TerminalV2 =>
  parse(ScaP03TerminalV2Schema, value, "SCA P03 terminal");

// The source oracle and validation receipt are shared exact-byte authority contracts.
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const PackageIdentity = Type.Object(
  {
    package_name: Type.String(),
    version: Type.String(),
    package_json_sha256: Digest,
    javascript_entrypoint_sha256: Digest,
    native_binding_sha256: Digest,
  },
  { additionalProperties: false }
);
const ParserIdentity = Type.Object(
  {
    runtime: PackageIdentity,
    grammars: Type.Tuple([
      Type.Object(
        { ...PackageIdentity.properties, language: Type.Literal("php"), query_sha256: Digest },
        { additionalProperties: false }
      ),
      Type.Object(
        {
          ...PackageIdentity.properties,
          language: Type.Literal("javascript"),
          query_sha256: Digest,
        },
        { additionalProperties: false }
      ),
      Type.Object(
        {
          ...PackageIdentity.properties,
          language: Type.Literal("typescript"),
          query_sha256: Digest,
        },
        { additionalProperties: false }
      ),
    ]),
    identity_sha256: Digest,
  },
  { additionalProperties: false }
);
const MaterialCase = Type.Object(
  {
    query_id: Type.String(),
    assertions: Type.Array(ScaP03OracleAssertionV2Schema, { minItems: 1 }),
  },
  { additionalProperties: false }
);
const Mark = Type.Object(
  {
    line: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
const Fixture = Type.Object(
  {
    fixture_id: Type.String(),
    language: Type.Union([
      Type.Literal("javascript"),
      Type.Literal("typescript"),
      Type.Literal("php"),
    ]),
    path: Type.String(),
    file: Type.String(),
    byte_length: Type.Integer({ minimum: 1 }),
    content_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    symbols: Type.Array(Mark, { minItems: 3 }),
    symbol_negative: Mark,
    call: Type.Object(
      { caller: Mark, site: Mark, callee: Mark, negative: Mark },
      { additionalProperties: false }
    ),
    guard: Type.Object(
      {
        condition: Mark,
        action: Mark,
        expected_branch: Type.Literal("true"),
        negative_branch: Type.Literal("false"),
        negative: Mark,
      },
      { additionalProperties: false }
    ),
    reaching_definition: Type.Object(
      { source: Mark, assignments: Type.Array(Mark, { minItems: 1 }), sink: Mark, negative: Mark },
      { additionalProperties: false }
    ),
    material_cases: Type.Array(MaterialCase, { minItems: 7, maxItems: 7 }),
    registration: Type.Object(
      {
        framework: Type.Union([
          Type.Literal("express"),
          Type.Literal("nestjs"),
          Type.Literal("wordpress"),
        ]),
        form: Type.String(),
        site: Mark,
        callback: Mark,
        negative: Mark,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
const Oracle = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-source-oracle.v2"),
    schema_version: Type.Literal(2),
    note: Type.String(),
    material_dimensions: Type.Tuple([
      Type.Literal("symbol"),
      Type.Literal("call"),
      Type.Literal("guard"),
      Type.Literal("reaching_definition"),
      Type.Literal("registration"),
    ]),
    fixtures: Type.Array(Fixture, { minItems: 3, maxItems: 3 }),
    parser: ParserIdentity,
    oracle_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false }
);
export type SourceFixture = Static<typeof Fixture>;
export type SourceMark = Static<typeof Mark>;
export type SourceOracle = Static<typeof Oracle>;

/** Closed, independent source oracle: no runtime observation or graph identity is an input. */
export function parseSourceOracleBytes(bytes: Uint8Array): Static<typeof Oracle> {
  if (bytes.byteLength > SCA_P03_MAX_ORACLE_BYTES) throw new Error("P03 oracle exceeds byte limit");
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes)))
    throw new Error("P03 oracle invalid UTF-8");
  const json: unknown = JSON.parse(text);
  if (canonicalJson(json) !== text) throw new Error("P03 oracle noncanonical or duplicate keys");
  const oracle = validateContract(Oracle, json, "P03 source oracle");
  const { oracle_sha256, ...unsigned } = oracle;
  if (sha256(canonicalJson(unsigned)) !== oracle_sha256) throw new Error("P03 oracle digest drift");
  if (
    sha256(canonicalJson({ runtime: oracle.parser.runtime, grammars: oracle.parser.grammars })) !==
    oracle.parser.identity_sha256
  )
    throw new Error("P03 oracle parser identity digest drift");
  if (
    oracle.fixtures.map((f) => f.fixture_id).join(",") !==
      [...oracle.fixtures.map((f) => f.fixture_id)].sort().join(",") ||
    new Set(oracle.fixtures.map((f) => f.fixture_id)).size !== 3
  )
    throw new Error("P03 oracle fixture ID ordering drift");
  if (
    oracle.fixtures.map((f) => f.language).join(",") !== "javascript,php,typescript" ||
    new Set(oracle.fixtures.map((f) => f.path)).size !== 3
  )
    throw new Error("P03 oracle fixture roster drift");
  return oracle;
}

export function validateSourceFixture(fixture: SourceFixture, bytes: Uint8Array): void {
  if (bytes.byteLength !== fixture.byte_length || sha256(bytes) !== fixture.content_sha256)
    throw new Error("P03 fixture byte drift");
  const lines = Buffer.from(bytes).toString("utf8").split("\n");
  const marks = [
    ...fixture.symbols,
    fixture.symbol_negative,
    fixture.call.caller,
    fixture.call.site,
    fixture.call.callee,
    fixture.call.negative,
    fixture.guard.condition,
    fixture.guard.action,
    fixture.guard.negative,
    fixture.reaching_definition.source,
    ...fixture.reaching_definition.assignments,
    fixture.reaching_definition.sink,
    fixture.reaching_definition.negative,
    fixture.registration.site,
    fixture.registration.callback,
    fixture.registration.negative,
  ];
  for (const group of [fixture.symbols, fixture.reaching_definition.assignments]) {
    const keys = group.map((m) => `${m.line}:${m.name}`);
    if (
      new Set(keys).size !== keys.length ||
      keys.join(",") !==
        [...keys].sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0])).join(",")
    )
      throw new Error("P03 oracle mark order/uniqueness drift");
  }
  const ids = fixture.material_cases.map((c) => c.query_id);
  if (
    ids.join(",") !==
    [
      "p03.graph-integrity.v2",
      "p03.symbol-entrypoint-index.v2",
      "p03.call-resolution.v2",
      "p03.control-guard.v2",
      "p03.dataflow-source-sink.v2",
      "p03.framework-dispatch.v2",
      "p03.unsupported-surface.v2",
    ].join(",")
  )
    throw new Error("P03 oracle query roster drift");
  for (const entry of fixture.material_cases) {
    const keys = entry.assertions.map((a) => canonicalJson(a));
    if (
      new Set(keys).size !== keys.length ||
      keys.join("|") !== [...keys].sort((a, b) => a.localeCompare(b)).join("|")
    )
      throw new Error("P03 oracle assertion ordering drift");
  }
  const selector = (mark: SourceMark, role: string) => ({
    path: fixture.path,
    name: mark.name,
    line: mark.line,
    role,
  });
  const checkCase = (
    id: string,
    start: SourceMark | null,
    startRole: string,
    end: SourceMark | null,
    endRole: string,
    negative: SourceMark | null,
    via: readonly SourceMark[] = []
  ) => {
    const entry = fixture.material_cases.find((item) => item.query_id === id);
    const positive = entry?.assertions.find((item) => item.expectation === "present");
    const absence = entry?.assertions.find((item) => item.expectation === "absent");
    const semantics: Record<string, readonly [string, string, string, string | null]> = {
      "p03.graph-integrity.v2": ["symbol_or_entrypoint", "observation", "supported", null],
      "p03.symbol-entrypoint-index.v2": ["symbol_or_entrypoint", "observation", "supported", null],
      "p03.call-resolution.v2": ["call_or_unresolved_call", "call_resolution", "supported", "call"],
      "p03.control-guard.v2": [
        "guard_or_control_relationship",
        "control_reachability",
        "supported",
        "dispatch",
      ],
      "p03.dataflow-source-sink.v2": [
        "source_to_sink_flow",
        "reaching_definition",
        "supported",
        "reaching_def",
      ],
      "p03.framework-dispatch.v2": [
        "route_or_framework_surface",
        "framework_dispatch",
        "supported",
        "dispatch",
      ],
      "p03.unsupported-surface.v2": [
        "unsupported_or_unresolved_surface",
        "unsupported_surface",
        "unresolved",
        null,
      ],
    };
    const expected = semantics[id];
    if (
      !expected ||
      entry?.assertions.length !== (id === "p03.graph-integrity.v2" ? 1 : 2) ||
      positive?.candidate_kind !== expected[0] ||
      positive.claim !== expected[1] ||
      (positive.disposition !== expected[2] &&
        !(
          ["p03.control-guard.v2", "p03.framework-dispatch.v2"].includes(id) &&
          positive.disposition === "unresolved" &&
          positive.reason_code === "relationship_unproven" &&
          positive.edge?.provenance === "observed_cpg" &&
          absence?.disposition === "unresolved" &&
          absence.reason_code === "relationship_unproven" &&
          absence.edge?.provenance === "observed_cpg" &&
          absence.edge.kind === positive.edge.kind &&
          absence.edge.branch_orientation === null &&
          positive.edge.branch_orientation === null &&
          (id !== "p03.framework-dispatch.v2" ||
            (positive.callback_resolution === "dynamic" &&
              absence.callback_resolution === "dynamic" &&
              positive.framework === null &&
              absence.framework === null &&
              positive.registration_form === null &&
              absence.registration_form === null))
        )) ||
      (positive.edge?.kind ?? null) !==
        (id === "p03.control-guard.v2" && positive.disposition === "unresolved"
          ? "cfg"
          : id === "p03.framework-dispatch.v2" && positive.disposition === "unresolved"
            ? "call"
            : expected[3]) ||
      (absence !== undefined &&
        (absence.candidate_kind !== expected[0] || absence.claim !== expected[1])) ||
      (["p03.control-guard.v2", "p03.framework-dispatch.v2"].includes(id) &&
        positive.disposition === "supported" &&
        [positive, absence].some(
          (assertion) =>
            assertion?.edge?.provenance !== "qualified_complement" ||
            assertion.edge.kind !== "dispatch" ||
            assertion.disposition !== "supported"
        )) ||
      (id === "p03.dataflow-source-sink.v2" &&
        [positive, absence].some(
          (assertion) =>
            assertion?.edge?.provenance !==
              (fixture.language === "javascript" ? "observed_cpg" : "qualified_complement") ||
            assertion.edge?.branch_orientation !== null
        )) ||
      (id === "p03.control-guard.v2" &&
        positive.disposition === "supported" &&
        (positive.edge?.branch_orientation !== "true" ||
          absence?.edge?.branch_orientation !== "false")) ||
      (id === "p03.unsupported-surface.v2" &&
        (positive.reason_code !== "relationship_unproven" || absence?.disposition !== "supported"))
    )
      throw new Error("P03 oracle material semantics drift");
    if (
      !positive ||
      (start !== null &&
        canonicalJson(positive.start) !== canonicalJson(selector(start, startRole))) ||
      (end !== null && canonicalJson(positive.end) !== canonicalJson(selector(end, endRole))) ||
      (via.length > 0 &&
        canonicalJson(positive.via) !==
          canonicalJson(via.map((mark) => selector(mark, "unknown")))) ||
      (negative !== null &&
        canonicalJson(absence?.end ?? absence?.start) !==
          canonicalJson(selector(negative, end === null ? startRole : endRole)))
    )
      throw new Error("P03 oracle material selector drift");
  };
  checkCase("p03.graph-integrity.v2", fixture.symbols[0] ?? null, "symbol", null, "", null);
  checkCase(
    "p03.symbol-entrypoint-index.v2",
    fixture.symbols[0] ?? null,
    "symbol",
    null,
    "",
    fixture.symbol_negative
  );
  checkCase(
    "p03.call-resolution.v2",
    fixture.call.site,
    "call_site",
    fixture.call.callee,
    "callee",
    fixture.symbol_negative
  );
  checkCase(
    "p03.control-guard.v2",
    fixture.guard.condition,
    "guard",
    fixture.guard.action,
    "action",
    fixture.guard.negative
  );
  checkCase(
    "p03.dataflow-source-sink.v2",
    fixture.reaching_definition.source,
    "source",
    fixture.reaching_definition.sink,
    "sink",
    fixture.reaching_definition.negative,
    fixture.reaching_definition.assignments
  );
  checkCase(
    "p03.framework-dispatch.v2",
    fixture.registration.site,
    "registration",
    fixture.registration.callback,
    "handler",
    fixture.symbols.find(
      (mark) => mark.name === (fixture.language === "php" ? "decoy_handler" : "decoyHandler")
    ) ?? null
  );
  checkCase("p03.unsupported-surface.v2", fixture.symbol_negative, "symbol", null, "", null);
  for (const mark of marks)
    if (lines[mark.line - 1] !== mark.text || !mark.text.includes(mark.name))
      throw new Error("P03 oracle line drift");
  if (
    fixture.symbols.some((symbol) => symbol.name === fixture.symbol_negative.name) ||
    fixture.call.site.name === fixture.call.negative.name ||
    fixture.reaching_definition.sink.name === fixture.reaching_definition.negative.name ||
    fixture.registration.callback.name === fixture.registration.negative.name
  )
    throw new Error("P03 oracle negative collapsed");
}

/** Projection is independent of graph output, caller-provided corpus selectors, and observation hashes. */
export function projectSourceOracleCases(
  oracle: SourceOracle
): ScaP03QualificationFixtureCorpusV2["expected_cases"] {
  const order = ["php", "javascript", "typescript"] as const;
  return order.flatMap((language) => {
    const fixture = oracle.fixtures.find((entry) => entry.language === language);
    if (fixture === undefined) throw new Error("P03 oracle fixture language missing");
    return SCA_P03_QUERY_IDS.map((query_id) => {
      const material = fixture.material_cases.find((entry) => entry.query_id === query_id);
      if (material === undefined) throw new Error("P03 oracle query missing");
      return {
        case_id: `p03-${language}-${query_id.replaceAll(".", "-")}`,
        language,
        query_id,
        expected_observed_sha256: null,
        oracle_assertions: material.assertions,
      };
    });
  });
}

/** Exact source selectors; never infer a missing match from an observation hash. */
export function matchesSourceMark(
  vertex: { path: string | null; line: number | null; name: string | null },
  fixture: SourceFixture,
  mark: SourceMark
): boolean {
  return vertex.path === fixture.path && vertex.line === mark.line && vertex.name === mark.name;
}

/** Offline review selectors; graph IDs and observation digests are deliberately irrelevant. */
export function matchesSourceRelationship(
  fixture: SourceFixture,
  dimension: "call" | "reaching_definition" | "registration",
  start: { path: string | null; line: number | null; name: string | null },
  end: { path: string | null; line: number | null; name: string | null }
): boolean {
  const marks =
    dimension === "call"
      ? [fixture.call.site, fixture.call.callee]
      : dimension === "reaching_definition"
        ? [fixture.reaching_definition.source, fixture.reaching_definition.sink]
        : [fixture.registration.site, fixture.registration.callback];
  const [source, sink] = marks;
  return (
    source !== undefined &&
    sink !== undefined &&
    matchesSourceMark(start, fixture, source) &&
    matchesSourceMark(end, fixture, sink)
  );
}

const FixtureBinding = Type.Object(
  {
    fixture_id: Type.String({ minLength: 1 }),
    language: Type.Union([
      Type.Literal("php"),
      Type.Literal("javascript"),
      Type.Literal("typescript"),
    ]),
    content_ref: ArtifactRefSchema,
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export const SourceOracleValidationReceiptSchema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA),
    schema_version: Type.Literal(1),
    producer: Type.Literal(SCA_P03_SOURCE_ORACLE_VALIDATOR),
    status: Type.Literal("PASS"),
    oracle_ref: ArtifactRefSchema,
    oracle_sha256: Sha256Schema,
    review_ref: ArtifactRefSchema,
    parser_identity_sha256: Sha256Schema,
    fixtures: Type.Tuple([FixtureBinding, FixtureBinding, FixtureBinding]),
    corpus_ref: ArtifactRefSchema,
    corpus_sha256: Sha256Schema,
    expected_cases: ScaP03QualificationFixtureCorpusV2Schema.properties.expected_cases,
    validated_at: Rfc3339UtcSchema,
    receipt_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA }
);
export type SourceOracleValidationReceipt = Readonly<
  Static<typeof SourceOracleValidationReceiptSchema>
>;

function equal(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Parses the receipt without mistaking a caller-authored JSON object for host provenance. */
export function parseSourceOracleValidationReceiptBytes(
  bytes: Uint8Array
): SourceOracleValidationReceipt {
  if (bytes.byteLength > SCA_P03_MAX_ORACLE_BYTES)
    throw new Error("p03_source_oracle_receipt_too_large");
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes)))
    throw new Error("p03_source_oracle_receipt_invalid_utf8");
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("p03_source_oracle_receipt_noncanonical");
  const receipt = validateContract(
    SourceOracleValidationReceiptSchema,
    value,
    "P03 source oracle validation receipt"
  );
  const { receipt_sha256, ...unsigned } = receipt;
  if (sha256(canonicalJson(unsigned)) !== receipt_sha256)
    throw new Error("p03_source_oracle_receipt_digest_mismatch");
  return receipt;
}

/** Exact byte and semantic correspondence; callers separately verify every ref's manifest custody. */
export function assertSourceOracleReceiptCorrespondence(input: {
  readonly oracle: SourceOracle;
  readonly oracle_ref: ArtifactRef;
  readonly receipt: SourceOracleValidationReceipt;
  readonly review_ref: ArtifactRef;
  readonly corpus: ScaP03QualificationFixtureCorpusV2;
  readonly corpus_ref: ArtifactRef;
  readonly fixtures: readonly {
    readonly ref: ArtifactRef;
    readonly fixture_id: string;
    readonly language: "php" | "javascript" | "typescript";
    readonly path: string;
    readonly content_sha256: string;
    readonly bytes: Uint8Array;
  }[];
}): void {
  const { oracle, receipt, corpus, fixtures } = input;
  const ordered = (["php", "javascript", "typescript"] as const).map((language) => {
    const f = fixtures.find((fixture) => fixture.language === language);
    if (f === undefined || fixtures.filter((fixture) => fixture.language === language).length !== 1)
      throw new Error("p03_source_oracle_fixture_roster_mismatch");
    return f;
  });
  if (
    fixtures.length !== 3 ||
    !equal(receipt.oracle_ref, input.oracle_ref) ||
    !equal(receipt.review_ref, input.review_ref) ||
    !equal(receipt.corpus_ref, input.corpus_ref) ||
    !equal(
      corpus.fixture_content_refs,
      ordered.map((f) => f.ref)
    ) ||
    !equal(
      corpus.fixture_ids,
      ordered.map((f) => f.fixture_id)
    ) ||
    !equal(
      receipt.fixtures,
      ordered.map((fixture) => {
        const entry = oracle.fixtures.find((f) => f.language === fixture.language);
        if (entry === undefined) throw new Error("p03_source_oracle_fixture_roster_mismatch");
        return {
          fixture_id: entry.fixture_id,
          language: entry.language,
          content_ref: fixture.ref,
          content_sha256: entry.content_sha256,
        };
      })
    ) ||
    receipt.oracle_sha256 !== oracle.oracle_sha256 ||
    receipt.parser_identity_sha256 !== oracle.parser.identity_sha256 ||
    receipt.corpus_sha256 !== corpus.corpus_sha256 ||
    !equal(receipt.expected_cases, corpus.expected_cases) ||
    !equal(projectSourceOracleCases(oracle), corpus.expected_cases)
  )
    throw new Error("p03_source_oracle_corpus_mismatch");
  for (const fixture of ordered) {
    const reviewed = oracle.fixtures.find((entry) => entry.language === fixture.language);
    if (
      reviewed === undefined ||
      reviewed.fixture_id !== fixture.fixture_id ||
      reviewed.path !== fixture.path ||
      reviewed.content_sha256 !== fixture.content_sha256
    )
      throw new Error("p03_source_oracle_fixture_mismatch");
    validateSourceFixture(reviewed, fixture.bytes);
  }
}

/** The validator returns immutable bytes; persistence and review provenance belong to the host. */
export function sealSourceOracleValidationReceipt(
  input: Omit<
    SourceOracleValidationReceipt,
    "schema_id" | "schema_version" | "producer" | "status" | "receipt_sha256"
  >
): SourceOracleValidationReceipt {
  const unsigned = {
    schema_id: SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
    schema_version: 1 as const,
    producer: SCA_P03_SOURCE_ORACLE_VALIDATOR,
    status: "PASS" as const,
    ...input,
  };
  return parseSourceOracleValidationReceiptBytes(
    Buffer.from(
      canonicalJson({
        ...unsigned,
        receipt_sha256: sha256(canonicalJson(unsigned)),
      })
    )
  );
}

/** Independently persisted review pins selectors, not just mutable caller corpus hashes. */
export const SourceOracleReviewV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA),
    schema_version: Type.Literal(1),
    producer: Type.Literal(SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER),
    oracle_sha256: Sha256Schema,
    parser_identity_sha256: Sha256Schema,
    fixture_content_sha256: Type.Tuple([Sha256Schema, Sha256Schema, Sha256Schema]),
    expected_cases: ScaP03QualificationFixtureCorpusV2Schema.properties.expected_cases,
    review_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA }
);
export type SourceOracleReviewV1 = Readonly<Static<typeof SourceOracleReviewV1Schema>>;

export function parseSourceOracleReviewV1Bytes(bytes: Uint8Array): SourceOracleReviewV1 {
  if (bytes.byteLength > SCA_P03_MAX_ORACLE_BYTES) throw new Error("P03 review too large");
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes)))
    throw new Error("P03 review invalid UTF-8");
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("P03 review noncanonical");
  const review = validateContract(SourceOracleReviewV1Schema, value, "P03 independent review");
  const { review_sha256, ...unsigned } = review;
  if (sha256(canonicalJson(unsigned)) !== review_sha256) throw new Error("P03 review digest drift");
  return review;
}
