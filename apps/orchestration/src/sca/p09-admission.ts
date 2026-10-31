import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import {
  SCA_OBLIGATION_LEDGER_V2_SCHEMA,
  effectiveScaObligations,
  validateScaObligationLedgerV2,
  type ScaObligationEntryV2,
  type ScaObligationLedgerV2,
} from "./p01-contracts.js";
import {
  validateScaP06AcceptedCohortV1,
  validateScaP06ActionRecordV1,
  validateScaP06CheckpointV1,
  validateScaP06DiscoveryReassessmentV1,
  validateScaP06GateV1,
  validateScaP06ObligationRevisionV1,
  validateScaP06SuccessorLedgerV1,
  validateScaP06ToP07TransitionV1,
  validateScaP06TraceabilityV1,
  type ScaP06AcceptedCohortV1,
  type ScaP06ActionRecordV1,
  type ScaP06CheckpointV1,
  type ScaP06ObligationRevisionV1,
  type ScaP06SuccessorLedgerV1,
  type ScaP06TraceabilityV1,
} from "./p06-contracts.js";
import { admitScaP08Disposition, type ScaP08AdmittedItemV1 } from "./p08-admission.js";
import type { ScaP07CurrentAuthorityScopeV1 } from "./p07-admission.js";
import { validateScaP05HypothesisRevisionV1 } from "./p05-contracts.js";
import {
  isScaP08ScopeDecisionKind,
  scaP08DuplicatePairKey,
  validateScaP08AdmissionV1,
  validateScaP08DispositionRevisionV1,
  validateScaP08DuplicateEquivalenceProofV1,
  validateScaP08EvidenceLedgerV1,
  validateScaP08GateV1,
  validateScaP08ItemUniverseV1,
  validateScaP08TerminalV1,
  validateScaP08ToP09TransitionV1,
  type ScaP08AdmissionV1,
  type ScaP08DispositionKindV1,
  type ScaP08DispositionRevisionV1,
  type ScaP08EvidenceLedgerV1,
  type ScaP08GateV1,
  type ScaP08ItemUniverseV1,
  type ScaP08TerminalV1,
  type ScaP08ToP09TransitionV1,
} from "./p08-contracts.js";
import {
  SCA_P09_ADMISSION_SCHEMA,
  SCA_P09_CANDIDATE_SURFACE_KINDS,
  SCA_P09_UNREACHABLE_COVERAGE_OBLIGATION_IDS,
  scaP09CoverageEvidenceForSurfaceKind,
  scaP09CoverageScopeComplete,
  scaP09ExpectedResolutionEvidence,
  scaP09ItemId,
  scaP09ObligationClassPrecedence,
  scaP09PhaseEvidenceBinding,
  scaP09UniverseSha256,
  validateScaP09AdmissionV1,
  validateScaP09CoverageInputV1,
  validateScaP09ObligationResolutionV1,
  withP09Digest,
  type ScaP09AdmissionV1,
  type ScaP09CoverageInputV1,
  type ScaP09CoverageStateV1,
  type ScaP09CoverageSurfaceKindV1,
  type ScaP09ItemKindV1,
  type ScaP09ObligationClassV1,
  type ScaP09ObligationResolutionEntryV1,
  type ScaP09PhaseEvidenceBindingV1,
} from "./p09-contracts.js";

export const SCA_P01_OBLIGATION_LEDGER_KIND = "sca-p01-candidate-obligation-ledger" as const;

/** The phase-acceptance obligation whose prerequisites define the P09-entry due frontier. */
const SCA_P09_P08_ACCEPTANCE_OBLIGATION_ID = "SCA-OBL-P08-ACCEPTANCE" as const;

/** Independent resolver scope for the current P01 obligation-ledger head (`SCA-O02`). */
export interface ScaP09CurrentObligationHeadScopeV1 {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
}

/** One deterministic effective-class derivation over an obligation's immutable revision chain. */
export interface ScaP09ObligationDerivationV1 {
  readonly obligation_id: string;
  readonly revision: number;
  readonly revision_kind: "registered" | "promoted";
  readonly revision_chain_refs: readonly ArtifactRef[];
  readonly effective_class: ScaP09ObligationClassV1;
  readonly precedence: number;
  readonly strongest_class_seen: ScaP09ObligationClassV1;
  readonly material: boolean;
  readonly completion_effect: "required-for-campaign" | "nonterminal" | "none";
  readonly scope: ScaObligationEntryV2["scope"];
  readonly semantic_phase_id: ScaObligationEntryV2["semantic_phase_id"];
  readonly occurred_at: string;
  /** Exact digest of the resolved effective revision entry (binds a resolution to one revision). */
  readonly effective_entry_sha256: string;
  /** True when the obligation is a prerequisite of reaching P09 entry (P01–P08 boundary/output). */
  readonly due_at_p09_entry: boolean;
}

/**
 * One admitted reconciliation universe item before eligibility/blocker derivation. It carries only
 * exact admitted facts; eligibility, coverage completeness, and lane are derived at reconciliation.
 */
export interface ScaP09AdmittedItemV1 {
  readonly item_id: string;
  readonly item_kind: ScaP09ItemKindV1;
  readonly identity: string;
  readonly primary_ref: ArtifactRef;
  readonly p08_disposition: ScaP08DispositionKindV1 | null;
  readonly p08_disposition_ref: ArtifactRef | null;
  readonly p08_blocker_codes: readonly string[];
  readonly p06_checkpoint_ref: ArtifactRef | null;
  readonly effective_class: ScaP09ObligationClassV1 | null;
  readonly precedence: number | null;
  readonly revision_chain_refs: readonly ArtifactRef[];
  readonly coverage_state: ScaP09CoverageStateV1 | null;
  readonly coverage_reason: string | null;
  readonly coverage_surface_kind: ScaP09CoverageSurfaceKindV1 | null;
  readonly coverage_blocker_codes: readonly string[];
  readonly p07_status: "completed" | "blocked" | "not_invoked" | null;
  /** True for obligations due at P09 entry; false for future downstream obligations. */
  readonly due_at_p09_entry: boolean;
  /** Set when the item cannot be discharged by an admitted disposition and needs a P09 checkpoint. */
  readonly checkpoint_needed: {
    readonly reason_code: string;
    readonly missing_evidence_need: string;
    readonly reopen_condition: string;
  } | null;
}

export interface ScaP09AdmissionResultV1 {
  readonly admission: ScaP09AdmissionV1;
  /** Explicit E1–E7 set-equality accounting; null for a non-reconcilable checkpoint. */
  readonly set_equality: {
    readonly e1: boolean;
    readonly e2: boolean;
    readonly e3: boolean;
    readonly e4: boolean;
    readonly e5: boolean;
    readonly e6: boolean;
    readonly e7: boolean;
  } | null;
  readonly non_reconcilable: boolean;
  readonly non_reconcilable_reason: string | null;
  readonly p08_terminal: ScaP08TerminalV1 | null;
  readonly p08_transition: ScaP08ToP09TransitionV1 | null;
  readonly p08_ledger: ScaP08EvidenceLedgerV1 | null;
  readonly p08_gate: ScaP08GateV1 | null;
  readonly p08_admission: ScaP08AdmissionV1 | null;
  readonly p08_universe: ScaP08ItemUniverseV1 | null;
  readonly p08_items: readonly ScaP08AdmittedItemV1[];
  readonly p08_revision_by_item_id: ReadonlyMap<
    string,
    {
      readonly revision: ScaP08DispositionRevisionV1;
      readonly ref: ArtifactRef;
      readonly chain: readonly ArtifactRef[];
    }
  >;
  /** P06 evidence-obligation base/material revisions, keyed by obligation identity. */
  readonly p06_obligation_by_identity: ReadonlyMap<
    string,
    {
      readonly revision: ScaP06ObligationRevisionV1;
      readonly base_ref: ArtifactRef;
      readonly revision_ref: ArtifactRef;
      readonly hypothesis_created_at: string | null;
      readonly reassessment_evaluated_at: string | null;
    }
  >;
  /** Exact P06 action records keyed by action identity. */
  readonly action_by_identity: ReadonlyMap<string, ScaP06ActionRecordV1>;
  /** The hypothesis each admitted P08 item belongs to, keyed by item identity. */
  readonly hypothesis_id_by_identity: ReadonlyMap<string, string>;
  readonly p01_ledger: ScaObligationLedgerV2 | null;
  readonly p01_ledger_ref: ArtifactRef | null;
  readonly p01_head_attested: boolean;
  readonly p01_fork_safety: "attested_unchanged" | "unattested_chain_revalidated";
  readonly p01_obligations: ReadonlyMap<string, ScaP09ObligationDerivationV1>;
  readonly coverage_input: ScaP09CoverageInputV1 | null;
  readonly coverage_input_ref: ArtifactRef | null;
  /** Exact, explicitly admitted typed phase-evidence sources (host-declared and revalidated). */
  readonly phase_evidence_refs: readonly ArtifactRef[];
  /** Valid exact obligation resolutions, keyed by obligation identity. */
  readonly obligation_resolutions: ReadonlyMap<
    string,
    {
      readonly entry: ScaP09ObligationResolutionEntryV1;
      readonly evidence_refs: readonly ArtifactRef[];
    }
  >;
  readonly obligation_resolution_ref: ArtifactRef | null;
  readonly p08_authority_assurance: "attested_unchanged" | "unattested_chain_revalidated";
  readonly items: readonly ScaP09AdmittedItemV1[];
  readonly evidence_refs: readonly ArtifactRef[];
  /** Structural failures discovered while re-deriving the recorded lineage (fail-closed). */
  readonly invalid_blocker_codes: readonly string[];
}

