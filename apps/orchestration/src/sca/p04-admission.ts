import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { type ArtifactRef, type InputArtifacts, validateContract } from "../contracts.js";
import {
  ScaCampaignSourceSnapshotV2Schema,
  ScaP01AdmissionRequestV3Schema,
  ScaP01SourceCustodyCorpusV1Schema,
  ScaP01SourceFileManifestV1Schema,
  validateScaCampaignSourceSnapshotV2,
  validateScaP01AdmissionRequestV3,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  type ScaCampaignSourceSnapshotV2,
  type ScaP01AdmissionRequestV3,
  type ScaP01SourceCustodyCorpusV1,
  type ScaP01SourceFileManifestV1,
} from "./p01-contracts.js";
import {
  ScaModelDataPolicyV1Schema,
  validateScaModelDataPolicyV1,
  type ScaModelDataPolicyV1,
} from "./p01-policy-contracts.js";
import {
  validateScaP02EvidenceManifestV1,
  validateScaP02PersistedEvidenceV1,
  validateScaP02SuccessorLedgerV1,
  type ScaP02EvidenceManifestV1,
  type ScaP02PersistedEvidenceV1,
} from "./p02-contracts.js";
import { admitScaP03Candidate, scaP03InputArtifacts } from "./p03-admission.js";
import {
  SCA_P03_PARTITIONS,
  SCA_P03_QUERY_IDS,
  ScaP03EntryAdmissionV2Schema,
  ScaP03ZeroModelEvidenceV1Schema,
  validateScaP03OperationResultV1,
  validateScaP03BaselineQueryAggregateV2,
  validateScaP03BaselineQueryPageV2,
  validateScaP03CoverageMatrixV1,
  validateScaP03EvidenceManifestV2,
  validateScaP03GateV1,
  validateScaP03GraphCandidatePacketV2,
  validateScaP03PacketAgainstQueryPagesV2,
  validateScaP03GraphManifestV1,
  validateScaP03GraphSupportMatrixV2,
  validateScaP03P04TransitionV2,
  validateScaP03QualificationRecordV2,
  validateScaP03RequestV2,
  validateScaP03SuccessorLedgerV1,
  validateScaP03TransitionAgainstGateV1,
  type ScaP03BaselineQueryAggregateV2,
  type ScaP03BaselineQueryBatchResultV2,
  type ScaP03BaselineQueryPageV2,
  type ScaP03CoverageMatrixV1,
  type ScaP03EntryAdmissionV2,
  type ScaP03EvidenceManifestV2,
  type ScaP03GateV1,
  type ScaP03GraphCandidatePacketV2,
  type ScaP03QueryCandidateV2,
  type ScaP03GraphManifestV1,
  type ScaP03GraphSupportMatrixV2,
  type ScaP03P04TransitionV2,
  type ScaP03QualificationRecordV2,
  type ScaP03RequestV2,
  type ScaP03SuccessorLedgerV1,
  type ScaP03ZeroModelEvidenceV1,
} from "./p03-contracts.js";
import {
  SCA_P04_REQUIRED_MODEL,
  SCA_P04_SCANNER_SPECIALIST,
  SCA_P04_SPECIALIST_IDS,
  SCA_P04_UNDERDETECTED_SPECIALIST,
  ScaP04AcceptedCohortV1Schema,
  ScaP04RequestV1Schema,
  ScaP04SelectionPopulationV1Schema,
  scaP04RequestSha256,
  scaP04StableItemId,
  validateScaP04AcceptedCohortV1,
  validateScaP04ImplementationIdentityV1,
  validateScaP04RequestV1,
  validateScaP04RuntimePolicyV1,
  validateScaP04SelectionPopulationV1,
  withSelfDigest,
  type ScaP04AcceptedCohortV1,
  type ScaP04ImplementationIdentityV1,
  type ScaP04PopulationItemV1,
  type ScaP04RequestV1,
  type ScaP04RuntimePolicyV1,
  type ScaP04SelectionPopulationV1,
} from "./p04-contracts.js";

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const P03_PRODUCER = "host:sca-p03-candidate";
const P04_PRODUCER = "host:sca-p04-candidate";

export class ScaP04AdmissionError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "input_set_mismatch"
      | "artifact_mismatch"
      | "cross_cohort_substitution"
      | "predecessor_not_live_qualified"
      | "predecessor_incomplete"
      | "model_policy_denied"
      | "population_overflow",
    message: string,
    options?: ErrorOptions
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ScaP04AdmissionError";
  }
}

function fail(code: ScaP04AdmissionError["code"], message: string, cause?: unknown): never {
  throw new ScaP04AdmissionError(code, message, cause === undefined ? undefined : { cause });
}

function same(left: ArtifactRef, right: ArtifactRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertSame(left: ArtifactRef, right: ArtifactRef, label: string): void {
  if (!same(left, right)) fail("cross_cohort_substitution", `${label} exact ref mismatch`);
}

function readExact(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  try {
    const storedRef = store.refById(ref.artifact_id);
    if (storedRef === undefined || !same(storedRef, ref)) {
      fail("artifact_mismatch", `${label} ref metadata is absent or substituted`);
    }
    const bytes = store.readById(ref.artifact_id);
    if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
      fail("artifact_mismatch", `${label} bytes disagree with the exact ref`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof ScaP04AdmissionError) throw error;
    fail("artifact_mismatch", `${label} failed immutable-byte verification`, error);
  }
}

function parseJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const bytes = readExact(store, ref, label);
  if (bytes.byteLength > MAX_JSON_BYTES) fail("artifact_mismatch", `${label} exceeds JSON bound`);
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return parsed;
  } catch (error) {
    fail("artifact_mismatch", `${label} is not JSON`, error);
  }
}

function parseContract<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string,
  validator: (value: unknown) => T
): T {
  try {
    return validator(parseJson(store, ref, label));
  } catch (error) {
    if (error instanceof ScaP04AdmissionError) throw error;
    fail("artifact_mismatch", `${label} contract validation failed`, error);
  }
}

function sortedUniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const prior = byId.get(ref.artifact_id);
    if (prior !== undefined && !same(prior, ref)) {
      fail(
        "cross_cohort_substitution",
        `artifact id '${ref.artifact_id}' has conflicting metadata`
      );
    }
    byId.set(ref.artifact_id, ref);
  }
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}

export function scaP04InputArtifacts(request: ScaP04RequestV1): InputArtifacts {
  return {
    schema_version: 2,
    artifacts: [
      { slot: "p03_transition", ref: request.p03_transition_ref },
      { slot: "implementation_identity", ref: request.implementation_identity_ref },
      { slot: "runtime_policy", ref: request.runtime_policy_ref },
    ],
  };
}

function assertExactInputs(actual: InputArtifacts, expected: InputArtifacts): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("input_set_mismatch", "P04 inputs must equal the transition-rooted request set exactly");
  }
}

interface P03CommonCohortBindingViewV1 {
  readonly schema_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly p01_binding_sha256: string;
  readonly p02_binding_sha256: string;
  readonly p03_runtime_binding_sha256: string;
  readonly source_snapshot_ref: ArtifactRef;
  readonly source_snapshot_sha256: string;
}

