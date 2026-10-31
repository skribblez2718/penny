import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore, type ArtifactStore as Store } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type {
  ArtifactRef,
  Directive,
  JsonValue,
  OutputArtifactMetadata,
  StartRequest,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { Checkpointer } from "../dist/checkpointer.js";
import { admitScaP09Reconciliation } from "../dist/sca/p09-admission.js";
import { reconcileScaP09 } from "../dist/sca/p09-reconcile.js";
import {
  SCA_P09_CANDIDATE_PLAYBOOK_NAME,
  SCA_P09_CANDIDATE_REGISTRATION,
} from "../dist/sca/p09-playbook.js";
import {
  SCA_P09_COVERAGE_INPUT_SCHEMA,
  SCA_P09_OBLIGATION_RESOLUTION_SCHEMA,
  SCA_P09_REASSESSMENT_SCHEMA,
  SCA_P09_TO_P10_TRANSITION_SCHEMA,
  scaP09CoverageEntryIdentity,
  validateScaP09CoverageInputV1,
  validateScaP09ObligationResolutionV1,
  validateScaP09ReassessmentV1,
  validateScaP09ReconciliationLedgerV1,
  validateScaP09TerminalV1,
  validateScaP09ToP10TransitionV1,
  withP09Digest,
  type ScaP09ObligationResolutionEntryV1,
} from "../dist/sca/p09-contracts.js";
import { buildScaP09Lineage, type ScaP09LineageV1 } from "./sca-p09-lineage.js";

import { validateScaObligationLedgerV2 } from "../dist/sca/p01-contracts.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function makeStore(): { readonly root: string; readonly store: ArtifactStore } {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p09-regression-"));
  roots.push(root);
  return { root, store: new ArtifactStore(path.join(root, "artifacts")) };
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
function ledgerOf(
  store: Store,
  ref: ArtifactRef
): ReturnType<typeof validateScaObligationLedgerV2> {
  return validateScaObligationLedgerV2(
    JSON.parse(store.readById(ref.artifact_id).toString("utf8"))
  );
}
function save(input: {
  readonly store: Store;
  readonly run_id: string;
  readonly phase: string;
  readonly kind: string;
  readonly operation_id: string;
  readonly schema_id: string;
  readonly schema_version?: number;
  readonly value: unknown;
  readonly upstream_refs?: readonly ArtifactRef[];
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.run_id,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operation_id,
    version: 1,
    producer: "host:sca-p09-regression",
    media_type: "application/json",
    content_schema: { schema_id: input.schema_id, schema_version: input.schema_version ?? 1 },
    parent_ref: null,
    upstream_refs: [...(input.upstream_refs ?? [])],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}

const FULL_COVERAGE = {
  entries: [
    {
      surface_kind: "normalized_candidate" as const,
      coverage_state: "covered" as const,
      reason: null,
    },
    {
      surface_kind: "graph_candidate" as const,
      coverage_state: "covered" as const,
      reason: null,
    },
    {
      surface_kind: "p04_selected_candidate" as const,
      coverage_state: "covered" as const,
      reason: null,
    },
    {
      surface_kind: "omitted_surface" as const,
      coverage_state: "omitted" as const,
      reason: "no P04 omission candidate",
    },
  ],
};

function admitLineage(
  store: Store,
  lineage: ScaP09LineageV1,
  overrides: Record<string, unknown> = {}
) {
  return admitScaP09Reconciliation({
    store,
    run_id: lineage.run_id,
    p08_terminal_ref: lineage.p08_terminal_ref,
    p08_transition_ref: lineage.p08_transition_ref,
    p08_evidence_ledger_ref: lineage.p08_evidence_ledger_ref,
    p08_gate_ref: lineage.p08_gate_ref,
    p08_admission_ref: lineage.p08_admission_ref,
    p08_item_universe_ref: lineage.p08_item_universe_ref,
    p01_obligation_ledger_ref: lineage.p01_obligation_ledger_ref,
    coverage_input_ref: lineage.coverage_input_ref,
    phase_evidence_refs: lineage.phase_evidence_refs,
    obligation_resolution_ref: lineage.obligation_resolution_ref,
    ...overrides,
  } as Parameters<typeof admitScaP09Reconciliation>[0]);
}

function reconcile(admitted: ReturnType<typeof admitScaP09Reconciliation>) {
  const checkpoints = new Map<string, ArtifactRef>(
    admitted.items
      .filter((item) => item.checkpoint_needed !== null)
      .map((item) => [item.item_id, item.primary_ref])
  );
  return reconcileScaP09({
    admitted,
    reassessment: null,
    prior_ledger: null,
    prior_ledger_ref: null,
    checkpoint_refs_by_item_id: checkpoints,
  });
}

function fullLineage(store: Store, runId: string, resolutions: boolean) {
  return buildScaP09Lineage({
    store,
    run_id: runId,
    kinds: ["source_query"],
    completed_indices: [0],
    disposition_for: () => "confirmed",
    coverage: FULL_COVERAGE,
    ...(resolutions ? { resolutions: "all_due" as const } : {}),
  });
}

describe("SCA P09 E1–E7 set equality and coverage binding", () => {
  it("computes every invariant explicitly on a golden lineage", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-e-golden", true);
    const admitted = admitLineage(store, lineage);
    expect(admitted.set_equality).not.toBeNull();
    expect(admitted.set_equality).toEqual({
      e1: true,
      e2: true,
      e3: true,
      e4: true,
      e5: true,
      e6: true,
      e7: true,
    });
    expect(admitted.invalid_blocker_codes).toEqual([]);
  });

  it("fails E6 closed when a coverage entry cites a substitute artifact kind", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-e6-mutant", true);
    // A `p04_selected_candidate` covered by the P08 gate record is exactly the H1 substitution.
    const wrongKind = save({
      store,
      run_id: lineage.run_id,
      phase: "SCA-P09",
      kind: "sca-p09-coverage-input",
      operation_id: "sca-p09-coverage-input-wrong-kind",
      schema_id: SCA_P09_COVERAGE_INPUT_SCHEMA,
      value: validateScaP09CoverageInputV1(
        withP09Digest(
          {
            schema_id: SCA_P09_COVERAGE_INPUT_SCHEMA,
            schema_version: 1,
            phase_id: "SCA-P09",
            run_id: lineage.run_id,
            entries: [
              {
                identity: scaP09CoverageEntryIdentity({
                  surface_kind: "p04_selected_candidate",
                  primary_ref: lineage.p08_gate_ref,
                }),
                surface_kind: "p04_selected_candidate",
                primary_ref: lineage.p08_gate_ref,
                coverage_state: "covered",
                reason: null,
                blocker_codes: [],
              },
            ],
          },
          "coverage_sha256"
        )
      ),
    });
    const admitted = admitLineage(store, lineage, { coverage_input_ref: wrongKind });
    expect(admitted.set_equality?.e6).toBe(false);
    expect(admitted.invalid_blocker_codes).toContain(
      "p09_coverage_binding_invalid::p04_selected_candidate"
    );
    expect(reconcile(admitted).lane).toBeNull();
  });

  it("rejects a resolution for a future downstream obligation without inflating resolution", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-e4-future", true);
    const ledger = ledgerOf(store, lineage.p01_obligation_ledger_ref);
    const future = ledger.entries.filter(
      (entry) => entry.obligation_id === "SCA-OBL-P10-ACCEPTANCE"
    );
    const futureEntry = future[future.length - 1];
    expect(futureEntry).toBeDefined();
    const entry: ScaP09ObligationResolutionEntryV1 = {
      obligation_id: "SCA-OBL-P10-ACCEPTANCE",
      obligation_entry_sha256: required(futureEntry, "P10 acceptance entry").entry_sha256,
      resolution_kind: "phase_acceptance",
      evidence_refs: [lineage.p08_gate_ref],
    };
    const resolutionRef = save({
      store,
      run_id: lineage.run_id,
      phase: "SCA-P09",
      kind: "sca-p09-obligation-resolution",
      operation_id: "sca-p09-obligation-resolution-future",
      schema_id: SCA_P09_OBLIGATION_RESOLUTION_SCHEMA,
      value: validateScaP09ObligationResolutionV1(
        withP09Digest(
          {
            schema_id: SCA_P09_OBLIGATION_RESOLUTION_SCHEMA,
            schema_version: 1,
            phase_id: "SCA-P09",
            run_id: lineage.run_id,
            entries: [entry],
          },
          "resolution_sha256"
        )
      ),
    });
    const admitted = admitLineage(store, lineage, { obligation_resolution_ref: resolutionRef });
    expect(admitted.invalid_blocker_codes).toContain(
      "p09_obligation_resolution_invalid::future_obligation"
    );
    expect(admitted.obligation_resolutions.size).toBe(0);
    const result = reconcile(admitted);
    expect(result.lane).toBeNull();
    // The future obligation is never counted as a due required result.
    expect(result.downstream_pending_required_result_ids.includes("SCA-OBL-P10-ACCEPTANCE")).toBe(
      true
    );
  });
});

