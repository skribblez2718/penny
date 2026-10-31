import { Type, type Static } from "typebox";

import { type ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { RunContext } from "../context.js";
import {
  ArtifactRefSchema,
  validateContract,
  validateDirective,
  type ArtifactRef,
  type Directive,
  type HostOperationArtifactContractV1,
  type OutputArtifactMetadata,
  type SkillContract,
  type StartRequest,
} from "../contracts.js";
import {
  hostOperationLeaseProfileSha256,
  hostOperationPolicyBinding,
  validateHostOperationReceipt,
  type HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import type {
  HostContinuationCapabilityV1,
  HostContinuationStepV1,
  PlaybookCore,
} from "../playbooks/playbook.js";
import {
  runtimeRegistrationSha256,
  type PlaybookConstructionOptions,
  type PlaybookRegistration,
  type PreparedStartV1,
  type StartAdmissionV1,
} from "../playbooks/registry.js";
import {
  validateScaCampaignManifestCoreV1,
  validateScaP01SourceFileManifestV1,
} from "./p01-contracts.js";
import {
  admitScaP03Candidate,
  assertScaP03AuthorityContracts,
  scaP03InputArtifacts,
} from "./p03-admission.js";
import {
  SCA_P03_BASELINE_QUERY_AGGREGATE_V2_SCHEMA,
  SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA,
  SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA,
  SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA,
  SCA_P03_CANDIDATE_PRODUCER,
  SCA_P03_COVERAGE_MATRIX_V1_SCHEMA,
  SCA_P03_ENTRY_ADMISSION_V2_SCHEMA,
  SCA_P03_EVIDENCE_MANIFEST_V2_SCHEMA,
  SCA_P03_GATE_V1_SCHEMA,
  SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA,
  SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA,
  SCA_P03_GRAPH_CANDIDATE_PACKET_V2_SCHEMA,
  SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
  SCA_P03_GRAPH_MANIFEST_V1_SCHEMA,
  SCA_P03_GRAPH_PROVENANCE_V1_SCHEMA,
  SCA_P03_GRAPH_SUPPORT_MATRIX_V2_SCHEMA,
  SCA_P03_INPUT_SLOTS,
  parseSourceOracleValidationReceiptBytes,
  SCA_P03_MAX_GRAPH_OPERATION_BYTES,
  SCA_P03_OBLIGATION_IDS,
  SCA_P03_OPERATION_IDS,
  SCA_P03_OPERATION_LOG_V1_SCHEMA,
  SCA_P03_P04_TRANSITION_V2_SCHEMA,
  SCA_P03_PARTITIONS,
  SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA,
  SCA_P03_QUALIFICATION_RECORD_V2_SCHEMA,
  SCA_P03_QUALIFICATION_REQUEST_V2_SCHEMA,
  SCA_P03_QUALIFICATION_RESULT_V2_SCHEMA,
  SCA_P03_QUERY_IDS,
  SCA_P03_REQUEST_V2_SCHEMA,
  SCA_P03_SUCCESSOR_LEDGER_V1_SCHEMA,
  SCA_P03_TERMINAL_V2_SCHEMA,
  SCA_P03_ZERO_MODEL_EVIDENCE_V1_SCHEMA,
  ScaP03RequestV2Schema,
  deriveScaP03GraphSupportEntriesV1,
  validateScaP03BaselineQueryAggregateV2,
  validateScaP03BaselineQueryPageV2,
  validateScaP03FidelityComplementEvidenceV2,
  validateScaP03CoverageMatrixV1,
  validateScaP03EntryAdmissionV2,
  validateScaP03EvidenceManifestV2,
  validateScaP03GateV1,
  validateScaP03GraphCandidatePacketV2,
  validateScaP03PacketAgainstQueryPagesV2,
  validateScaP03GraphManifestV1,
  validateScaP03GraphProvenanceV1,
  validateScaP03GraphSupportMatrixV2,
  validateScaP03IsolationEvidenceV1,
  validateScaP03JoernRuntimeIdentityV1,
  validateScaP03OperationLogV1,
  validateScaP03OperationRequestV1,
  validateScaP03OperationResultV1,
  validateScaP03P04TransitionV2,
  validateScaP03QualificationEvidenceV1,
  validateScaP03QualificationFixtureCorpusV2,
  validateScaP03QualificationResultProjectionV2,
  validateScaP03QualificationProfileV2,
  validateScaP03QualificationRecordV2,
  validateScaP03RequestV2,
  validateScaP03RuntimePolicyV1,
  validateScaP03SuccessorLedgerV1,
  validateScaP03TerminalV2,
  validateScaP03TransitionAgainstGateV1,
  validateScaP03ZeroModelEvidenceV1,
  withScaP03Digest,
  type ScaP03BaselineQueryBatchRequestV2,
  type ScaP03GraphBuildRequestV1,
  type ScaP03OperationKind,
  type ScaP03OperationRequestV1,
  type ScaP03OperationResultV1,
  type ScaP03Partition,
} from "./p03-contracts.js";
import { SCA_P02_CANDIDATE_SKILL_CONTRACT } from "./p02-playbook.js";
import { validateScaP02SuccessorLedgerV1 } from "./p02-contracts.js";

export const SCA_P03_CANDIDATE_PLAYBOOK_NAME = "sca-p03-candidate" as const;
/** Accepted production phase; availability still requires durable activation. */
export const SCA_P03_PHASE_PLAYBOOK_NAME = "sca-p03" as const;
export const SCA_P03_START_V1_SCHEMA = "penny.sca-p03-start.v1";
const P03_PHASE = "SCA-P03";
const P03_PRODUCER = SCA_P03_CANDIDATE_PRODUCER;
const FINAL_STATE = "sca_p03_evaluating_gate";

const STEPS = Object.freeze([
  "qualify",
  "build_php",
  "build_javascript_typescript",
  "query_php",
  "query_javascript_typescript",
] as const);
type Step = (typeof STEPS)[number];

const STATE: Readonly<Record<Step, string>> = Object.freeze({
  qualify: "sca_p03_qualifying_joern",
  build_php: "sca_p03_building_graph_php",
  build_javascript_typescript: "sca_p03_building_graph_javascript_typescript",
  query_php: "sca_p03_running_queries_php",
  query_javascript_typescript: "sca_p03_running_queries_javascript_typescript",
});
const OPERATION_KIND: Readonly<Record<Step, string>> = Object.freeze({
  qualify: "sca.p03.qualify-joern.v1",
  build_php: "sca.p03.build-source-graph.v1",
  build_javascript_typescript: "sca.p03.build-source-graph.v1",
  query_php: "sca.p03.run-baseline-query-batch.v1",
  query_javascript_typescript: "sca.p03.run-baseline-query-batch.v1",
});
const DOMAIN_KIND: Readonly<Record<Step, ScaP03OperationKind>> = Object.freeze({
  qualify: "qualify_joern",
  build_php: "build_source_graph",
  build_javascript_typescript: "build_source_graph",
  query_php: "run_baseline_query_batch",
  query_javascript_typescript: "run_baseline_query_batch",
});
const OPERATION_ID: Readonly<Record<Step, string>> = Object.freeze({
  qualify: SCA_P03_OPERATION_IDS.qualify,
  build_php: SCA_P03_OPERATION_IDS.build_php,
  build_javascript_typescript: SCA_P03_OPERATION_IDS.build_javascript_typescript,
  query_php: SCA_P03_OPERATION_IDS.query_php,
  query_javascript_typescript: SCA_P03_OPERATION_IDS.query_javascript_typescript,
});

export const ScaP03StartConstraintsV1Schema = Type.Object(
  { p03_request: ScaP03RequestV2Schema },
  { additionalProperties: false, $id: SCA_P03_START_V1_SCHEMA }
);

function requestContract(step: Step): HostOperationArtifactContractV1 {
  const domainKind = DOMAIN_KIND[step];
  return {
    schema_version: 1,
    port_name: `p03_${step}_request`,
    artifact_kind:
      domainKind === "qualify_joern"
        ? "sca-p03-qualification-request"
        : domainKind === "build_source_graph"
          ? "sca-p03-graph-build-request"
          : "sca-p03-baseline-query-batch-request",
    schema_id:
      domainKind === "qualify_joern"
        ? SCA_P03_QUALIFICATION_REQUEST_V2_SCHEMA
        : domainKind === "build_source_graph"
          ? SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA
          : SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA,
    schema_version_required: domainKind === "build_source_graph" ? 1 : 2,
  };
}

function resultContract(step: Step): HostOperationArtifactContractV1 {
  const domainKind = DOMAIN_KIND[step];
  return {
    schema_version: 1,
    port_name: `p03_${step}_result`,
    artifact_kind:
      domainKind === "qualify_joern"
        ? "sca-p03-qualification-result"
        : domainKind === "build_source_graph"
          ? "sca-p03-graph-build-result"
          : "sca-p03-baseline-query-batch-result",
    schema_id:
      domainKind === "qualify_joern"
        ? SCA_P03_QUALIFICATION_RESULT_V2_SCHEMA
        : domainKind === "build_source_graph"
          ? SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA
          : SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA,
    schema_version_required: domainKind === "build_source_graph" ? 1 : 2,
  };
}

const GRAPH_OUTPUT_CONTRACT: HostOperationArtifactContractV1 = {
  schema_version: 1,
  port_name: "p03_graph_component",
  artifact_kind: "sca-p03-graph-component",
  schema_id: SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
  schema_version_required: 1,
};
const PAGE_OUTPUT_CONTRACT: HostOperationArtifactContractV1 = {
  schema_version: 1,
  port_name: "p03_baseline_query_page",
  artifact_kind: "sca-p03-baseline-query-page",
  schema_id: SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA,
  schema_version_required: 2,
};

function declaration(step: Step): HostOperationDeclarationV1 {
  const domainKind = DOMAIN_KIND[step];
  const adapterId =
    domainKind === "qualify_joern"
      ? "sca-p03-qualify-joern-adapter-v1"
      : domainKind === "build_source_graph"
        ? "sca-p03-build-source-graph-adapter-v1"
        : "sca-p03-run-baseline-query-batch-adapter-v1";
  const leaseBody = {
    profile_id: `sca-p03-${domainKind.replaceAll("_", "-")}-lease-v1`,
    profile_version: 1 as const,
    duration_ms: 300_000,
    renew_after_ms: 60_000,
    queue_inactivity_ms: 300_000,
  };
  const outputContracts =
    domainKind === "build_source_graph"
      ? [GRAPH_OUTPUT_CONTRACT]
      : domainKind === "run_baseline_query_batch"
        ? [PAGE_OUTPUT_CONTRACT]
        : [];
  return {
    schema_version: 1,
    operation_kind: OPERATION_KIND[step],
    adapter_id: adapterId,
    request: requestContract(step),
    result: resultContract(step),
    backend_binding_id: "sca-p03-joern-backend-v1",
    capability_classes: ["artifact_store"],
    lease_profile: {
      ...leaseBody,
      profile_sha256: hostOperationLeaseProfileSha256(leaseBody),
    },
    operation_inactivity_ms: 300_000,
    max_request_bytes: 64 * 1024 * 1024,
    max_input_artifacts: 512,
    max_input_bytes: 512 * 1024 * 1024,
    ...(outputContracts.length === 0 ? {} : { output_contracts: outputContracts }),
    max_output_artifacts:
      domainKind === "run_baseline_query_batch" ? 71 : domainKind === "build_source_graph" ? 2 : 1,
    max_output_bytes:
      domainKind === "run_baseline_query_batch"
        ? 96 * 1024 * 1024
        : domainKind === "build_source_graph"
          ? SCA_P03_MAX_GRAPH_OPERATION_BYTES
          : 8 * 1024 * 1024,
    max_progress_events: 4_096,
    max_pre_acceptance_retries: 1,
    recovery_semantics: "atomic_local_publication_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
}

export const SCA_P03_OPERATION_DECLARATIONS = Object.freeze({
  qualify: declaration("qualify"),
  build_source_graph: declaration("build_php"),
  run_baseline_query_batch: declaration("query_php"),
});

function declarationFor(step: Step): HostOperationDeclarationV1 {
  if (DOMAIN_KIND[step] === "qualify_joern") return SCA_P03_OPERATION_DECLARATIONS.qualify;
  if (DOMAIN_KIND[step] === "build_source_graph") {
    return SCA_P03_OPERATION_DECLARATIONS.build_source_graph;
  }
  return SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch;
}

function port(input: {
  readonly name: string;
  readonly kind: string;
  readonly schema: string;
  readonly version: number;
  readonly min?: number;
  readonly max?: number;
  readonly direction?: "input" | "output";
}) {
  const direction = input.direction ?? "input";
  return {
    schema_version: 1 as const,
    name: input.name,
    direction,
    transport: "artifact" as const,
    schema_id: input.schema,
    schema_version_required: input.version,
    artifact_kind: input.kind,
    source: direction === "input" ? ("caller" as const) : ("skill" as const),
    min_items: input.min ?? 1,
    max_items: input.max ?? 1,
    semantic_product: false,
  };
}

const P02_INPUT_PORTS = [
  port({
    name: "accepted_p02_qualification_definition",
    kind: "sca-p02-v3-definition-snapshot",
    schema: "penny.sca-p02-v3-definition-snapshot.v1",
    version: 1,
    min: 0,
  }),
  port({
    name: "accepted_p02_qualification_gate",
    kind: "sca-p02-phase-gate-v3",
    schema: "penny.sca-phase-gate-record.v3",
    version: 3,
    min: 0,
  }),
  ...SCA_P02_CANDIDATE_SKILL_CONTRACT.io.input_ports.map((entry, index) => ({
    ...entry,
    name: `accepted_p02_input_${String(index).padStart(2, "0")}_${entry.name}`,
  })),
  ...SCA_P02_CANDIDATE_SKILL_CONTRACT.io.active_output_ports.map((entry, index) => ({
    ...entry,
    name: `accepted_p02_output_${String(index).padStart(2, "0")}_${entry.name}`,
    direction: "input" as const,
    source: "caller" as const,
    min_items: 0,
  })),
  port({
    name: "p02_host_operation_receipts",
    kind: "host-operation-receipt",
    schema: "penny.host-operation-receipt.v1",
    version: 1,
    min: 0,
    max: 6,
  }),
];

const P03_AUTHORITY_PORTS = [
  port({
    name: "source_oracle",
    kind: "sca-p03-source-oracle",
    schema: "penny.sca-p03-source-oracle.v2",
    version: 2,
  }),
  port({
    name: "source_oracle_validation",
    kind: "sca-p03-source-oracle-validation",
    schema: "penny.sca-p03-source-oracle-validation.v1",
    version: 1,
  }),
  port({
    name: "sealed_bootstrap_inputs",
    kind: "sca-p03-sealed-bootstrap-inputs",
    schema: "penny.sca-p03-sealed-bootstrap-inputs.v1",
    version: 1,
    min: 0,
  }),
  port({
    name: "runtime_packages",
    kind: "sca-p03-runtime-package",
    schema: "penny.sca-p03-runtime-package.v1",
    version: 1,
    min: 0,
    max: 128,
  }),
  port({
    name: "runtime_policy",
    kind: "sca-p03-runtime-policy",
    schema: "penny.sca-p03-runtime-policy.v1",
    version: 1,
  }),
  port({
    name: "runtime_identity",
    kind: "sca-p03-joern-runtime-identity",
    schema: "penny.sca-p03-joern-runtime-identity.v1",
    version: 1,
  }),
  port({
    name: "isolation_evidence",
    kind: "sca-p03-isolation-evidence",
    schema: "penny.sca-p03-isolation-evidence.v1",
    version: 1,
  }),
  port({
    name: "host_isolation_attestation",
    kind: "sca-p03-host-isolation-attestation",
    schema: "penny.sca-p03-host-isolation-attestation.v1",
    version: 1,
    min: 0,
  }),
  port({
    name: "implementation_identity",
    kind: "sca-p03-implementation-identity",
    schema: "penny.sca-p03-implementation-identity.v1",
    version: 1,
  }),
  port({
    name: "qualification_profile",
    kind: "sca-p03-qualification-profile",
    schema: "penny.sca-p03-qualification-profile.v2",
    version: 2,
  }),
  port({
    name: "qualification_fixture_corpus",
    kind: "sca-p03-qualification-fixture-corpus",
    schema: "penny.sca-p03-qualification-fixture-corpus.v2",
    version: 2,
  }),
  port({
    name: "qualification_fixture_contents",
    kind: "sca-p03-qualification-fixture-content",
    schema: "penny.sca-p03-qualification-fixture-content.v1",
    version: 1,
    min: 3,
    max: 256,
  }),
  port({
    name: "fidelity_complements",
    kind: "sca-p03-fidelity-complement-evidence",
    schema: "penny.sca-p03-fidelity-complement-evidence.v2",
    version: 1,
    min: 0,
    max: 256,
  }),
  port({
    name: "baseline_query_set",
    kind: "sca-p03-baseline-query-set",
    schema: "penny.sca-p03-baseline-query-set.v2",
    version: 2,
  }),
  port({
    name: "query_scripts",
    kind: "sca-p03-query-script",
    schema: "penny.sca-p03-query-script.v2",
    version: 2,
    min: 7,
    max: 7,
  }),
  port({
    name: "query_plans",
    kind: "sca-p03-query-plan",
    schema: "penny.sca-p03-query-plan.v2",
    version: 2,
    min: 7,
    max: 7,
  }),
];

const OUTPUT_PORTS = [
  port({
    name: "p03_request",
    kind: "sca-p03-candidate-request",
    schema: SCA_P03_REQUEST_V2_SCHEMA,
    version: 1,
    min: 0,
    direction: "output",
  }),
  port({
    name: "p03_entry_admission",
    kind: "sca-p03-entry-admission",
    schema: SCA_P03_ENTRY_ADMISSION_V2_SCHEMA,
    version: 1,
    min: 0,
    direction: "output",
  }),
  ...STEPS.flatMap((step) => [
    port({
      name: `${step}_request`,
      kind: requestContract(step).artifact_kind,
      schema: requestContract(step).schema_id,
      version: requestContract(step).schema_version_required,
      min: 0,
      direction: "output",
    }),
    port({
      name: `${step}_result`,
      kind: resultContract(step).artifact_kind,
      schema: resultContract(step).schema_id,
      version: resultContract(step).schema_version_required,
      min: 0,
      direction: "output",
    }),
  ]),
  port({
    name: "graph_components",
    kind: "sca-p03-graph-component",
    schema: SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
    version: 1,
    min: 0,
    max: 2,
    direction: "output",
  }),
  port({
    name: "query_pages",
    kind: "sca-p03-baseline-query-page",
    schema: SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA,
    version: 2,
    min: 0,
    max: 1_024,
    direction: "output",
  }),
  ...[
    ["graph_provenance", "sca-p03-graph-provenance", SCA_P03_GRAPH_PROVENANCE_V1_SCHEMA, 2],
    ["graph_manifest", "sca-p03-graph-manifest", SCA_P03_GRAPH_MANIFEST_V1_SCHEMA, 1],
    [
      "graph_support_matrix",
      "sca-p03-graph-support-matrix",
      SCA_P03_GRAPH_SUPPORT_MATRIX_V2_SCHEMA,
      2,
    ],
    [
      "baseline_query_aggregate",
      "sca-p03-baseline-query-aggregate",
      SCA_P03_BASELINE_QUERY_AGGREGATE_V2_SCHEMA,
      2,
    ],
    [
      "candidate_packet",
      "sca-p03-graph-candidate-packet",
      SCA_P03_GRAPH_CANDIDATE_PACKET_V2_SCHEMA,
      2,
    ],
    ["coverage_matrix", "sca-p03-coverage-matrix", SCA_P03_COVERAGE_MATRIX_V1_SCHEMA, 1],
    ["operation_log", "sca-p03-operation-log", SCA_P03_OPERATION_LOG_V1_SCHEMA, 1],
    [
      "qualification_evidence",
      "sca-p03-qualification-evidence",
      SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA,
      1,
    ],
    [
      "qualification_record",
      "sca-p03-qualification-record",
      SCA_P03_QUALIFICATION_RECORD_V2_SCHEMA,
      2,
    ],
    [
      "zero_model_evidence",
      "sca-p03-zero-model-evidence",
      SCA_P03_ZERO_MODEL_EVIDENCE_V1_SCHEMA,
      1,
    ],
    ["evidence_manifest", "sca-p03-evidence-manifest", SCA_P03_EVIDENCE_MANIFEST_V2_SCHEMA, 2],
    [
      "successor_ledger",
      "sca-p03-successor-obligation-ledger",
      SCA_P03_SUCCESSOR_LEDGER_V1_SCHEMA,
      1,
    ],
    ["gate", "sca-p03-gate", SCA_P03_GATE_V1_SCHEMA, 1],
    ["p04_transition", "sca-p03-p04-transition", SCA_P03_P04_TRANSITION_V2_SCHEMA, 2],
  ].map(([name, kind, schema, max]) =>
    port({
      name: String(name),
      kind: String(kind),
      schema: String(schema),
      version: String(schema).endsWith(".v2") ? 2 : 1,
      min: 0,
      max: Number(max),
      direction: "output",
    })
  ),
];

function p03SkillContract(input: {
  readonly name: string;
  readonly objective: string;
  readonly policy_id: string;
  readonly resolver_id: string;
  readonly admission_id: string;
  readonly snapshot_id: string;
}): SkillContract {
  return {
    schema_version: 2,
    name: input.name,
    objective: input.objective,
    io: {
      request: {
        schema_version: 1,
        name: "request",
        direction: "input",
        transport: "inline_request",
        schema_id: SCA_P03_START_V1_SCHEMA,
        schema_version_required: 1,
        artifact_kind: null,
        source: "caller",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
      input_ports: [...P02_INPUT_PORTS, ...P03_AUTHORITY_PORTS],
      active_output_ports: [...OUTPUT_PORTS],
    },
    behavior: {
      side_effects: {
        external_reads: "host_policy_only",
        external_mutations: "forbidden",
        filesystem_writes: "host_policy_only",
        allowed_relative_paths: [],
      },
      approval: { policy: "caller_skill_request", additional_approval_required: false },
      stopping: {
        budget_exhaustion: "incomplete",
        cancellation: "cancelled",
        blocking_ambiguity: "incomplete",
      },
      escalation: { out_of_scope_effect: "non_positive", sandbox_prevention_claim: false },
      violation_terminal: "incomplete",
    },
    guidance: { skill_root: "apps/orchestration/src/sca", resolution: "per_agent_phase" },
    budget_policy: {
      schema_version: 1,
      policy_id: input.policy_id,
      resolver_id: input.resolver_id,
      admission_id: input.admission_id,
      snapshot_id: input.snapshot_id,
    },
    repair_routing: { schema_version: 1, routes: [] },
    completion_gate: {
      schema_version: 2,
      allowed_terminal_origins: [FINAL_STATE],
      required_visited_states: [FINAL_STATE],
      required_receipt_predicates: [],
      latest_product: {
        selector: "terminal_result",
        schema_id: SCA_P03_TERMINAL_V2_SCHEMA,
        product_schema_version: 1,
      },
      unresolved_policy: { mode: "max_count", max_count: 0 },
    },
  };
}

export const SCA_P03_CANDIDATE_SKILL_CONTRACT: SkillContract = p03SkillContract({
  name: SCA_P03_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Deterministically build source-bound P03 graph artifacts and frozen baseline query evidence without model dispatch.",
  policy_id: "penny.sca-p03-candidate-budget.v1",
  resolver_id: "scaP03CandidateDeterministicResolver",
  admission_id: "scaP03CandidateAdmission",
  snapshot_id: "scaP03CandidateSnapshot",
});
export const SCA_P03_PHASE_SKILL_CONTRACT: SkillContract = p03SkillContract({
  name: SCA_P03_PHASE_PLAYBOOK_NAME,
  objective:
    "Run the accepted deterministic SCA P03 graph and baseline query phase without model dispatch.",
  policy_id: "penny.sca-p03-phase-budget.v1",
  resolver_id: "scaP03PhaseDeterministicResolver",
  admission_id: "scaP03PhaseAdmission",
  snapshot_id: "scaP03PhaseSnapshot",
});

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.artifact_id)) return false;
    seen.add(ref.artifact_id);
    return true;
  });
}

function exactJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) throw new Error(`${label} exact ref is stale`);
  const text = store.readById(ref.artifact_id).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not JSON`, { cause: error });
  }
  if (canonicalJson(value) !== text || sha256(text) !== ref.content_digest) {
    throw new Error(`${label} canonical bytes drifted`);
  }
  return value;
}

function persistJson(input: {
  readonly store: ArtifactHostStore;
  readonly context?: RunContext;
  readonly runId: string;
  readonly phase: string;
  readonly branchId?: string | null;
  readonly kind: string;
  readonly operationId: string;
  readonly producer: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly value: unknown;
  readonly upstreamRefs: readonly ArtifactRef[];
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const branchId = input.branchId ?? null;
  const prior = input.store.refFor(
    input.runId,
    input.phase,
    branchId,
    input.kind,
    input.operationId,
    1
  );
  if (prior !== null) {
    if (
      prior.content_digest !== sha256(content) ||
      input.store.readById(prior.artifact_id).toString("utf8") !== content
    ) {
      throw new Error(`P03 deterministic artifact '${input.operationId}' conflicts`);
    }
    input.store.select(prior);
    if (
      input.context !== undefined &&
      !input.context.selectedArtifacts.some((ref) => ref.artifact_id === prior.artifact_id)
    ) {
      input.context.selectedArtifacts.push(prior);
    }
    return prior;
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: input.phase,
    branch_id: branchId,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: input.producer,
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: input.schemaVersion },
    parent_ref: null,
    upstream_refs: uniqueRefs(input.upstreamRefs).sort((left, right) =>
      left.artifact_id.localeCompare(right.artifact_id)
    ),
  };
  const ref = input.store.persist({ metadata, content });
  input.store.select(ref);
  if (
    input.context !== undefined &&
    !input.context.selectedArtifacts.some((candidate) => candidate.artifact_id === ref.artifact_id)
  ) {
    input.context.selectedArtifacts.push(ref);
  }
  return ref;
}

function p03StartAdmission(playbookName: string): StartAdmissionV1 {
  return {
    schema_id: SCA_P03_START_V1_SCHEMA,
    schema_version: 1,
    prepare(request: StartRequest): PreparedStartV1 {
      const constraints = validateContract(
        ScaP03StartConstraintsV1Schema,
        request.constraints,
        "SCA P03 start constraints"
      );
      const p03 = validateScaP03RequestV2(constraints.p03_request);
      if (
        request.identity.playbook !== playbookName ||
        request.identity.run_id !== p03.run_id ||
        request.input_artifacts === undefined
      ) {
        throw new Error("SCA P03 start identity or exact input artifacts are invalid");
      }
      const expected = scaP03InputArtifacts(p03)
        .artifacts.map((binding) => canonicalJson(binding.ref))
        .sort();
      const observed = request.input_artifacts.artifacts
        .map((binding) => canonicalJson(binding.ref))
        .sort();
      if (!same(expected, observed)) {
        throw new Error("SCA P03 start inputs do not equal the exact accepted input set");
      }
      return {
        schema_id: SCA_P03_START_V1_SCHEMA,
        schema_version: 1,
        request,
        goal: request.goal,
        constraints,
        input_artifacts: request.input_artifacts,
        admission_data: p03,
      };
    },
    materialize(prepared, host) {
      if (host.artifactStore === undefined) {
        throw new Error("SCA P03 admission requires the artifact host store");
      }
      const inputs = prepared.input_artifacts;
      if (inputs === undefined) throw new Error("SCA P03 admission requires exact inputs");
      const admitted = admitScaP03Candidate({
        store: host.artifactStore,
        request: prepared.admission_data,
        input_artifacts: inputs,
        trusted_clock: host.trustedClock ?? (() => new Date()),
      });
      const requestRef = persistJson({
        store: host.artifactStore,
        runId: host.run_id,
        phase: P03_PHASE,
        kind: "sca-p03-candidate-request",
        operationId: "sca-p03-candidate-request",
        producer: P03_PRODUCER,
        schemaId: SCA_P03_REQUEST_V2_SCHEMA,
        schemaVersion: 2,
        value: admitted.request,
        upstreamRefs: inputs.artifacts.map((binding) => binding.ref),
      });
      const admittedAt = (host.trustedClock ?? (() => new Date()))();
      if (!Number.isFinite(admittedAt.getTime())) throw new Error("P03 admission clock is invalid");
      const entry = validateScaP03EntryAdmissionV2(
        withScaP03Digest(
          {
            schema_id: SCA_P03_ENTRY_ADMISSION_V2_SCHEMA,
            schema_version: 2,
            tenant_id: admitted.request.tenant_id,
            project_id: admitted.request.project_id,
            run_id: admitted.request.run_id,
            phase_id: "SCA-P03" as const,
            p01_binding_sha256: admitted.request.p01_binding_sha256,
            p02_binding_sha256: admitted.request.p02_binding_sha256,
            p03_runtime_binding_sha256: admitted.request.p03_runtime_binding_sha256,
            source_snapshot_ref: admitted.request.source_snapshot_ref,
            source_snapshot_sha256: admitted.request.source_snapshot_sha256,
            p03_request_ref: requestRef,
            source_oracle_ref: admitted.request.source_oracle_ref,
            source_oracle_validation_ref: admitted.request.source_oracle_validation_ref,
            p02_transition_ref: admitted.request.accepted_p02.transition_ref,
            p02_m1_ref: admitted.request.accepted_p02.m1_ref,
            p01_manifest_ref: admitted.request.accepted_p01.campaign_manifest_ref,
            admitted_at: admittedAt.toISOString(),
          },
          "admission_sha256"
        )
      );
      const entryRef = persistJson({
        store: host.artifactStore,
        runId: host.run_id,
        phase: P03_PHASE,
        kind: "sca-p03-entry-admission",
        operationId: "sca-p03-entry-admission",
        producer: P03_PRODUCER,
        schemaId: SCA_P03_ENTRY_ADMISSION_V2_SCHEMA,
        schemaVersion: 2,
        value: entry,
        upstreamRefs: [requestRef, ...inputs.artifacts.map((binding) => binding.ref)],
      });
      return [requestRef, entryRef];
    },
  };
}

const START_ADMISSION = p03StartAdmission(SCA_P03_CANDIDATE_PLAYBOOK_NAME);
const PHASE_START_ADMISSION = p03StartAdmission(SCA_P03_PHASE_PLAYBOOK_NAME);

const StepRefsSchema = Type.Object(
  {
    qualify: Type.Optional(ArtifactRefSchema),
    build_php: Type.Optional(ArtifactRefSchema),
    build_javascript_typescript: Type.Optional(ArtifactRefSchema),
    query_php: Type.Optional(ArtifactRefSchema),
    query_javascript_typescript: Type.Optional(ArtifactRefSchema),
  },
  { additionalProperties: false }
);
const PartitionRefsSchema = Type.Object(
  {
    php: Type.Optional(ArtifactRefSchema),
    javascript_typescript: Type.Optional(ArtifactRefSchema),
  },
  { additionalProperties: false }
);
const PartitionRefArraysSchema = Type.Object(
  {
    php: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 1_024 })),
    javascript_typescript: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 1_024 })),
  },
  { additionalProperties: false }
);
const P03DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    entry_admission_ref: ArtifactRefSchema,
    operation_request_refs: StepRefsSchema,
    operation_result_refs: StepRefsSchema,
    graph_component_refs: PartitionRefsSchema,
    page_refs: PartitionRefArraysSchema,
  },
  { additionalProperties: false }
);
type P03Data = Static<typeof P03DataSchema>;

function data(context: RunContext): P03Data {
  return validateContract(P03DataSchema, context.playbookData, "SCA P03 durable playbook data");
}

function latestSelected(
  context: RunContext,
  predicate: (ref: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts]
    .filter(predicate)
    .sort(
      (left, right) =>
        right.version - left.version || right.artifact_id.localeCompare(left.artifact_id)
    )[0];
}

function dynamicSlot(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(4, "0")}`;
}

