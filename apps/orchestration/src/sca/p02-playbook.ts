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
import type {
  PlaybookConstructionOptions,
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import {
  SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
  SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
  SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
  SCA_OBLIGATION_LEDGER_V2_SCHEMA,
  SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
  SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
  SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
  SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
  SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
  SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
  SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA,
  SCA_PHASE_GATE_RECORD_V2_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
  SCA_SOURCE_PROVENANCE_V1_SCHEMA,
  validateScaCampaignManifestCoreV1,
  validateScaObligationLedgerV2,
  validateScaP01AdmissionRequestV3,
} from "./p01-contracts.js";
import {
  SCA_ANALYSIS_PROFILE_V1_SCHEMA,
  SCA_AUTHORITY_POLICY_V1_SCHEMA,
  SCA_MODEL_DATA_POLICY_V1_SCHEMA,
  SCA_NETWORK_POLICY_V1_SCHEMA,
  SCA_OUTPUT_POLICY_V1_SCHEMA,
  SCA_P01_RULE_BUNDLE_V1_SCHEMA,
  SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA,
  SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
  SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
  SCA_PRIVACY_POLICY_V1_SCHEMA,
  SCA_RESOURCE_POLICY_V1_SCHEMA,
  SCA_RULE_PROFILE_V1_SCHEMA,
  SCA_RULE_RELEASE_V1_SCHEMA,
  SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
  validateScaP01RuleBundleV1,
  validateScaP01SelectedRuleManifestV1,
  validateScaToolchainIdentityV1,
} from "./p01-policy-contracts.js";
import {
  admitScaP02Candidate,
  createScaP03TransitionAdmissionV1,
  scaP02InputArtifacts,
} from "./p02-admission.js";
import {
  SCA_M1_RECORD_V2_SCHEMA,
  SCA_P02_ANALYZER_IDS,
  SCA_P02_CANDIDATE_PRODUCER,
  SCA_P02_CANDIDATE_REQUEST_KIND,
  SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
  SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA,
  SCA_P02_GATE_V1_SCHEMA,
  SCA_P02_GITLEAKS_REQUEST_V1_SCHEMA,
  SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
  SCA_P02_HOST_ATTESTATION_KIND,
  SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
  SCA_P02_INPUT_SLOTS,
  SCA_P02_INVENTORY_REQUEST_V1_SCHEMA,
  SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
  SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
  SCA_P02_OPERATION_IDS,
  SCA_P02_OSV_COMPOSER_REQUEST_V1_SCHEMA,
  SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
  SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA,
  SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
  SCA_P02_P03_TRANSITION_V1_SCHEMA,
  SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA,
  SCA_P02_REQUEST_V1_SCHEMA,
  SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
  SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA,
  SCA_P02_SEMGREP_JS_TS_REQUEST_V1_SCHEMA,
  SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
  SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA,
  SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
  ScaP02RequestV1Schema,
  admitScaP02OperationResultV1,
  scaP02P01BindingSha256,
  scaP02OperationProfileSha256,
  validateScaM1AgainstGateV2,
  validateScaM1RecordV2,
  validateScaP02CoverageMatrixV1,
  validateScaP02GateAgainstCoverageV1,
  validateScaP02EvidenceManifestV1,
  validateScaP02GateV1,
  validateScaP02IsolationEvidenceV1,
  validateScaP02OperationRequestV1,
  validateScaP02P03TransitionV1,
  validateScaP02PersistedEvidenceV1,
  validateScaP02SuccessorLedgerAgainstP01V1,
  validateScaP02SuccessorLedgerV1,
  validateScaP02TransitionAgainstM1V1,
  validateScaP02RequestV1,
  validateScaP02RuntimePolicyV1,
  withScaP02Digest,
  type ScaP02ComponentValidationAuthorityV1,
  type ScaP02OperationKind,
  type ScaP02OperationRequestV1,
  type ScaP02OperationResultV1,
} from "./p02-contracts.js";

export const SCA_P02_CANDIDATE_PLAYBOOK_NAME = "sca-p02-candidate" as const;
/** Accepted phase registration. It remains outside the user-facing product registry. */
export const SCA_P02_PHASE_PLAYBOOK_NAME = "sca-p02" as const;
export const SCA_P02_START_V1_SCHEMA = "penny.sca-p02-start.v1";
const P02_PHASE = "sca-p02-candidate";
const P02_PRODUCER = SCA_P02_CANDIDATE_PRODUCER;

// Contract evidence remains in the original canonical analyzer order. Runtime
// dispatch is separate so bounded external capabilities can be consumed early
// without changing persisted schemas, manifests, ports, or ledger ordering.
const CONTRACT_ORDER = Object.freeze([
  "inventory",
  "semgrep_php",
  "semgrep_js_ts",
  "gitleaks",
  "osv_composer",
  "osv_npm",
] as const satisfies readonly ScaP02OperationKind[]);
const EXECUTION_ORDER = Object.freeze([
  "inventory",
  // Consume the caller-admitted DNS capability while its bounded TTL is current;
  // local scanners do not depend on OSV results and may outlast that admission.
  "osv_composer",
  "osv_npm",
  "semgrep_php",
  "semgrep_js_ts",
  "gitleaks",
] as const satisfies readonly ScaP02OperationKind[]);
const STATE_BY_KIND: Readonly<Record<ScaP02OperationKind, string>> = Object.freeze({
  inventory: "sca_p02_inventory",
  semgrep_php: "sca_p02_semgrep_php",
  semgrep_js_ts: "sca_p02_semgrep_js_ts",
  gitleaks: "sca_p02_gitleaks",
  osv_composer: "sca_p02_osv_composer",
  osv_npm: "sca_p02_osv_npm",
});
const FINAL_STATE = "sca_p02_finalizing";
const OPERATION_KIND: Readonly<Record<ScaP02OperationKind, string>> = Object.freeze({
  inventory: "sca.p02.inventory.v1",
  semgrep_php: "sca.p02.semgrep-php.v1",
  semgrep_js_ts: "sca.p02.semgrep-js-ts.v1",
  gitleaks: "sca.p02.gitleaks.v1",
  osv_composer: "sca.p02.osv-composer.v1",
  osv_npm: "sca.p02.osv-npm.v1",
});

export const ScaP02StartConstraintsV1Schema = Type.Object(
  { p02_request: ScaP02RequestV1Schema },
  { additionalProperties: false, $id: SCA_P02_START_V1_SCHEMA }
);

const REQUEST_SCHEMA: Readonly<Record<ScaP02OperationKind, string>> = Object.freeze({
  inventory: SCA_P02_INVENTORY_REQUEST_V1_SCHEMA,
  semgrep_php: SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA,
  semgrep_js_ts: SCA_P02_SEMGREP_JS_TS_REQUEST_V1_SCHEMA,
  gitleaks: SCA_P02_GITLEAKS_REQUEST_V1_SCHEMA,
  osv_composer: SCA_P02_OSV_COMPOSER_REQUEST_V1_SCHEMA,
  osv_npm: SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA,
});
const RESULT_SCHEMA: Readonly<Record<ScaP02OperationKind, string>> = Object.freeze({
  inventory: SCA_P02_INVENTORY_RESULT_V1_SCHEMA,
  semgrep_php: SCA_P02_SEMGREP_PHP_RESULT_V1_SCHEMA,
  semgrep_js_ts: SCA_P02_SEMGREP_JS_TS_RESULT_V1_SCHEMA,
  gitleaks: SCA_P02_GITLEAKS_RESULT_V1_SCHEMA,
  osv_composer: SCA_P02_OSV_COMPOSER_RESULT_V1_SCHEMA,
  osv_npm: SCA_P02_OSV_NPM_RESULT_V1_SCHEMA,
});

function operationArtifactContract(
  kind: ScaP02OperationKind,
  direction: "request" | "result"
): HostOperationArtifactContractV1 {
  return {
    schema_version: 1,
    port_name: `p02_${kind}_${direction}`,
    artifact_kind: `sca-p02-${kind.replaceAll("_", "-")}-${direction}`,
    schema_id: direction === "request" ? REQUEST_SCHEMA[kind] : RESULT_SCHEMA[kind],
    schema_version_required: 1,
  };
}

function declaration(kind: ScaP02OperationKind): HostOperationDeclarationV1 {
  const leaseBody = {
    profile_id: `sca-p02-${kind.replaceAll("_", "-")}-lease-v1`,
    profile_version: 1 as const,
    duration_ms: 300_000,
    renew_after_ms: 60_000,
    queue_inactivity_ms: 300_000,
  };
  return {
    schema_version: 1,
    operation_kind: OPERATION_KIND[kind],
    adapter_id: `sca-p02-${kind.replaceAll("_", "-")}-adapter-v1`,
    request: operationArtifactContract(kind, "request"),
    result: operationArtifactContract(kind, "result"),
    backend_binding_id: `sca-p02-${kind.replaceAll("_", "-")}-backend-v1`,
    capability_classes: ["artifact_store"],
    lease_profile: {
      ...leaseBody,
      profile_sha256: hostOperationLeaseProfileSha256(leaseBody),
    },
    operation_inactivity_ms: 300_000,
    max_request_bytes: 64 * 1024 * 1024,
    max_input_artifacts: kind === "inventory" ? 3 : kind.startsWith("osv_") ? 1 : 8,
    max_input_bytes: 512 * 1024 * 1024,
    max_output_artifacts: 1,
    max_output_bytes: 512 * 1024 * 1024,
    max_progress_events: 4_096,
    max_pre_acceptance_retries: 0,
    recovery_semantics: kind.startsWith("osv_")
      ? "journaled_remote_submission_v1"
      : "atomic_local_publication_v1",
    cancellation_semantics: "local_abort_only_v1",
  };
}

export const SCA_P02_OPERATION_DECLARATIONS = Object.freeze({
  inventory: declaration("inventory"),
  semgrep_php: declaration("semgrep_php"),
  semgrep_js_ts: declaration("semgrep_js_ts"),
  gitleaks: declaration("gitleaks"),
  osv_composer: declaration("osv_composer"),
  osv_npm: declaration("osv_npm"),
});

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

const INPUT_PORTS = [
  port({
    name: "p01_request",
    kind: "sca-p01-candidate-request",
    schema: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
    version: 3,
  }),
  port({
    name: "p01_ledger",
    kind: "sca-p01-candidate-obligation-ledger",
    schema: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
    version: 2,
  }),
  port({
    name: "p01_core",
    kind: "sca-p01-candidate-manifest-core",
    schema: SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "p01_admission_evidence",
    kind: "sca-p01-candidate-admission-evidence",
    schema: SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "p01_gate",
    kind: "sca-p01-candidate-gate",
    schema: SCA_PHASE_GATE_RECORD_V2_SCHEMA,
    version: 2,
  }),
  port({
    name: "p01_manifest",
    kind: "sca-p01-candidate-campaign-manifest",
    schema: SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
    version: 2,
  }),
  port({
    name: "source_snapshots",
    kind: "source-snapshot",
    schema: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
    version: 2,
    max: 2,
  }),
  port({
    name: "source_manifests",
    kind: "sca-p01-source-file-manifest",
    schema: SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
    version: 1,
    max: 2,
  }),
  port({
    name: "source_custodies",
    kind: "sca-p01-source-custody-corpus",
    schema: SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
    version: 1,
    max: 2,
  }),
  port({
    name: "source_provenance",
    kind: "source-provenance",
    schema: SCA_SOURCE_PROVENANCE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "variant_capture_manifest",
    kind: "sca-p01-variant-capture-manifest",
    schema: SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA,
    version: 1,
    min: 0,
  }),
  port({
    name: "analysis_profile",
    kind: "sca-analysis-profile",
    schema: SCA_ANALYSIS_PROFILE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "rule_release",
    kind: "sca-rule-release",
    schema: SCA_RULE_RELEASE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "rule_bundle",
    kind: "sca-p01-rule-bundle",
    schema: SCA_P01_RULE_BUNDLE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "rule_profile",
    kind: "sca-rule-profile",
    schema: SCA_RULE_PROFILE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "selected_rule_manifest",
    kind: "sca-p01-selected-rule-manifest",
    schema: SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "toolchain",
    kind: "sca-toolchain",
    schema: SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "tool_executables",
    kind: "sca-p01-tool-executable-package",
    schema: SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
    version: 1,
    min: 2,
    max: 128,
  }),
  port({
    name: "tool_measurements",
    kind: "sca-p01-tool-measurement-receipt",
    schema: SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
    version: 1,
    min: 2,
    max: 128,
  }),
  port({
    name: "network_policy",
    kind: "sca-network-policy",
    schema: SCA_NETWORK_POLICY_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "privacy_policy",
    kind: "sca-privacy-policy",
    schema: SCA_PRIVACY_POLICY_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "model_data_policy",
    kind: "sca-model-data-policy",
    schema: SCA_MODEL_DATA_POLICY_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "resource_policy",
    kind: "sca-resource-policy",
    schema: SCA_RESOURCE_POLICY_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "output_policy",
    kind: "sca-output-policy",
    schema: SCA_OUTPUT_POLICY_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "authority_policy",
    kind: "sca-authority-policy",
    schema: SCA_AUTHORITY_POLICY_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "p01_qualification",
    kind: "sca-phase-qualification",
    schema: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
    version: 2,
  }),
  port({
    name: "implementation_source",
    kind: "sca-p01-implementation-source-bundle",
    schema: SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "implementation_build",
    kind: "sca-p01-implementation-build-bundle",
    schema: SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "runtime_policy",
    kind: "sca-p02-runtime-policy",
    schema: SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "isolation_evidence",
    kind: "sca-p02-isolation-evidence",
    schema: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
    version: 1,
  }),
  port({
    name: "host_isolation_attestation",
    kind: SCA_P02_HOST_ATTESTATION_KIND,
    schema: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
    version: 1,
    min: 0,
  }),
] as const;

const OUTPUT_PORTS = [
  port({
    name: "p02_candidate_request",
    kind: SCA_P02_CANDIDATE_REQUEST_KIND,
    schema: SCA_P02_REQUEST_V1_SCHEMA,
    version: 1,
    min: 0,
    direction: "output",
  }),
  ...CONTRACT_ORDER.flatMap((kind) => [
    port({
      name: `${kind}_request`,
      kind: operationArtifactContract(kind, "request").artifact_kind,
      schema: REQUEST_SCHEMA[kind],
      version: 1,
      min: 0,
      direction: "output",
    }),
    port({
      name: `${kind}_result`,
      kind: operationArtifactContract(kind, "result").artifact_kind,
      schema: RESULT_SCHEMA[kind],
      version: 1,
      min: 0,
      direction: "output",
    }),
  ]),
  port({
    name: "p02_evidence",
    kind: "sca-p02-persisted-evidence",
    schema: SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA,
    version: 1,
    min: 0,
    max: 6,
    direction: "output",
  }),
  port({
    name: "p02_coverage",
    kind: "sca-p02-coverage-matrix",
    schema: SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
    version: 1,
    min: 0,
    direction: "output",
  }),
  port({
    name: "p02_successor_ledger",
    kind: "sca-p02-successor-obligation-ledger",
    schema: SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA,
    version: 1,
    min: 0,
    direction: "output",
  }),
  port({
    name: "p02_evidence_manifest",
    kind: "sca-p02-evidence-manifest",
    schema: SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA,
    version: 1,
    min: 0,
    direction: "output",
  }),
  port({
    name: "p02_gate",
    kind: "sca-p02-gate",
    schema: SCA_P02_GATE_V1_SCHEMA,
    version: 1,
    min: 0,
    direction: "output",
  }),
  port({
    name: "m1",
    kind: "sca-m1-record",
    schema: SCA_M1_RECORD_V2_SCHEMA,
    version: 2,
    min: 0,
    direction: "output",
  }),
  port({
    name: "p02_p03_transition",
    kind: "sca-p02-p03-transition",
    schema: SCA_P02_P03_TRANSITION_V1_SCHEMA,
    version: 1,
    min: 0,
    direction: "output",
  }),
] as const;

function p02SkillContract(input: {
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
        schema_id: SCA_P02_START_V1_SCHEMA,
        schema_version_required: 1,
        artifact_kind: null,
        source: "caller",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
      input_ports: [...INPUT_PORTS],
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
        // Retained for exact P02/P03 artifact compatibility; registration class is bound separately.
        schema_id: "penny.sca-p02-candidate-terminal.v1",
        product_schema_version: 1,
      },
      unresolved_policy: { mode: "max_count", max_count: 0 },
    },
  };
}

