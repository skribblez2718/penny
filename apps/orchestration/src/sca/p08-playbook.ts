import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type InputArtifacts,
  type JsonValue,
  type LivenessSnapshotV1,
  type LivenessTerminalReason,
  type OutputArtifactMetadata,
  type SkillContract,
  type StartRequest,
  validateContract,
  validateDirective,
} from "../contracts.js";
import type { RunContext } from "../context.js";
import type { Playbook } from "../playbooks/playbook.js";
import type {
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import {
  assertResolvedModelIdentity,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
  validateModelDispatchGuardV1,
  validateModelExecutionReceiptV1,
} from "../required-model.js";
import {
  admitScaP08Disposition,
  type ScaP08AdmittedItemV1,
  type ScaP08AdmissionResultV1,
  type ScaP08PriorItemV1,
} from "./p08-admission.js";
import {
  SCA_P08_ADMISSION_SCHEMA,
  SCA_P08_ASSESSING_STATE,
  SCA_P08_ASSESSMENT_CALL_ID,
  SCA_P08_ASSESSMENT_SCHEMA,
  SCA_P08_ASSESSOR_AGENT,
  SCA_P08_CANCELLED_STATE,
  SCA_P08_COGNITIVE_PAYLOAD_SCHEMA,
  SCA_P08_CONTENT_MODE,
  SCA_P08_DISCLOSURE_ADMISSION_SCHEMA,
  SCA_P08_DISPOSITION_REVISION_SCHEMA,
  SCA_P08_EVIDENCE_LEDGER_SCHEMA,
  SCA_P08_FINAL_STATE,
  SCA_P08_GATE_SCHEMA,
  SCA_P08_ITEM_UNIVERSE_SCHEMA,
  SCA_P08_PROVIDER_OPENING_GUARD,
  SCA_P08_REQUIRED_MODEL,
  SCA_P08_REQUIRED_TOOL_SUBSET,
  SCA_P08_REVIEWING_STATE,
  SCA_P08_REVIEWER_AGENT,
  SCA_P08_REVIEW_CALL_ID,
  SCA_P08_REVIEW_SCHEMA,
  SCA_P08_TERMINAL_SCHEMA,
  SCA_P08_TO_P09_TRANSITION_SCHEMA,
  assertScaP08DuplicateTargetsValid,
  scaP08DuplicatePairKey,
  validateScaP08AdmissionV1,
  validateScaP08AssessmentAgainstPayload,
  validateScaP08CognitivePayloadV1,
  validateScaP08DisclosureAdmissionV1,
  validateScaP08DispositionRevisionV1,
  validateScaP08DispositionSupportV1,
  validateScaP08EvidenceLedgerV1,
  validateScaP08GateV1,
  validateScaP08ItemUniverseV1,
  validateScaP08ReviewAgainstPayload,
  validateScaP08TerminalV1,
  validateScaP08ToP09TransitionV1,
  withP08Digest,
  ScaP08DispositionAssessmentV1Schema,
  ScaP08DispositionReviewV1Schema,
  type ScaP08CognitivePayloadV1,
  type ScaP08DispositionAssertionV1,
  type ScaP08DispositionKindV1,
  type ScaP08DispositionRevisionV1,
  type ScaP08DispositionReviewV1,
  type ScaP08DisclosureAdmissionV1,
  type ScaP08GateV1,
  type ScaP08ReassessmentEntryV1,
  type ScaP08TerminalV1,
} from "./p08-contracts.js";

/**
 * Inactive candidate only. This module is deliberately absent from `PLAYBOOK_REGISTRY` and
 * `SCA_PHASE_REGISTRY`: a registration here is a construction, not an accepted P08 phase.
 *
 * The candidate consumes the recorded P07 result through exact lineage admission, obtains one
 * disposition assessment and one independent semantic review from fixed DeepSeek model roles, and
 * deterministically finalizes immutable per-item revisions, an exhaustive ledger, a gate, a
 * non-authorizing P09 handoff, and an always non-positive terminal. It never gathers evidence,
 * executes a target, adjudicates a report or finding, releases, or completes a campaign.
 */
export const SCA_P08_CANDIDATE_PLAYBOOK_NAME = "sca-p08-candidate" as const;
export const SCA_P08_START_V1_SCHEMA = "penny.sca-p08-candidate-start.v1" as const;
export const SCA_P08_ASSESSMENT_OUTPUT_KIND = "sca-p08-assessment-output" as const;
export const SCA_P08_REVIEW_OUTPUT_KIND = "sca-p08-review-output" as const;
export const SCA_P08_REQUEST_KIND = "sca-p08-candidate-request" as const;

const PRODUCER = "host:sca-p08-candidate" as const;
const P08_PHASE = "SCA-P08" as const;
const ASSESSMENT_RECORD_KIND = "sca-p08-disposition-assessment" as const;
const REVIEW_RECORD_KIND = "sca-p08-disposition-review" as const;
type ReviewVerdict = "permits_confirmation" | "permits_refutation" | "not_permitted";

interface P08SupportV1 {
  readonly claim: string | null;
  readonly supporting_evidence_refs: readonly ArtifactRef[];
  readonly defeating_evidence_refs: readonly ArtifactRef[];
  readonly evidence_mode: "runtime" | "code" | "none";
  readonly actor_state_stimulus_verified: boolean;
  readonly target_reachability_observed: boolean;
  readonly distinguishing_oracle: string | null;
  readonly complete_code_control_state_evidence: boolean;
  readonly finite_clean_fuzzing_only: boolean;
  readonly unresolved_material_link: string | null;
  readonly resolution_evidence_need: string | null;
  readonly deferral_reason: string | null;
  readonly reopening_conditions: readonly string[];
  readonly duplicate_of_item_id: string | null;
  readonly equivalence_evidence_refs: readonly ArtifactRef[];
  readonly scope_evidence_ref: ArtifactRef | null;
  readonly repository_path: string | null;
  readonly line_start: number | null;
  readonly line_end: number | null;
}

interface P08FinalItemV1 {
  readonly item: ScaP08AdmittedItemV1;
  readonly disposition: ScaP08DispositionKindV1;
  readonly support: P08SupportV1;
  readonly review_verdict: ReviewVerdict | null;
  readonly review_ref: ArtifactRef | null;
  readonly review_exact_record_refs: readonly ArtifactRef[];
  readonly blocker_codes: readonly string[];
}

/**
 * Deterministic host validation facts the gate booleans are derived from. Each field states a
 * predicate the host actually established (`SCA-P08` R4); a gate never records a hardcoded `true`,
 * so a false `pass_ready` is impossible.
 */
interface ScaP08AssessmentValidationV1 {
  readonly support_semantics_valid: boolean;
  readonly no_false_refutation: boolean;
  readonly scope_duplicate_deferred_valid: boolean;
  readonly immutable_p07_lineage_valid: boolean;
  readonly blockers: readonly string[];
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function byArtifactId(left: ArtifactRef, right: ArtifactRef): number {
  return left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0;
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort(byArtifactId);
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
    throw new Error(`P08 ${label} exact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P08 ${label} exact bytes drifted`);
  }
  return bytes;
}
function exactJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const text = exactBytes(store, ref, label).toString("utf8");
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`P08 ${label} is not canonical JSON`);
  return value;
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
      throw new Error(`P08 artifact '${input.operationId}' conflicts with immutable prior bytes`);
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
function supportFromAssertion(assertion: ScaP08DispositionAssertionV1): P08SupportV1 {
  return {
    claim: assertion.claim,
    supporting_evidence_refs: assertion.supporting_evidence_refs,
    defeating_evidence_refs: assertion.defeating_evidence_refs,
    evidence_mode: assertion.evidence_mode,
    actor_state_stimulus_verified: assertion.actor_state_stimulus_verified,
    target_reachability_observed: assertion.target_reachability_observed,
    distinguishing_oracle: assertion.distinguishing_oracle,
    complete_code_control_state_evidence: assertion.complete_code_control_state_evidence,
    finite_clean_fuzzing_only: assertion.finite_clean_fuzzing_only,
    unresolved_material_link: assertion.unresolved_material_link,
    resolution_evidence_need: assertion.resolution_evidence_need,
    deferral_reason: assertion.deferral_reason,
    reopening_conditions: assertion.reopening_conditions,
    duplicate_of_item_id: assertion.duplicate_of_item_id,
    equivalence_evidence_refs: assertion.equivalence_evidence_refs,
    scope_evidence_ref: assertion.scope_evidence_ref,
    repository_path: assertion.repository_path,
    line_start: assertion.line_start,
    line_end: assertion.line_end,
  };
}
function inconclusiveSupport(link: string, need: string): P08SupportV1 {
  return {
    claim: null,
    supporting_evidence_refs: [],
    defeating_evidence_refs: [],
    evidence_mode: "none",
    actor_state_stimulus_verified: false,
    target_reachability_observed: false,
    distinguishing_oracle: null,
    complete_code_control_state_evidence: false,
    finite_clean_fuzzing_only: false,
    unresolved_material_link: link,
    resolution_evidence_need: need,
    deferral_reason: null,
    reopening_conditions: [],
    duplicate_of_item_id: null,
    equivalence_evidence_refs: [],
    scope_evidence_ref: null,
    repository_path: null,
    line_start: null,
    line_end: null,
  };
}
function refIds(refs: readonly ArtifactRef[]): string[] {
  return refs.map((ref) => ref.artifact_id).sort();
}

/**
 * Material disposition fields. Location/annotation fields (`repository_path`, `line_start`,
 * `line_end`) and the review binding are deliberately excluded so a severity/location-only
 * reassessment is a no-op rather than a new immutable revision (`SCA-D02`).
 */