export interface ScaP09AdmissionInputV1 {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly p08_terminal_ref: ArtifactRef;
  readonly p08_transition_ref: ArtifactRef | null;
  readonly p08_evidence_ledger_ref: ArtifactRef | null;
  readonly p08_gate_ref: ArtifactRef | null;
  readonly p08_admission_ref: ArtifactRef | null;
  readonly p08_item_universe_ref: ArtifactRef | null;
  readonly p01_obligation_ledger_ref: ArtifactRef;
  readonly coverage_input_ref?: ArtifactRef | null;
  /**
   * Exact typed phase-evidence sources the host explicitly admits as resolution evidence. Each ref
   * is exact-read and revalidated against its closed kind/phase/schema/gate-status binding; a
   * fabricated standalone gate is never admitted without matching these semantics.
   */
  readonly phase_evidence_refs?: readonly ArtifactRef[];
  /** Closed exact obligation-resolution input for the due P01 obligations. */
  readonly obligation_resolution_ref?: ArtifactRef | null;
  /** Independent resolver of the current P07 execution authority (production binding). */
  readonly resolve_current_p07_authority_ref?: (
    scope: ScaP07CurrentAuthorityScopeV1
  ) => ArtifactRef;
  /** Independent resolver of the current P01 obligation-ledger head (production binding). */
  readonly resolve_current_p01_obligation_head_ref?: (
    scope: ScaP09CurrentObligationHeadScopeV1
  ) => ArtifactRef;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function requireSame(left: unknown, right: unknown, label: string): void {
  if (!same(left, right)) throw new Error(`P09 ${label} exact binding mismatch`);
}
function exact<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  kind: string,
  validate: (value: unknown) => T
): T {
  if (ref.kind !== kind || !same(store.refById(ref.artifact_id), ref)) {
    throw new Error(`P09 ${kind} exact ref absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P09 ${kind} exact bytes drifted`);
  }
  const text = bytes.toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new Error(`P09 ${kind} noncanonical bytes`);
  return validate(parsed);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function setEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function isScaP09JsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Closed gate/status/content semantics for one typed phase-evidence kind: a gate must record
 * `pass_ready`, a terminal must record `candidate_complete`, and every other admitted typed source
 * must at least be a non-array JSON object. The predicate is applied to the exact bytes, never to
 * the ref's metadata alone.
 */
function scaP09PhaseEvidenceSemanticsOk(
  binding: ScaP09PhaseEvidenceBindingV1,
  value: unknown
): boolean {
  if (!isScaP09JsonRecord(value)) return false;
  if (binding.semantics === "gate") return value.verdict === "pass_ready";
  if (binding.semantics === "terminal") return value.status === "candidate_complete";
  return true;
}

/**
 * Exact-read and revalidate every explicitly admitted typed phase-evidence source. A source is
 * admissible only when its ref is exact, host-produced, run-bound, and matches the closed
 * kind/phase/schema binding with satisfied gate/status/content semantics. Any deviation aborts
 * admission before reconciliation, so a fabricated standalone gate can never stand as evidence.
 */
function admitScaP09PhaseEvidenceRefs(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly refs: readonly ArtifactRef[];
}): readonly ArtifactRef[] {
  const admitted: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const ref of input.refs) {
    const stored = input.store.refById(ref.artifact_id);
    if (stored === undefined || !same(stored, ref)) {
      throw new Error("P09 phase-evidence source exact ref is absent or substituted");
    }
    const bytes = input.store.readById(ref.artifact_id);
    if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
      throw new Error("P09 phase-evidence source exact bytes drifted");
    }
    if (ref.run_id !== input.run_id) {
      throw new Error("P09 phase-evidence source belongs to another run");
    }
    if (!ref.producer.startsWith("host:")) {
      throw new Error("P09 phase-evidence source is not host-produced");
    }
    const binding = scaP09PhaseEvidenceBinding(ref.kind);
    if (binding === null) {
      throw new Error("P09 phase-evidence source kind is not a closed phase-evidence kind");
    }
    if (
      ref.phase !== binding.phase_id ||
      ref.content_schema === undefined ||
      !binding.schema_ids.includes(ref.content_schema.schema_id)
    ) {
      throw new Error("P09 phase-evidence source kind/phase/schema binding mismatch");
    }
    const text = bytes.toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (canonicalJson(parsed) !== text) {
      throw new Error("P09 phase-evidence source is not canonical JSON");
    }
    if (!scaP09PhaseEvidenceSemanticsOk(binding, parsed)) {
      throw new Error("P09 phase-evidence source gate/status/content semantics are not satisfied");
    }
    if (seen.has(ref.artifact_id)) {
      throw new Error("P09 phase-evidence source is declared more than once");
    }
    seen.add(ref.artifact_id);
    admitted.push(ref);
  }
  return admitted;
}

/** Byte-exact gate/status/content predicate for one already-admitted evidence ref. */
function scaP09ResolutionEvidenceSemanticsOk(store: ArtifactHostStore, ref: ArtifactRef): boolean {
  const binding = scaP09PhaseEvidenceBinding(ref.kind);
  if (binding === null) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.readById(ref.artifact_id).toString("utf8"));
  } catch {
    return false;
  }
  return scaP09PhaseEvidenceSemanticsOk(binding, parsed);
}

/**
 * Exact P08→P09 lineage admission plus P01 obligation-ledger admission. It re-derives the P08
 * admission through the shared `admitScaP08Disposition` path (never a second engine), which
 * transitively re-derives the P07/P06/P05/P01 chain. Any absent, substituted, cross-run,
 * cross-scope, stale, rehashed, non-canonical, or digest-drifted ref, any re-derivation mismatch,
 * and any count disagreement aborts admission before any reconciliation output.
 */