describe("SCA P09 class-integrity and late-action mutants", () => {
  it("derives the strongest class for a promoted P01 obligation revision", () => {
    const { store } = makeStore();
    const lineage = buildScaP09Lineage({
      store,
      run_id: "run-promotion",
      kinds: ["source_query"],
      promote: {
        obligation_id: "SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY",
        requested_class: "required-result",
      },
    });
    const admitted = admitLineage(store, lineage);
    const derivation = admitted.p01_obligations.get("SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY");
    expect(derivation?.revision).toBe(2);
    expect(derivation?.revision_kind).toBe("promoted");
    expect(derivation?.effective_class).toBe("required-result");
    expect(derivation?.strongest_class_seen).toBe("required-result");
    expect(derivation?.revision_chain_refs.length).toBe(2);
    // A future boundary promotion is not due at P09 entry and stays explicitly pending downstream.
    const result = reconcile(admitted);
    expect(result.downstream_pending_required_result_ids).toContain(
      "SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY"
    );
  });

  it("flags an underclassified material mandatory obligation", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-underclassification", true);
    const admitted = admitLineage(store, lineage);
    const obligations = new Map(admitted.p01_obligations);
    const target = required(obligations.get("SCA-OBL-P02-ACCEPTANCE"), "P02 acceptance derivation");
    obligations.set("SCA-OBL-P02-ACCEPTANCE", {
      ...target,
      effective_class: "optional",
      precedence: 1,
      material: true,
    });
    const result = reconcile({ ...admitted, p01_obligations: obligations });
    expect(result.blocker_codes).toContain(
      "p09_underclassification::required_for_campaign_optional"
    );
    expect(result.predicates.no_underclassification).toBe(false);
    expect(result.lane).toBeNull();
  });

  it("blocks a P06 action whose relied-on obligation was registered after it", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-late-action", true);
    const admitted = admitLineage(store, lineage);
    const obligations = new Map(admitted.p06_obligation_by_identity);
    const [identity, entry] = required([...obligations.entries()][0], "P06 obligation");
    obligations.set(identity, {
      ...entry,
      revision: { ...entry.revision, created_at: "2030-01-01T00:00:00.000Z" },
    });
    const result = reconcile({ ...admitted, p06_obligation_by_identity: obligations });
    expect(result.blocker_codes).toContain("p09_late_unregistered_action::obligation_after_action");
    expect(result.predicates.no_late_unregistered_action).toBe(false);
  });

  it("fails closed on conflicting P01 replay (non-gapless appended revision)", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-conflicting-replay", true);
    const admitted = admitLineage(store, lineage);
    const ledger = ledgerOf(store, lineage.p01_obligation_ledger_ref);
    const firstEntry = required(ledger.entries[0], "first entry");
    const tampered = {
      ...ledger,
      entries: [
        ...ledger.entries,
        { ...firstEntry, revision: 2, revision_kind: "promoted" as const },
      ],
    };
    // A forked/replayed revision chain is rejected before any lane can be assigned.
    expect(() =>
      reconcile({
        ...admitted,
        p01_ledger: tampered,
      })
    ).toThrow();
  });

  it("records the reduced P01 fork assurance rather than claiming fork safety", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-reduced-assurance", true);
    const admitted = admitLineage(store, lineage);
    expect(admitted.p01_head_attested).toBe(false);
    expect(admitted.admission.p01_fork_safety).toBe("unattested_chain_revalidated");
    expect(admitted.p08_authority_assurance).toBe("unattested_chain_revalidated");
    const reconcileResult = reconcile(admitted);
    expect(reconcileResult.predicates.immutable_p08_lineage_valid).toBe(true);
  });
});