function materialChangedFields(
  prior: ScaP08DispositionRevisionV1,
  final: P08FinalItemV1
): string[] {
  const next = final.support;
  const changed: string[] = [];
  const check = (field: string, before: unknown, after: unknown): void => {
    if (canonicalJson(before) !== canonicalJson(after)) changed.push(field);
  };
  check("disposition", prior.disposition, final.disposition);
  check("claim", prior.claim, next.claim);
  check(
    "supporting_evidence_refs",
    refIds(prior.supporting_evidence_refs),
    refIds(next.supporting_evidence_refs)
  );
  check(
    "defeating_evidence_refs",
    refIds(prior.defeating_evidence_refs),
    refIds(next.defeating_evidence_refs)
  );
  check("evidence_mode", prior.evidence_mode, next.evidence_mode);
  check(
    "actor_state_stimulus_verified",
    prior.actor_state_stimulus_verified,
    next.actor_state_stimulus_verified
  );
  check(
    "target_reachability_observed",
    prior.target_reachability_observed,
    next.target_reachability_observed
  );
  check("distinguishing_oracle", prior.distinguishing_oracle, next.distinguishing_oracle);
  check(
    "complete_code_control_state_evidence",
    prior.complete_code_control_state_evidence,
    next.complete_code_control_state_evidence
  );
  check(
    "finite_clean_fuzzing_only",
    prior.finite_clean_fuzzing_only,
    next.finite_clean_fuzzing_only
  );
  check("unresolved_material_link", prior.unresolved_material_link, next.unresolved_material_link);
  check("resolution_evidence_need", prior.resolution_evidence_need, next.resolution_evidence_need);
  check("deferral_reason", prior.deferral_reason, next.deferral_reason);
  check("reopening_conditions", prior.reopening_conditions, next.reopening_conditions);
  check("duplicate_of_item_id", prior.duplicate_of_item_id, next.duplicate_of_item_id);
  check(
    "equivalence_evidence_refs",
    refIds(prior.equivalence_evidence_refs),
    refIds(next.equivalence_evidence_refs)
  );
  check(
    "scope_evidence_ref",
    prior.scope_evidence_ref?.artifact_id ?? null,
    next.scope_evidence_ref?.artifact_id ?? null
  );
  return changed.sort();
}

function revisionUpstreams(final: P08FinalItemV1): ArtifactRef[] {
  return uniqueRefs([
    final.item.primary_ref,
    ...final.support.supporting_evidence_refs,
    ...final.support.defeating_evidence_refs,
    ...(final.review_ref === null ? [] : [final.review_ref]),
    ...final.review_exact_record_refs,
  ]);
}

/**
 * Destination predicates for a versioned reassessment (`SCA-D02`): uncertain→confirmed and
 * code→PoC upgrades require every destination predicate, refutation requires defeating evidence,
 * and invalidated evidence may neither survive as support nor be silently rewritten.
 */
function assertScaP08ReassessmentTransition(input: {
  readonly prior: ScaP08PriorItemV1;
  readonly entry: ScaP08ReassessmentEntryV1;
  readonly final: P08FinalItemV1;
}): void {
  const { prior, entry, final } = input;
  const next = final.disposition;
  const support = final.support;
  const invalidated = entry.change_reason_codes.includes("invalidated_evidence")
    ? new Set(entry.stimulus_refs.map((ref) => ref.artifact_id))
    : new Set<string>();
  const runtimePredicate =
    support.evidence_mode === "runtime" &&
    support.actor_state_stimulus_verified &&
    support.target_reachability_observed;
  const codePredicate =
    support.evidence_mode === "code" && support.complete_code_control_state_evidence;
  if (next === "confirmed") {
    if (final.review_verdict !== "permits_confirmation") {
      throw new Error("P08 confirmation reassessment lacks an independent permitting review");
    }
    if (!runtimePredicate && !codePredicate) {
      throw new Error("P08 confirmation reassessment lacks every destination predicate");
    }
    if (support.supporting_evidence_refs.some((ref) => invalidated.has(ref.artifact_id))) {
      throw new Error("P08 invalidated evidence cannot still support a confirmation");
    }
    const upgrade =
      prior.revision.disposition === "inconclusive" ||
      prior.revision.disposition === "deferred" ||
      (prior.revision.evidence_mode === "code" && support.evidence_mode === "runtime");
    if (upgrade && !runtimePredicate && !codePredicate) {
      throw new Error("P08 upgrade reassessment lacks every destination predicate");
    }
  }
  if (next === "rejected-with-evidence") {
    if (final.review_verdict !== "permits_refutation") {
      throw new Error("P08 refutation reassessment lacks an independent permitting review");
    }
    if (support.defeating_evidence_refs.length === 0) {
      throw new Error("P08 refutation reassessment lacks defeating evidence");
    }
    if (support.defeating_evidence_refs.some((ref) => invalidated.has(ref.artifact_id))) {
      throw new Error("P08 invalidated evidence cannot still support a refutation");
    }
  }
}

function callRole(callId: string): { readonly role: string; readonly purpose: string } {
  return callId === SCA_P08_ASSESSMENT_CALL_ID
    ? { role: "evidence_disposition_assessor", purpose: "p08_evidence_based_disposition" }
    : { role: "evidence_disposition_reviewer", purpose: "p08_independent_semantic_review" };
}
function callState(callId: string): string {
  return callId === SCA_P08_ASSESSMENT_CALL_ID ? SCA_P08_ASSESSING_STATE : SCA_P08_REVIEWING_STATE;
}

const ScaP08StartConstraintsV1Schema = Type.Object(
  {
    p07_terminal_ref: ArtifactRefSchema,
    p07_transition_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    p07_evidence_ledger_ref: ArtifactRefSchema,
    disclosure_scope_ref: ArtifactRefSchema,
    /** Optional host-issued reassessment stimulus naming an earlier P08 ledger to version. */
    p08_reassessment_ref: Type.Optional(Type.Union([ArtifactRefSchema, Type.Null()])),
    /** Optional exact host-issued duplicate-equivalence proofs cited by `duplicate-of` items. */
    p08_equivalence_proof_refs: Type.Optional(Type.Array(ArtifactRefSchema, { maxItems: 16 })),
  },
  { additionalProperties: false, $id: SCA_P08_START_V1_SCHEMA }
);
type ScaP08StartConstraintsV1 = Readonly<Static<typeof ScaP08StartConstraintsV1Schema>>;

const P08DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    universe_ref: ArtifactRefSchema,
    scope_ref: ArtifactRefSchema,
    assessment_payload_ref: ArtifactRefSchema,
    assessment_disclosure_ref: ArtifactRefSchema,
    review_payload_ref: Type.Optional(ArtifactRefSchema),
    review_disclosure_ref: Type.Optional(ArtifactRefSchema),
    reassessment_ref: Type.Optional(ArtifactRefSchema),
  },
  { additionalProperties: false }
);
type P08Data = Readonly<Static<typeof P08DataSchema>>;
function data(context: RunContext): P08Data {
  return validateContract(P08DataSchema, context.playbookData, "SCA P08 durable state");
}

function outputArtifact(input: {
  readonly runId: string;
  readonly state: string;
  readonly agent: string;
  readonly kind: string;
  readonly operationId: string;
  readonly upstream: readonly ArtifactRef[];
}): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: input.runId,
    phase: input.state,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: `agent:${input.agent}`,
    media_type: "text/plain",
    content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [...input.upstream],
  };
}
function payloadItem(item: ScaP08AdmittedItemV1) {
  return {
    item_id: item.item_id,
    item_kind: item.item_kind,
    identity: item.identity,
    hypothesis_id: item.hypothesis_id,
    primary_ref: item.primary_ref,
    p07_status: item.p07_status,
    p07_evidence_refs: [...item.p07_evidence_refs],
    p07_ledger_row_operation_id: item.p07_ledger_row_operation_id,
    hypothesis: item.hypothesis,
    prior_disposition_ref: item.prior_disposition_ref,
    equivalence_proof_refs: [...item.duplicate_equivalence_proof_refs].sort((left, right) =>
      left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0
    ),
    excerpt: item.excerpt,
  };
}

export interface ScaP08CandidateBindingV1 {
  /**
   * Independent resolver of the current P07 execution authority. Absent only for the exported
   * provider-free compatibility fixture, which revalidates the ledger's own authority.
   */
  readonly resolve_current_p07_authority_ref?: (scope: {
    readonly tenant_id: string;
    readonly project_id: string;
    readonly run_id: string;
    readonly transition_ref: ArtifactRef;
  }) => ArtifactRef;
}