export function admitScaP09Reconciliation(input: ScaP09AdmissionInputV1): ScaP09AdmissionResultV1 {
  const { store } = input;
  const terminal = exact(
    store,
    input.p08_terminal_ref,
    "sca-p08-terminal",
    validateScaP08TerminalV1
  );

  // A cancelled or ledger-less P08 result is an explicit non-reconcilable checkpoint (`SCA-P09`
  // R10). P09 emits durable terminal accounting and fabricates no disposition or obligation.
  const nonReconcilable = terminal.evidence_ledger_ref === null || terminal.gate_ref === null;
  if (nonReconcilable) {
    if (
      input.p08_transition_ref !== null ||
      input.p08_evidence_ledger_ref !== null ||
      input.p08_gate_ref !== null ||
      input.p08_admission_ref !== null ||
      input.p08_item_universe_ref !== null ||
      terminal.p09_transition_ref !== null
    ) {
      throw new Error("P09 non-reconcilable P08 checkpoint cannot bind reconciliation state");
    }
    const p01 = admitP01ObligationLedger({
      store,
      run_id: input.run_id,
      ref: input.p01_obligation_ledger_ref,
      ...(input.resolve_current_p01_obligation_head_ref === undefined
        ? {}
        : { resolve: input.resolve_current_p01_obligation_head_ref }),
    });
    const reason = `p08_${terminal.status}_non_reconcilable_checkpoint`;
    const authorityAssurance =
      input.resolve_current_p07_authority_ref === undefined
        ? ("unattested_chain_revalidated" as const)
        : ("attested_unchanged" as const);
    const admission = validateScaP09AdmissionV1(
      withP09Digest(
        {
          schema_id: SCA_P09_ADMISSION_SCHEMA,
          schema_version: 1 as const,
          phase_id: "SCA-P09" as const,
          run_id: input.run_id,
          p08_terminal_ref: input.p08_terminal_ref,
          p08_transition_ref: null,
          p08_evidence_ledger_ref: null,
          p08_gate_ref: null,
          p08_admission_ref: null,
          p08_item_universe_ref: null,
          p01_obligation_ledger_ref: input.p01_obligation_ledger_ref,
          coverage_input_ref: null,
          phase_evidence_refs: [],
          obligation_resolution_ref: null,
          p01_head_attested: p01.attested,
          p01_fork_safety: p01.attested
            ? ("attested_unchanged" as const)
            : ("unattested_chain_revalidated" as const),
          p08_authority_assurance: authorityAssurance,
          p08_rederivation_ok: false,
          non_reconcilable: true,
          non_reconcilable_reason: reason,
          item_count: 0,
          universe_sha256: scaP09UniverseSha256([]),
        },
        "admission_sha256"
      )
    );
    return {
      admission,
      set_equality: null,
      non_reconcilable: true,
      non_reconcilable_reason: reason,
      p08_terminal: terminal,
      p08_transition: null,
      p08_ledger: null,
      p08_gate: null,
      p08_admission: null,
      p08_universe: null,
      p08_items: [],
      p08_revision_by_item_id: new Map(),
      p06_obligation_by_identity: new Map(),
      action_by_identity: new Map(),
      hypothesis_id_by_identity: new Map(),
      p01_ledger: p01.head,
      p01_ledger_ref: input.p01_obligation_ledger_ref,
      p01_head_attested: p01.attested,
      p01_fork_safety: p01.attested ? "attested_unchanged" : "unattested_chain_revalidated",
      p01_obligations: p01.obligations,
      coverage_input: null,
      coverage_input_ref: null,
      phase_evidence_refs: [],
      obligation_resolutions: new Map(),
      obligation_resolution_ref: null,
      p08_authority_assurance: authorityAssurance,
      items: [],
      evidence_refs: uniqueRefs([input.p08_terminal_ref, input.p01_obligation_ledger_ref]),
      invalid_blocker_codes: [],
    };
  }

  if (
    input.p08_transition_ref === null ||
    input.p08_evidence_ledger_ref === null ||
    input.p08_gate_ref === null ||
    input.p08_admission_ref === null ||
    input.p08_item_universe_ref === null
  ) {
    throw new Error("P09 reconciliation requires every recorded P08 artifact ref");
  }
  const transition = exact(
    store,
    input.p08_transition_ref,
    "sca-p08-to-p09-transition",
    validateScaP08ToP09TransitionV1
  );
  const ledger = exact(
    store,
    input.p08_evidence_ledger_ref,
    "sca-p08-evidence-ledger",
    validateScaP08EvidenceLedgerV1
  );
  const gate = exact(store, input.p08_gate_ref, "sca-p08-gate", validateScaP08GateV1);
  const recordedAdmission = exact(
    store,
    input.p08_admission_ref,
    "sca-p08-admission",
    validateScaP08AdmissionV1
  );
  const universe = exact(
    store,
    input.p08_item_universe_ref,
    "sca-p08-item-universe",
    validateScaP08ItemUniverseV1
  );

  requireSame(terminal.evidence_ledger_ref, input.p08_evidence_ledger_ref, "terminal ledger");
  requireSame(terminal.gate_ref, input.p08_gate_ref, "terminal gate");
  requireSame(terminal.p09_transition_ref, input.p08_transition_ref, "terminal transition");
  if (
    transition.handoff_kind !== "candidate_disposition_only" ||
    transition.qualification_scope !== "disposition_gate_only_not_p09_reconciliation" ||
    transition.phase_gate_passed !== false ||
    transition.p09_reconciliation_authorized_by_this_transition !== false ||
    transition.release_eligible !== false ||
    transition.campaign_complete !== false ||
    transition.campaign_completion_claimed !== false
  ) {
    throw new Error("P09 P08 transition is not the explicit non-authorizing disposition handoff");
  }
  requireSame(transition.p08_evidence_ledger_ref, input.p08_evidence_ledger_ref, "handoff ledger");
  requireSame(ledger.admission_ref, input.p08_admission_ref, "ledger admission");
  requireSame(gate.evidence_ledger_ref, input.p08_evidence_ledger_ref, "gate ledger");
  requireSame(
    ledger.p07_evidence_ledger_ref,
    recordedAdmission.p07_evidence_ledger_ref,
    "P07 ledger"
  );
  const accounting = {
    item_count: ledger.item_count,
    confirmed: ledger.confirmed_count,
    rejected: ledger.rejected_with_evidence_count,
    inconclusive: ledger.inconclusive_count,
    deferred: ledger.deferred_count,
    duplicate: ledger.duplicate_of_count,
    out_of_scope: ledger.out_of_scope_count,
  };
  requireSame(
    {
      item_count: terminal.item_count,
      confirmed: terminal.confirmed_count,
      rejected: terminal.rejected_with_evidence_count,
      inconclusive: terminal.inconclusive_count,
      deferred: terminal.deferred_count,
      duplicate: terminal.duplicate_of_count,
      out_of_scope: terminal.out_of_scope_count,
    },
    accounting,
    "terminal/ledger accounting"
  );
  requireSame(
    {
      item_count: transition.item_count,
      confirmed: transition.confirmed_count,
      rejected: transition.rejected_with_evidence_count,
      inconclusive: transition.inconclusive_count,
      deferred: transition.deferred_count,
      duplicate: transition.duplicate_of_count,
      out_of_scope: transition.out_of_scope_count,
    },
    accounting,
    "transition/ledger accounting"
  );
  if (
    (terminal.status === "candidate_complete") !== (gate.verdict === "pass_ready") ||
    (terminal.status === "blocked" && gate.verdict === "pass_ready")
  ) {
    throw new Error("P09 P08 terminal status disagrees with its gate verdict");
  }
  if (gate.item_count !== ledger.item_count || ledger.items.length !== ledger.item_count) {
    throw new Error("P09 P08 gate or ledger item count mismatch");
  }
  for (const ref of [input.p08_terminal_ref, input.p08_gate_ref, input.p08_admission_ref]) {
    if (ref.run_id !== input.run_id) throw new Error("P09 cross-run P08 ref");
  }

  const recordedAssurance = recordedAdmission.p07_authority_assurance;
  const authorityResolver = input.resolve_current_p07_authority_ref;
  if (recordedAssurance === "attested_unchanged" && authorityResolver === undefined) {
    throw new Error(
      "P09 recorded P08 authority attestation requires an independent current P07 authority resolver"
    );
  }
  const rederived = admitScaP08Disposition({
    store,
    run_id: input.run_id,
    p07_terminal_ref: recordedAdmission.p07_terminal_ref,
    p07_evidence_ledger_ref: recordedAdmission.p07_evidence_ledger_ref,
    p07_transition_ref: recordedAdmission.p07_transition_ref,
    disclosure_scope_ref: recordedAdmission.disclosure_scope_ref,
    // Reproduce the recorded admission exactly: supply a resolver if and only if the recorded
    // admission actually encoded an independent attestation. The gate truth is the recorded
    // assurance, not the presence of a P09 resolver.
    ...(recordedAssurance === "attested_unchanged" && authorityResolver !== undefined
      ? { resolve_current_p07_authority_ref: authorityResolver }
      : {}),
  });
  requireSame(rederived.admission, recordedAdmission, "re-derived P08 admission");
  const authorityAssurance = recordedAssurance;
  requireSame(rederived.universe, universe, "re-derived P08 item universe");
  if (recordedAdmission.universe_sha256 !== universe.universe_sha256) {
    throw new Error("P09 P08 admission/universe digest binding mismatch");
  }
  if (
    recordedAdmission.item_count !== universe.item_count ||
    rederived.items.length !== recordedAdmission.item_count
  ) {
    throw new Error("P09 re-derived P08 item count mismatch");
  }

  const evidenceRefs: ArtifactRef[] = [
    input.p08_terminal_ref,
    input.p08_transition_ref,
    input.p08_evidence_ledger_ref,
    input.p08_gate_ref,
    input.p08_admission_ref,
    input.p08_item_universe_ref,
    input.p01_obligation_ledger_ref,
  ];
  for (const ref of rederived.evidence_refs) evidenceRefs.push(ref);

  // Exact-read every P08 disposition revision (current + prior) with a gapless chain.
  const revisionByItemId = new Map<
    string,
    {
      readonly revision: ScaP08DispositionRevisionV1;
      readonly ref: ArtifactRef;
      readonly chain: readonly ArtifactRef[];
    }
  >();
  const universeIds = new Set(universe.items.map((item) => item.item_id));
  for (const row of ledger.items) {
    if (!universeIds.has(row.item_id)) {
      throw new Error("P09 P08 ledger row names an item outside the admitted P08 universe");
    }
    const chainRefs = [...row.prior_revision_refs, row.current_revision_ref];
    const revisions = chainRefs.map((ref) => ({
      ref,
      revision: exact(
        store,
        ref,
        "sca-p08-disposition-revision",
        validateScaP08DispositionRevisionV1
      ),
    }));
    revisions.sort((left, right) => left.revision.revision - right.revision.revision);
    const last = revisions[revisions.length - 1];
    if (revisions.length < 1 || last === undefined || last.revision.revision !== revisions.length) {
      throw new Error("P09 P08 revision chain length mismatch");
    }
    for (const [index, entry] of revisions.entries()) {
      if (entry.revision.revision !== index + 1) {
        throw new Error("P09 P08 revision chain is not a gapless append-only sequence");
      }
      if (entry.revision.run_id !== input.run_id) {
        throw new Error("P09 P08 revision belongs to another run");
      }
      if (
        entry.revision.item_id !== row.item_id ||
        entry.revision.item_kind !== row.item_kind ||
        entry.revision.identity !== row.identity
      ) {
        throw new Error("P09 P08 revision item identity mismatch");
      }
      if (index === 0) {
        if (entry.revision.parent_revision_ref !== null) {
          throw new Error("P09 P08 revision chain root carries a parent");
        }
      } else {
        const parent = revisions[index - 1];
        if (
          parent === undefined ||
          entry.revision.parent_revision_ref === null ||
          entry.revision.parent_revision_ref.artifact_id !== parent.ref.artifact_id ||
          entry.revision.parent_revision_sha256 !== parent.ref.content_digest
        ) {
          throw new Error("P09 P08 revision chain parent linkage mismatch");
        }
      }
      evidenceRefs.push(entry.ref, ...revisionEvidenceRefs(entry.revision));
    }
    if (last.revision.disposition !== row.disposition) {
      throw new Error("P09 P08 ledger row disagrees with its current revision");
    }
    if (canonicalJson([...row.blocker_codes].sort()) !== canonicalJson([...row.blocker_codes])) {
      throw new Error("P09 P08 ledger row blocker codes are not canonical");
    }
    revisionByItemId.set(row.item_id, {
      revision: last.revision,
      ref: last.ref,
      chain: revisions.map((entry) => entry.ref),
    });
  }
  if (revisionByItemId.size !== ledger.items.length) {
    throw new Error("P09 P08 ledger rows are not uniquely identified");
  }
  assertP08Counts(ledger, universe);
  verifyCitedEvidence(store, revisionByItemId, universe);

  // P06 lineage for the set-equality invariants (E1–E3, E7).
  const p06Transition = exact(
    store,
    recordedAdmission.p06_transition_ref,
    "sca-p06-to-p07-transition",
    validateScaP06ToP07TransitionV1
  );
  const accepted = exact(
    store,
    p06Transition.accepted_cohort_ref,
    "sca-p06-accepted-cohort",
    validateScaP06AcceptedCohortV1
  );
  const successorLedger = exact(
    store,
    p06Transition.successor_ledger_ref,
    "sca-p06-successor-ledger",
    validateScaP06SuccessorLedgerV1
  );
  const traceability = exact(
    store,
    p06Transition.traceability_ref,
    "sca-p06-traceability",
    validateScaP06TraceabilityV1
  );
  const p06GateRef = p06Transition.p06_gate_ref;
  exact(store, p06GateRef, "sca-p06-gate", validateScaP06GateV1);
  for (const ref of [
    recordedAdmission.p06_transition_ref,
    p06Transition.accepted_cohort_ref,
    p06Transition.successor_ledger_ref,
    p06Transition.traceability_ref,
    p06GateRef,
  ]) {
    evidenceRefs.push(ref);
  }
  const actionByIdentity = new Map<string, ScaP06ActionRecordV1>();
  const actionIdentityByRefId = new Map<string, string>();
  for (const ref of p06Transition.action_record_refs) {
    const action = exact(store, ref, "sca-p06-action-record", validateScaP06ActionRecordV1);
    actionByIdentity.set(action.action_id, action);
    actionIdentityByRefId.set(ref.artifact_id, action.action_id);
    evidenceRefs.push(ref);
  }
  const checkpointByHypothesis = new Map<
    string,
    { ref: ArtifactRef; checkpoint: ScaP06CheckpointV1 }
  >();
  for (const row of traceability.rows) {
    if (
      row.disposition === "blocked_no_authorized_action" ||
      row.disposition === "checkpointed_invalid"
    ) {
      if (row.checkpoint_ref === null) {
        throw new Error("P09 blocked or checkpointed P06 row lacks an exact checkpoint");
      }
      const checkpoint = exact(
        store,
        row.checkpoint_ref,
        "sca-p06-checkpoint",
        validateScaP06CheckpointV1
      );
      if (checkpoint.hypothesis_id !== row.hypothesis_id) {
        throw new Error("P09 P06 checkpoint hypothesis binding mismatch");
      }
      checkpointByHypothesis.set(row.hypothesis_id, { ref: row.checkpoint_ref, checkpoint });
      evidenceRefs.push(row.checkpoint_ref);
    }
  }
  const p06ObligationByIdentity = new Map<
    string,
    {
      revision: ScaP06ObligationRevisionV1;
      base_ref: ArtifactRef;
      revision_ref: ArtifactRef;
      hypothesis_created_at: string | null;
      reassessment_evaluated_at: string | null;
    }
  >();
  for (const obligation of successorLedger.evidence_obligations) {
    const revision = exact(
      store,
      obligation.obligation_revision_ref,
      "sca-p06-obligation-revision",
      validateScaP06ObligationRevisionV1
    );
    evidenceRefs.push(obligation.obligation_revision_ref);
    let baseRef = obligation.obligation_revision_ref;
    if (revision.parent_revision_ref !== null) {
      const base = exact(
        store,
        revision.parent_revision_ref,
        "sca-p06-obligation-revision",
        validateScaP06ObligationRevisionV1
      );
      if (
        base.obligation_id !== revision.obligation_id ||
        base.revision !== revision.revision - 1
      ) {
        throw new Error("P09 P06 material obligation base revision mismatch");
      }
      baseRef = revision.parent_revision_ref;
      evidenceRefs.push(revision.parent_revision_ref);
    }
    let reassessmentEvaluatedAt: string | null = null;
    if (revision.discovery_reassessment_ref !== null) {
      const reassessment = exact(
        store,
        revision.discovery_reassessment_ref,
        "sca-p06-discovery-reassessment",
        validateScaP06DiscoveryReassessmentV1
      );
      if (
        reassessment.promoted_obligation_id !== revision.obligation_id ||
        reassessment.hypothesis_id !== revision.hypothesis_id
      ) {
        throw new Error("P09 P06 material obligation reassessment mismatch");
      }
      reassessmentEvaluatedAt = reassessment.evaluated_at;
      evidenceRefs.push(revision.discovery_reassessment_ref);
    }
    const hypothesisRevision = exact(
      store,
      revision.final_hypothesis_revision_ref,
      "sca-p05-hypothesis-revision",
      validateScaP05HypothesisRevisionV1
    );
    if (hypothesisRevision.hypothesis_id !== revision.hypothesis_id) {
      throw new Error("P09 P06 obligation hypothesis revision binding mismatch");
    }
    evidenceRefs.push(revision.final_hypothesis_revision_ref);
    p06ObligationByIdentity.set(revision.obligation_id, {
      revision,
      base_ref: baseRef,
      revision_ref: obligation.obligation_revision_ref,
      hypothesis_created_at: hypothesisRevision.created_at,
      reassessment_evaluated_at: reassessmentEvaluatedAt,
    });
  }

  const hypothesisIdByIdentity = new Map<string, string>();
  for (const item of rederived.items) {
    if (item.hypothesis_id !== null) {
      hypothesisIdByIdentity.set(item.identity, item.hypothesis_id);
    }
  }

  const p01 = admitP01ObligationLedger({
    store,
    run_id: input.run_id,
    ref: input.p01_obligation_ledger_ref,
    ...(input.resolve_current_p01_obligation_head_ref === undefined
      ? {}
      : { resolve: input.resolve_current_p01_obligation_head_ref }),
  });
  evidenceRefs.push(input.p01_obligation_ledger_ref, ...p01.chain_refs);

  // Snapshot the exact admitted/re-derived lineage before appending coverage, phase-evidence, and
  // resolution refs: only lineage refs can satisfy an acceptance obligation's exact-lineage bind.
  const lineageRefIds = new Set(evidenceRefs.map((ref) => ref.artifact_id));
  // Exact, explicitly admitted typed phase-evidence sources. Each is revalidated against its closed
  // kind/phase/schema binding and gate/status/content semantics; a fabricated standalone gate is
  // never admitted here without matching those semantics.
  const phaseEvidenceRefs = uniqueRefs(
    admitScaP09PhaseEvidenceRefs({
      store,
      run_id: input.run_id,
      refs: input.phase_evidence_refs ?? [],
    })
  );
  const phaseEvidenceRefIds = new Set(phaseEvidenceRefs.map((ref) => ref.artifact_id));
  for (const ref of phaseEvidenceRefs) evidenceRefs.push(ref);
  const acceptanceLineageByPhase = new Map<string, ArtifactRef>([
    ["SCA-P08", input.p08_gate_ref],
    ["SCA-P07", recordedAdmission.p07_terminal_ref],
    ["SCA-P06", p06GateRef],
  ]);

  const semanticBlockers: string[] = [];

  let coverageRefIds: ReadonlySet<string> = new Set<string>();
  let coverageInput: ScaP09CoverageInputV1 | null = null;
  if (input.coverage_input_ref !== undefined && input.coverage_input_ref !== null) {
    coverageInput = exact(
      store,
      input.coverage_input_ref,
      "sca-p09-coverage-input",
      validateScaP09CoverageInputV1
    );
    if (coverageInput.run_id !== input.run_id) {
      throw new Error("P09 coverage input belongs to another run");
    }
    evidenceRefs.push(input.coverage_input_ref);
    coverageRefIds = new Set(coverageInput.entries.map((entry) => entry.primary_ref.artifact_id));
    for (const entry of coverageInput.entries) {
      const stored = store.refById(entry.primary_ref.artifact_id);
      if (stored === undefined || !same(stored, entry.primary_ref)) {
        throw new Error("P09 coverage entry names a substituted exact record");
      }
      const bytes = store.readById(entry.primary_ref.artifact_id);
      if (
        bytes.byteLength !== entry.primary_ref.byte_length ||
        sha256(bytes) !== entry.primary_ref.content_digest
      ) {
        throw new Error("P09 coverage entry exact record bytes drifted");
      }
      evidenceRefs.push(entry.primary_ref);
      const binding = scaP09CoverageEvidenceForSurfaceKind(entry.surface_kind);
      if (
        entry.primary_ref.run_id !== input.run_id ||
        entry.primary_ref.phase !== binding.phase_id ||
        !binding.kinds.includes(entry.primary_ref.kind) ||
        entry.primary_ref.content_schema === undefined ||
        !binding.schema_ids.includes(entry.primary_ref.content_schema.schema_id)
      ) {
        semanticBlockers.push(`p09_coverage_binding_invalid::${entry.surface_kind}`);
      }
    }
  }

  // Exact obligation-resolution admission (`SCA-P09` R3/R6/R10): a pending ledger entry is never
  // resolution evidence. Only due required-result obligations with exact adequate evidence count.
  const obligationResolutions = new Map<
    string,
    { entry: ScaP09ObligationResolutionEntryV1; evidence_refs: readonly ArtifactRef[] }
  >();
  if (input.obligation_resolution_ref !== undefined && input.obligation_resolution_ref !== null) {
    const resolution = exact(
      store,
      input.obligation_resolution_ref,
      "sca-p09-obligation-resolution",
      validateScaP09ObligationResolutionV1
    );
    if (resolution.run_id !== input.run_id) {
      throw new Error("P09 obligation resolution belongs to another run");
    }
    evidenceRefs.push(input.obligation_resolution_ref);
    for (const entry of resolution.entries) {
      for (const ref of entry.evidence_refs) {
        const stored = store.refById(ref.artifact_id);
        if (stored === undefined || !same(stored, ref)) {
          throw new Error("P09 obligation resolution cites a substituted exact record");
        }
        const bytes = store.readById(ref.artifact_id);
        if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
          throw new Error("P09 obligation resolution cited record bytes drifted");
        }
        evidenceRefs.push(ref);
      }
      const code = scaP09ResolutionInvalidCode({
        entry,
        obligations: p01.obligations,
        runId: input.run_id,
        store,
        lineageRefIds,
        coverageRefIds,
        phaseEvidenceRefIds,
        acceptanceLineageByPhase,
      });
      if (code !== null) {
        semanticBlockers.push(code);
        continue;
      }
      obligationResolutions.set(entry.obligation_id, {
        entry,
        evidence_refs: [...entry.evidence_refs],
      });
    }
  }

  const items = buildUniverse({
    rederived,
    ledger,
    revisionByItemId,
    p06ObligationByIdentity,
    checkpointByHypothesis,
    p01,
    coverageInput,
  });
  const sorted = [...items].sort((left, right) =>
    left.item_id < right.item_id ? -1 : left.item_id > right.item_id ? 1 : 0
  );
  if (new Set(sorted.map((item) => item.item_id)).size !== sorted.length) {
    throw new Error("P09 reconciliation universe contains a duplicate stable identity");
  }

  // E4/E6 are computed here, not asserted: E4 every effective P01 obligation appears once; E6 every
  // coverage entry maps to an admitted exact record of the bound kind/schema.
  const p01UniverseIds = sorted
    .filter((item) => item.item_kind === "p01_obligation")
    .map((item) => item.identity)
    .sort();
  const p01DerivedIds = [...p01.obligations.keys()].sort();
  const e4 =
    same(p01UniverseIds, p01DerivedIds) && new Set(p01UniverseIds).size === p01UniverseIds.length;
  const coverageItemIds = sorted
    .filter((item) => item.item_kind === "candidate" || item.item_kind === "surface")
    .map((item) => item.item_id)
    .sort();
  const coverageEntryIds = (coverageInput?.entries ?? [])
    .map((entry) =>
      scaP09ItemId({
        item_kind: scaP09CoverageItemKind(entry.surface_kind),
        identity: entry.identity,
      })
    )
    .sort();
  const coverageBindingOk = semanticBlockers.every(
    (code) => !code.startsWith("p09_coverage_binding_invalid")
  );
  const e6 =
    coverageInput === null || (coverageBindingOk && same(coverageItemIds, coverageEntryIds));

  const setEquality = verifySetEquality({
    ledger,
    universe,
    rederived,
    accepted,
    successorLedger,
    traceability,
    actionIdentityByRefId,
    actionByIdentity,
    checkpointByHypothesis,
  });
  const invalidBlockerCodes = [
    ...(setEquality.e5 ? [] : ["p09_set_equality_violation::e5"]),
    ...(setEquality.e1 ? [] : ["p09_set_equality_violation::e1"]),
    ...(setEquality.e2 ? [] : ["p09_set_equality_violation::e2"]),
    ...(setEquality.e3 ? [] : ["p09_set_equality_violation::e3"]),
    ...(setEquality.e7 ? [] : ["p09_set_equality_violation::e7"]),
    ...(e4 ? [] : ["p09_unaccounted_item::e4"]),
    ...(e6 ? [] : ["p09_unaccounted_item::e6"]),
    ...semanticBlockers,
  ].sort();

  const admission = validateScaP09AdmissionV1(
    withP09Digest(
      {
        schema_id: SCA_P09_ADMISSION_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P09" as const,
        run_id: input.run_id,
        p08_terminal_ref: input.p08_terminal_ref,
        p08_transition_ref: input.p08_transition_ref,
        p08_evidence_ledger_ref: input.p08_evidence_ledger_ref,
        p08_gate_ref: input.p08_gate_ref,
        p08_admission_ref: input.p08_admission_ref,
        p08_item_universe_ref: input.p08_item_universe_ref,
        p01_obligation_ledger_ref: input.p01_obligation_ledger_ref,
        coverage_input_ref: input.coverage_input_ref ?? null,
        phase_evidence_refs: [...phaseEvidenceRefs],
        obligation_resolution_ref: input.obligation_resolution_ref ?? null,
        p01_head_attested: p01.attested,
        p01_fork_safety: p01.attested
          ? ("attested_unchanged" as const)
          : ("unattested_chain_revalidated" as const),
        p08_authority_assurance: authorityAssurance,
        p08_rederivation_ok: true,
        non_reconcilable: false,
        non_reconcilable_reason: null,
        item_count: sorted.length,
        universe_sha256: scaP09UniverseSha256(sorted),
      },
      "admission_sha256"
    )
  );

  return {
    admission,
    set_equality: {
      e1: setEquality.e1,
      e2: setEquality.e2,
      e3: setEquality.e3,
      e4,
      e5: setEquality.e5,
      e6,
      e7: setEquality.e7,
    },
    non_reconcilable: false,
    non_reconcilable_reason: null,
    p08_terminal: terminal,
    p08_transition: transition,
    p08_ledger: ledger,
    p08_gate: gate,
    p08_admission: recordedAdmission,
    p08_universe: universe,
    p08_items: rederived.items,
    p08_revision_by_item_id: revisionByItemId,
    p06_obligation_by_identity: p06ObligationByIdentity,
    action_by_identity: actionByIdentity,
    hypothesis_id_by_identity: hypothesisIdByIdentity,
    p01_ledger: p01.head,
    p01_ledger_ref: input.p01_obligation_ledger_ref,
    p01_head_attested: p01.attested,
    p01_fork_safety: p01.attested ? "attested_unchanged" : "unattested_chain_revalidated",
    p01_obligations: p01.obligations,
    coverage_input: coverageInput,
    coverage_input_ref: input.coverage_input_ref ?? null,
    phase_evidence_refs: phaseEvidenceRefs,
    obligation_resolutions: obligationResolutions,
    obligation_resolution_ref: input.obligation_resolution_ref ?? null,
    p08_authority_assurance: authorityAssurance,
    items: sorted,
    evidence_refs: uniqueRefs(evidenceRefs),
    invalid_blocker_codes: invalidBlockerCodes,
  };
}