describe("SCA P09 lane honesty", () => {
  it("never assigns accepted progression from the absence of blockers alone", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-no-resolution", false);
    const admitted = admitLineage(store, lineage);
    const result = reconcile(admitted);
    expect(result.lane).toBe("incomplete_closeout");
    expect(result.blocker_codes).toContain("p09_required_result_unresolved");
    expect(result.required_result_resolved).toBeLessThan(result.required_result_total);
  });

  it("keeps future obligations explicitly pending downstream without blocking honest progression", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-honest-progression", true);
    const admitted = admitLineage(store, lineage);
    const result = reconcile(admitted);
    expect(result.lane).toBe("accepted_progression");
    expect(result.required_result_resolved).toBe(result.required_result_total);
    expect(result.downstream_pending_required_result_ids.length).toBeGreaterThan(0);
    expect(result.downstream_pending_required_result_ids).toContain("SCA-OBL-P10-ACCEPTANCE");
    // P10 remains pending: the gate must not claim it resolved.
    expect(result.required_result_resolved).toBeLessThan(result.items.length);
  });

  it("resolves only due required results, never the P01 ledger's frozen pending status", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-frozen-pending", true);
    const admitted = admitLineage(store, lineage);
    const result = reconcile(admitted);
    const resolvedDue = result.items.filter((item) => item.due_at_p09_entry && item.resolved);
    expect(resolvedDue.length).toBe(result.required_result_resolved);
    // Every resolved due item is backed by an exact admitted resolution or an eligible disposition.
    for (const item of resolvedDue) {
      if (item.item_kind === "p01_obligation") {
        expect(admitted.obligation_resolutions.has(item.identity)).toBe(true);
      }
    }
  });
});

