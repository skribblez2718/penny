import { TextDecoder } from "node:util";
import { Type, type Static } from "typebox";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";

import {
  currentArtifactRef,
  previewArtifactRef,
  type ArtifactHostStore,
} from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { admitScaP03Candidate, scaP03InputArtifacts } from "./p03-admission.js";
import {
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
} from "./p03-contracts.js";
import {
  validateScaP04AcceptedP03CohortV1,
  validateScaP04AcceptedP03QueryPagesV1,
} from "./p04-admission.js";

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function sortedUniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const map = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const prior = map.get(ref.artifact_id);
    if (prior !== undefined && !same(prior, ref)) throw new Error("P03 conflicting refs");
    map.set(ref.artifact_id, ref);
  }
  return [...map.values()].sort((a, b) =>
    Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
  );
}
/** Current revision, exact bytes and artifact identity, never producer labels alone. */
export function readScaP03CurrentArtifact(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string
): Buffer {
  const current = currentArtifactRef(ref, label);
  if (
    !same(store.refById(current.artifact_id), current) ||
    store.lastVersion(
      current.run_id,
      current.phase,
      current.branch_id,
      current.kind,
      current.operation_id
    ) !== current.version
  )
    throw new Error(`${label} missing, substituted or stale revision`);
  const bytes = store.readById(current.artifact_id);
  if (
    bytes.byteLength !== current.byte_length ||
    sha256(bytes) !== current.content_digest ||
    !same(previewArtifactRef({ metadata: store.metadata(current), content: bytes }), current)
  )
    throw new Error(`${label} custody mismatch`);
  return bytes;
}
const readExact = readScaP03CurrentArtifact;
export function readScaP03CurrentJson(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string
): unknown {
  if (ref.media_type !== "application/json" || ref.byte_length > 64 * 1_048_576)
    throw new Error(`${label} JSON contract mismatch`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readExact(store, ref, label));
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`${label} must be canonical JSON`);
  return value;
}
const parseJson = readScaP03CurrentJson;
function parseContract<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string,
  validate: (value: unknown) => T
): T {
  return validate(parseJson(store, ref, label));
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
    ref.producer !== "host:sca-p03-candidate" ||
    ref.content_schema?.schema_id !== input.schema_id ||
    ref.content_schema.schema_version !== (input.schema_id.endsWith(".v2") ? 2 : 1)
  )
    throw new Error("P03 operational artifact contract mismatch");
}

/** Replay only: no P04 admission, model work, registration, collector or activation. */
export function requireScaP03OperationalCohort(input: {
  readonly store: ArtifactHostStore;
  readonly transition_ref: ArtifactRef;
  readonly gate_ref: ArtifactRef;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly trusted_clock: () => Date;
}) {
  const transition = parseContract(
    input.store,
    input.transition_ref,
    "P03 to P04 transition",
    validateScaP03P04TransitionV2
  );
  if (
    transition.tenant_id !== input.tenant_id ||
    transition.project_id !== input.project_id ||
    !same(transition.gate_ref, input.gate_ref)
  )
    throw new Error("P03 operational cohort identity or gate mismatch");
  assertP03OutputRef(input.transition_ref, {
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
    throw new Error("P03 persisted request upstream closure differs from admitted inputs");
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
    throw new Error("P03 transitive admission closure failed", { cause: error });
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
    throw new Error("P03 transition does not exactly bind its gate", { cause: error });
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
  validateScaP03PacketAgainstQueryPagesV2({
    packet: candidatePacket,
    aggregate: queryAggregate,
    graph_manifest: graphManifest,
    pages: packetPages,
  });
  const queryPageRefs = sortedUniqueRefs(
    queryAggregate.batches.flatMap((batch) => batch.page_refs)
  );
  if (
    queryPageRefs.length !==
    queryAggregate.batches.reduce((sum, batch) => sum + batch.page_refs.length, 0)
  ) {
    throw new Error("P03 query page ref is reused across partitions");
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

  const refs = sortedUniqueRefs([
    input.transition_ref,
    transition.p03_request_ref,
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
    ...p03Inputs.artifacts.map((item) => item.ref),
    ...p03CohortDetailRefs,
  ]);
  // Immediate persisted ancestors are checked too; a missing detail cannot hide behind a valid top-level ref.
  for (const ref of refs) {
    readExact(input.store, ref, "P03 operational cohort ref");
    for (const upstream of input.store.metadata(ref).upstream_refs)
      readExact(input.store, upstream, "P03 operational provenance ref");
  }
  return { request: p03Request, refs };
}

/** Collector output is an exact operational input, never a formal gate or activation authority. */
export const ScaP03OperationalSummaryV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-formal-collector-summary.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    status: Type.Literal("candidate_boundary_passed"),
    aggregate_profile_sha256: Sha256Schema,
    gate_ref: ArtifactRefSchema,
    p04_transition_ref: ArtifactRefSchema,
    p02_operational_summary_ref: ArtifactRefSchema,
    bootstrap_handoff_sha256: Sha256Schema,
    bootstrap_proof_sha256: Sha256Schema,
    deployment_identity_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ScaP03OperationalSummaryV1 = Readonly<Static<typeof ScaP03OperationalSummaryV1Schema>>;
export const SCA_P03_OPERATIONAL_SUMMARY_KIND = "sca-p03-operational-qualification-input" as const;
export const SCA_P03_OPERATIONAL_SUMMARY_PRODUCER = "host:sca-p03-qualification-custodian" as const;
export function requireScaP03OperationalSummary(input: {
  readonly store: ArtifactHostStore;
  readonly summary_ref: ArtifactRef;
  readonly gate_ref: ArtifactRef;
  readonly transition_ref: ArtifactRef;
  readonly tenant_id: string;
  readonly project_id: string;
}): ScaP03OperationalSummaryV1 {
  const ref = input.summary_ref;
  if (
    ref.kind !== SCA_P03_OPERATIONAL_SUMMARY_KIND ||
    ref.producer !== SCA_P03_OPERATIONAL_SUMMARY_PRODUCER ||
    ref.phase !== "SCA-P03" ||
    ref.branch_id !== null ||
    ref.content_schema?.schema_id !== "penny.sca-p03-formal-collector-summary.v1" ||
    ref.content_schema.schema_version !== 1
  )
    throw new Error("P03 operational summary artifact contract mismatch");
  const summary = validateContract(
    ScaP03OperationalSummaryV1Schema,
    parseJson(input.store, ref, "P03 operational summary"),
    "P03 operational summary"
  );
  if (
    summary.tenant_id !== input.tenant_id ||
    summary.project_id !== input.project_id ||
    summary.run_id !== ref.run_id ||
    summary.run_id !== input.gate_ref.run_id ||
    summary.run_id !== input.transition_ref.run_id ||
    !same(summary.gate_ref, input.gate_ref) ||
    !same(summary.p04_transition_ref, input.transition_ref)
  )
    throw new Error("P03 operational summary cohort mismatch");
  return summary;
}