function scaP09CoverageItemKind(kind: ScaP09CoverageSurfaceKindV1): ScaP09ItemKindV1 {
  return (SCA_P09_CANDIDATE_SURFACE_KINDS as readonly string[]).includes(kind)
    ? "candidate"
    : "surface";
}

function scaP09ResolutionInvalidCode(input: {
  readonly entry: ScaP09ObligationResolutionEntryV1;
  readonly obligations: ReadonlyMap<string, ScaP09ObligationDerivationV1>;
  readonly runId: string;
  readonly store: ArtifactHostStore;
  readonly lineageRefIds: ReadonlySet<string>;
  readonly coverageRefIds: ReadonlySet<string>;
  readonly phaseEvidenceRefIds: ReadonlySet<string>;
  readonly acceptanceLineageByPhase: ReadonlyMap<string, ArtifactRef>;
}): string | null {
  const { entry } = input;
  const derivation = input.obligations.get(entry.obligation_id);
  if (derivation === undefined) {
    return "p09_obligation_resolution_invalid::unknown_obligation";
  }
  if (!derivation.due_at_p09_entry) {
    return "p09_obligation_resolution_invalid::future_obligation";
  }
  if (derivation.effective_class !== "required-result") {
    return "p09_obligation_resolution_invalid::not_required";
  }
  if (entry.obligation_entry_sha256 !== derivation.effective_entry_sha256) {
    return "p09_obligation_resolution_invalid::revision_mismatch";
  }
  const expected = scaP09ExpectedResolutionEvidence(derivation);
  if (expected === null || entry.resolution_kind !== expected.resolution_kind) {
    return "p09_obligation_resolution_invalid::resolution_kind";
  }
  const acceptanceRef =
    derivation.scope === "phase" && derivation.semantic_phase_id !== null
      ? input.acceptanceLineageByPhase.get(derivation.semantic_phase_id)
      : undefined;
  for (const ref of entry.evidence_refs) {
    if (ref.run_id !== input.runId) {
      return "p09_obligation_resolution_invalid::cross_run_evidence";
    }
    if (!expected.kinds.includes(ref.kind)) {
      return "p09_obligation_resolution_invalid::evidence_kind";
    }
    if (expected.phase_id !== null && ref.phase !== expected.phase_id) {
      return "p09_obligation_resolution_invalid::evidence_phase";
    }
    if (
      ref.content_schema === undefined ||
      !expected.schema_ids.includes(ref.content_schema.schema_id)
    ) {
      return "p09_obligation_resolution_invalid::evidence_schema";
    }
    const admitted =
      input.lineageRefIds.has(ref.artifact_id) ||
      input.coverageRefIds.has(ref.artifact_id) ||
      input.phaseEvidenceRefIds.has(ref.artifact_id);
    if (!admitted) {
      return "p09_obligation_resolution_invalid::evidence_not_admitted";
    }
    if (acceptanceRef !== undefined && ref.artifact_id !== acceptanceRef.artifact_id) {
      return "p09_obligation_resolution_invalid::evidence_not_lineage";
    }
    if (!scaP09ResolutionEvidenceSemanticsOk(input.store, ref)) {
      return "p09_obligation_resolution_invalid::evidence_semantics";
    }
  }
  return null;
}

