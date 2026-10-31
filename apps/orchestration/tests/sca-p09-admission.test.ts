import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { admitScaP09Reconciliation } from "../dist/sca/p09-admission.js";
import { reconcileScaP09 } from "../dist/sca/p09-reconcile.js";
import { buildScaP09Lineage, type ScaP09LineageV1 } from "./sca-p09-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p09-admission-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function admit(
  artifacts: ArtifactStore,
  lineage: ScaP09LineageV1,
  overrides: Record<string, unknown> = {}
) {
  return admitScaP09Reconciliation({
    store: artifacts,
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

describe("SCA P09 exact lineage admission", () => {
  it("admits the exact P08 handoff and derives every immutable obligation class", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-admit",
      kinds: ["source_query", "graph_query"],
    });
    const admitted = admit(artifacts, lineage);
    expect(admitted.non_reconcilable).toBe(false);
    expect(admitted.p01_head_attested).toBe(false);
    expect(admitted.p01_fork_safety).toBe("unattested_chain_revalidated");
    const kinds = admitted.items.map((item) => item.item_kind);
    expect(kinds.filter((kind) => kind === "action")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "hypothesis")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "p06_obligation")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "p01_obligation").length).toBeGreaterThan(40);
    // The strongest applicable class is derived, never caller-selected.
    expect(admitted.p01_obligations.get("SCA-OBL-P01-ACCEPTANCE")?.effective_class).toBe(
      "required-result"
    );
    const promotion = admitted.p01_obligations.get("SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY");
    expect(promotion?.effective_class).toBe("attempt-and-report");
    expect(promotion?.material).toBe(true);
    expect(
      admitted.p01_obligations.get("SCA-OBL-OPTIONAL-NATIVE-GRAPH-ESCALATION")?.effective_class
    ).toBe("optional");
    // Absent coverage is fail-closed: the unreachable coverage obligations need exact checkpoints.
    const checkpointNeeds = admitted.items.filter((item) => item.checkpoint_needed !== null);
    expect(checkpointNeeds).toHaveLength(6);
    expect(
      checkpointNeeds.every(
        (item) => item.checkpoint_needed?.reason_code === "p09_coverage_input_absent"
      )
    ).toBe(true);
  });

  it("admits a full declared P02/P03/P04 coverage input and accounts every candidate once", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-coverage",
      kinds: ["source_query"],
      coverage: {
        entries: [
          {
            surface_kind: "normalized_candidate",
            coverage_state: "covered",
            reason: null,
          },
          {
            surface_kind: "graph_candidate",
            coverage_state: "covered",
            reason: null,
          },
          {
            surface_kind: "p04_selected_candidate",
            coverage_state: "covered",
            reason: null,
          },
          {
            surface_kind: "omitted_surface",
            coverage_state: "omitted",
            reason: "no P04 omission candidate",
          },
        ],
      },
    });
    const admitted = admit(artifacts, lineage);
    const candidates = admitted.items.filter((item) => item.item_kind === "candidate");
    const surfaces = admitted.items.filter((item) => item.item_kind === "surface");
    expect(candidates).toHaveLength(3);
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.coverage_state).toBe("omitted");
    expect(admitted.items.every((item) => item.checkpoint_needed === null)).toBe(true);
  });

  it("never clears the unreachable coverage obligations from a trivial or partial manifest", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-coverage-trivial",
      kinds: ["source_query"],
      coverage: {
        entries: [
          {
            surface_kind: "normalized_candidate",
            coverage_state: "covered",
            reason: null,
          },
        ],
      },
    });
    const admitted = admit(artifacts, lineage);
    const checkpointNeeds = admitted.items.filter((item) => item.checkpoint_needed !== null);
    expect(checkpointNeeds).toHaveLength(6);
    expect(
      checkpointNeeds.every(
        (item) => item.checkpoint_needed?.reason_code === "p09_coverage_scope_incomplete"
      )
    ).toBe(true);
  });

  it("admits a cancelled P08 result only as a non-reconcilable checkpoint", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-nonreconcilable",
      kinds: ["source_query"],
      cancelled: true,
    });
    const admitted = admitScaP09Reconciliation({
      store: artifacts,
      run_id: lineage.run_id,
      p08_terminal_ref: lineage.p08_terminal_ref,
      p08_transition_ref: null,
      p08_evidence_ledger_ref: null,
      p08_gate_ref: null,
      p08_admission_ref: null,
      p08_item_universe_ref: null,
      p01_obligation_ledger_ref: lineage.p01_obligation_ledger_ref,
    });
    expect(admitted.non_reconcilable).toBe(true);
    expect(admitted.items).toEqual([]);
    expect(admitted.non_reconcilable_reason).toBe("p08_cancelled_non_reconcilable_checkpoint");
  });

  it("fails closed on substituted, drifted, cross-run, and mismatched refs", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-negative",
      kinds: ["source_query"],
    });
    // Wrong kind / substituted ref.
    expect(() => admit(artifacts, lineage, { p08_terminal_ref: lineage.p08_gate_ref })).toThrow();
    // Rehashed / digest-drifted ref for the same artifact id.
    const drifted: ArtifactRef = { ...lineage.p08_terminal_ref, content_digest: "b".repeat(64) };
    expect(() => admit(artifacts, lineage, { p08_terminal_ref: drifted })).toThrow();
    // Cross-run scope.
    expect(() => admit(artifacts, lineage, { run_id: "other-run" })).toThrow();
    // Missing recorded P08 admission ref.
    expect(() => admit(artifacts, lineage, { p08_admission_ref: null })).toThrow();
    // P01 obligation ledger kind substitution.
    expect(() =>
      admit(artifacts, lineage, { p01_obligation_ledger_ref: lineage.p08_gate_ref })
    ).toThrow();
  });

  it("fails closed when a recorded P08 ledger row disagrees with the admitted universe", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-tamper",
      kinds: ["source_query"],
    });
    // A reconcilable admission whose P08 universe ref is replaced by another exact artifact must
    // fail the re-derivation equality check rather than silently reconcile.
    expect(() =>
      admit(artifacts, lineage, { p08_item_universe_ref: lineage.p08_admission_ref })
    ).toThrow();
  });
});