describe("SCA P09 revision, replay, and reassessment", () => {
  it("supports a coherent same-campaign append-only revision without a dead same-run block", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-same-run-revision", true);
    const admitted = admitLineage(store, lineage);
    const reconciled = reconcile(admitted);
    const priorLedger = validateScaP09ReconciliationLedgerV1(
      withP09Digest(
        {
          schema_id: "penny.sca-p09-reconciliation-ledger.v1",
          schema_version: 1,
          phase_id: "SCA-P09",
          run_id: lineage.run_id,
          admission_ref: lineage.p08_terminal_ref,
          p08_terminal_ref: lineage.p08_terminal_ref,
          p08_transition_ref: lineage.p08_transition_ref,
          p08_evidence_ledger_ref: lineage.p08_evidence_ledger_ref,
          p08_gate_ref: lineage.p08_gate_ref,
          p08_item_universe_ref: lineage.p08_item_universe_ref,
          p01_obligation_ledger_ref: lineage.p01_obligation_ledger_ref,
          coverage_input_ref: lineage.coverage_input_ref,
          lane: "incomplete_closeout",
          ledger_revision: 1,
          append_only: true,
          items: reconciled.items,
          item_count: reconciled.items.length,
          kind_counts: reconciled.kind_counts,
          disposition_counts: reconciled.disposition_counts,
          required_result_total: reconciled.required_result_total,
          required_result_resolved: reconciled.required_result_resolved,
          downstream_pending_required_result_ids: reconciled.downstream_pending_required_result_ids,
          unresolved_item_refs: reconciled.unresolved_item_refs,
          eligible_refs: reconciled.eligible_refs,
          ineligible_refs: reconciled.ineligible_refs,
          exhaustive_accounting: true,
          release_eligible: false,
          campaign_complete: false,
          blocker_codes: reconciled.blocker_codes,
        },
        "ledger_sha256"
      )
    );
    const priorRef = save({
      store,
      run_id: lineage.run_id,
      phase: "SCA-P09",
      kind: "sca-p09-reconciliation-ledger",
      operation_id: "sca-p09-reconciliation-ledger",
      schema_id: "penny.sca-p09-reconciliation-ledger.v1",
      value: priorLedger,
    });
    const reassessment = validateScaP09ReassessmentV1(
      withP09Digest(
        {
          schema_id: SCA_P09_REASSESSMENT_SCHEMA,
          schema_version: 1,
          phase_id: "SCA-P09",
          run_id: lineage.run_id,
          prior_p09_ledger_ref: priorRef,
          prior_p09_ledger_sha256: priorRef.content_digest,
          trigger_codes: ["new_evidence"],
          stimulus_refs: [lineage.p08_terminal_ref],
          invalidated_evidence_refs: [],
        },
        "reassessment_sha256"
      )
    );
    const result = reconcileScaP09({
      admitted,
      reassessment,
      prior_ledger: priorLedger,
      prior_ledger_ref: priorRef,
      checkpoint_refs_by_item_id: new Map(),
    });
    expect(result.predicates.append_only_revisions).toBe(true);
    expect(result.blocker_codes).not.toContain("p09_revision_chain_invalid::prior_run");
    expect(result.blocker_codes).not.toContain("p09_revision_chain_invalid::reassessment_prior");
  });

  it("rejects an invalidation that the prior ledger never relied on", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-invalidation-not-relied", true);
    const admitted = admitLineage(store, lineage);
    const reconciled = reconcile(admitted);
    const priorLedger = validateScaP09ReconciliationLedgerV1(
      withP09Digest(
        {
          schema_id: "penny.sca-p09-reconciliation-ledger.v1",
          schema_version: 1,
          phase_id: "SCA-P09",
          run_id: lineage.run_id,
          admission_ref: lineage.p08_terminal_ref,
          p08_terminal_ref: lineage.p08_terminal_ref,
          p08_transition_ref: lineage.p08_transition_ref,
          p08_evidence_ledger_ref: lineage.p08_evidence_ledger_ref,
          p08_gate_ref: lineage.p08_gate_ref,
          p08_item_universe_ref: lineage.p08_item_universe_ref,
          p01_obligation_ledger_ref: lineage.p01_obligation_ledger_ref,
          coverage_input_ref: lineage.coverage_input_ref,
          lane: "incomplete_closeout",
          ledger_revision: 1,
          append_only: true,
          items: reconciled.items,
          item_count: reconciled.items.length,
          kind_counts: reconciled.kind_counts,
          disposition_counts: reconciled.disposition_counts,
          required_result_total: reconciled.required_result_total,
          required_result_resolved: reconciled.required_result_resolved,
          downstream_pending_required_result_ids: reconciled.downstream_pending_required_result_ids,
          unresolved_item_refs: reconciled.unresolved_item_refs,
          eligible_refs: reconciled.eligible_refs,
          ineligible_refs: reconciled.ineligible_refs,
          exhaustive_accounting: true,
          release_eligible: false,
          campaign_complete: false,
          blocker_codes: reconciled.blocker_codes,
        },
        "ledger_sha256"
      )
    );
    const priorRef = save({
      store,
      run_id: lineage.run_id,
      phase: "SCA-P09",
      kind: "sca-p09-reconciliation-ledger",
      operation_id: "sca-p09-reconciliation-ledger",
      schema_id: "penny.sca-p09-reconciliation-ledger.v1",
      value: priorLedger,
    });
    const unrelated = save({
      store,
      run_id: lineage.run_id,
      phase: "SCA-P09",
      kind: "sca-p09-checkpoint",
      operation_id: "sca-p09-checkpoint-unrelated",
      schema_id: "penny.sca-p09-checkpoint.v1",
      value: { unrelated: true },
    });
    const reassessment = validateScaP09ReassessmentV1(
      withP09Digest(
        {
          schema_id: SCA_P09_REASSESSMENT_SCHEMA,
          schema_version: 1,
          phase_id: "SCA-P09",
          run_id: lineage.run_id,
          prior_p09_ledger_ref: priorRef,
          prior_p09_ledger_sha256: priorRef.content_digest,
          trigger_codes: ["invalidated_evidence"],
          stimulus_refs: [lineage.p08_terminal_ref],
          invalidated_evidence_refs: [unrelated],
        },
        "reassessment_sha256"
      )
    );
    const result = reconcileScaP09({
      admitted,
      reassessment,
      prior_ledger: priorLedger,
      prior_ledger_ref: priorRef,
      checkpoint_refs_by_item_id: new Map(),
    });
    expect(result.predicates.append_only_revisions).toBe(false);
    expect(result.blocker_codes).toContain("p09_revision_chain_invalid::invalidated_not_relied_on");
  });
});