function revisionEvidenceRefs(revision: ScaP08DispositionRevisionV1): readonly ArtifactRef[] {
  return [
    ...revision.supporting_evidence_refs,
    ...revision.defeating_evidence_refs,
    ...revision.equivalence_evidence_refs,
    ...(revision.review_exact_record_refs ?? []),
    ...(revision.scope_evidence_ref === null ? [] : [revision.scope_evidence_ref]),
    ...(revision.review_ref === null ? [] : [revision.review_ref]),
  ];
}

function verifyCitedEvidence(
  store: ArtifactHostStore,
  revisionByItemId: ReadonlyMap<
    string,
    { readonly revision: ScaP08DispositionRevisionV1; readonly ref: ArtifactRef }
  >,
  universe: ScaP08ItemUniverseV1
): void {
  const itemById = new Map(universe.items.map((item) => [item.item_id, item]));
  for (const entry of revisionByItemId.values()) {
    const revision = entry.revision;
    for (const ref of revisionEvidenceRefs(revision)) {
      const stored = store.refById(ref.artifact_id);
      if (stored === undefined || !same(stored, ref)) {
        throw new Error("P09 P08 revision cites a substituted exact record");
      }
      const bytes = store.readById(ref.artifact_id);
      if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
        throw new Error("P09 P08 revision cited record bytes drifted");
      }
    }
    if (revision.duplicate_of_item_id !== null) {
      const proofRefs = revision.equivalence_evidence_refs.filter(
        (ref) => ref.kind === "sca-p08-duplicate-equivalence-proof"
      );
      if (proofRefs.length === 0) {
        throw new Error("P09 duplicate-of revision lacks a typed equivalence proof");
      }
      const target = itemById.get(revision.duplicate_of_item_id);
      if (target === undefined) {
        throw new Error("P09 duplicate-of revision references an item outside the P08 universe");
      }
      const pairKey = scaP08DuplicatePairKey(revision.item_id, revision.duplicate_of_item_id);
      let matched = false;
      for (const proofRef of proofRefs) {
        const proof = exact(
          store,
          proofRef,
          "sca-p08-duplicate-equivalence-proof",
          validateScaP08DuplicateEquivalenceProofV1
        );
        if (scaP08DuplicatePairKey(proof.duplicate_item_id, proof.target_item_id) === pairKey) {
          matched = true;
        }
      }
      if (!matched) {
        throw new Error("P09 duplicate-of revision lacks an admitted proof for its exact pair");
      }
    }
    if (revision.disposition === "out-of-scope") {
      if (revision.scope_evidence_ref === null) {
        throw new Error("P09 out-of-scope revision lacks admitted scope evidence");
      }
      if (!isScaP08ScopeDecisionKind(revision.scope_evidence_ref.kind)) {
        throw new Error("P09 out-of-scope revision cites an unrelated admitted record");
      }
    }
  }
}

