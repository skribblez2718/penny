import path from "node:path";

import type { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type {
  ArtifactRef,
  Directive,
  JsonValue,
  OutputArtifactMetadata,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { sealScaPhaseGateRecordV3 } from "../dist/sca/qualification-gate-contracts.js";
import {
  SCA_P11_TERMINAL_SCHEMA,
  validateScaP11TerminalV1,
  withP11Digest,
  type ScaP11CandidateStartV1,
} from "../dist/sca/p11-contracts.js";
import {
  SCA_P12_CANDIDATE_START_SCHEMA,
  SCA_P12_DIMENSIONS,
  SCA_P12_PHASE_GATE_INDEX_SCHEMA,
  SCA_P12_REQUIRED_MODEL,
  SCA_P12_RELEASE_AUTHORITY_SCHEMA,
  SCA_P12_VERIFICATION_SCOPE_SCHEMA,
  SCA_P12_VERIFIER_AUTHORITY_SCHEMA,
  validateScaP12CandidateStartV1,
  withP12Digest,
  type ScaP12CandidateStartV1,
} from "../dist/sca/p12-contracts.js";
import {
  SCA_P12_CANDIDATE_PLAYBOOK_NAME,
  ScaP12CandidatePlaybook,
  buildExpectedInputs,
  createScaP12VerificationRegistrationV1,
  scaP12AuthorityScopeSubject,
  type ScaP12CandidateBindingV1,
} from "../dist/sca/p12-playbook.js";
import { driveP11, prepareP11, type P11Harness } from "./sca-p11-harness.js";
import { persistScaP11FixtureQualification, stubScaP11ReviewOutput } from "./sca-p11-lineage.js";
import {
  SCA_P11_FIXTURE_CVSS_QUALIFICATION,
  buildScaP11CvssScorerFromQualification,
} from "../dist/sca/p11-scoring.js";
import {
  admitScaP12Release,
  type ScaP12AdmissionInputV1,
  type ScaP12AdmissionResultV1,
} from "../dist/sca/p12-admission.js";

const NOW = "2026-10-03T00:00:00.000Z";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

export const P12_PROJECT_ROOT = PROJECT_ROOT;

function save(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly phase: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly schema_id: string;
  readonly value: unknown;
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.run_id,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation_id,
    version: 1,
    producer: "host:sca-p12-lineage",
    media_type: "application/json",
    content_schema: { schema_id: input.schema_id, schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}

export type ScaP12LaneKindV1 =
  | "reporting_complete"
  | "reporting_incomplete"
  | "blocked_invalid"
  | "cancelled";

export interface ScaP12LineageV1 {
  readonly run_id: string;
  readonly p11_terminal_ref: ArtifactRef;
  readonly p11_report_ref: ArtifactRef | null;
  readonly p11_transition_ref: ArtifactRef | null;
  readonly p11_admission_ref: ArtifactRef | null;
  readonly p11_harness: P11Harness | null;
  readonly scope_ref: ArtifactRef;
  readonly verifier_authority_ref: ArtifactRef;
  readonly release_authority_ref: ArtifactRef;
  readonly phase_gate_index_ref: ArtifactRef;
  readonly constraints: ScaP12CandidateStartV1;
  readonly approved_payload: JsonValue;
  readonly rejected_payload: JsonValue;
  readonly subject_sha256: string;
}

function buildP11Terminal(
  store: ArtifactStore,
  runId: string,
  status: "blocked_invalid" | "cancelled"
): ArtifactRef {
  const terminal = validateScaP11TerminalV1(
    withP11Digest(
      {
        schema_id: SCA_P11_TERMINAL_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P11" as const,
        status,
        report_ref: null,
        reconciliation_ref: null,
        validation_records_ref: null,
        gate_ref: null,
        p12_transition_ref: null,
        p12_handoff_ready: false,
        report_status: null,
        missing_downstream_artifacts: ["penny.sca-p12-release-record.v1"],
        required_downstream_obligation_ids: ["SCA-OBL-P12-ACCEPTANCE"],
        selected_artifact_refs: [],
        blocker_codes: status === "blocked_invalid" ? ["p11_blocked_invalid"] : [],
        phase_gate_passed: false as const,
        release_eligible: false as const,
        campaign_complete: false as const,
        nonterminal_campaign: true as const,
        p12_release_authorized: false as const,
        release_adjudication_performed: false as const,
      },
      "terminal_sha256"
    )
  );
  return save({
    store,
    run_id: runId,
    phase: "SCA-P11",
    kind: "sca-p11-terminal",
    operation_id: `sca-p12-lineage-p11-terminal-${status}`,
    schema_id: SCA_P11_TERMINAL_SCHEMA,
    value: terminal,
  });
}

function buildPhaseGateIndex(store: ArtifactStore, runId: string, complete: boolean): ArtifactRef {
  const phases = [
    "SCA-P01",
    "SCA-P02",
    "SCA-P03",
    "SCA-P04",
    "SCA-P05",
    "SCA-P06",
    "SCA-P07",
    "SCA-P08",
    "SCA-P09",
    "SCA-P10",
    "SCA-P11",
  ];
  const entries = (complete ? phases : phases.slice(0, 1)).map((phase, index) => {
    const shared = save({
      store,
      run_id: runId,
      phase,
      kind: "sca-phase-gate-placeholder",
      operation_id: `sca-p12-lineage-gate-${phase}`,
      schema_id: SCA_P12_PHASE_GATE_INDEX_SCHEMA,
      value: { phase, index },
    });
    const gate = sealScaPhaseGateRecordV3({
      schema_id: "penny.sca-phase-gate-record.v3",
      schema_version: 3,
      tenant_id: "tenant",
      project_id: "project",
      run_id: runId,
      phase_id: phase,
      implementation_revision: "r1",
      implementation_assurance_scope: "host_derived_binding",
      implementation_identity_ref: shared,
      qualified_input_refs: [shared],
      qualification_ref: shared,
      reviewer_authority_ref: shared,
      reviewer_receipt_ref: shared,
      criterion_results: [{ criterion_id: `AC-${phase.replace(/^SCA-/, "")}`, status: "PASS" }],
      remaining_gaps: [],
      status: "passed",
      evaluated_at: NOW,
    });
    const gateRef = save({
      store,
      run_id: runId,
      phase,
      kind: "sca-phase-gate-record",
      operation_id: `sca-p12-lineage-gate-record-${phase}`,
      schema_id: "penny.sca-phase-gate-record.v3",
      value: gate,
    });
    return {
      phase_id: phase,
      criterion_id: `AC-${phase.replace(/^SCA-/, "")}`,
      gate_ref: gateRef,
    };
  });
  return save({
    store,
    run_id: runId,
    phase: "SCA-P12",
    kind: "sca-p12-phase-gate-index",
    operation_id: complete
      ? "sca-p12-lineage-phase-gate-index"
      : "sca-p12-lineage-incomplete-phase-gate-index",
    schema_id: SCA_P12_PHASE_GATE_INDEX_SCHEMA,
    value: withP12Digest(
      {
        schema_id: SCA_P12_PHASE_GATE_INDEX_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P12" as const,
        entries,
        entry_count: entries.length,
        closed: complete,
        issued_at: NOW,
      },
      "index_sha256"
    ),
  });
}

export function buildScaP12Lineage(input: {
  readonly store: ArtifactStore;
  readonly run_id: string;
  readonly lane: ScaP12LaneKindV1;
  /** False forces a non-positive fixture: an incomplete phase-gate index (no accepted predecessor). */
  readonly phaseGateComplete?: boolean;
}): ScaP12LineageV1 {
  const { store, run_id } = input;

  let p11TerminalRef: ArtifactRef;
  let p11ReportRef: ArtifactRef | null = null;
  let p11TransitionRef: ArtifactRef | null = null;
  let p11AdmissionRef: ArtifactRef | null = null;
  let p11Constraints: ScaP11CandidateStartV1 | null = null;
  let p11Harness: P11Harness | null = null;

  if (input.lane === "blocked_invalid" || input.lane === "cancelled") {
    p11TerminalRef = buildP11Terminal(store, run_id, input.lane);
  } else {
    const qualificationRef = persistScaP11FixtureQualification(store, run_id);
    const scorer = buildScaP11CvssScorerFromQualification({
      qualification: SCA_P11_FIXTURE_CVSS_QUALIFICATION,
      qualification_ref: qualificationRef,
    });
    p11Harness = prepareP11({
      store,
      runId: run_id,
      reportPolicyComplete: input.lane === "reporting_complete",
      binding: { scorer },
      p10Status: input.lane === "reporting_complete" ? "learning_complete" : "learning_incomplete",
    });
    driveP11({
      harness: p11Harness,
      review: (context) =>
        stubScaP11ReviewOutput({
          run_id,
          report_ref: context.reportRef,
          payload: { ...context.payload, revision: context.revision },
        }),
    });
    p11TerminalRef = required(
      [...p11Harness.run.selectedArtifacts]
        .reverse()
        .find((ref) => ref.kind === "sca-p11-terminal"),
      "P11 terminal ref"
    );
    p11ReportRef = required(
      [...p11Harness.run.selectedArtifacts].reverse().find((ref) => ref.kind === "sca-p11-report"),
      "P11 report projection ref"
    );
    p11TransitionRef = required(
      [...p11Harness.run.selectedArtifacts]
        .reverse()
        .find((ref) => ref.kind === "sca-p11-to-p12-transition"),
      "P11 transition ref"
    );
    p11AdmissionRef = required(
      [...p11Harness.run.selectedArtifacts]
        .reverse()
        .find((ref) => ref.kind === "sca-p11-admission"),
      "P11 admission ref"
    );
    p11Constraints = p11Harness.lineage.constraints;
  }

  const subject = scaP12AuthorityScopeSubject({
    p11_terminal_ref: p11TerminalRef,
    p11_report_ref: p11ReportRef ?? p11TerminalRef,
  });

  const scopeRef = save({
    store,
    run_id,
    phase: "SCA-P12",
    kind: "sca-p12-verification-scope",
    operation_id: "sca-p12-lineage-verification-scope",
    schema_id: SCA_P12_VERIFICATION_SCOPE_SCHEMA,
    value: withP12Digest(
      {
        schema_id: SCA_P12_VERIFICATION_SCOPE_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P12" as const,
        run_id,
        dimensions: [...SCA_P12_DIMENSIONS].sort().map((dimension_id) => ({
          dimension_id,
          assertion_allowlist: [`p12_assertion_${dimension_id}`],
          evidence_allowlist: [p11TerminalRef],
        })),
        spot_check: { threshold: 4, sample_size: 4 },
        issued_at: NOW,
      },
      "scope_sha256"
    ),
  });
  const verifierAuthorityRef = save({
    store,
    run_id,
    phase: "SCA-P12",
    kind: "sca-p12-verifier-authority",
    operation_id: "sca-p12-lineage-verifier-authority",
    schema_id: SCA_P12_VERIFIER_AUTHORITY_SCHEMA,
    value: withP12Digest(
      {
        schema_id: SCA_P12_VERIFIER_AUTHORITY_SCHEMA,
        schema_version: 1 as const,
        authority_id: "p12-verifier-authority",
        run_id,
        phase_id: "SCA-P12" as const,
        verifier_identity_id: "p12-verifier-identity",
        verifier_lineage_id: "p12-verifier-lineage",
        excluded_identity_ids: ["p11-implementer-identity", "p11-report-producer-identity"],
        excluded_lineage_ids: ["host:sca-p11-candidate", "vera"],
        required_model: SCA_P12_REQUIRED_MODEL,
        allowed_tools: [] as const,
        external_mutations: "forbidden" as const,
        filesystem_writes: "host_policy_only" as const,
        allowed_relative_paths: [] as const,
        subject_sha256: subject,
        evidence_refs: [p11TerminalRef],
        decision: "authorized" as const,
        issued_at: NOW,
      },
      "authority_sha256"
    ),
  });
  const releaseAuthorityRef = save({
    store,
    run_id,
    phase: "SCA-P12",
    kind: "sca-p12-release-authority",
    operation_id: "sca-p12-lineage-release-authority",
    schema_id: SCA_P12_RELEASE_AUTHORITY_SCHEMA,
    value: withP12Digest(
      {
        schema_id: SCA_P12_RELEASE_AUTHORITY_SCHEMA,
        schema_version: 1 as const,
        authority_id: "p12-release-authority",
        run_id,
        phase_id: "SCA-P12" as const,
        release_authority_identity_id: "p12-release-identity",
        release_authority_lineage_id: "p12-release-lineage",
        publication_authority: "separate_unmet" as const,
        decision: "authorized" as const,
        subject_sha256: subject,
        evidence_refs: [p11TerminalRef],
        issued_at: NOW,
      },
      "authority_sha256"
    ),
  });
  const phaseGateIndexRef = buildPhaseGateIndex(store, run_id, input.phaseGateComplete ?? true);

  const constraints = validateScaP12CandidateStartV1(
    buildConstraints({
      run_id,
      p11TerminalRef,
      p11ReportRef,
      p11TransitionRef,
      p11AdmissionRef,
      p11Constraints,
      scopeRef,
      verifierAuthorityRef,
      releaseAuthorityRef,
    })
  );

  return {
    run_id,
    p11_terminal_ref: p11TerminalRef,
    p11_report_ref: p11ReportRef,
    p11_transition_ref: p11TransitionRef,
    p11_admission_ref: p11AdmissionRef,
    p11_harness: p11Harness,
    scope_ref: scopeRef,
    verifier_authority_ref: verifierAuthorityRef,
    release_authority_ref: releaseAuthorityRef,
    phase_gate_index_ref: phaseGateIndexRef,
    constraints,
    approved_payload: {
      schema_version: 1,
      action: "release_decision",
      run_id,
      decision: "approved",
      human_principal_id: "p12-human-approver",
      authority_receipt_sha256: "f".repeat(64),
      decided_at: "2026-10-03T00:00:00.000Z",
      expires_at: "2026-12-31T00:00:00.000Z",
    },
    rejected_payload: {
      schema_version: 1,
      action: "release_decision",
      run_id,
      decision: "rejected",
      human_principal_id: "p12-human-approver",
      authority_receipt_sha256: "f".repeat(64),
      decided_at: "2026-10-03T00:00:00.000Z",
      expires_at: "2026-12-31T00:00:00.000Z",
    },
    subject_sha256: subject,
  };
}

function buildConstraints(input: {
  readonly run_id: string;
  readonly p11TerminalRef: ArtifactRef;
  readonly p11ReportRef: ArtifactRef | null;
  readonly p11TransitionRef: ArtifactRef | null;
  readonly p11AdmissionRef: ArtifactRef | null;
  readonly p11Constraints: ScaP11CandidateStartV1 | null;
  readonly scopeRef: ArtifactRef;
  readonly verifierAuthorityRef: ArtifactRef;
  readonly releaseAuthorityRef: ArtifactRef;
}): ScaP12CandidateStartV1 {
  const filler = input.p11TerminalRef;
  const p11 = input.p11Constraints;
  const fill = (ref: ArtifactRef | null | undefined): ArtifactRef => ref ?? filler;
  return {
    schema_id: SCA_P12_CANDIDATE_START_SCHEMA,
    schema_version: 1,
    phase_id: "SCA-P12",
    run_id: input.run_id,
    p11_terminal_ref: input.p11TerminalRef,
    p11_transition_ref: input.p11TransitionRef,
    p11_admission_ref: input.p11AdmissionRef,
    p10_terminal_ref: fill(p11?.p10_terminal_ref),
    p10_transition_ref: p11?.p10_transition_ref ?? null,
    p10_outcome_ref: p11?.p10_outcome_ref ?? null,
    p10_gate_ref: p11?.p10_gate_ref ?? null,
    p10_admission_ref: p11?.p10_admission_ref ?? null,
    p10_eligibility_ledger_ref: p11?.p10_eligibility_ledger_ref ?? null,
    p10_candidate_registry_ref: p11?.p10_candidate_registry_ref ?? null,
    p09_terminal_ref: fill(p11?.p09_terminal_ref),
    p09_transition_ref: p11?.p09_transition_ref ?? null,
    p09_reconciliation_ledger_ref: p11?.p09_reconciliation_ledger_ref ?? null,
    p09_gate_ref: p11?.p09_gate_ref ?? null,
    p09_admission_ref: p11?.p09_admission_ref ?? null,
    p08_terminal_ref: fill(p11?.p08_terminal_ref),
    p08_transition_ref: p11?.p08_transition_ref ?? null,
    p08_evidence_ledger_ref: p11?.p08_evidence_ledger_ref ?? null,
    p08_gate_ref: p11?.p08_gate_ref ?? null,
    p08_admission_ref: p11?.p08_admission_ref ?? null,
    p08_item_universe_ref: p11?.p08_item_universe_ref ?? null,
    p01_obligation_ledger_ref: fill(p11?.p01_obligation_ledger_ref),
    baseline_evidence_ref: fill(p11?.baseline_evidence_ref),
    p10_disclosure_scope_ref: fill(p11?.p10_disclosure_scope_ref),
    promotion_authority_ref: fill(p11?.promotion_authority_ref),
    active_run_rule_release_refs: [...(p11?.active_run_rule_release_refs ?? [])],
    p09_coverage_input_ref: p11?.p09_coverage_input_ref ?? null,
    p09_phase_evidence_refs: [...(p11?.p09_phase_evidence_refs ?? [])],
    p09_obligation_resolution_ref: p11?.p09_obligation_resolution_ref ?? null,
    p09_reassessment_ref: p11?.p09_reassessment_ref ?? null,
    p10_reassessment_ref: p11?.p10_reassessment_ref ?? null,
    p10_prior_ledger_ref: p11?.p10_prior_ledger_ref ?? null,
    p11_disclosure_scope_ref: fill(p11?.p11_disclosure_scope_ref),
    p11_repair_disclosure_scope_ref: p11?.p11_repair_disclosure_scope_ref ?? null,
    scoring_policy_ref: fill(p11?.scoring_policy_ref),
    report_policy_ref: fill(p11?.report_policy_ref),
    verification_scope_ref: input.scopeRef,
    verifier_authority_ref: input.verifierAuthorityRef,
    release_authority_ref: input.releaseAuthorityRef,
    p12_reassessment_ref: null,
    p12_prior_release_ref: null,
  };
}

export function buildProductionBinding(lineage: ScaP12LineageV1): ScaP12CandidateBindingV1 {
  return {
    resolve_current_verifier_authority_ref: () => lineage.verifier_authority_ref,
    resolve_current_release_authority_ref: () => lineage.release_authority_ref,
    resolve_current_phase_gate_index_ref: () => lineage.phase_gate_index_ref,
  };
}

export interface P12HarnessV1 {
  readonly run: RunContext;
  readonly playbook: ScaP12CandidatePlaybook;
  readonly registration: ReturnType<typeof createScaP12VerificationRegistrationV1>;
  readonly lineage: ScaP12LineageV1;
}

export function prepareP12(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly lineage: ScaP12LineageV1;
  readonly binding?: ScaP12CandidateBindingV1;
  readonly constraints?: ScaP12CandidateStartV1;
}): P12HarnessV1 {
  const binding = input.binding ?? buildProductionBinding(input.lineage);
  const registration = createScaP12VerificationRegistrationV1({
    resolve_current_verifier_authority_ref:
      binding.resolve_current_verifier_authority_ref ?? missingResolver,
    resolve_current_release_authority_ref:
      binding.resolve_current_release_authority_ref ?? missingResolver,
    resolve_current_phase_gate_index_ref:
      binding.resolve_current_phase_gate_index_ref ?? missingResolver,
  });
  const constraints = input.constraints ?? input.lineage.constraints;
  const startAdmission = required(registration.start_admission, "P12 start admission");
  const prepared = startAdmission.prepare(
    {
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: input.runId,
        session_id: `session-${input.runId}`,
        playbook: SCA_P12_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      goal: "Exercise the inactive P12 release-verification candidate.",
      constraints,
      project_root: P12_PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
      input_artifacts: { schema_version: 2, artifacts: buildExpectedInputs(constraints) },
    },
    {}
  );
  const refs = startAdmission.materialize(prepared, {
    run_id: input.runId,
    artifactStore: input.store,
    trustedClock: () => new Date(NOW),
  });
  const run = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: `session-${input.runId}`,
      playbook: SCA_P12_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise the inactive P12 release-verification candidate.",
    constraints: {},
    projectRoot: P12_PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 64,
    initialArtifacts: refs,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: SCA_P12_CANDIDATE_PLAYBOOK_NAME,
      contract_sha256: "b".repeat(64),
      registration_sha256: "a".repeat(64),
    },
  });
  const playbook = new ScaP12CandidatePlaybook(input.store, binding, () => new Date(NOW));
  return { run, playbook, registration, lineage: input.lineage };
}