export interface ScaP04AcceptedP03CohortInputV1 {
  readonly transition: P03CommonCohortBindingViewV1 & {
    readonly p03_request_ref: ArtifactRef;
    readonly source_oracle_ref: ArtifactRef;
    readonly source_oracle_validation_ref: ArtifactRef;
    readonly entry_admission_ref: ArtifactRef;
    readonly qualification_record_ref: ArtifactRef;
    readonly graph_manifest_ref: ArtifactRef;
    readonly graph_support_matrix_ref: ArtifactRef;
    readonly baseline_query_aggregate_ref: ArtifactRef;
    readonly candidate_packet_ref: ArtifactRef;
    readonly coverage_matrix_ref: ArtifactRef;
    readonly evidence_manifest_ref: ArtifactRef;
    readonly successor_ledger_ref: ArtifactRef;
    readonly zero_model_evidence_ref: ArtifactRef;
    readonly gate_ref: ArtifactRef;
  };
  readonly request: {
    readonly tenant_id: string;
    readonly project_id: string;
    readonly run_id: string;
    readonly p01_binding_sha256: string;
    readonly p02_binding_sha256: string;
    readonly p03_runtime_binding_sha256: string;
    readonly source_snapshot_sha256: string;
    readonly source_oracle_ref: ArtifactRef;
    readonly source_oracle_validation_ref: ArtifactRef;
  };
  readonly entry: P03CommonCohortBindingViewV1 & {
    readonly p03_request_ref: ArtifactRef;
    readonly source_oracle_ref: ArtifactRef;
    readonly source_oracle_validation_ref: ArtifactRef;
  };
  readonly qualification: P03CommonCohortBindingViewV1 & {
    readonly status: string;
    readonly live_qualified: boolean;
    readonly blocker_codes: readonly string[];
  };
  readonly graph_manifest: P03CommonCohortBindingViewV1 & {
    readonly complete: boolean;
    readonly components: readonly {
      readonly partition: string;
      readonly status: string;
      readonly graph_component_ref: ArtifactRef | null;
      readonly graph_provenance_ref: ArtifactRef | null;
      readonly graph_id: string | null;
    }[];
  };
  readonly graph_support: P03CommonCohortBindingViewV1 & {
    readonly complete: boolean;
    readonly entries: readonly {
      readonly qualification_scope: string;
      readonly material_gap: boolean;
      readonly materiality: string;
      readonly support: string;
    }[];
  };
  readonly query_aggregate: P03CommonCohortBindingViewV1 & {
    readonly complete: boolean;
    readonly batches: readonly {
      readonly partition: string;
      readonly graph_component_ref: ArtifactRef;
      readonly complete: boolean;
      readonly truncated: boolean;
      readonly ordered_query_ids: readonly string[];
    }[];
  };
  readonly candidate_packet: P03CommonCohortBindingViewV1 & {
    readonly complete: boolean;
    readonly source_bound: boolean;
  };
  readonly coverage: P03CommonCohortBindingViewV1 & {
    readonly entries: readonly {
      readonly status: string;
      readonly blocker_codes: readonly string[];
    }[];
  };
  readonly evidence_manifest: P03CommonCohortBindingViewV1 & {
    readonly p03_request_ref: ArtifactRef;
    readonly source_oracle_ref: ArtifactRef;
    readonly source_oracle_validation_ref: ArtifactRef;
    readonly entry_admission_ref: ArtifactRef;
    readonly qualification_record_ref: ArtifactRef;
    readonly graph_manifest_ref: ArtifactRef;
    readonly graph_support_matrix_ref: ArtifactRef;
    readonly baseline_query_aggregate_ref: ArtifactRef;
    readonly candidate_packet_ref: ArtifactRef;
    readonly coverage_matrix_ref: ArtifactRef;
    readonly zero_model_evidence_ref: ArtifactRef;
  };
  readonly successor_ledger: P03CommonCohortBindingViewV1 & {
    readonly dispositions: readonly { readonly status: string }[];
    readonly pending_phase_ids: readonly string[];
    readonly append_only: boolean;
    readonly campaign_completion_claimed: boolean;
    readonly release_eligible: boolean;
  };
  readonly zero_model: P03CommonCohortBindingViewV1 & {
    readonly worker_kind: string;
    readonly model_calls: number;
    readonly model_turns: number;
    readonly passed: boolean;
  };
  readonly gate: P03CommonCohortBindingViewV1 & {
    readonly p03_request_ref: ArtifactRef;
    readonly entry_admission_ref: ArtifactRef;
    readonly qualification_record_ref: ArtifactRef;
    readonly graph_manifest_ref: ArtifactRef;
    readonly graph_support_matrix_ref: ArtifactRef;
    readonly baseline_query_aggregate_ref: ArtifactRef;
    readonly candidate_packet_ref: ArtifactRef;
    readonly coverage_matrix_ref: ArtifactRef;
    readonly evidence_manifest_ref: ArtifactRef;
    readonly successor_ledger_ref: ArtifactRef;
    readonly zero_model_evidence_ref: ArtifactRef;
    readonly status: string;
    readonly isolation_scope: string;
    readonly blocker_codes: readonly string[];
  };
}

