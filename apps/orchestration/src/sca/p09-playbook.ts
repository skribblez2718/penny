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
} from "../contracts.js";
import type { RunContext } from "../context.js";
import { ordinaryLivenessPolicy } from "../liveness.js";
import type { Playbook } from "../playbooks/playbook.js";
import type {
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import {
  admitScaP09Reconciliation,
  type ScaP09AdmissionResultV1,
  type ScaP09CurrentObligationHeadScopeV1,
} from "./p09-admission.js";
import { reconcileScaP09, type ScaP09ReconciliationResultV1 } from "./p09-reconcile.js";
import {
  SCA_P09_ADMISSION_SCHEMA,
  SCA_P09_CANCELLED_STATE,
  SCA_P09_CHECKPOINT_SCHEMA,
  SCA_P09_DOWNSTREAM_OBLIGATION_IDS,
  SCA_P09_FINAL_STATE,
  SCA_P09_GATE_SCHEMA,
  SCA_P09_MISSING_DOWNSTREAM_ARTIFACTS,
  SCA_P09_RECONCILIATION_LEDGER_SCHEMA,
  SCA_P09_RECONCILING_STATE,
  SCA_P09_REASSESSMENT_SCHEMA,
  SCA_P09_TERMINAL_SCHEMA,
  SCA_P09_TO_P10_TRANSITION_SCHEMA,
  validateScaP09CheckpointV1,
  validateScaP09GateV1,
  validateScaP09ReassessmentV1,
  validateScaP09ReconciliationLedgerV1,
  validateScaP09TerminalV1,
  validateScaP09ToP10TransitionV1,
  withP09Digest,
  type ScaP09GateV1,
  type ScaP09ReassessmentV1,
  type ScaP09ReconciliationLedgerV1,
  type ScaP09TerminalV1,
} from "./p09-contracts.js";
import type { ScaP07CurrentAuthorityScopeV1 } from "./p07-admission.js";

/**
 * Inactive candidate only. This module is deliberately absent from `PLAYBOOK_REGISTRY` and
 * `SCA_PHASE_REGISTRY`: a registration here is a construction, not an accepted P09 phase.
 *
 * P09 is host automation (`SCA-P09` owner). It makes zero model calls, zero tool calls, and no
 * provider dispatch, declares no host operation, and closes on an always non-positive terminal.
 */
export const SCA_P09_CANDIDATE_PLAYBOOK_NAME = "sca-p09-candidate" as const;
export const SCA_P09_START_V1_SCHEMA = "penny.sca-p09-candidate-start.v1" as const;
export const SCA_P09_REQUEST_KIND = "sca-p09-candidate-request" as const;

const PRODUCER = "host:sca-p09-candidate" as const;
const P09_PHASE = "SCA-P09" as const;
const ADMISSION_KIND = "sca-p09-admission" as const;
const CHECKPOINT_KIND = "sca-p09-checkpoint" as const;
const LEDGER_KIND = "sca-p09-reconciliation-ledger" as const;
const GATE_KIND = "sca-p09-gate" as const;
const HANDOFF_KIND = "sca-p09-to-p10-transition" as const;
const TERMINAL_KIND = "sca-p09-terminal" as const;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0
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
    throw new Error(`P09 ${label} exact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P09 ${label} exact bytes drifted`);
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
  if (canonicalJson(value) !== text) throw new Error(`P09 ${label} is not canonical JSON`);
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
  /** False for repeated `(run, phase, kind)` artifacts; the owner selects one per kind. */
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
      throw new Error(`P09 artifact '${input.operationId}' conflicts with immutable prior bytes`);
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

const ScaP09StartConstraintsV1Schema = Type.Object(
  {
    p08_terminal_ref: ArtifactRefSchema,
    p08_transition_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p08_evidence_ledger_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p08_gate_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p08_admission_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p08_item_universe_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p01_obligation_ledger_ref: ArtifactRefSchema,
    p09_coverage_input_ref: Type.Optional(Type.Union([ArtifactRefSchema, Type.Null()])),
    p09_phase_evidence_refs: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 256 })),
    p09_obligation_resolution_ref: Type.Optional(Type.Union([ArtifactRefSchema, Type.Null()])),
    p09_reassessment_ref: Type.Optional(Type.Union([ArtifactRefSchema, Type.Null()])),
  },
  { additionalProperties: false, $id: SCA_P09_START_V1_SCHEMA }
);
type ScaP09StartConstraintsV1 = Readonly<Static<typeof ScaP09StartConstraintsV1Schema>>;