function assertP08Counts(ledger: ScaP08EvidenceLedgerV1, universe: ScaP08ItemUniverseV1): void {
  const counts = new Map<string, number>();
  for (const row of ledger.items)
    counts.set(row.disposition, (counts.get(row.disposition) ?? 0) + 1);
  const declared =
    ledger.confirmed_count +
    ledger.rejected_with_evidence_count +
    ledger.inconclusive_count +
    ledger.deferred_count +
    ledger.duplicate_of_count +
    ledger.out_of_scope_count;
  if (
    declared !== ledger.item_count ||
    (counts.get("confirmed") ?? 0) !== ledger.confirmed_count ||
    (counts.get("rejected-with-evidence") ?? 0) !== ledger.rejected_with_evidence_count ||
    (counts.get("inconclusive") ?? 0) !== ledger.inconclusive_count ||
    (counts.get("deferred") ?? 0) !== ledger.deferred_count ||
    (counts.get("duplicate-of") ?? 0) !== ledger.duplicate_of_count ||
    (counts.get("out-of-scope") ?? 0) !== ledger.out_of_scope_count
  ) {
    throw new Error("P09 P08 ledger disposition accounting is not exhaustive");
  }
  const expectedUnresolved = ledger.items
    .filter((row) => row.disposition === "inconclusive" || row.disposition === "deferred")
    .map((row) => row.current_revision_ref.artifact_id)
    .sort();
  if (
    canonicalJson(expectedUnresolved) !==
    canonicalJson(ledger.unresolved_item_refs.map((ref) => ref.artifact_id).sort())
  ) {
    throw new Error("P09 P08 ledger unresolved refs disagree with its rows");
  }
  if (
    universe.items.length !== ledger.item_count ||
    !setEqual(
      new Set(universe.items.map((item) => item.item_id)),
      new Set(ledger.items.map((row) => row.item_id))
    )
  ) {
    throw new Error("P09 P08 ledger rows differ from the admitted P08 universe (E5)");
  }
}