describe("SCA P09 handoff ref ordering", () => {
  it("requires every handoff ref set to be sorted and unique", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-handoff-order", true);
    const shared = lineage.p08_gate_ref;
    const base = {
      schema_id: SCA_P09_TO_P10_TRANSITION_SCHEMA,
      schema_version: 1,
      source_phase_id: "SCA-P09",
      target_phase_id: "SCA-P10",
      handoff_kind: "reconciled_eligible_evidence_only",
      qualification_scope: "reconciliation_gate_only_not_p10_learning",
      phase_gate_passed: false,
      p10_rule_learning_authorized_by_this_transition: false,
      release_eligible: false,
      campaign_complete: false,
      campaign_completion_claimed: false,
      p08_terminal_ref: shared,
      p08_transition_ref: shared,
      p08_evidence_ledger_ref: shared,
      p09_reconciliation_ledger_ref: shared,
      lane: "incomplete_closeout",
      eligible_refs: [shared],
      ineligible_refs: [shared, lineage.p08_terminal_ref],
      unresolved_item_refs: [shared],
      required_gaps_retained: true,
    };
    expect(() =>
      validateScaP09ToP10TransitionV1(withP09Digest(base, "transition_sha256"))
    ).toThrow();
  });
});

describe("SCA P09 host-only authority, liveness, and replay determinism", () => {
  it("dispatches zero host operations and zero model phases", () => {
    const { root, store } = makeStore();
    const lineage = fullLineage(store, "run-zero-dispatch", true);
    const startAdmission = required(
      SCA_P09_CANDIDATE_REGISTRATION.start_admission,
      "P09 start admission"
    );
    const request = startRequest(lineage, null);
    const prepared = startAdmission.prepare(request, {});
    const refs = startAdmission.materialize(prepared, {
      run_id: lineage.run_id,
      artifactStore: store,
      trustedClock: () => new Date("2026-09-26T00:00:04.000Z"),
    });
    const run = context(lineage.run_id, refs);
    const playbook = SCA_P09_CANDIDATE_REGISTRATION.construct({
      artifactStore: store,
      trustedClock: () => new Date("2026-09-26T00:00:04.000Z"),
    });
    playbook.initialize(run);
    using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    expect(checkpointer.hostOperationCallsForRun(lineage.run_id)).toEqual([]);
    expect(SCA_P09_CANDIDATE_REGISTRATION.worker.kind).toBe("none");
    expect(SCA_P09_CANDIDATE_REGISTRATION.worker.phases.size).toBe(0);
    expect(SCA_P09_CANDIDATE_REGISTRATION.host_operations).toBeUndefined();
  });

  it("exposes a deterministic non-trivial liveness policy", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-liveness", true);
    const run = context(lineage.run_id, []);
    const resolve = SCA_P09_CANDIDATE_REGISTRATION.liveness.resolve;
    const first = resolve(run);
    const second = resolve(run);
    expect(first).toBeDefined();
    if (first === undefined || first.schema_version !== 3) {
      throw new Error("expected the deterministic V3 P09 liveness policy");
    }
    expect(first.renewal_policy).toBe("trusted_host_activity_or_convergence_v1");
    expect(first).toEqual(second);
  });

  it("derives a stable gate timestamp so replay is deterministic across clock changes", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-clock", true);
    const early = drive(store, lineage, () => new Date("1999-01-01T00:00:00.000Z"));
    const late = drive(store, lineage, () => new Date("2099-12-31T23:59:59.000Z"));
    expect(selectedRef(late.run, "sca-p09-gate").artifact_id).toBe(
      selectedRef(early.run, "sca-p09-gate").artifact_id
    );
    expect(selectedRef(late.run, "sca-p09-terminal").artifact_id).toBe(
      selectedRef(early.run, "sca-p09-terminal").artifact_id
    );
  });

  it("persists the cancelled terminal accounting", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-cancelled-persist", true);
    const driven = drive(store, lineage, () => new Date("2026-09-26T00:00:04.000Z"));
    const directive = driven.playbook.cancel(driven.run, "operator cancelled");
    if (directive.action !== "cancelled") throw new Error("expected cancelled directive");
    const terminal = validateScaP09TerminalV1(directive.result);
    expect(terminal.status).toBe("cancelled");
    const terminalRef = selectedRef(driven.run, "sca-p09-terminal");
    expect(store.readById(terminalRef.artifact_id).toString("utf8")).toBe(canonicalJson(terminal));
    expect(directive.artifacts.some((ref) => ref.kind === "sca-p09-terminal")).toBe(true);
  });
});