export const SCA_P02_CANDIDATE_SKILL_CONTRACT: SkillContract = p02SkillContract({
  name: SCA_P02_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Deterministically orchestrate the inactive SCA P02 inventory and analyzer candidate without model dispatch.",
  policy_id: "penny.sca-p02-candidate-budget.v1",
  resolver_id: "scaP02CandidateDeterministicResolver",
  admission_id: "scaP02CandidateAdmission",
  snapshot_id: "scaP02CandidateSnapshot",
});

export const SCA_P02_PHASE_SKILL_CONTRACT: SkillContract = p02SkillContract({
  name: SCA_P02_PHASE_PLAYBOOK_NAME,
  objective:
    "Run the accepted deterministic SCA P02 inventory and baseline analyzers without model dispatch.",
  policy_id: "penny.sca-p02-phase-budget.v1",
  resolver_id: "scaP02PhaseDeterministicResolver",
  admission_id: "scaP02PhaseAdmission",
  snapshot_id: "scaP02PhaseSnapshot",
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsJsonValue(value: unknown, key: string, expected: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      const entries: readonly unknown[] = current;
      pending.push(...entries);
    } else if (isRecord(current)) {
      if (Reflect.get(current, key) === expected) return true;
      pending.push(...Object.values(current));
    }
  }
  return false;
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
  if (stored === undefined || canonicalJson(stored) !== canonicalJson(ref)) {
    throw new Error(`${label} exact ref is absent or stale`);
  }
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
  readonly kind: string;
  readonly operationId: string;
  readonly producer: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly value: unknown;
  readonly upstreamRefs: readonly ArtifactRef[];
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const prior = input.store.refFor(
    input.runId,
    input.phase,
    null,
    input.kind,
    input.operationId,
    1
  );
  if (prior !== null) {
    if (
      prior.content_digest !== sha256(content) ||
      input.store.readById(prior.artifact_id).toString("utf8") !== content
    ) {
      throw new Error(
        `P02 deterministic artifact '${input.operationId}' conflicts with persisted bytes`
      );
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
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: input.producer,
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: input.schemaVersion },
    parent_ref: null,
    upstream_refs: uniqueRefs(input.upstreamRefs).sort((a, b) =>
      a.artifact_id.localeCompare(b.artifact_id)
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

function p02StartAdmission(playbookName: string): StartAdmissionV1 {
  return {
    schema_id: SCA_P02_START_V1_SCHEMA,
    schema_version: 1,
    prepare(request: StartRequest): PreparedStartV1 {
      const constraints = validateContract(
        ScaP02StartConstraintsV1Schema,
        request.constraints,
        "SCA P02 start constraints"
      );
      const p02 = validateScaP02RequestV1(constraints.p02_request);
      if (
        request.identity.playbook !== playbookName ||
        request.identity.run_id !== p02.run_id ||
        request.input_artifacts === undefined
      ) {
        throw new Error("SCA P02 start identity or exact input artifacts are invalid");
      }
      const expected = scaP02InputArtifacts(p02);
      const expectedRefs = expected.artifacts.map((binding) => canonicalJson(binding.ref)).sort();
      const observedRefs = request.input_artifacts.artifacts
        .map((binding) => canonicalJson(binding.ref))
        .sort();
      if (canonicalJson(expectedRefs) !== canonicalJson(observedRefs)) {
        throw new Error("SCA P02 start inputs do not equal the exact accepted input set");
      }
      return {
        schema_id: SCA_P02_START_V1_SCHEMA,
        schema_version: 1,
        request,
        goal: request.goal,
        constraints,
        input_artifacts: request.input_artifacts,
        admission_data: p02,
      };
    },
    materialize(prepared, host) {
      if (host.artifactStore === undefined)
        throw new Error("SCA P02 admission requires the artifact host store");
      const inputArtifacts = prepared.input_artifacts;
      if (inputArtifacts === undefined)
        throw new Error("SCA P02 admission requires exact input artifacts");
      const admitted = admitScaP02Candidate({
        store: host.artifactStore,
        request: prepared.admission_data,
        input_artifacts: inputArtifacts,
      });
      const requestRef = persistJson({
        store: host.artifactStore,
        runId: host.run_id,
        phase: P02_PHASE,
        kind: SCA_P02_CANDIDATE_REQUEST_KIND,
        operationId: "sca-p02-candidate-request",
        producer: P02_PRODUCER,
        schemaId: SCA_P02_REQUEST_V1_SCHEMA,
        schemaVersion: 1,
        value: admitted.request,
        upstreamRefs: inputArtifacts.artifacts.map((binding) => binding.ref),
      });
      return [requestRef];
    },
  };
}

const SCA_P02_START_ADMISSION = p02StartAdmission(SCA_P02_CANDIDATE_PLAYBOOK_NAME);
const SCA_P02_PHASE_START_ADMISSION = p02StartAdmission(SCA_P02_PHASE_PLAYBOOK_NAME);

const P02OperationRefsSchema = Type.Object(
  {
    inventory: Type.Optional(ArtifactRefSchema),
    semgrep_php: Type.Optional(ArtifactRefSchema),
    semgrep_js_ts: Type.Optional(ArtifactRefSchema),
    gitleaks: Type.Optional(ArtifactRefSchema),
    osv_composer: Type.Optional(ArtifactRefSchema),
    osv_npm: Type.Optional(ArtifactRefSchema),
  },
  { additionalProperties: false }
);
const P02DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    operation_request_refs: P02OperationRefsSchema,
    operation_result_refs: P02OperationRefsSchema,
    evidence_refs: P02OperationRefsSchema,
  },
  { additionalProperties: false }
);
type P02Data = Static<typeof P02DataSchema>;

function data(context: RunContext): P02Data {
  return validateContract(P02DataSchema, context.playbookData, "SCA P02 durable playbook data");
}

function requiredOperationRef(
  refs: P02Data["operation_result_refs"] | P02Data["evidence_refs"],
  kind: ScaP02OperationKind,
  label: string
): ArtifactRef {
  const ref = refs[kind];
  if (ref === undefined) throw new Error(`P02 ${label} lacks ${kind}`);
  return ref;
}

function resultKind(kind: ScaP02OperationKind): string {
  return operationArtifactContract(kind, "result").artifact_kind;
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

function unsignedDigest<T extends Readonly<Record<string, unknown>>>(value: T) {
  return { ...value, request_sha256: sha256(canonicalJson(value)) };
}

export class ScaP02CandidatePlaybook implements PlaybookCore, HostContinuationCapabilityV1 {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly trustedClock: () => Date,
    private readonly componentValidationAuthority: ScaP02ComponentValidationAuthorityV1
  ) {}

  initialize(context: RunContext): Directive {
    const requestRef = latestSelected(
      context,
      (ref) =>
        ref.kind === SCA_P02_CANDIDATE_REQUEST_KIND &&
        ref.producer === SCA_P02_CANDIDATE_PRODUCER &&
        ref.run_id === context.identity.run_id &&
        ref.media_type === "application/json" &&
        ref.content_schema?.schema_id === SCA_P02_REQUEST_V1_SCHEMA &&
        ref.content_schema.schema_version === 1
    );
    if (requestRef === undefined) throw new Error("SCA P02 admitted request artifact is absent");
    Object.assign(context.playbookData, {
      request_ref: requestRef,
      operation_request_refs: {},
      operation_result_refs: {},
      evidence_refs: {},
    });
    context.transition(STATE_BY_KIND.inventory);
    const next = validateDirective({
      schema_version: 2,
      action: "status",
      identity: context.identity,
      status: "running",
      state_id: context.stateId,
      terminal: false,
      met: false,
    });
    context.pendingDirective = next;
    return next;
  }

  dispatch(context: RunContext): Directive {
    const kind = EXECUTION_ORDER.find((candidate) => STATE_BY_KIND[candidate] === context.stateId);
    if (kind === undefined)
      throw new Error(`SCA P02 has no dispatch for state '${context.stateId}'`);
    const state = data(context);
    const resultRef = latestSelected(context, (ref) => ref.kind === resultKind(kind));
    if (resultRef === undefined)
      throw new Error(`SCA P02 ${kind} result is absent after host settlement`);
    const requestRef = state.operation_request_refs[kind];
    if (requestRef === undefined) {
      throw new Error(`SCA P02 ${kind} request is absent`);
    }
    const operationRequest = validateScaP02OperationRequestV1(
      kind,
      exactJson(this.store, requestRef, `${kind} request`)
    );
    const result = admitScaP02OperationResultV1(
      kind,
      operationRequest,
      exactJson(this.store, resultRef, `${kind} result`),
      this.componentValidationAuthority
    );
    if (result.request_sha256 !== operationRequest.request_sha256) {
      throw new Error(`SCA P02 ${kind} result is stale or misbound`);
    }
    const prior = state.operation_result_refs[kind];
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(resultRef)) {
      throw new Error(`SCA P02 ${kind} accepted result changed across replay`);
    }
    state.operation_result_refs[kind] = resultRef;
    state.evidence_refs[kind] = this.persistEvidence(context, kind, resultRef, result);
    const index = EXECUTION_ORDER.indexOf(kind);
    const nextKind = EXECUTION_ORDER[index + 1];
    if (nextKind !== undefined) {
      context.transition(STATE_BY_KIND[nextKind]);
      return this.issueOperation(context, nextKind);
    }
    context.transition(FINAL_STATE);
    return this.finalize(context);
  }

  resume(): Directive {
    throw new Error("SCA P02 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = "cancelled";
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
        phase_id: "SCA-P02",
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
    throw new Error("SCA P02 deterministic candidate never accepts worker summaries");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }

  needsHostContinuation(context: RunContext): boolean {
    return context.terminalDirective === null && context.stateId === STATE_BY_KIND.inventory;
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context))
      throw new Error("SCA P02 host continuation is unavailable");
    const directive = this.issueOperation(context, "inventory");
    return {
      event_type: "sca_p02_inventory_scheduled",
      payload: { run_id: context.identity.run_id, operation_id: SCA_P02_OPERATION_IDS.inventory },
      directive,
      after_checkpoint_fault: "sca_p02:inventory_scheduled",
    };
  }

  private readAdmitted(context: RunContext) {
    const request = validateScaP02RequestV1(
      exactJson(this.store, data(context).request_ref, "P02 request")
    );
    const policy = validateScaP02RuntimePolicyV1(
      exactJson(this.store, request.runtime_policy_ref, "P02 runtime policy")
    );
    const core = validateScaCampaignManifestCoreV1(
      exactJson(this.store, request.accepted_p01.campaign_manifest_core_ref, "P01 manifest core")
    );
    const p01Request = validateScaP01AdmissionRequestV3(
      exactJson(this.store, request.accepted_p01.request_ref, "P01 request")
    );
    return { request, policy, core, p01Request };
  }

  private toolInputs(context: RunContext, toolId: string) {
    const admitted = this.readAdmitted(context);
    const toolchain = validateScaToolchainIdentityV1(
      exactJson(this.store, admitted.core.frozen_refs.toolchain_ref, "P01 toolchain")
    );
    const tool = toolchain.tools.find((candidate) => candidate.tool_id === toolId);
    if (tool === undefined)
      throw new Error(`P02 runtime tool '${toolId}' is not in the frozen toolchain`);
    const executable = admitted.policy.executables.find(
      (candidate) => candidate.tool_id === toolId
    );
    if (
      executable === undefined ||
      tool.role !== "scanner" ||
      executable.executable_sha256 !== tool.executable_sha256 ||
      executable.version !== tool.version
    ) {
      throw new Error(`P02 runtime tool '${toolId}' drifts from the frozen toolchain`);
    }
    return {
      executable,
      refs: [
        { slot: SCA_P02_INPUT_SLOTS.toolchain, ref: admitted.core.frozen_refs.toolchain_ref },
        { slot: SCA_P02_INPUT_SLOTS.tool_executable, ref: tool.executable_ref },
        { slot: SCA_P02_INPUT_SLOTS.tool_measurement, ref: tool.measurement_receipt_ref },
      ],
    };
  }

  private buildOperation(
    context: RunContext,
    kind: ScaP02OperationKind
  ): {
    request: ScaP02OperationRequestV1;
    inputs: readonly { readonly slot: string; readonly ref: ArtifactRef }[];
  } {
    const { request, policy, core } = this.readAdmitted(context);
    const isolation = validateScaP02IsolationEvidenceV1(
      exactJson(this.store, request.isolation_evidence_ref, "P02 isolation evidence")
    );
    const common = {
      schema_version: 1 as const,
      run_id: request.run_id,
      operation_id: SCA_P02_OPERATION_IDS[kind],
      operation_kind: kind,
      p01_binding_sha256: scaP02P01BindingSha256(request),
      p02_request_ref: data(context).request_ref,
      runtime_policy_ref: request.runtime_policy_ref,
      isolation_evidence_ref: request.isolation_evidence_ref,
      isolation_id: isolation.isolation_id,
      isolation_runtime_id: isolation.runtime_id,
      isolation_runtime_kind: isolation.runtime_kind,
      isolation_qualification_scope: isolation.qualification_scope,
      isolation_profile_id: isolation.profile_id,
      isolation_profile_sha256: scaP02OperationProfileSha256(isolation, kind),
      isolation_implementation_sha256: isolation.implementation_identity_sha256,
      isolation_deployment_sha256: isolation.deployment_identity_sha256,
      isolation_host_attestation_id:
        isolation.qualification_scope === "live_qualified" ? isolation.host_attestation_id : null,
      isolation_host_attestation_sha256:
        isolation.qualification_scope === "live_qualified"
          ? isolation.host_attestation_sha256
          : null,
      isolation_host_attestation_ref:
        isolation.qualification_scope === "live_qualified" ? isolation.host_attestation_ref : null,
    };
    const liveIsolationInput =
      isolation.qualification_scope === "live_qualified"
        ? [{ slot: SCA_P02_INPUT_SLOTS.isolation_evidence, ref: request.isolation_evidence_ref }]
        : [];
    const sourceInputs = [
      ...liveIsolationInput,
      {
        slot: SCA_P02_INPUT_SLOTS.source_file_manifest,
        ref: core.frozen_refs.source_file_manifest_ref,
      },
      { slot: SCA_P02_INPUT_SLOTS.source_custody, ref: core.frozen_refs.source_custody_ref },
    ];
    if (kind === "inventory") {
      const unsigned = {
        schema_id: SCA_P02_INVENTORY_REQUEST_V1_SCHEMA,
        ...common,
        source_snapshot_ref: core.frozen_refs.source_snapshot_ref,
        source_snapshot_sha256: core.frozen_refs.source_snapshot_ref.content_digest,
        staging_parent: policy.staging_parent,
        source_census_identity_sha256: policy.internal_component_identities.source_census_sha256,
        tree_sitter_identity_sha256: policy.internal_component_identities.tree_sitter_sha256,
        tree_sitter: policy.tree_sitter,
      };
      return {
        request: validateScaP02OperationRequestV1(kind, unsignedDigest(unsigned)),
        inputs: sourceInputs,
      };
    }
    if (kind === "semgrep_php" || kind === "semgrep_js_ts" || kind === "gitleaks") {
      const toolId =
        kind === "gitleaks"
          ? policy.operation_tools.gitleaks_tool_id
          : policy.operation_tools.semgrep_tool_id;
      const tool = this.toolInputs(context, toolId);
      const ruleBundle = validateScaP01RuleBundleV1(
        exactJson(this.store, core.frozen_refs.rule_bundle_ref, "P01 rule bundle")
      );
      const selectedRuleManifest = validateScaP01SelectedRuleManifestV1(
        exactJson(
          this.store,
          core.frozen_refs.selected_rule_manifest_ref,
          "P01 selected rule manifest"
        )
      );
      const selectedIds = new Set(selectedRuleManifest.selected_rule_ids);
      const selectedRules = ruleBundle.rules.filter((rule) => selectedIds.has(rule.rule_id));
      const scannerInputs = [
        ...sourceInputs,
        { slot: SCA_P02_INPUT_SLOTS.rule_bundle, ref: core.frozen_refs.rule_bundle_ref },
        {
          slot: SCA_P02_INPUT_SLOTS.selected_rule_manifest,
          ref: core.frozen_refs.selected_rule_manifest_ref,
        },
        ...tool.refs,
      ];
      const base = {
        ...common,
        source_snapshot_ref: core.frozen_refs.source_snapshot_ref,
        source_snapshot_sha256: core.frozen_refs.source_snapshot_ref.content_digest,
        staging_parent: policy.staging_parent,
        executable: tool.executable,
        timeout_ms: policy.process_timeout_ms,
        max_output_bytes:
          kind === "gitleaks" ? policy.gitleaks_max_output_bytes : policy.semgrep_max_output_bytes,
      };
      const unsigned =
        kind === "semgrep_php"
          ? {
              schema_id: SCA_P02_SEMGREP_PHP_REQUEST_V1_SCHEMA,
              ...base,
              languages: ["php"] as const,
              excluded_rule_ids: [policy.gitleaks_configuration_rule_id],
              selected_rule_bindings: selectedRules
                .filter(
                  (rule) =>
                    rule.language === "php" &&
                    rule.rule_id !== policy.gitleaks_configuration_rule_id
                )
                .map((rule) => ({
                  rule_id: rule.rule_id,
                  content_sha256: rule.content_sha256,
                })),
            }
          : kind === "semgrep_js_ts"
            ? {
                schema_id: SCA_P02_SEMGREP_JS_TS_REQUEST_V1_SCHEMA,
                ...base,
                languages: ["javascript", "typescript"] as const,
                excluded_rule_ids: [policy.gitleaks_configuration_rule_id],
                selected_rule_bindings: selectedRules
                  .filter(
                    (rule) =>
                      (rule.language === "javascript" || rule.language === "typescript") &&
                      rule.rule_id !== policy.gitleaks_configuration_rule_id
                  )
                  .map((rule) => ({
                    rule_id: rule.rule_id,
                    content_sha256: rule.content_sha256,
                  })),
              }
            : {
                schema_id: SCA_P02_GITLEAKS_REQUEST_V1_SCHEMA,
                ...base,
                configuration_rule_binding: (() => {
                  const rule = selectedRules.find(
                    (candidate) => candidate.rule_id === policy.gitleaks_configuration_rule_id
                  );
                  if (rule === undefined) {
                    throw new Error("P02 Gitleaks configuration is not selected");
                  }
                  return { rule_id: rule.rule_id, content_sha256: rule.content_sha256 };
                })(),
              };
      return {
        request: validateScaP02OperationRequestV1(kind, unsignedDigest(unsigned)),
        inputs: scannerInputs,
      };
    }
    const inventoryRef = data(context).operation_result_refs.inventory;
    if (inventoryRef === undefined)
      throw new Error("P02 OSV request lacks accepted dependency inventory");
    const inventoryRequestRef = data(context).operation_request_refs.inventory;
    if (inventoryRequestRef === undefined) {
      throw new Error("P02 dependency inventory request is absent");
    }
    const inventoryRequest = validateScaP02OperationRequestV1(
      "inventory",
      exactJson(this.store, inventoryRequestRef, "P02 dependency inventory request")
    );
    const inventory = admitScaP02OperationResultV1(
      "inventory",
      inventoryRequest,
      exactJson(this.store, inventoryRef, "P02 dependency inventory result"),
      this.componentValidationAuthority
    );
    if (inventory.operation_kind !== "inventory") {
      throw new Error("P02 dependency inventory result has the wrong operation kind");
    }
    const ecosystem = kind === "osv_composer" ? "Packagist" : "npm";
    const coordinates = inventory.dependency_coordinates.filter(
      (entry) => entry.package.ecosystem === ecosystem
    );
    const coordinateIds = new Set(coordinates.map((entry) => entry.query_id));
    const mappings = inventory.dependency_mappings.filter((entry) =>
      coordinateIds.has(entry.query_id)
    );
    const osvBase = {
      ...common,
      coordinates,
      mappings,
      transport_id: policy.osv.transport_id,
      max_batch_size: policy.osv.max_batch_size,
      max_concurrency: policy.osv.max_concurrency,
      timeout_ms: policy.osv.timeout_ms,
      max_response_bytes: policy.osv.max_response_bytes,
      max_advisory_requests: policy.osv.max_advisory_requests,
      freshness_max_age_seconds: policy.osv.freshness_max_age_seconds,
    };
    const unsigned =
      kind === "osv_composer"
        ? {
            schema_id: SCA_P02_OSV_COMPOSER_REQUEST_V1_SCHEMA,
            ...osvBase,
            ecosystem: "Packagist" as const,
          }
        : { schema_id: SCA_P02_OSV_NPM_REQUEST_V1_SCHEMA, ...osvBase, ecosystem: "npm" as const };
    return {
      request: validateScaP02OperationRequestV1(kind, unsignedDigest(unsigned)),
      inputs: liveIsolationInput,
    };
  }

  private issueOperation(context: RunContext, kind: ScaP02OperationKind): Directive {
    const state = data(context);
    const prepared = this.buildOperation(context, kind);
    const validated = validateScaP02OperationRequestV1(kind, prepared.request);
    const requestRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P02_PHASE,
      kind: operationArtifactContract(kind, "request").artifact_kind,
      operationId: SCA_P02_OPERATION_IDS[kind],
      producer: P02_PRODUCER,
      schemaId: REQUEST_SCHEMA[kind],
      schemaVersion: 1,
      value: validated,
      upstreamRefs: [
        ...prepared.inputs.map((binding) => binding.ref),
        validated.p02_request_ref,
        validated.runtime_policy_ref,
        ...(validated.isolation_qualification_scope === "live_qualified"
          ? []
          : [validated.isolation_evidence_ref]),
        ...(validated.isolation_host_attestation_ref === null
          ? []
          : [validated.isolation_host_attestation_ref]),
        ...("source_snapshot_ref" in validated ? [validated.source_snapshot_ref] : []),
      ],
    });
    const prior = state.operation_request_refs[kind];
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(requestRef)) {
      throw new Error(`SCA P02 ${kind} request changed across replay`);
    }
    state.operation_request_refs[kind] = requestRef;
    const registrationSha256 = context.registrationContractBinding?.registration_sha256;
    if (registrationSha256 === undefined)
      throw new Error("SCA P02 lacks a runtime registration binding");
    const operationDeclaration = SCA_P02_OPERATION_DECLARATIONS[kind];
    const directive = validateDirective({
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: context.identity,
      state_id: STATE_BY_KIND[kind],
      attempt: context.stepCount,
      operation_id: SCA_P02_OPERATION_IDS[kind],
      operation_kind: OPERATION_KIND[kind],
      registration_sha256: registrationSha256,
      request_ref: requestRef,
      request_sha256: requestRef.content_digest,
      input_artifacts: { schema_version: 2, artifacts: prepared.inputs },
      expected_result: operationDeclaration.result,
      policy_binding: hostOperationPolicyBinding(operationDeclaration, validated.request_sha256),
    });
    context.pendingDirective = directive;
    return directive;
  }

  private persistEvidence(
    context: RunContext,
    kind: ScaP02OperationKind,
    resultRef: ArtifactRef,
    result: ScaP02OperationResultV1
  ): ArtifactRef {
    const unsigned = {
      schema_id: SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA,
      schema_version: 1 as const,
      run_id: context.identity.run_id,
      operation_kind: kind,
      operation_result_ref: resultRef,
      analyzer_results: result.analyzer_results,
      raw_evidence: result.raw_evidence,
      raw_records: result.raw_records,
      normalized_observations: result.normalized_observations,
      correlations: result.correlations,
      freshness: result.freshness,
    };
    const evidence = validateScaP02PersistedEvidenceV1(
      withScaP02Digest(unsigned, "evidence_sha256")
    );
    return persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: context.stateId,
      kind: "sca-p02-persisted-evidence",
      operationId: `sca-p02-evidence-${kind.replaceAll("_", "-")}`,
      producer: P02_PRODUCER,
      schemaId: SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA,
      schemaVersion: 1,
      value: evidence,
      upstreamRefs: [resultRef],
    });
  }

  private finalize(context: RunContext): Directive {
    const state = data(context);
    const results = new Map<ScaP02OperationKind, ScaP02OperationResultV1>();
    const requests = new Map<ScaP02OperationKind, ScaP02OperationRequestV1>();
    for (const kind of CONTRACT_ORDER) {
      const resultRef = state.operation_result_refs[kind];
      const requestRef = state.operation_request_refs[kind];
      if (resultRef === undefined || requestRef === undefined) {
        throw new Error(`P02 finalization lacks ${kind} request or result`);
      }
      const request = validateScaP02OperationRequestV1(
        kind,
        exactJson(this.store, requestRef, `${kind} final request`)
      );
      requests.set(kind, request);
      results.set(
        kind,
        admitScaP02OperationResultV1(
          kind,
          request,
          exactJson(this.store, resultRef, `${kind} final result`),
          this.componentValidationAuthority
        )
      );
    }
    const operationForAnalyzer = (
      id: (typeof SCA_P02_ANALYZER_IDS)[number]
    ): ScaP02OperationKind => {
      if (id.startsWith("source-") || id.startsWith("tree-") || id.startsWith("dependency-")) {
        return "inventory";
      }
      if (id === "semgrep-php") return "semgrep_php";
      if (id === "semgrep-js-ts") return "semgrep_js_ts";
      if (id === "gitleaks") return "gitleaks";
      return id === "osv-composer" ? "osv_composer" : "osv_npm";
    };
    const entries = SCA_P02_ANALYZER_IDS.map((analyzerId) => {
      const kind = operationForAnalyzer(analyzerId);
      const result = results.get(kind);
      const resultRef = state.operation_result_refs[kind];
      const evidenceRef = state.evidence_refs[kind];
      const analyzerResult = result?.analyzer_results.find(
        (entry) => entry.analyzer_id === analyzerId
      );
      if (
        result === undefined ||
        analyzerResult === undefined ||
        resultRef === undefined ||
        evidenceRef === undefined
      ) {
        throw new Error(`P02 coverage lacks '${analyzerId}' exact evidence`);
      }
      return {
        ...analyzerResult,
        operation_kind: kind,
        operation_result_ref: resultRef,
        normalized_evidence_ref: evidenceRef,
      };
    });
    const admitted = this.readAdmitted(context);
    const isolation = validateScaP02IsolationEvidenceV1(
      exactJson(this.store, admitted.request.isolation_evidence_ref, "P02 isolation evidence")
    );
    const isolationHostAttestationRef = admitted.request.isolation_host_attestation_ref;
    const isolationHostAttestationRefs =
      isolationHostAttestationRef === null ? [] : [isolationHostAttestationRef];
    const matrix = validateScaP02CoverageMatrixV1(
      withScaP02Digest(
        {
          schema_id: SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
          schema_version: 1,
          run_id: context.identity.run_id,
          p01_binding_sha256: scaP02P01BindingSha256(admitted.request),
          entries,
        },
        "coverage_sha256"
      )
    );
    const evidenceRefs = CONTRACT_ORDER.map((kind) =>
      requiredOperationRef(state.evidence_refs, kind, "coverage evidence")
    );
    const coverageRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P02_PHASE,
      kind: "sca-p02-coverage-matrix",
      operationId: "sca-p02-coverage-matrix",
      producer: P02_PRODUCER,
      schemaId: SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
      schemaVersion: 1,
      value: matrix,
      upstreamRefs: evidenceRefs,
    });

    const evaluatedAt = this.trustedClock();
    if (!Number.isFinite(evaluatedAt.getTime()))
      throw new Error("P02 trusted gate clock is invalid");
    const evaluatedAtText = evaluatedAt.toISOString();
    const coverageBlockers = matrix.entries.flatMap((entry) => [
      ...entry.blocker_codes.map((code) => `${entry.analyzer_id}:${code}`),
      ...(entry.applicability === "applicable" && entry.fresh !== true
        ? [`${entry.analyzer_id}:stale`]
        : []),
      ...(entry.status !== "complete" ? [`${entry.analyzer_id}:incomplete`] : []),
    ]);
    const expiryBlockers = [...results.entries()].flatMap(([kind, result]) =>
      kind.startsWith("osv_") &&
      result.freshness.expires_at !== null &&
      evaluatedAt.getTime() > Date.parse(result.freshness.expires_at)
        ? [`${kind === "osv_composer" ? "osv-composer" : "osv-npm"}:stale_at_gate`]
        : []
    );
    const blockers = [
      ...new Set([
        ...coverageBlockers,
        ...expiryBlockers,
        ...(isolation.qualification_scope === "live_qualified" && isolation.qualified
          ? []
          : ["isolation:not_live_qualified"]),
      ]),
    ].sort();

    const priorLedger = validateScaObligationLedgerV2(
      exactJson(
        this.store,
        admitted.request.accepted_p01.obligation_ledger_ref,
        "P01 obligation ledger"
      )
    );
    const requestRefs = CONTRACT_ORDER.map((kind) =>
      requiredOperationRef(state.operation_request_refs, kind, "evidence manifest request")
    );
    const resultRefs = CONTRACT_ORDER.map((kind) =>
      requiredOperationRef(state.operation_result_refs, kind, "successor ledger result")
    );
    const successorLedger = validateScaP02SuccessorLedgerV1(
      withScaP02Digest(
        {
          schema_id: SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA,
          schema_version: 1,
          run_id: context.identity.run_id,
          prior_p01_ledger_ref: admitted.request.accepted_p01.obligation_ledger_ref,
          prior_p01_ledger_sha256: priorLedger.ledger_sha256,
          prior_entry_count: priorLedger.entries.length,
          prior_event_count: priorLedger.events.length,
          prior_entries: priorLedger.entries,
          prior_events: priorLedger.events,
          p01_campaign_manifest_ref: admitted.request.accepted_p01.campaign_manifest_ref,
          dispositions: (() => {
            const phaseStatus =
              blockers.length === 0 ? ("satisfied" as const) : ("blocked" as const);
            // The successor ledger records whether the *whole* P02 gate discharged each
            // P02 obligation. Per-analyzer outcomes remain in coverage and the manifest.
            const pair = (kind: ScaP02OperationKind) => [
              requiredOperationRef(state.operation_result_refs, kind, "obligation result"),
              requiredOperationRef(state.evidence_refs, kind, "obligation evidence"),
            ];
            const inventory = pair("inventory");
            const semgrep = [...pair("semgrep_php"), ...pair("semgrep_js_ts")];
            const secret = pair("gitleaks");
            const osv = [...pair("osv_composer"), ...pair("osv_npm")];
            return [
              {
                obligation_id: "SCA-OBL-P01-ACCEPTANCE" as const,
                status: "satisfied" as const,
                evidence_refs: [
                  admitted.request.accepted_p01.p01_gate_ref,
                  admitted.request.accepted_p01.campaign_manifest_ref,
                ],
              },
              {
                obligation_id: "SCA-OBL-OUTPUT-SOURCE-CENSUS" as const,
                status: phaseStatus,
                evidence_refs: inventory,
              },
              {
                obligation_id: "SCA-OBL-OUTPUT-SYNTAX-INDEX" as const,
                status: phaseStatus,
                evidence_refs: inventory,
              },
              {
                obligation_id: "SCA-OBL-OUTPUT-SEMGREP" as const,
                status: phaseStatus,
                evidence_refs: semgrep,
              },
              {
                obligation_id: "SCA-OBL-OUTPUT-SECRET-SCAN" as const,
                status: phaseStatus,
                evidence_refs: secret,
              },
              {
                obligation_id: "SCA-OBL-OUTPUT-DEPENDENCY-INVENTORY" as const,
                status: phaseStatus,
                evidence_refs: inventory,
              },
              {
                obligation_id: "SCA-OBL-OUTPUT-OSV-EVIDENCE" as const,
                status: phaseStatus,
                evidence_refs: osv,
              },
              {
                obligation_id: "SCA-OBL-OUTPUT-NORMALIZED-CANDIDATES" as const,
                status: phaseStatus,
                evidence_refs: evidenceRefs,
              },
              {
                obligation_id: "SCA-OBL-P02-ACCEPTANCE" as const,
                status: phaseStatus,
                evidence_refs: [
                  coverageRef,
                  ...resultRefs.flatMap((ref, index) => {
                    const evidenceRef = evidenceRefs[index];
                    if (evidenceRef === undefined) {
                      throw new Error("P02 obligation evidence ordering is incomplete");
                    }
                    return [ref, evidenceRef];
                  }),
                ],
              },
              {
                obligation_id: "SCA-OBL-M1-NONTERMINAL" as const,
                status: phaseStatus,
                evidence_refs: [coverageRef, ...evidenceRefs],
              },
            ];
          })(),
          pending_phase_ids: [
            "SCA-P03",
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
          recorded_at: evaluatedAtText,
        },
        "ledger_sha256"
      )
    );
    validateScaP02SuccessorLedgerAgainstP01V1({
      successor: successorLedger,
      prior_ledger: priorLedger,
      prior_ledger_ref: admitted.request.accepted_p01.obligation_ledger_ref,
      p01_campaign_manifest_ref: admitted.request.accepted_p01.campaign_manifest_ref,
    });
    const successorLedgerRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P02_PHASE,
      kind: "sca-p02-successor-obligation-ledger",
      operationId: "sca-p02-successor-obligation-ledger",
      producer: P02_PRODUCER,
      schemaId: SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA,
      schemaVersion: 1,
      value: successorLedger,
      upstreamRefs: [
        admitted.request.accepted_p01.obligation_ledger_ref,
        admitted.request.accepted_p01.campaign_manifest_ref,
        coverageRef,
        ...resultRefs,
        ...evidenceRefs,
      ],
    });

    const receiptByOperationId = new Map<string, ArtifactRef>();
    for (const ref of context.selectedArtifacts.filter(
      (candidate) => candidate.kind === "host-operation-receipt"
    )) {
      const receipt = validateHostOperationReceipt(
        exactJson(this.store, ref, "P02 operation receipt")
      );
      receiptByOperationId.set(receipt.operation_id, ref);
    }
    const receiptRefs = CONTRACT_ORDER.map((kind) => {
      const ref = receiptByOperationId.get(SCA_P02_OPERATION_IDS[kind]);
      if (ref === undefined) throw new Error(`P02 evidence manifest lacks ${kind} receipt`);
      return ref;
    });
    const rawHas = (
      result: ScaP02OperationResultV1,
      analyzerId: (typeof SCA_P02_ANALYZER_IDS)[number],
      predicate: (value: Readonly<Record<string, unknown>>) => boolean
    ): boolean =>
      result.raw_evidence
        .filter((raw) => raw.analyzer_id === analyzerId)
        .some((raw) => {
          const parsed: unknown = JSON.parse(
            Buffer.from(raw.content_base64, "base64").toString("utf8")
          );
          return isRecord(parsed) ? predicate(parsed) : false;
        });
    const manifestOperations = CONTRACT_ORDER.map((kind, index) => {
      const result = results.get(kind);
      const requestRef = state.operation_request_refs[kind];
      const resultRef = state.operation_result_refs[kind];
      const normalizedRef = state.evidence_refs[kind];
      const receiptRef = receiptRefs[index];
      if (
        result === undefined ||
        requestRef === undefined ||
        resultRef === undefined ||
        normalizedRef === undefined ||
        receiptRef === undefined
      ) {
        throw new Error(`P02 evidence manifest operation '${kind}' is incomplete`);
      }
      return {
        operation_kind: kind,
        operation_request_ref: requestRef,
        operation_result_ref: resultRef,
        normalized_evidence_ref: normalizedRef,
        operation_receipt_ref: receiptRef,
        status: result.status,
        raw_evidence_ids: result.raw_evidence.map((raw) => raw.evidence_id).sort(),
        raw_record_ids: result.raw_records.map((raw) => raw.raw_record_id).sort(),
      };
    });
    const manifestAnalyzers = SCA_P02_ANALYZER_IDS.map((analyzerId) => {
      const kind = operationForAnalyzer(analyzerId);
      const result = results.get(kind);
      const coverage = matrix.entries.find((entry) => entry.analyzer_id === analyzerId);
      if (result === undefined || coverage === undefined) {
        throw new Error(`P02 evidence manifest lacks analyzer '${analyzerId}'`);
      }
      const rawEvidence = result.raw_evidence.filter((raw) => raw.analyzer_id === analyzerId);
      const evidenceIds = new Set(rawEvidence.map((raw) => raw.evidence_id));
      return {
        analyzer_id: analyzerId,
        operation_kind: kind,
        operation_result_ref: coverage.operation_result_ref,
        normalized_evidence_ref: coverage.normalized_evidence_ref,
        applicability: coverage.applicability,
        status: coverage.status,
        fresh: coverage.fresh,
        fetched_at: result.freshness.fetched_at,
        max_age_seconds: result.freshness.max_age_seconds,
        expires_at: result.freshness.expires_at,
        unsupported: coverage.blocker_codes.some((code) => code.includes("unsupported")),
        truncated: rawHas(
          result,
          analyzerId,
          (value) =>
            containsJsonValue(value, "truncated", true) ||
            containsJsonValue(value, "status", "truncated")
        ),
        blocker_codes: [...coverage.blocker_codes],
        raw_evidence_ids: [...evidenceIds].sort(),
        raw_record_ids: result.raw_records
          .filter((record) => record.analyzer_id === analyzerId)
          .map((record) => record.raw_record_id)
          .sort(),
      };
    });
    const osvEvidence = (["osv_composer", "osv_npm"] as const).map((kind) => {
      const result = results.get(kind);
      const request = requests.get(kind);
      const resultRef = state.operation_result_refs[kind];
      if (
        result === undefined ||
        request === undefined ||
        resultRef === undefined ||
        (request.operation_kind !== "osv_composer" && request.operation_kind !== "osv_npm")
      ) {
        throw new Error(`P02 evidence manifest lacks ${kind} details`);
      }
      return {
        analyzer_id: kind === "osv_composer" ? ("osv-composer" as const) : ("osv-npm" as const),
        operation_result_ref: resultRef,
        batch_evidence_ids: result.raw_evidence.map((raw) => raw.evidence_id).sort(),
        coordinate_ids: request.coordinates.map((entry) => entry.query_id),
        occurrence_ids: request.mappings.map((entry) => entry.occurrence_id),
        fetched_at: result.freshness.fetched_at,
        max_age_seconds: result.freshness.max_age_seconds,
        expires_at: result.freshness.expires_at,
      };
    });
    const evidenceManifest = validateScaP02EvidenceManifestV1(
      withScaP02Digest(
        {
          schema_id: SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA,
          schema_version: 1,
          run_id: context.identity.run_id,
          p02_request_ref: state.request_ref,
          runtime_policy_ref: admitted.request.runtime_policy_ref,
          isolation_evidence_ref: admitted.request.isolation_evidence_ref,
          isolation_host_attestation_ref: isolationHostAttestationRef,
          p01_request_ref: admitted.request.accepted_p01.request_ref,
          p01_campaign_manifest_core_ref: admitted.request.accepted_p01.campaign_manifest_core_ref,
          p01_campaign_manifest_ref: admitted.request.accepted_p01.campaign_manifest_ref,
          p01_predecessor_ledger_ref: admitted.request.accepted_p01.obligation_ledger_ref,
          coverage_matrix_ref: coverageRef,
          successor_ledger_ref: successorLedgerRef,
          operations: manifestOperations,
          analyzers: manifestAnalyzers,
          symbol_evidence_refs: [
            requiredOperationRef(state.evidence_refs, "inventory", "symbol evidence"),
          ],
          dependency_evidence_refs: [
            requiredOperationRef(state.evidence_refs, "inventory", "dependency evidence"),
          ],
          osv_evidence: osvEvidence,
        },
        "manifest_sha256"
      )
    );
    const evidenceManifestRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P02_PHASE,
      kind: "sca-p02-evidence-manifest",
      operationId: "sca-p02-evidence-manifest",
      producer: P02_PRODUCER,
      schemaId: SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA,
      schemaVersion: 1,
      value: evidenceManifest,
      upstreamRefs: [
        state.request_ref,
        admitted.request.runtime_policy_ref,
        admitted.request.isolation_evidence_ref,
        ...isolationHostAttestationRefs,
        admitted.request.accepted_p01.request_ref,
        admitted.request.accepted_p01.campaign_manifest_core_ref,
        admitted.request.accepted_p01.campaign_manifest_ref,
        admitted.request.accepted_p01.obligation_ledger_ref,
        coverageRef,
        successorLedgerRef,
        ...requestRefs,
        ...receiptRefs,
        ...resultRefs,
        ...evidenceRefs,
      ],
    });

    const gate = validateScaP02GateV1(
      withScaP02Digest(
        {
          schema_id: SCA_P02_GATE_V1_SCHEMA,
          schema_version: 1,
          run_id: context.identity.run_id,
          p02_request_ref: state.request_ref,
          runtime_policy_ref: admitted.request.runtime_policy_ref,
          isolation_evidence_ref: admitted.request.isolation_evidence_ref,
          isolation_host_attestation_ref: isolationHostAttestationRef,
          coverage_matrix_ref: coverageRef,
          successor_ledger_ref: successorLedgerRef,
          evidence_manifest_ref: evidenceManifestRef,
          isolation_scope: isolation.qualification_scope,
          status: blockers.length === 0 ? ("passed" as const) : ("blocked" as const),
          blocker_codes: blockers,
          evaluated_at: evaluatedAtText,
        },
        "gate_sha256"
      )
    );
    validateScaP02GateAgainstCoverageV1({
      gate,
      coverage: matrix,
      coverage_ref: coverageRef,
      successor_ledger_ref: successorLedgerRef,
      evidence_manifest_ref: evidenceManifestRef,
      evidence_manifest: evidenceManifest,
      successor_ledger: successorLedger,
      p02_request_ref: state.request_ref,
      runtime_policy_ref: admitted.request.runtime_policy_ref,
      isolation_evidence_ref: admitted.request.isolation_evidence_ref,
      isolation_host_attestation_ref: isolationHostAttestationRef,
      isolation_evidence: isolation,
    });
    const gateRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P02_PHASE,
      kind: "sca-p02-gate",
      operationId: "sca-p02-gate",
      producer: P02_PRODUCER,
      schemaId: SCA_P02_GATE_V1_SCHEMA,
      schemaVersion: 1,
      value: gate,
      upstreamRefs: [
        state.request_ref,
        admitted.request.runtime_policy_ref,
        admitted.request.isolation_evidence_ref,
        ...isolationHostAttestationRefs,
        coverageRef,
        successorLedgerRef,
        evidenceManifestRef,
      ],
    });
    const m1 = validateScaM1RecordV2(
      withScaP02Digest(
        {
          schema_id: SCA_M1_RECORD_V2_SCHEMA,
          schema_version: 2,
          run_id: context.identity.run_id,
          phase_id: "SCA-P02",
          p02_request_ref: state.request_ref,
          runtime_policy_ref: admitted.request.runtime_policy_ref,
          isolation_evidence_ref: admitted.request.isolation_evidence_ref,
          isolation_host_attestation_ref: isolationHostAttestationRef,
          gate_ref: gateRef,
          coverage_matrix_ref: coverageRef,
          successor_ledger_ref: successorLedgerRef,
          evidence_manifest_ref: evidenceManifestRef,
          status: gate.status,
          nonterminal: true,
          release_eligible: false,
          campaign_terminal: false,
          model_calls: 0,
          model_turns: 0,
          blocker_codes: gate.blocker_codes,
          transition_authorized: gate.status === "passed",
          recorded_at: evaluatedAtText,
        },
        "record_sha256"
      )
    );
    const m1Ref = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P02_PHASE,
      kind: "sca-m1-record",
      operationId: "sca-m1-record-v2",
      producer: P02_PRODUCER,
      schemaId: SCA_M1_RECORD_V2_SCHEMA,
      schemaVersion: 2,
      value: m1,
      upstreamRefs: [
        state.request_ref,
        admitted.request.runtime_policy_ref,
        admitted.request.isolation_evidence_ref,
        ...isolationHostAttestationRefs,
        coverageRef,
        gateRef,
        successorLedgerRef,
        evidenceManifestRef,
      ],
    });
    validateScaM1AgainstGateV2({
      m1,
      gate,
      gate_ref: gateRef,
      coverage_ref: coverageRef,
      successor_ledger_ref: successorLedgerRef,
      evidence_manifest_ref: evidenceManifestRef,
      p02_request_ref: state.request_ref,
      runtime_policy_ref: admitted.request.runtime_policy_ref,
      isolation_evidence_ref: admitted.request.isolation_evidence_ref,
      isolation_host_attestation_ref: isolationHostAttestationRef,
    });
    let transitionRef: ArtifactRef | null = null;
    if (gate.status === "passed") {
      const transition = validateScaP02P03TransitionV1(
        withScaP02Digest(
          {
            schema_id: SCA_P02_P03_TRANSITION_V1_SCHEMA,
            schema_version: 1,
            run_id: context.identity.run_id,
            from_phase_id: "SCA-P02",
            to_phase_id: "SCA-P03",
            p02_request_ref: state.request_ref,
            runtime_policy_ref: admitted.request.runtime_policy_ref,
            isolation_evidence_ref: admitted.request.isolation_evidence_ref,
            isolation_host_attestation_ref: isolationHostAttestationRef,
            p01_request_ref: admitted.request.accepted_p01.request_ref,
            p01_campaign_manifest_core_ref:
              admitted.request.accepted_p01.campaign_manifest_core_ref,
            p01_campaign_manifest_ref: admitted.request.accepted_p01.campaign_manifest_ref,
            successor_ledger_ref: successorLedgerRef,
            evidence_manifest_ref: evidenceManifestRef,
            p02_gate_ref: gateRef,
            coverage_matrix_ref: coverageRef,
            m1_ref: m1Ref,
            consumed_as_of: evaluatedAtText,
            qualification_claimed: false,
            campaign_terminal: false,
            release_eligible: false,
          },
          "transition_sha256"
        )
      );
      validateScaP02TransitionAgainstM1V1({
        transition,
        m1,
        m1_ref: m1Ref,
        gate_ref: gateRef,
        coverage_ref: coverageRef,
        successor_ledger_ref: successorLedgerRef,
        evidence_manifest_ref: evidenceManifestRef,
        evidence_manifest: evidenceManifest,
        p01_request_ref: admitted.request.accepted_p01.request_ref,
        p01_campaign_manifest_core_ref: admitted.request.accepted_p01.campaign_manifest_core_ref,
        p01_campaign_manifest_ref: admitted.request.accepted_p01.campaign_manifest_ref,
        p01_predecessor_ledger_ref: admitted.request.accepted_p01.obligation_ledger_ref,
        p02_request_ref: state.request_ref,
        runtime_policy_ref: admitted.request.runtime_policy_ref,
        isolation_evidence_ref: admitted.request.isolation_evidence_ref,
        isolation_host_attestation_ref: isolationHostAttestationRef,
      });
      transitionRef = persistJson({
        store: this.store,
        context,
        runId: context.identity.run_id,
        phase: P02_PHASE,
        kind: "sca-p02-p03-transition",
        operationId: "sca-p02-p03-transition",
        producer: P02_PRODUCER,
        schemaId: SCA_P02_P03_TRANSITION_V1_SCHEMA,
        schemaVersion: 1,
        value: transition,
        upstreamRefs: [
          state.request_ref,
          admitted.request.runtime_policy_ref,
          admitted.request.isolation_evidence_ref,
          ...isolationHostAttestationRefs,
          gateRef,
          coverageRef,
          successorLedgerRef,
          evidenceManifestRef,
          m1Ref,
          admitted.request.accepted_p01.request_ref,
          admitted.request.accepted_p01.campaign_manifest_core_ref,
          admitted.request.accepted_p01.campaign_manifest_ref,
        ],
      });
      createScaP03TransitionAdmissionV1({
        store: this.store,
        trusted_clock: this.trustedClock,
      }).consume({ transition_ref: transitionRef });
    }
    context.previousState = context.stateId;
    context.stateId = FINAL_STATE;
    context.status = "incomplete";
    context.met = false;
    context.pendingBranches = [];
    const terminal = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: {
        schema_id: "penny.sca-p02-candidate-terminal.v1",
        schema_version: 1,
        phase_id: "SCA-P02",
        boundary: gate.status === "passed" ? "p03" : "blocked_at_p02",
        gate_status: gate.status,
        p02_request_ref: state.request_ref,
        runtime_policy_ref: admitted.request.runtime_policy_ref,
        isolation_evidence_ref: admitted.request.isolation_evidence_ref,
        isolation_host_attestation_ref: isolationHostAttestationRef,
        coverage_matrix_ref: coverageRef,
        successor_ledger_ref: successorLedgerRef,
        evidence_manifest_ref: evidenceManifestRef,
        gate_ref: gateRef,
        m1_ref: m1Ref,
        transition_ref: transitionRef,
        blocker_codes: gate.blocker_codes,
        campaign_terminal: false,
        release_eligible: false,
        model_calls: 0,
        model_turns: 0,
      },
      artifacts: uniqueRefs([
        state.request_ref,
        admitted.request.runtime_policy_ref,
        admitted.request.isolation_evidence_ref,
        ...isolationHostAttestationRefs,
        ...requestRefs,
        ...resultRefs,
        ...receiptRefs,
        ...evidenceRefs,
        coverageRef,
        successorLedgerRef,
        evidenceManifestRef,
        gateRef,
        m1Ref,
        ...(transitionRef === null ? [] : [transitionRef]),
      ]),
      unresolved:
        gate.status === "passed"
          ? ["SCA-P03 is outside this inactive P02 candidate boundary."]
          : gate.blocker_codes,
    });
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    return terminal;
  }

  private terminalArtifacts(context: RunContext): ArtifactRef[] {
    return uniqueRefs(
      context.selectedArtifacts.filter(
        (ref) => ref.phase === P02_PHASE || ref.kind.startsWith("host-operation-")
      )
    ).slice(0, 256);
  }
}

