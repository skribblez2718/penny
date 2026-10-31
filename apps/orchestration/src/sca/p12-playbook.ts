import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  validateDirective,
  type ArtifactRef,
  type Directive,
  type InputArtifacts,
  type OutputArtifactMetadata,
  type SkillContract,
  type StartRequest,
  type RunIdentity,
  type JsonValue,
} from "../contracts.js";
import type { RunContext } from "../context.js";
import { ordinaryLivenessPolicy } from "../liveness.js";
import type { Playbook } from "../playbooks/playbook.js";
import type {
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import { admitScaP12Release, type ScaP12AdmissionResultV1 } from "./p12-admission.js";
import {
  SCA_P12_ADMISSION_SCHEMA,
  SCA_P12_ADMITTING_STATE,
  SCA_P12_AWAITING_RELEASE_APPROVAL_STATE,
  SCA_P12_CANCELLED_STATE,
  SCA_P12_CANDIDATE_PLAYBOOK_NAME,
  SCA_P12_CANDIDATE_START_SCHEMA,
  SCA_P12_CHECKPOINT_SCHEMA,
  SCA_P12_FINALIZING_STATE,
  SCA_P12_GATE_SCHEMA,
  SCA_P12_RELEASE_APPROVAL_SCHEMA,
  SCA_P12_RELEASE_RECORD_SCHEMA,
  SCA_P12_REPLAYING_STATE,
  SCA_P12_REPLAY_EVIDENCE_SCHEMA,
  SCA_P12_REQUIRED_MODEL,
  SCA_P12_TERMINAL_SCHEMA,
  SCA_P12_VERIFYING_STATE,
  SCA_P12_VERIFIER_AUTHORITY_SCHEMA,
  SCA_P12_VERIFIER_VERDICTS_SCHEMA,
  validateScaP12GateV1,
  validateScaP12ObligationLedgerV1,
  validateScaP12CheckpointV1,
  validateScaP12PhaseGateIndexV1,
  validateScaP12ReleaseApprovalV1,
  validateScaP12ReleaseAuthorityV1,
  validateScaP12TerminalV1,
  validateScaP12VerificationScopeV1,
  validateScaP12VerifierAuthorityV1,
  validateScaP12VerifierVerdictsV1,
  withP12Digest,
  type ScaP12GateV1,
  type ScaP12ReleaseAuthorityV1,
  type ScaP12TerminalV1,
  type ScaP12VerificationScopeV1,
  type ScaP12VerifierAuthorityV1,
} from "./p12-contracts.js";
import {
  buildScaP12GateV1,
  buildScaP12ObligationLedgerV1,
  buildScaP12ReleaseRecordV1,
  buildScaP12TerminalV1,
  evaluateScaP12PhaseGateIndexV1,
  scaP12IncompleteMarker,
  scaP12MissingDownstreamArtifacts,
  scaP12DownstreamObligationIds,
  validateScaP12ResumePayloadV1,
  type ScaP12GateFactsV1,
  type ScaP12PhaseGateDerivedExclusionsV1,
  type ScaP12PhaseGateEvaluationV1,
} from "./p12-release.js";
import {
  deriveScaP12ApproverSeparation,
  evaluateScaP12ReleaseApprovalV1,
  sealScaP12ReleaseApprovalV1,
} from "./p12-approval.js";
import {
  buildScaP12ReplayEvidenceV1,
  buildScaP12VerifierVerdictsV1,
  checkScaP12Independence,
  deriveScaP12IndependenceExclusionsV1,
  evaluateScaP12VerifierVerdictsV1,
  type ScaP12IndependenceResultV1,
  type ScaP12ReplayResultV1,
} from "./p12-verification.js";
import type { ScaPhaseQualificationDefinitionV1 } from "./qualification-gate.js";
import { OpaqueIdSchema } from "../skill-contracts/common.js";

export {
  SCA_P12_CANDIDATE_PLAYBOOK_NAME,
  SCA_P12_ADMITTING_STATE,
  SCA_P12_VERIFYING_STATE,
  SCA_P12_REPLAYING_STATE,
  SCA_P12_AWAITING_RELEASE_APPROVAL_STATE,
  SCA_P12_FINALIZING_STATE,
  SCA_P12_CANCELLED_STATE,
} from "./p12-contracts.js";

const PRODUCER = "host:sca-p12-candidate" as const;
const REQUEST_KIND = "sca-p12-candidate-request" as const;
const ADMISSION_KIND = "sca-p12-admission" as const;
const REPLAY_KIND = "sca-p12-replay-evidence" as const;
const VERDICTS_KIND = "sca-p12-verifier-verdicts" as const;
const CHECKPOINT_KIND = "sca-p12-checkpoint" as const;
const OBLIGATION_KIND = "sca-p12-obligation-ledger" as const;
const APPROVAL_KIND = "sca-p12-release-approval" as const;
const DRAFT_KIND = "sca-p12-release-record-draft" as const;
const RECORD_KIND = "sca-p12-release-record" as const;
const GATE_KIND = "sca-p12-gate" as const;
const TERMINAL_KIND = "sca-p12-terminal" as const;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
function latestSelected(
  context: RunContext,
  predicate: (ref: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts].reverse().find(predicate);
}
function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) {
    throw new Error(`P12 ${label} exact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P12 ${label} exact bytes drifted`);
  }
  return bytes;
}
function exactJson<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string,
  validate: (value: unknown) => T
): T {
  const text = exactBytes(store, ref, label).toString("utf8");
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`P12 ${label} is not canonical JSON`);
  return validate(value);
}

function persistJson(input: {
  readonly store: ArtifactHostStore;
  readonly context?: RunContext;
  readonly runId: string;
  readonly phase: string;
  readonly kind: string;
  readonly operationId: string;
  readonly schemaId: string;
  readonly value: unknown;
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly select?: boolean;
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const select = input.select ?? true;
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
      throw new Error(`P12 artifact '${input.operationId}' conflicts with immutable prior bytes`);
    }
    if (select) input.store.select(prior);
    const context = input.context;
    if (
      context !== undefined &&
      !context.selectedArtifacts.some((ref) => ref.artifact_id === prior.artifact_id)
    ) {
      context.selectedArtifacts.push(prior);
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
    producer: PRODUCER,
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    parent_ref: null,
    upstream_refs: uniqueRefs(input.upstreamRefs),
  };
  const ref = input.store.persist({ metadata, content });
  if (select) input.store.select(ref);
  const context = input.context;
  if (
    context !== undefined &&
    !context.selectedArtifacts.some((candidate) => candidate.artifact_id === ref.artifact_id)
  ) {
    context.selectedArtifacts.push(ref);
  }
  return ref;
}

/** Host-injected current-authority scope (A2/A5). The host owns the resolver, never the caller. */
export interface ScaP12CurrentAuthorityScopeV1 {
  readonly run_id: string;
  readonly phase_id: "SCA-P12";
  readonly subject_sha256: string;
}

/** The exact verification subject digest the verifier and release authorities must bind. */
export function scaP12AuthorityScopeSubject(input: {
  readonly p11_terminal_ref: ArtifactRef;
  readonly p11_report_ref: ArtifactRef;
}): string {
  return sha256(canonicalJson({ terminal: input.p11_terminal_ref, report: input.p11_report_ref }));
}

export interface ScaP12CandidateBindingV1 {
  /** Independent host resolver of the current admitted verifier authority (A2). */
  readonly resolve_current_verifier_authority_ref?: (
    scope: ScaP12CurrentAuthorityScopeV1
  ) => ArtifactRef;
  /** Independent host resolver of the current P12 release authority (A2/A7). */
  readonly resolve_current_release_authority_ref?: (
    scope: ScaP12CurrentAuthorityScopeV1
  ) => ArtifactRef;
  /** Independent host resolver of the current accepted AC-P01..AC-P11 phase-gate index (A5). */
  readonly resolve_current_phase_gate_index_ref?: (
    scope: ScaP12CurrentAuthorityScopeV1
  ) => ArtifactRef;
  /**
   * Host-owned qualification definition for one phase, used to fully re-verify its AC-Pnn gate with
   * `verifyScaPhaseGateV3` (qualification re-derivation + reviewer policy + custody). It is trusted
   * in-process policy, never parsed from the gate. Absence makes the gate unverifiable (fail closed).
   */
  readonly resolve_phase_gate_qualification?: (
    phase_id: string
  ) => ScaPhaseQualificationDefinitionV1 | null;
}

const ScaP12StartConstraintsV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P12_CANDIDATE_START_SCHEMA),
    schema_version: Type.Literal(1),
    phase_id: Type.Literal("SCA-P12"),
    run_id: OpaqueIdSchema,
    p11_terminal_ref: ArtifactRefSchema,
    p11_transition_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p11_admission_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p10_terminal_ref: ArtifactRefSchema,
    p10_transition_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p10_outcome_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p10_gate_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p10_admission_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p10_eligibility_ledger_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p10_candidate_registry_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p09_terminal_ref: ArtifactRefSchema,
    p09_transition_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p09_reconciliation_ledger_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p09_gate_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p09_admission_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p08_terminal_ref: ArtifactRefSchema,
    p08_transition_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p08_evidence_ledger_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p08_gate_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p08_admission_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p08_item_universe_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p01_obligation_ledger_ref: ArtifactRefSchema,
    baseline_evidence_ref: ArtifactRefSchema,
    p10_disclosure_scope_ref: ArtifactRefSchema,
    promotion_authority_ref: ArtifactRefSchema,
    active_run_rule_release_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    p09_coverage_input_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p09_phase_evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 256 }),
    p09_obligation_resolution_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p09_reassessment_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p10_reassessment_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p10_prior_ledger_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p11_disclosure_scope_ref: ArtifactRefSchema,
    p11_repair_disclosure_scope_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    scoring_policy_ref: ArtifactRefSchema,
    report_policy_ref: ArtifactRefSchema,
    verification_scope_ref: ArtifactRefSchema,
    verifier_authority_ref: ArtifactRefSchema,
    release_authority_ref: ArtifactRefSchema,
    p12_reassessment_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p12_prior_release_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
  },
  { additionalProperties: false, $id: SCA_P12_CANDIDATE_START_SCHEMA }
);
type ScaP12StartConstraintsV1 = Readonly<Static<typeof ScaP12StartConstraintsV1Schema>>;