function stepPartition(step: Step): ScaP03Partition | null {
  if (step.endsWith("php") && !step.endsWith("javascript_typescript")) return "php";
  if (step.includes("javascript_typescript")) return "javascript_typescript";
  return null;
}

function unsignedRequest<T extends Readonly<Record<string, unknown>>>(value: T) {
  return withScaP03Digest(value, "request_sha256");
}

/** Resolve only already-admitted P03 host inputs. No activation, ref wrapping or predecessor issuance. */
export function resolveScaP03HostOperationPlan(store: ArtifactHostStore, request_ref: ArtifactRef) {
  const request = validateScaP03RequestV2(exactJson(store, request_ref, "P03 request"));
  assertScaP03AuthorityContracts(request);
  // Verify exact custody for every P03 authority input, not caller-supplied producer labels.
  for (const ref of [
    request.runtime_policy_ref,
    request.joern_runtime_identity_ref,
    request.isolation_evidence_ref,
    ...(request.host_isolation_attestation_ref === null
      ? []
      : [request.host_isolation_attestation_ref]),
    request.implementation_identity_ref,
    request.qualification_profile_ref,
    request.fixture_corpus_ref,
    request.source_oracle_ref,
    request.source_oracle_validation_ref,
    ...request.fixture_content_refs,
    request.baseline_query_set_ref,
    ...request.query_script_refs,
    ...request.query_plan_refs,
    ...request.fidelity_complement_refs,
  ])
    exactJson(store, ref, "P03 host input");
  const policy = validateScaP03RuntimePolicyV1(
    exactJson(store, request.runtime_policy_ref, "P03 runtime policy")
  );
  const runtime = validateScaP03JoernRuntimeIdentityV1(
    exactJson(store, request.joern_runtime_identity_ref, "P03 runtime identity")
  );
  const isolation = validateScaP03IsolationEvidenceV1(
    exactJson(store, request.isolation_evidence_ref, "P03 isolation")
  );
  const profile = validateScaP03QualificationProfileV2(
    exactJson(store, request.qualification_profile_ref, "P03 qualification profile")
  );
  const core = validateScaCampaignManifestCoreV1(
    exactJson(store, request.accepted_p01.campaign_manifest_core_ref, "P01 core")
  );
  return { request, policy, runtime, isolation, profile, core };
}