/** Pure cohort closure check used by production admission and cross-splice tests. */
export function validateScaP04AcceptedP03CohortV1(cohort: ScaP04AcceptedP03CohortInputV1): void {
  const { transition, request, entry, qualification, graph_manifest, graph_support } = cohort;
  const { query_aggregate, candidate_packet, coverage, evidence_manifest, successor_ledger } =
    cohort;
  const { zero_model, gate } = cohort;

  for (const [label, value] of [
    ["tenant", transition.tenant_id === request.tenant_id],
    ["project", transition.project_id === request.project_id],
    ["run", transition.run_id === request.run_id],
    [
      "source snapshot digest",
      transition.source_snapshot_sha256 === request.source_snapshot_sha256,
    ],
    ["P01 binding", transition.p01_binding_sha256 === request.p01_binding_sha256],
    ["P02 binding", transition.p02_binding_sha256 === request.p02_binding_sha256],
    [
      "P03 runtime binding",
      transition.p03_runtime_binding_sha256 === request.p03_runtime_binding_sha256,
    ],
  ] as const) {
    if (!value) fail("cross_cohort_substitution", `P03 ${label} cohort binding mismatch`);
  }
  const boundArtifacts = [
    entry,
    qualification,
    graph_manifest,
    graph_support,
    query_aggregate,
    candidate_packet,
    coverage,
    evidence_manifest,
    successor_ledger,
    zero_model,
    gate,
  ];
  for (const artifact of boundArtifacts) {
    if (
      artifact.tenant_id !== transition.tenant_id ||
      artifact.project_id !== transition.project_id ||
      artifact.run_id !== transition.run_id ||
      artifact.p01_binding_sha256 !== transition.p01_binding_sha256 ||
      artifact.p02_binding_sha256 !== transition.p02_binding_sha256 ||
      artifact.p03_runtime_binding_sha256 !== transition.p03_runtime_binding_sha256 ||
      !same(artifact.source_snapshot_ref, transition.source_snapshot_ref) ||
      artifact.source_snapshot_sha256 !== transition.source_snapshot_sha256
    ) {
      fail(
        "cross_cohort_substitution",
        `P03 '${artifact.schema_id}' common cohort binding mismatch`
      );
    }
  }

  for (const [label, actual, expected] of [
    ["request oracle", request.source_oracle_ref, transition.source_oracle_ref],
    [
      "request receipt",
      request.source_oracle_validation_ref,
      transition.source_oracle_validation_ref,
    ],
    ["entry oracle", entry.source_oracle_ref, transition.source_oracle_ref],
    ["entry receipt", entry.source_oracle_validation_ref, transition.source_oracle_validation_ref],
    ["manifest oracle", evidence_manifest.source_oracle_ref, transition.source_oracle_ref],
    [
      "manifest receipt",
      evidence_manifest.source_oracle_validation_ref,
      transition.source_oracle_validation_ref,
    ],
  ] as const)
    assertSame(actual, expected, label);
  assertSame(transition.p03_request_ref, entry.p03_request_ref, "P03 entry request");
  assertSame(transition.entry_admission_ref, gate.entry_admission_ref, "P03 gate entry");
  assertSame(
    transition.qualification_record_ref,
    gate.qualification_record_ref,
    "P03 qualification"
  );
  assertSame(transition.graph_manifest_ref, gate.graph_manifest_ref, "P03 graph manifest");
  assertSame(
    transition.graph_support_matrix_ref,
    gate.graph_support_matrix_ref,
    "P03 graph support"
  );
  assertSame(
    transition.baseline_query_aggregate_ref,
    gate.baseline_query_aggregate_ref,
    "P03 query aggregate"
  );
  assertSame(transition.candidate_packet_ref, gate.candidate_packet_ref, "P03 candidates");
  assertSame(transition.coverage_matrix_ref, gate.coverage_matrix_ref, "P03 coverage");
  assertSame(transition.evidence_manifest_ref, gate.evidence_manifest_ref, "P03 evidence");
  assertSame(transition.successor_ledger_ref, gate.successor_ledger_ref, "P03 successor ledger");
  assertSame(transition.zero_model_evidence_ref, gate.zero_model_evidence_ref, "P03 zero model");
  assertSame(transition.gate_ref, transition.gate_ref, "P03 gate");

  if (
    gate.status !== "passed" ||
    gate.isolation_scope !== "live_qualified" ||
    gate.blocker_codes.length !== 0 ||
    qualification.status !== "passed" ||
    !qualification.live_qualified ||
    qualification.blocker_codes.length !== 0
  ) {
    fail(
      "predecessor_not_live_qualified",
      "P03 gate and qualification must both be positive live evidence"
    );
  }
  if (
    !graph_manifest.complete ||
    graph_manifest.components.length !== 2 ||
    graph_manifest.components.some(
      (entry, index) =>
        entry.partition !== SCA_P03_PARTITIONS[index] ||
        entry.status !== "complete" ||
        entry.graph_component_ref === null ||
        entry.graph_provenance_ref === null ||
        entry.graph_id === null
    )
  ) {
    fail("predecessor_incomplete", "P03 graph manifest is not a complete two-partition cohort");
  }
  if (
    !graph_support.complete ||
    graph_support.entries.some(
      (entry) =>
        entry.qualification_scope !== "live_qualified" ||
        entry.material_gap ||
        (entry.materiality === "material" &&
          entry.support !== "supported" &&
          entry.support !== "complemented")
    )
  ) {
    fail("predecessor_incomplete", "P03 graph support has an unclosed material gap");
  }
  if (
    !query_aggregate.complete ||
    query_aggregate.batches.length !== 2 ||
    query_aggregate.batches.some((batch, index) => {
      const graphRef = graph_manifest.components[index]?.graph_component_ref;
      return (
        batch.partition !== SCA_P03_PARTITIONS[index] ||
        graphRef === null ||
        graphRef === undefined ||
        !same(batch.graph_component_ref, graphRef) ||
        !batch.complete ||
        batch.truncated ||
        batch.ordered_query_ids.length !== SCA_P03_QUERY_IDS.length ||
        batch.ordered_query_ids.some((id, queryIndex) => id !== SCA_P03_QUERY_IDS[queryIndex])
      );
    })
  ) {
    fail("predecessor_incomplete", "P03 query aggregate is incomplete or truncated");
  }
  if (!candidate_packet.complete || !candidate_packet.source_bound) {
    fail("predecessor_incomplete", "P03 candidate packet is incomplete or not source-bound");
  }
  if (
    coverage.entries.some(
      (entry) => entry.status !== "complete" || entry.blocker_codes.length !== 0
    )
  ) {
    fail("predecessor_incomplete", "P03 coverage matrix is not exhaustively complete");
  }
  if (
    successor_ledger.dispositions.some((entry) => entry.status !== "satisfied") ||
    successor_ledger.pending_phase_ids[0] !== "SCA-P04" ||
    !successor_ledger.append_only ||
    successor_ledger.campaign_completion_claimed ||
    successor_ledger.release_eligible
  ) {
    fail(
      "predecessor_incomplete",
      "P03 successor ledger is not a positive append-only P04 handoff"
    );
  }
  if (
    zero_model.worker_kind !== "none" ||
    zero_model.model_calls !== 0 ||
    zero_model.model_turns !== 0 ||
    !zero_model.passed
  ) {
    fail("predecessor_incomplete", "P03 zero-model evidence is not positive");
  }
  for (const [label, expected, actual] of [
    ["request", transition.p03_request_ref, evidence_manifest.p03_request_ref],
    ["entry", transition.entry_admission_ref, evidence_manifest.entry_admission_ref],
    [
      "qualification",
      transition.qualification_record_ref,
      evidence_manifest.qualification_record_ref,
    ],
    ["graph manifest", transition.graph_manifest_ref, evidence_manifest.graph_manifest_ref],
    [
      "graph support",
      transition.graph_support_matrix_ref,
      evidence_manifest.graph_support_matrix_ref,
    ],
    [
      "query aggregate",
      transition.baseline_query_aggregate_ref,
      evidence_manifest.baseline_query_aggregate_ref,
    ],
    ["candidate packet", transition.candidate_packet_ref, evidence_manifest.candidate_packet_ref],
    ["coverage", transition.coverage_matrix_ref, evidence_manifest.coverage_matrix_ref],
    ["zero model", transition.zero_model_evidence_ref, evidence_manifest.zero_model_evidence_ref],
  ] as const) {
    assertSame(expected, actual, `P03 evidence manifest ${label}`);
  }
}

type P03QueryBatchView = Pick<
  ScaP03BaselineQueryAggregateV2["batches"][number],
  "partition" | "graph_component_ref" | "page_refs" | "ordered_query_ids" | "complete" | "truncated"
>;
type P03QueryResultView = Pick<
  ScaP03BaselineQueryBatchResultV2,
  | "partition"
  | "graph_component_ref"
  | "baseline_query_set_ref"
  | "executed_query_release_sha256"
  | "page_descriptors"
  | "query_footers"
  | "complete"
  | "truncated"
  | "status"
>;
type P03QueryPageView = Pick<
  ScaP03BaselineQueryPageV2,
  | "run_id"
  | "partition"
  | "source_snapshot_ref"
  | "source_snapshot_sha256"
  | "graph_component_ref"
  | "baseline_query_set_ref"
  | "query_release_sha256"
  | "query_id"
  | "page_number"
  | "item_count"
  | "complete"
>;