const P12DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    verification_scope_ref: ArtifactRefSchema,
    verifier_authority_ref: ArtifactRefSchema,
    release_authority_ref: ArtifactRefSchema,
    phase_gate_index_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    replay_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    verdicts_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    obligation_ledger_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    draft_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    gate_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
type P12Data = Readonly<Static<typeof P12DataSchema>>;
function data(context: RunContext): P12Data {
  return validateContract(P12DataSchema, context.playbookData, "SCA P12 durable state");
}

interface P12VerificationBundleV1 {
  readonly admissionResult: ScaP12AdmissionResultV1;
  readonly scope: ScaP12VerificationScopeV1;
  readonly verifierAuthority: ScaP12VerifierAuthorityV1;
  readonly releaseAuthority: ScaP12ReleaseAuthorityV1;
  readonly verifierAuthorityCurrent: boolean;
  readonly releaseAuthorityCurrent: boolean;
  readonly phaseGate: ScaP12PhaseGateEvaluationV1 | null;
  readonly replay: ScaP12ReplayResultV1;
  readonly verdictsPassed: boolean;
  readonly obligationComplete: boolean;
  readonly facts: ScaP12GateFactsV1;
  readonly green: boolean;
}

/**
 * Pure projection of a P12 terminal into the engine terminal directive. A `released_complete`
 * terminal maps to `action`/`status` `"complete"` with `met: true` so that the engine completion
 * gate actually runs; every non-positive terminal maps to `"incomplete"` with `met: false` and its
 * sorted blockers. Exported for the guarded positive-projection unit test; the live path applies the
 * identical mapping through `persistTerminal`.
 */
export type ScaP12TerminalDirectiveV1 = Extract<Directive, { result: Record<string, JsonValue> }>;

export function scaP12TerminalDirective(input: {
  readonly identity: RunIdentity;
  readonly terminal: ScaP12TerminalV1;
  readonly artifacts: readonly ArtifactRef[];
  readonly unresolved: readonly string[];
}): ScaP12TerminalDirectiveV1 {
  const positive = input.terminal.status === "released_complete";
  const directive = validateDirective({
    schema_version: 2,
    action: positive ? "complete" : "incomplete",
    identity: input.identity,
    status: positive ? "complete" : "incomplete",
    met: positive,
    result: input.terminal,
    artifacts: uniqueRefs(input.artifacts).slice(0, 128),
    unresolved: positive ? [] : [...input.unresolved].sort(),
  });
  if (directive.action !== "complete" && directive.action !== "incomplete") {
    throw new Error("SCA P12 terminal directive has an unexpected action");
  }
  return directive;
}

/**
 * Inactive SCA P12 candidate: independent release verification and campaign completion. It is
 * deliberately absent from `PLAYBOOK_REGISTRY` and `SCA_PHASE_REGISTRY`. It is a deterministic host
 * playbook (worker `kind: "none"`) — the verifier is host-side and makes no model or provider call —
 * with exactly one human user gate (`sca_p12_awaiting_release_approval`).
 */