export class ScaP03CandidatePlaybook implements PlaybookCore, HostContinuationCapabilityV1 {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly trustedClock: () => Date
  ) {}

  initialize(context: RunContext): Directive {
    const requestRef = latestSelected(
      context,
      (ref) =>
        ref.kind === "sca-p03-candidate-request" &&
        ref.producer === P03_PRODUCER &&
        ref.run_id === context.identity.run_id &&
        ref.content_schema?.schema_id === SCA_P03_REQUEST_V2_SCHEMA
    );
    const entryRef = latestSelected(
      context,
      (ref) =>
        ref.kind === "sca-p03-entry-admission" &&
        ref.producer === P03_PRODUCER &&
        ref.run_id === context.identity.run_id &&
        ref.content_schema?.schema_id === SCA_P03_ENTRY_ADMISSION_V2_SCHEMA
    );
    if (requestRef === undefined || entryRef === undefined) {
      throw new Error("SCA P03 admitted request or entry evidence is absent");
    }
    const admitted = validateScaP03RequestV2(exactJson(this.store, requestRef, "P03 request"));
    const entry = validateScaP03EntryAdmissionV2(
      exactJson(this.store, entryRef, "P03 entry admission")
    );
    if (
      !same(entry.p03_request_ref, requestRef) ||
      entry.run_id !== admitted.run_id ||
      !same(entry.source_oracle_ref, admitted.source_oracle_ref) ||
      !same(entry.source_oracle_validation_ref, admitted.source_oracle_validation_ref) ||
      entry.p01_binding_sha256 !== admitted.p01_binding_sha256 ||
      entry.p02_binding_sha256 !== admitted.p02_binding_sha256 ||
      entry.p03_runtime_binding_sha256 !== admitted.p03_runtime_binding_sha256
    ) {
      throw new Error("SCA P03 entry evidence does not bind the admitted request");
    }
    Object.assign(context.playbookData, {
      request_ref: requestRef,
      entry_admission_ref: entryRef,
      operation_request_refs: {},
      operation_result_refs: {},
      graph_component_refs: {},
      page_refs: {},
    });
    context.transition(STATE.qualify);
    // Issue only the immutable request; the engine checkpoints it before the runner
    // delegates any effects to the registered canonical owner.
    return this.issueOperation(context, "qualify");
  }

  dispatch(context: RunContext): Directive {
    const step = STEPS.find((candidate) => STATE[candidate] === context.stateId);
    if (step === undefined) throw new Error(`SCA P03 has no dispatch for '${context.stateId}'`);
    const state = data(context);
    const requestRef = state.operation_request_refs[step];
    if (requestRef === undefined) throw new Error(`SCA P03 ${step} request is absent`);
    const resultRef = latestSelected(
      context,
      (ref) => ref.phase === context.stateId && ref.kind === resultContract(step).artifact_kind
    );
    if (resultRef === undefined) throw new Error(`SCA P03 ${step} result is absent`);
    const request = validateScaP03OperationRequestV1(
      DOMAIN_KIND[step],
      exactJson(this.store, requestRef, `${step} request`)
    );
    const result = validateScaP03OperationResultV1(
      DOMAIN_KIND[step],
      request,
      exactJson(this.store, resultRef, `${step} result`)
    );
    if (step === "qualify") {
      const qualificationRequest = validateScaP03OperationRequestV1("qualify_joern", request);
      const qualificationResult = validateScaP03OperationResultV1(
        "qualify_joern",
        qualificationRequest,
        result
      );
      const corpus = validateScaP03QualificationFixtureCorpusV2(
        exactJson(this.store, qualificationRequest.fixture_corpus_ref, "P03 qualification corpus")
      );
      validateScaP03QualificationResultProjectionV2(
        qualificationResult,
        corpus.expected_cases,
        qualificationRequest.source_oracle_validation_ref
      );
    }
    state.operation_result_refs[step] = resultRef;
    if (request.operation_kind === "build_source_graph") {
      this.acceptGraphOutput(context, state, request, result);
    } else if (request.operation_kind === "run_baseline_query_batch") {
      this.acceptQueryOutputs(context, state, request, result);
    }
    if (step === "build_javascript_typescript") {
      if (
        state.graph_component_refs.php === undefined ||
        state.graph_component_refs.javascript_typescript === undefined
      ) {
        context.transition(FINAL_STATE);
        return this.finalize(context);
      }
    }
    const index = STEPS.indexOf(step);
    const next = STEPS[index + 1];
    if (next === undefined) {
      context.transition(FINAL_STATE);
      return this.finalize(context);
    }
    context.transition(STATE[next]);
    return this.issueOperation(context, next);
  }

  resume(): Directive {
    throw new Error("SCA P03 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = "sca_p03_cancelled";
    context.status = "cancelled";
    context.met = false;
    context.pendingBranches = [];
    const terminal = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: {
        phase_id: "SCA-P03",
        terminal_reason: "cancelled",
        campaign_terminal: false,
        release_eligible: false,
        model_calls: 0,
        model_turns: 0,
      },
      artifacts: this.terminalArtifacts(context),
      unresolved: [reason],
    });
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    return terminal;
  }

  acceptSummary(): Directive {
    throw new Error("SCA P03 deterministic candidate never accepts worker summaries");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }

  needsHostContinuation(context: RunContext): boolean {
    return (
      context.terminalDirective === null &&
      context.stateId === STATE.qualify &&
      data(context).operation_request_refs.qualify === undefined
    );
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context)) {
      throw new Error("SCA P03 host continuation is unavailable");
    }
    const directive = this.issueOperation(context, "qualify");
    return {
      event_type: "sca_p03_qualification_scheduled",
      payload: { run_id: context.identity.run_id, operation_id: SCA_P03_OPERATION_IDS.qualify },
      directive,
      after_checkpoint_fault: "sca_p03:qualification_scheduled",
    };
  }

  private admitted(context: RunContext) {
    const state = data(context);
    return { state, ...resolveScaP03HostOperationPlan(this.store, state.request_ref) };
  }

  private commonOperation(context: RunContext) {
    const admitted = this.admitted(context);
    return {
      admitted,
      common: {
        schema_version: 1 as const,
        tenant_id: admitted.request.tenant_id,
        project_id: admitted.request.project_id,
        run_id: admitted.request.run_id,
        phase_id: "SCA-P03" as const,
        p01_binding_sha256: admitted.request.p01_binding_sha256,
        p02_binding_sha256: admitted.request.p02_binding_sha256,
        p03_runtime_binding_sha256: admitted.request.p03_runtime_binding_sha256,
        source_snapshot_ref: admitted.request.source_snapshot_ref,
        source_snapshot_sha256: admitted.request.source_snapshot_sha256,
        p03_request_ref: admitted.state.request_ref,
        ...(admitted.request.bootstrap_verification === undefined
          ? {}
          : {
              backend_resource_sha256:
                admitted.request.bootstrap_verification.backend_resource_sha256,
            }),
        runtime_policy_ref: admitted.request.runtime_policy_ref,
        joern_runtime_identity_ref: admitted.request.joern_runtime_identity_ref,
        isolation_evidence_ref: admitted.request.isolation_evidence_ref,
        host_isolation_attestation_ref: admitted.request.host_isolation_attestation_ref,
        implementation_identity_ref: admitted.request.implementation_identity_ref,
        qualification_profile_ref: admitted.request.qualification_profile_ref,
        baseline_query_set_ref: admitted.request.baseline_query_set_ref,
        runtime_id: admitted.runtime.runtime_id,
        runtime_kind: admitted.runtime.runtime_kind,
        qualification_scope: admitted.runtime.qualification_scope,
        runtime_tree_sha256: admitted.runtime.runtime_tree_sha256,
        isolation_id: admitted.isolation.isolation_id,
        isolation_profile_sha256: admitted.isolation.profile_sha256,
      },
      inputs: [
        { slot: "p03_request", ref: admitted.state.request_ref },
        ...(admitted.request.bootstrap_verification === undefined
          ? []
          : [
              admitted.request.bootstrap_verification.sealed_inputs_ref,
              ...admitted.request.bootstrap_verification.input_refs,
            ].map((ref, i) => ({ slot: `bootstrap_proof_${String(i).padStart(3, "0")}`, ref }))),
        { slot: SCA_P03_INPUT_SLOTS.runtime_policy, ref: admitted.request.runtime_policy_ref },
        {
          slot: SCA_P03_INPUT_SLOTS.runtime_identity,
          ref: admitted.request.joern_runtime_identity_ref,
        },
        {
          slot: SCA_P03_INPUT_SLOTS.isolation_evidence,
          ref: admitted.request.isolation_evidence_ref,
        },
        ...(admitted.request.host_isolation_attestation_ref === null
          ? []
          : [
              {
                slot: SCA_P03_INPUT_SLOTS.host_attestation,
                ref: admitted.request.host_isolation_attestation_ref,
              },
            ]),
        {
          slot: SCA_P03_INPUT_SLOTS.implementation_identity,
          ref: admitted.request.implementation_identity_ref,
        },
        {
          slot: SCA_P03_INPUT_SLOTS.qualification_profile,
          ref: admitted.request.qualification_profile_ref,
        },
        {
          slot: SCA_P03_INPUT_SLOTS.baseline_query_set,
          ref: admitted.request.baseline_query_set_ref,
        },
      ],
    };
  }

  private buildOperation(
    context: RunContext,
    step: Step
  ): {
    readonly request: ScaP03OperationRequestV1;
    readonly inputs: readonly { readonly slot: string; readonly ref: ArtifactRef }[];
  } {
    const prepared = this.commonOperation(context);
    if (step === "qualify") {
      const request = validateScaP03OperationRequestV1(
        "qualify_joern",
        unsignedRequest({
          schema_id: SCA_P03_QUALIFICATION_REQUEST_V2_SCHEMA,
          ...prepared.common,
          schema_version: 2,
          operation_id: SCA_P03_OPERATION_IDS.qualify,
          operation_kind: "qualify_joern" as const,
          fixture_corpus_ref: prepared.admitted.request.fixture_corpus_ref,
          source_oracle_ref: prepared.admitted.request.source_oracle_ref,
          source_oracle_validation_ref: prepared.admitted.request.source_oracle_validation_ref,
          fixture_content_refs: prepared.admitted.request.fixture_content_refs,
          query_script_refs: prepared.admitted.request.query_script_refs,
          query_plan_refs: prepared.admitted.request.query_plan_refs,
        })
      );
      exactJson(
        this.store,
        prepared.admitted.request.source_oracle_validation_ref,
        "P03 oracle receipt"
      );
      const receipt = parseSourceOracleValidationReceiptBytes(
        this.store.readById(prepared.admitted.request.source_oracle_validation_ref.artifact_id)
      );
      return {
        request,
        inputs: [
          ...prepared.inputs,
          { slot: SCA_P03_INPUT_SLOTS.source_oracle, ref: request.source_oracle_ref },
          {
            slot: SCA_P03_INPUT_SLOTS.source_oracle_validation,
            ref: request.source_oracle_validation_ref,
          },
          { slot: SCA_P03_INPUT_SLOTS.source_oracle_review, ref: receipt.review_ref },
          {
            slot: SCA_P03_INPUT_SLOTS.fixture_corpus,
            ref: prepared.admitted.request.fixture_corpus_ref,
          },
          ...prepared.admitted.request.fixture_content_refs.map((ref, index) => ({
            slot: dynamicSlot("fixture_content", index),
            ref,
          })),
          ...prepared.admitted.request.query_script_refs.map((ref, index) => ({
            slot: dynamicSlot("query_script", index),
            ref,
          })),
          ...prepared.admitted.request.query_plan_refs.map((ref, index) => ({
            slot: dynamicSlot("query_plan", index),
            ref,
          })),
        ],
      };
    }
    const partition = stepPartition(step);
    if (partition === null) throw new Error(`SCA P03 step '${step}' has no partition`);
    if (DOMAIN_KIND[step] === "build_source_graph") {
      const manifest = validateScaP01SourceFileManifestV1(
        exactJson(
          this.store,
          prepared.admitted.core.frozen_refs.source_file_manifest_ref,
          "P01 source manifest"
        )
      );
      const primary = (path: string): boolean => {
        const lower = path.toLowerCase();
        return partition === "php"
          ? lower.endsWith(".php")
          : [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].some((suffix) => lower.endsWith(suffix));
      };
      const request = validateScaP03OperationRequestV1(
        "build_source_graph",
        unsignedRequest({
          schema_id: SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA,
          ...prepared.common,
          operation_id: OPERATION_ID[step],
          operation_kind: "build_source_graph" as const,
          partition,
          frontend_language: partition === "php" ? ("PHP" as const) : ("JSSRC" as const),
          source_file_manifest_ref: prepared.admitted.core.frozen_refs.source_file_manifest_ref,
          source_custody_ref: prepared.admitted.core.frozen_refs.source_custody_ref,
          expected_files: manifest.files.map((file) => ({
            path: file.path,
            content_sha256: file.content_sha256,
            role: primary(file.path) ? ("primary" as const) : ("contextual" as const),
          })),
          max_num_def: prepared.admitted.policy.max_num_def,
          max_graph_bytes: prepared.admitted.policy.max_graph_bytes,
        })
      );
      return {
        request,
        inputs: [
          ...prepared.inputs,
          {
            slot: SCA_P03_INPUT_SLOTS.source_file_manifest,
            ref: prepared.admitted.core.frozen_refs.source_file_manifest_ref,
          },
          {
            slot: SCA_P03_INPUT_SLOTS.source_custody,
            ref: prepared.admitted.core.frozen_refs.source_custody_ref,
          },
        ],
      };
    }
    const buildStep =
      partition === "php" ? ("build_php" as const) : ("build_javascript_typescript" as const);
    const graphRef = prepared.admitted.state.graph_component_refs[partition];
    const buildResultRef = prepared.admitted.state.operation_result_refs[buildStep];
    const buildRequestRef = prepared.admitted.state.operation_request_refs[buildStep];
    if (graphRef === undefined || buildResultRef === undefined || buildRequestRef === undefined) {
      throw new Error(`SCA P03 ${partition} baseline query lacks its exact graph build`);
    }
    const request = validateScaP03OperationRequestV1(
      "run_baseline_query_batch",
      unsignedRequest({
        schema_id: SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA,
        ...prepared.common,
        schema_version: 2,
        operation_id: OPERATION_ID[step],
        operation_kind: "run_baseline_query_batch" as const,
        partition,
        graph_component_ref: graphRef,
        graph_component_sha256: graphRef.content_digest,
        graph_build_request_ref: buildRequestRef,
        graph_build_result_ref: buildResultRef,
        ordered_query_ids: SCA_P03_QUERY_IDS,
        fidelity_requirements: prepared.admitted.profile.fidelity_requirements.filter(
          (entry) => entry.partition === partition
        ),
        query_script_refs: prepared.admitted.request.query_script_refs,
        query_plan_refs: prepared.admitted.request.query_plan_refs,
        max_query_output_bytes: prepared.admitted.policy.max_query_output_bytes,
        max_query_items: prepared.admitted.policy.max_query_items,
        max_page_items: prepared.admitted.policy.max_page_items,
        max_pages_per_query: prepared.admitted.policy.max_pages_per_query,
      })
    );
    return {
      request,
      inputs: [
        ...prepared.inputs,
        { slot: SCA_P03_INPUT_SLOTS.graph_component, ref: graphRef },
        { slot: SCA_P03_INPUT_SLOTS.graph_build_result, ref: buildResultRef },
        { slot: SCA_P03_INPUT_SLOTS.graph_build_request, ref: buildRequestRef },
        ...prepared.admitted.request.query_script_refs.map((ref, index) => ({
          slot: dynamicSlot("query_script", index),
          ref,
        })),
        ...prepared.admitted.request.query_plan_refs.map((ref, index) => ({
          slot: dynamicSlot("query_plan", index),
          ref,
        })),
      ],
    };
  }

  private issueOperation(context: RunContext, step: Step): Directive {
    const state = data(context);
    const prepared = this.buildOperation(context, step);
    // Preserve semantic slots; exact bootstrap overlaps are read through those same slots.
    const inputs = prepared.inputs.filter(
      (binding, i, all) =>
        !binding.slot.startsWith("bootstrap_proof_") ||
        !all.some(
          (other, j) =>
            j !== i &&
            other.ref.artifact_id === binding.ref.artifact_id &&
            (!other.slot.startsWith("bootstrap_proof_") || j < i)
        )
    );
    const requestRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: STATE[step],
      kind: requestContract(step).artifact_kind,
      operationId: OPERATION_ID[step],
      producer: P03_PRODUCER,
      schemaId: requestContract(step).schema_id,
      schemaVersion: requestContract(step).schema_version_required,
      value: prepared.request,
      upstreamRefs: inputs.map((binding) => binding.ref),
    });
    const prior = state.operation_request_refs[step];
    if (prior !== undefined && !same(prior, requestRef)) {
      throw new Error(`SCA P03 ${step} request changed across replay`);
    }
    state.operation_request_refs[step] = requestRef;
    const registrationSha256 = context.registrationContractBinding?.registration_sha256;
    if (registrationSha256 === undefined) throw new Error("SCA P03 registration binding is absent");
    const operationDeclaration = declarationFor(step);
    const directive = validateDirective({
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: context.identity,
      state_id: STATE[step],
      attempt: context.stepCount,
      operation_id: OPERATION_ID[step],
      operation_kind: OPERATION_KIND[step],
      registration_sha256: registrationSha256,
      request_ref: requestRef,
      request_sha256: requestRef.content_digest,
      input_artifacts: { schema_version: 2, artifacts: inputs },
      expected_result: operationDeclaration.result,
      policy_binding: hostOperationPolicyBinding(
        operationDeclaration,
        prepared.request.backend_resource_sha256 ?? prepared.request.request_sha256
      ),
    });
    context.pendingDirective = directive;
    return directive;
  }

  private acceptGraphOutput(
    context: RunContext,
    state: P03Data,
    request: ScaP03GraphBuildRequestV1,
    result: ScaP03OperationResultV1
  ): void {
    if (result.operation_kind !== "build_source_graph") {
      throw new Error("P03 graph result kind drifted");
    }
    const outputs = context.selectedArtifacts.filter(
      (ref) => ref.phase === context.stateId && ref.kind === "sca-p03-graph-component"
    );
    if (result.graph === null) {
      if (outputs.length !== 0) throw new Error("blocked P03 graph build emitted graph bytes");
      return;
    }
    const graphRef = outputs[0];
    if (
      outputs.length !== 1 ||
      graphRef === undefined ||
      graphRef.media_type !== "application/vnd.penny.joern-cpg" ||
      graphRef.content_schema?.schema_id !== SCA_P03_GRAPH_COMPONENT_V1_SCHEMA ||
      graphRef.content_digest !== result.graph.content_sha256 ||
      graphRef.byte_length !== result.graph.byte_length ||
      sha256(this.store.readById(graphRef.artifact_id)) !== graphRef.content_digest ||
      request.source_snapshot_sha256 !== result.source_snapshot_sha256
    ) {
      throw new Error("P03 graph artifact digest/custody binding failed");
    }
    state.graph_component_refs[request.partition] = graphRef;
  }

  private acceptQueryOutputs(
    context: RunContext,
    state: P03Data,
    request: ScaP03BaselineQueryBatchRequestV2,
    result: ScaP03OperationResultV1
  ): void {
    if (result.operation_kind !== "run_baseline_query_batch") {
      throw new Error("P03 query result kind drifted");
    }
    const observed = context.selectedArtifacts
      .filter((ref) => ref.phase === context.stateId && ref.kind === "sca-p03-baseline-query-page")
      .map((ref) => ({
        ref,
        page: validateScaP03BaselineQueryPageV2(exactJson(this.store, ref, "P03 query page")),
      }))
      .sort(
        (left, right) =>
          SCA_P03_QUERY_IDS.indexOf(left.page.query_id) -
            SCA_P03_QUERY_IDS.indexOf(right.page.query_id) ||
          left.page.page_number - right.page.page_number
      );
    if (result.status === "blocked") {
      if (observed.length !== 0) throw new Error("blocked P03 query emitted page artifacts");
      state.page_refs[request.partition] = [];
      return;
    }
    if (observed.length !== result.page_descriptors.length) {
      throw new Error("P03 baseline query page artifact count disagrees with result");
    }
    for (const [index, entry] of observed.entries()) {
      const descriptor = result.page_descriptors[index];
      if (
        descriptor === undefined ||
        entry.page.query_id !== descriptor.query_id ||
        entry.page.page_number !== descriptor.page_number ||
        entry.page.item_count !== descriptor.item_count ||
        entry.ref.content_digest !== descriptor.content_sha256 ||
        entry.ref.byte_length !== descriptor.byte_length ||
        !same(entry.page.graph_component_ref, request.graph_component_ref) ||
        entry.page.source_snapshot_sha256 !== request.source_snapshot_sha256 ||
        !same(entry.page.baseline_query_set_ref, request.baseline_query_set_ref)
      ) {
        throw new Error("P03 baseline query page artifact is stale or misbound");
      }
    }
    state.page_refs[request.partition] = observed.map((entry) => entry.ref);
  }

  private requireStepRef(
    refs: P03Data["operation_request_refs"] | P03Data["operation_result_refs"],
    step: Step,
    label: string
  ): ArtifactRef {
    const ref = refs[step];
    if (ref === undefined) throw new Error(`P03 ${label} lacks ${step}`);
    return ref;
  }

  private receiptRefs(context: RunContext): ReadonlyMap<string, ArtifactRef> {
    const refs = new Map<string, ArtifactRef>();
    for (const ref of context.selectedArtifacts.filter(
      (candidate) => candidate.kind === "host-operation-receipt"
    )) {
      const receipt = validateHostOperationReceipt(exactJson(this.store, ref, "P03 receipt"));
      refs.set(receipt.operation_id, ref);
    }
    return refs;
  }

  private boundCommon(context: RunContext) {
    const admitted = this.admitted(context);
    return {
      admitted,
      common: {
        tenant_id: admitted.request.tenant_id,
        project_id: admitted.request.project_id,
        run_id: admitted.request.run_id,
        phase_id: "SCA-P03" as const,
        p01_binding_sha256: admitted.request.p01_binding_sha256,
        p02_binding_sha256: admitted.request.p02_binding_sha256,
        p03_runtime_binding_sha256: admitted.request.p03_runtime_binding_sha256,
        source_snapshot_ref: admitted.request.source_snapshot_ref,
        source_snapshot_sha256: admitted.request.source_snapshot_sha256,
      },
    };
  }

  private persistFinal(input: {
    readonly context: RunContext;
    readonly branchId?: string | null;
    readonly kind: string;
    readonly operationId: string;
    readonly schemaId: string;
    readonly value: unknown;
    readonly upstreamRefs: readonly ArtifactRef[];
  }): ArtifactRef {
    return persistJson({
      store: this.store,
      context: input.context,
      runId: input.context.identity.run_id,
      phase: P03_PHASE,
      ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
      kind: input.kind,
      operationId: input.operationId,
      producer: P03_PRODUCER,
      schemaId: input.schemaId,
      schemaVersion: input.schemaId.endsWith(".v2") ? 2 : 1,
      value: input.value,
      upstreamRefs: input.upstreamRefs,
    });
  }

  private finalize(context: RunContext): Directive {
    const state = data(context);
    const bound = this.boundCommon(context);
    const executedSteps = STEPS.filter(
      (step) =>
        state.operation_request_refs[step] !== undefined &&
        state.operation_result_refs[step] !== undefined
    );
    const requests = new Map<Step, ScaP03OperationRequestV1>();
    const results = new Map<Step, ScaP03OperationResultV1>();
    for (const step of executedSteps) {
      const requestRef = this.requireStepRef(state.operation_request_refs, step, "request");
      const resultRef = this.requireStepRef(state.operation_result_refs, step, "result");
      const request = validateScaP03OperationRequestV1(
        DOMAIN_KIND[step],
        exactJson(this.store, requestRef, `${step} request`)
      );
      requests.set(step, request);
      results.set(
        step,
        validateScaP03OperationResultV1(
          DOMAIN_KIND[step],
          request,
          exactJson(this.store, resultRef, `${step} result`)
        )
      );
    }
    const qualification = results.get("qualify");
    if (qualification?.operation_kind !== "qualify_joern") {
      throw new Error("P03 finalization lacks qualification result");
    }
    const qualificationRequest = requests.get("qualify");
    if (qualificationRequest?.operation_kind !== "qualify_joern")
      throw new Error("P03 finalization lacks qualification request");
    const corpus = validateScaP03QualificationFixtureCorpusV2(
      exactJson(this.store, qualificationRequest.fixture_corpus_ref, "P03 qualification corpus")
    );
    validateScaP03QualificationResultProjectionV2(
      qualification,
      corpus.expected_cases,
      qualificationRequest.source_oracle_validation_ref
    );
    const receiptRefs = this.receiptRefs(context);
    const operationEntries = executedSteps.map((step) => {
      const result = results.get(step);
      const receipt = receiptRefs.get(OPERATION_ID[step]);
      if (result === undefined || receipt === undefined) {
        throw new Error(`P03 operation log lacks ${step} result or receipt`);
      }
      const partition = stepPartition(step);
      const outputs =
        DOMAIN_KIND[step] === "build_source_graph" && partition !== null
          ? state.graph_component_refs[partition] === undefined
            ? []
            : [state.graph_component_refs[partition]]
          : DOMAIN_KIND[step] === "run_baseline_query_batch" && partition !== null
            ? (state.page_refs[partition] ?? [])
            : [];
      return {
        operation_id: OPERATION_ID[step],
        operation_kind: DOMAIN_KIND[step],
        request_ref: this.requireStepRef(
          state.operation_request_refs,
          step,
          "operation log request"
        ),
        result_ref: this.requireStepRef(state.operation_result_refs, step, "operation log result"),
        receipt_ref: receipt,
        output_refs: outputs,
        status: result.status,
      };
    });
    const operationLog = validateScaP03OperationLogV1(
      withScaP03Digest(
        {
          schema_id: SCA_P03_OPERATION_LOG_V1_SCHEMA,
          schema_version: 1,
          ...bound.common,
          operations: operationEntries,
        },
        "log_sha256"
      )
    );
    const operationLogRef = this.persistFinal({
      context,
      kind: "sca-p03-operation-log",
      operationId: "sca-p03-operation-log",
      schemaId: SCA_P03_OPERATION_LOG_V1_SCHEMA,
      value: operationLog,
      upstreamRefs: operationEntries.flatMap((entry) => [
        entry.request_ref,
        entry.result_ref,
        entry.receipt_ref,
        ...entry.output_refs,
      ]),
    });

    const qualificationRequestRef = this.requireStepRef(
      state.operation_request_refs,
      "qualify",
      "qualification request"
    );
    const qualificationResultRef = this.requireStepRef(
      state.operation_result_refs,
      "qualify",
      "qualification result"
    );
    const qualificationReceiptRef = receiptRefs.get(SCA_P03_OPERATION_IDS.qualify);
    if (qualificationReceiptRef === undefined)
      throw new Error("P03 qualification receipt is absent");
    const qualificationEvidence = validateScaP03QualificationEvidenceV1(
      withScaP03Digest(
        {
          schema_id: SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA,
          schema_version: 1,
          ...bound.common,
          qualification_request_ref: qualificationRequestRef,
          qualification_result_ref: qualificationResultRef,
          operation_receipt_ref: qualificationReceiptRef,
          source_oracle_ref: bound.admitted.request.source_oracle_ref,
          source_oracle_validation_ref: bound.admitted.request.source_oracle_validation_ref,
          parser_identity_sha256: qualification.parser_identity_sha256,
          qualification_scope: qualification.qualification_scope,
          qualified: qualification.qualified,
        },
        "evidence_sha256"
      )
    );
    const qualificationEvidenceRef = this.persistFinal({
      context,
      kind: "sca-p03-qualification-evidence",
      operationId: "sca-p03-qualification-evidence",
      schemaId: SCA_P03_QUALIFICATION_EVIDENCE_V1_SCHEMA,
      value: qualificationEvidence,
      upstreamRefs: [
        qualificationRequestRef,
        qualificationResultRef,
        qualificationReceiptRef,
        bound.admitted.request.source_oracle_ref,
        bound.admitted.request.source_oracle_validation_ref,
      ],
    });

    const graphProvenanceRefs = new Map<ScaP03Partition, ArtifactRef>();
    const graphComponents = SCA_P03_PARTITIONS.map((partition) => {
      const step =
        partition === "php" ? ("build_php" as const) : ("build_javascript_typescript" as const);
      const request = requests.get(step);
      const result = results.get(step);
      const resultRef = state.operation_result_refs[step];
      const requestRef = state.operation_request_refs[step];
      const graphRef = state.graph_component_refs[partition];
      if (
        request?.operation_kind !== "build_source_graph" ||
        result?.operation_kind !== "build_source_graph" ||
        resultRef === undefined ||
        requestRef === undefined
      ) {
        throw new Error(`P03 graph finalization lacks ${partition} build evidence`);
      }
      let provenanceRef: ArtifactRef | null = null;
      if (
        graphRef !== undefined &&
        result.graph !== null &&
        result.graph_id !== null &&
        result.complete &&
        result.cleanup_status === "proven"
      ) {
        const provenance = validateScaP03GraphProvenanceV1(
          withScaP03Digest(
            {
              schema_id: SCA_P03_GRAPH_PROVENANCE_V1_SCHEMA,
              schema_version: 1,
              ...bound.common,
              partition,
              frontend_language: request.frontend_language,
              graph_component_ref: graphRef,
              graph_build_request_ref: requestRef,
              graph_build_result_ref: resultRef,
              runtime_tree_sha256: result.runtime_tree_sha256,
              graph_build_key_sha256: result.graph_build_key_sha256,
              graph_id: result.graph_id,
              expected_files: request.expected_files,
              accounted_files: result.accounted_files,
              graph_opened: true as const,
              cleanup_status: "proven" as const,
            },
            "provenance_sha256"
          )
        );
        provenanceRef = this.persistFinal({
          context,
          branchId: partition,
          kind: "sca-p03-graph-provenance",
          operationId: `sca-p03-graph-provenance-${partition.replaceAll("_", "-")}`,
          schemaId: SCA_P03_GRAPH_PROVENANCE_V1_SCHEMA,
          value: provenance,
          upstreamRefs: [requestRef, resultRef, graphRef],
        });
        graphProvenanceRefs.set(partition, provenanceRef);
      }
      return {
        partition,
        graph_component_ref: graphRef ?? null,
        graph_build_result_ref: resultRef,
        graph_provenance_ref: provenanceRef,
        graph_id: result.graph_id,
        status: result.complete
          ? ("complete" as const)
          : result.status === "partial"
            ? ("partial" as const)
            : ("blocked" as const),
      };
    });
    const graphManifest = validateScaP03GraphManifestV1(
      withScaP03Digest(
        {
          schema_id: SCA_P03_GRAPH_MANIFEST_V1_SCHEMA,
          schema_version: 1,
          ...bound.common,
          components: graphComponents,
          complete: graphComponents.every((entry) => entry.status === "complete"),
        },
        "manifest_sha256"
      )
    );
    const graphManifestRef = this.persistFinal({
      context,
      kind: "sca-p03-graph-manifest",
      operationId: "sca-p03-graph-manifest",
      schemaId: SCA_P03_GRAPH_MANIFEST_V1_SCHEMA,
      value: graphManifest,
      upstreamRefs: graphComponents.flatMap((entry) => [
        entry.graph_build_result_ref,
        ...(entry.graph_component_ref === null ? [] : [entry.graph_component_ref]),
        ...(entry.graph_provenance_ref === null ? [] : [entry.graph_provenance_ref]),
      ]),
    });
    const fidelityObservations = SCA_P03_PARTITIONS.flatMap((partition) => {
      const queryStep =
        partition === "php" ? ("query_php" as const) : ("query_javascript_typescript" as const);
      const result = results.get(queryStep);
      return result?.operation_kind === "run_baseline_query_batch"
        ? result.fidelity_observations.map((observation) =>
            observation.support === "supported" && !qualification.qualified
              ? { ...observation, support: "partial" as const, reason_code: "qualification_failed" }
              : observation
          )
        : [];
    });
    const qualifiedComplements = new Set<string>();
    for (const requirement of bound.admitted.profile.fidelity_requirements) {
      if (requirement.complement_evidence_ref === null) continue;
      const complement = validateScaP03FidelityComplementEvidenceV2(
        exactJson(
          this.store,
          requirement.complement_evidence_ref,
          `P03 fidelity complement '${requirement.requirement_id}'`
        )
      );
      if (
        complement.profile_id !== bound.admitted.profile.profile_id ||
        complement.requirement_id !== requirement.requirement_id ||
        complement.partition !== requirement.partition
      ) {
        throw new Error(`P03 fidelity complement '${requirement.requirement_id}' drifted`);
      }
      qualifiedComplements.add(requirement.requirement_id);
    }
    const graphComponentRefs = {
      php:
        graphComponents.find((entry) => entry.partition === "php")?.graph_component_ref ??
        undefined,
      javascript_typescript:
        graphComponents.find((entry) => entry.partition === "javascript_typescript")
          ?.graph_component_ref ?? undefined,
    };
    const fidelityEvidenceRefs = {
      php: [
        qualificationEvidenceRef,
        ...graphComponents
          .filter((entry) => entry.partition === "php")
          .map((entry) => entry.graph_build_result_ref),
        ...(state.operation_result_refs.query_php === undefined
          ? []
          : [state.operation_result_refs.query_php]),
        ...(state.page_refs.php ?? []),
      ],
      javascript_typescript: [
        qualificationEvidenceRef,
        ...graphComponents
          .filter((entry) => entry.partition === "javascript_typescript")
          .map((entry) => entry.graph_build_result_ref),
        ...(state.operation_result_refs.query_javascript_typescript === undefined
          ? []
          : [state.operation_result_refs.query_javascript_typescript]),
        ...(state.page_refs.javascript_typescript ?? []),
      ],
    };
    const supportEntries = deriveScaP03GraphSupportEntriesV1({
      requirements: bound.admitted.profile.fidelity_requirements,
      observations: fidelityObservations,
      qualification_scope: bound.admitted.isolation.qualification_scope,
      graph_component_refs: graphComponentRefs,
      evidence_refs: fidelityEvidenceRefs,
      qualified_complement_requirement_ids: qualifiedComplements,
    });
    const supportMatrix = validateScaP03GraphSupportMatrixV2(
      withScaP03Digest(
        {
          schema_id: SCA_P03_GRAPH_SUPPORT_MATRIX_V2_SCHEMA,
          schema_version: 2,
          ...bound.common,
          profile_ref: bound.admitted.request.qualification_profile_ref,
          entries: supportEntries,
          complete: supportEntries.every((entry) => !entry.material_gap),
        },
        "matrix_sha256"
      )
    );
    const supportMatrixRef = this.persistFinal({
      context,
      kind: "sca-p03-graph-support-matrix",
      operationId: "sca-p03-graph-support-matrix",
      schemaId: SCA_P03_GRAPH_SUPPORT_MATRIX_V2_SCHEMA,
      value: supportMatrix,
      upstreamRefs: [
        graphManifestRef,
        bound.admitted.request.qualification_profile_ref,
        ...supportEntries.flatMap((entry) => [
          ...entry.evidence_refs,
          ...(entry.complement_evidence_ref === null ? [] : [entry.complement_evidence_ref]),
        ]),
      ],
    });

    const batches = SCA_P03_PARTITIONS.flatMap((partition) => {
      const step =
        partition === "php" ? ("query_php" as const) : ("query_javascript_typescript" as const);
      const request = requests.get(step);
      const result = results.get(step);
      const requestRef = state.operation_request_refs[step];
      const resultRef = state.operation_result_refs[step];
      const graphRef = state.graph_component_refs[partition];
      if (
        request?.operation_kind !== "run_baseline_query_batch" ||
        result?.operation_kind !== "run_baseline_query_batch" ||
        requestRef === undefined ||
        resultRef === undefined ||
        graphRef === undefined
      ) {
        return [];
      }
      return [
        {
          partition,
          graph_component_ref: graphRef,
          query_batch_request_ref: requestRef,
          query_batch_result_ref: resultRef,
          page_refs: state.page_refs[partition] ?? [],
          ordered_query_ids: SCA_P03_QUERY_IDS,
          complete: result.complete,
          truncated: result.truncated,
        },
      ];
    });
    const aggregate = validateScaP03BaselineQueryAggregateV2(
      withScaP03Digest(
        {
          schema_id: SCA_P03_BASELINE_QUERY_AGGREGATE_V2_SCHEMA,
          schema_version: 2,
          ...bound.common,
          baseline_query_set_ref: bound.admitted.request.baseline_query_set_ref,
          batches,
          complete:
            batches.length === 2 && batches.every((entry) => entry.complete && !entry.truncated),
        },
        "aggregate_sha256"
      )
    );
    const aggregateRef = this.persistFinal({
      context,
      kind: "sca-p03-baseline-query-aggregate",
      operationId: "sca-p03-baseline-query-aggregate",
      schemaId: SCA_P03_BASELINE_QUERY_AGGREGATE_V2_SCHEMA,
      value: aggregate,
      upstreamRefs: [
        bound.admitted.request.baseline_query_set_ref,
        ...batches.flatMap((entry) => [
          entry.graph_component_ref,
          entry.query_batch_request_ref,
          entry.query_batch_result_ref,
          ...entry.page_refs,
        ]),
      ],
    });

    const packetCandidates = batches.flatMap((batch) =>
      batch.page_refs.flatMap((pageRef) => {
        const page = validateScaP03BaselineQueryPageV2(
          exactJson(this.store, pageRef, "P03 candidate source page")
        );
        return page.items.map((item) => ({
          ...item,
          partition: batch.partition,
          accounted_paths: page.accounted_paths,
          graph_component_ref: batch.graph_component_ref,
          page_ref: pageRef,
        }));
      })
    );
    const packet = validateScaP03GraphCandidatePacketV2(
      withScaP03Digest(
        {
          schema_id: SCA_P03_GRAPH_CANDIDATE_PACKET_V2_SCHEMA,
          schema_version: 2,
          ...bound.common,
          baseline_query_set_ref: bound.admitted.request.baseline_query_set_ref,
          graph_manifest_ref: graphManifestRef,
          candidates: packetCandidates.sort((left, right) =>
            left.candidate_id.localeCompare(right.candidate_id)
          ),
          complete:
            graphManifest.complete &&
            aggregate.complete &&
            packetCandidates.every((candidate) => !candidate.truncated),
          source_bound: graphManifest.complete && aggregate.complete,
        },
        "packet_sha256"
      )
    );
    validateScaP03PacketAgainstQueryPagesV2({
      packet,
      aggregate,
      graph_manifest: graphManifest,
      pages: batches.flatMap((batch) =>
        batch.page_refs.map((ref) => ({
          ref,
          page: validateScaP03BaselineQueryPageV2(
            exactJson(this.store, ref, "P03 packet source page")
          ),
        }))
      ),
    });
    const packetRef = this.persistFinal({
      context,
      kind: "sca-p03-graph-candidate-packet",
      operationId: "sca-p03-graph-candidate-packet",
      schemaId: SCA_P03_GRAPH_CANDIDATE_PACKET_V2_SCHEMA,
      value: packet,
      upstreamRefs: [
        graphManifestRef,
        aggregateRef,
        ...batches.flatMap((entry) => entry.page_refs),
      ],
    });

    const graphCoverage = SCA_P03_PARTITIONS.map((partition) => {
      const component = graphComponents.find((entry) => entry.partition === partition);
      if (component === undefined) throw new Error(`P03 coverage lacks ${partition}`);
      return {
        coverage_id: `graph:${partition}`,
        status: component.status,
        blocker_codes: component.status === "complete" ? [] : ["graph_partial"],
        evidence_refs: [
          component.graph_build_result_ref,
          ...(component.graph_component_ref === null ? [] : [component.graph_component_ref]),
          ...(component.graph_provenance_ref === null ? [] : [component.graph_provenance_ref]),
        ],
      };
    });
    const queryCoverage = SCA_P03_QUERY_IDS.map((queryId) => {
      const pageRefs = batches.flatMap((batch) =>
        batch.page_refs.filter((ref) => {
          const page = validateScaP03BaselineQueryPageV2(
            exactJson(this.store, ref, "P03 coverage page")
          );
          return page.query_id === queryId;
        })
      );
      const complete =
        batches.length === 2 &&
        batches.every((batch) => batch.complete && !batch.truncated) &&
        pageRefs.length >= 2;
      return {
        coverage_id: `query:${queryId}`,
        status: complete ? ("complete" as const) : ("blocked" as const),
        blocker_codes: complete ? [] : ["query_matrix_incomplete"],
        evidence_refs:
          pageRefs.length === 0
            ? graphComponents.map((entry) => entry.graph_build_result_ref)
            : pageRefs,
      };
    });
    const coverage = validateScaP03CoverageMatrixV1(
      withScaP03Digest(
        {
          schema_id: SCA_P03_COVERAGE_MATRIX_V1_SCHEMA,
          schema_version: 1,
          ...bound.common,
          entries: [...graphCoverage, ...queryCoverage],
        },
        "coverage_sha256"
      )
    );
    const coverageRef = this.persistFinal({
      context,
      kind: "sca-p03-coverage-matrix",
      operationId: "sca-p03-coverage-matrix",
      schemaId: SCA_P03_COVERAGE_MATRIX_V1_SCHEMA,
      value: coverage,
      upstreamRefs: coverage.entries.flatMap((entry) => entry.evidence_refs),
    });

    const registrationSha256 = context.registrationContractBinding?.registration_sha256;
    if (registrationSha256 === undefined) throw new Error("P03 finalization lacks registration");
    const zeroModel = validateScaP03ZeroModelEvidenceV1(
      withScaP03Digest(
        {
          schema_id: SCA_P03_ZERO_MODEL_EVIDENCE_V1_SCHEMA,
          schema_version: 1,
          ...bound.common,
          registration_sha256: registrationSha256,
          worker_kind: "none" as const,
          worker_phase_count: 0 as const,
          invoke_agent_directives: 0 as const,
          child_workflow_directives: 0 as const,
          provider_calls: 0 as const,
          model_calls: 0 as const,
          model_turns: 0 as const,
          passed: true as const,
        },
        "evidence_sha256"
      )
    );
    const zeroModelRef = this.persistFinal({
      context,
      kind: "sca-p03-zero-model-evidence",
      operationId: "sca-p03-zero-model-evidence",
      schemaId: SCA_P03_ZERO_MODEL_EVIDENCE_V1_SCHEMA,
      value: zeroModel,
      upstreamRefs: [bound.admitted.state.request_ref],
    });

    const qualificationBlockers = [
      ...(bound.admitted.isolation.qualification_scope === "live_qualified"
        ? []
        : ["isolation_unqualified"]),
      ...(qualification.qualified ? [] : ["qualification_failed"]),
    ];
    const qualificationRecord = validateScaP03QualificationRecordV2(
      withScaP03Digest(
        {
          schema_id: SCA_P03_QUALIFICATION_RECORD_V2_SCHEMA,
          schema_version: 2,
          ...bound.common,
          implementation_identity_ref: bound.admitted.request.implementation_identity_ref,
          joern_runtime_identity_ref: bound.admitted.request.joern_runtime_identity_ref,
          isolation_evidence_ref: bound.admitted.request.isolation_evidence_ref,
          host_isolation_attestation_ref: bound.admitted.request.host_isolation_attestation_ref,
          qualification_profile_ref: bound.admitted.request.qualification_profile_ref,
          fixture_corpus_ref: bound.admitted.request.fixture_corpus_ref,
          source_oracle_ref: bound.admitted.request.source_oracle_ref,
          source_oracle_validation_ref: bound.admitted.request.source_oracle_validation_ref,
          parser_identity_sha256: qualification.parser_identity_sha256,
          baseline_query_set_ref: bound.admitted.request.baseline_query_set_ref,
          qualification_evidence_ref: qualificationEvidenceRef,
          operation_log_ref: operationLogRef,
          review_identity: "host-p03-candidate-validation-v1",
          status: qualificationBlockers.length === 0 ? ("passed" as const) : ("blocked" as const),
          live_qualified: qualificationBlockers.length === 0,
          blocker_codes: qualificationBlockers,
        },
        "record_sha256"
      )
    );
    const qualificationRecordRef = this.persistFinal({
      context,
      kind: "sca-p03-qualification-record",
      operationId: "sca-p03-qualification-record",
      schemaId: SCA_P03_QUALIFICATION_RECORD_V2_SCHEMA,
      value: qualificationRecord,
      upstreamRefs: [
        bound.admitted.request.implementation_identity_ref,
        bound.admitted.request.joern_runtime_identity_ref,
        bound.admitted.request.isolation_evidence_ref,
        ...(bound.admitted.request.host_isolation_attestation_ref === null
          ? []
          : [bound.admitted.request.host_isolation_attestation_ref]),
        bound.admitted.request.qualification_profile_ref,
        bound.admitted.request.fixture_corpus_ref,
        bound.admitted.request.source_oracle_ref,
        bound.admitted.request.source_oracle_validation_ref,
        bound.admitted.request.baseline_query_set_ref,
        qualificationEvidenceRef,
        operationLogRef,
      ],
    });

    const evidenceManifest = validateScaP03EvidenceManifestV2(
      withScaP03Digest(
        {
          schema_id: SCA_P03_EVIDENCE_MANIFEST_V2_SCHEMA,
          schema_version: 2,
          ...bound.common,
          p03_request_ref: bound.admitted.state.request_ref,
          source_oracle_ref: bound.admitted.request.source_oracle_ref,
          source_oracle_validation_ref: bound.admitted.request.source_oracle_validation_ref,
          entry_admission_ref: bound.admitted.state.entry_admission_ref,
          qualification_record_ref: qualificationRecordRef,
          graph_manifest_ref: graphManifestRef,
          graph_support_matrix_ref: supportMatrixRef,
          baseline_query_aggregate_ref: aggregateRef,
          candidate_packet_ref: packetRef,
          coverage_matrix_ref: coverageRef,
          zero_model_evidence_ref: zeroModelRef,
          operation_log_ref: operationLogRef,
          operations: operationEntries.map((entry) => ({
            operation_id: entry.operation_id,
            request_ref: entry.request_ref,
            result_ref: entry.result_ref,
            receipt_ref: entry.receipt_ref,
            output_refs: entry.output_refs,
          })),
        },
        "manifest_sha256"
      )
    );
    const evidenceManifestRef = this.persistFinal({
      context,
      kind: "sca-p03-evidence-manifest",
      operationId: "sca-p03-evidence-manifest",
      schemaId: SCA_P03_EVIDENCE_MANIFEST_V2_SCHEMA,
      value: evidenceManifest,
      upstreamRefs: [
        bound.admitted.state.request_ref,
        bound.admitted.request.source_oracle_ref,
        bound.admitted.request.source_oracle_validation_ref,
        bound.admitted.state.entry_admission_ref,
        qualificationRecordRef,
        graphManifestRef,
        supportMatrixRef,
        aggregateRef,
        packetRef,
        coverageRef,
        zeroModelRef,
        operationLogRef,
        ...operationEntries.flatMap((entry) => [
          entry.request_ref,
          entry.result_ref,
          entry.receipt_ref,
          ...entry.output_refs,
        ]),
      ],
    });

    const blockers = [
      ...qualificationRecord.blocker_codes,
      ...(graphManifest.complete ? [] : ["graph_partial"]),
      ...(supportMatrix.complete ? [] : ["material_graph_fidelity_gap"]),
      ...supportMatrix.entries.flatMap((entry) => (entry.material_gap ? entry.blocker_codes : [])),
      ...(aggregate.complete ? [] : ["query_matrix_incomplete"]),
      ...(batches.some((entry) => entry.truncated) ? ["query_truncated"] : []),
      ...(packet.complete && packet.source_bound ? [] : ["candidate_packet_incomplete"]),
      ...(coverage.entries.every((entry) => entry.status === "complete")
        ? []
        : ["coverage_incomplete"]),
      ...(graphComponents.every((entry) => {
        const step =
          entry.partition === "php"
            ? ("build_php" as const)
            : ("build_javascript_typescript" as const);
        const result = results.get(step);
        return (
          result?.operation_kind === "build_source_graph" && result.cleanup_status === "proven"
        );
      })
        ? []
        : ["cleanup_unproven"]),
    ]
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort();
    const phaseSatisfied = blockers.length === 0;
    validateScaP02SuccessorLedgerV1(
      exactJson(
        this.store,
        bound.admitted.request.accepted_p02.successor_ledger_ref,
        "P02 successor ledger"
      )
    );
    const ledger = validateScaP03SuccessorLedgerV1(
      withScaP03Digest(
        {
          schema_id: SCA_P03_SUCCESSOR_LEDGER_V1_SCHEMA,
          schema_version: 1,
          ...bound.common,
          prior_p02_ledger_ref: bound.admitted.request.accepted_p02.successor_ledger_ref,
          prior_p02_ledger_sha256:
            bound.admitted.request.accepted_p02.successor_ledger_ref.content_digest,
          dispositions: [
            {
              obligation_id: SCA_P03_OBLIGATION_IDS[0],
              status:
                graphManifest.complete && supportMatrix.complete
                  ? ("satisfied" as const)
                  : ("blocked" as const),
              evidence_refs: [graphManifestRef, supportMatrixRef],
            },
            {
              obligation_id: SCA_P03_OBLIGATION_IDS[1],
              status:
                aggregate.complete && supportMatrix.complete
                  ? ("satisfied" as const)
                  : ("blocked" as const),
              evidence_refs: [aggregateRef, coverageRef],
            },
            {
              obligation_id: SCA_P03_OBLIGATION_IDS[2],
              status: packet.complete ? ("satisfied" as const) : ("blocked" as const),
              evidence_refs: [packetRef, coverageRef],
            },
            {
              obligation_id: SCA_P03_OBLIGATION_IDS[3],
              status: phaseSatisfied ? ("satisfied" as const) : ("blocked" as const),
              evidence_refs: [evidenceManifestRef, coverageRef],
            },
          ],
          pending_phase_ids: [
            "SCA-P04",
            "SCA-P05",
            "SCA-P06",
            "SCA-P07",
            "SCA-P08",
            "SCA-P09",
            "SCA-P10",
            "SCA-P11",
            "SCA-P12",
          ] as const,
          append_only: true as const,
          campaign_completion_claimed: false as const,
          release_eligible: false as const,
          recorded_at: this.now().toISOString(),
        },
        "ledger_sha256"
      )
    );
    const ledgerRef = this.persistFinal({
      context,
      kind: "sca-p03-successor-obligation-ledger",
      operationId: "sca-p03-successor-obligation-ledger",
      schemaId: SCA_P03_SUCCESSOR_LEDGER_V1_SCHEMA,
      value: ledger,
      upstreamRefs: [
        bound.admitted.request.accepted_p02.successor_ledger_ref,
        evidenceManifestRef,
        graphManifestRef,
        supportMatrixRef,
        aggregateRef,
        packetRef,
        coverageRef,
      ],
    });

    const gate = validateScaP03GateV1(
      withScaP03Digest(
        {
          schema_id: SCA_P03_GATE_V1_SCHEMA,
          schema_version: 1,
          ...bound.common,
          p03_request_ref: bound.admitted.state.request_ref,
          entry_admission_ref: bound.admitted.state.entry_admission_ref,
          qualification_record_ref: qualificationRecordRef,
          graph_manifest_ref: graphManifestRef,
          graph_support_matrix_ref: supportMatrixRef,
          baseline_query_aggregate_ref: aggregateRef,
          candidate_packet_ref: packetRef,
          coverage_matrix_ref: coverageRef,
          evidence_manifest_ref: evidenceManifestRef,
          successor_ledger_ref: ledgerRef,
          zero_model_evidence_ref: zeroModelRef,
          isolation_scope: bound.admitted.isolation.qualification_scope,
          status: phaseSatisfied ? ("passed" as const) : ("blocked" as const),
          blocker_codes: blockers,
          evaluated_at: this.now().toISOString(),
        },
        "gate_sha256"
      )
    );
    const gateRef = this.persistFinal({
      context,
      kind: "sca-p03-gate",
      operationId: "sca-p03-gate",
      schemaId: SCA_P03_GATE_V1_SCHEMA,
      value: gate,
      upstreamRefs: [
        bound.admitted.state.request_ref,
        bound.admitted.state.entry_admission_ref,
        qualificationRecordRef,
        graphManifestRef,
        supportMatrixRef,
        aggregateRef,
        packetRef,
        coverageRef,
        evidenceManifestRef,
        ledgerRef,
        zeroModelRef,
      ],
    });

    let transitionRef: ArtifactRef | null = null;
    if (gate.status === "passed") {
      const transitionedAt = this.now().toISOString();
      const transition = validateScaP03P04TransitionV2(
        withScaP03Digest(
          {
            schema_id: SCA_P03_P04_TRANSITION_V2_SCHEMA,
            schema_version: 2,
            ...bound.common,
            from_phase_id: "SCA-P03" as const,
            to_phase_id: "SCA-P04" as const,
            p03_request_ref: bound.admitted.state.request_ref,
            source_oracle_ref: bound.admitted.request.source_oracle_ref,
            source_oracle_validation_ref: bound.admitted.request.source_oracle_validation_ref,
            p02_m1_ref: bound.admitted.request.accepted_p02.m1_ref,
            p02_evidence_manifest_ref: bound.admitted.request.accepted_p02.evidence_manifest_ref,
            entry_admission_ref: bound.admitted.state.entry_admission_ref,
            qualification_record_ref: qualificationRecordRef,
            graph_manifest_ref: graphManifestRef,
            graph_support_matrix_ref: supportMatrixRef,
            baseline_query_aggregate_ref: aggregateRef,
            candidate_packet_ref: packetRef,
            coverage_matrix_ref: coverageRef,
            evidence_manifest_ref: evidenceManifestRef,
            successor_ledger_ref: ledgerRef,
            zero_model_evidence_ref: zeroModelRef,
            gate_ref: gateRef,
            p04_entry_authorized: true as const,
            campaign_terminal: false as const,
            release_eligible: false as const,
            transitioned_at: transitionedAt,
          },
          "transition_sha256"
        )
      );
      validateScaP03TransitionAgainstGateV1({
        transition,
        gate,
        gate_ref: gateRef,
        request_ref: bound.admitted.state.request_ref,
        p02_m1_ref: bound.admitted.request.accepted_p02.m1_ref,
        p02_evidence_manifest_ref: bound.admitted.request.accepted_p02.evidence_manifest_ref,
      });
      transitionRef = this.persistFinal({
        context,
        kind: "sca-p03-p04-transition",
        operationId: "sca-p03-p04-transition",
        schemaId: SCA_P03_P04_TRANSITION_V2_SCHEMA,
        value: transition,
        upstreamRefs: [
          bound.admitted.state.request_ref,
          bound.admitted.request.source_oracle_ref,
          bound.admitted.request.source_oracle_validation_ref,
          bound.admitted.request.accepted_p02.m1_ref,
          bound.admitted.request.accepted_p02.evidence_manifest_ref,
          bound.admitted.state.entry_admission_ref,
          qualificationRecordRef,
          graphManifestRef,
          supportMatrixRef,
          aggregateRef,
          packetRef,
          coverageRef,
          evidenceManifestRef,
          ledgerRef,
          zeroModelRef,
          gateRef,
        ],
      });
    }

    context.previousState = context.stateId;
    context.stateId = FINAL_STATE;
    context.status = "incomplete";
    context.met = false;
    context.pendingBranches = [];
    const terminalResult = validateScaP03TerminalV2({
      schema_id: SCA_P03_TERMINAL_V2_SCHEMA,
      schema_version: 2,
      phase_id: "SCA-P03",
      boundary: transitionRef === null ? "blocked_at_p03" : "p04",
      gate_status: gate.status,
      p03_request_ref: bound.admitted.state.request_ref,
      source_oracle_ref: bound.admitted.request.source_oracle_ref,
      source_oracle_validation_ref: bound.admitted.request.source_oracle_validation_ref,
      graph_manifest_ref: graphManifestRef,
      baseline_query_aggregate_ref: aggregateRef,
      candidate_packet_ref: packetRef,
      coverage_matrix_ref: coverageRef,
      evidence_manifest_ref: evidenceManifestRef,
      successor_ledger_ref: ledgerRef,
      gate_ref: gateRef,
      transition_ref: transitionRef,
      blocker_codes: gate.blocker_codes,
      campaign_terminal: false,
      release_eligible: false,
      model_calls: 0,
      model_turns: 0,
    });
    const terminal = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: terminalResult,
      artifacts: this.terminalArtifacts(context),
      unresolved:
        transitionRef === null
          ? gate.blocker_codes
          : ["SCA-P04 requires a separate admission and is outside this P03 candidate."],
    });
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    return terminal;
  }

  private now(): Date {
    const value = this.trustedClock();
    if (!Number.isFinite(value.getTime())) throw new Error("P03 trusted clock is invalid");
    return value;
  }

  private terminalArtifacts(context: RunContext): ArtifactRef[] {
    return uniqueRefs(
      context.selectedArtifacts.filter(
        (ref) => ref.run_id === context.identity.run_id || ref.kind.startsWith("host-operation-")
      )
    ).slice(0, 2_048);
  }
}

