import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, InputArtifacts } from "../contracts.js";
import {
  MODEL_DISPATCH_GUARD_V1_SCHEMA,
  MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
  validateModelDispatchGuardV1,
  validateModelExecutionReceiptV1,
} from "../required-model.js";
import { SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA } from "./p02-contracts.js";
import { SCA_P03_GRAPH_CANDIDATE_PACKET_V1_SCHEMA } from "./p03-contracts.js";
import {
  admitScaP04Candidate,
  buildScaP04AcceptedCohortArtifact,
  scaP04InputArtifacts,
  type ScaP04AdmissionResultV1,
} from "./p04-admission.js";
import {
  SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P04_CONVERGENCE_MATRIX_V1_SCHEMA,
  SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA,
  SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P04_EVIDENCE_MANIFEST_V1_SCHEMA,
  SCA_P04_GATE_V1_SCHEMA,
  SCA_P04_OMISSION_DOSSIER_V1_SCHEMA,
  SCA_P04_POPULATION_V1_SCHEMA,
  SCA_P04_PROVIDER_OPENING_GUARD,
  SCA_P04_REQUIRED_MODEL,
  SCA_P04_SCANNER_SPECIALIST,
  SCA_P04_SELECTION_DOSSIER_V1_SCHEMA,
  SCA_P04_SPECIALIST_DOSSIER_V1_SCHEMA,
  SCA_P04_SUCCESSOR_LEDGER_V1_SCHEMA,
  SCA_P04_TO_P05_TRANSITION_V1_SCHEMA,
  SCA_P04_UNDERDETECTED_SPECIALIST,
  scaP04StableDiscoveryId,
  validateScaP04AcceptedCohortV1,
  validateScaP04CognitivePayloadV1,
  validateScaP04ConvergenceMatrixV1,
  validateScaP04CoverageDossierV1,
  validateScaP04DisclosureAdmissionV1,
  validateScaP04EvidenceManifestV1,
  validateScaP04GateV1,
  validateScaP04OmissionDossierV1,
  validateScaP04RequestV1,
  validateScaP04SelectionDossierV1,
  validateScaP04SelectionPopulationV1,
  validateScaP04SpecialistDossierV1,
  validateScaP04SpecialistResultV1,
  validateScaP04SuccessorLedgerV1,
  validateScaP04ToP05TransitionV1,
  type ScaP04AcceptedCohortV1,
  type ScaP04ConvergenceRowV1,
  type ScaP04CoverageDossierV1,
  type ScaP04EvidenceManifestV1,
  type ScaP04GateV1,
  type ScaP04OmissionDossierV1,
  type ScaP04SelectionDossierV1,
  type ScaP04SpecialistResultItemV1,
  type ScaP04SpecialistResultV1,
  type ScaP04SuccessorLedgerV1,
  type ScaP04ToP05TransitionV1,
} from "./p04-contracts.js";
import {
  SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P05_CONTROL_RECORD_V1_SCHEMA,
  SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P05_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  SCA_P05_REQUEST_V1_SCHEMA,
  SCA_P05_RUNTIME_POLICY_V1_SCHEMA,
  ScaP05AcceptedCohortV1Schema,
  validateScaP05AcceptedCohortV1,
  validateScaP05ControlRecordV1,
  validateScaP05DisclosureAuthorityV1,
  validateScaP05DisclosureScopeV1,
  validateScaP05ImplementationIdentityV1,
  validateScaP05RequestV1,
  validateScaP05RuntimePolicyV1,
  withSelfDigest,
  type ScaP05AcceptedCohortV1,
  type ScaP05DisclosureScopeV1,
  type ScaP05EvidencePermissionV1,
  type ScaP05ImplementationIdentityV1,
  type ScaP05RequestV1,
  type ScaP05RuntimePolicyV1,
} from "./p05-contracts.js";

const P05_PRODUCER = "host:sca-p05-candidate" as const;

export class ScaP05AdmissionError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "artifact_mismatch"
      | "cross_cohort_substitution"
      | "predecessor_not_accepted"
      | "disclosure_scope_denied"
      | "source_binding_mismatch"
      | "limit_exceeded",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaP05AdmissionError";
  }
}