export class ScaP08CandidatePlaybook implements Playbook {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly binding: ScaP08CandidateBindingV1 = {},
    private readonly trustedClock: () => Date = () => new Date()
  ) {}

  initialize(context: RunContext): Directive {
    const requestRef = latestSelected(
      context,
      (ref) => ref.kind === SCA_P08_REQUEST_KIND && ref.run_id === context.identity.run_id
    );
    if (requestRef === undefined) throw new Error("SCA P08 admitted request is absent");
    const constraints = validateContract(
      ScaP08StartConstraintsV1Schema,
      exactJson(this.store, requestRef, "candidate request"),
      "SCA P08 start constraints"
    );
    const admissionRef = latestSelected(context, (ref) => ref.kind === "sca-p08-admission");
    const universeRef = latestSelected(context, (ref) => ref.kind === "sca-p08-item-universe");
    if (admissionRef === undefined || universeRef === undefined) {
      throw new Error("SCA P08 admitted universe or admission is absent");
    }
    const admitted = this.readmit(context.identity.run_id, constraints);
    const admission = validateScaP08AdmissionV1(exactJson(this.store, admissionRef, "admission"));
    const universe = validateScaP08ItemUniverseV1(
      exactJson(this.store, universeRef, "item universe")
    );
    if (
      !same(admission, admitted.admission) ||
      !same(universe, admitted.universe) ||
      universe.universe_sha256 !== admission.universe_sha256
    ) {
      throw new Error("SCA P08 admission is not the exact re-derived lineage admission");
    }
    const assessment = this.persistCall(context, admitted, SCA_P08_ASSESSMENT_CALL_ID, null);
    Object.assign(context.playbookData, {
      request_ref: requestRef,
      admission_ref: admissionRef,
      universe_ref: universeRef,
      scope_ref: constraints.disclosure_scope_ref,
      assessment_payload_ref: assessment.payload_ref,
      assessment_disclosure_ref: assessment.disclosure_ref,
      ...(constraints.p08_reassessment_ref === undefined ||
      constraints.p08_reassessment_ref === null
        ? {}
        : { reassessment_ref: constraints.p08_reassessment_ref }),
    });
    if (admission.blocked_checkpoint) {
      context.transition(SCA_P08_FINAL_STATE);
      return this.finalize(context, "blocked_checkpoint");
    }
    if (assessment.disclosure.decision !== "allow") {
      context.transition(SCA_P08_FINAL_STATE);
      return this.finalize(context, "disclosure_denied");
    }
    context.transition(SCA_P08_ASSESSING_STATE);
    return this.issue(context, "assessment");
  }

  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    if (context.stateId === SCA_P08_ASSESSING_STATE) return this.issue(context, "assessment");
    if (context.stateId === SCA_P08_REVIEWING_STATE) return this.issue(context, "review");
    throw new Error(`SCA P08 has no dispatch for '${context.stateId}'`);
  }

  resume(): Directive {
    throw new Error("SCA P08 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = SCA_P08_CANCELLED_STATE;
    context.status = "cancelled";
    context.met = false;
    const terminal = validateScaP08TerminalV1(
      withP08Digest(
        {
          schema_id: SCA_P08_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P08_PHASE,
          status: "cancelled" as const,
          evidence_ledger_ref: null,
          gate_ref: null,
          p09_transition_ref: null,
          p09_handoff_ready: false,
          item_count: 0,
          confirmed_count: 0,
          rejected_with_evidence_count: 0,
          inconclusive_count: 0,
          deferred_count: 0,
          duplicate_of_count: 0,
          out_of_scope_count: 0,
          selected_artifact_refs: this.selectedCoreRefs(context),
          blocker_codes: [
            reason.startsWith("model call outcome remote_unknown")
              ? "p08_remote_unknown_quarantined"
              : reason.startsWith("model outcome persisted but not committed")
                ? "p08_uncommitted_outcome_quarantined"
                : "p08_cancelled",
          ],
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          report_or_finding_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    const artifacts = this.selectedCoreRefs(context);
    const directive = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: terminal,
      artifacts,
      unresolved: terminal.blocker_codes,
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending?.action === "invoke_agent") {
      const coordinate = {
        run_id: context.identity.run_id,
        state_id: pending.state_id,
        branch_id: null,
        agent: pending.agent,
        attempt: pending.attempt,
      };
      const guardRef = this.store.refFor(
        context.identity.run_id,
        pending.state_id,
        null,
        "model-dispatch-guard",
        modelDispatchGuardOperationId(coordinate),
        1
      );
      if (guardRef !== null) {
        // A durable dispatch guard without its exact model-execution receipt means the provider
        // outcome is uncommitted: fence it explicitly rather than treating it as an ordinary
        // remote-unknown dispatch (`SCA-C09`). Neither path replays or auto-accepts the outcome.
        const outputRef = this.store.refFor(
          context.identity.run_id,
          pending.state_id,
          null,
          pending.output_artifact.kind,
          pending.output_artifact.operation_id,
          1
        );
        const receiptRef = this.store.refFor(
          context.identity.run_id,
          pending.state_id,
          null,
          "model-execution-receipt",
          modelExecutionReceiptOperationId(coordinate),
          1
        );
        if (outputRef !== null && receiptRef === null) {
          return this.cancel(
            context,
            "model outcome persisted but not committed; durable fencing prohibits implicit acceptance or replay"
          );
        }
        return this.cancel(
          context,
          "model call outcome remote_unknown; durable dispatch fencing prohibits automatic replay"
        );
      }
    }
    return pending;
  }

  terminalizeLiveness(
    context: RunContext,
    reason: LivenessTerminalReason,
    _snapshot: LivenessSnapshotV1
  ): Directive {
    context.transition(SCA_P08_FINAL_STATE);
    return this.finalize(context, "liveness", [`p08_liveness_${reason}`]);
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    if (context.stateId === SCA_P08_ASSESSING_STATE) return this.acceptAssessment(context, details);
    if (context.stateId === SCA_P08_REVIEWING_STATE) return this.acceptReview(context, details);
    throw new Error(`unexpected SCA P08 summary in '${context.stateId}'`);
  }

  private readmit(runId: string, constraints: ScaP08StartConstraintsV1): ScaP08AdmissionResultV1 {
    const base = {
      store: this.store,
      run_id: runId,
      p07_terminal_ref: constraints.p07_terminal_ref,
      p07_evidence_ledger_ref: constraints.p07_evidence_ledger_ref,
      p07_transition_ref: constraints.p07_transition_ref,
      disclosure_scope_ref: constraints.disclosure_scope_ref,
      p08_reassessment_ref: constraints.p08_reassessment_ref ?? null,
      p08_equivalence_proof_refs: constraints.p08_equivalence_proof_refs ?? [],
    };
    const resolver = this.binding.resolve_current_p07_authority_ref;
    return resolver === undefined
      ? admitScaP08Disposition(base)
      : admitScaP08Disposition({ ...base, resolve_current_p07_authority_ref: resolver });
  }

  private readmitFromState(context: RunContext, state: P08Data): ScaP08AdmissionResultV1 {
    const constraints = validateContract(
      ScaP08StartConstraintsV1Schema,
      exactJson(this.store, state.request_ref, "candidate request"),
      "SCA P08 start constraints"
    );
    const admitted = this.readmit(context.identity.run_id, constraints);
    const persisted = validateScaP08AdmissionV1(
      exactJson(this.store, state.admission_ref, "admission")
    );
    if (!same(admitted.admission, persisted)) {
      throw new Error("SCA P08 durable admission drifted from exact lineage");
    }
    return admitted;
  }

  private persistCall(
    context: RunContext,
    admitted: ScaP08AdmissionResultV1,
    callId: string,
    assessmentRef: ArtifactRef | null
  ): {
    readonly payload_ref: ArtifactRef;
    readonly disclosure_ref: ArtifactRef;
    readonly payload: ScaP08CognitivePayloadV1;
    readonly disclosure: ScaP08DisclosureAdmissionV1;
  } {
    const role = callRole(callId);
    const state = callState(callId);
    const payload = validateScaP08CognitivePayloadV1(
      withP08Digest(
        {
          schema_id: SCA_P08_COGNITIVE_PAYLOAD_SCHEMA,
          schema_version: 1 as const,
          run_id: admitted.admission.run_id,
          phase_id: P08_PHASE,
          call_id: callId,
          role: role.role,
          purpose: role.purpose,
          required_model: SCA_P08_REQUIRED_MODEL,
          p07_terminal_ref: admitted.admission.p07_terminal_ref,
          p07_transition_ref: admitted.admission.p07_transition_ref,
          p07_evidence_ledger_ref: admitted.admission.p07_evidence_ledger_ref,
          disclosure_scope_ref: admitted.admission.disclosure_scope_ref,
          scope_decision_refs: [...admitted.scope_decision_refs],
          assessment_ref: assessmentRef,
          assigned_item_ids: admitted.items.map((item) => item.item_id),
          items: admitted.items.map(payloadItem),
          content_mode: SCA_P08_CONTENT_MODE,
        },
        "payload_sha256"
      )
    );
    const payloadRef = persistJson({
      store: this.store,
      context,
      runId: admitted.admission.run_id,
      phase: state,
      kind: "sca-p08-cognitive-payload",
      operationId:
        callId === SCA_P08_ASSESSMENT_CALL_ID
          ? "sca-p08-assessment-payload"
          : "sca-p08-review-payload",
      schemaId: SCA_P08_COGNITIVE_PAYLOAD_SCHEMA,
      value: payload,
      upstreamRefs: [
        admitted.admission.p07_terminal_ref,
        admitted.admission.p07_transition_ref,
        admitted.admission.p07_evidence_ledger_ref,
        admitted.admission.disclosure_scope_ref,
        ...(assessmentRef === null ? [] : [assessmentRef]),
      ].filter((ref): ref is ArtifactRef => ref !== null),
    });
    const withinLimit =
      payloadRef.byte_length <= admitted.disclosure_scope.max_payload_bytes_per_call;
    const allowed = admitted.disclosure_scope.decision === "allow" && withinLimit;
    const blockerCodes = [
      ...admitted.disclosure_scope.blocker_codes,
      ...(withinLimit ? [] : ["p08_payload_limit_exceeded"]),
    ].sort();
    const disclosure = validateScaP08DisclosureAdmissionV1(
      withP08Digest(
        {
          schema_id: SCA_P08_DISCLOSURE_ADMISSION_SCHEMA,
          schema_version: 1 as const,
          run_id: admitted.admission.run_id,
          phase_id: P08_PHASE,
          call_id: callId,
          role: role.role,
          purpose: role.purpose,
          required_model: SCA_P08_REQUIRED_MODEL,
          disclosure_scope_ref: admitted.admission.disclosure_scope_ref,
          disclosure_scope_sha256: admitted.disclosure_scope.scope_sha256,
          payload_ref: payloadRef,
          payload_sha256: payloadRef.content_digest,
          payload_byte_length: payloadRef.byte_length,
          serialized_opening_byte_limit: admitted.disclosure_scope.max_payload_bytes_per_call,
          authorized_refs: uniqueRefs([
            ...admitted.scope_decision_refs,
            ...admitted.items.flatMap((item) => [
              item.primary_ref,
              ...item.p07_evidence_refs,
              ...item.duplicate_equivalence_proof_refs,
              ...(item.prior_disposition_ref === null ? [] : [item.prior_disposition_ref]),
            ]),
          ]),
          destination: "cloud" as const,
          retention_days: admitted.disclosure_scope.provider_retention_days,
          logging_status: admitted.disclosure_scope.provider_logging_status,
          logging_days: admitted.disclosure_scope.provider_logging_days,
          training: "prohibited" as const,
          secrets_embedded: false as const,
          personal_data_embedded: false as const,
          decision: allowed ? ("allow" as const) : ("deny" as const),
          blocker_codes: blockerCodes,
          evaluated_before_dispatch: true as const,
        },
        "admission_sha256"
      )
    );
    const disclosureRef = persistJson({
      store: this.store,
      context,
      runId: admitted.admission.run_id,
      phase: state,
      kind: "sca-p08-disclosure-admission",
      operationId:
        callId === SCA_P08_ASSESSMENT_CALL_ID
          ? "sca-p08-assessment-disclosure"
          : "sca-p08-review-disclosure",
      schemaId: SCA_P08_DISCLOSURE_ADMISSION_SCHEMA,
      value: disclosure,
      upstreamRefs: [payloadRef, admitted.admission.disclosure_scope_ref],
    });
    return { payload_ref: payloadRef, disclosure_ref: disclosureRef, payload, disclosure };
  }

  private issue(context: RunContext, which: "assessment" | "review"): Directive {
    const directive = this.buildIssue(context, which);
    context.pendingDirective = directive;
    return directive;
  }

  private buildIssue(context: RunContext, which: "assessment" | "review"): Directive {
    const state = data(context);
    const runId = context.identity.run_id;
    if (which === "assessment") {
      const payloadRef = state.assessment_payload_ref;
      const disclosureRef = state.assessment_disclosure_ref;
      return this.modelDirective(context, {
        state_id: SCA_P08_ASSESSING_STATE,
        agent: SCA_P08_ASSESSOR_AGENT,
        payload_ref: payloadRef,
        disclosure_ref: disclosureRef,
        output: outputArtifact({
          runId,
          state: SCA_P08_ASSESSING_STATE,
          agent: SCA_P08_ASSESSOR_AGENT,
          kind: SCA_P08_ASSESSMENT_OUTPUT_KIND,
          operationId: "sca-p08-assessment-output",
          upstream: [payloadRef, disclosureRef],
        }),
        task: "For every assigned item, propose exactly one disposition from the closed six-value domain (confirmed, rejected-with-evidence, inconclusive, deferred, duplicate-of, out-of-scope) with its exact required support fields. Copy payload_sha256 from the payload's own payload_sha256 field, not from any artifact ref digest. Runtime confirmation or refutation requires correct actor/state/stimulus and observed target reachability; a runtime refutation must also state its distinguishing oracle (the exact observation separating the claim from its alternatives); code refutation requires complete code/control/state evidence and a repository path with a line range; finite clean fuzzing may support at most inconclusive. An out-of-scope item may cite only one ref from the payload's scope_decision_refs list (the admitted campaign/source scope-decision records); a duplicate-of item must cite the admitted equivalence proof for its exact duplicate pair and may not target an item that is itself duplicate-of. Return only the exact closed disposition-assessment JSON contract with items sorted by item_id. No tools are available.",
      });
    }
    const reviewPayloadRef = state.review_payload_ref;
    const reviewDisclosureRef = state.review_disclosure_ref;
    if (reviewPayloadRef === undefined || reviewDisclosureRef === undefined) {
      throw new Error("SCA P08 review payload is absent");
    }
    return this.modelDirective(context, {
      state_id: SCA_P08_REVIEWING_STATE,
      agent: SCA_P08_REVIEWER_AGENT,
      payload_ref: reviewPayloadRef,
      disclosure_ref: reviewDisclosureRef,
      output: outputArtifact({
        runId,
        state: SCA_P08_REVIEWING_STATE,
        agent: SCA_P08_REVIEWER_AGENT,
        kind: SCA_P08_REVIEW_OUTPUT_KIND,
        operationId: "sca-p08-review-output",
        upstream: [reviewPayloadRef, reviewDisclosureRef],
      }),
      task: "Independently review the disposition assessment. For every assigned item, bind at least one exact record ref and return one verdict (permits_confirmation, permits_refutation, or not_permitted). Do not derive a verdict solely from the assessment; resolve the substantive assertions and counterevidence against the exact items supplied. A verdict with no exact-record binding is invalid. Return only the exact closed disposition-review JSON contract with items sorted by item_id. No tools are available.",
    });
  }

  private modelDirective(
    context: RunContext,
    input: {
      readonly state_id: string;
      readonly agent: string;
      readonly payload_ref: ArtifactRef;
      readonly disclosure_ref: ArtifactRef;
      readonly output: OutputArtifactMetadata;
      readonly task: string;
    }
  ): Directive {
    return validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: input.state_id,
      agent: input.agent,
      attempt: 1,
      trust_profile: "hardened-untrusted",
      model_override: SCA_P08_REQUIRED_MODEL.override,
      task: input.task,
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "cognitive_payload", ref: input.payload_ref },
          { slot: "disclosure_admission", ref: input.disclosure_ref },
        ],
      },
      output_artifact: input.output,
    });
  }

  private acceptAssessment(context: RunContext, details: Record<string, JsonValue>): Directive {
    const state = data(context);
    const admitted = this.readmitFromState(context, state);
    const payload = validateScaP08CognitivePayloadV1(
      exactJson(this.store, state.assessment_payload_ref, "assessment payload")
    );
    const outputRef = latestSelected(context, (ref) => ref.kind === SCA_P08_ASSESSMENT_OUTPUT_KIND);
    if (outputRef === undefined) throw new Error("SCA P08 assessment output ref is absent");
    let assessment: ReturnType<typeof validateScaP08AssessmentAgainstPayload>;
    try {
      assessment = validateScaP08AssessmentAgainstPayload(details, payload);
      this.assertModelEvidence(context, {
        state_id: SCA_P08_ASSESSING_STATE,
        agent: SCA_P08_ASSESSOR_AGENT,
        outputRef,
        payloadRef: state.assessment_payload_ref,
        disclosureRef: state.assessment_disclosure_ref,
      });
    } catch {
      context.transition(SCA_P08_FINAL_STATE);
      return this.finalize(context, "assessment_invalid");
    }
    const assessmentRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: SCA_P08_ASSESSING_STATE,
      kind: ASSESSMENT_RECORD_KIND,
      operationId: "sca-p08-disposition-assessment",
      schemaId: SCA_P08_ASSESSMENT_SCHEMA,
      value: assessment,
      upstreamRefs: [state.assessment_payload_ref, state.assessment_disclosure_ref, outputRef],
    });
    const review = this.persistCall(context, admitted, SCA_P08_REVIEW_CALL_ID, assessmentRef);
    Object.assign(context.playbookData, {
      review_payload_ref: review.payload_ref,
      review_disclosure_ref: review.disclosure_ref,
    });
    if (review.disclosure.decision !== "allow") {
      context.transition(SCA_P08_FINAL_STATE);
      return this.finalize(context, "disclosure_denied");
    }
    context.transition(SCA_P08_REVIEWING_STATE);
    return this.issue(context, "review");
  }

  private acceptReview(context: RunContext, details: Record<string, JsonValue>): Directive {
    const state = data(context);
    const payloadRef = state.review_payload_ref;
    if (payloadRef === undefined) throw new Error("SCA P08 review payload ref is absent");
    const payload = validateScaP08CognitivePayloadV1(
      exactJson(this.store, payloadRef, "review payload")
    );
    const assessmentRef = this.store.refFor(
      context.identity.run_id,
      SCA_P08_ASSESSING_STATE,
      null,
      ASSESSMENT_RECORD_KIND,
      "sca-p08-disposition-assessment",
      1
    );
    if (assessmentRef === null) throw new Error("SCA P08 assessment ref is absent");
    const outputRef = latestSelected(context, (ref) => ref.kind === SCA_P08_REVIEW_OUTPUT_KIND);
    if (outputRef === undefined) throw new Error("SCA P08 review output ref is absent");
    let review: ScaP08DispositionReviewV1;
    try {
      review = validateScaP08ReviewAgainstPayload(details, payload, assessmentRef.content_digest);
      this.assertModelEvidence(context, {
        state_id: SCA_P08_REVIEWING_STATE,
        agent: SCA_P08_REVIEWER_AGENT,
        outputRef,
        payloadRef,
        disclosureRef:
          state.review_disclosure_ref === undefined ? payloadRef : state.review_disclosure_ref,
      });
    } catch {
      context.transition(SCA_P08_FINAL_STATE);
      return this.finalize(context, "review_invalid");
    }
    persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: SCA_P08_REVIEWING_STATE,
      kind: REVIEW_RECORD_KIND,
      operationId: "sca-p08-disposition-review",
      schemaId: SCA_P08_REVIEW_SCHEMA,
      value: review,
      upstreamRefs: [payloadRef, assessmentRef, outputRef],
    });
    context.transition(SCA_P08_FINAL_STATE);
    return this.finalize(context, "complete");
  }

  private assertModelEvidence(
    context: RunContext,
    input: {
      readonly state_id: string;
      readonly agent: string;
      readonly outputRef: ArtifactRef;
      readonly payloadRef: ArtifactRef;
      readonly disclosureRef: ArtifactRef;
    }
  ): void {
    const coordinate = {
      run_id: context.identity.run_id,
      state_id: input.state_id,
      branch_id: null,
      agent: input.agent,
      attempt: 1,
    };
    const guardRef = this.store.refFor(
      context.identity.run_id,
      input.state_id,
      null,
      "model-dispatch-guard",
      modelDispatchGuardOperationId(coordinate),
      1
    );
    const receiptRef = this.store.refFor(
      context.identity.run_id,
      input.state_id,
      null,
      "model-execution-receipt",
      modelExecutionReceiptOperationId(coordinate),
      1
    );
    if (guardRef === null || receiptRef === null) {
      throw new Error("P08 model dispatch guard or receipt is absent");
    }
    const guard = validateModelDispatchGuardV1(exactJson(this.store, guardRef, "P08 guard"));
    const wrapper = validateModelExecutionReceiptV1(
      exactJson(this.store, receiptRef, "P08 receipt")
    );
    const receipt = wrapper.execution_receipt;
    const inputs = {
      schema_version: 2 as const,
      artifacts: [
        { slot: "cognitive_payload", ref: input.payloadRef },
        { slot: "disclosure_admission", ref: input.disclosureRef },
      ],
    };
    if (
      !same(guard.coordinate, coordinate) ||
      !same(guard.requested_model, SCA_P08_REQUIRED_MODEL) ||
      guard.provider_opening_guard !== SCA_P08_PROVIDER_OPENING_GUARD ||
      guard.input_artifacts_sha256 !== sha256(canonicalJson(inputs)) ||
      !same(wrapper.dispatch_guard_ref, guardRef) ||
      receipt.run_id !== coordinate.run_id ||
      receipt.state_id !== coordinate.state_id ||
      receipt.branch_id !== null ||
      receipt.agent !== coordinate.agent ||
      receipt.attempt !== coordinate.attempt ||
      !same(receipt.requested_model, SCA_P08_REQUIRED_MODEL) ||
      receipt.observed_model === undefined ||
      !same(receipt.output_artifact_ref, input.outputRef) ||
      receipt.output_digest !== input.outputRef.content_digest
    ) {
      throw new Error("P08 model execution evidence binding mismatch");
    }
    assertResolvedModelIdentity(
      SCA_P08_REQUIRED_MODEL,
      receipt.observed_model,
      "P08 observed model"
    );
  }

  private finalize(
    context: RunContext,
    mode:
      | "complete"
      | "assessment_invalid"
      | "review_invalid"
      | "blocked_checkpoint"
      | "disclosure_denied"
      | "liveness",
    extraBlockers: readonly string[] = []
  ): Directive {
    const state = data(context);
    const admitted = this.readmitFromState(context, state);
    const modeBlockers = this.deriveBlockers(mode, extraBlockers);
    let blockers: readonly string[] = modeBlockers;
    let finalItems: readonly P08FinalItemV1[];
    let validation: ScaP08AssessmentValidationV1;
    try {
      const derived = this.deriveFinalItems(context, state, admitted, mode, modeBlockers);
      finalItems = derived.items;
      validation = derived.validation;
      blockers = [...modeBlockers, ...derived.validation.blockers];
    } catch {
      blockers = [...modeBlockers, "p08_disposition_validation_failed"];
      finalItems = admitted.items.map((item) => ({
        item,
        disposition: "inconclusive" as const,
        support: inconclusiveSupport(
          "disposition_validation_failed",
          "a host-valid re-assessment of the exact evidence"
        ),
        review_verdict: null,
        review_ref: null,
        review_exact_record_refs: [],
        blocker_codes: blockers,
      }));
      // The host established none of the semantic predicates, so every derived gate boolean is
      // false and the gate can never reach `pass_ready` (`SCA-P08` R4).
      validation = {
        support_semantics_valid: false,
        no_false_refutation: false,
        scope_duplicate_deferred_valid: false,
        immutable_p07_lineage_valid: true,
        blockers: [...blockers],
      };
    }
    const persisted = this.persistFinalization(
      context,
      state,
      admitted,
      finalItems,
      blockers,
      mode,
      validation
    );
    context.status = "incomplete";
    context.met = false;
    const directive = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: persisted.terminal,
      artifacts: persisted.artifactRefs,
      unresolved:
        persisted.terminal.status === "candidate_complete"
          ? [
              "SCA-P09 reconciliation remains separately admitted; no report, finding, release, or campaign completion is claimed.",
            ]
          : [...persisted.terminal.blocker_codes],
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private deriveBlockers(mode: string, extra: readonly string[]): readonly string[] {
    if (mode === "assessment_invalid") return ["p08_assessment_invalid", ...extra];
    if (mode === "review_invalid") return ["p08_review_invalid", ...extra];
    if (mode === "blocked_checkpoint") return ["p08_blocked_checkpoint", ...extra];
    if (mode === "disclosure_denied") return ["p08_disclosure_denied_before_dispatch", ...extra];
    return [...extra];
  }

  private deriveFinalItems(
    context: RunContext,
    state: P08Data,
    admitted: ScaP08AdmissionResultV1,
    mode: string,
    modeBlockers: readonly string[]
  ): {
    readonly items: readonly P08FinalItemV1[];
    readonly validation: ScaP08AssessmentValidationV1;
  } {
    if (
      mode === "assessment_invalid" ||
      mode === "blocked_checkpoint" ||
      mode === "disclosure_denied" ||
      mode === "liveness"
    ) {
      const link =
        mode === "blocked_checkpoint"
          ? "p07_blocked_checkpoint"
          : mode === "assessment_invalid"
            ? "assessment_invalid"
            : mode === "disclosure_denied"
              ? "disclosure_denied_before_dispatch"
              : "liveness_inactivity";
      return {
        items: admitted.items.map((item) => ({
          item,
          disposition: "inconclusive" as const,
          support: inconclusiveSupport(link, "a host-validated disposition assessment"),
          review_verdict: null,
          review_ref: null,
          review_exact_record_refs: [],
          blocker_codes: modeBlockers,
        })),
        validation: {
          // No assessment was host-validated, so no semantic predicate is established.
          support_semantics_valid: false,
          no_false_refutation: false,
          scope_duplicate_deferred_valid: false,
          immutable_p07_lineage_valid: true,
          blockers: [],
        },
      };
    }
    const assessmentRef = this.assessmentRef(context);
    const assessment = validateScaP08AssessmentAgainstPayload(
      exactJson(this.store, assessmentRef, "assessment"),
      validateScaP08CognitivePayloadV1(
        exactJson(this.store, state.assessment_payload_ref, "assessment payload")
      )
    );
    const assessmentById = new Map(assessment.items.map((item) => [item.item_id, item]));
    const proofRefIdByPair = new Map<string, string>();
    for (const [pair, entry] of admitted.equivalence_proof_by_pair) {
      proofRefIdByPair.set(pair, entry.ref.artifact_id);
    }
    const supportContext = {
      universe_item_ids: new Set(admitted.items.map((item) => item.item_id)),
      p07_status_by_item_id: admitted.p07_status_by_item_id,
      admitted_scope_decision_ref_ids: admitted.scope_decision_ref_ids,
      admitted_equivalence_proof_ref_id_by_pair: proofRefIdByPair,
    };
    const reviewById = this.reviewById(mode, admitted, assessmentRef);
    const items = admitted.items.map((item) => {
      const assertion = assessmentById.get(item.item_id);
      if (assertion === undefined) throw new Error("P08 assessment omits a universe item");
      validateScaP08DispositionSupportV1(assertion, supportContext);
      this.assertCitedEvidence(admitted, assertion);
      const reviewed = reviewById.get(item.item_id);
      const verdict = reviewed?.verdict ?? null;
      const blockers: string[] = [];
      let disposition: ScaP08DispositionKindV1 = assertion.disposition;
      let support = supportFromAssertion(assertion);
      if (mode === "review_invalid") {
        if (disposition === "confirmed" || disposition === "rejected-with-evidence") {
          disposition = "inconclusive";
          support = inconclusiveSupport("review_invalid", "a valid independent semantic review");
          blockers.push("p08_review_invalid");
        }
      } else if (disposition === "confirmed" && verdict !== "permits_confirmation") {
        disposition = "inconclusive";
        support = inconclusiveSupport(
          "review_did_not_permit_confirmation",
          "an independent review permitting confirmation"
        );
        blockers.push("p08_review_did_not_permit_confirmation");
      } else if (disposition === "rejected-with-evidence" && verdict !== "permits_refutation") {
        disposition = "inconclusive";
        support = inconclusiveSupport(
          "review_did_not_permit_refutation",
          "an independent review permitting refutation"
        );
        blockers.push("p08_review_did_not_permit_refutation");
      }
      const final: P08FinalItemV1 = {
        item,
        disposition,
        support,
        review_verdict: verdict,
        review_ref: reviewed?.ref ?? null,
        review_exact_record_refs: reviewed?.exact ?? [],
        blocker_codes: blockers,
      };
      if (mode === "complete") this.assertReassessmentTrigger(admitted, final);
      return final;
    });
    // Defense in depth: the final dispositions must still satisfy the duplicate-target predicate.
    assertScaP08DuplicateTargetsValid(
      items.map((final) => ({
        item_id: final.item.item_id,
        disposition: final.disposition,
        duplicate_of_item_id: final.support.duplicate_of_item_id,
      }))
    );
    const refutationHolds = (final: P08FinalItemV1): boolean => {
      if (final.disposition !== "rejected-with-evidence") return true;
      const support = final.support;
      const runtime =
        support.evidence_mode === "runtime" &&
        support.actor_state_stimulus_verified &&
        support.target_reachability_observed &&
        support.distinguishing_oracle !== null;
      const code = support.evidence_mode === "code" && support.complete_code_control_state_evidence;
      return (runtime || code) && !support.finite_clean_fuzzing_only;
    };
    const scopeDuplicateDeferredHolds = (final: P08FinalItemV1): boolean => {
      if (final.disposition === "out-of-scope") {
        return (
          final.support.scope_evidence_ref !== null &&
          admitted.scope_decision_ref_ids.has(final.support.scope_evidence_ref.artifact_id)
        );
      }
      if (final.disposition === "duplicate-of") {
        const pair = scaP08DuplicatePairKey(
          final.item.item_id,
          final.support.duplicate_of_item_id ?? ""
        );
        return admitted.equivalence_proof_by_pair.has(pair);
      }
      if (final.disposition === "deferred") {
        return (
          final.support.deferral_reason !== null && final.support.reopening_conditions.length > 0
        );
      }
      return true;
    };
    return {
      items,
      validation: {
        support_semantics_valid: items.length === admitted.items.length,
        no_false_refutation: items.every(refutationHolds),
        scope_duplicate_deferred_valid: items.every(scopeDuplicateDeferredHolds),
        immutable_p07_lineage_valid: true,
        blockers: [],
      },
    };
  }

  /**
   * Fail-closed reassessment trigger enforcement: a material disposition change must name an
   * admitted exact trigger, and the destination predicates must hold (`SCA-D02`).
   */
  private assertReassessmentTrigger(
    admitted: ScaP08AdmissionResultV1,
    final: P08FinalItemV1
  ): void {
    if (final.item.prior_disposition_ref === null) return;
    const prior = admitted.prior_by_item_id.get(final.item.item_id);
    if (prior === undefined) {
      throw new Error("P08 prior revision is absent for an admitted prior disposition ref");
    }
    if (materialChangedFields(prior.revision, final).length === 0) return;
    const entry = admitted.reassessment_by_item_id.get(final.item.item_id);
    if (entry === undefined) {
      throw new Error("P08 disposition changed without an admitted reassessment trigger");
    }
    assertScaP08ReassessmentTransition({ prior, entry, final });
  }

  private assessmentRef(context: RunContext): ArtifactRef {
    const ref = this.store.refFor(
      context.identity.run_id,
      SCA_P08_ASSESSING_STATE,
      null,
      ASSESSMENT_RECORD_KIND,
      "sca-p08-disposition-assessment",
      1
    );
    if (ref === null) throw new Error("P08 assessment record is absent");
    return ref;
  }

  private reviewById(
    mode: string,
    admitted: ScaP08AdmissionResultV1,
    assessmentRef: ArtifactRef
  ): ReadonlyMap<
    string,
    {
      readonly verdict: ReviewVerdict;
      readonly ref: ArtifactRef;
      readonly exact: readonly ArtifactRef[];
    }
  > {
    if (mode !== "complete") return new Map();
    const reviewRef = this.store.refFor(
      admitted.admission.run_id,
      SCA_P08_REVIEWING_STATE,
      null,
      REVIEW_RECORD_KIND,
      "sca-p08-disposition-review",
      1
    );
    if (reviewRef === null) throw new Error("P08 review record is absent");
    const review = exactJson(this.store, reviewRef, "review");
    const payloadRef = this.store.refFor(
      admitted.admission.run_id,
      SCA_P08_REVIEWING_STATE,
      null,
      "sca-p08-cognitive-payload",
      "sca-p08-review-payload",
      1
    );
    if (payloadRef === null) throw new Error("P08 review payload is absent");
    const validated = validateScaP08ReviewAgainstPayload(
      review,
      validateScaP08CognitivePayloadV1(exactJson(this.store, payloadRef, "review payload")),
      assessmentRef.content_digest
    );
    for (const item of validated.items) {
      for (const ref of item.exact_record_refs) {
        if (!admitted.admitted_evidence_ref_ids.has(ref.artifact_id)) {
          throw new Error("P08 review cites an exact record outside the admitted lineage");
        }
        exactBytes(this.store, ref, "review exact record");
      }
    }
    return new Map(
      validated.items.map((item) => [
        item.item_id,
        { verdict: item.verdict, ref: reviewRef, exact: item.exact_record_refs },
      ])
    );
  }

  private assertCitedEvidence(
    admitted: ScaP08AdmissionResultV1,
    assertion: ScaP08DispositionAssertionV1
  ): void {
    const cited: ArtifactRef[] = [
      ...assertion.supporting_evidence_refs,
      ...assertion.defeating_evidence_refs,
      ...assertion.equivalence_evidence_refs,
      ...(assertion.scope_evidence_ref === null ? [] : [assertion.scope_evidence_ref]),
    ];
    for (const ref of cited) {
      if (!admitted.admitted_evidence_ref_ids.has(ref.artifact_id)) {
        throw new Error("P08 disposition cites evidence outside the admitted lineage");
      }
      exactBytes(this.store, ref, "cited evidence");
    }
  }

  private persistFinalization(
    context: RunContext,
    state: P08Data,
    admitted: ScaP08AdmissionResultV1,
    finalItems: readonly P08FinalItemV1[],
    modeBlockers: readonly string[],
    mode: string,
    validation: ScaP08AssessmentValidationV1
  ): { readonly terminal: ScaP08TerminalV1; readonly artifactRefs: ArtifactRef[] } {
    const runId = context.identity.run_id;
    const now = this.trustedClock().toISOString();
    const resolved = new Map<
      string,
      {
        readonly ref: ArtifactRef;
        readonly prior_revision_refs: readonly ArtifactRef[];
        readonly disposition: ScaP08DispositionKindV1;
      }
    >();
    for (const final of finalItems) {
      const prior = admitted.prior_by_item_id.get(final.item.item_id) ?? null;
      if (prior !== null && mode !== "complete") {
        // A failed reassessment cannot rewrite a prior immutable disposition; retain and block.
        resolved.set(final.item.item_id, {
          ref: prior.ref,
          prior_revision_refs: prior.chain.slice(0, -1),
          disposition: prior.revision.disposition,
        });
        continue;
      }
      if (prior === null) {
        const revision = validateScaP08DispositionRevisionV1(
          withP08Digest(
            {
              schema_id: SCA_P08_DISPOSITION_REVISION_SCHEMA,
              schema_version: 1 as const,
              phase_id: P08_PHASE,
              run_id: runId,
              item_id: final.item.item_id,
              item_kind: final.item.item_kind,
              identity: final.item.identity,
              revision: 1,
              parent_revision_ref: null,
              parent_revision_sha256: null,
              disposition: final.disposition,
              ...final.support,
              review_verdict: final.review_verdict,
              review_ref: final.review_ref,
              review_exact_record_refs: [...final.review_exact_record_refs],
              change_reason_codes: ["initial_construction"],
              changed_fields: [],
              created_at: now,
            },
            "revision_sha256"
          )
        );
        const ref = persistJson({
          store: this.store,
          context,
          runId,
          phase: P08_PHASE,
          kind: "sca-p08-disposition-revision",
          operationId: `sca-p08-${final.item.item_id}-revision-000001`,
          schemaId: SCA_P08_DISPOSITION_REVISION_SCHEMA,
          value: revision,
          upstreamRefs: revisionUpstreams(final),
          select: false,
        });
        resolved.set(final.item.item_id, {
          ref,
          prior_revision_refs: [],
          disposition: final.disposition,
        });
        continue;
      }
      const changedFields = materialChangedFields(prior.revision, final);
      const entry = admitted.reassessment_by_item_id.get(final.item.item_id);
      if (changedFields.length === 0 || entry === undefined) {
        // A severity/location-only (or fully unchanged) reassessment is a no-op (`SCA-D02`):
        // the earlier immutable revision stays current and no snapshot is rewritten. An
        // untriggered material change is caught earlier and falls back to this same retention.
        resolved.set(final.item.item_id, {
          ref: prior.ref,
          prior_revision_refs: prior.chain.slice(0, -1),
          disposition: prior.revision.disposition,
        });
        continue;
      }
      const revisionNumber = prior.revision.revision + 1;
      const revision = validateScaP08DispositionRevisionV1(
        withP08Digest(
          {
            schema_id: SCA_P08_DISPOSITION_REVISION_SCHEMA,
            schema_version: 1 as const,
            phase_id: P08_PHASE,
            run_id: runId,
            item_id: final.item.item_id,
            item_kind: final.item.item_kind,
            identity: final.item.identity,
            revision: revisionNumber,
            parent_revision_ref: prior.ref,
            parent_revision_sha256: prior.ref.content_digest,
            disposition: final.disposition,
            ...final.support,
            review_verdict: final.review_verdict,
            review_ref: final.review_ref,
            review_exact_record_refs: [...final.review_exact_record_refs],
            change_reason_codes: [...entry.change_reason_codes],
            changed_fields: [...changedFields],
            created_at: now,
          },
          "revision_sha256"
        )
      );
      const ref = persistJson({
        store: this.store,
        context,
        runId,
        phase: P08_PHASE,
        kind: "sca-p08-disposition-revision",
        operationId: `sca-p08-${final.item.item_id}-revision-${String(revisionNumber).padStart(
          6,
          "0"
        )}`,
        schemaId: SCA_P08_DISPOSITION_REVISION_SCHEMA,
        value: revision,
        upstreamRefs: [...revisionUpstreams(final), prior.ref],
        select: false,
      });
      resolved.set(final.item.item_id, {
        ref,
        prior_revision_refs: [...prior.chain],
        disposition: final.disposition,
      });
    }
    const revisionRefs = new Map(
      [...resolved.entries()].map(([itemId, entry]) => [itemId, entry.ref])
    );
    const ordered = [...finalItems].sort((left, right) =>
      left.item.item_id < right.item.item_id ? -1 : left.item.item_id > right.item.item_id ? 1 : 0
    );
    const rows = ordered.map((final) => {
      const entry = resolved.get(final.item.item_id);
      if (entry === undefined) throw new Error("P08 disposition revision ref is absent");
      return {
        item_id: final.item.item_id,
        item_kind: final.item.item_kind,
        identity: final.item.identity,
        disposition: entry.disposition,
        current_revision_ref: entry.ref,
        prior_revision_refs: [...entry.prior_revision_refs] as ArtifactRef[],
        blocker_codes: [...final.blocker_codes],
      };
    });
    const count = (kind: ScaP08DispositionKindV1): number =>
      rows.filter((row) => row.disposition === kind).length;
    const unresolvedRefs = rows
      .filter((row) => row.disposition === "inconclusive" || row.disposition === "deferred")
      .map((row) => row.current_revision_ref);
    const ledgerRevision =
      admitted.prior_ledger === null ? 1 : (admitted.prior_ledger.ledger_revision ?? 1) + 1;
    const ledger = validateScaP08EvidenceLedgerV1(
      withP08Digest(
        {
          schema_id: SCA_P08_EVIDENCE_LEDGER_SCHEMA,
          schema_version: 1 as const,
          phase_id: P08_PHASE,
          run_id: runId,
          admission_ref: state.admission_ref,
          p07_terminal_ref: admitted.admission.p07_terminal_ref,
          p07_transition_ref: admitted.admission.p07_transition_ref,
          p07_evidence_ledger_ref: admitted.admission.p07_evidence_ledger_ref,
          prior_p08_ledger_ref: admitted.prior_ledger_ref,
          prior_p08_ledger_sha256: admitted.prior_ledger_ref?.content_digest ?? null,
          ledger_revision: ledgerRevision,
          append_only: true as const,
          items: rows,
          item_count: rows.length,
          confirmed_count: count("confirmed"),
          rejected_with_evidence_count: count("rejected-with-evidence"),
          inconclusive_count: count("inconclusive"),
          deferred_count: count("deferred"),
          duplicate_of_count: count("duplicate-of"),
          out_of_scope_count: count("out-of-scope"),
          unresolved_item_refs: unresolvedRefs,
          exhaustive_accounting: true as const,
          release_eligible: false as const,
          campaign_complete: false as const,
        },
        "ledger_sha256"
      )
    );
    const ledgerRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P08_PHASE,
      kind: "sca-p08-evidence-ledger",
      operationId:
        ledgerRevision === 1
          ? "sca-p08-evidence-ledger"
          : `sca-p08-evidence-ledger-revision-${String(ledgerRevision).padStart(6, "0")}`,
      schemaId: SCA_P08_EVIDENCE_LEDGER_SCHEMA,
      value: ledger,
      upstreamRefs: [
        state.admission_ref,
        state.universe_ref,
        ...revisionRefs.values(),
        ...(admitted.prior_ledger_ref === null ? [] : [admitted.prior_ledger_ref]),
      ],
    });
    const unresolved = unresolvedRefs.length;

    // Derive every gate boolean from a predicate the host actually established. Nothing here is a
    // hardcoded `true`, so a gate can never record a readiness it did not verify (`SCA-P08` R4).
    const universeIds = new Set(admitted.items.map((item) => item.item_id));
    const exhaustiveAccounting =
      rows.length === admitted.items.length &&
      new Set(rows.map((row) => row.item_id)).size === rows.length &&
      rows.every((row) => universeIds.has(row.item_id)) &&
      ledger.item_count === rows.length &&
      ledger.exhaustive_accounting === true;
    const appendOnlyRevisions = [...resolved.entries()].every(([itemId, entry]) => {
      if (entry.ref.kind !== "sca-p08-disposition-revision") return false;
      const prior = admitted.prior_by_item_id.get(itemId) ?? null;
      if (prior === null) return entry.prior_revision_refs.length === 0;
      const expectedPrefix =
        entry.ref.artifact_id === prior.ref.artifact_id ? prior.chain.slice(0, -1) : prior.chain;
      return (
        entry.prior_revision_refs.length === expectedPrefix.length &&
        entry.prior_revision_refs.every(
          (ref, index) => ref.artifact_id === expectedPrefix[index]?.artifact_id
        )
      );
    });
    const immutableP07LineageValid =
      validation.immutable_p07_lineage_valid &&
      admitted.admission.universe_sha256 === admitted.universe.universe_sha256 &&
      admitted.admission.item_count === admitted.items.length;
    // The non-authorizing handoff/terminal claims are closed schema literals; only the ledger's
    // own flags are dynamic here.
    const p09OrReportOrReleaseClaimsAbsent =
      ledger.release_eligible === false && ledger.campaign_complete === false;
    const gatePredicatesMet =
      exhaustiveAccounting &&
      immutableP07LineageValid &&
      validation.support_semantics_valid &&
      validation.no_false_refutation &&
      validation.scope_duplicate_deferred_valid &&
      appendOnlyRevisions &&
      p09OrReportOrReleaseClaimsAbsent;
    const invalidBlockers = [
      ...new Set([
        ...modeBlockers,
        ...validation.blockers,
        ...(gatePredicatesMet ? [] : ["p08_gate_predicate_unmet"]),
      ]),
    ].sort();
    const verdict: ScaP08GateV1["verdict"] =
      invalidBlockers.length > 0
        ? ("blocked_invalid" as const)
        : unresolved > 0
          ? ("pass_blocked" as const)
          : ("pass_ready" as const);
    const gateBlockers = [
      ...new Set([...invalidBlockers, ...(unresolved > 0 ? ["p08_required_gaps_retained"] : [])]),
    ].sort();
    const gate = validateScaP08GateV1(
      withP08Digest(
        {
          schema_id: SCA_P08_GATE_SCHEMA,
          schema_version: 1 as const,
          phase_id: P08_PHASE,
          criterion_id: "AC-P08" as const,
          verdict,
          evidence_ledger_ref: ledgerRef,
          p07_terminal_ref: admitted.admission.p07_terminal_ref,
          p07_transition_ref: admitted.admission.p07_transition_ref,
          p07_evidence_ledger_ref: admitted.admission.p07_evidence_ledger_ref,
          exhaustive_accounting: exhaustiveAccounting,
          immutable_p07_lineage_valid: immutableP07LineageValid,
          support_semantics_valid: validation.support_semantics_valid,
          no_false_refutation: validation.no_false_refutation,
          scope_duplicate_deferred_valid: validation.scope_duplicate_deferred_valid,
          append_only_revisions: appendOnlyRevisions,
          retained_required_gaps: unresolved > 0,
          p09_or_report_or_release_claims_absent: p09OrReportOrReleaseClaimsAbsent,
          item_count: rows.length,
          confirmed_count: count("confirmed"),
          rejected_with_evidence_count: count("rejected-with-evidence"),
          inconclusive_count: count("inconclusive"),
          deferred_count: count("deferred"),
          duplicate_of_count: count("duplicate-of"),
          out_of_scope_count: count("out-of-scope"),
          unresolved_item_count: unresolved,
          blocker_codes: gateBlockers,
          evaluated_at: now,
        },
        "gate_sha256"
      )
    );
    const gateRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P08_PHASE,
      kind: "sca-p08-gate",
      operationId: "sca-p08-gate",
      schemaId: SCA_P08_GATE_SCHEMA,
      value: gate,
      upstreamRefs: [ledgerRef],
    });
    const transition = validateScaP08ToP09TransitionV1(
      withP08Digest(
        {
          schema_id: SCA_P08_TO_P09_TRANSITION_SCHEMA,
          schema_version: 1 as const,
          source_phase_id: P08_PHASE,
          target_phase_id: "SCA-P09" as const,
          handoff_kind: "candidate_disposition_only" as const,
          qualification_scope: "disposition_gate_only_not_p09_reconciliation" as const,
          phase_gate_passed: false as const,
          p09_reconciliation_authorized_by_this_transition: false as const,
          p07_terminal_ref: admitted.admission.p07_terminal_ref,
          p07_transition_ref: admitted.admission.p07_transition_ref,
          p07_evidence_ledger_ref: admitted.admission.p07_evidence_ledger_ref,
          p08_evidence_ledger_ref: ledgerRef,
          item_count: rows.length,
          confirmed_count: count("confirmed"),
          rejected_with_evidence_count: count("rejected-with-evidence"),
          inconclusive_count: count("inconclusive"),
          deferred_count: count("deferred"),
          duplicate_of_count: count("duplicate-of"),
          out_of_scope_count: count("out-of-scope"),
          unresolved_item_refs: unresolvedRefs,
          required_gaps_retained: true as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          campaign_completion_claimed: false as const,
        },
        "transition_sha256"
      )
    );
    const transitionRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P08_PHASE,
      kind: "sca-p08-to-p09-transition",
      operationId: "sca-p08-to-p09-transition",
      schemaId: SCA_P08_TO_P09_TRANSITION_SCHEMA,
      value: transition,
      upstreamRefs: [ledgerRef, gateRef],
    });
    const terminal = validateScaP08TerminalV1(
      withP08Digest(
        {
          schema_id: SCA_P08_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P08_PHASE,
          status: verdict === "pass_ready" ? ("candidate_complete" as const) : ("blocked" as const),
          evidence_ledger_ref: ledgerRef,
          gate_ref: gateRef,
          p09_transition_ref: transitionRef,
          p09_handoff_ready: true,
          item_count: rows.length,
          confirmed_count: count("confirmed"),
          rejected_with_evidence_count: count("rejected-with-evidence"),
          inconclusive_count: count("inconclusive"),
          deferred_count: count("deferred"),
          duplicate_of_count: count("duplicate-of"),
          out_of_scope_count: count("out-of-scope"),
          selected_artifact_refs: uniqueRefs([
            state.admission_ref,
            state.universe_ref,
            ledgerRef,
            gateRef,
            transitionRef,
            ...this.selectedCoreRefs(context),
            ...revisionRefs.values(),
          ]).slice(0, 128),
          blocker_codes: gateBlockers,
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          report_or_finding_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P08_PHASE,
      kind: "sca-p08-terminal",
      operationId: "sca-p08-terminal",
      schemaId: SCA_P08_TERMINAL_SCHEMA,
      value: terminal,
      upstreamRefs: [ledgerRef, gateRef, transitionRef],
    });
    return {
      terminal,
      artifactRefs: uniqueRefs([
        state.admission_ref,
        state.universe_ref,
        ledgerRef,
        gateRef,
        transitionRef,
        terminalRef,
        ...revisionRefs.values(),
      ]).slice(0, 128),
    };
  }

  private selectedCoreRefs(context: RunContext): ArtifactRef[] {
    const kinds = new Set([
      SCA_P08_REQUEST_KIND,
      "sca-p08-item-universe",
      "sca-p08-admission",
      "sca-p08-cognitive-payload",
      "sca-p08-disclosure-admission",
      ASSESSMENT_RECORD_KIND,
      REVIEW_RECORD_KIND,
      "sca-p08-disposition-revision",
      "sca-p08-evidence-ledger",
      "sca-p08-gate",
      "sca-p08-to-p09-transition",
      "sca-p08-terminal",
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

export const SCA_P08_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: SCA_P08_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Assign exactly one evidence-based disposition to every admitted P06/P07 item through one DeepSeek assessment and one independent DeepSeek review, then deterministically finalize immutable per-item revisions, an exhaustive ledger, a gate, and a non-authorizing P09 handoff, without gathering evidence, executing a target, adjudicating a report, releasing, or completing a campaign.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: SCA_P08_START_V1_SCHEMA,
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [
      port({
        name: "p08_item_universe",
        kind: "sca-p08-item-universe",
        schema: SCA_P08_ITEM_UNIVERSE_SCHEMA,
        direction: "input",
      }),
      port({
        name: "p08_admission",
        kind: "sca-p08-admission",
        schema: SCA_P08_ADMISSION_SCHEMA,
        direction: "input",
      }),
    ],
    active_output_ports: [
      port({
        name: "p08_disposition_revisions",
        kind: "sca-p08-disposition-revision",
        schema: SCA_P08_DISPOSITION_REVISION_SCHEMA,
        direction: "output",
        min: 0,
        max: 10_000,
      }),
      port({
        name: "p08_evidence_ledger",
        kind: "sca-p08-evidence-ledger",
        schema: SCA_P08_EVIDENCE_LEDGER_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p08_gate",
        kind: "sca-p08-gate",
        schema: SCA_P08_GATE_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p08_to_p09_transition",
        kind: "sca-p08-to-p09-transition",
        schema: SCA_P08_TO_P09_TRANSITION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p08_terminal",
        kind: "sca-p08-terminal",
        schema: SCA_P08_TERMINAL_SCHEMA,
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
    policy_id: "penny.sca-p08-candidate-budget.v1",
    resolver_id: "scaP08CandidateDeterministicResolver",
    admission_id: "scaP08CandidateAdmission",
    snapshot_id: "scaP08CandidateSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [SCA_P08_FINAL_STATE],
    required_visited_states: [SCA_P08_FINAL_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: SCA_P08_TERMINAL_SCHEMA,
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

const START_ADMISSION: StartAdmissionV1 = {
  schema_id: SCA_P08_START_V1_SCHEMA,
  schema_version: 1,
  prepare(request: StartRequest): PreparedStartV1 {
    const constraints = validateContract(
      ScaP08StartConstraintsV1Schema,
      request.constraints,
      "SCA P08 start constraints"
    );
    if (request.identity.playbook !== SCA_P08_CANDIDATE_PLAYBOOK_NAME) {
      throw new Error("SCA P08 start identity is invalid");
    }
    const inputs: InputArtifacts | undefined = request.input_artifacts;
    const expected = [
      { slot: "p07_terminal", ref: constraints.p07_terminal_ref },
      { slot: "p07_evidence_ledger", ref: constraints.p07_evidence_ledger_ref },
      { slot: "disclosure_scope", ref: constraints.disclosure_scope_ref },
      ...(constraints.p07_transition_ref === null
        ? []
        : [{ slot: "p07_transition", ref: constraints.p07_transition_ref }]),
      ...(constraints.p08_reassessment_ref === undefined ||
      constraints.p08_reassessment_ref === null
        ? []
        : [{ slot: "p08_reassessment", ref: constraints.p08_reassessment_ref }]),
      ...(constraints.p08_equivalence_proof_refs ?? []).map((ref) => ({
        slot: "p08_equivalence_proof",
        ref,
      })),
    ];
    if (
      inputs === undefined ||
      inputs.artifacts.length !== expected.length ||
      expected.some(
        (entry, index) =>
          inputs.artifacts[index]?.slot !== entry.slot ||
          !same(inputs.artifacts[index]?.ref, entry.ref)
      )
    ) {
      throw new Error("SCA P08 start inputs do not equal the declared exact lineage refs");
    }
    return {
      schema_id: SCA_P08_START_V1_SCHEMA,
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
      throw new Error("SCA P08 materialization requires artifact store and exact inputs");
    }
    const constraints = validateContract(
      ScaP08StartConstraintsV1Schema,
      prepared.constraints,
      "SCA P08 start constraints"
    );
    const requestRef = persistJson({
      store: host.artifactStore,
      runId: host.run_id,
      phase: P08_PHASE,
      kind: SCA_P08_REQUEST_KIND,
      operationId: "sca-p08-candidate-request",
      schemaId: SCA_P08_START_V1_SCHEMA,
      value: constraints,
      upstreamRefs: [
        constraints.p07_terminal_ref,
        constraints.p07_evidence_ledger_ref,
        constraints.disclosure_scope_ref,
        ...(constraints.p07_transition_ref === null ? [] : [constraints.p07_transition_ref]),
        ...(constraints.p08_reassessment_ref === undefined ||
        constraints.p08_reassessment_ref === null
          ? []
          : [constraints.p08_reassessment_ref]),
        ...(constraints.p08_equivalence_proof_refs ?? []),
      ],
    });
    const admitted = admitScaP08Disposition({
      store: host.artifactStore,
      run_id: host.run_id,
      p07_terminal_ref: constraints.p07_terminal_ref,
      p07_evidence_ledger_ref: constraints.p07_evidence_ledger_ref,
      p07_transition_ref: constraints.p07_transition_ref,
      disclosure_scope_ref: constraints.disclosure_scope_ref,
      p08_reassessment_ref: constraints.p08_reassessment_ref ?? null,
      p08_equivalence_proof_refs: constraints.p08_equivalence_proof_refs ?? [],
    });
    const universeRef = persistJson({
      store: host.artifactStore,
      runId: host.run_id,
      phase: P08_PHASE,
      kind: "sca-p08-item-universe",
      operationId: "sca-p08-item-universe",
      schemaId: SCA_P08_ITEM_UNIVERSE_SCHEMA,
      value: admitted.universe,
      upstreamRefs: [requestRef, ...admitted.evidence_refs],
    });
    const admissionRef = persistJson({
      store: host.artifactStore,
      runId: host.run_id,
      phase: P08_PHASE,
      kind: "sca-p08-admission",
      operationId: "sca-p08-admission",
      schemaId: SCA_P08_ADMISSION_SCHEMA,
      value: admitted.admission,
      upstreamRefs: [universeRef],
    });
    return [requestRef, universeRef, admissionRef];
  },
};

function buildScaP08CandidateRegistration(binding: ScaP08CandidateBindingV1): PlaybookRegistration {
  const registration: PlaybookRegistration = {
    name: SCA_P08_CANDIDATE_PLAYBOOK_NAME,
    contract: SCA_P08_CANDIDATE_SKILL_CONTRACT,
    ingress: "skill" as const,
    start_admission: START_ADMISSION,
    caller_documentation: {
      constraints_schema: ScaP08StartConstraintsV1Schema,
      example: {
        goal: "Run the inactive P08 evidence-based disposition candidate.",
        constraints: {
          p07_terminal_ref: {},
          p07_transition_ref: null,
          p07_evidence_ledger_ref: {},
          disclosure_scope_ref: {},
        },
      },
      semantic_caveat:
        "P08 records dispositions over the exact admitted P07 result. It does not gather evidence, reconcile P09, report, release, or complete a campaign, and it never claims public success.",
    },
    liveness: {
      resolver_id: SCA_P08_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
      resolve: () => undefined,
      thinking_policy: "agent_ssot" as const,
    },
    worker: {
      kind: "catalog-agent" as const,
      workflow_name: SCA_P08_CANDIDATE_PLAYBOOK_NAME,
      guidance: SCA_P08_CANDIDATE_SKILL_CONTRACT.guidance,
      guidance_required: true as const,
      result_transport: "persisted_summary" as const,
      opening_policy: "registration_guidance_task_artifacts" as const,
      model_policy: "directive_override_or_runtime_default" as const,
      phases: new Map([
        [
          SCA_P08_ASSESSING_STATE,
          {
            agent: SCA_P08_ASSESSOR_AGENT,
            result_schema_id: SCA_P08_ASSESSMENT_SCHEMA,
            result_schema_version: 1 as const,
            schema: ScaP08DispositionAssessmentV1Schema,
            allowed_tools: SCA_P08_REQUIRED_TOOL_SUBSET,
            required_model: SCA_P08_REQUIRED_MODEL,
            provider_opening_guard: SCA_P08_PROVIDER_OPENING_GUARD,
          },
        ],
        [
          SCA_P08_REVIEWING_STATE,
          {
            agent: SCA_P08_REVIEWER_AGENT,
            result_schema_id: SCA_P08_REVIEW_SCHEMA,
            result_schema_version: 1 as const,
            schema: ScaP08DispositionReviewV1Schema,
            allowed_tools: SCA_P08_REQUIRED_TOOL_SUBSET,
            required_model: SCA_P08_REQUIRED_MODEL,
            provider_opening_guard: SCA_P08_PROVIDER_OPENING_GUARD,
          },
        ],
      ]),
    },
    host_states: [SCA_P08_FINAL_STATE],
    completionReceiptPredicates: new Map(),
    construct: (options) => {
      if (options.artifactStore === undefined) {
        throw new Error("SCA P08 candidate requires the artifact host store");
      }
      return new ScaP08CandidatePlaybook(
        options.artifactStore,
        binding,
        options.trustedClock ?? (() => new Date())
      );
    },
  };
  return Object.freeze(registration);
}

/** Production composition factory requiring an explicit current P07 authority resolver. */
export function createScaP08CandidateRegistrationV1(input: {
  readonly resolve_current_p07_authority_ref: (scope: {
    readonly tenant_id: string;
    readonly project_id: string;
    readonly run_id: string;
    readonly transition_ref: ArtifactRef;
  }) => ArtifactRef;
}): PlaybookRegistration {
  if (typeof input.resolve_current_p07_authority_ref !== "function") {
    throw new Error("SCA P08 candidate requires an independent current-authority resolver");
  }
  return buildScaP08CandidateRegistration({
    resolve_current_p07_authority_ref: input.resolve_current_p07_authority_ref,
  });
}

/** Fixed provider-free compatibility fixture used by focused tests. */
export const SCA_P08_CANDIDATE_REGISTRATION: PlaybookRegistration =
  buildScaP08CandidateRegistration({});