/** Match every accepted immutable page to exactly one descriptor in its own partition/result. */
export function validateScaP04AcceptedP03QueryPagesV1(input: {
  readonly aggregate: Pick<
    ScaP03BaselineQueryAggregateV2,
    "run_id" | "source_snapshot_ref" | "source_snapshot_sha256" | "baseline_query_set_ref"
  >;
  readonly batch: P03QueryBatchView;
  readonly result: P03QueryResultView;
  readonly pages: readonly { readonly ref: ArtifactRef; readonly page: P03QueryPageView }[];
}): void {
  const { aggregate, batch, result, pages } = input;
  if (
    !batch.complete ||
    batch.truncated ||
    batch.ordered_query_ids.length !== SCA_P03_QUERY_IDS.length ||
    batch.ordered_query_ids.some((id, index) => id !== SCA_P03_QUERY_IDS[index]) ||
    !result.complete ||
    result.truncated ||
    result.status !== "complete" ||
    result.partition !== batch.partition ||
    !same(result.graph_component_ref, batch.graph_component_ref) ||
    !same(result.baseline_query_set_ref, aggregate.baseline_query_set_ref) ||
    result.executed_query_release_sha256 === null ||
    result.query_footers.length !== SCA_P03_QUERY_IDS.length ||
    result.query_footers.some(
      (footer, index) => footer.query_id !== SCA_P03_QUERY_IDS[index] || !footer.complete
    )
  ) {
    fail("predecessor_incomplete", "P03 query batch is not the accepted complete V2 release");
  }
  const descriptors = new Map(
    result.page_descriptors.map((descriptor) => [
      `${descriptor.query_id}:${descriptor.page_number}`,
      descriptor,
    ])
  );
  const observed = new Map<
    string,
    { readonly ref: ArtifactRef; readonly page: P03QueryPageView }
  >();
  for (const entry of pages) {
    const key = `${entry.page.query_id}:${entry.page.page_number}`;
    if (
      observed.has(key) ||
      entry.page.run_id !== aggregate.run_id ||
      entry.page.partition !== batch.partition ||
      !same(entry.page.source_snapshot_ref, aggregate.source_snapshot_ref) ||
      entry.page.source_snapshot_sha256 !== aggregate.source_snapshot_sha256 ||
      !same(entry.page.graph_component_ref, batch.graph_component_ref) ||
      !same(entry.page.baseline_query_set_ref, aggregate.baseline_query_set_ref) ||
      entry.page.query_release_sha256 !== result.executed_query_release_sha256 ||
      entry.page.complete !==
        (entry.page.page_number ===
          result.query_footers.find((footer) => footer.query_id === entry.page.query_id)
            ?.page_count)
    ) {
      fail("cross_cohort_substitution", "P03 query page is duplicated or misbound");
    }
    observed.set(key, entry);
  }
  if (
    pages.length !== batch.page_refs.length ||
    descriptors.size !== result.page_descriptors.length ||
    observed.size !== descriptors.size ||
    new Set(pages.map((entry) => entry.ref.artifact_id)).size !== pages.length
  ) {
    fail("predecessor_incomplete", "P03 query page coverage disagrees with batch descriptors");
  }
  for (const [index, entry] of pages.entries()) {
    const expectedRef = batch.page_refs[index];
    if (expectedRef === undefined) fail("predecessor_incomplete", "P03 query page ref is missing");
    assertSame(expectedRef, entry.ref, "P03 query page");
  }
  for (const footer of result.query_footers) {
    if (footer.page_count < 1) fail("predecessor_incomplete", "P03 query has no pages");
    for (let number = 1; number <= footer.page_count; number++) {
      const key = `${footer.query_id}:${number}`;
      const descriptor = descriptors.get(key);
      const entry = observed.get(key);
      if (
        descriptor === undefined ||
        entry === undefined ||
        descriptor.item_count !== entry.page.item_count ||
        descriptor.byte_length !== entry.ref.byte_length ||
        descriptor.content_sha256 !== entry.ref.content_digest
      ) {
        fail("predecessor_incomplete", "P03 query page descriptor is absent or substituted");
      }
    }
  }
  if (
    result.query_footers.reduce((count, footer) => count + footer.page_count, 0) !==
    descriptors.size
  ) {
    fail("predecessor_incomplete", "P03 query has extra or duplicate page descriptors");
  }
}

export interface ScaP04AdmissionResultV1 {
  readonly request: ScaP04RequestV1;
  readonly implementation_identity: ScaP04ImplementationIdentityV1;
  readonly runtime_policy: ScaP04RuntimePolicyV1;
  readonly transition: ScaP03P04TransitionV2;
  readonly p03_request: ScaP03RequestV2;
  readonly p03_entry: ScaP03EntryAdmissionV2;
  readonly p03_qualification: ScaP03QualificationRecordV2;
  readonly graph_manifest: ScaP03GraphManifestV1;
  readonly graph_support: ScaP03GraphSupportMatrixV2;
  readonly query_aggregate: ScaP03BaselineQueryAggregateV2;
  readonly candidate_packet: ScaP03GraphCandidatePacketV2;
  readonly p03_coverage: ScaP03CoverageMatrixV1;
  readonly p03_evidence_manifest: ScaP03EvidenceManifestV2;
  readonly p03_successor_ledger: ScaP03SuccessorLedgerV1;
  readonly p03_zero_model: ScaP03ZeroModelEvidenceV1;
  readonly p03_gate: ScaP03GateV1;
  readonly p02_evidence_manifest: ScaP02EvidenceManifestV1;
  readonly p02_evidence: readonly ScaP02PersistedEvidenceV1[];
  readonly p01_request: ScaP01AdmissionRequestV3;
  readonly source_snapshot: ScaCampaignSourceSnapshotV2;
  readonly source_file_manifest: ScaP01SourceFileManifestV1;
  readonly source_custody: ScaP01SourceCustodyCorpusV1;
  readonly model_data_policy: ScaModelDataPolicyV1;
  readonly transitive_refs: readonly ArtifactRef[];
}

function assertP04InputRef(
  ref: ArtifactRef,
  kind: string,
  schemaId: string,
  schemaVersion: number,
  runId: string
): void {
  if (
    ref.run_id !== runId ||
    ref.phase !== "SCA-P04" ||
    ref.kind !== kind ||
    ref.producer !== P04_PRODUCER ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== schemaId ||
    ref.content_schema.schema_version !== schemaVersion
  ) {
    fail("artifact_mismatch", `P04 input '${kind}' metadata does not match trusted host contract`);
  }
}

function assertP03OutputRef(
  ref: ArtifactRef,
  input: { readonly run_id: string; readonly kind: string; readonly schema_id: string }
): void {
  if (
    ref.run_id !== input.run_id ||
    ref.phase !== "SCA-P03" ||
    ref.branch_id !== null ||
    ref.kind !== input.kind ||
    ref.producer !== P03_PRODUCER ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== input.schema_id ||
    ref.content_schema.schema_version !== (input.schema_id.endsWith(".v2") ? 2 : 1)
  ) {
    fail(
      "artifact_mismatch",
      `P03 output '${input.kind}' lacks exact trusted host metadata for the accepted cohort`
    );
  }
}

function assertApprovedModelPolicy(policy: ScaModelDataPolicyV1): void {
  const treatments = new Map(
    policy.data_classes.map((entry) => [entry.data_class, entry.treatment])
  );
  if (
    policy.status !== "approved" ||
    policy.model_alias !== SCA_P04_REQUIRED_MODEL.alias ||
    policy.provider !== SCA_P04_REQUIRED_MODEL.provider ||
    policy.model !== SCA_P04_REQUIRED_MODEL.model ||
    policy.destination_class !== "cloud" ||
    policy.provider_retention_status !== "known" ||
    policy.provider_training_use !== "prohibited" ||
    treatments.get("secrets") !== "deny" ||
    treatments.get("source-code") === "deny" ||
    treatments.get("scanner-evidence") === "deny" ||
    treatments.get("dependency-coordinates") === "deny"
  ) {
    fail(
      "model_policy_denied",
      "P01 model-data policy does not positively admit minimized P04 cloud use"
    );
  }
}

