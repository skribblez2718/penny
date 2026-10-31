import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { admitScaP08Disposition } from "../dist/sca/p08-admission.js";
import { SCA_P08_SCOPE_DECISION_KINDS } from "../dist/sca/p08-contracts.js";
import { validateScaP06AcceptedCohortV1 } from "../dist/sca/p06-contracts.js";
import {
  buildScaP08Lineage,
  type ScaP08LedgerRowFixtureV1,
  type ScaP08LineageV1,
} from "./sca-p08-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p08-admission-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function parseUnknown(text: string): unknown {
  return JSON.parse(text);
}

function admit(
  storeValue: ArtifactStore,
  lineage: ScaP08LineageV1,
  overrides: Record<string, unknown> = {}
) {
  return admitScaP08Disposition({
    store: storeValue,
    run_id: lineage.run_id,
    p07_terminal_ref: lineage.p07_terminal_ref,
    p07_evidence_ledger_ref: lineage.p07_evidence_ledger_ref,
    p07_transition_ref: lineage.p07_transition_ref,
    disclosure_scope_ref: lineage.disclosure_scope_ref,
    ...overrides,
  });
}

describe("SCA P08 exact lineage admission", () => {
  it("admits the exact P07 handoff and builds actions ∪ hypotheses ∪ obligations", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-admit",
      kinds: ["source_query", "graph_query"],
    });
    const result = admit(artifacts, lineage);
    expect(result.admission.blocked_checkpoint).toBe(false);
    expect(result.admission.item_count).toBe(6);
    const kinds = result.items.map((item) => item.item_kind);
    expect(kinds.filter((kind) => kind === "action")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "hypothesis")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "obligation")).toHaveLength(2);
    expect(result.universe.items).toHaveLength(6);
    // Every action item inherits its honest not-invoked P07 status.
    for (const item of result.items) {
      if (item.item_kind === "action") expect(item.p07_status).toBe("not_invoked");
    }
  });

  it("admits a blocked checkpoint when the P07 terminal recorded no transition", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-blocked",
      kinds: ["source_query"],
      with_transition: false,
    });
    const result = admit(artifacts, lineage);
    expect(result.admission.blocked_checkpoint).toBe(true);
    expect(result.admission.p07_transition_ref).toBeNull();
  });

  it("fails closed on a substituted ref, digest drift, cross-run scope, and a missing transition", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-negative",
      kinds: ["source_query"],
    });
    // Wrong kind / substituted ref.
    expect(() =>
      admitScaP08Disposition({
        store: artifacts,
        run_id: lineage.run_id,
        p07_terminal_ref: lineage.p07_evidence_ledger_ref,
        p07_evidence_ledger_ref: lineage.p07_evidence_ledger_ref,
        p07_transition_ref: lineage.p07_transition_ref,
        disclosure_scope_ref: lineage.disclosure_scope_ref,
      })
    ).toThrow();
    // Rehashed / digest-drifted ref for the same artifact id.
    const rehashed: ArtifactRef = { ...lineage.p07_terminal_ref, content_digest: "b".repeat(64) };
    expect(() => admit(artifacts, lineage, { p07_terminal_ref: rehashed })).toThrow();
    // Cross-run scope.
    expect(() => admit(artifacts, lineage, { run_id: "other-run" })).toThrow();
    // Missing transition while the terminal records one.
    expect(() => admit(artifacts, lineage, { p07_transition_ref: null })).toThrow();
  });

  it("derives the admitted scope evidence from the allowlist, not handoff transitions", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-scope-set",
      kinds: ["source_query"],
    });
    const result = admit(artifacts, lineage);
    // The declared allowlist is the single source of truth for the admitted set.
    expect([...result.scope_decision_refs.map((ref) => ref.kind)].sort()).toEqual(
      [...SCA_P08_SCOPE_DECISION_KINDS].sort()
    );
    expect(result.scope_decision_ref_ids).toEqual(
      new Set(result.scope_decision_refs.map((ref) => ref.artifact_id))
    );
    // The exact P01 source snapshot (campaign source scope) and P06 accepted cohort are admitted.
    const sourceScope = result.scope_decision_refs.find((ref) => ref.kind === "source-snapshot");
    const cohort = result.scope_decision_refs.find((ref) => ref.kind === "sca-p06-accepted-cohort");
    if (sourceScope === undefined || cohort === undefined) {
      throw new Error("admitted scope-decision records are absent");
    }
    expect(sourceScope.content_schema?.schema_id).toBe("penny.sca-campaign-source-snapshot.v2");
    const cohortValue = validateScaP06AcceptedCohortV1(
      parseUnknown(artifacts.readById(cohort.artifact_id).toString("utf8"))
    );
    expect(cohortValue.source_snapshot_ref.artifact_id).toBe(sourceScope.artifact_id);
    expect(cohortValue.source_snapshot_sha256).toBe(sourceScope.content_digest);
    // Handoff transitions and provider disclosure scope are not scope decisions.
    const denied = [
      lineage.p06_transition_ref,
      lineage.disclosure_scope_ref,
      ...(lineage.p07_transition_ref === null ? [] : [lineage.p07_transition_ref]),
    ];
    for (const ref of denied) {
      expect(result.scope_decision_ref_ids.has(ref.artifact_id)).toBe(false);
    }
  });

  it("fails closed when the P07 ledger disagrees with its transition counts", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-crosscheck",
      kinds: ["source_query"],
    });
    // A terminal ref that names a different ledger must not admit.
    const wrongTerminal = {
      ...lineage.p07_terminal_ref,
      artifact_id: lineage.p07_evidence_ledger_ref.artifact_id,
    };
    expect(() => admit(artifacts, lineage, { p07_terminal_ref: wrongTerminal })).toThrow();
  });

  it("exact-reads and revalidates every completed P07 row's host result/receipt/platform", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-completed",
      kinds: ["source_query", "graph_query"],
      completed_indices: [0, 1],
    });
    const result = admit(artifacts, lineage);
    const actions = result.items.filter((item) => item.item_kind === "action");
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.p07_status).toBe("completed");
      // request + result + platform result + host receipt, all exact-read at admission.
      expect(action.p07_evidence_refs).toHaveLength(4);
    }
  });

  it("fails closed on a completed row whose host evidence is substituted, dropped, or foreign", () => {
    using artifacts = store();
    const local = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-row-tamper",
      kinds: ["source_query"],
      completed_indices: [0],
    });
    const row = requiredRow(local, 0);
    expect(row.platform_result_ref).not.toBeNull();
    expect(row.host_result_ref).not.toBeNull();

    // A foreign-but-valid host result from another run is not this row's exact result.
    const foreign = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-row-foreign",
      kinds: ["source_query"],
      completed_indices: [0],
    });
    const foreignResult = requiredRow(foreign, 0).host_result_ref;
    if (foreignResult === null) throw new Error("foreign host result is absent");

    // Admission is attempted by the fixture itself, so a mutated row aborts the whole build.
    expect(() =>
      tamperLineage(artifacts, "run-p08-row-sub", (candidate) => ({
        ...candidate,
        platform_result_ref: candidate.host_receipt_ref,
      }))
    ).toThrow();
    expect(() =>
      tamperLineage(artifacts, "run-p08-row-drop", (candidate) => ({
        ...candidate,
        host_result_ref: null,
        platform_result_ref: null,
        host_receipt_ref: null,
      }))
    ).toThrow();
    expect(() =>
      tamperLineage(artifacts, "run-p08-row-foreign-2", (candidate) => ({
        ...candidate,
        host_result_ref: foreignResult,
      }))
    ).toThrow();
    expect(() =>
      tamperLineage(artifacts, "run-p08-row-drift", (candidate) => ({
        ...candidate,
        host_request_ref: { ...candidate.host_request_ref, content_digest: "f".repeat(64) },
      }))
    ).toThrow();

    // The untampered completed lineage still admits.
    expect(() => admit(artifacts, local)).not.toThrow();
  });
});

function requiredRow(lineage: ScaP08LineageV1, index: number): ScaP08LedgerRowFixtureV1 {
  const row = lineage.p07_rows[index];
  if (row === undefined) throw new Error(`P07 fixture row ${index} is absent`);
  return row;
}

/** Rebuild a completed lineage under a fresh run with one mutated P07 ledger row. */
function tamperLineage(
  artifacts: ArtifactStore,
  runId: string,
  mutate: (row: ScaP08LedgerRowFixtureV1) => ScaP08LedgerRowFixtureV1
): ScaP08LineageV1 {
  return buildScaP08Lineage({
    store: artifacts,
    run_id: runId,
    kinds: ["source_query"],
    completed_indices: [0],
    tamper_row: (row, index) => (index === 0 ? mutate(row) : row),
  });
}