// --- focused hardening regressions -----------------------------------------

function coverageFrom(
  store: Store,
  runId: string,
  entries: readonly Record<string, unknown>[]
): ArtifactRef {
  const sorted = [...entries].sort((left, right) =>
    String(left.identity) < String(right.identity) ? -1 : 1
  );
  return save({
    store,
    run_id: runId,
    phase: "SCA-P09",
    kind: "sca-p09-coverage-input",
    operation_id: `sca-p09-coverage-input-${sorted.length}-${String(sorted[0]?.identity ?? "").slice(-12)}`,
    schema_id: SCA_P09_COVERAGE_INPUT_SCHEMA,
    value: validateScaP09CoverageInputV1(
      withP09Digest(
        {
          schema_id: SCA_P09_COVERAGE_INPUT_SCHEMA,
          schema_version: 1,
          phase_id: "SCA-P09",
          run_id: runId,
          entries: sorted,
        },
        "coverage_sha256"
      )
    ),
  });
}

describe("SCA P09 coverage identity and injectivity", () => {
  it("rejects two candidate coverage entries that share one exact artifact (reproduced counterexample)", () => {
    const { store } = makeStore();
    const lineage = buildScaP09Lineage({
      store,
      run_id: "run-shared-coverage-ref",
      kinds: ["source_query"],
    });
    const shared = save({
      store,
      run_id: lineage.run_id,
      phase: "SCA-P02",
      kind: "sca-p02-persisted-evidence",
      operation_id: "sca-p02-persisted-evidence-shared",
      schema_id: "penny.sca-p02-persisted-evidence.v1",
      value: { shared: true },
    });
    const identity = scaP09CoverageEntryIdentity({
      surface_kind: "normalized_candidate",
      primary_ref: shared,
    });
    // Same surface kind and same exact artifact => colliding derived identity.
    expect(() =>
      coverageFrom(store, lineage.run_id, [
        {
          identity,
          surface_kind: "normalized_candidate",
          primary_ref: shared,
          coverage_state: "covered",
          reason: null,
          blocker_codes: [],
        },
        {
          identity,
          surface_kind: "normalized_candidate",
          primary_ref: shared,
          coverage_state: "covered",
          reason: null,
          blocker_codes: [],
        },
      ])
    ).toThrow();
  });

  it("rejects one exact artifact standing for two distinct candidate identities", () => {
    const { store } = makeStore();
    const lineage = buildScaP09Lineage({
      store,
      run_id: "run-shared-candidate-ref",
      kinds: ["source_query"],
    });
    const shared = save({
      store,
      run_id: lineage.run_id,
      phase: "SCA-P02",
      kind: "sca-p02-persisted-evidence",
      operation_id: "sca-p02-persisted-evidence-shared-candidate",
      schema_id: "penny.sca-p02-persisted-evidence.v1",
      value: { shared: true },
    });
    expect(() =>
      coverageFrom(store, lineage.run_id, [
        {
          identity: scaP09CoverageEntryIdentity({
            surface_kind: "normalized_candidate",
            primary_ref: shared,
          }),
          surface_kind: "normalized_candidate",
          primary_ref: shared,
          coverage_state: "covered",
          reason: null,
          blocker_codes: [],
        },
        {
          identity: scaP09CoverageEntryIdentity({
            surface_kind: "graph_candidate",
            primary_ref: shared,
          }),
          surface_kind: "graph_candidate",
          primary_ref: shared,
          coverage_state: "covered",
          reason: null,
          blocker_codes: [],
        },
      ])
    ).toThrow();
  });
});