export function admitScaP04Candidate(input: {
  readonly store: ArtifactHostStore;
  readonly request: unknown;
  readonly input_artifacts: InputArtifacts;
  readonly trusted_clock: () => Date;
}): ScaP04AdmissionResultV1 {
  let request: ScaP04RequestV1;
  try {
    request = validateScaP04RequestV1(input.request);
  } catch (error) {
    fail("invalid_request", "P04 request validation failed", error);
  }
  assertExactInputs(input.input_artifacts, scaP04InputArtifacts(request));
  assertP04InputRef(
    request.implementation_identity_ref,
    "sca-p04-implementation-identity",
    "penny.sca-p04-implementation-identity.v1",
    1,
    request.run_id
  );
  assertP04InputRef(
    request.runtime_policy_ref,
    "sca-p04-runtime-policy",
    "penny.sca-p04-runtime-policy.v1",
    1,
    request.run_id
  );
  const implementationIdentity = parseContract(
    input.store,
    request.implementation_identity_ref,
    "P04 implementation identity",
    validateScaP04ImplementationIdentityV1
  );
  const runtimePolicy = parseContract(
    input.store,
    request.runtime_policy_ref,
    "P04 runtime policy",
    validateScaP04RuntimePolicyV1
  );
  const transition = parseContract(
    input.store,
    request.p03_transition_ref,
    "P03 to P04 transition",
    validateScaP03P04TransitionV2
  );
  if (
    transition.tenant_id !== request.tenant_id ||
    transition.project_id !== request.project_id ||
    transition.to_phase_id !== "SCA-P04" ||
    !transition.p04_entry_authorized
  ) {
    fail(
      "cross_cohort_substitution",
      "P04 request identity does not match its P03 transition root"
    );
  }
  assertP03OutputRef(request.p03_transition_ref, {
    run_id: transition.run_id,
    kind: "sca-p03-p04-transition",
    schema_id: "penny.sca-p03-p04-transition.v2",
  });
  for (const [ref, kind, schemaId] of [
    [transition.p03_request_ref, "sca-p03-candidate-request", "penny.sca-p03-request.v2"],
    [transition.entry_admission_ref, "sca-p03-entry-admission", "penny.sca-p03-entry-admission.v2"],
    [
      transition.qualification_record_ref,
      "sca-p03-qualification-record",
      "penny.sca-p03-qualification-record.v2",
    ],
    [transition.graph_manifest_ref, "sca-p03-graph-manifest", "penny.sca-p03-graph-manifest.v1"],
    [
      transition.graph_support_matrix_ref,
      "sca-p03-graph-support-matrix",
      "penny.sca-p03-graph-support-matrix.v2",
    ],
    [
      transition.baseline_query_aggregate_ref,
      "sca-p03-baseline-query-aggregate",
      "penny.sca-p03-baseline-query-aggregate.v2",
    ],
    [
      transition.candidate_packet_ref,
      "sca-p03-graph-candidate-packet",
      "penny.sca-p03-graph-candidate-packet.v2",
    ],
    [transition.coverage_matrix_ref, "sca-p03-coverage-matrix", "penny.sca-p03-coverage-matrix.v1"],
    [
      transition.evidence_manifest_ref,
      "sca-p03-evidence-manifest",
      "penny.sca-p03-evidence-manifest.v2",
    ],
    [
      transition.successor_ledger_ref,
      "sca-p03-successor-obligation-ledger",
      "penny.sca-p03-successor-obligation-ledger.v1",
    ],
    [
      transition.zero_model_evidence_ref,
      "sca-p03-zero-model-evidence",
      "penny.sca-p03-zero-model-evidence.v1",
    ],
    [transition.gate_ref, "sca-p03-gate", "penny.sca-p03-gate.v1"],
  ] as const) {
    assertP03OutputRef(ref, { run_id: transition.run_id, kind, schema_id: schemaId });
  }
  const p03Request = parseContract(
    input.store,
    transition.p03_request_ref,
    "P03 request",
    validateScaP03RequestV2
  );
  const p03Inputs = scaP03InputArtifacts(p03Request);
  const persistedP03Upstreams = input.store.metadata(transition.p03_request_ref).upstream_refs;
  if (
    canonicalJson(persistedP03Upstreams) !==
    canonicalJson(sortedUniqueRefs(p03Inputs.artifacts.map((item) => item.ref)))
  ) {
    fail(
      "cross_cohort_substitution",
      "P03 persisted request upstream closure differs from admitted inputs"
    );
  }
  // Re-run the complete P03 admission closure. The request determines its exact input set;
  // P04 does not trust caller-provided transitive substitutions.
  try {
    admitScaP03Candidate({
      store: input.store,
      request: p03Request,
      input_artifacts: p03Inputs,
      trusted_clock: input.trusted_clock,
    });
  } catch (error) {
    fail("cross_cohort_substitution", "P03 transitive admission closure failed", error);
  }
  const entry = parseContract(input.store, transition.entry_admission_ref, "P03 entry", (value) =>
    validateContract(ScaP03EntryAdmissionV2Schema, value, "P03 entry")
  );
  const qualification = parseContract(
    input.store,
    transition.qualification_record_ref,
    "P03 qualification",
    validateScaP03QualificationRecordV2
  );
  const graphManifest = parseContract(
    input.store,
    transition.graph_manifest_ref,
    "P03 graph manifest",
    validateScaP03GraphManifestV1
  );
  const graphSupport = parseContract(
    input.store,
    transition.graph_support_matrix_ref,
    "P03 graph support",
    validateScaP03GraphSupportMatrixV2
  );
  const queryAggregate = parseContract(
    input.store,
    transition.baseline_query_aggregate_ref,
    "P03 query aggregate",
    validateScaP03BaselineQueryAggregateV2
  );
  const candidatePacket = parseContract(
    input.store,
    transition.candidate_packet_ref,
    "P03 candidate packet",
    validateScaP03GraphCandidatePacketV2
  );
  const coverage = parseContract(
    input.store,
    transition.coverage_matrix_ref,
    "P03 coverage",
    validateScaP03CoverageMatrixV1
  );
  const evidenceManifest = parseContract(
    input.store,
    transition.evidence_manifest_ref,
    "P03 evidence manifest",
    validateScaP03EvidenceManifestV2
  );
  const successorLedger = parseContract(
    input.store,
    transition.successor_ledger_ref,
    "P03 successor ledger",
    validateScaP03SuccessorLedgerV1
  );
  const zeroModel = parseContract(
    input.store,
    transition.zero_model_evidence_ref,
    "P03 zero model",
    (value) => validateContract(ScaP03ZeroModelEvidenceV1Schema, value, "P03 zero model")
  );
  const gate = parseContract(input.store, transition.gate_ref, "P03 gate", validateScaP03GateV1);
  try {
    validateScaP03TransitionAgainstGateV1({
      transition,
      gate,
      gate_ref: transition.gate_ref,
      request_ref: transition.p03_request_ref,
      p02_m1_ref: transition.p02_m1_ref,
      p02_evidence_manifest_ref: transition.p02_evidence_manifest_ref,
    });
  } catch (error) {
    fail("cross_cohort_substitution", "P03 transition does not exactly bind its gate", error);
  }
  validateScaP04AcceptedP03CohortV1({
    transition,
    request: p03Request,
    entry,
    qualification,
    graph_manifest: graphManifest,
    graph_support: graphSupport,
    query_aggregate: queryAggregate,
    candidate_packet: candidatePacket,
    coverage,
    evidence_manifest: evidenceManifest,
    successor_ledger: successorLedger,
    zero_model: zeroModel,
    gate,
  });
  const packetPages = [];
  for (const batch of queryAggregate.batches) {
    const batchRequest = parseJson(input.store, batch.query_batch_request_ref, "P03 query request");
    const batchResult = parseContract(
      input.store,
      batch.query_batch_result_ref,
      "P03 query result",
      (value) => validateScaP03OperationResultV1("run_baseline_query_batch", batchRequest, value)
    );
    const pages = batch.page_refs.map((ref) => ({
      ref,
      page: parseContract(input.store, ref, "P03 query page", validateScaP03BaselineQueryPageV2),
    }));
    validateScaP04AcceptedP03QueryPagesV1({
      aggregate: queryAggregate,
      batch,
      result: batchResult,
      pages,
    });
    packetPages.push(...pages);
  }
  try {
    validateScaP03PacketAgainstQueryPagesV2({
      packet: candidatePacket,
      aggregate: queryAggregate,
      graph_manifest: graphManifest,
      pages: packetPages,
    });
  } catch (error) {
    fail("cross_cohort_substitution", "P03 packet does not preserve its exact query pages", error);
  }
  const queryPageRefs = sortedUniqueRefs(
    queryAggregate.batches.flatMap((batch) => batch.page_refs)
  );
  if (
    queryPageRefs.length !==
    queryAggregate.batches.reduce((sum, batch) => sum + batch.page_refs.length, 0)
  ) {
    fail("cross_cohort_substitution", "P03 query page ref is reused across partitions");
  }
  const queryPageIds = new Set(queryPageRefs.map((ref) => ref.artifact_id));
  const p03CohortDetailRefs = sortedUniqueRefs([
    qualification.qualification_evidence_ref,
    qualification.operation_log_ref,
    ...graphManifest.components.flatMap((component) => [
      ...(component.graph_component_ref === null ? [] : [component.graph_component_ref]),
      component.graph_build_result_ref,
      ...(component.graph_provenance_ref === null ? [] : [component.graph_provenance_ref]),
    ]),
    ...graphSupport.entries.flatMap((entry) => [
      ...entry.evidence_refs,
      ...(entry.graph_component_ref === null ? [] : [entry.graph_component_ref]),
      ...(entry.complement_evidence_ref === null ? [] : [entry.complement_evidence_ref]),
    ]),
    ...queryAggregate.batches.flatMap((batch) => [
      batch.graph_component_ref,
      batch.query_batch_request_ref,
      batch.query_batch_result_ref,
      ...batch.page_refs,
    ]),
    ...candidatePacket.candidates.flatMap((candidate) => [
      candidate.graph_component_ref,
      candidate.page_ref,
    ]),
    ...coverage.entries.flatMap((entry) => entry.evidence_refs),
    evidenceManifest.operation_log_ref,
    ...evidenceManifest.operations.flatMap((operation) => [
      operation.request_ref,
      operation.result_ref,
      operation.receipt_ref,
      ...operation.output_refs,
    ]),
  ]);
  for (const ref of p03CohortDetailRefs) {
    if (!queryPageIds.has(ref.artifact_id)) {
      readExact(input.store, ref, "P03 transitive cohort detail");
    }
  }

  const p02EvidenceManifest = parseContract(
    input.store,
    transition.p02_evidence_manifest_ref,
    "P02 evidence manifest",
    validateScaP02EvidenceManifestV1
  );
  const p02SuccessorLedger = parseContract(
    input.store,
    p03Request.accepted_p02.successor_ledger_ref,
    "P02 successor obligation ledger",
    validateScaP02SuccessorLedgerV1
  );
  assertSame(
    successorLedger.prior_p02_ledger_ref,
    p03Request.accepted_p02.successor_ledger_ref,
    "P03/P02 successor ledger"
  );
  if (
    !p02SuccessorLedger.pending_phase_ids.includes("SCA-P04") ||
    !p02SuccessorLedger.append_only
  ) {
    fail("predecessor_incomplete", "P02 successor ledger does not preserve pending P04 work");
  }
  assertSame(transition.p02_m1_ref, p03Request.accepted_p02.m1_ref, "P02 M1 transition/request");
  assertSame(
    transition.p02_evidence_manifest_ref,
    p03Request.accepted_p02.evidence_manifest_ref,
    "P02 evidence transition/request"
  );
  const p02Evidence = p02EvidenceManifest.operations.map((operation) =>
    parseContract(
      input.store,
      operation.normalized_evidence_ref,
      `P02 normalized evidence '${operation.operation_kind}'`,
      validateScaP02PersistedEvidenceV1
    )
  );
  const p01Request = parseContract(
    input.store,
    p03Request.accepted_p01.request_ref,
    "P01 request",
    validateScaP01AdmissionRequestV3
  );
  const sourceSnapshot = parseContract(
    input.store,
    p01Request.source.snapshot_ref,
    "P01 source snapshot",
    validateScaCampaignSourceSnapshotV2
  );
  assertSame(
    p03Request.source_snapshot_ref,
    p01Request.source.snapshot_ref,
    "P03/P01 source snapshot"
  );
  const sourceFileManifest = parseContract(
    input.store,
    sourceSnapshot.file_manifest_ref,
    "P01 source file manifest",
    validateScaP01SourceFileManifestV1
  );
  const sourceCustody = parseContract(
    input.store,
    sourceSnapshot.custody_ref,
    "P01 source custody",
    validateScaP01SourceCustodyCorpusV1
  );
  const modelDataPolicy = parseContract(
    input.store,
    p01Request.model_data_policy_ref,
    "P01 model data policy",
    validateScaModelDataPolicyV1
  );
  assertApprovedModelPolicy(modelDataPolicy);
  if (
    runtimePolicy.max_payload_bytes_per_call > modelDataPolicy.payload_limit_bytes ||
    sourceSnapshot.file_manifest_sha256 !== sourceSnapshot.file_manifest_ref.content_digest ||
    sourceSnapshot.custody_sha256 !== sourceSnapshot.custody_ref.content_digest
  ) {
    fail(
      "artifact_mismatch",
      "P04 runtime/source closure exceeds or disagrees with P01 policy bindings"
    );
  }

  const transitiveRefs = sortedUniqueRefs([
    request.p03_transition_ref,
    request.implementation_identity_ref,
    request.runtime_policy_ref,
    transition.p03_request_ref,
    transition.source_oracle_ref,
    transition.source_oracle_validation_ref,
    transition.p02_m1_ref,
    transition.p02_evidence_manifest_ref,
    p03Request.accepted_p02.successor_ledger_ref,
    transition.entry_admission_ref,
    transition.qualification_record_ref,
    transition.graph_manifest_ref,
    transition.graph_support_matrix_ref,
    transition.baseline_query_aggregate_ref,
    transition.candidate_packet_ref,
    transition.coverage_matrix_ref,
    transition.evidence_manifest_ref,
    transition.successor_ledger_ref,
    transition.zero_model_evidence_ref,
    transition.gate_ref,
    p03Request.accepted_p01.request_ref,
    p01Request.source.snapshot_ref,
    sourceSnapshot.file_manifest_ref,
    sourceSnapshot.custody_ref,
    p01Request.model_data_policy_ref,
    ...p02EvidenceManifest.operations.map((operation) => operation.normalized_evidence_ref),
    ...p03CohortDetailRefs,
  ]);
  return {
    request,
    implementation_identity: implementationIdentity,
    runtime_policy: runtimePolicy,
    transition,
    p03_request: p03Request,
    p03_entry: entry,
    p03_qualification: qualification,
    graph_manifest: graphManifest,
    graph_support: graphSupport,
    query_aggregate: queryAggregate,
    candidate_packet: candidatePacket,
    p03_coverage: coverage,
    p03_evidence_manifest: evidenceManifest,
    p03_successor_ledger: successorLedger,
    p03_zero_model: zeroModel,
    p03_gate: gate,
    p02_evidence_manifest: p02EvidenceManifest,
    p02_evidence: p02Evidence,
    p01_request: p01Request,
    source_snapshot: sourceSnapshot,
    source_file_manifest: sourceFileManifest,
    source_custody: sourceCustody,
    model_data_policy: modelDataPolicy,
    transitive_refs: transitiveRefs,
  };
}