interface ScaP09SetEqualityV1 {
  readonly e1: boolean;
  readonly e2: boolean;
  readonly e3: boolean;
  readonly e5: boolean;
  readonly e7: boolean;
}

function verifySetEquality(input: {
  readonly ledger: ScaP08EvidenceLedgerV1;
  readonly universe: ScaP08ItemUniverseV1;
  readonly rederived: ReturnType<typeof admitScaP08Disposition>;
  readonly accepted: ScaP06AcceptedCohortV1;
  readonly successorLedger: ScaP06SuccessorLedgerV1;
  readonly traceability: ScaP06TraceabilityV1;
  readonly actionIdentityByRefId: ReadonlyMap<string, string>;
  readonly actionByIdentity: ReadonlyMap<string, ScaP06ActionRecordV1>;
  readonly checkpointByHypothesis: ReadonlyMap<string, { readonly ref: ArtifactRef }>;
}): ScaP09SetEqualityV1 {
  const p08ActionIdentities = new Set(
    input.rederived.items.filter((item) => item.item_kind === "action").map((item) => item.identity)
  );
  const actionIdentities = new Set(input.actionByIdentity.keys());
  const traceActionIdentities = new Set<string>();
  for (const row of input.traceability.rows) {
    if (row.disposition === "action_selected") {
      const identity =
        row.action_record_ref === null
          ? undefined
          : input.actionIdentityByRefId.get(row.action_record_ref.artifact_id);
      traceActionIdentities.add(identity ?? "");
    }
  }
  const e1 =
    setEqual(p08ActionIdentities, actionIdentities) &&
    setEqual(actionIdentities, traceActionIdentities) &&
    !traceActionIdentities.has("");

  const p08HypothesisIdentities = new Set(
    input.rederived.items
      .filter((item) => item.item_kind === "hypothesis")
      .map((item) => item.identity)
  );
  const expectedHypothesisIdentities = new Set<string>([
    ...input.traceability.rows.map((row) => row.hypothesis_id),
    ...input.accepted.refuted_hypothesis_ids,
  ]);
  const e2 =
    setEqual(p08HypothesisIdentities, expectedHypothesisIdentities) &&
    input.traceability.rows.every(
      (row) =>
        !(
          (row.disposition === "blocked_no_authorized_action" ||
            row.disposition === "checkpointed_invalid") &&
          !input.checkpointByHypothesis.has(row.hypothesis_id)
        )
    );

  const p08ObligationIdentities = new Set(
    input.rederived.items
      .filter((item) => item.item_kind === "obligation")
      .map((item) => item.identity)
  );
  const p06ObligationIdentities = new Set(
    input.successorLedger.evidence_obligations.map((entry) => entry.obligation_id)
  );
  const e3 = setEqual(p08ObligationIdentities, p06ObligationIdentities);

  const e5 = setEqual(
    new Set(input.universe.items.map((item) => item.item_id)),
    new Set(input.ledger.items.map((row) => row.item_id))
  );

  // E7: every P06 checkpoint referenced by a blocked/checkpointed traceability row is reconciled
  // to an admitted hypothesis item, and every P07 blocked/not_invoked row is reconciled to an
  // admitted ledger row for its exact action item (which reconciliation then names with an
  // explicit `p09_p07_row_unresolved` blocker). Both halves are one predicate, so neither a P06
  // checkpoint nor a blocked P07 row can be silently dropped from the closed universe.
  const p06E7 = input.traceability.rows.every(
    (row) =>
      !(
        row.disposition === "blocked_no_authorized_action" ||
        row.disposition === "checkpointed_invalid"
      ) ||
      (input.checkpointByHypothesis.has(row.hypothesis_id) &&
        p08HypothesisIdentities.has(row.hypothesis_id))
  );
  const p08LedgerItemIds = new Set(input.ledger.items.map((row) => row.item_id));
  const p07UnresolvedActionItems = input.rederived.items.filter(
    (item) =>
      item.item_kind === "action" && item.p07_status !== null && item.p07_status !== "completed"
  );
  const p07E7 =
    p07UnresolvedActionItems.length > 0
      ? p07UnresolvedActionItems.every((item) => p08LedgerItemIds.has(item.item_id))
      : true;
  const e7 = p06E7 && p07E7;

  return { e1, e2, e3, e5, e7 };
}

interface ScaP09P01AdmissionV1 {
  readonly head: ScaObligationLedgerV2;
  readonly head_ref: ArtifactRef;
  readonly chain_refs: readonly ArtifactRef[];
  readonly attested: boolean;
  readonly obligations: ReadonlyMap<string, ScaP09ObligationDerivationV1>;
}

function admitP01ObligationLedger(input: {
  readonly store: ArtifactHostStore;
  readonly run_id: string;
  readonly ref: ArtifactRef;
  readonly resolve?: (scope: ScaP09CurrentObligationHeadScopeV1) => ArtifactRef;
}): ScaP09P01AdmissionV1 {
  const head = exact(
    input.store,
    input.ref,
    SCA_P01_OBLIGATION_LEDGER_KIND,
    validateScaObligationLedgerV2
  );
  if (head.run_id !== input.run_id) throw new Error("P09 P01 obligation ledger cross-run");
  if (input.ref.content_schema?.schema_id !== SCA_OBLIGATION_LEDGER_V2_SCHEMA) {
    throw new Error("P09 P01 obligation ledger schema binding mismatch");
  }
  const revisions: { ref: ArtifactRef; ledger: ScaObligationLedgerV2 }[] = [
    { ref: input.ref, ledger: head },
  ];
  let current = head;
  while (current.prior_ledger_ref !== null) {
    if (current.prior_ledger_sha256 !== current.prior_ledger_ref.content_digest) {
      throw new Error("P09 P01 obligation ledger prior digest mismatch");
    }
    const prior = exact(
      input.store,
      current.prior_ledger_ref,
      SCA_P01_OBLIGATION_LEDGER_KIND,
      validateScaObligationLedgerV2
    );
    if (prior.version !== current.version - 1 || prior.run_id !== head.run_id) {
      throw new Error("P09 P01 obligation ledger chain is not a gapless append-only sequence");
    }
    revisions.push({ ref: current.prior_ledger_ref, ledger: prior });
    current = prior;
  }
  if (current.version !== 1) throw new Error("P09 P01 obligation ledger chain lacks a root");
  revisions.reverse();
  const chainRefs = revisions.map((entry) => entry.ref);

  let attested = false;
  if (input.resolve !== undefined) {
    const currentHead = input.resolve({
      tenant_id: head.tenant_id,
      project_id: head.project_id,
      run_id: head.run_id,
    });
    requireSame(currentHead, input.ref, "current P01 obligation-ledger head");
    attested = true;
  }

  const revisionRefForIndex = (index: number): ArtifactRef => {
    for (const entry of revisions) {
      if (entry.ledger.entries.length > index) return entry.ref;
    }
    throw new Error("P09 P01 obligation ledger index is outside its chain");
  };
  const occurrences = new Map<string, { entry: ScaObligationEntryV2; index: number }[]>();
  head.entries.forEach((entry, index) => {
    const existing = occurrences.get(entry.obligation_id) ?? [];
    existing.push({ entry, index });
    occurrences.set(entry.obligation_id, existing);
  });
  const obligations = new Map<string, ScaP09ObligationDerivationV1>();
  for (const [obligationId, entries] of occurrences) {
    const first = entries[0];
    const last = entries[entries.length - 1];
    if (first === undefined || last === undefined) {
      throw new Error("P09 P01 obligation revision history is empty");
    }
    let strongest = first.entry;
    for (const candidate of entries) {
      if (
        scaP09ObligationClassPrecedence(candidate.entry.effective_class) >
        scaP09ObligationClassPrecedence(strongest.effective_class)
      ) {
        strongest = candidate.entry;
      }
    }
    obligations.set(obligationId, {
      obligation_id: obligationId,
      revision: last.entry.revision,
      revision_kind: last.entry.revision_kind,
      revision_chain_refs: entries.map((entry) => revisionRefForIndex(entry.index)),
      effective_class: last.entry.effective_class,
      precedence: last.entry.precedence,
      strongest_class_seen: strongest.effective_class,
      material: last.entry.completion_effect === "required-for-campaign",
      completion_effect: last.entry.completion_effect,
      scope: last.entry.scope,
      semantic_phase_id: last.entry.semantic_phase_id,
      occurred_at: last.entry.occurred_at,
      effective_entry_sha256: last.entry.entry_sha256,
      due_at_p09_entry: false,
    });
  }
  const effective = effectiveScaObligations(head);
  if (Object.keys(effective).length !== obligations.size) {
    throw new Error("P09 P01 obligation derivation dropped an effective obligation (E4)");
  }
  const due = scaP09DueObligationIdSet(effective);
  for (const [obligationId, derivation] of obligations) {
    obligations.set(obligationId, { ...derivation, due_at_p09_entry: due.has(obligationId) });
  }
  return { head, head_ref: input.ref, chain_refs: chainRefs, attested, obligations };
}