function missingResolver(): never {
  throw new Error("SCA P12 test binding is missing a required current-authority resolver");
}

export function asTerminalDirective(
  directive: Directive
): Extract<Directive, { result: Record<string, JsonValue> }> {
  if (directive.action !== "incomplete" && directive.action !== "cancelled") {
    throw new Error(`expected a P12 terminal directive, received '${directive.action}'`);
  }
  return directive;
}

export function buildFixtureRegistration(): ReturnType<
  typeof createScaP12VerificationRegistrationV1
> {
  return createScaP12VerificationRegistrationV1({
    resolve_current_verifier_authority_ref: missingResolver,
    resolve_current_release_authority_ref: missingResolver,
    resolve_current_phase_gate_index_ref: missingResolver,
  });
}

/** Exact-read P12 admission over one lineage, mirroring the playbook's own binding. */
export function scaP12AdmissionInputFor(
  store: ArtifactStore,
  lineage: ScaP12LineageV1
): ScaP12AdmissionInputV1 {
  const c = lineage.constraints;
  return {
    store,
    run_id: lineage.run_id,
    p11_terminal_ref: c.p11_terminal_ref,
    p11_transition_ref: c.p11_transition_ref,
    p11_admission_ref: c.p11_admission_ref,
    verification_scope_ref: c.verification_scope_ref,
    verifier_authority_ref: c.verifier_authority_ref,
    release_authority_ref: c.release_authority_ref,
    p10_terminal_ref: c.p10_terminal_ref,
    p10_transition_ref: c.p10_transition_ref,
    p10_outcome_ref: c.p10_outcome_ref,
    p10_gate_ref: c.p10_gate_ref,
    p10_admission_ref: c.p10_admission_ref,
    p10_eligibility_ledger_ref: c.p10_eligibility_ledger_ref,
    p10_candidate_registry_ref: c.p10_candidate_registry_ref,
    p09_terminal_ref: c.p09_terminal_ref,
    p09_transition_ref: c.p09_transition_ref,
    p09_reconciliation_ledger_ref: c.p09_reconciliation_ledger_ref,
    p09_gate_ref: c.p09_gate_ref,
    p09_admission_ref: c.p09_admission_ref,
    p08_terminal_ref: c.p08_terminal_ref,
    p08_transition_ref: c.p08_transition_ref,
    p08_evidence_ledger_ref: c.p08_evidence_ledger_ref,
    p08_gate_ref: c.p08_gate_ref,
    p08_admission_ref: c.p08_admission_ref,
    p08_item_universe_ref: c.p08_item_universe_ref,
    p01_obligation_ledger_ref: c.p01_obligation_ledger_ref,
    baseline_evidence_ref: c.baseline_evidence_ref,
    p10_disclosure_scope_ref: c.p10_disclosure_scope_ref,
    promotion_authority_ref: c.promotion_authority_ref,
    active_run_rule_release_refs: c.active_run_rule_release_refs,
    p09_coverage_input_ref: c.p09_coverage_input_ref,
    p09_phase_evidence_refs: c.p09_phase_evidence_refs,
    p09_obligation_resolution_ref: c.p09_obligation_resolution_ref,
    p09_reassessment_ref: c.p09_reassessment_ref,
    p10_reassessment_ref: c.p10_reassessment_ref,
    p10_prior_ledger_ref: c.p10_prior_ledger_ref,
    p11_disclosure_scope_ref: c.p11_disclosure_scope_ref,
    p11_repair_disclosure_scope_ref: c.p11_repair_disclosure_scope_ref,
    scoring_policy_ref: c.scoring_policy_ref,
    report_policy_ref: c.report_policy_ref,
  };
}

/** Exact-read P12 admission over one lineage, mirroring the playbook's own binding. */
export function admitLineage(
  store: ArtifactStore,
  lineage: ScaP12LineageV1
): ScaP12AdmissionResultV1 {
  return admitScaP12Release(scaP12AdmissionInputFor(store, lineage));
}