function p03Registration(input: {
  readonly name: string;
  readonly contract: SkillContract;
  readonly start_admission: StartAdmissionV1;
  readonly goal: string;
  readonly semantic_caveat: string;
  readonly construction_label: string;
}): PlaybookRegistration {
  return {
    name: input.name,
    contract: input.contract,
    ingress: "skill",
    start_admission: input.start_admission,
    caller_documentation: {
      constraints_schema: ScaP03StartConstraintsV1Schema,
      example: {
        goal: input.goal,
        constraints: { p03_request: {} },
      },
      semantic_caveat: input.semantic_caveat,
    },
    liveness: {
      resolver_id: input.contract.budget_policy.resolver_id,
      resolve: () => undefined,
      thinking_policy: "agent_ssot",
    },
    worker: {
      kind: "none",
      workflow_name: input.name,
      guidance: input.contract.guidance,
      guidance_required: true,
      result_transport: "host_typed",
      opening_policy: "none",
      model_policy: "none",
      phases: new Map<string, never>(),
    },
    host_states: [...Object.values(STATE), FINAL_STATE],
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: [
        SCA_P03_OPERATION_DECLARATIONS.qualify,
        SCA_P03_OPERATION_DECLARATIONS.build_source_graph,
        SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch,
      ],
    },
    completionReceiptPredicates: new Map(),
    construct(options: PlaybookConstructionOptions): PlaybookCore {
      if (options.artifactStore === undefined) {
        throw new Error(`${input.construction_label} requires the artifact host store`);
      }
      return new ScaP03CandidatePlaybook(
        options.artifactStore,
        options.trustedClock ?? (() => new Date())
      );
    },
  };
}
export const SCA_P03_CANDIDATE_REGISTRATION: PlaybookRegistration = p03Registration({
  name: SCA_P03_CANDIDATE_PLAYBOOK_NAME,
  contract: SCA_P03_CANDIDATE_SKILL_CONTRACT,
  start_admission: START_ADMISSION,
  goal: "Run the admitted inactive deterministic SCA P03 candidate.",
  semantic_caveat:
    "Candidate-only: deterministic test isolation cannot claim AC-P03 or authorize P04.",
  construction_label: "SCA P03 candidate",
});
/** Accepted phase only: never added to the user-facing PLAYBOOK_REGISTRY. */
export const SCA_P03_PHASE_REGISTRATION: PlaybookRegistration = p03Registration({
  name: SCA_P03_PHASE_PLAYBOOK_NAME,
  contract: SCA_P03_PHASE_SKILL_CONTRACT,
  start_admission: PHASE_START_ADMISSION,
  goal: "Run the accepted deterministic SCA P03 phase.",
  semantic_caveat:
    "Phase-only: produces the P03→P04 handoff, not campaign completion, release eligibility, or activation authority.",
  construction_label: "SCA P03 accepted phase",
});

export function scaP03RegistrationSha256(): string {
  return runtimeRegistrationSha256(SCA_P03_CANDIDATE_REGISTRATION);
}