function normalizedPath(value: string | null): string | null {
  if (value === null) return null;
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function sortedRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return sortedUniqueRefs(refs);
}

function makeItem(input: {
  readonly source_snapshot_sha256: string;
  readonly item_kind: ScaP04PopulationItemV1["item_kind"];
  readonly normalized_locator: string;
  readonly source_path: string | null;
  readonly package_coordinate: string | null;
  readonly alert_state: ScaP04PopulationItemV1["alert_state"];
  readonly aliases: readonly string[];
  readonly upstream_ids: readonly string[];
  readonly evidence_refs: readonly ArtifactRef[];
  readonly assigned_specialists: readonly (
    | typeof SCA_P04_SCANNER_SPECIALIST
    | typeof SCA_P04_UNDERDETECTED_SPECIALIST
  )[];
  readonly selection_metadata: ScaP04PopulationItemV1["selection_metadata"];
  readonly description: string;
}): ScaP04PopulationItemV1 {
  const upstreamIds = [...new Set(input.upstream_ids)].sort();
  return {
    stable_id: scaP04StableItemId({
      source_snapshot_sha256: input.source_snapshot_sha256,
      item_kind: input.item_kind,
      normalized_locator: input.normalized_locator,
      upstream_ids: upstreamIds,
    }),
    item_kind: input.item_kind,
    normalized_locator: input.normalized_locator,
    source_path: input.source_path,
    package_coordinate: input.package_coordinate,
    alert_state: input.alert_state,
    aliases: [...new Set(input.aliases)].sort(),
    upstream_ids: upstreamIds,
    evidence_refs: sortedRefs(input.evidence_refs),
    assigned_specialists: [...new Set(input.assigned_specialists)].sort(),
    selection_metadata: input.selection_metadata,
    description: input.description,
  };
}

