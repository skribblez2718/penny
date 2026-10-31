import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { admitScaP10Learning } from "../dist/sca/p10-admission.js";
import {
  validateScaP10BaselineEvidenceV1,
  validateScaP10EligibilityLedgerV1,
  withP10Digest,
} from "../dist/sca/p10-contracts.js";
import { buildScaP09Lineage } from "./sca-p09-lineage.js";
import { buildScaP10Lineage, driveScaP09, type ScaP10LineageInputV1 } from "./sca-p10-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p10-admission-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
function readJson(store: ArtifactStore, ref: ArtifactRef): unknown {
  return JSON.parse(store.readById(ref.artifact_id).toString("utf8"));
}

const COVERAGE_FULL: NonNullable<Parameters<typeof buildScaP09Lineage>[0]["coverage"]> = {
  entries: [
    { surface_kind: "normalized_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "graph_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "p04_selected_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "omitted_surface", coverage_state: "omitted", reason: "no omission candidate" },
  ],
};

interface BuiltRun {
  readonly store: ArtifactStore;
  readonly admit: () => ReturnType<typeof admitScaP10Learning>;
  readonly admitWith: (overrides: {
    readonly p09_terminal_ref?: ArtifactRef;
    readonly baseline_evidence_ref?: ArtifactRef;
  }) => ReturnType<typeof admitScaP10Learning>;
  readonly constraints: ReturnType<typeof buildScaP10Lineage>["constraints"];
}

function build(input: {
  readonly runId: string;
  readonly accepted: boolean;
  readonly baselineLanguages?: ScaP10LineageInputV1["baseline_languages"];
  readonly baselineAlerts?: ScaP10LineageInputV1["baseline_alerts"];
  readonly baselineBlocked?: ScaP10LineageInputV1["baseline_blocked_languages"];
  readonly baselineNotApplicable?: ScaP10LineageInputV1["baseline_not_applicable_languages"];
  readonly baselineSnapshotMismatch?: ScaP10LineageInputV1["baseline_snapshot_mismatch_languages"];
  readonly located?: boolean;
  readonly cancelled?: boolean;
}): BuiltRun {
  const artifacts = store();
  const p09 = buildScaP09Lineage({
    store: artifacts,
    run_id: input.runId,
    kinds: ["source_query"],
    completed_indices: [0],
    disposition_for: () => "confirmed",
    ...(input.located === false
      ? {}
      : {
          repository_location_for: () => ({
            path: "src/example.php",
            line_start: 10,
            line_end: 12,
          }),
        }),
    ...(input.accepted ? { resolutions: "all_due" as const, coverage: COVERAGE_FULL } : {}),
    ...(input.cancelled === true ? { cancelled: true } : {}),
  });
  const result = driveScaP09({ store: artifacts, p09 });
  const lineage = buildScaP10Lineage({
    store: artifacts,
    p09,
    p09_result: result,
    baseline_languages: input.baselineLanguages ?? ["php"],
    ...(input.baselineAlerts === undefined ? {} : { baseline_alerts: input.baselineAlerts }),
    ...(input.baselineBlocked === undefined
      ? {}
      : { baseline_blocked_languages: input.baselineBlocked }),
    ...(input.baselineNotApplicable === undefined
      ? {}
      : { baseline_not_applicable_languages: input.baselineNotApplicable }),
    ...(input.baselineSnapshotMismatch === undefined
      ? {}
      : { baseline_snapshot_mismatch_languages: input.baselineSnapshotMismatch }),
  });
  const base = {
    store: artifacts,
    run_id: input.runId,
    p09_terminal_ref: lineage.constraints.p09_terminal_ref,
    p09_transition_ref: lineage.constraints.p09_transition_ref,
    p09_reconciliation_ledger_ref: lineage.constraints.p09_reconciliation_ledger_ref,
    p09_gate_ref: lineage.constraints.p09_gate_ref,
    p09_admission_ref: lineage.constraints.p09_admission_ref,
    p08_terminal_ref: lineage.constraints.p08_terminal_ref,
    p08_transition_ref: lineage.constraints.p08_transition_ref,
    p08_evidence_ledger_ref: lineage.constraints.p08_evidence_ledger_ref,
    p08_gate_ref: lineage.constraints.p08_gate_ref,
    p08_admission_ref: lineage.constraints.p08_admission_ref,
    p08_item_universe_ref: lineage.constraints.p08_item_universe_ref,
    p01_obligation_ledger_ref: lineage.constraints.p01_obligation_ledger_ref,
    p09_coverage_input_ref: lineage.constraints.p09_coverage_input_ref,
    p09_phase_evidence_refs: lineage.constraints.p09_phase_evidence_refs,
    p09_obligation_resolution_ref: lineage.constraints.p09_obligation_resolution_ref,
    p09_reassessment_ref: null,
    baseline_evidence_ref: lineage.constraints.baseline_evidence_ref,
    disclosure_scope_ref: lineage.constraints.disclosure_scope_ref,
    promotion_authority_ref: lineage.constraints.promotion_authority_ref,
    active_run_rule_release_refs: [] as readonly ArtifactRef[],
  };
  return {
    store: artifacts,
    constraints: lineage.constraints,
    admit: () => admitScaP10Learning(base),
    admitWith: (overrides) => admitScaP10Learning({ ...base, ...overrides }),
  };
}

function established(run: BuiltRun) {
  const admitted = run.admit();
  const eligibility = required(admitted.eligibility, "eligibility ledger");
  return eligibility.eligible_items.filter(
    (item) => item.eligible_classification === "established_issue"
  );
}

describe("SCA P10 exact P09 lineage admission and eligibility", () => {
  it("admits the accepted lane and re-derives the exact P09 reconciliation", () => {
    const run = build({ runId: "run-p10-accepted", accepted: true });
    const admitted = run.admit();
    expect(admitted.non_learnable).toBe(false);
    expect(admitted.lane).toBe("accepted_progression");
    expect(admitted.admission.p09_rederivation_ok).toBe(true);
    expect(admitted.admission.p09_reconciliation_rederivation_ok).toBe(true);
    expect(admitted.p09_reconciliation?.lane).toBe("accepted_progression");
  });

  it("admits the incomplete-closeout lane without upgrading unresolved items", () => {
    const run = build({ runId: "run-p10-incomplete", accepted: false });
    const admitted = run.admit();
    expect(admitted.non_learnable).toBe(false);
    expect(admitted.lane).toBe("incomplete_closeout");
    expect(admitted.admission.item_count).toBe(admitted.p09_ledger?.item_count);
  });

  it("admits a cancelled P09 checkpoint as non-learnable accounting only", () => {
    const run = build({ runId: "run-p10-cancelled", accepted: false, cancelled: true });
    const admitted = run.admit();
    expect(admitted.non_learnable).toBe(true);
    expect(admitted.lane).toBeNull();
    expect(admitted.eligibility).toBeNull();
    expect(admitted.eligible_refs).toEqual([]);
  });
});

describe("SCA P10 false-negative predicate honesty", () => {
  it("classifies a missed established issue as a false negative", () => {
    const run = build({ runId: "run-p10-fn", accepted: true, baselineAlerts: [] });
    const issues = established(run);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.baseline_classification).toBe("false_negative");
      expect(issue.baseline_language).toBe("php");
    }
  });

  it("classifies a covering baseline alert as a baseline hit, never a false negative", () => {
    const run = build({
      runId: "run-p10-hit",
      accepted: true,
      baselineAlerts: [{ language: "php", path: "src/example.php", start_line: 11 }],
    });
    const issues = established(run);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.baseline_classification).toBe("baseline_hit");
    }
  });

  it("treats an absent baseline language as a coverage gap", () => {
    const run = build({
      runId: "run-p10-gap-language",
      accepted: true,
      baselineLanguages: ["typescript"],
    });
    const issues = established(run);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.baseline_classification).toBe("coverage_gap");
    }
  });

  it("treats a failed baseline as a coverage gap, never a false negative", () => {
    const run = build({
      runId: "run-p10-gap-failed",
      accepted: true,
      baselineBlocked: ["php"],
    });
    const issues = established(run);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.baseline_classification).toBe("coverage_gap");
      expect(issue.baseline_classification).not.toBe("false_negative");
    }
  });

  it("treats an unlocated established issue as a coverage gap", () => {
    const run = build({
      runId: "run-p10-gap-unlocated",
      accepted: true,
      located: false,
      baselineAlerts: [],
    });
    const admitted = run.admit();
    const eligibility = validateScaP10EligibilityLedgerV1(admitted.eligibility);
    const issue = eligibility.eligible_items.find(
      (item) => item.eligible_classification === "established_issue"
    );
    expect(issue?.baseline_classification).toBe("coverage_gap");
    expect(issue?.blocker_codes).toContain("p10_issue_unlocated");
  });

  it("classifies a not-applicable baseline analyzer as a coverage gap, never a false negative", () => {
    // The exact P02 result is `complete` but its analyzer is `not_applicable`; the false-negative
    // predicate must re-derive applicability from those exact bytes and refuse the classification.
    const run = build({
      runId: "run-p10-gap-not-applicable",
      accepted: true,
      baselineNotApplicable: ["php"],
    });
    const issues = established(run);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.baseline_classification).toBe("coverage_gap");
      expect(issue.baseline_classification).not.toBe("false_negative");
    }
  });

  it("classifies a baseline whose P02 snapshot binding differs as a coverage gap", () => {
    // The exact P02 result binds a different source snapshot; the false-negative predicate must
    // re-derive that binding from the P02 bytes and refuse the classification.
    const run = build({
      runId: "run-p10-gap-snapshot-binding",
      accepted: true,
      baselineSnapshotMismatch: ["php"],
    });
    const issues = established(run);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.baseline_classification).toBe("coverage_gap");
      expect(issue.baseline_classification).not.toBe("false_negative");
    }
  });
});