const P09DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    reassessment_ref: Type.Optional(ArtifactRefSchema),
  },
  { additionalProperties: false }
);
type P09Data = Readonly<Static<typeof P09DataSchema>>;
function data(context: RunContext): P09Data {
  return validateContract(P09DataSchema, context.playbookData, "SCA P09 durable state");
}

export interface ScaP09CandidateBindingV1 {
  /**
   * Independent resolver of the current P07 execution authority. Absent only for the exported
   * provider-free compatibility fixture, which re-derives the recorded P07 admission against the
   * P07 ledger's own authority bytes.
   */
  readonly resolve_current_p07_authority_ref?: (
    scope: ScaP07CurrentAuthorityScopeV1
  ) => ArtifactRef;
  /**
   * Independent resolver of the current P01 obligation-ledger head. Absent only for the
   * provider-free fixture, which revalidates the supplied ledger's own append-only chain and
   * records reduced assurance rather than claiming fork-safety.
   */
  readonly resolve_current_p01_obligation_head_ref?: (
    scope: ScaP09CurrentObligationHeadScopeV1
  ) => ArtifactRef;
}

export class ScaP09CandidatePlaybook implements Playbook {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly binding: ScaP09CandidateBindingV1 = {},
    private readonly trustedClock: () => Date = () => new Date()
  ) {}

  initialize(context: RunContext): Directive {
    const state = this.initializeState(context);
    return state;
  }

  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    if (context.stateId === SCA_P09_FINAL_STATE) return this.finalizeFromState(context);
    throw new Error(`SCA P09 has no dispatch for '${context.stateId}'`);
  }

  resume(): Directive {
    throw new Error("SCA P09 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = SCA_P09_CANCELLED_STATE;
    context.status = "cancelled";
    context.met = false;
    const terminal = validateScaP09TerminalV1(
      withP09Digest(
        {
          schema_id: SCA_P09_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P09_PHASE,
          status: "cancelled" as const,
          reconciliation_ledger_ref: null,
          gate_ref: null,
          p10_transition_ref: null,
          p10_handoff_ready: false,
          item_count: 0,
          kind_counts: [],
          disposition_counts: [],
          required_result_total: 0,
          required_result_resolved: 0,
          eligible_refs: [],
          ineligible_refs: [],
          missing_downstream_artifacts: [...SCA_P09_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: [...SCA_P09_DOWNSTREAM_OBLIGATION_IDS],
          selected_artifact_refs: this.selectedCoreRefs(context),
          blocker_codes: ["p09_cancelled"],
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          p12_release_authorized: false as const,
          report_or_release_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    void reason;
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P09_PHASE,
      kind: TERMINAL_KIND,
      operationId: "sca-p09-terminal-cancelled",
      schemaId: SCA_P09_TERMINAL_SCHEMA,
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
    if (context.stateId === SCA_P09_FINAL_STATE) {
      try {
        return this.finalizeFromState(context);
      } catch {
        return this.finalizeNonPositive(context, "p09_restart_finalization_failed");
      }
    }
    return null;
  }

  acceptSummary(): Directive {
    throw new Error("SCA P09 deterministic candidate never accepts worker summaries");
  }

  private initializeState(context: RunContext): Directive {
    const runId = context.identity.run_id;
    const requestRef = latestSelected(
      context,
      (ref) => ref.kind === SCA_P09_REQUEST_KIND && ref.run_id === runId
    );
    if (requestRef === undefined) throw new Error("SCA P09 admitted request is absent");
    const constraints = validateContract(
      ScaP09StartConstraintsV1Schema,
      exactJson(this.store, requestRef, "candidate request", (value) => value),
      "SCA P09 start constraints"
    );
    const admitted = this.readmit(runId, constraints);
    const admissionRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P09_PHASE,
      kind: ADMISSION_KIND,
      operationId: "sca-p09-admission",
      schemaId: SCA_P09_ADMISSION_SCHEMA,
      value: admitted.admission,
      upstreamRefs: uniqueRefs([requestRef, ...admitted.evidence_refs]),
    });
    Object.assign(context.playbookData, {
      request_ref: requestRef,
      admission_ref: admissionRef,
      ...(constraints.p09_reassessment_ref === undefined ||
      constraints.p09_reassessment_ref === null
        ? {}
        : { reassessment_ref: constraints.p09_reassessment_ref }),
    });
    if (admitted.non_reconcilable) {
      context.transition(SCA_P09_FINAL_STATE);
      return this.finalizeNonPositive(
        context,
        admitted.non_reconcilable_reason ?? "p09_non_reconcilable_p08_checkpoint"
      );
    }
    context.transition(SCA_P09_RECONCILING_STATE);
    context.transition(SCA_P09_FINAL_STATE);
    return this.finalize(context, admitted);
  }

  private finalizeFromState(context: RunContext): Directive {
    const state = data(context);
    const constraints = validateContract(
      ScaP09StartConstraintsV1Schema,
      exactJson(this.store, state.request_ref, "candidate request", (value) => value),
      "SCA P09 start constraints"
    );
    const admitted = this.readmit(context.identity.run_id, constraints);
    if (admitted.non_reconcilable) {
      return this.finalizeNonPositive(
        context,
        admitted.non_reconcilable_reason ?? "p09_non_reconcilable_p08_checkpoint"
      );
    }
    return this.finalize(context, admitted);
  }

  private readmit(runId: string, constraints: ScaP09StartConstraintsV1): ScaP09AdmissionResultV1 {
    const base = {
      store: this.store,
      run_id: runId,
      p08_terminal_ref: constraints.p08_terminal_ref as ArtifactRef,
      p08_transition_ref: (constraints.p08_transition_ref as ArtifactRef | null) ?? null,
      p08_evidence_ledger_ref: constraints.p08_evidence_ledger_ref ?? null,
      p08_gate_ref: constraints.p08_gate_ref ?? null,
      p08_admission_ref: constraints.p08_admission_ref ?? null,
      p08_item_universe_ref: constraints.p08_item_universe_ref ?? null,
      p01_obligation_ledger_ref: constraints.p01_obligation_ledger_ref,
      coverage_input_ref: constraints.p09_coverage_input_ref ?? null,
      phase_evidence_refs: constraints.p09_phase_evidence_refs ?? [],
      obligation_resolution_ref: constraints.p09_obligation_resolution_ref ?? null,
    };
    const p07 = this.binding.resolve_current_p07_authority_ref;
    const p01 = this.binding.resolve_current_p01_obligation_head_ref;
    return admitScaP09Reconciliation({
      ...base,
      ...(p07 === undefined ? {} : { resolve_current_p07_authority_ref: p07 }),
      ...(p01 === undefined ? {} : { resolve_current_p01_obligation_head_ref: p01 }),
    });
  }

  private persistCheckpoints(
    context: RunContext,
    admitted: ScaP09AdmissionResultV1
  ): ReadonlyMap<string, ArtifactRef> {
    const refs = new Map<string, ArtifactRef>();
    for (const item of admitted.items) {
      if (item.checkpoint_needed === null) continue;
      const checkpoint = validateScaP09CheckpointV1(
        withP09Digest(
          {
            schema_id: SCA_P09_CHECKPOINT_SCHEMA,
            schema_version: 1 as const,
            phase_id: P09_PHASE,
            run_id: admitted.admission.run_id,
            item_id: item.item_id,
            item_kind: item.item_kind,
            identity: item.identity,
            reason_code: item.checkpoint_needed.reason_code,
            primary_ref: item.primary_ref,
            missing_evidence_need: item.checkpoint_needed.missing_evidence_need,
            reopen_condition: item.checkpoint_needed.reopen_condition,
          },
          "checkpoint_sha256"
        )
      );
      const ref = persistJson({
        store: this.store,
        context,
        runId: admitted.admission.run_id,
        phase: P09_PHASE,
        kind: CHECKPOINT_KIND,
        operationId: `sca-p09-checkpoint-${item.item_id}`,
        schemaId: SCA_P09_CHECKPOINT_SCHEMA,
        value: checkpoint,
        upstreamRefs: [item.primary_ref],
        select: false,
      });
      refs.set(item.item_id, ref);
    }
    return refs;
  }

  private finalize(context: RunContext, admitted: ScaP09AdmissionResultV1): Directive {
    const state = data(context);
    const reassessmentRef = state.reassessment_ref ?? null;
    const reassessment = this.readReassessment(reassessmentRef);
    const priorLedgerRef = reassessment === null ? null : reassessment.prior_p09_ledger_ref;
    const priorLedger =
      priorLedgerRef === null
        ? null
        : exactJson(
            this.store,
            priorLedgerRef,
            "prior reconciliation ledger",
            validateScaP09ReconciliationLedgerV1
          );
    if (priorLedger !== null) {
      for (const ref of reassessment?.stimulus_refs ?? []) exactBytes(this.store, ref, "stimulus");
    }
    const checkpointRefs = this.persistCheckpoints(context, admitted);
    const reconciliation = reconcileScaP09({
      admitted,
      reassessment,
      prior_ledger: priorLedger,
      prior_ledger_ref: priorLedgerRef,
      checkpoint_refs_by_item_id: checkpointRefs,
    });
    return this.persistFinalization(context, admitted, reconciliation, priorLedger, priorLedgerRef);
  }

  private readReassessment(ref: ArtifactRef | null): ScaP09ReassessmentV1 | null {
    if (ref === null) return null;
    const reassessment = exactJson(this.store, ref, "reassessment", validateScaP09ReassessmentV1);
    if (ref.content_schema?.schema_id !== SCA_P09_REASSESSMENT_SCHEMA) {
      throw new Error("SCA P09 reassessment schema binding mismatch");
    }
    return reassessment;
  }

  private stableEvaluatedAt(admitted: ScaP09AdmissionResultV1): string {
    const stable = admitted.p08_gate?.evaluated_at ?? admitted.p01_ledger?.created_at;
    if (stable === undefined) {
      throw new Error("SCA P09 has no admitted stable timestamp to derive its gate evaluation");
    }
    return stable;
  }

  private persistFinalization(
    context: RunContext,
    admitted: ScaP09AdmissionResultV1,
    reconciliation: ScaP09ReconciliationResultV1,
    priorLedger: ScaP09ReconciliationLedgerV1 | null,
    priorLedgerRef: ArtifactRef | null
  ): Directive {
    const runId = context.identity.run_id;
    const evaluatedAt = this.stableEvaluatedAt(admitted);
    const revision = priorLedger === null ? 1 : (priorLedger.ledger_revision ?? 1) + 1;
    const lane = reconciliation.lane;
    const ledger = validateScaP09ReconciliationLedgerV1(
      withP09Digest(
        {
          schema_id: SCA_P09_RECONCILIATION_LEDGER_SCHEMA,
          schema_version: 1 as const,
          phase_id: P09_PHASE,
          run_id: runId,
          admission_ref: this.admissionRef(context),
          p08_terminal_ref: admitted.admission.p08_terminal_ref,
          p08_transition_ref: admitted.admission.p08_transition_ref,
          p08_evidence_ledger_ref: admitted.admission.p08_evidence_ledger_ref,
          p08_gate_ref: admitted.admission.p08_gate_ref,
          p08_item_universe_ref: admitted.admission.p08_item_universe_ref,
          p01_obligation_ledger_ref: admitted.admission.p01_obligation_ledger_ref,
          coverage_input_ref: admitted.admission.coverage_input_ref,
          ...(lane === null ? {} : { lane }),
          prior_p09_ledger_ref: priorLedgerRef,
          prior_p09_ledger_sha256: priorLedgerRef === null ? null : priorLedgerRef.content_digest,
          ledger_revision: revision,
          append_only: true as const,
          items: [...reconciliation.items],
          item_count: reconciliation.items.length,
          kind_counts: [...reconciliation.kind_counts],
          disposition_counts: [...reconciliation.disposition_counts],
          required_result_total: reconciliation.required_result_total,
          required_result_resolved: reconciliation.required_result_resolved,
          downstream_pending_required_result_ids: [
            ...reconciliation.downstream_pending_required_result_ids,
          ],
          unresolved_item_refs: [...reconciliation.unresolved_item_refs],
          eligible_refs: [...reconciliation.eligible_refs],
          ineligible_refs: [...reconciliation.ineligible_refs],
          exhaustive_accounting: true as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          blocker_codes: [...reconciliation.blocker_codes],
        },
        "ledger_sha256"
      )
    );
    const ledgerRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P09_PHASE,
      kind: LEDGER_KIND,
      operationId:
        revision === 1
          ? "sca-p09-reconciliation-ledger"
          : `sca-p09-reconciliation-ledger-revision-${String(revision).padStart(6, "0")}`,
      schemaId: SCA_P09_RECONCILIATION_LEDGER_SCHEMA,
      value: ledger,
      upstreamRefs: [
        admitted.admission.p08_terminal_ref,
        ...(admitted.admission.p08_evidence_ledger_ref === null
          ? []
          : [admitted.admission.p08_evidence_ledger_ref]),
        admitted.admission.p01_obligation_ledger_ref,
        ...(admitted.admission.coverage_input_ref === null
          ? []
          : [admitted.admission.coverage_input_ref]),
      ],
    });
    const verdict: ScaP09GateV1["verdict"] =
      lane === "accepted_progression"
        ? "pass_ready"
        : lane === "incomplete_closeout"
          ? "pass_blocked"
          : "blocked_invalid";
    const gate = validateScaP09GateV1(
      withP09Digest(
        {
          schema_id: SCA_P09_GATE_SCHEMA,
          schema_version: 1 as const,
          phase_id: P09_PHASE,
          criterion_id: "AC-P09" as const,
          verdict,
          reconciliation_ledger_ref: ledgerRef,
          p08_terminal_ref: admitted.admission.p08_terminal_ref,
          p08_evidence_ledger_ref: admitted.admission.p08_evidence_ledger_ref,
          p08_gate_ref: admitted.admission.p08_gate_ref,
          ...(lane === null ? {} : { lane }),
          exhaustive_accounting: reconciliation.predicates.exhaustive_accounting,
          immutable_p08_lineage_valid: reconciliation.predicates.immutable_p08_lineage_valid,
          set_equality_valid: reconciliation.predicates.set_equality_valid,
          effective_class_derivation_valid:
            reconciliation.predicates.effective_class_derivation_valid,
          no_underclassification: reconciliation.predicates.no_underclassification,
          no_post_failure_downgrade: reconciliation.predicates.no_post_failure_downgrade,
          no_late_unregistered_action: reconciliation.predicates.no_late_unregistered_action,
          no_conflicting_replay: reconciliation.predicates.no_conflicting_replay,
          coverage_reconciled: reconciliation.predicates.coverage_reconciled,
          append_only_revisions: reconciliation.predicates.append_only_revisions,
          eligible_handoff_only: reconciliation.predicates.eligible_handoff_only,
          downstream_accounting_present: reconciliation.predicates.downstream_accounting_present,
          p12_or_release_claims_absent: reconciliation.predicates.p12_or_release_claims_absent,
          p01_head_attested: admitted.admission.p01_head_attested,
          p08_authority_attested: admitted.p08_authority_assurance === "attested_unchanged",
          retained_required_gaps:
            reconciliation.required_result_total > reconciliation.required_result_resolved,
          item_count: reconciliation.items.length,
          required_result_total: reconciliation.required_result_total,
          required_result_resolved: reconciliation.required_result_resolved,
          required_result_downstream_pending:
            reconciliation.downstream_pending_required_result_ids.length,
          blocker_codes: [...reconciliation.blocker_codes],
          evaluated_at: evaluatedAt,
        },
        "gate_sha256"
      )
    );
    const gateRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P09_PHASE,
      kind: GATE_KIND,
      operationId:
        revision === 1
          ? "sca-p09-gate"
          : `sca-p09-gate-revision-${String(revision).padStart(6, "0")}`,
      schemaId: SCA_P09_GATE_SCHEMA,
      value: gate,
      upstreamRefs: [ledgerRef],
    });

    let handoffRef: ArtifactRef | null = null;
    if (lane !== null) {
      const handoff = validateScaP09ToP10TransitionV1(
        withP09Digest(
          {
            schema_id: SCA_P09_TO_P10_TRANSITION_SCHEMA,
            schema_version: 1 as const,
            source_phase_id: P09_PHASE,
            target_phase_id: "SCA-P10" as const,
            handoff_kind: "reconciled_eligible_evidence_only" as const,
            qualification_scope: "reconciliation_gate_only_not_p10_learning" as const,
            phase_gate_passed: false as const,
            p10_rule_learning_authorized_by_this_transition: false as const,
            release_eligible: false as const,
            campaign_complete: false as const,
            campaign_completion_claimed: false as const,
            p08_terminal_ref: admitted.admission.p08_terminal_ref,
            p08_transition_ref: admitted.admission.p08_transition_ref,
            p08_evidence_ledger_ref: admitted.admission.p08_evidence_ledger_ref,
            p09_reconciliation_ledger_ref: ledgerRef,
            lane,
            eligible_refs: [...reconciliation.eligible_refs],
            ineligible_refs: [...reconciliation.ineligible_refs],
            unresolved_item_refs: [...reconciliation.unresolved_item_refs],
            required_gaps_retained: true as const,
          },
          "transition_sha256"
        )
      );
      handoffRef = persistJson({
        store: this.store,
        context,
        runId,
        phase: P09_PHASE,
        kind: HANDOFF_KIND,
        operationId:
          revision === 1
            ? "sca-p09-to-p10-transition"
            : `sca-p09-to-p10-transition-revision-${String(revision).padStart(6, "0")}`,
        schemaId: SCA_P09_TO_P10_TRANSITION_SCHEMA,
        value: handoff,
        upstreamRefs: [ledgerRef, gateRef],
      });
    }

    const status: ScaP09TerminalV1["status"] = lane ?? "blocked_invalid";
    const terminal = validateScaP09TerminalV1(
      withP09Digest(
        {
          schema_id: SCA_P09_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P09_PHASE,
          status,
          reconciliation_ledger_ref: ledgerRef,
          gate_ref: gateRef,
          p10_transition_ref: handoffRef,
          p10_handoff_ready: handoffRef !== null,
          ...(lane === null ? {} : { lane }),
          item_count: reconciliation.items.length,
          kind_counts: [...reconciliation.kind_counts],
          disposition_counts: [...reconciliation.disposition_counts],
          required_result_total: reconciliation.required_result_total,
          required_result_resolved: reconciliation.required_result_resolved,
          eligible_refs: [...reconciliation.eligible_refs],
          ineligible_refs: [...reconciliation.ineligible_refs],
          missing_downstream_artifacts: [...SCA_P09_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: uniqueStrings([
            ...SCA_P09_DOWNSTREAM_OBLIGATION_IDS,
            ...reconciliation.downstream_pending_required_result_ids,
          ]),
          selected_artifact_refs: uniqueRefs([
            this.admissionRef(context),
            ledgerRef,
            gateRef,
            ...(handoffRef === null ? [] : [handoffRef]),
            ...this.selectedCoreRefs(context),
          ]).slice(0, 128),
          blocker_codes: [...reconciliation.blocker_codes],
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          p12_release_authorized: false as const,
          report_or_release_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P09_PHASE,
      kind: TERMINAL_KIND,
      operationId:
        revision === 1
          ? "sca-p09-terminal"
          : `sca-p09-terminal-revision-${String(revision).padStart(6, "0")}`,
      schemaId: SCA_P09_TERMINAL_SCHEMA,
      value: terminal,
      upstreamRefs: [ledgerRef, gateRef, ...(handoffRef === null ? [] : [handoffRef])],
    });
    context.status = "incomplete";
    context.met = false;
    const directive = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: terminal,
      artifacts: uniqueRefs([
        this.admissionRef(context),
        ledgerRef,
        gateRef,
        ...(handoffRef === null ? [] : [handoffRef]),
        terminalRef,
        ...this.selectedCoreRefs(context),
      ]).slice(0, 128),
      unresolved:
        lane === "accepted_progression"
          ? [
              "SCA-P10 learning remains separately admitted; no report, release, or campaign completion is claimed.",
            ]
          : terminal.blocker_codes.length > 0
            ? terminal.blocker_codes
            : ["p09_incomplete_closeout_retains_required_gaps"],
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private finalizeNonPositive(context: RunContext, blocker: string): Directive {
    const runId = context.identity.run_id;
    const now = this.trustedClock().toISOString();
    const terminal = validateScaP09TerminalV1(
      withP09Digest(
        {
          schema_id: SCA_P09_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P09_PHASE,
          status: "incomplete_closeout" as const,
          reconciliation_ledger_ref: null,
          gate_ref: null,
          p10_transition_ref: null,
          p10_handoff_ready: false,
          item_count: 0,
          kind_counts: [],
          disposition_counts: [],
          required_result_total: 0,
          required_result_resolved: 0,
          eligible_refs: [],
          ineligible_refs: [],
          missing_downstream_artifacts: [...SCA_P09_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: [...SCA_P09_DOWNSTREAM_OBLIGATION_IDS],
          selected_artifact_refs: this.selectedCoreRefs(context),
          blocker_codes: [blocker],
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          p12_release_authorized: false as const,
          report_or_release_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    void now;
    void runId;
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P09_PHASE,
      kind: TERMINAL_KIND,
      operationId: "sca-p09-terminal",
      schemaId: SCA_P09_TERMINAL_SCHEMA,
      value: terminal,
      upstreamRefs: this.selectedCoreRefs(context),
    });
    context.status = "incomplete";
    context.met = false;
    const directive = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: terminal,
      artifacts: uniqueRefs([terminalRef, ...this.selectedCoreRefs(context)]).slice(0, 128),
      unresolved: terminal.blocker_codes,
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private admissionRef(context: RunContext): ArtifactRef {
    const ref = latestSelected(context, (candidate) => candidate.kind === ADMISSION_KIND);
    if (ref === undefined) throw new Error("SCA P09 admission artifact is absent");
    return ref;
  }

  private selectedCoreRefs(context: RunContext): ArtifactRef[] {
    const kinds = new Set<string>([
      SCA_P09_REQUEST_KIND,
      ADMISSION_KIND,
      CHECKPOINT_KIND,
      LEDGER_KIND,
      GATE_KIND,
      HANDOFF_KIND,
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

export const SCA_P09_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: SCA_P09_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Reconcile every known campaign item exactly once from the exact recorded P08 disposition result and the admitted P01 obligation ledger, derive immutable effective obligation classes, determine one explicit lane, and emit a derived readiness gate, an eligible-only non-authorizing P10 handoff, and durable non-positive terminal accounting — with zero model, tool, provider, or host-operation calls.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: SCA_P09_START_V1_SCHEMA,
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
        name: "p09_admission",
        kind: ADMISSION_KIND,
        schema: SCA_P09_ADMISSION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p09_reconciliation_ledger",
        kind: LEDGER_KIND,
        schema: SCA_P09_RECONCILIATION_LEDGER_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p09_gate",
        kind: GATE_KIND,
        schema: SCA_P09_GATE_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p09_to_p10_transition",
        kind: HANDOFF_KIND,
        schema: SCA_P09_TO_P10_TRANSITION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p09_terminal",
        kind: TERMINAL_KIND,
        schema: SCA_P09_TERMINAL_SCHEMA,
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
    policy_id: "penny.sca-p09-candidate-budget.v1",
    resolver_id: "scaP09CandidateDeterministicResolver",
    admission_id: "scaP09CandidateAdmission",
    snapshot_id: "scaP09CandidateSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [SCA_P09_FINAL_STATE],
    required_visited_states: [SCA_P09_FINAL_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: SCA_P09_TERMINAL_SCHEMA,
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

const START_ADMISSION: StartAdmissionV1 = {
  schema_id: SCA_P09_START_V1_SCHEMA,
  schema_version: 1,
  prepare(request: StartRequest): PreparedStartV1 {
    const constraints = validateContract(
      ScaP09StartConstraintsV1Schema,
      request.constraints,
      "SCA P09 start constraints"
    );
    if (request.identity.playbook !== SCA_P09_CANDIDATE_PLAYBOOK_NAME) {
      throw new Error("SCA P09 start identity is invalid");
    }
    const inputs: InputArtifacts | undefined = request.input_artifacts;
    const expected = buildExpectedInputs(constraints);
    if (
      inputs === undefined ||
      inputs.artifacts.length !== expected.length ||
      expected.some(
        (entry, index) =>
          inputs.artifacts[index]?.slot !== entry.slot ||
          !same(inputs.artifacts[index]?.ref, entry.ref)
      )
    ) {
      throw new Error("SCA P09 start inputs do not equal the declared exact lineage refs");
    }
    return {
      schema_id: SCA_P09_START_V1_SCHEMA,
      schema_version: 1,
      request,
      goal: request.goal,
      constraints,
      input_artifacts: inputs,
      admission_data: constraints,
    };
  },
  materialize(prepared, host) {
    if (host.artifactStore === undefined || prepared.input_artifacts === undefined) {
      throw new Error("SCA P09 materialization requires artifact store and exact inputs");
    }
    const constraints = validateContract(
      ScaP09StartConstraintsV1Schema,
      prepared.constraints,
      "SCA P09 start constraints"
    );
    const requestRef = persistJson({
      store: host.artifactStore,
      runId: host.run_id,
      phase: P09_PHASE,
      kind: SCA_P09_REQUEST_KIND,
      operationId: "sca-p09-candidate-request",
      schemaId: SCA_P09_START_V1_SCHEMA,
      value: constraints,
      upstreamRefs: buildExpectedInputs(constraints).map((entry) => entry.ref),
    });
    return [requestRef];
  },
};

function buildExpectedInputs(
  constraints: ScaP09StartConstraintsV1
): { readonly slot: string; readonly ref: ArtifactRef }[] {
  return [
    { slot: "p08_terminal", ref: constraints.p08_terminal_ref as ArtifactRef },
    ...(constraints.p08_transition_ref === null || constraints.p08_transition_ref === undefined
      ? []
      : [{ slot: "p08_transition", ref: constraints.p08_transition_ref as ArtifactRef }]),
    ...(constraints.p08_evidence_ledger_ref === null ||
    constraints.p08_evidence_ledger_ref === undefined
      ? []
      : [{ slot: "p08_evidence_ledger", ref: constraints.p08_evidence_ledger_ref as ArtifactRef }]),
    ...(constraints.p08_gate_ref === null || constraints.p08_gate_ref === undefined
      ? []
      : [{ slot: "p08_gate", ref: constraints.p08_gate_ref as ArtifactRef }]),
    ...(constraints.p08_admission_ref === null || constraints.p08_admission_ref === undefined
      ? []
      : [{ slot: "p08_admission", ref: constraints.p08_admission_ref as ArtifactRef }]),
    ...(constraints.p08_item_universe_ref === null ||
    constraints.p08_item_universe_ref === undefined
      ? []
      : [{ slot: "p08_item_universe", ref: constraints.p08_item_universe_ref as ArtifactRef }]),
    { slot: "p01_obligation_ledger", ref: constraints.p01_obligation_ledger_ref },
    ...(constraints.p09_coverage_input_ref === null ||
    constraints.p09_coverage_input_ref === undefined
      ? []
      : [{ slot: "p09_coverage_input", ref: constraints.p09_coverage_input_ref as ArtifactRef }]),
    ...(constraints.p09_phase_evidence_refs ?? []).map((ref, index) => ({
      slot: `p09_phase_evidence_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...(constraints.p09_obligation_resolution_ref === null ||
    constraints.p09_obligation_resolution_ref === undefined
      ? []
      : [
          {
            slot: "p09_obligation_resolution",
            ref: constraints.p09_obligation_resolution_ref as ArtifactRef,
          },
        ]),
    ...(constraints.p09_reassessment_ref === null || constraints.p09_reassessment_ref === undefined
      ? []
      : [{ slot: "p09_reassessment", ref: constraints.p09_reassessment_ref as ArtifactRef }]),
  ];
}

function buildScaP09CandidateRegistration(binding: ScaP09CandidateBindingV1): PlaybookRegistration {
  const registration: PlaybookRegistration = {
    name: SCA_P09_CANDIDATE_PLAYBOOK_NAME,
    contract: SCA_P09_CANDIDATE_SKILL_CONTRACT,
    ingress: "skill" as const,
    start_admission: START_ADMISSION,
    caller_documentation: {
      constraints_schema: ScaP09StartConstraintsV1Schema,
      example: {
        goal: "Run the inactive P09 obligation-and-coverage reconciliation candidate.",
        constraints: {
          p08_terminal_ref: {},
          p08_transition_ref: null,
          p08_evidence_ledger_ref: null,
          p08_gate_ref: null,
          p08_admission_ref: null,
          p08_item_universe_ref: null,
          p01_obligation_ledger_ref: {},
        },
      },
      semantic_caveat:
        "P09 reconciles the exact admitted P08 result and P01 obligation ledger. It does not run P07/P08 again, gather evidence, learn rules, report, release, or complete a campaign, and it never claims public success.",
    },
    liveness: {
      resolver_id: SCA_P09_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
      resolve: () =>
        ordinaryLivenessPolicy({ scope: "sca-p09-candidate", preset: "deterministic-host" }),
      thinking_policy: "agent_ssot" as const,
    },
    worker: {
      kind: "none" as const,
      workflow_name: SCA_P09_CANDIDATE_PLAYBOOK_NAME,
      guidance: SCA_P09_CANDIDATE_SKILL_CONTRACT.guidance,
      guidance_required: true as const,
      result_transport: "host_typed" as const,
      opening_policy: "none" as const,
      model_policy: "none" as const,
      phases: new Map<string, never>(),
    },
    host_states: [SCA_P09_RECONCILING_STATE, SCA_P09_FINAL_STATE],
    completionReceiptPredicates: new Map(),
    construct: (options) => {
      if (options.artifactStore === undefined) {
        throw new Error("SCA P09 candidate requires the artifact host store");
      }
      return new ScaP09CandidatePlaybook(
        options.artifactStore,
        binding,
        options.trustedClock ?? (() => new Date())
      );
    },
  };
  return Object.freeze(registration);
}

/**
 * Production composition factory. It requires an independent current P07 execution-authority
 * resolver and an independent current P01 obligation-ledger head resolver; both attestations are
 * host-owned and never caller- or artifact-selected.
 */
export function createScaP09CandidateRegistrationV1(input: {
  readonly resolve_current_p07_authority_ref: (scope: ScaP07CurrentAuthorityScopeV1) => ArtifactRef;
  readonly resolve_current_p01_obligation_head_ref: (
    scope: ScaP09CurrentObligationHeadScopeV1
  ) => ArtifactRef;
}): PlaybookRegistration {
  if (typeof input.resolve_current_p07_authority_ref !== "function") {
    throw new Error("SCA P09 candidate requires an independent current P07 authority resolver");
  }
  if (typeof input.resolve_current_p01_obligation_head_ref !== "function") {
    throw new Error("SCA P09 candidate requires an independent P01 obligation-head resolver");
  }
  return buildScaP09CandidateRegistration({
    resolve_current_p07_authority_ref: input.resolve_current_p07_authority_ref,
    resolve_current_p01_obligation_head_ref: input.resolve_current_p01_obligation_head_ref,
  });
}

/**
 * Fixed provider-free compatibility fixture used by focused tests. It resolves neither the current
 * P07 authority nor the current P01 obligation-ledger head, so the admission records
 * reduced-assurance P01 fork posture (`unattested_chain_revalidated`) and never claims fork-safety.
 */
export const SCA_P09_CANDIDATE_REGISTRATION: PlaybookRegistration =
  buildScaP09CandidateRegistration({});