function p02Registration(input: {
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
      constraints_schema: ScaP02StartConstraintsV1Schema,
      example: {
        goal: input.goal,
        constraints: { p02_request: {} },
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
    host_states: [...Object.values(STATE_BY_KIND), FINAL_STATE],
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: CONTRACT_ORDER.map((kind) => SCA_P02_OPERATION_DECLARATIONS[kind]),
    },
    completionReceiptPredicates: new Map(),
    construct(options: PlaybookConstructionOptions): PlaybookCore {
      if (options.artifactStore === undefined)
        throw new Error(`${input.construction_label} requires the artifact host store`);
      if (options.scaP02ComponentValidationAuthority === undefined) {
        throw new Error(
          `${input.construction_label} requires host-owned component validation authority`
        );
      }
      return new ScaP02CandidatePlaybook(
        options.artifactStore,
        options.trustedClock ?? (() => new Date()),
        options.scaP02ComponentValidationAuthority
      );
    },
  };
}

export const SCA_P02_CANDIDATE_REGISTRATION: PlaybookRegistration = p02Registration({
  name: SCA_P02_CANDIDATE_PLAYBOOK_NAME,
  contract: SCA_P02_CANDIDATE_SKILL_CONTRACT,
  start_admission: SCA_P02_START_ADMISSION,
  goal: "Run the admitted inactive deterministic SCA P02 candidate.",
  semantic_caveat:
    "Candidate-only: never claims live qualification, release eligibility, or campaign completion.",
  construction_label: "SCA P02 candidate",
});

/**
 * Accepted phase registration. It is intentionally absent from PLAYBOOK_REGISTRY: the eventual
 * user-facing `sca` product keeps its current registration until the remaining target phases pass.
 */
export const SCA_P02_PHASE_REGISTRATION: PlaybookRegistration = p02Registration({
  name: SCA_P02_PHASE_PLAYBOOK_NAME,
  contract: SCA_P02_PHASE_SKILL_CONTRACT,
  start_admission: SCA_P02_PHASE_START_ADMISSION,
  goal: "Run the accepted deterministic SCA P02 phase.",
  semantic_caveat:
    "Phase-only: produces the P02→P03 handoff and never claims campaign completion or release eligibility.",
  construction_label: "SCA P02 accepted phase",
});