function fail(code: ScaP05AdmissionError["code"], message: string, cause?: unknown): never {
  throw new ScaP05AdmissionError(code, message, cause === undefined ? undefined : { cause });
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const prior = byId.get(ref.artifact_id);
    if (prior !== undefined && !same(prior, ref)) {
      fail("cross_cohort_substitution", "P05 predecessor evidence contains conflicting full refs");
    }
    byId.set(ref.artifact_id, ref);
  }
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function hostP04Ref(
  ref: ArtifactRef,
  input: {
    readonly run_id: string;
    readonly kind: string;
    readonly operation_id: string;
    readonly schema_id: string;
    readonly branch_id?: string | null;
  }
): boolean {
  return (
    ref.run_id === input.run_id &&
    ref.phase === "SCA-P04" &&
    ref.branch_id === (input.branch_id ?? null) &&
    ref.kind === input.kind &&
    ref.operation_id === input.operation_id &&
    ref.version === 1 &&
    ref.producer === "host:sca-p04-candidate" &&
    ref.media_type === "application/json" &&
    ref.content_schema?.schema_id === input.schema_id &&
    ref.content_schema.schema_version === 1
  );
}
function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) {
    fail("artifact_mismatch", `${label} full artifact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    fail("artifact_mismatch", `${label} exact bytes do not match the admitted ref`);
  }
  return bytes;
}
function exactJson<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string,
  validate: (value: unknown) => T
): T {
  const bytes = exactBytes(store, ref, label);
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return validate(parsed);
  } catch (error) {
    fail("artifact_mismatch", `${label} is not valid canonical contract JSON`, error);
  }
}
export function parseScaP04PersistedSpecialistResult(
  persistedText: string
): ScaP04SpecialistResultV1 {
  const outputText = persistedText.endsWith("\n") ? persistedText.slice(0, -1) : persistedText;
  if (outputText.length === 0 || outputText.endsWith("\n")) {
    fail("artifact_mismatch", "P04 specialist output has an invalid trailing-line shape");
  }
  const exactSummary = outputText.match(/^SUMMARY:(\{[^\n]*\})$/u)?.[1];
  const outputJson = exactSummary ?? outputText;
  let outputValue: unknown;
  try {
    outputValue = JSON.parse(outputJson);
  } catch (error) {
    fail(
      "artifact_mismatch",
      "P04 specialist output is neither an exact SUMMARY nor raw phase JSON",
      error
    );
  }
  if (exactSummary !== undefined) {
    if (!isUnknownRecord(outputValue)) {
      fail("artifact_mismatch", "P04 specialist SUMMARY is not an object");
    }
    const { confidence, ...details } = outputValue;
    if (
      confidence !== undefined &&
      confidence !== "CERTAIN" &&
      confidence !== "PROBABLE" &&
      confidence !== "POSSIBLE" &&
      confidence !== "UNCERTAIN"
    ) {
      fail("artifact_mismatch", "P04 specialist SUMMARY confidence is invalid");
    }
    outputValue = details;
  }
  return validateScaP04SpecialistResultV1(outputValue);
}

export function assertScaP05InputMetadata(
  ref: ArtifactRef,
  input: {
    readonly run_id: string;
    readonly kind: string;
    readonly operation_id: string;
    readonly schema_id: string;
  }
): void {
  if (
    ref.run_id !== input.run_id ||
    ref.phase !== "SCA-P05" ||
    ref.branch_id !== null ||
    ref.kind !== input.kind ||
    ref.operation_id !== input.operation_id ||
    ref.version !== 1 ||
    ref.producer !== P05_PRODUCER ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== input.schema_id ||
    ref.content_schema.schema_version !== 1
  ) {
    fail("artifact_mismatch", `P05 input '${input.kind}' metadata is not host-owned`);
  }
}
function assertExactInputs(actual: InputArtifacts, expected: InputArtifacts): void {
  if (!same(actual, expected))
    fail("invalid_request", "P05 exact start inputs differ from request");
}
function extractVerbatimLines(
  content: string,
  startLine: number,
  endLineExclusive: number
): string {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  const start = starts[startLine - 1];
  const end = endLineExclusive - 1 < starts.length ? starts[endLineExclusive - 1] : content.length;
  if (
    start === undefined ||
    end === undefined ||
    endLineExclusive > starts.length + 1 ||
    end <= start
  ) {
    fail(
      "source_binding_mismatch",
      "P05 source segment line range is outside frozen source custody"
    );
  }
  return content.slice(start, end);
}
function decodeJsonPointerToken(value: string): string {
  return value.replace(/~1/gu, "/").replace(/~0/gu, "~");
}
function resolveJsonPointer(value: unknown, selector: string): unknown {
  if (!selector.startsWith("json-pointer:")) {
    fail(
      "source_binding_mismatch",
      "P05 structured evidence selector is not an exact JSON pointer"
    );
  }
  const pointer = selector.slice("json-pointer:".length);
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) {
    fail("source_binding_mismatch", "P05 structured evidence JSON pointer is malformed");
  }
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const token = decodeJsonPointerToken(raw);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
        fail("source_binding_mismatch", "P05 structured evidence array pointer is malformed");
      }
      current = current[Number(token)];
    } else if (typeof current === "object" && current !== null) {
      current = Reflect.get(current, token);
    } else {
      current = undefined;
    }
    if (current === undefined) {
      fail("source_binding_mismatch", "P05 structured evidence JSON pointer is unresolved");
    }
  }
  return current;
}
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(canonicalJson(value));
  if (!isUnknownRecord(parsed)) {
    fail("source_binding_mismatch", `${label} is not a canonical object evidence value`);
  }
  return parsed;
}
function jsonEvidenceValue(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  selector: string,
  label: string
): string | Record<string, unknown> | unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exactBytes(store, ref, label).toString("utf8"));
  } catch (error) {
    fail("source_binding_mismatch", `${label} is not exact JSON evidence`, error);
  }
  const value = resolveJsonPointer(parsed, selector);
  if (typeof value !== "string" && !Array.isArray(value) && !isUnknownRecord(value)) {
    fail("source_binding_mismatch", `${label} selected value is not a permitted evidence value`);
  }
  return value;
}

export function scaP05InputArtifacts(request: ScaP05RequestV1): InputArtifacts {
  return {
    schema_version: 2,
    artifacts: [
      { slot: "p04_transition", ref: request.p04_transition_ref },
      { slot: "implementation_identity", ref: request.implementation_identity_ref },
      { slot: "runtime_policy", ref: request.runtime_policy_ref },
      { slot: "disclosure_scope", ref: request.disclosure_scope_ref },
    ],
  };
}

export interface ScaP05AcceptedP04CohortV1 {
  readonly transition: ScaP04ToP05TransitionV1;
  readonly accepted_cohort: ScaP04AcceptedCohortV1;
  readonly selection_dossier: ScaP04SelectionDossierV1;
  readonly omission_dossier: ScaP04OmissionDossierV1;
  readonly coverage_dossier: ScaP04CoverageDossierV1;
  readonly evidence_manifest: ScaP04EvidenceManifestV1;
  readonly successor_ledger: ScaP04SuccessorLedgerV1;
  readonly gate: ScaP04GateV1;
  readonly p04_admission: ScaP04AdmissionResultV1;
  readonly exact_refs: readonly ArtifactRef[];
}

export function admitScaP04CompletedCohort(input: {
  readonly store: ArtifactHostStore;
  readonly transition_ref: ArtifactRef;
  readonly trusted_clock: () => Date;
}): ScaP05AcceptedP04CohortV1 {
  const transition = exactJson(
    input.store,
    input.transition_ref,
    "P04 to P05 transition",
    validateScaP04ToP05TransitionV1
  );
  if (
    transition.target_phase_id !== "SCA-P05" ||
    transition.qualification_scope !== "live_qualified" ||
    !transition.authorized
  ) {
    fail("predecessor_not_accepted", "P04 transition is not live-qualified and authorized");
  }
  const p04Request = exactJson(
    input.store,
    transition.p04_request_ref,
    "P04 request",
    validateScaP04RequestV1
  );
  let p04Admission: ScaP04AdmissionResultV1;
  try {
    p04Admission = admitScaP04Candidate({
      store: input.store,
      request: p04Request,
      input_artifacts: scaP04InputArtifacts(p04Request),
      trusted_clock: input.trusted_clock,
    });
  } catch (error) {
    fail("predecessor_not_accepted", "P04 transitive admission could not be reproduced", error);
  }
  const acceptedCohort = exactJson(
    input.store,
    transition.accepted_cohort_ref,
    "P04 accepted cohort",
    validateScaP04AcceptedCohortV1
  );
  const expectedCohort = buildScaP04AcceptedCohortArtifact({
    admission: p04Admission,
    p04_request_ref: transition.p04_request_ref,
    admitted_at: acceptedCohort.admitted_at,
  });
  if (!same(acceptedCohort, expectedCohort)) {
    fail(
      "cross_cohort_substitution",
      "P04 accepted cohort is not the deterministic transitive rebuild"
    );
  }
  if (
    transition.tenant_id !== acceptedCohort.tenant_id ||
    transition.project_id !== acceptedCohort.project_id ||
    transition.source_run_id !== acceptedCohort.run_id ||
    p04Request.tenant_id !== acceptedCohort.tenant_id ||
    p04Request.project_id !== acceptedCohort.project_id ||
    p04Request.run_id !== acceptedCohort.run_id ||
    acceptedCohort.qualification_scope !== "live_qualified" ||
    acceptedCohort.model_data_policy_status !== "approved" ||
    !same(transition.p04_request_ref, acceptedCohort.p04_request_ref)
  ) {
    fail("cross_cohort_substitution", "P04 transition identity differs from its accepted cohort");
  }
  const selection = exactJson(
    input.store,
    transition.selection_dossier_ref,
    "P04 selection dossier",
    validateScaP04SelectionDossierV1
  );
  const omission = exactJson(
    input.store,
    transition.omission_dossier_ref,
    "P04 omission dossier",
    validateScaP04OmissionDossierV1
  );
  const coverage = exactJson(
    input.store,
    transition.coverage_dossier_ref,
    "P04 coverage dossier",
    validateScaP04CoverageDossierV1
  );
  const evidence = exactJson(
    input.store,
    transition.evidence_manifest_ref,
    "P04 evidence manifest",
    validateScaP04EvidenceManifestV1
  );
  const ledger = exactJson(
    input.store,
    transition.successor_ledger_ref,
    "P04 successor ledger",
    validateScaP04SuccessorLedgerV1
  );
  const gate = exactJson(input.store, transition.gate_ref, "P04 gate", validateScaP04GateV1);
  if (
    transition.gate_sha256 !== transition.gate_ref.content_digest ||
    gate.gate_status !== "passed" ||
    gate.qualification_scope !== "live_qualified" ||
    gate.pending_obligation_count !== 0 ||
    gate.blocker_codes.length !== 0 ||
    !same(gate.required_model, SCA_P04_REQUIRED_MODEL) ||
    !gate.exhaustive_accounting ||
    !gate.disclosure_admissions_allowed ||
    ledger.pending_obligations.length !== 0 ||
    gate.run_id !== acceptedCohort.run_id ||
    !same(gate.accepted_cohort_ref, transition.accepted_cohort_ref) ||
    !same(gate.selection_dossier_ref, transition.selection_dossier_ref) ||
    !same(gate.omission_dossier_ref, transition.omission_dossier_ref) ||
    !same(gate.coverage_dossier_ref, transition.coverage_dossier_ref) ||
    !same(gate.evidence_manifest_ref, transition.evidence_manifest_ref) ||
    !same(gate.successor_ledger_ref, transition.successor_ledger_ref)
  ) {
    fail("predecessor_not_accepted", "P04 gate/transition closure is not a passing exact cohort");
  }
  const population = exactJson(
    input.store,
    evidence.population_ref,
    "P04 selection population",
    validateScaP04SelectionPopulationV1
  );
  const convergence = exactJson(
    input.store,
    evidence.convergence_matrix_ref,
    "P04 convergence matrix",
    validateScaP04ConvergenceMatrixV1
  );
  const dossiers = evidence.specialist_dossier_refs.map((ref) =>
    exactJson(input.store, ref, "P04 specialist dossier", validateScaP04SpecialistDossierV1)
  );
  if (
    !hostP04Ref(input.transition_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-to-p05-transition",
      operation_id: "sca-p04-to-p05-transition",
      schema_id: SCA_P04_TO_P05_TRANSITION_V1_SCHEMA,
    }) ||
    !hostP04Ref(transition.accepted_cohort_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-accepted-cohort",
      operation_id: "sca-p04-accepted-cohort",
      schema_id: SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
    }) ||
    !hostP04Ref(evidence.population_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-selection-population",
      operation_id: "sca-p04-selection-population",
      schema_id: SCA_P04_POPULATION_V1_SCHEMA,
    }) ||
    !hostP04Ref(evidence.convergence_matrix_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-convergence-matrix",
      operation_id: "sca-p04-convergence-matrix",
      schema_id: SCA_P04_CONVERGENCE_MATRIX_V1_SCHEMA,
    }) ||
    !hostP04Ref(transition.selection_dossier_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-selection-dossier",
      operation_id: "sca-p04-selection-dossier",
      schema_id: SCA_P04_SELECTION_DOSSIER_V1_SCHEMA,
    }) ||
    !hostP04Ref(transition.omission_dossier_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-omission-dossier",
      operation_id: "sca-p04-omission-dossier",
      schema_id: SCA_P04_OMISSION_DOSSIER_V1_SCHEMA,
    }) ||
    !hostP04Ref(transition.coverage_dossier_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-coverage-dossier",
      operation_id: "sca-p04-coverage-dossier",
      schema_id: SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA,
    }) ||
    !hostP04Ref(transition.evidence_manifest_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-evidence-manifest",
      operation_id: "sca-p04-evidence-manifest",
      schema_id: SCA_P04_EVIDENCE_MANIFEST_V1_SCHEMA,
    }) ||
    !hostP04Ref(transition.successor_ledger_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-successor-obligation-ledger",
      operation_id: "sca-p04-successor-obligation-ledger",
      schema_id: SCA_P04_SUCCESSOR_LEDGER_V1_SCHEMA,
    }) ||
    !hostP04Ref(transition.gate_ref, {
      run_id: acceptedCohort.run_id,
      kind: "sca-p04-gate",
      operation_id: "sca-p04-gate",
      schema_id: SCA_P04_GATE_V1_SCHEMA,
    }) ||
    !same(gate.population_ref, evidence.population_ref) ||
    evidence.run_id !== acceptedCohort.run_id ||
    ledger.run_id !== acceptedCohort.run_id ||
    convergence.run_id !== acceptedCohort.run_id ||
    selection.run_id !== acceptedCohort.run_id ||
    omission.run_id !== acceptedCohort.run_id ||
    coverage.run_id !== acceptedCohort.run_id ||
    !same(evidence.accepted_cohort_ref, transition.accepted_cohort_ref) ||
    !same(evidence.selection_dossier_ref, transition.selection_dossier_ref) ||
    !same(evidence.omission_dossier_ref, transition.omission_dossier_ref) ||
    !same(evidence.coverage_dossier_ref, transition.coverage_dossier_ref) ||
    !same(convergence.population_ref, evidence.population_ref) ||
    !same(convergence.specialist_dossier_refs, evidence.specialist_dossier_refs) ||
    !same(selection.convergence_matrix_ref, evidence.convergence_matrix_ref) ||
    !same(omission.convergence_matrix_ref, evidence.convergence_matrix_ref) ||
    !same(coverage.population_ref, evidence.population_ref) ||
    !same(population.accepted_cohort_ref, evidence.accepted_cohort_ref) ||
    population.run_id !== acceptedCohort.run_id ||
    !same(population.source_snapshot_ref, acceptedCohort.refs.p01_source_snapshot_ref) ||
    population.source_snapshot_sha256 !== population.source_snapshot_ref.content_digest ||
    population.max_selected_items !== p04Admission.runtime_policy.max_selected_items ||
    dossiers.length !== 2 ||
    new Set(dossiers.map((dossier) => dossier.specialist_id)).size !== 2
  ) {
    fail("cross_cohort_substitution", "P04 evidence manifest/dossier closure is cross-spliced");
  }
  for (const dossier of dossiers) {
    const expectedAgent = dossier.specialist_id === SCA_P04_SCANNER_SPECIALIST ? "annie" : "echo";
    const expectedRole =
      dossier.specialist_id === SCA_P04_SCANNER_SPECIALIST
        ? "scanner_and_dependency_leads"
        : "underdetected_and_no_alert_surfaces";
    const dossierRef = evidence.specialist_dossier_refs.find(
      (ref) => ref.branch_id === dossier.specialist_id
    );
    if (
      dossierRef === undefined ||
      !hostP04Ref(dossierRef, {
        run_id: acceptedCohort.run_id,
        branch_id: dossier.specialist_id,
        kind: "sca-p04-specialist-dossier",
        operation_id: `sca-p04-${dossier.specialist_id}-dossier`,
        schema_id: SCA_P04_SPECIALIST_DOSSIER_V1_SCHEMA,
      }) ||
      !hostP04Ref(dossier.cognitive_payload_ref, {
        run_id: acceptedCohort.run_id,
        branch_id: dossier.specialist_id,
        kind: "sca-p04-cognitive-payload",
        operation_id: `sca-p04-${dossier.specialist_id}-payload`,
        schema_id: SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
      }) ||
      !hostP04Ref(dossier.disclosure_admission_ref, {
        run_id: acceptedCohort.run_id,
        branch_id: dossier.specialist_id,
        kind: "sca-p04-disclosure-admission",
        operation_id: `sca-p04-${dossier.specialist_id}-disclosure-admission`,
        schema_id: SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
      }) ||
      dossier.run_id !== acceptedCohort.run_id ||
      (dossier.specialist_id !== SCA_P04_SCANNER_SPECIALIST &&
        dossier.specialist_id !== SCA_P04_UNDERDETECTED_SPECIALIST) ||
      dossier.agent !== expectedAgent ||
      dossier.role !== expectedRole ||
      !evidence.specialist_output_refs.some((ref) => same(ref, dossier.source_output_ref)) ||
      !evidence.cognitive_payload_refs.some((ref) => same(ref, dossier.cognitive_payload_ref)) ||
      !evidence.disclosure_admission_refs.some((ref) =>
        same(ref, dossier.disclosure_admission_ref)
      ) ||
      !evidence.dispatch_guard_refs.some((ref) => same(ref, dossier.dispatch_guard_ref)) ||
      !evidence.model_execution_receipt_refs.some((ref) =>
        same(ref, dossier.model_execution_receipt_ref)
      )
    ) {
      fail("cross_cohort_substitution", "P04 specialist dossier category closure is inconsistent");
    }
    const payload = exactJson(
      input.store,
      dossier.cognitive_payload_ref,
      "P04 cognitive payload",
      validateScaP04CognitivePayloadV1
    );
    const disclosure = exactJson(
      input.store,
      dossier.disclosure_admission_ref,
      "P04 disclosure admission",
      validateScaP04DisclosureAdmissionV1
    );
    const guard = exactJson(
      input.store,
      dossier.dispatch_guard_ref,
      "P04 dispatch guard",
      validateModelDispatchGuardV1
    );
    const receiptWrapper = exactJson(
      input.store,
      dossier.model_execution_receipt_ref,
      "P04 model receipt",
      validateModelExecutionReceiptV1
    );
    const persistedText = exactBytes(
      input.store,
      dossier.source_output_ref,
      "P04 specialist output"
    ).toString("utf8");
    const result = parseScaP04PersistedSpecialistResult(persistedText);
    const receipt = receiptWrapper.execution_receipt;
    const expectedAssignedIds = population.items
      .filter((item) => item.assigned_specialists.includes(dossier.specialist_id))
      .map((item) => item.stable_id);
    const populationById = new Map(population.items.map((item) => [item.stable_id, item] as const));
    if (
      result.population_sha256 !== population.population_sha256 ||
      !same(result.assigned_item_ids, expectedAssignedIds)
    ) {
      fail("cross_cohort_substitution", "P04 specialist assignment/population binding drift");
    }
    for (const entry of result.results) {
      const item = populationById.get(entry.stable_id);
      if (
        item === undefined ||
        !item.assigned_specialists.includes(dossier.specialist_id) ||
        entry.evidence_refs.some(
          (ref) => !item.evidence_refs.some((admitted) => same(admitted, ref))
        )
      ) {
        fail("cross_cohort_substitution", "P04 result cites unassigned or non-admitted evidence");
      }
      for (const ref of entry.evidence_refs) {
        exactBytes(input.store, ref, "P04 result evidence");
      }
    }
    for (const discovery of result.discoveries) {
      const basis = populationById.get(discovery.basis_item_id);
      const expectedDiscoveryId = scaP04StableDiscoveryId({
        source_snapshot_sha256: population.source_snapshot_sha256,
        specialist_id: dossier.specialist_id,
        basis_item_id: discovery.basis_item_id,
        normalized_locator: discovery.normalized_locator,
        evidence_refs: discovery.evidence_refs,
      });
      if (
        basis === undefined ||
        !basis.assigned_specialists.includes(dossier.specialist_id) ||
        discovery.stable_id !== expectedDiscoveryId ||
        discovery.evidence_refs.some(
          (ref) => !basis.evidence_refs.some((admitted) => same(admitted, ref))
        )
      ) {
        fail("cross_cohort_substitution", "P04 discovery lacks exact assigned-basis provenance");
      }
      for (const ref of discovery.evidence_refs) {
        exactBytes(input.store, ref, "P04 discovery evidence");
      }
    }
    const expectedInputArtifacts = {
      schema_version: 2 as const,
      artifacts: [
        { slot: "cognitive_payload", ref: dossier.cognitive_payload_ref },
        { slot: "disclosure_admission", ref: dossier.disclosure_admission_ref },
      ],
    };
    if (
      !same(result, dossier.result) ||
      result.specialist_id !== dossier.specialist_id ||
      result.role !== dossier.role ||
      !same(result.assigned_item_ids, payload.assigned_item_ids) ||
      payload.run_id !== acceptedCohort.run_id ||
      payload.specialist_id !== dossier.specialist_id ||
      !same(payload.population_ref, evidence.population_ref) ||
      payload.population_sha256 !== population.population_sha256 ||
      !same(payload.source_snapshot_ref, population.source_snapshot_ref) ||
      !same(payload.required_model, SCA_P04_REQUIRED_MODEL) ||
      !same(
        payload.assigned_item_ids,
        payload.assigned_items.map((item) => item.stable_id)
      ) ||
      payload.assigned_items.some(
        (item) =>
          !population.items.some((candidate) => same(candidate, item)) ||
          !item.assigned_specialists.includes(dossier.specialist_id)
      ) ||
      disclosure.run_id !== acceptedCohort.run_id ||
      disclosure.call_id !== payload.call_id ||
      disclosure.specialist_id !== dossier.specialist_id ||
      disclosure.agent !== dossier.agent ||
      !same(disclosure.required_model, SCA_P04_REQUIRED_MODEL) ||
      !same(disclosure.model_data_policy_ref, acceptedCohort.refs.p01_model_data_policy_ref) ||
      disclosure.model_data_policy_sha256 !==
        acceptedCohort.refs.p01_model_data_policy_ref.content_digest ||
      !same(disclosure.payload_ref, dossier.cognitive_payload_ref) ||
      disclosure.payload_sha256 !== dossier.cognitive_payload_ref.content_digest ||
      disclosure.payload_byte_length !== dossier.cognitive_payload_ref.byte_length ||
      disclosure.destination !== "cloud" ||
      disclosure.training !== "prohibited" ||
      disclosure.decision !== "allow" ||
      disclosure.blocker_codes.length !== 0 ||
      dossier.dispatch_guard_ref.run_id !== acceptedCohort.run_id ||
      dossier.dispatch_guard_ref.phase !== "selecting_surfaces" ||
      dossier.dispatch_guard_ref.branch_id !== dossier.specialist_id ||
      dossier.dispatch_guard_ref.kind !== "model-dispatch-guard" ||
      dossier.dispatch_guard_ref.operation_id !== modelDispatchGuardOperationId(guard.coordinate) ||
      dossier.dispatch_guard_ref.version !== 1 ||
      dossier.dispatch_guard_ref.producer !== "host:required-model-runtime" ||
      dossier.dispatch_guard_ref.media_type !== "application/json" ||
      dossier.dispatch_guard_ref.content_schema?.schema_id !== MODEL_DISPATCH_GUARD_V1_SCHEMA ||
      dossier.dispatch_guard_ref.content_schema.schema_version !== 1 ||
      dossier.model_execution_receipt_ref.run_id !== acceptedCohort.run_id ||
      dossier.model_execution_receipt_ref.phase !== "selecting_surfaces" ||
      dossier.model_execution_receipt_ref.branch_id !== dossier.specialist_id ||
      dossier.model_execution_receipt_ref.kind !== "model-execution-receipt" ||
      dossier.model_execution_receipt_ref.operation_id !==
        modelExecutionReceiptOperationId(guard.coordinate) ||
      dossier.model_execution_receipt_ref.version !== 1 ||
      dossier.model_execution_receipt_ref.producer !== "host:required-model-runtime" ||
      dossier.model_execution_receipt_ref.media_type !== "application/json" ||
      dossier.model_execution_receipt_ref.content_schema?.schema_id !==
        MODEL_EXECUTION_RECEIPT_V1_SCHEMA ||
      dossier.model_execution_receipt_ref.content_schema.schema_version !== 1 ||
      guard.coordinate.run_id !== p04Request.run_id ||
      guard.coordinate.state_id !== "selecting_surfaces" ||
      guard.coordinate.branch_id !== dossier.specialist_id ||
      guard.coordinate.agent !== dossier.agent ||
      guard.coordinate.attempt !== 1 ||
      !same(guard.requested_model, SCA_P04_REQUIRED_MODEL) ||
      guard.provider_opening_guard !== SCA_P04_PROVIDER_OPENING_GUARD ||
      guard.input_artifacts_sha256 !== sha256(canonicalJson(expectedInputArtifacts)) ||
      !same(receiptWrapper.dispatch_guard_ref, dossier.dispatch_guard_ref) ||
      receipt.run_id !== p04Request.run_id ||
      receipt.state_id !== "selecting_surfaces" ||
      receipt.branch_id !== dossier.specialist_id ||
      receipt.agent !== dossier.agent ||
      receipt.attempt !== guard.coordinate.attempt ||
      !same(receipt.requested_model, SCA_P04_REQUIRED_MODEL) ||
      receipt.observed_model?.provider !== SCA_P04_REQUIRED_MODEL.provider ||
      receipt.observed_model.model !== SCA_P04_REQUIRED_MODEL.model ||
      !same(receipt.output_artifact_ref, dossier.source_output_ref) ||
      receipt.output_digest !== dossier.source_output_ref.content_digest ||
      dossier.source_output_ref.run_id !== acceptedCohort.run_id ||
      dossier.source_output_ref.phase !== "selecting_surfaces" ||
      dossier.source_output_ref.branch_id !== dossier.specialist_id ||
      dossier.source_output_ref.kind !== "sca-p04-specialist-output" ||
      dossier.source_output_ref.version !== 1 ||
      dossier.source_output_ref.producer !== `agent:${dossier.agent}` ||
      dossier.source_output_ref.operation_id !== `sca-p04-${dossier.specialist_id}-output` ||
      dossier.source_output_ref.media_type !== "text/plain" ||
      dossier.source_output_ref.content_schema?.schema_id !== "penny.persisted-summary-line.v1" ||
      dossier.source_output_ref.content_schema.schema_version !== 1
    ) {
      fail("cross_cohort_substitution", "P04 specialist model-evidence closure is inconsistent");
    }
  }
  type PartitionMetadata = {
    readonly origin: "initial_population" | "branch_discovery";
    readonly source_path: string | null;
    readonly package_coordinate: string | null;
    readonly evidence_refs: readonly ArtifactRef[];
    readonly specialist_ids: readonly string[];
    readonly alert_state: "scanner_alert" | "no_alert" | "context_only" | "not_applicable";
  };
  const partitionMetadata = new Map<string, PartitionMetadata>();
  const resultBySpecialist = new Map(
    dossiers.map((dossier) => [dossier.specialist_id, dossier.result] as const)
  );
  const converge = (
    recommendations: readonly Pick<
      ScaP04SpecialistResultItemV1,
      "recommendation" | "evidence_status" | "uncertainty_code" | "p05_question_codes"
    >[]
  ): "selected_for_p05" | "not_selected" | "deferred" | "blocked_evidence_gap" => {
    const gap = recommendations.some(
      (entry) =>
        entry.evidence_status === "evidence_gap" ||
        entry.uncertainty_code === "missing_required_evidence" ||
        entry.p05_question_codes.includes("resolve_evidence_gap")
    );
    if (gap || recommendations.some((entry) => entry.recommendation === "block")) {
      return "blocked_evidence_gap";
    }
    if (recommendations.some((entry) => entry.recommendation === "defer")) return "deferred";
    if (recommendations.some((entry) => entry.recommendation === "select")) {
      return "selected_for_p05";
    }
    return "not_selected";
  };
  const expectedRows: ScaP04ConvergenceRowV1[] = population.items.map((item) => {
    const recommendations = item.assigned_specialists
      .map((specialistId) => {
        const result = resultBySpecialist
          .get(specialistId)
          ?.results.find((entry) => entry.stable_id === item.stable_id);
        if (result === undefined) {
          fail(
            "cross_cohort_substitution",
            `P04 '${item.stable_id}' lacks exact specialist accounting`
          );
        }
        return {
          specialist_id: specialistId,
          recommendation: result.recommendation,
          reason_code: result.reason_code,
          evidence_status: result.evidence_status,
          uncertainty_code: result.uncertainty_code,
          p05_question_codes: result.p05_question_codes,
          evidence_refs: uniqueRefs(result.evidence_refs),
        };
      })
      .sort((left, right) => left.specialist_id.localeCompare(right.specialist_id));
    const finalDisposition = converge(recommendations);
    partitionMetadata.set(item.stable_id, {
      origin: "initial_population",
      source_path: item.source_path,
      package_coordinate: item.package_coordinate,
      evidence_refs: uniqueRefs(recommendations.flatMap((entry) => entry.evidence_refs)),
      specialist_ids: [...item.assigned_specialists].sort(),
      alert_state: item.alert_state,
    });
    return {
      stable_id: item.stable_id,
      origin: "initial_population" as const,
      recommendations: recommendations.map((entry) => ({
        specialist_id: entry.specialist_id,
        recommendation: entry.recommendation,
        reason_code: entry.reason_code,
        evidence_status: entry.evidence_status,
        evidence_refs: entry.evidence_refs,
      })),
      final_disposition: finalDisposition,
      host_reason_code:
        finalDisposition === "selected_for_p05"
          ? "selected_by_specialist"
          : finalDisposition === "blocked_evidence_gap"
            ? "evidence_gap_requires_resolution"
            : finalDisposition === "deferred"
              ? "deferred_by_specialist"
              : "not_selected_by_specialist",
    };
  });
  for (const dossier of dossiers) {
    for (const discovery of dossier.result.discoveries) {
      const recommendation = {
        specialist_id: dossier.specialist_id,
        recommendation: discovery.recommendation,
        reason_code: discovery.reason_code,
        evidence_status: "bounded_but_usable" as const,
        uncertainty_code: "bounded_metadata_only" as const,
        p05_question_codes: [],
        evidence_refs: uniqueRefs(discovery.evidence_refs),
      };
      const finalDisposition = converge([recommendation]);
      expectedRows.push({
        stable_id: discovery.stable_id,
        origin: "branch_discovery",
        recommendations: [
          {
            specialist_id: recommendation.specialist_id,
            recommendation: recommendation.recommendation,
            reason_code: recommendation.reason_code,
            evidence_status: recommendation.evidence_status,
            evidence_refs: recommendation.evidence_refs,
          },
        ],
        final_disposition: finalDisposition,
        host_reason_code:
          finalDisposition === "selected_for_p05"
            ? "selected_by_specialist"
            : finalDisposition === "blocked_evidence_gap"
              ? "evidence_gap_requires_resolution"
              : finalDisposition === "deferred"
                ? "deferred_by_specialist"
                : "not_selected_by_specialist",
      });
      partitionMetadata.set(discovery.stable_id, {
        origin: "branch_discovery",
        source_path: discovery.source_path,
        package_coordinate: discovery.package_coordinate,
        evidence_refs: uniqueRefs(discovery.evidence_refs),
        specialist_ids: [dossier.specialist_id],
        alert_state: "not_applicable",
      });
    }
  }
  expectedRows.sort((left, right) => left.stable_id.localeCompare(right.stable_id));
  if (
    new Set(expectedRows.map((row) => row.stable_id)).size !== expectedRows.length ||
    expectedRows.some(
      (row) =>
        row.final_disposition === "deferred" || row.final_disposition === "blocked_evidence_gap"
    ) ||
    dossiers.some((dossier) => dossier.result.branch_gap_codes.length > 0)
  ) {
    fail(
      "predecessor_not_accepted",
      "P04 reconstructed completion contains duplicate, deferred, blocked, or branch-gap work"
    );
  }
  const expectedSelected = expectedRows
    .filter((row) => row.final_disposition === "selected_for_p05")
    .map((row) => {
      const metadata = partitionMetadata.get(row.stable_id);
      if (metadata === undefined) fail("artifact_mismatch", "P04 selected metadata is absent");
      return {
        stable_id: row.stable_id,
        origin: metadata.origin,
        source_path: metadata.source_path,
        package_coordinate: metadata.package_coordinate,
        reason_code: row.host_reason_code,
        evidence_refs: metadata.evidence_refs,
      };
    });
  const expectedOmitted = expectedRows
    .filter((row) => row.final_disposition !== "selected_for_p05")
    .map((row) => {
      const metadata = partitionMetadata.get(row.stable_id);
      if (metadata === undefined) fail("artifact_mismatch", "P04 omitted metadata is absent");
      return {
        stable_id: row.stable_id,
        origin: metadata.origin,
        source_path: metadata.source_path,
        package_coordinate: metadata.package_coordinate,
        reason_code: row.host_reason_code,
        evidence_refs: metadata.evidence_refs,
        disposition: row.final_disposition,
        safe_claim: false as const,
      };
    });
  const expectedCoverage = expectedRows.map((row) => {
    const metadata = partitionMetadata.get(row.stable_id);
    if (metadata === undefined) fail("artifact_mismatch", "P04 coverage metadata is absent");
    return {
      stable_id: row.stable_id,
      origin: metadata.origin,
      specialist_ids: metadata.specialist_ids,
      status:
        row.final_disposition === "selected_for_p05"
          ? ("selected" as const)
          : row.final_disposition === "deferred"
            ? ("deferred" as const)
            : row.final_disposition === "blocked_evidence_gap"
              ? ("blocked" as const)
              : ("omitted" as const),
      alert_state: metadata.alert_state,
    };
  });
  if (expectedSelected.length === 0 || expectedSelected.length > population.max_selected_items) {
    fail("predecessor_not_accepted", "P04 reconstructed selected population violates policy");
  }
  const expectedDispositionIds = [
    "SCA-OBL-P04-ACCEPTANCE",
    "SCA-OBL-OUTPUT-P04-SPECIALIST-DOSSIERS",
    "SCA-OBL-OUTPUT-P04-SELECTION-DOSSIER",
    "SCA-OBL-OUTPUT-P04-OMISSION-DOSSIER",
    "SCA-OBL-OUTPUT-P04-COVERAGE-DOSSIER",
  ];
  const expectedDispositionRefs = [
    [evidence.accepted_cohort_ref, evidence.coverage_dossier_ref],
    [
      evidence.convergence_matrix_ref,
      ...[SCA_P04_SCANNER_SPECIALIST, SCA_P04_UNDERDETECTED_SPECIALIST].map((specialistId) => {
        const ref = evidence.specialist_dossier_refs.find(
          (candidate) => candidate.branch_id === specialistId
        );
        if (ref === undefined) {
          fail("artifact_mismatch", `P04 '${specialistId}' dossier ref is absent`);
        }
        return ref;
      }),
    ],
    [evidence.selection_dossier_ref],
    [evidence.omission_dossier_ref],
    [evidence.coverage_dossier_ref],
  ];
  if (
    !same(convergence.rows, expectedRows) ||
    !same(selection.selected, expectedSelected) ||
    selection.selected_count !== expectedSelected.length ||
    !same(omission.omitted, expectedOmitted) ||
    omission.omitted_count !== expectedOmitted.length ||
    !same(coverage.entries, expectedCoverage) ||
    !same(
      coverage.initial_population_ids,
      population.items.map((item) => item.stable_id)
    ) ||
    !same(
      coverage.final_accounted_ids,
      expectedRows.map((row) => row.stable_id)
    ) ||
    !same(ledger.prior_ledger_ref, acceptedCohort.refs.p03_successor_ledger_ref) ||
    ledger.prior_ledger_sha256 !== acceptedCohort.refs.p03_successor_ledger_ref.content_digest ||
    ledger.dispositions.some((entry, index) => {
      const expectedRefs = expectedDispositionRefs[index];
      return (
        expectedRefs === undefined ||
        entry.obligation_id !== expectedDispositionIds[index] ||
        entry.status !== "satisfied" ||
        !same(entry.evidence_refs, expectedRefs)
      );
    })
  ) {
    fail("cross_cohort_substitution", "P04 deterministic final partition closure is inconsistent");
  }
  const expectedAllRefs = uniqueRefs([
    evidence.accepted_cohort_ref,
    evidence.population_ref,
    ...evidence.cognitive_payload_refs,
    ...evidence.disclosure_admission_refs,
    ...evidence.dispatch_guard_refs,
    ...evidence.model_execution_receipt_refs,
    ...evidence.specialist_output_refs,
    ...evidence.specialist_dossier_refs,
    evidence.convergence_matrix_ref,
    evidence.selection_dossier_ref,
    evidence.omission_dossier_ref,
    evidence.coverage_dossier_ref,
    transition.successor_ledger_ref,
  ]);
  if (!same(evidence.all_refs, expectedAllRefs)) {
    fail(
      "cross_cohort_substitution",
      "P04 evidence manifest all_refs is not the exact category union"
    );
  }
  const selectedIds = selection.selected.map((entry) => entry.stable_id).sort();
  const omittedIds = omission.omitted.map((entry) => entry.stable_id).sort();
  const finalIds = coverage.final_accounted_ids;
  if (
    selection.selected_count !== selection.selected.length ||
    omission.omitted_count !== omission.omitted.length ||
    new Set([...selectedIds, ...omittedIds]).size !== finalIds.length ||
    !same([...selectedIds, ...omittedIds].sort(), finalIds) ||
    selectedIds.some((id) => omittedIds.includes(id))
  ) {
    fail("cross_cohort_substitution", "P04 selected/omitted/coverage partition is not exhaustive");
  }
  for (const ref of evidence.dispatch_guard_refs) {
    exactJson(input.store, ref, "P04 dispatch guard", validateModelDispatchGuardV1);
  }
  for (const ref of evidence.model_execution_receipt_refs) {
    exactJson(input.store, ref, "P04 model receipt", validateModelExecutionReceiptV1);
  }
  const exactRefs = [
    input.transition_ref,
    transition.p04_request_ref,
    transition.accepted_cohort_ref,
    transition.selection_dossier_ref,
    transition.omission_dossier_ref,
    transition.coverage_dossier_ref,
    transition.evidence_manifest_ref,
    transition.successor_ledger_ref,
    transition.gate_ref,
    ...evidence.all_refs,
  ];
  return {
    transition,
    accepted_cohort: acceptedCohort,
    selection_dossier: selection,
    omission_dossier: omission,
    coverage_dossier: coverage,
    evidence_manifest: evidence,
    successor_ledger: ledger,
    gate,
    p04_admission: p04Admission,
    exact_refs: [...new Map(exactRefs.map((ref) => [ref.artifact_id, ref])).values()].sort((a, b) =>
      a.artifact_id.localeCompare(b.artifact_id)
    ),
  };
}

export interface ScaP05AdmissionResultV1 {
  readonly request: ScaP05RequestV1;
  readonly implementation_identity: ScaP05ImplementationIdentityV1;
  readonly runtime_policy: ScaP05RuntimePolicyV1;
  readonly disclosure_scope: ScaP05DisclosureScopeV1;
  readonly predecessor: ScaP05AcceptedP04CohortV1;
  readonly selected_ids: readonly string[];
  readonly transitive_refs: readonly ArtifactRef[];
}

export function resolveScaP05EvidencePermissionValue(input: {
  readonly store: ArtifactHostStore;
  readonly admission: ScaP05AdmissionResultV1;
  readonly permission: ScaP05EvidencePermissionV1;
}): string | Record<string, unknown> | unknown[] {
  const selected = input.admission.predecessor.selection_dossier.selected.find(
    (entry) => entry.stable_id === input.permission.selected_item_id
  );
  if (selected === undefined) {
    fail("source_binding_mismatch", "P05 evidence permission has no selected P04 owner");
  }
  if (input.permission.atom_kind === "source_segment") {
    const segment = input.admission.disclosure_scope.source_segments.find(
      (entry) => `source-segment:${entry.segment_id}` === input.permission.selector
    );
    if (
      segment === undefined ||
      segment.selected_item_id !== input.permission.selected_item_id ||
      !same(segment.origin_ref, input.permission.origin_ref)
    ) {
      fail("source_binding_mismatch", "P05 source atom does not resolve to its exact segment");
    }
    return segment.visible_text_utf8;
  }
  if (input.permission.atom_kind === "p04_selection_record") {
    if (
      !same(
        input.permission.origin_ref,
        input.admission.predecessor.transition.selection_dossier_ref
      ) ||
      input.permission.selector !== `p04-selection:${selected.stable_id}`
    ) {
      fail("source_binding_mismatch", "P05 selection atom does not resolve to its exact P04 row");
    }
    return canonicalRecord(selected, "P05 selection record");
  }
  if (input.permission.atom_kind === "control_record") {
    if (
      input.permission.origin_ref.content_schema?.schema_id !== SCA_P05_CONTROL_RECORD_V1_SCHEMA
    ) {
      fail("source_binding_mismatch", "P05 control atom origin is not a typed control record");
    }
    const value = jsonEvidenceValue(
      input.store,
      input.permission.origin_ref,
      input.permission.selector,
      "P05 control record"
    );
    const control = validateScaP05ControlRecordV1(value);
    if (
      control.selected_item_id !== selected.stable_id ||
      control.source_snapshot_sha256 !==
        input.admission.predecessor.accepted_cohort.refs.p01_source_snapshot_ref.content_digest ||
      control.evidence_refs.some(
        (ref) => !selected.evidence_refs.some((admitted) => same(admitted, ref))
      )
    ) {
      fail(
        "source_binding_mismatch",
        "P05 control record is outside the selected item's evidence closure"
      );
    }
    for (const ref of control.evidence_refs) exactBytes(input.store, ref, "P05 control basis");
    return canonicalRecord(control, "P05 control record");
  }
  if (!selected.evidence_refs.some((ref) => same(ref, input.permission.origin_ref))) {
    fail(
      "source_binding_mismatch",
      "P05 structured evidence origin is outside its P04 item closure"
    );
  }
  const requiredSchema =
    input.permission.atom_kind === "p02_observation"
      ? SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA
      : SCA_P03_GRAPH_CANDIDATE_PACKET_V1_SCHEMA;
  if (input.permission.origin_ref.content_schema?.schema_id !== requiredSchema) {
    fail(
      "source_binding_mismatch",
      "P05 structured evidence origin schema does not match atom kind"
    );
  }
  return jsonEvidenceValue(
    input.store,
    input.permission.origin_ref,
    input.permission.selector,
    "P05 structured evidence origin"
  );
}

export function admitScaP05Candidate(input: {
  readonly store: ArtifactHostStore;
  readonly request: unknown;
  readonly input_artifacts: InputArtifacts;
  readonly trusted_clock: () => Date;
}): ScaP05AdmissionResultV1 {
  let request: ScaP05RequestV1;
  try {
    request = validateScaP05RequestV1(input.request);
  } catch (error) {
    fail("invalid_request", "P05 request validation failed", error);
  }
  assertExactInputs(input.input_artifacts, scaP05InputArtifacts(request));
  assertScaP05InputMetadata(request.implementation_identity_ref, {
    run_id: request.run_id,
    kind: "sca-p05-implementation-identity",
    operation_id: "sca-p05-implementation-identity",
    schema_id: SCA_P05_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  });
  assertScaP05InputMetadata(request.runtime_policy_ref, {
    run_id: request.run_id,
    kind: "sca-p05-runtime-policy",
    operation_id: "sca-p05-runtime-policy",
    schema_id: SCA_P05_RUNTIME_POLICY_V1_SCHEMA,
  });
  assertScaP05InputMetadata(request.disclosure_scope_ref, {
    run_id: request.run_id,
    kind: "sca-p05-disclosure-scope",
    operation_id: "sca-p05-disclosure-scope",
    schema_id: SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
  });
  const implementationIdentity = exactJson(
    input.store,
    request.implementation_identity_ref,
    "P05 implementation identity",
    validateScaP05ImplementationIdentityV1
  );
  const runtimePolicy = exactJson(
    input.store,
    request.runtime_policy_ref,
    "P05 runtime policy",
    validateScaP05RuntimePolicyV1
  );
  const disclosureScope = exactJson(
    input.store,
    request.disclosure_scope_ref,
    "P05 disclosure scope",
    validateScaP05DisclosureScopeV1
  );
  const predecessor = admitScaP04CompletedCohort({
    store: input.store,
    transition_ref: request.p04_transition_ref,
    trusted_clock: input.trusted_clock,
  });
  if (
    predecessor.transition.tenant_id !== request.tenant_id ||
    predecessor.transition.project_id !== request.project_id
  ) {
    fail("cross_cohort_substitution", "P05 request identity differs from P04 transition identity");
  }
  const selectedIds = predecessor.selection_dossier.selected.map((entry) => entry.stable_id).sort();
  if (selectedIds.length === 0) {
    fail("predecessor_not_accepted", "P05 requires at least one selected P04 surface");
  }
  if (selectedIds.length > runtimePolicy.max_selected_items) {
    fail("limit_exceeded", "P05 selected population exceeds admitted runtime limit");
  }
  const sourceSnapshotRef = predecessor.accepted_cohort.refs.p01_source_snapshot_ref;
  if (
    disclosureScope.run_id !== request.run_id ||
    disclosureScope.source_snapshot_sha256 !== sourceSnapshotRef.content_digest ||
    !same(disclosureScope.source_snapshot_ref, sourceSnapshotRef) ||
    disclosureScope.max_provider_calls !== runtimePolicy.max_provider_calls ||
    disclosureScope.max_payload_bytes_per_call > runtimePolicy.max_payload_bytes_per_call
  ) {
    fail("source_binding_mismatch", "P05 disclosure scope is not bound to runtime/source cohort");
  }
  const selectedSet = new Set(selectedIds);
  if (
    disclosureScope.source_segments.some((entry) => !selectedSet.has(entry.selected_item_id)) ||
    disclosureScope.evidence_permissions.some((entry) => !selectedSet.has(entry.selected_item_id))
  ) {
    fail("source_binding_mismatch", "P05 disclosure scope names an unselected P04 item");
  }
  for (const selectedId of selectedIds) {
    if (
      !disclosureScope.source_segments.some((entry) => entry.selected_item_id === selectedId) ||
      !disclosureScope.evidence_permissions.some(
        (entry) => entry.selected_item_id === selectedId && entry.atom_kind === "source_segment"
      )
    ) {
      fail(
        "source_binding_mismatch",
        `P05 selected item '${selectedId}' lacks source authorization`
      );
    }
  }
  if (disclosureScope.decision !== "allow") {
    fail("disclosure_scope_denied", "P05 disclosure scope is denied");
  }
  if (
    disclosureScope.evidence_permissions.length > runtimePolicy.max_evidence_atoms ||
    disclosureScope.source_segments.some(
      (entry) =>
        Buffer.byteLength(entry.visible_text_utf8, "utf8") > runtimePolicy.max_source_segment_bytes
    )
  ) {
    fail("limit_exceeded", "P05 disclosed evidence exceeds admitted atom or source-byte limits");
  }
  assertScaP05InputMetadata(disclosureScope.authority_ref, {
    run_id: request.run_id,
    kind: "sca-p05-disclosure-authority",
    operation_id: "sca-p05-disclosure-authority",
    schema_id: SCA_P05_DISCLOSURE_AUTHORITY_V1_SCHEMA,
  });
  const authority = exactJson(
    input.store,
    disclosureScope.authority_ref,
    "P05 disclosure authority",
    validateScaP05DisclosureAuthorityV1
  );
  if (
    authority.tenant_id !== request.tenant_id ||
    authority.project_id !== request.project_id ||
    authority.run_id !== request.run_id ||
    authority.source_snapshot_sha256 !== sourceSnapshotRef.content_digest ||
    !same(authority.required_model, disclosureScope.required_model) ||
    authority.destination_class !== disclosureScope.destination_class ||
    !same(authority.purposes, disclosureScope.purposes) ||
    authority.provider_retention_status !== disclosureScope.provider_retention_status ||
    authority.provider_retention_days !== disclosureScope.provider_retention_days ||
    authority.provider_logging_status !== disclosureScope.provider_logging_status ||
    authority.provider_logging_days !== disclosureScope.provider_logging_days ||
    authority.provider_training_use !== disclosureScope.provider_training_use ||
    authority.max_payload_bytes_per_call !== disclosureScope.max_payload_bytes_per_call ||
    authority.max_provider_calls !== disclosureScope.max_provider_calls
  ) {
    fail("disclosure_scope_denied", "P05 disclosure scope differs from typed authority");
  }
  const selectedById = new Map(
    predecessor.selection_dossier.selected.map((entry) => [entry.stable_id, entry])
  );
  const custodyRef = predecessor.accepted_cohort.refs.p01_source_custody_ref;
  for (const segment of disclosureScope.source_segments) {
    const selected = selectedById.get(segment.selected_item_id);
    const file = predecessor.p04_admission.source_custody.files.find(
      (entry) => entry.path === segment.source_path
    );
    if (
      selected === undefined ||
      !same(segment.origin_ref, custodyRef) ||
      (selected.source_path !== null && selected.source_path !== segment.source_path) ||
      file === undefined ||
      segment.transformation !== "verbatim" ||
      segment.redaction_ranges.length !== 0 ||
      segment.secrets_status !== "absent" ||
      segment.personal_data_status !== "absent"
    ) {
      fail(
        "source_binding_mismatch",
        "P05 source segment is not an exact unredacted custody slice"
      );
    }
    const fileBytes = Buffer.from(file.content_base64, "base64");
    if (fileBytes.byteLength !== file.byte_count || sha256(fileBytes) !== file.content_sha256) {
      fail("source_binding_mismatch", "P05 source custody file bytes do not match their identity");
    }
    let fileText: string;
    try {
      fileText = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
    } catch (error) {
      fail("source_binding_mismatch", "P05 source segment origin is not valid UTF-8", error);
    }
    if (
      extractVerbatimLines(fileText, segment.start_line, segment.end_line_exclusive) !==
      segment.visible_text_utf8
    ) {
      fail(
        "source_binding_mismatch",
        "P05 source segment text is not the declared frozen line range"
      );
    }
  }
  for (const ref of disclosureScope.evidence_permissions.map((entry) => entry.origin_ref)) {
    exactBytes(input.store, ref, "P05 evidence source");
  }
  const provisional: ScaP05AdmissionResultV1 = {
    request,
    implementation_identity: implementationIdentity,
    runtime_policy: runtimePolicy,
    disclosure_scope: disclosureScope,
    predecessor,
    selected_ids: selectedIds,
    transitive_refs: [],
  };
  for (const permission of disclosureScope.evidence_permissions) {
    const value = resolveScaP05EvidencePermissionValue({
      store: input.store,
      admission: provisional,
      permission,
    });
    if (permission.value_sha256 !== sha256(canonicalJson(value))) {
      fail(
        "source_binding_mismatch",
        `P05 evidence atom '${permission.atom_id}' value digest drift`
      );
    }
  }
  return {
    ...provisional,
    transitive_refs: [
      ...predecessor.exact_refs,
      request.implementation_identity_ref,
      request.runtime_policy_ref,
      request.disclosure_scope_ref,
      disclosureScope.authority_ref,
      ...disclosureScope.source_segments.map((entry) => entry.origin_ref),
      ...disclosureScope.evidence_permissions.map((entry) => entry.origin_ref),
    ],
  };
}

export function buildScaP05AcceptedCohort(input: {
  readonly admission: ScaP05AdmissionResultV1;
  readonly p05_request_ref: ArtifactRef;
  readonly admitted_at: string;
}): ScaP05AcceptedCohortV1 {
  const value = withSelfDigest(
    {
      schema_id: SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
      schema_version: 1 as const,
      phase_id: "SCA-P05" as const,
      run_id: input.admission.request.run_id,
      p05_request_ref: input.p05_request_ref,
      p04_transition_ref: input.admission.request.p04_transition_ref,
      p04_gate_ref: input.admission.predecessor.transition.gate_ref,
      p04_successor_ledger_ref: input.admission.predecessor.transition.successor_ledger_ref,
      p04_selection_dossier_ref: input.admission.predecessor.transition.selection_dossier_ref,
      source_snapshot_ref: input.admission.disclosure_scope.source_snapshot_ref,
      source_snapshot_sha256: input.admission.disclosure_scope.source_snapshot_sha256,
      selected_item_ids: [...input.admission.selected_ids],
      runtime_policy_ref: input.admission.request.runtime_policy_ref,
      disclosure_scope_ref: input.admission.request.disclosure_scope_ref,
      admitted_at: input.admitted_at,
    },
    "cohort_sha256"
  );
  return validateScaP05AcceptedCohortV1(value);
}

export function createScaP05Request(input: {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly p04_transition_ref: ArtifactRef;
  readonly implementation_identity_ref: ArtifactRef;
  readonly runtime_policy_ref: ArtifactRef;
  readonly disclosure_scope_ref: ArtifactRef;
  readonly requested_at: string;
}): ScaP05RequestV1 {
  return validateScaP05RequestV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_REQUEST_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: input.tenant_id,
        project_id: input.project_id,
        run_id: input.run_id,
        phase_id: "SCA-P05" as const,
        p04_transition_ref: input.p04_transition_ref,
        implementation_identity_ref: input.implementation_identity_ref,
        runtime_policy_ref: input.runtime_policy_ref,
        disclosure_scope_ref: input.disclosure_scope_ref,
        requested_at: input.requested_at,
      },
      "request_sha256"
    )
  );
}

void ScaP05AcceptedCohortV1Schema;
void SCA_P05_REQUEST_V1_SCHEMA;