describe("SCA P09 obligation resolution binds to the admitted lineage", () => {
  function phaseGateResolution(
    store: Store,
    runId: string,
    obligationId: string,
    ledgerRef: ArtifactRef,
    evidenceRef: ArtifactRef
  ): ArtifactRef {
    const history = ledgerOf(store, ledgerRef).entries.filter(
      (entry) => entry.obligation_id === obligationId
    );
    const last = required(history[history.length - 1], `${obligationId} entry`);
    return save({
      store,
      run_id: runId,
      phase: "SCA-P09",
      kind: "sca-p09-obligation-resolution",
      operation_id: "sca-p09-obligation-resolution-probe",
      schema_id: SCA_P09_OBLIGATION_RESOLUTION_SCHEMA,
      value: validateScaP09ObligationResolutionV1(
        withP09Digest(
          {
            schema_id: SCA_P09_OBLIGATION_RESOLUTION_SCHEMA,
            schema_version: 1,
            phase_id: "SCA-P09",
            run_id: runId,
            entries: [
              {
                obligation_id: obligationId,
                obligation_entry_sha256: last.entry_sha256,
                resolution_kind: "phase_acceptance",
                evidence_refs: [evidenceRef],
              },
            ],
          },
          "resolution_sha256"
        )
      ),
    });
  }

  it("rejects a fabricated standalone sca-p08-gate probe for P08 acceptance", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-fabricated-gate", true);
    const fabricated = save({
      store,
      run_id: lineage.run_id,
      phase: "SCA-P08",
      kind: "sca-p08-gate",
      operation_id: "sca-p08-gate-fabricated",
      schema_id: "penny.sca-p08-gate.v1",
      value: { verdict: "pass_ready" },
    });
    const resolutionRef = phaseGateResolution(
      store,
      lineage.run_id,
      "SCA-OBL-P08-ACCEPTANCE",
      lineage.p01_obligation_ledger_ref,
      fabricated
    );
    // Not admitted at all: the fabricated artifact is not part of the exact admitted lineage.
    const undeclared = admitLineage(store, lineage, { obligation_resolution_ref: resolutionRef });
    expect(undeclared.invalid_blocker_codes).toContain(
      "p09_obligation_resolution_invalid::evidence_not_admitted"
    );
    expect(undeclared.obligation_resolutions.has("SCA-OBL-P08-ACCEPTANCE")).toBe(false);
    // Even when explicitly admitted as a typed phase-evidence source, the P08 acceptance obligation
    // must bind to the exact admitted P08 gate rather than a look-alike.
    const declared = admitLineage(store, lineage, {
      obligation_resolution_ref: resolutionRef,
      phase_evidence_refs: [...lineage.phase_evidence_refs, fabricated],
    });
    expect(declared.invalid_blocker_codes).toContain(
      "p09_obligation_resolution_invalid::evidence_not_lineage"
    );
  });

  it("binds the golden P08 acceptance resolution to the exact admitted P08 gate", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-p08-acceptance-lineage", true);
    const resolution = validateScaP09ObligationResolutionV1(
      JSON.parse(
        store
          .readById(required(lineage.obligation_resolution_ref, "resolution").artifact_id)
          .toString("utf8")
      )
    );
    const entry = resolution.entries.find(
      (candidate) => candidate.obligation_id === "SCA-OBL-P08-ACCEPTANCE"
    );
    expect(entry?.evidence_refs[0]?.artifact_id).toBe(lineage.p08_gate_ref.artifact_id);
  });

  it("rejects an explicitly admitted phase-evidence source whose typed semantics are unmet", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-phase-evidence-semantics", true);
    const bogus = save({
      store,
      run_id: lineage.run_id,
      phase: "SCA-P02",
      kind: "sca-p02-gate",
      operation_id: "sca-p02-gate-bogus",
      schema_id: "penny.sca-p02-gate.v1",
      value: { obligation_id: "SCA-OBL-P02-ACCEPTANCE" },
    });
    expect(() =>
      admitLineage(store, lineage, {
        phase_evidence_refs: [...lineage.phase_evidence_refs, bogus],
      })
    ).toThrow();
  });
});

describe("SCA P09 E7 covers P06 checkpoints and P07 blocked rows", () => {
  it("holds while accounting every not-invoked P07 action row with an explicit blocker", () => {
    const { store } = makeStore();
    const lineage = buildScaP09Lineage({
      store,
      run_id: "run-e7-p07",
      kinds: ["source_query"],
      completed_indices: [],
    });
    const admitted = admitLineage(store, lineage);
    expect(admitted.set_equality?.e7).toBe(true);
    const result = reconcile(admitted);
    const actionItems = result.items.filter((item) => item.item_kind === "action");
    expect(actionItems.length).toBeGreaterThan(0);
    expect(actionItems.every((item) => item.blocker_codes.includes("p09_p07_row_unresolved"))).toBe(
      true
    );
  });
});

describe("SCA P09 P08 authority assurance provenance", () => {
  it("derives gate authority truth from the recorded P08 attestation, not from a P09 resolver", () => {
    const { store } = makeStore();
    const fixture = buildScaP09Lineage({
      store,
      run_id: "run-assurance-fixture",
      kinds: ["source_query"],
    });
    // A P09 resolver cannot upgrade a fixture-self-revalidated P08 admission.
    const admittedFixture = admitLineage(store, fixture, {
      resolve_current_p07_authority_ref: () => fixture.p07_authority_ref,
    });
    expect(admittedFixture.p08_admission?.p07_authority_assurance).toBe(
      "unattested_chain_revalidated"
    );
    expect(admittedFixture.p08_authority_assurance).toBe("unattested_chain_revalidated");

    const attested = buildScaP09Lineage({
      store,
      run_id: "run-assurance-attested",
      kinds: ["source_query"],
      attest_p07_authority: true,
    });
    const admittedAttested = admitLineage(store, attested, {
      resolve_current_p07_authority_ref: () => attested.p07_authority_ref,
    });
    expect(admittedAttested.p08_admission?.p07_authority_assurance).toBe("attested_unchanged");
    expect(admittedAttested.p08_authority_assurance).toBe("attested_unchanged");
    // A recorded production attestation cannot be reproduced without the independent resolver.
    expect(() => admitLineage(store, attested)).toThrow();
  });
});