export interface ScaP04PopulationAdmissionV1 {
  readonly request: { readonly run_id: string };
  readonly runtime_policy: {
    readonly max_population_items: number;
    readonly max_selected_items: number;
  };
  readonly p01_request: {
    readonly source: { readonly snapshot_ref: ArtifactRef };
  };
  readonly source_snapshot: { readonly file_manifest_ref: ArtifactRef };
  readonly source_file_manifest: {
    readonly files: readonly {
      readonly path: string;
      readonly content_sha256: string;
    }[];
  };
  readonly p02_evidence_manifest: {
    readonly operations: readonly { readonly normalized_evidence_ref: ArtifactRef }[];
  };
  readonly p02_evidence: readonly {
    readonly operation_kind: string;
    readonly normalized_observations: readonly {
      readonly observation_id: string;
      readonly analyzer_id: string;
      readonly category: string;
      readonly subject: string;
      readonly path: string | null;
      readonly start_line: number | null;
      readonly advisory_id: string | null;
      readonly correlation_id: string;
      readonly duplicate_group_id: string | null;
      readonly raw_record_ids: readonly string[];
    }[];
    readonly correlations: readonly {
      readonly correlation_id: string;
      readonly disposition: string;
      readonly raw_record_ids: readonly string[];
    }[];
  }[];
  readonly graph_support: {
    readonly entries: readonly {
      readonly requirement_id: string;
      readonly partition: string;
      readonly dimension: string;
      readonly subject: string;
      readonly evidence_refs: readonly ArtifactRef[];
    }[];
  };
  readonly candidate_packet: {
    readonly candidates: readonly {
      readonly candidate_id: string;
      readonly claim: ScaP03QueryCandidateV2["claim"];
      readonly disposition: ScaP03QueryCandidateV2["disposition"];
      readonly reason_code: ScaP03QueryCandidateV2["reason_code"];
      readonly graph_component_sha256: string;
      readonly source_snapshot_sha256: string;
      readonly query_release_sha256: string;
      readonly partition: string;
      readonly query_id: string;
      readonly path: string | null;
      readonly stable_locator: string;
      readonly summary: string;
      readonly graph_component_ref: ArtifactRef;
      readonly page_ref: ArtifactRef;
    }[];
  };
}

export function buildScaP04SelectionPopulation(input: {
  readonly admission: ScaP04PopulationAdmissionV1;
  readonly accepted_cohort_ref: ArtifactRef;
}): ScaP04SelectionPopulationV1 {
  const { admission } = input;
  const sourceDigest = admission.p01_request.source.snapshot_ref.content_digest;
  const items: ScaP04PopulationItemV1[] = [];
  const scannerPaths = new Set<string>();
  for (const [evidenceIndex, evidence] of admission.p02_evidence.entries()) {
    const evidenceRef =
      admission.p02_evidence_manifest.operations[evidenceIndex]?.normalized_evidence_ref;
    if (evidenceRef === undefined) fail("artifact_mismatch", "P02 evidence/ref cardinality drift");
    for (const observation of evidence.normalized_observations) {
      const path = normalizedPath(observation.path);
      if (path !== null) scannerPaths.add(path);
      const dependency =
        evidence.operation_kind === "osv_composer" ||
        evidence.operation_kind === "osv_npm" ||
        observation.analyzer_id === "dependency-composer" ||
        observation.analyzer_id === "dependency-npm";
      const packageCoordinate = dependency ? observation.subject : null;
      const locator = [
        dependency ? "dependency" : "scanner",
        path ?? "no-path",
        observation.start_line ?? "no-line",
        observation.advisory_id ?? observation.category,
        observation.subject,
      ].join(":");
      items.push(
        makeItem({
          source_snapshot_sha256: sourceDigest,
          item_kind: dependency ? "dependency_lead" : "scanner_lead",
          normalized_locator: locator,
          source_path: path,
          package_coordinate: packageCoordinate,
          alert_state: "scanner_alert",
          aliases: [
            observation.observation_id,
            observation.correlation_id,
            ...(observation.duplicate_group_id === null ? [] : [observation.duplicate_group_id]),
          ],
          upstream_ids: [
            observation.observation_id,
            observation.correlation_id,
            ...observation.raw_record_ids,
          ],
          evidence_refs: [evidenceRef],
          assigned_specialists: [SCA_P04_SCANNER_SPECIALIST],
          selection_metadata: {
            metadata_kind: "scanner_observation",
            operation_kind: evidence.operation_kind,
            observation_id: observation.observation_id,
            analyzer_id: observation.analyzer_id,
            category: observation.category,
            subject: observation.subject,
            start_line: observation.start_line,
            advisory_id: observation.advisory_id,
            correlation_id: observation.correlation_id,
            duplicate_group_id: observation.duplicate_group_id,
          },
          description: `${dependency ? "Dependency" : "Scanner"} lead: ${observation.subject}`,
        })
      );
    }
    for (const correlation of evidence.correlations.filter(
      (entry) => entry.disposition === "context_only"
    )) {
      items.push(
        makeItem({
          source_snapshot_sha256: sourceDigest,
          item_kind: "context_record",
          normalized_locator: `context:${evidence.operation_kind}:${correlation.correlation_id}`,
          source_path: null,
          package_coordinate: null,
          alert_state: "context_only",
          aliases: [correlation.correlation_id],
          upstream_ids: [correlation.correlation_id, ...correlation.raw_record_ids],
          evidence_refs: [evidenceRef],
          assigned_specialists: [SCA_P04_SCANNER_SPECIALIST],
          selection_metadata: {
            metadata_kind: "scanner_context",
            operation_kind: evidence.operation_kind,
            correlation_id: correlation.correlation_id,
            disposition: "context_only",
            raw_record_count: correlation.raw_record_ids.length,
          },
          description: `Deterministic ${evidence.operation_kind} context retained for lead selection`,
        })
      );
    }
  }
  for (const file of admission.source_file_manifest.files) {
    const path = normalizedPath(file.path);
    if (path === null) continue;
    const hasAlert = scannerPaths.has(path);
    items.push(
      makeItem({
        source_snapshot_sha256: sourceDigest,
        item_kind: "source_surface",
        normalized_locator: `source:${path}`,
        source_path: path,
        package_coordinate: null,
        alert_state: hasAlert ? "scanner_alert" : "no_alert",
        aliases: [],
        upstream_ids: [file.content_sha256],
        evidence_refs: [admission.source_snapshot.file_manifest_ref],
        assigned_specialists: hasAlert
          ? [SCA_P04_SCANNER_SPECIALIST, SCA_P04_UNDERDETECTED_SPECIALIST]
          : [SCA_P04_UNDERDETECTED_SPECIALIST],
        selection_metadata: {
          metadata_kind: "source_surface",
          content_sha256: file.content_sha256,
          scanner_alert_present: hasAlert,
        },
        description: hasAlert
          ? `Source surface with scanner-linked evidence: ${path}`
          : `Source surface with no scanner alert; absence is not evidence of safety: ${path}`,
      })
    );
  }
  for (const support of admission.graph_support.entries) {
    items.push(
      makeItem({
        source_snapshot_sha256: sourceDigest,
        item_kind: "context_record",
        normalized_locator: `graph-support:${support.partition}:${support.dimension}:${support.subject}:${support.requirement_id}`,
        source_path: null,
        package_coordinate: null,
        alert_state: "not_applicable",
        aliases: [support.requirement_id],
        upstream_ids: [support.requirement_id],
        evidence_refs: support.evidence_refs,
        assigned_specialists: [SCA_P04_UNDERDETECTED_SPECIALIST],
        selection_metadata: {
          metadata_kind: "p03_graph_support",
          requirement_id: support.requirement_id,
          partition: support.partition,
          dimension: support.dimension,
          subject: support.subject,
        },
        description: `Required graph-support surface (${support.dimension}): ${support.subject}`,
      })
    );
  }
  for (const candidate of admission.candidate_packet.candidates) {
    const path = normalizedPath(candidate.path);
    items.push(
      makeItem({
        source_snapshot_sha256: sourceDigest,
        item_kind: "graph_candidate",
        normalized_locator: `graph:${candidate.partition}:${candidate.stable_locator}`,
        source_path: path,
        package_coordinate: null,
        alert_state: path !== null && scannerPaths.has(path) ? "scanner_alert" : "no_alert",
        aliases: [candidate.candidate_id],
        upstream_ids: [candidate.candidate_id, candidate.query_id],
        evidence_refs: [candidate.graph_component_ref, candidate.page_ref],
        assigned_specialists: [SCA_P04_UNDERDETECTED_SPECIALIST],
        selection_metadata: {
          metadata_kind: "p03_graph_candidate",
          candidate_id: candidate.candidate_id,
          claim: candidate.claim,
          disposition: candidate.disposition,
          reason_code: candidate.reason_code,
          graph_component_sha256: candidate.graph_component_sha256,
          source_snapshot_sha256: candidate.source_snapshot_sha256,
          query_release_sha256: candidate.query_release_sha256,
          graph_component_ref: candidate.graph_component_ref,
          page_ref: candidate.page_ref,
          partition: candidate.partition,
          query_id: candidate.query_id,
          stable_locator: candidate.stable_locator,
          summary: candidate.summary,
        },
        description: candidate.summary,
      })
    );
  }
  const byId = new Map<string, ScaP04PopulationItemV1>();
  for (const item of items) {
    const prior = byId.get(item.stable_id);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(item)) {
      fail("cross_cohort_substitution", `P04 stable item '${item.stable_id}' collides`);
    }
    byId.set(item.stable_id, item);
  }
  const ordered = [...byId.values()].sort((left, right) =>
    left.stable_id.localeCompare(right.stable_id)
  );
  if (ordered.length > admission.runtime_policy.max_population_items) {
    fail("population_overflow", "P04 population exceeds runtime policy; truncation is forbidden");
  }
  const body = {
    schema_id: "penny.sca-p04-selection-population.v1" as const,
    schema_version: 1 as const,
    phase_id: "SCA-P04" as const,
    run_id: admission.request.run_id,
    source_snapshot_ref: admission.p01_request.source.snapshot_ref,
    source_snapshot_sha256: sourceDigest,
    accepted_cohort_ref: input.accepted_cohort_ref,
    items: ordered,
    item_count: ordered.length,
    max_selected_items: admission.runtime_policy.max_selected_items,
    specialist_ids: [...SCA_P04_SPECIALIST_IDS] as [
      typeof SCA_P04_SCANNER_SPECIALIST,
      typeof SCA_P04_UNDERDETECTED_SPECIALIST,
    ],
  };
  return validateScaP04SelectionPopulationV1(withSelfDigest(body, "population_sha256"));
}