describe("SCA P10 fail-closed admission", () => {
  it("rejects a digest-drifted P09 terminal ref", () => {
    const run = build({ runId: "run-p10-drift", accepted: true });
    expect(run.admit().lane).toBe("accepted_progression");
    const terminalRef = run.constraints.p09_terminal_ref;
    expect(() =>
      run.admitWith({
        p09_terminal_ref: { ...terminalRef, content_digest: "0".repeat(64) },
      })
    ).toThrow();
  });

  it("rejects a baseline whose declared status does not match the exact P02 bytes", () => {
    const run = build({ runId: "run-p10-baseline-tamper", accepted: true });
    const baselineRef = run.constraints.baseline_evidence_ref;
    const baseline = validateScaP10BaselineEvidenceV1(readJson(run.store, baselineRef));
    const first = required(baseline.entries[0], "baseline entry");
    // Re-digest over the body *excluding* the stale digest, so the mutant is self-consistent and
    // reaches the re-derivation predicate rather than failing early on a self-digest mismatch.
    const tampered = withP10Digest(
      {
        schema_id: baseline.schema_id,
        schema_version: baseline.schema_version,
        phase_id: baseline.phase_id,
        run_id: baseline.run_id,
        frozen_rule_release_ref: baseline.frozen_rule_release_ref,
        frozen_rule_release_sha256: baseline.frozen_rule_release_sha256,
        frozen_rule_config_sha256: baseline.frozen_rule_config_sha256,
        source_snapshot_ref: baseline.source_snapshot_ref,
        source_snapshot_sha256: baseline.source_snapshot_sha256,
        entries: [{ ...first, baseline_status: "failed" as const }, ...baseline.entries.slice(1)],
      },
      "baseline_sha256"
    );
    const tamperedRef = run.store.persist({
      metadata: {
        schema_version: 2,
        run_id: "run-p10-baseline-tamper",
        phase: "SCA-P10",
        branch_id: null,
        kind: "sca-p10-baseline-evidence",
        operation_id: "sca-p10-baseline-evidence-tampered",
        version: 1,
        producer: "host:sca-p10-test",
        media_type: "application/json",
        content_schema: { schema_id: "penny.sca-p10-baseline-evidence.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(tampered),
    });
    expect(() => run.admitWith({ baseline_evidence_ref: tamperedRef })).toThrow(
      /baseline status is not re-derived/
    );
  });
});