describe("SCA P09 downstream required-result filtering", () => {
  it("lists only non-due required-result obligations as downstream pending", () => {
    const { store } = makeStore();
    const lineage = fullLineage(store, "run-downstream-filter", true);
    const admitted = admitLineage(store, lineage);
    const result = reconcile(admitted);
    expect(result.downstream_pending_required_result_ids).toContain("SCA-OBL-P10-ACCEPTANCE");
    expect(result.downstream_pending_required_result_ids).not.toContain(
      "SCA-OBL-OPTIONAL-NATIVE-GRAPH-ESCALATION"
    );
    expect(result.downstream_pending_required_result_ids).not.toContain(
      "SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY"
    );
    for (const id of result.downstream_pending_required_result_ids) {
      const derivation = admitted.p01_obligations.get(id);
      expect(derivation?.due_at_p09_entry).toBe(false);
      expect(derivation?.effective_class).toBe("required-result");
    }
  });
});

// --- shared drive helpers mirrored from the playbook test ------------------

function context(runId: string, refs: readonly ArtifactRef[]): RunContext {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: SCA_P09_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise inactive P09.",
    constraints: {},
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
    initialArtifacts: refs,
  });
}

function startRequest(lineage: ScaP09LineageV1, reassessmentRef: ArtifactRef | null): StartRequest {
  const constraints: Record<string, JsonValue> = {
    p08_terminal_ref: lineage.p08_terminal_ref,
    p08_transition_ref:
      lineage.p08_terminal_status === "cancelled" ? null : lineage.p08_transition_ref,
    p08_evidence_ledger_ref:
      lineage.p08_terminal_status === "cancelled" ? null : lineage.p08_evidence_ledger_ref,
    p08_gate_ref: lineage.p08_terminal_status === "cancelled" ? null : lineage.p08_gate_ref,
    p08_admission_ref:
      lineage.p08_terminal_status === "cancelled" ? null : lineage.p08_admission_ref,
    p08_item_universe_ref:
      lineage.p08_terminal_status === "cancelled" ? null : lineage.p08_item_universe_ref,
    p01_obligation_ledger_ref: lineage.p01_obligation_ledger_ref,
    ...(lineage.coverage_input_ref === null
      ? {}
      : { p09_coverage_input_ref: lineage.coverage_input_ref }),
    ...(lineage.phase_evidence_refs.length === 0
      ? {}
      : { p09_phase_evidence_refs: [...lineage.phase_evidence_refs] }),
    ...(lineage.obligation_resolution_ref === null
      ? {}
      : { p09_obligation_resolution_ref: lineage.obligation_resolution_ref }),
    ...(reassessmentRef === null ? {} : { p09_reassessment_ref: reassessmentRef }),
  };
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: lineage.run_id,
      session_id: `session-${lineage.run_id}`,
      playbook: SCA_P09_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise inactive P09.",
    constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted",
    input_artifacts: {
      schema_version: 2,
      artifacts: [
        { slot: "p08_terminal", ref: lineage.p08_terminal_ref },
        ...(lineage.p08_terminal_status === "cancelled"
          ? []
          : [
              { slot: "p08_transition", ref: lineage.p08_transition_ref },
              { slot: "p08_evidence_ledger", ref: lineage.p08_evidence_ledger_ref },
              { slot: "p08_gate", ref: lineage.p08_gate_ref },
              { slot: "p08_admission", ref: lineage.p08_admission_ref },
              { slot: "p08_item_universe", ref: lineage.p08_item_universe_ref },
            ]),
        { slot: "p01_obligation_ledger", ref: lineage.p01_obligation_ledger_ref },
        ...(lineage.coverage_input_ref === null
          ? []
          : [{ slot: "p09_coverage_input", ref: lineage.coverage_input_ref }]),
        ...lineage.phase_evidence_refs.map((ref, index) => ({
          slot: `p09_phase_evidence_${String(index).padStart(4, "0")}`,
          ref,
        })),
        ...(lineage.obligation_resolution_ref === null
          ? []
          : [
              {
                slot: "p09_obligation_resolution",
                ref: lineage.obligation_resolution_ref,
              },
            ]),
        ...(reassessmentRef === null ? [] : [{ slot: "p09_reassessment", ref: reassessmentRef }]),
      ],
    },
  };
}

function drive(
  store: Store,
  lineage: ScaP09LineageV1,
  clock: () => Date
): {
  readonly run: RunContext;
  readonly playbook: ReturnType<typeof SCA_P09_CANDIDATE_REGISTRATION.construct>;
  readonly directive: Directive;
} {
  const startAdmission = required(
    SCA_P09_CANDIDATE_REGISTRATION.start_admission,
    "P09 start admission"
  );
  const prepared = startAdmission.prepare(startRequest(lineage, null), {});
  const refs = startAdmission.materialize(prepared, {
    run_id: lineage.run_id,
    artifactStore: store,
    trustedClock: clock,
  });
  const run = context(lineage.run_id, refs);
  const playbook = SCA_P09_CANDIDATE_REGISTRATION.construct({
    artifactStore: store,
    trustedClock: clock,
  });
  const directive = playbook.initialize(run);
  return { run, playbook, directive };
}

function selectedRef(run: RunContext, kind: string): ArtifactRef {
  return required(
    [...run.selectedArtifacts].reverse().find((ref) => ref.kind === kind),
    `selected ${kind} ref`
  );
}