function scaP09DueObligationIdSet(
  effective: Readonly<Record<string, ScaObligationEntryV2>>
): ReadonlySet<string> {
  const due = new Set<string>();
  const stack: string[] = [SCA_P09_P08_ACCEPTANCE_OBLIGATION_ID];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || due.has(id)) continue;
    const entry = effective[id];
    if (entry === undefined) continue;
    due.add(id);
    for (const predecessor of entry.predecessor_ids) stack.push(predecessor);
  }
  return due;
}

/**
 * Exported deterministic due-at-P09-entry set: the transitive predecessor closure of the P08
 * acceptance obligation. Every obligation that a completed P01–P08 campaign must have resolved is
 * due at P09 entry; P09/P10–P12 and every other downstream obligation is explicitly not due.
 */
export function scaP09DueObligationIds(ledger: unknown): readonly string[] {
  return [...scaP09DueObligationIdSet(effectiveScaObligations(ledger))].sort();
}

function buildUniverse(input: {
  readonly rederived: ReturnType<typeof admitScaP08Disposition>;
  readonly ledger: ScaP08EvidenceLedgerV1;
  readonly revisionByItemId: ReadonlyMap<
    string,
    { readonly revision: ScaP08DispositionRevisionV1; readonly ref: ArtifactRef }
  >;
  readonly p06ObligationByIdentity: ReadonlyMap<
    string,
    {
      revision: ScaP06ObligationRevisionV1;
      base_ref: ArtifactRef;
      revision_ref: ArtifactRef;
      hypothesis_created_at: string | null;
      reassessment_evaluated_at: string | null;
    }
  >;
  readonly checkpointByHypothesis: ReadonlyMap<string, { readonly ref: ArtifactRef }>;
  readonly p01: ScaP09P01AdmissionV1;
  readonly coverageInput: ScaP09CoverageInputV1 | null;
}): ScaP09AdmittedItemV1[] {
  const items: ScaP09AdmittedItemV1[] = [];
  const dispositionByP08ItemId = new Map(
    input.ledger.items.map((row) => [row.item_id, row.disposition])
  );
  for (const item of input.rederived.items) {
    const revision = input.revisionByItemId.get(item.item_id);
    const disposition = dispositionByP08ItemId.get(item.item_id);
    if (revision === undefined || disposition === undefined) {
      throw new Error("P09 P08 item lacks an exact current disposition revision");
    }
    const kind: ScaP09ItemKindV1 =
      item.item_kind === "action"
        ? "action"
        : item.item_kind === "hypothesis"
          ? "hypothesis"
          : "p06_obligation";
    const obligation =
      kind === "p06_obligation" ? input.p06ObligationByIdentity.get(item.identity) : undefined;
    if (kind === "p06_obligation" && obligation === undefined) {
      throw new Error("P09 P06 evidence obligation lacks its exact revision chain");
    }
    items.push({
      item_id: scaP09ItemId({ item_kind: kind, identity: item.identity }),
      item_kind: kind,
      identity: item.identity,
      primary_ref: item.primary_ref,
      p08_disposition: disposition,
      p08_disposition_ref: revision.ref,
      p08_blocker_codes: [],
      p06_checkpoint_ref:
        item.item_kind === "hypothesis"
          ? (input.checkpointByHypothesis.get(item.identity)?.ref ?? null)
          : null,
      effective_class: kind === "p06_obligation" ? "required-result" : null,
      precedence: kind === "p06_obligation" ? 3 : null,
      revision_chain_refs:
        kind === "p06_obligation" && obligation !== undefined
          ? [obligation.base_ref, item.primary_ref]
          : [],
      coverage_state: null,
      coverage_reason: null,
      coverage_surface_kind: null,
      coverage_blocker_codes: [],
      p07_status: item.item_kind === "action" ? item.p07_status : null,
      due_at_p09_entry: kind === "p06_obligation",
      checkpoint_needed: null,
    });
  }
  for (const [obligationId, derivation] of input.p01.obligations) {
    const unreachable = (SCA_P09_UNREACHABLE_COVERAGE_OBLIGATION_IDS as readonly string[]).includes(
      obligationId
    );
    const lastRef = derivation.revision_chain_refs[derivation.revision_chain_refs.length - 1];
    if (lastRef === undefined) throw new Error("P09 P01 obligation lacks a revision chain");
    items.push({
      item_id: scaP09ItemId({ item_kind: "p01_obligation", identity: obligationId }),
      item_kind: "p01_obligation",
      identity: obligationId,
      primary_ref: lastRef,
      p08_disposition: null,
      p08_disposition_ref: null,
      p08_blocker_codes: [],
      p06_checkpoint_ref: null,
      effective_class: derivation.effective_class,
      precedence: derivation.precedence,
      revision_chain_refs: derivation.revision_chain_refs,
      coverage_state: null,
      coverage_reason: null,
      coverage_surface_kind: null,
      coverage_blocker_codes: [],
      p07_status: null,
      due_at_p09_entry: derivation.due_at_p09_entry,
      checkpoint_needed:
        unreachable && !scaP09CoverageScopeComplete(input.coverageInput)
          ? {
              reason_code:
                input.coverageInput === null
                  ? "p09_coverage_input_absent"
                  : "p09_coverage_scope_incomplete",
              missing_evidence_need:
                "an explicit sca-p09-coverage-input declaring the full P02/P03/P04 candidate, selection, and omission scope",
              reopen_condition:
                "supply an admitted coverage input that accounts for every candidate and surface",
            }
          : null,
    });
  }
  if (input.coverageInput !== null) {
    for (const entry of input.coverageInput.entries) {
      const kind: ScaP09ItemKindV1 = scaP09CoverageItemKind(entry.surface_kind);
      items.push({
        item_id: scaP09ItemId({ item_kind: kind, identity: entry.identity }),
        item_kind: kind,
        identity: entry.identity,
        primary_ref: entry.primary_ref,
        p08_disposition: null,
        p08_disposition_ref: null,
        p08_blocker_codes: [],
        p06_checkpoint_ref: null,
        effective_class: null,
        precedence: null,
        revision_chain_refs: [],
        coverage_state: entry.coverage_state,
        coverage_reason: entry.reason,
        coverage_surface_kind: entry.surface_kind,
        coverage_blocker_codes: [...entry.blocker_codes],
        p07_status: null,
        due_at_p09_entry: false,
        checkpoint_needed: null,
      });
    }
  }
  return items;
}