export function buildScaP04AcceptedCohortArtifact(input: {
  readonly admission: ScaP04AdmissionResultV1;
  readonly p04_request_ref: ArtifactRef;
  readonly admitted_at: string;
  readonly qualification_scope?: "live_qualified" | "deterministic_test_only";
}): ScaP04AcceptedCohortV1 {
  const { admission } = input;
  const body = {
    schema_id: "penny.sca-p04-accepted-cohort.v1" as const,
    schema_version: 1 as const,
    tenant_id: admission.request.tenant_id,
    project_id: admission.request.project_id,
    run_id: admission.request.run_id,
    phase_id: "SCA-P04" as const,
    p04_request_ref: input.p04_request_ref,
    implementation_identity_ref: admission.request.implementation_identity_ref,
    runtime_policy_ref: admission.request.runtime_policy_ref,
    refs: {
      p03_transition_ref: admission.request.p03_transition_ref,
      p03_request_ref: admission.transition.p03_request_ref,
      p03_entry_ref: admission.transition.entry_admission_ref,
      p03_qualification_ref: admission.transition.qualification_record_ref,
      p03_graph_manifest_ref: admission.transition.graph_manifest_ref,
      p03_supported_matrix_ref: admission.transition.graph_support_matrix_ref,
      p03_query_aggregate_ref: admission.transition.baseline_query_aggregate_ref,
      p03_candidate_packet_ref: admission.transition.candidate_packet_ref,
      p03_coverage_matrix_ref: admission.transition.coverage_matrix_ref,
      p03_evidence_manifest_ref: admission.transition.evidence_manifest_ref,
      p03_successor_ledger_ref: admission.transition.successor_ledger_ref,
      p03_zero_model_ref: admission.transition.zero_model_evidence_ref,
      p03_gate_ref: admission.transition.gate_ref,
      p02_m1_ref: admission.transition.p02_m1_ref,
      p02_evidence_manifest_ref: admission.transition.p02_evidence_manifest_ref,
      p01_request_ref: admission.p03_request.accepted_p01.request_ref,
      p01_source_snapshot_ref: admission.p01_request.source.snapshot_ref,
      p01_source_file_manifest_ref: admission.source_snapshot.file_manifest_ref,
      p01_source_custody_ref: admission.source_snapshot.custody_ref,
      p01_model_data_policy_ref: admission.p01_request.model_data_policy_ref,
    },
    transitive_refs_sha256: sha256(canonicalJson(admission.transitive_refs)),
    transitive_ref_count: admission.transitive_refs.length,
    qualification_scope: input.qualification_scope ?? ("live_qualified" as const),
    accepted_p03: true as const,
    model_data_policy_status: "approved" as const,
    admitted_at: input.admitted_at,
  };
  return validateScaP04AcceptedCohortV1(withSelfDigest(body, "admission_sha256"));
}

export function createScaP04Request(input: {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly p03_transition_ref: ArtifactRef;
  readonly implementation_identity_ref: ArtifactRef;
  readonly runtime_policy_ref: ArtifactRef;
  readonly requested_at: string;
}): ScaP04RequestV1 {
  const body = {
    schema_id: "penny.sca-p04-request.v1" as const,
    schema_version: 1 as const,
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: input.run_id,
    phase_id: "SCA-P04" as const,
    p03_transition_ref: input.p03_transition_ref,
    implementation_identity_ref: input.implementation_identity_ref,
    runtime_policy_ref: input.runtime_policy_ref,
    requested_at: input.requested_at,
  };
  return validateScaP04RequestV1({ ...body, request_sha256: scaP04RequestSha256(body) });
}

// Keep schemas referenced from this inactive candidate module so inventory checks catch drift.
void ScaP04RequestV1Schema;
void ScaP04AcceptedCohortV1Schema;
void ScaP04SelectionPopulationV1Schema;
void ScaP01AdmissionRequestV3Schema;
void ScaCampaignSourceSnapshotV2Schema;
void ScaP01SourceFileManifestV1Schema;
void ScaP01SourceCustodyCorpusV1Schema;
void ScaModelDataPolicyV1Schema;
void P03_PRODUCER;