export class ScaP12CandidatePlaybook implements Playbook {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly binding: ScaP12CandidateBindingV1 = {},
    private readonly trustedClock: () => Date = () => new Date()
  ) {}

  initialize(context: RunContext): Directive {
    const requestRef = latestSelected(
      context,
      (ref) => ref.kind === REQUEST_KIND && ref.run_id === context.identity.run_id
    );
    if (requestRef === undefined) throw new Error("SCA P12 admitted request is absent");
    const constraints = validateContract(
      ScaP12StartConstraintsV1Schema,
      exactJson(this.store, requestRef, "candidate request", (value) => value),
      "SCA P12 start constraints"
    );
    const admission = this.admit(context, constraints);
    const admissionRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: ADMISSION_KIND,
      operationId: "sca-p12-admission",
      schemaId: SCA_P12_ADMISSION_SCHEMA,
      value: admission.admission,
      upstreamRefs: uniqueRefs([requestRef, ...admission.evidence_refs]),
    });
    this.writeData(context, {
      request_ref: requestRef,
      admission_ref: admissionRef,
      verification_scope_ref: constraints.verification_scope_ref,
      verifier_authority_ref: constraints.verifier_authority_ref,
      release_authority_ref: constraints.release_authority_ref,
      phase_gate_index_ref: null,
      replay_ref: null,
      verdicts_ref: null,
      obligation_ledger_ref: null,
      draft_ref: null,
      gate_ref: null,
    });

    if (!admission.reportable || admission.lane === null) {
      context.transition(SCA_P12_FINALIZING_STATE);
      const cancelled = admission.p11_terminal.status === "cancelled";
      return this.finalizeNonPositive(
        context,
        admission,
        cancelled ? "cancelled" : "blocked_invalid",
        admission.non_reportable_reason ?? "p12_non_reportable_p11_terminal"
      );
    }

    context.transition(SCA_P12_VERIFYING_STATE);
    const bundle = this.verify(context, constraints, admission);
    context.transition(SCA_P12_REPLAYING_STATE);

    if (!bundle.green) {
      context.transition(SCA_P12_FINALIZING_STATE);
      return this.finalizeVerificationIncomplete(context, admission, bundle);
    }

    context.transition(SCA_P12_AWAITING_RELEASE_APPROVAL_STATE);
    return this.issueReleaseGate(context, admission, bundle);
  }

  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    if (context.stateId === SCA_P12_FINALIZING_STATE) return this.finalizeFromState(context);
    if (context.stateId === SCA_P12_AWAITING_RELEASE_APPROVAL_STATE) {
      return this.issueReleaseGate(context, this.readmitFromState(context), null);
    }
    throw new Error(`SCA P12 has no dispatch for '${context.stateId}'`);
  }

  resume(context: RunContext, response: unknown): Directive {
    if (context.stateId !== SCA_P12_AWAITING_RELEASE_APPROVAL_STATE) {
      throw new Error("SCA P12 has no user gate in this state");
    }
    const payload = validateScaP12ResumePayloadV1(response);
    const state = data(context);
    const admission = this.readmitFromState(context);
    if (state.draft_ref === null || state.gate_ref === null || !admission.reportable) {
      throw new Error("SCA P12 release gate has no recorded draft or gate");
    }
    const draftRef = state.draft_ref;
    const separation = this.deriveApprovalSeparation(
      context,
      admission,
      payload.human_principal_id
    );
    const approval = sealScaP12ReleaseApprovalV1({
      run_id: context.identity.run_id,
      report_projection_ref: admission.admission.p11_report_ref ?? admission.p11_terminal_ref,
      report_projection_sha256:
        admission.admission.p11_report_ref?.content_digest ??
        admission.p11_terminal_ref.content_digest,
      gate_ref: state.gate_ref,
      gate_sha256: state.gate_ref.content_digest,
      release_record_draft_sha256: draftRef.content_digest,
      release_authority_ref: admission.admission.release_authority_ref,
      decision: payload.decision,
      human_principal_id: payload.human_principal_id,
      authority_receipt_sha256: payload.authority_receipt_sha256,
      decided_at: payload.decided_at,
      expires_at: payload.expires_at,
      separated_from_verifier: separation.separated_from_verifier,
      separated_from_report_production: separation.separated_from_report_production,
      distinct_from_release_authority: separation.distinct_from_release_authority,
    });
    const approvalRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: APPROVAL_KIND,
      operationId: "sca-p12-release-approval",
      schemaId: SCA_P12_RELEASE_APPROVAL_SCHEMA,
      value: approval,
      upstreamRefs: [draftRef, state.gate_ref],
    });
    context.transition(SCA_P12_FINALIZING_STATE);
    return this.finalizeResolved(context, admission, approvalRef);
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = SCA_P12_CANCELLED_STATE;
    context.status = "cancelled";
    context.met = false;
    const terminal = validateScaP12TerminalV1(
      withP12Digest(
        {
          schema_id: SCA_P12_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: "SCA-P12" as const,
          status: "cancelled" as const,
          release_record_ref: null,
          gate_ref: null,
          release_approval_ref: null,
          p11_terminal_ref: null,
          report_ref: null,
          campaign_complete: false,
          release_eligible: false,
          publication_authorized: false as const,
          publication_performed: false as const,
          incomplete_marker: null,
          missing_downstream_artifacts: scaP12MissingDownstreamArtifacts(),
          required_downstream_obligation_ids: scaP12DownstreamObligationIds(),
          selected_artifact_refs: this.selectedCoreRefs(context),
          blocker_codes: ["p12_cancelled"],
        },
        "terminal_sha256"
      )
    );
    void reason;
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: TERMINAL_KIND,
      operationId: "sca-p12-terminal-cancelled",
      schemaId: SCA_P12_TERMINAL_SCHEMA,
      value: terminal,
      upstreamRefs: this.selectedCoreRefs(context),
      select: false,
    });
    const directive = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: terminal,
      artifacts: uniqueRefs([terminalRef, ...this.selectedCoreRefs(context)]).slice(0, 128),
      unresolved: terminal.blocker_codes,
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending !== null) return pending;
    if (context.stateId === SCA_P12_FINALIZING_STATE) {
      return this.finalizeFromState(context);
    }
    if (context.stateId === SCA_P12_AWAITING_RELEASE_APPROVAL_STATE) {
      return this.issueReleaseGate(context, this.readmitFromState(context), null);
    }
    return null;
  }

  acceptSummary(): Directive {
    throw new Error("SCA P12 deterministic candidate never accepts worker summaries");
  }

  // --- private -------------------------------------------------------------------------------

  private writeData(context: RunContext, value: P12Data): void {
    for (const key of Object.keys(context.playbookData)) delete context.playbookData[key];
    Object.assign(context.playbookData, value);
  }

  private readmitFromState(context: RunContext): ScaP12AdmissionResultV1 {
    const state = data(context);
    const constraints = validateContract(
      ScaP12StartConstraintsV1Schema,
      exactJson(this.store, state.request_ref, "candidate request", (value) => value),
      "SCA P12 start constraints"
    );
    return this.admit(context, constraints);
  }

  private admit(
    context: RunContext,
    constraints: ScaP12StartConstraintsV1
  ): ScaP12AdmissionResultV1 {
    return admitScaP12Release({
      store: this.store,
      run_id: context.identity.run_id,
      p11_terminal_ref: constraints.p11_terminal_ref,
      p11_transition_ref: constraints.p11_transition_ref,
      p11_admission_ref: constraints.p11_admission_ref,
      verification_scope_ref: constraints.verification_scope_ref,
      verifier_authority_ref: constraints.verifier_authority_ref,
      release_authority_ref: constraints.release_authority_ref,
      p10_terminal_ref: constraints.p10_terminal_ref,
      p10_transition_ref: constraints.p10_transition_ref,
      p10_outcome_ref: constraints.p10_outcome_ref,
      p10_gate_ref: constraints.p10_gate_ref,
      p10_admission_ref: constraints.p10_admission_ref,
      p10_eligibility_ledger_ref: constraints.p10_eligibility_ledger_ref,
      p10_candidate_registry_ref: constraints.p10_candidate_registry_ref,
      p09_terminal_ref: constraints.p09_terminal_ref,
      p09_transition_ref: constraints.p09_transition_ref,
      p09_reconciliation_ledger_ref: constraints.p09_reconciliation_ledger_ref,
      p09_gate_ref: constraints.p09_gate_ref,
      p09_admission_ref: constraints.p09_admission_ref,
      p08_terminal_ref: constraints.p08_terminal_ref,
      p08_transition_ref: constraints.p08_transition_ref,
      p08_evidence_ledger_ref: constraints.p08_evidence_ledger_ref,
      p08_gate_ref: constraints.p08_gate_ref,
      p08_admission_ref: constraints.p08_admission_ref,
      p08_item_universe_ref: constraints.p08_item_universe_ref,
      p01_obligation_ledger_ref: constraints.p01_obligation_ledger_ref,
      baseline_evidence_ref: constraints.baseline_evidence_ref,
      p10_disclosure_scope_ref: constraints.p10_disclosure_scope_ref,
      promotion_authority_ref: constraints.promotion_authority_ref,
      active_run_rule_release_refs: constraints.active_run_rule_release_refs,
      p09_coverage_input_ref: constraints.p09_coverage_input_ref,
      p09_phase_evidence_refs: constraints.p09_phase_evidence_refs,
      p09_obligation_resolution_ref: constraints.p09_obligation_resolution_ref,
      p09_reassessment_ref: constraints.p09_reassessment_ref,
      p10_reassessment_ref: constraints.p10_reassessment_ref,
      p10_prior_ledger_ref: constraints.p10_prior_ledger_ref,
      p11_disclosure_scope_ref: constraints.p11_disclosure_scope_ref,
      p11_repair_disclosure_scope_ref: constraints.p11_repair_disclosure_scope_ref,
      scoring_policy_ref: constraints.scoring_policy_ref,
      report_policy_ref: constraints.report_policy_ref,
      ...(constraints.p12_reassessment_ref === null
        ? {}
        : { p12_reassessment_ref: constraints.p12_reassessment_ref }),
      ...(constraints.p12_prior_release_ref === null
        ? {}
        : { p12_prior_release_ref: constraints.p12_prior_release_ref }),
    });
  }

  private authorityScope(
    context: RunContext,
    admission: ScaP12AdmissionResultV1
  ): ScaP12CurrentAuthorityScopeV1 {
    const reportRef = admission.admission.p11_report_ref ?? admission.p11_terminal_ref;
    return {
      run_id: context.identity.run_id,
      phase_id: "SCA-P12",
      subject_sha256: scaP12AuthorityScopeSubject({
        p11_terminal_ref: admission.p11_terminal_ref,
        p11_report_ref: reportRef,
      }),
    };
  }

  private resolveAuthorities(
    context: RunContext,
    admission: ScaP12AdmissionResultV1
  ): {
    readonly authorityScope: ScaP12CurrentAuthorityScopeV1;
    readonly verifierRef: ArtifactRef;
    readonly releaseRef: ArtifactRef;
    readonly verifierCurrent: boolean;
    readonly releaseCurrent: boolean;
    readonly verifierAuthority: ScaP12VerifierAuthorityV1;
    readonly releaseAuthority: ScaP12ReleaseAuthorityV1;
  } {
    const authorityScope = this.authorityScope(context, admission);
    const verifierRef =
      this.binding.resolve_current_verifier_authority_ref?.(authorityScope) ??
      admission.admission.verifier_authority_ref;
    const releaseRef =
      this.binding.resolve_current_release_authority_ref?.(authorityScope) ??
      admission.admission.release_authority_ref;
    const verifierCurrent = this.binding.resolve_current_verifier_authority_ref !== undefined;
    const releaseCurrent = this.binding.resolve_current_release_authority_ref !== undefined;
    const verifierAuthority: ScaP12VerifierAuthorityV1 = exactJson(
      this.store,
      verifierRef,
      "verifier authority",
      validateScaP12VerifierAuthorityV1
    );
    const releaseAuthority: ScaP12ReleaseAuthorityV1 = exactJson(
      this.store,
      releaseRef,
      "release authority",
      validateScaP12ReleaseAuthorityV1
    );
    if (verifierAuthority.schema_id !== SCA_P12_VERIFIER_AUTHORITY_SCHEMA) {
      throw new Error("SCA P12 verifier authority schema binding mismatch");
    }
    return {
      authorityScope,
      verifierRef,
      releaseRef,
      verifierCurrent,
      releaseCurrent,
      verifierAuthority,
      releaseAuthority,
    };
  }

  private evaluatePhaseGate(phaseGateRef: ArtifactRef): ScaP12PhaseGateEvaluationV1 {
    // Phase-gate index is host-owned (A5). Absence is deny-by-default (never caller-asserted), and
    // each gate is fully re-verified with verifyScaPhaseGateV3 against a host-supplied definition.
    const definitionFor = this.binding.resolve_phase_gate_qualification;
    return evaluateScaP12PhaseGateIndexV1({
      store: this.store,
      index: exactJson(
        this.store,
        phaseGateRef,
        "phase gate index",
        validateScaP12PhaseGateIndexV1
      ),
      ...(definitionFor === undefined ? {} : { definition_for: definitionFor }),
    });
  }

  /** Derived exclusions for independence: verified gate identities, the exact P11 producer set, and
   * the recorded P11 semantic reviewer/repairer identity and execution lineage (P12-R07). */
  private derivedIndependenceExclusions(
    admission: ScaP12AdmissionResultV1,
    phaseGate: ScaP12PhaseGateEvaluationV1 | null
  ): ScaP12PhaseGateDerivedExclusionsV1 & { readonly available: boolean } {
    return deriveScaP12IndependenceExclusionsV1({
      store: this.store,
      admission,
      phase_gate_exclusions: phaseGate === null ? null : phaseGate.derived_exclusions,
      phase_gate_complete: phaseGate !== null && phaseGate.complete,
    });
  }

  /** Derive the approver separation from the actual verifier/report-production/release identities. */
  private deriveApprovalSeparation(
    context: RunContext,
    admission: ScaP12AdmissionResultV1,
    humanPrincipalId: string
  ): ReturnType<typeof deriveScaP12ApproverSeparation> {
    const authorities = this.resolveAuthorities(context, admission);
    const phaseGateRef =
      this.binding.resolve_current_phase_gate_index_ref?.(authorities.authorityScope) ?? null;
    const phaseGate = phaseGateRef === null ? null : this.evaluatePhaseGate(phaseGateRef);
    const exclusions = this.derivedIndependenceExclusions(admission, phaseGate);
    return deriveScaP12ApproverSeparation({
      human_principal_id: humanPrincipalId,
      verifier_authority: authorities.verifierAuthority,
      release_authority: authorities.releaseAuthority,
      report_production_identity_ids: exclusions.identity_ids,
      report_production_lineage_ids: exclusions.lineage_ids,
    });
  }

  private computeFacts(input: {
    readonly admission: ScaP12AdmissionResultV1;
    readonly independence: ScaP12IndependenceResultV1;
    readonly replay: ScaP12ReplayResultV1;
    readonly phaseGate: ScaP12PhaseGateEvaluationV1 | null;
    readonly verdictsPassed: boolean;
    readonly obligationComplete: boolean;
    readonly releaseCurrent: boolean;
    readonly addendumFree: boolean;
  }): ScaP12GateFactsV1 {
    const { admission, independence, replay, phaseGate } = input;
    return {
      immutable_p11_lineage_valid: admission.rederived !== null,
      verifier_independent_and_subset_authority:
        independence.verifier_independent &&
        independence.verifier_subset_authority &&
        independence.verifier_authority_current,
      deterministic_replay_passed: replay.evidence.passed,
      spot_check_passed: replay.evidence.spot_check_passed,
      verifier_verdicts_supported: input.verdictsPassed && replay.evidence.passed,
      no_unresolved_required_item: admission.no_unresolved_required_item,
      phase_gate_index_complete: phaseGate?.complete ?? false,
      obligation_ledger_complete: input.obligationComplete,
      accepted_set_projection_consistent: replay.facts.set_equality_valid,
      artifact_identity_valid: replay.facts.checksum_manifest_valid,
      latest_revision_only: replay.facts.latest_revision_only && input.addendumFree,
      human_release_authority_valid:
        independence.release_authority_valid &&
        independence.release_authority_distinct &&
        input.releaseCurrent,
      // The release record binds the same exact evidence the replay resolved; both the checksum
      // manifest and the accepted-set projection must resolve exactly, never a hardcoded true.
      release_record_binding_valid:
        replay.facts.checksum_manifest_valid && replay.facts.set_equality_valid,
      publication_not_claimed: replay.facts.release_claim_absent,
      p12_release_authority_respected: independence.release_authority_valid && input.releaseCurrent,
    };
  }

  private verify(
    context: RunContext,
    constraints: ScaP12StartConstraintsV1,
    admission: ScaP12AdmissionResultV1
  ): P12VerificationBundleV1 {
    const scope = exactJson(
      this.store,
      constraints.verification_scope_ref,
      "verification scope",
      validateScaP12VerificationScopeV1
    );
    const authorities = this.resolveAuthorities(context, admission);
    const phaseGateRef =
      this.binding.resolve_current_phase_gate_index_ref?.(authorities.authorityScope) ?? null;
    const phaseGate = phaseGateRef === null ? null : this.evaluatePhaseGate(phaseGateRef);
    const exclusions = this.derivedIndependenceExclusions(admission, phaseGate);

    const independence = checkScaP12Independence({
      verifier_authority: authorities.verifierAuthority,
      release_authority: authorities.releaseAuthority,
      subject_sha256: authorities.authorityScope.subject_sha256,
      excluded_identity_ids: exclusions.identity_ids,
      excluded_lineage_ids: exclusions.lineage_ids,
      exclusions_available: exclusions.available,
      verifier_authority_current: authorities.verifierCurrent,
    });

    const replay = buildScaP12ReplayEvidenceV1({
      store: this.store,
      run_id: context.identity.run_id,
      revision: 1,
      replay_lineage_id: `${context.identity.run_id}:p12-replay`,
      admission,
      verification_scope: scope,
    });

    const addendumFree = (admission.report?.addendum_refs.length ?? 0) === 0;
    const admissionRef = this.admissionRef(context);

    const replayRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: REPLAY_KIND,
      operationId: "sca-p12-replay-evidence",
      schemaId: SCA_P12_REPLAY_EVIDENCE_SCHEMA,
      value: replay.evidence,
      upstreamRefs: replay.evidence.evidence_refs,
    });

    const acceptanceCovered = replay.evidence.passed;
    const independentReviewCovered =
      independence.verifier_independent &&
      independence.verifier_subset_authority &&
      independence.verifier_authority_current;
    const releaseAuthorityCovered =
      independence.release_authority_valid && authorities.releaseCurrent;
    const obligationComplete =
      acceptanceCovered && independentReviewCovered && releaseAuthorityCovered;

    const verdictResult = buildScaP12VerifierVerdictsV1({
      store: this.store,
      run_id: context.identity.run_id,
      revision: 1,
      verification_scope: scope,
      facts: {
        scope_complete: true,
        independence,
        replay_passed: replay.evidence.passed,
        spot_check_passed: replay.evidence.spot_check_passed,
        phase_gate_complete: phaseGate?.complete ?? false,
        obligation_ledger_complete: obligationComplete,
        set_equality: replay.facts.set_equality_valid,
        no_unresolved: admission.no_unresolved_required_item,
        identity_valid: replay.facts.checksum_manifest_valid,
        stale_free: replay.facts.latest_revision_only && addendumFree,
        release_claims_absent: replay.facts.release_claim_absent,
      },
    });
    const verdictsRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: VERDICTS_KIND,
      operationId: "sca-p12-verifier-verdicts",
      schemaId: SCA_P12_VERIFIER_VERDICTS_SCHEMA,
      value: verdictResult.verdicts,
      upstreamRefs: [replayRef],
    });

    const obligations = buildScaP12ObligationLedgerV1({
      run_id: context.identity.run_id,
      revision: 1,
      admission_ref: admissionRef,
      verifier_authority_ref: authorities.verifierRef,
      release_authority_ref: authorities.releaseRef,
      replay_ref: replayRef,
      verdicts_ref: verdictsRef,
      approval_ref: null,
      acceptance_covered: acceptanceCovered,
      independent_review_covered: independentReviewCovered,
      release_authority_covered: releaseAuthorityCovered,
    });
    const obligationRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: OBLIGATION_KIND,
      operationId: "sca-p12-obligation-ledger",
      schemaId: "penny.sca-p12-obligation-ledger.v1",
      value: obligations,
      upstreamRefs: [replayRef, verdictsRef],
    });
    if ((obligations.uncovered_obligation_ids.length === 0) !== obligationComplete) {
      throw new Error("SCA P12 obligation ledger closure disagrees with the derived completeness");
    }

    const facts = this.computeFacts({
      admission,
      independence,
      replay,
      phaseGate,
      verdictsPassed: verdictResult.evaluation.passed,
      obligationComplete,
      releaseCurrent: authorities.releaseCurrent,
      addendumFree,
    });

    const state = data(context);
    this.writeData(context, {
      ...state,
      phase_gate_index_ref: phaseGateRef,
      replay_ref: replayRef,
      verdicts_ref: verdictsRef,
      obligation_ledger_ref: obligationRef,
    });

    const green =
      facts.immutable_p11_lineage_valid &&
      facts.verifier_independent_and_subset_authority &&
      facts.deterministic_replay_passed &&
      facts.spot_check_passed &&
      facts.verifier_verdicts_supported &&
      facts.no_unresolved_required_item &&
      facts.phase_gate_index_complete &&
      facts.obligation_ledger_complete &&
      facts.accepted_set_projection_consistent &&
      facts.artifact_identity_valid &&
      facts.latest_revision_only &&
      facts.human_release_authority_valid &&
      facts.release_record_binding_valid &&
      facts.publication_not_claimed &&
      facts.p12_release_authority_respected;

    return {
      admissionResult: admission,
      scope,
      verifierAuthority: authorities.verifierAuthority,
      releaseAuthority: authorities.releaseAuthority,
      verifierAuthorityCurrent: authorities.verifierCurrent,
      releaseAuthorityCurrent: authorities.releaseCurrent,
      phaseGate,
      replay,
      verdictsPassed: verdictResult.evaluation.passed,
      obligationComplete,
      facts,
      green,
    };
  }

  private buildDraftAndGate(
    context: RunContext,
    admission: ScaP12AdmissionResultV1,
    facts: ScaP12GateFactsV1,
    evaluatedAt: string
  ): { readonly draftRef: ArtifactRef; readonly gateRef: ArtifactRef } {
    const state = data(context);
    if (
      state.replay_ref === null ||
      state.verdicts_ref === null ||
      state.obligation_ledger_ref === null
    ) {
      throw new Error("SCA P12 draft requires the persisted verification evidence");
    }
    const reportRef = admission.admission.p11_report_ref ?? admission.p11_terminal_ref;
    const gate = buildScaP12GateV1({
      report_ref: reportRef,
      release_record_ref: null,
      lane: admission.lane ?? undefined,
      facts,
      blocker_codes: [],
      finding_count: admission.admission.finding_count,
      record_count: admission.admission.record_count,
      evaluated_at: evaluatedAt,
    });
    const gateRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: GATE_KIND,
      operationId: "sca-p12-gate",
      schemaId: SCA_P12_GATE_SCHEMA,
      value: gate,
      upstreamRefs: [state.replay_ref, state.verdicts_ref, reportRef],
    });
    const draft = buildScaP12ReleaseRecordV1({
      run_id: context.identity.run_id,
      phase_gate_index_ref: state.phase_gate_index_ref ?? admission.p11_terminal_ref,
      p11_terminal_ref: admission.p11_terminal_ref,
      p11_report_ref: reportRef,
      p11_reconciliation_ref: admission.report?.reconciliation_ref ?? reportRef,
      p11_validation_records_ref: admission.report?.validation_records_ref ?? reportRef,
      p11_gate_ref: admission.p11_terminal.gate_ref ?? reportRef,
      admission_ref: state.admission_ref,
      replay_evidence_ref: state.replay_ref,
      verifier_verdicts_ref: state.verdicts_ref,
      release_authority_ref: admission.admission.release_authority_ref,
      release_approval_ref: null,
      obligation_ledger_ref: state.obligation_ledger_ref,
      release_eligible: false,
      campaign_complete: false,
      blocker_codes: [],
    });
    const draftRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: DRAFT_KIND,
      operationId: "sca-p12-release-record-draft",
      schemaId: SCA_P12_RELEASE_RECORD_SCHEMA,
      value: draft,
      upstreamRefs: [gateRef, state.replay_ref, state.verdicts_ref],
    });
    this.writeData(context, {
      ...state,
      gate_ref: gateRef,
      draft_ref: draftRef,
    });
    return { draftRef, gateRef };
  }

  private issueReleaseGate(
    context: RunContext,
    admission: ScaP12AdmissionResultV1,
    bundle: P12VerificationBundleV1 | null
  ): Directive {
    let facts: ScaP12GateFactsV1;
    let evaluatedAt: string;
    if (bundle !== null) {
      facts = bundle.facts;
      evaluatedAt = bundle.admissionResult.p11_gate?.evaluated_at ?? this.stableTimestamp(context);
    } else {
      const rebuilt = this.rebuildFactsFromState(context, admission);
      facts = rebuilt.facts;
      evaluatedAt = rebuilt.evaluatedAt;
    }
    const state = data(context);
    let draftRef = state.draft_ref;
    let gateRef = state.gate_ref;
    if (draftRef === null || gateRef === null) {
      const built = this.buildDraftAndGate(context, admission, facts, evaluatedAt);
      draftRef = built.draftRef;
      gateRef = built.gateRef;
    }
    const reportRef = admission.admission.p11_report_ref ?? admission.p11_terminal_ref;
    const draftDigest = draftRef.content_digest;
    context.pendingDirective = null;
    context.status = "awaiting_user";
    const next = validateDirective({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: SCA_P12_AWAITING_RELEASE_APPROVAL_STATE,
      gate_id: `p12gate_${sha256(canonicalJson({ draft: draftDigest })).slice(0, 32)}`,
      challenge: sha256(canonicalJson({ challenge: draftDigest, gate: gateRef.artifact_id })),
      payload_digest: draftDigest,
      questions: [
        {
          id: "release-decision",
          prompt: `Approve or reject the P12 release for report ${reportRef.artifact_id} (gate ${gateRef.artifact_id}).`,
        },
      ],
    });
    context.pendingDirective = next;
    return next;
  }

  private rebuildFactsFromState(
    context: RunContext,
    admission: ScaP12AdmissionResultV1
  ): { readonly facts: ScaP12GateFactsV1; readonly evaluatedAt: string } {
    // Re-derive every gate fact from the exact persisted artifacts and current authorities (A5/A2).
    // No fact is hardcoded: independence, the phase-gate index, the deterministic replay, the
    // verifier verdicts, and the obligation-ledger closure are all recomputed from exact bytes.
    const state = data(context);
    if (
      state.replay_ref === null ||
      state.verdicts_ref === null ||
      state.obligation_ledger_ref === null
    ) {
      throw new Error("SCA P12 awaiting gate requires the persisted verification evidence");
    }
    const constraints = validateContract(
      ScaP12StartConstraintsV1Schema,
      exactJson(this.store, state.request_ref, "candidate request", (value) => value),
      "SCA P12 start constraints"
    );
    const scope = exactJson(
      this.store,
      constraints.verification_scope_ref,
      "verification scope",
      validateScaP12VerificationScopeV1
    );
    const authorities = this.resolveAuthorities(context, admission);
    const phaseGateRef =
      this.binding.resolve_current_phase_gate_index_ref?.(authorities.authorityScope) ?? null;
    const phaseGate = phaseGateRef === null ? null : this.evaluatePhaseGate(phaseGateRef);
    const exclusions = this.derivedIndependenceExclusions(admission, phaseGate);
    const independence = checkScaP12Independence({
      verifier_authority: authorities.verifierAuthority,
      release_authority: authorities.releaseAuthority,
      subject_sha256: authorities.authorityScope.subject_sha256,
      excluded_identity_ids: exclusions.identity_ids,
      excluded_lineage_ids: exclusions.lineage_ids,
      exclusions_available: exclusions.available,
      verifier_authority_current: authorities.verifierCurrent,
    });
    const replay = buildScaP12ReplayEvidenceV1({
      store: this.store,
      run_id: context.identity.run_id,
      revision: 1,
      replay_lineage_id: `${context.identity.run_id}:p12-replay`,
      admission,
      verification_scope: scope,
    });
    const persistedVerdicts = validateScaP12VerifierVerdictsV1(
      exactJson(this.store, state.verdicts_ref, "verifier verdicts", (value) => value)
    );
    const verdictEvaluation = evaluateScaP12VerifierVerdictsV1({
      store: this.store,
      verification_scope: scope,
      verdicts: persistedVerdicts,
    });
    const obligationLedger = validateScaP12ObligationLedgerV1(
      exactJson(this.store, state.obligation_ledger_ref, "obligation ledger", (value) => value)
    );
    const addendumFree = (admission.report?.addendum_refs.length ?? 0) === 0;
    const facts = this.computeFacts({
      admission,
      independence,
      replay,
      phaseGate,
      verdictsPassed: verdictEvaluation.passed,
      obligationComplete: obligationLedger.uncovered_obligation_ids.length === 0,
      releaseCurrent: authorities.releaseCurrent,
      addendumFree,
    });
    return {
      facts,
      evaluatedAt: admission.p11_gate?.evaluated_at ?? this.stableTimestamp(context),
    };
  }

  private stableTimestamp(context: RunContext): string {
    void this.admissionRef(context);
    return this.trustedClock().toISOString();
  }

  private finalizeFromState(context: RunContext): Directive {
    // Byte-identical replay: if this run already persisted a terminal, re-emit that exact terminal
    // rather than deriving a second one (which would conflict with the immutable prior bytes).
    const persisted = this.persistedTerminalDirective(context);
    if (persisted !== null) return persisted;
    const admission = this.readmitFromState(context);
    if (!admission.reportable) {
      const cancelled = admission.p11_terminal.status === "cancelled";
      return this.finalizeNonPositive(
        context,
        admission,
        cancelled ? "cancelled" : "blocked_invalid",
        admission.non_reportable_reason ?? "p12_non_reportable_p11_terminal"
      );
    }
    const state = data(context);
    if (state.gate_ref !== null && state.draft_ref !== null) {
      const gate = this.readGate(state.gate_ref);
      const approvalRef = latestSelected(context, (ref) => ref.kind === APPROVAL_KIND);
      if (approvalRef !== undefined) {
        const approval = exactJson(
          this.store,
          approvalRef,
          "release approval",
          validateScaP12ReleaseApprovalV1
        );
        return this.finalizeResolved(context, admission, approvalRef, approval);
      }
      if (gate.verdict === "pass_ready") {
        return this.finalizeResolved(context, admission, null);
      }
    }
    return this.finalizeSimple(context, "verification_incomplete", [
      "p12_release_evidence_incomplete",
    ]);
  }

  private readGate(ref: ArtifactRef): ScaP12GateV1 {
    return validateScaP12GateV1(exactJson(this.store, ref, "gate", (value) => value));
  }

  /** Reconstruct the exact terminal directive already persisted for this run, if any (replay-safe). */
  private persistedTerminalDirective(context: RunContext): Directive | null {
    const ref = latestSelected(
      context,
      (candidate) =>
        candidate.kind === TERMINAL_KIND && candidate.run_id === context.identity.run_id
    );
    if (ref === undefined) return null;
    const terminal = validateScaP12TerminalV1(
      exactJson(this.store, ref, "terminal", (value) => value)
    );
    return scaP12TerminalDirective({
      identity: context.identity,
      terminal,
      artifacts: [ref, ...this.selectedCoreRefs(context)],
      unresolved: terminal.blocker_codes,
    });
  }

  private admissionRef(context: RunContext): ArtifactRef {
    const ref = latestSelected(context, (candidate) => candidate.kind === ADMISSION_KIND);
    if (ref === undefined) throw new Error("SCA P12 admission artifact is absent");
    return ref;
  }

  private finalizeVerificationIncomplete(
    context: RunContext,
    admission: ScaP12AdmissionResultV1,
    bundle: P12VerificationBundleV1
  ): Directive {
    const state = data(context);
    if (
      state.replay_ref === null ||
      state.verdicts_ref === null ||
      state.obligation_ledger_ref === null
    ) {
      return this.finalizeSimple(context, "verification_incomplete", [
        "p12_verification_evidence_incomplete",
      ]);
    }
    const evaluatedAt =
      bundle.admissionResult.p11_gate?.evaluated_at ?? this.stableTimestamp(context);
    const built = this.buildDraftAndGate(context, admission, bundle.facts, evaluatedAt);
    const reportRef = admission.admission.p11_report_ref ?? admission.p11_terminal_ref;
    const blockers = uniqueStrings([
      ...this.incompleteBlockers(bundle),
      ...(admission.admission.non_reportable_reason === null
        ? []
        : [admission.admission.non_reportable_reason]),
    ]);
    const marker = scaP12IncompleteMarker(blockers);
    const checkpointRefs = this.persistCheckpoints(context, admission, blockers);
    const terminal = buildScaP12TerminalV1({
      status: "verification_incomplete",
      lane: admission.lane ?? undefined,
      release_record_ref: built.draftRef,
      gate_ref: built.gateRef,
      release_approval_ref: null,
      p11_terminal_ref: admission.p11_terminal_ref,
      report_ref: reportRef,
      campaign_complete: false,
      release_eligible: false,
      incomplete_marker: marker,
      selected_artifact_refs: this.selectedCoreRefs(context),
      blocker_codes: blockers,
    });
    return this.persistTerminal(
      context,
      terminal,
      [built.draftRef, built.gateRef, ...checkpointRefs],
      blockers,
      "incomplete"
    );
  }

  private persistCheckpoints(
    context: RunContext,
    admission: ScaP12AdmissionResultV1,
    blockers: readonly string[]
  ): ArtifactRef[] {
    const refs: ArtifactRef[] = [];
    for (const blocker of blockers) {
      const checkpoint = validateScaP12CheckpointV1(
        withP12Digest(
          {
            schema_id: SCA_P12_CHECKPOINT_SCHEMA,
            schema_version: 1 as const,
            phase_id: "SCA-P12" as const,
            run_id: context.identity.run_id,
            item_id: `p12cp_${sha256(blocker).slice(0, 32)}`,
            identity: blocker,
            reason_code: blocker,
            primary_ref: admission.p11_terminal_ref,
            missing_evidence_need: `Establish '${blocker}' against the exact latest P11 revision.`,
            reopen_condition:
              "A new reassessment against the exact latest revision must supply the missing evidence.",
          },
          "checkpoint_sha256"
        )
      );
      refs.push(
        persistJson({
          store: this.store,
          context,
          runId: context.identity.run_id,
          phase: "SCA-P12",
          kind: CHECKPOINT_KIND,
          operationId: `sca-p12-checkpoint-${sha256(blocker).slice(0, 16)}`,
          schemaId: SCA_P12_CHECKPOINT_SCHEMA,
          value: checkpoint,
          upstreamRefs: [admission.p11_terminal_ref],
          select: false,
        })
      );
    }
    return refs;
  }

  private incompleteBlockers(bundle: P12VerificationBundleV1): string[] {
    const blockers: string[] = [];
    if (!bundle.replay.evidence.passed) blockers.push("p12_deterministic_replay_not_passed");
    if (!bundle.replay.evidence.spot_check_passed) blockers.push("p12_spot_check_not_passed");
    if (!bundle.verdictsPassed) blockers.push("p12_verifier_verdicts_not_supported");
    if (!bundle.facts.phase_gate_index_complete) blockers.push("p12_phase_gate_index_incomplete");
    if (!bundle.facts.obligation_ledger_complete) blockers.push("p12_obligation_ledger_incomplete");
    if (!bundle.facts.human_release_authority_valid)
      blockers.push("p12_release_authority_unestablished");
    if (!bundle.facts.latest_revision_only)
      blockers.push("p12_latest_revision_or_p11_addendum_invalid");
    if (!bundle.facts.immutable_p11_lineage_valid) blockers.push("p12_p11_lineage_invalid");
    return blockers.length === 0 ? ["p12_release_predicate_unestablished"] : blockers;
  }

  private finalizeResolved(
    context: RunContext,
    admission: ScaP12AdmissionResultV1,
    approvalRef: ArtifactRef | null,
    preloadedApproval?: ReturnType<typeof validateScaP12ReleaseApprovalV1>
  ): Directive {
    const state = data(context);
    if (
      state.draft_ref === null ||
      state.gate_ref === null ||
      state.obligation_ledger_ref === null
    ) {
      return this.finalizeSimple(context, "verification_incomplete", [
        "p12_release_state_incomplete",
      ]);
    }
    const reportRef = admission.admission.p11_report_ref ?? admission.p11_terminal_ref;
    const approval =
      preloadedApproval === undefined
        ? approvalRef === null
          ? null
          : exactJson(this.store, approvalRef, "release approval", validateScaP12ReleaseApprovalV1)
        : preloadedApproval;

    let approved = false;
    if (approval !== null) {
      if (approvalRef === null) throw new Error("SCA P12 approval ref is absent");
      const releaseAuthority = exactJson(
        this.store,
        approval.release_authority_ref,
        "release authority",
        validateScaP12ReleaseAuthorityV1
      );
      const authorities = this.resolveAuthorities(context, admission);
      const phaseGateRef =
        this.binding.resolve_current_phase_gate_index_ref?.(authorities.authorityScope) ?? null;
      const phaseGate = phaseGateRef === null ? null : this.evaluatePhaseGate(phaseGateRef);
      const exclusions = this.derivedIndependenceExclusions(admission, phaseGate);
      const evaluation = evaluateScaP12ReleaseApprovalV1({
        approval,
        gate: this.readGate(state.gate_ref),
        verifier_authority: authorities.verifierAuthority,
        release_authority: releaseAuthority,
        release_authority_ref: admission.admission.release_authority_ref,
        report_production_identity_ids: exclusions.identity_ids,
        report_production_lineage_ids: exclusions.lineage_ids,
        report_projection_ref: reportRef,
        gate_ref: state.gate_ref,
        release_record_draft_sha256: state.draft_ref.content_digest,
        now: this.trustedClock(),
      });
      approved = evaluation.valid;
    }

    if (!approved) {
      const blockers = uniqueStrings([
        ...(approval !== null && approval.decision === "rejected"
          ? ["p12_human_release_rejected"]
          : approval === null
            ? ["p12_human_release_approval_absent"]
            : ["p12_human_release_approval_invalid"]),
      ]);
      const record = this.buildFinalRecord(
        context,
        admission,
        state,
        approvalRef,
        false,
        false,
        blockers
      );
      const terminal = buildScaP12TerminalV1({
        status: "release_refused",
        lane: admission.lane ?? undefined,
        release_record_ref: record,
        gate_ref: state.gate_ref,
        release_approval_ref: approvalRef,
        p11_terminal_ref: admission.p11_terminal_ref,
        report_ref: reportRef,
        campaign_complete: false,
        release_eligible: false,
        incomplete_marker: null,
        selected_artifact_refs: this.selectedCoreRefs(context),
        blocker_codes: blockers,
      });
      return this.persistTerminal(
        context,
        terminal,
        [record, state.gate_ref],
        blockers,
        "incomplete"
      );
    }

    const record = this.buildFinalRecord(context, admission, state, approvalRef, true, true, []);
    const terminal = buildScaP12TerminalV1({
      status: "released_complete",
      lane: admission.lane ?? undefined,
      release_record_ref: record,
      gate_ref: state.gate_ref,
      release_approval_ref: approvalRef,
      p11_terminal_ref: admission.p11_terminal_ref,
      report_ref: reportRef,
      campaign_complete: true,
      release_eligible: true,
      incomplete_marker: null,
      selected_artifact_refs: this.selectedCoreRefs(context),
      blocker_codes: [],
    });
    return this.persistTerminal(context, terminal, [record, state.gate_ref], [], "complete");
  }

  private buildFinalRecord(
    context: RunContext,
    admission: ScaP12AdmissionResultV1,
    state: P12Data,
    approvalRef: ArtifactRef | null,
    releaseEligible: boolean,
    campaignComplete: boolean,
    blockerCodes: readonly string[]
  ): ArtifactRef {
    if (
      state.replay_ref === null ||
      state.verdicts_ref === null ||
      state.obligation_ledger_ref === null
    ) {
      throw new Error("SCA P12 final release record requires the persisted verification evidence");
    }
    const report = admission.report;
    const record = buildScaP12ReleaseRecordV1({
      run_id: context.identity.run_id,
      phase_gate_index_ref: state.phase_gate_index_ref ?? admission.p11_terminal_ref,
      p11_terminal_ref: admission.p11_terminal_ref,
      p11_report_ref: admission.admission.p11_report_ref ?? admission.p11_terminal_ref,
      p11_reconciliation_ref: report?.reconciliation_ref ?? admission.p11_terminal_ref,
      p11_validation_records_ref: report?.validation_records_ref ?? admission.p11_terminal_ref,
      p11_gate_ref: admission.p11_terminal.gate_ref ?? admission.p11_terminal_ref,
      admission_ref: state.admission_ref,
      replay_evidence_ref: state.replay_ref,
      verifier_verdicts_ref: state.verdicts_ref,
      release_authority_ref: admission.admission.release_authority_ref,
      release_approval_ref: approvalRef,
      obligation_ledger_ref: state.obligation_ledger_ref,
      release_eligible: releaseEligible,
      campaign_complete: campaignComplete,
      blocker_codes: blockerCodes,
    });
    return persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: RECORD_KIND,
      operationId: "sca-p12-release-record",
      schemaId: SCA_P12_RELEASE_RECORD_SCHEMA,
      value: record,
      upstreamRefs: uniqueRefs([
        state.draft_ref ?? state.admission_ref,
        ...(state.gate_ref === null ? [] : [state.gate_ref]),
        ...(approvalRef === null ? [] : [approvalRef]),
      ]),
    });
  }

  private finalizeNonPositive(
    context: RunContext,
    admission: ScaP12AdmissionResultV1,
    status: "blocked_invalid" | "cancelled",
    blocker: string
  ): Directive {
    const blockers = uniqueStrings([blocker]);
    let gateRef: ArtifactRef | null = null;
    if (status === "blocked_invalid") {
      const evaluatedAt = this.stableTimestamp(context);
      const gate = buildScaP12GateV1({
        report_ref: null,
        release_record_ref: null,
        lane: admission.lane ?? undefined,
        facts: this.neutralFacts(),
        blocker_codes: blockers,
        finding_count: 0,
        record_count: 0,
        evaluated_at: evaluatedAt,
      });
      gateRef = persistJson({
        store: this.store,
        context,
        runId: context.identity.run_id,
        phase: "SCA-P12",
        kind: GATE_KIND,
        operationId: "sca-p12-gate",
        schemaId: SCA_P12_GATE_SCHEMA,
        value: gate,
        upstreamRefs: [this.admissionRef(context)],
      });
    }
    const terminal = buildScaP12TerminalV1({
      status,
      lane: admission.lane ?? undefined,
      release_record_ref: null,
      gate_ref: gateRef,
      release_approval_ref: null,
      p11_terminal_ref: admission.p11_terminal_ref,
      report_ref: null,
      campaign_complete: false,
      release_eligible: false,
      incomplete_marker: null,
      selected_artifact_refs: this.selectedCoreRefs(context),
      blocker_codes: blockers,
    });
    return this.persistTerminal(
      context,
      terminal,
      gateRef === null ? [] : [gateRef],
      blockers,
      "incomplete"
    );
  }

  private finalizeSimple(
    context: RunContext,
    status: "verification_incomplete",
    blockers: readonly string[]
  ): Directive {
    const terminal = buildScaP12TerminalV1({
      status,
      release_record_ref: null,
      gate_ref: null,
      release_approval_ref: null,
      p11_terminal_ref: null,
      report_ref: null,
      campaign_complete: false,
      release_eligible: false,
      incomplete_marker: scaP12IncompleteMarker(blockers),
      selected_artifact_refs: this.selectedCoreRefs(context),
      blocker_codes: blockers,
    });
    return this.persistTerminal(context, terminal, [], [...blockers], "incomplete");
  }

  private neutralFacts(): ScaP12GateFactsV1 {
    return {
      immutable_p11_lineage_valid: false,
      verifier_independent_and_subset_authority: false,
      deterministic_replay_passed: false,
      spot_check_passed: false,
      verifier_verdicts_supported: false,
      no_unresolved_required_item: false,
      phase_gate_index_complete: false,
      obligation_ledger_complete: false,
      accepted_set_projection_consistent: false,
      artifact_identity_valid: false,
      latest_revision_only: false,
      human_release_authority_valid: false,
      release_record_binding_valid: false,
      publication_not_claimed: false,
      p12_release_authority_respected: false,
    };
  }

  private persistTerminal(
    context: RunContext,
    terminal: ScaP12TerminalV1,
    upstream: readonly ArtifactRef[],
    unresolved: readonly string[],
    action: "complete" | "incomplete"
  ): Directive {
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: "SCA-P12",
      kind: TERMINAL_KIND,
      operationId: "sca-p12-terminal",
      schemaId: SCA_P12_TERMINAL_SCHEMA,
      value: terminal,
      upstreamRefs: uniqueRefs([...upstream, ...this.selectedCoreRefs(context)]),
    });
    const positive = action === "complete";
    context.status = positive ? "complete" : "incomplete";
    context.met = positive;
    const directive = scaP12TerminalDirective({
      identity: context.identity,
      terminal,
      artifacts: [terminalRef, ...upstream, ...this.selectedCoreRefs(context)],
      unresolved: positive ? [] : [...unresolved].sort(),
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private selectedCoreRefs(context: RunContext): ArtifactRef[] {
    const kinds = new Set<string>([
      REQUEST_KIND,
      ADMISSION_KIND,
      REPLAY_KIND,
      VERDICTS_KIND,
      CHECKPOINT_KIND,
      OBLIGATION_KIND,
      APPROVAL_KIND,
      DRAFT_KIND,
      RECORD_KIND,
      GATE_KIND,
      TERMINAL_KIND,
    ]);
    return uniqueRefs(
      context.selectedArtifacts.filter(
        (ref) => ref.run_id === context.identity.run_id && kinds.has(ref.kind)
      )
    ).slice(0, 128);
  }
}

function port(input: {
  readonly name: string;
  readonly kind: string;
  readonly schema: string;
  readonly direction: "input" | "output";
  readonly min?: number;
  readonly max?: number;
}) {
  return {
    schema_version: 1 as const,
    name: input.name,
    direction: input.direction,
    transport: "artifact" as const,
    schema_id: input.schema,
    schema_version_required: 1 as const,
    artifact_kind: input.kind,
    source: input.direction === "input" ? ("caller" as const) : ("skill" as const),
    min_items: input.min ?? 1,
    max_items: input.max ?? 1,
    semantic_product: input.direction === "output",
  };
}

export const SCA_P12_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: SCA_P12_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Independently re-derive the exact P11 reporting lineage across all four terminal statuses, perform deterministic replay and spot-checks over exact immutable evidence, derive a separated-verifier verdict set, an independent release record and AC-P12 gate, and close only on an exact-digest-bound authorized human release approval — with zero model, tool, provider, or publication calls.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: SCA_P12_CANDIDATE_START_SCHEMA,
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [],
    active_output_ports: [
      port({
        name: "p12_admission",
        kind: ADMISSION_KIND,
        schema: SCA_P12_ADMISSION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p12_replay_evidence",
        kind: REPLAY_KIND,
        schema: SCA_P12_REPLAY_EVIDENCE_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p12_verifier_verdicts",
        kind: VERDICTS_KIND,
        schema: SCA_P12_VERIFIER_VERDICTS_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p12_release_record",
        kind: RECORD_KIND,
        schema: SCA_P12_RELEASE_RECORD_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p12_gate",
        kind: GATE_KIND,
        schema: SCA_P12_GATE_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p12_terminal",
        kind: TERMINAL_KIND,
        schema: SCA_P12_TERMINAL_SCHEMA,
        direction: "output",
        min: 0,
      }),
    ],
  },
  behavior: {
    side_effects: {
      external_reads: "host_policy_only",
      external_mutations: "forbidden",
      filesystem_writes: "host_policy_only",
      allowed_relative_paths: [],
    },
    approval: { policy: "caller_skill_request", additional_approval_required: true },
    stopping: {
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "await_user",
    },
    escalation: { out_of_scope_effect: "non_positive", sandbox_prevention_claim: false },
    violation_terminal: "incomplete",
  },
  guidance: { skill_root: "apps/orchestration/src/sca", resolution: "per_agent_phase" },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.sca-p12-candidate-budget.v1",
    resolver_id: "scaP12CandidateDeterministicResolver",
    admission_id: "scaP12CandidateAdmission",
    snapshot_id: "scaP12CandidateSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [SCA_P12_FINALIZING_STATE],
    required_visited_states: [SCA_P12_FINALIZING_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: SCA_P12_TERMINAL_SCHEMA,
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

const START_ADMISSION: StartAdmissionV1 = {
  schema_id: SCA_P12_CANDIDATE_START_SCHEMA,
  schema_version: 1,
  prepare(request: StartRequest): PreparedStartV1 {
    const constraints = validateContract(
      ScaP12StartConstraintsV1Schema,
      request.constraints,
      "SCA P12 start constraints"
    );
    if (request.identity.playbook !== SCA_P12_CANDIDATE_PLAYBOOK_NAME) {
      throw new Error("SCA P12 start identity is invalid");
    }
    if (constraints.run_id !== request.identity.run_id) {
      throw new Error("SCA P12 start run identity is invalid");
    }
    const inputs: InputArtifacts | undefined = request.input_artifacts;
    const expected = buildExpectedInputs(constraints);
    // The exact lineage refs are carried by the request constraints. When the caller supplies them as
    // composition inputs they must match exactly, but the contract declares no composition input
    // ports, so the prepared start intentionally omits them and the engine's composition validator is
    // never asked to match an undeclared port.
    if (
      inputs !== undefined &&
      (inputs.artifacts.length !== expected.length ||
        expected.some(
          (entry, index) =>
            inputs.artifacts[index]?.slot !== entry.slot ||
            !same(inputs.artifacts[index]?.ref, entry.ref)
        ))
    ) {
      throw new Error("SCA P12 start inputs do not equal the declared exact lineage refs");
    }
    return {
      schema_id: SCA_P12_CANDIDATE_START_SCHEMA,
      schema_version: 1,
      request,
      goal: request.goal,
      constraints,
      admission_data: constraints,
    };
  },
  materialize(prepared, host) {
    if (host.artifactStore === undefined) {
      throw new Error("SCA P12 materialization requires the artifact host store");
    }
    const constraints = validateContract(
      ScaP12StartConstraintsV1Schema,
      prepared.constraints,
      "SCA P12 start constraints"
    );
    const requestRef = persistJson({
      store: host.artifactStore,
      runId: host.run_id,
      phase: "SCA-P12",
      kind: REQUEST_KIND,
      operationId: "sca-p12-candidate-request",
      schemaId: SCA_P12_CANDIDATE_START_SCHEMA,
      value: constraints,
      upstreamRefs: buildExpectedInputs(constraints).map((entry) => entry.ref),
    });
    return [requestRef];
  },
};

function optional(
  slot: string,
  ref: ArtifactRef | null
): { readonly slot: string; readonly ref: ArtifactRef }[] {
  return ref === null ? [] : [{ slot, ref }];
}

export function buildExpectedInputs(constraints: ScaP12StartConstraintsV1): {
  readonly slot: string;
  readonly ref: ArtifactRef;
}[] {
  return [
    { slot: "p11_terminal", ref: constraints.p11_terminal_ref },
    ...optional("p11_transition", constraints.p11_transition_ref),
    ...optional("p11_admission", constraints.p11_admission_ref),
    { slot: "p10_terminal", ref: constraints.p10_terminal_ref },
    ...optional("p10_transition", constraints.p10_transition_ref),
    ...optional("p10_outcome", constraints.p10_outcome_ref),
    ...optional("p10_gate", constraints.p10_gate_ref),
    ...optional("p10_admission", constraints.p10_admission_ref),
    ...optional("p10_eligibility_ledger", constraints.p10_eligibility_ledger_ref),
    ...optional("p10_candidate_registry", constraints.p10_candidate_registry_ref),
    { slot: "p09_terminal", ref: constraints.p09_terminal_ref },
    ...optional("p09_transition", constraints.p09_transition_ref),
    ...optional("p09_reconciliation_ledger", constraints.p09_reconciliation_ledger_ref),
    ...optional("p09_gate", constraints.p09_gate_ref),
    ...optional("p09_admission", constraints.p09_admission_ref),
    { slot: "p08_terminal", ref: constraints.p08_terminal_ref },
    ...optional("p08_transition", constraints.p08_transition_ref),
    ...optional("p08_evidence_ledger", constraints.p08_evidence_ledger_ref),
    ...optional("p08_gate", constraints.p08_gate_ref),
    ...optional("p08_admission", constraints.p08_admission_ref),
    ...optional("p08_item_universe", constraints.p08_item_universe_ref),
    { slot: "p01_obligation_ledger", ref: constraints.p01_obligation_ledger_ref },
    { slot: "baseline_evidence", ref: constraints.baseline_evidence_ref },
    { slot: "p10_disclosure_scope", ref: constraints.p10_disclosure_scope_ref },
    { slot: "promotion_authority", ref: constraints.promotion_authority_ref },
    ...constraints.active_run_rule_release_refs.map((ref, index) => ({
      slot: `active_run_rule_release_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...optional("p09_coverage_input", constraints.p09_coverage_input_ref),
    ...constraints.p09_phase_evidence_refs.map((ref, index) => ({
      slot: `p09_phase_evidence_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...optional("p09_obligation_resolution", constraints.p09_obligation_resolution_ref),
    ...optional("p09_reassessment", constraints.p09_reassessment_ref),
    ...optional("p10_reassessment", constraints.p10_reassessment_ref),
    ...optional("p10_prior_ledger", constraints.p10_prior_ledger_ref),
    { slot: "p11_disclosure_scope", ref: constraints.p11_disclosure_scope_ref },
    ...optional("p11_repair_disclosure_scope", constraints.p11_repair_disclosure_scope_ref),
    { slot: "scoring_policy", ref: constraints.scoring_policy_ref },
    { slot: "report_policy", ref: constraints.report_policy_ref },
    { slot: "verification_scope", ref: constraints.verification_scope_ref },
    { slot: "verifier_authority", ref: constraints.verifier_authority_ref },
    { slot: "release_authority", ref: constraints.release_authority_ref },
    ...optional("p12_reassessment", constraints.p12_reassessment_ref),
    ...optional("p12_prior_release", constraints.p12_prior_release_ref),
  ];
}

function buildScaP12CandidateRegistration(binding: ScaP12CandidateBindingV1): PlaybookRegistration {
  const registration: PlaybookRegistration = {
    name: SCA_P12_CANDIDATE_PLAYBOOK_NAME,
    contract: SCA_P12_CANDIDATE_SKILL_CONTRACT,
    ingress: "skill" as const,
    start_admission: START_ADMISSION,
    caller_documentation: {
      constraints_schema: ScaP12StartConstraintsV1Schema,
      example: {
        goal: "Run the inactive P12 independent release-verification candidate.",
        constraints: {
          p11_terminal_ref: {},
          p11_transition_ref: null,
          p10_terminal_ref: {},
          p10_transition_ref: null,
          p10_outcome_ref: null,
          p10_gate_ref: null,
          p10_admission_ref: null,
          p10_eligibility_ledger_ref: null,
          p10_candidate_registry_ref: null,
          p09_terminal_ref: {},
          p09_transition_ref: null,
          p09_reconciliation_ledger_ref: null,
          p09_gate_ref: null,
          p09_admission_ref: null,
          p08_terminal_ref: {},
          p08_transition_ref: null,
          p08_evidence_ledger_ref: null,
          p08_gate_ref: null,
          p08_admission_ref: null,
          p08_item_universe_ref: null,
          p01_obligation_ledger_ref: {},
          baseline_evidence_ref: {},
          p10_disclosure_scope_ref: {},
          promotion_authority_ref: {},
          active_run_rule_release_refs: [],
          p09_coverage_input_ref: null,
          p09_phase_evidence_refs: [],
          p09_obligation_resolution_ref: null,
          p09_reassessment_ref: null,
          p10_reassessment_ref: null,
          p10_prior_ledger_ref: null,
          p11_disclosure_scope_ref: {},
          p11_repair_disclosure_scope_ref: null,
          scoring_policy_ref: {},
          report_policy_ref: {},
          verification_scope_ref: {},
          verifier_authority_ref: {},
          release_authority_ref: {},
          p12_reassessment_ref: null,
          p12_prior_release_ref: null,
        },
      },
      semantic_caveat:
        "P12 re-derives the exact P11 report and verifies it with a separated deterministic verifier. It performs no publication and never claims product qualification; a positive release requires the authorized predecessor chain and an exact-bound human approval.",
    },
    liveness: {
      resolver_id: SCA_P12_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
      resolve: () =>
        ordinaryLivenessPolicy({ scope: "sca-p12-candidate", preset: "deterministic-host" }),
      thinking_policy: "agent_ssot" as const,
    },
    worker: {
      kind: "none" as const,
      workflow_name: SCA_P12_CANDIDATE_PLAYBOOK_NAME,
      guidance: SCA_P12_CANDIDATE_SKILL_CONTRACT.guidance,
      guidance_required: true as const,
      result_transport: "host_typed" as const,
      opening_policy: "none" as const,
      model_policy: "none" as const,
      phases: new Map<string, never>(),
    },
    host_states: [
      SCA_P12_ADMITTING_STATE,
      SCA_P12_VERIFYING_STATE,
      SCA_P12_REPLAYING_STATE,
      SCA_P12_FINALIZING_STATE,
    ],
    completionReceiptPredicates: new Map(),
    construct: (options) => {
      if (options.artifactStore === undefined) {
        throw new Error("SCA P12 candidate requires the artifact host store");
      }
      return new ScaP12CandidatePlaybook(
        options.artifactStore,
        binding,
        options.trustedClock ?? (() => new Date())
      );
    },
  };
  return Object.freeze(registration);
}

/**
 * Production composition factory. It requires the exact host-owned current-authority resolvers for
 * the verifier authority, the release authority, and the accepted AC-P01..AC-P11 phase-gate index
 * (ambiguities A2/A5). It installs nothing into any registry or the public `sca` skill.
 */
export function createScaP12VerificationRegistrationV1(input: {
  readonly resolve_current_verifier_authority_ref: (
    scope: ScaP12CurrentAuthorityScopeV1
  ) => ArtifactRef;
  readonly resolve_current_release_authority_ref: (
    scope: ScaP12CurrentAuthorityScopeV1
  ) => ArtifactRef;
  readonly resolve_current_phase_gate_index_ref: (
    scope: ScaP12CurrentAuthorityScopeV1
  ) => ArtifactRef;
  /** Optional host-owned per-phase qualification definition used to fully re-verify each gate. */
  readonly resolve_phase_gate_qualification?: (
    phase_id: string
  ) => ScaPhaseQualificationDefinitionV1 | null;
}): PlaybookRegistration {
  if (typeof input.resolve_current_verifier_authority_ref !== "function") {
    throw new Error(
      "SCA P12 candidate requires an independent current verifier authority resolver"
    );
  }
  if (typeof input.resolve_current_release_authority_ref !== "function") {
    throw new Error("SCA P12 candidate requires an independent current release authority resolver");
  }
  if (typeof input.resolve_current_phase_gate_index_ref !== "function") {
    throw new Error("SCA P12 candidate requires an independent current phase-gate index resolver");
  }
  return buildScaP12CandidateRegistration({
    resolve_current_verifier_authority_ref: input.resolve_current_verifier_authority_ref,
    resolve_current_release_authority_ref: input.resolve_current_release_authority_ref,
    resolve_current_phase_gate_index_ref: input.resolve_current_phase_gate_index_ref,
    ...(input.resolve_phase_gate_qualification === undefined
      ? {}
      : { resolve_phase_gate_qualification: input.resolve_phase_gate_qualification }),
  });
}

/**
 * Fixed provider-free compatibility fixture used by focused tests and by the inactive candidate's
 * absence proof. It resolves no current authority and no phase-gate index, so it is permanently
 * non-positive: it can never reach `released_complete` from fixture or synthetic lineage (A1).
 */
export const SCA_P12_CANDIDATE_REGISTRATION: PlaybookRegistration =
  buildScaP12CandidateRegistration({});

export const SCA_P12_CANDIDATE_MODEL_IDENTITY = SCA_P12_REQUIRED_MODEL;
export type {
  ScaP12GateV1,
  ScaP12LaneV1,
  ScaP12PhaseGateIndexV1,
  ScaP12ReleaseApprovalV1,
  ScaP12ReleaseAuthorityV1,
  ScaP12ReleaseRecordV1,
  ScaP12TerminalV1,
  ScaP12VerificationScopeV1,
  ScaP12VerifierAuthorityV1,
} from "./p12-contracts.js";
export type { ScaP12AdmissionResultV1 } from "./p12-admission.js";