describe("SCA P09 deterministic reconciliation", () => {
  it("assigns accepted progression only when every due required result is resolved", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-lane-accepted",
      kinds: ["source_query"],
      completed_indices: [0],
      disposition_for: () => "confirmed",
      resolutions: "all_due",
      coverage: {
        entries: [
          {
            surface_kind: "normalized_candidate",
            coverage_state: "covered",
            reason: null,
          },
          {
            surface_kind: "graph_candidate",
            coverage_state: "covered",
            reason: null,
          },
          {
            surface_kind: "p04_selected_candidate",
            coverage_state: "covered",
            reason: null,
          },
          {
            surface_kind: "omitted_surface",
            coverage_state: "omitted",
            reason: "no P04 omission candidate",
          },
        ],
      },
    });
    const admitted = admit(artifacts, lineage);
    const result = reconcileScaP09({
      admitted,
      reassessment: null,
      prior_ledger: null,
      prior_ledger_ref: null,
      checkpoint_refs_by_item_id: new Map(),
    });
    expect(result.lane).toBe("accepted_progression");
    expect(result.required_result_total).toBeGreaterThan(0);
    expect(result.required_result_resolved).toBe(result.required_result_total);
    expect(result.downstream_pending_required_result_ids.length).toBeGreaterThan(0);
    expect(result.predicates.set_equality_valid).toBe(true);
    expect(result.predicates.effective_class_derivation_valid).toBe(true);
    expect(result.predicates.coverage_reconciled).toBe(true);
  });

  it("never assigns accepted progression while a required result is unresolved", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-lane-incomplete",
      kinds: ["source_query"],
    });
    const admitted = admit(artifacts, lineage);
    const checkpoints = new Map<string, ArtifactRef>(
      admitted.items
        .filter((item) => item.checkpoint_needed !== null)
        .map((item) => [item.item_id, item.primary_ref])
    );
    const result = reconcileScaP09({
      admitted,
      reassessment: null,
      prior_ledger: null,
      prior_ledger_ref: null,
      checkpoint_refs_by_item_id: checkpoints,
    });
    expect(result.lane).toBe("incomplete_closeout");
    expect(result.required_result_resolved).toBeLessThan(result.required_result_total);
    expect(result.blocker_codes).toContain("p09_coverage_input_absent");
    expect(result.blocker_codes).toContain("p09_required_result_unresolved");
    expect(result.unresolved_item_refs.length).toBeGreaterThan(0);
  });
});
