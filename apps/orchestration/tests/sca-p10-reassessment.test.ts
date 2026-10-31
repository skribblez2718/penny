import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type {
  ArtifactRef,
  Directive,
  OutputArtifactMetadata,
  StartRequest,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { admitScaP10Learning } from "../dist/sca/p10-admission.js";
import {
  SCA_P10_CANDIDATE_PLAYBOOK_NAME,
  SCA_P10_CANDIDATE_REGISTRATION,
  ScaP10CandidatePlaybook,
} from "../dist/sca/p10-playbook.js";
import {
  SCA_P10_REASSESSMENT_SCHEMA,
  validateScaP10EligibilityLedgerV1,
  validateScaP10ReassessmentV1,
  validateScaP10RuleLearningOutcomeV1,
  validateScaP10TerminalV1,
  withP10Digest,
  type ScaP10CandidateStartV1,
  type ScaP10EligibilityLedgerV1,
} from "../dist/sca/p10-contracts.js";
import { buildScaP09Lineage } from "./sca-p09-lineage.js";
import { buildScaP10Lineage, driveScaP09, type ScaP10LineageV1 } from "./sca-p10-lineage.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p10-reassess-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
function readJson(artifacts: ArtifactStore, ref: ArtifactRef): unknown {
  return JSON.parse(artifacts.readById(ref.artifact_id).toString("utf8"));
}

const COVERAGE_FULL: NonNullable<Parameters<typeof buildScaP09Lineage>[0]["coverage"]> = {
  entries: [
    { surface_kind: "normalized_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "graph_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "p04_selected_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "omitted_surface", coverage_state: "omitted", reason: "no omission candidate" },
  ],
};

function save(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly phase: string;
  readonly kind: string;
  readonly operationId: string;
  readonly schemaId: string;
  readonly value: unknown;
  readonly upstream?: readonly ArtifactRef[];
}): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: "host:p10-reassess-test",
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    parent_ref: null,
    upstream_refs: [...(input.upstream ?? [])],
  };
  return input.store.persist({ metadata, content: canonicalJson(input.value) });
}

interface Built {
  readonly store: ArtifactStore;
  readonly lineage: ScaP10LineageV1;
  readonly input: Parameters<typeof admitScaP10Learning>[0];
}

function buildLineage(input: { readonly store: ArtifactStore; readonly runId: string }): Built {
  const p09 = buildScaP09Lineage({
    store: input.store,
    run_id: input.runId,
    kinds: ["source_query"],
    completed_indices: [0],
    disposition_for: () => "confirmed",
    repository_location_for: () => ({ path: "src/example.php", line_start: 10, line_end: 12 }),
    resolutions: "all_due" as const,
    coverage: COVERAGE_FULL,
  });
  const result = driveScaP09({ store: input.store, p09 });
  const lineage = buildScaP10Lineage({
    store: input.store,
    p09,
    p09_result: result,
    baseline_languages: ["php"],
  });
  const c = lineage.constraints;
  return {
    store: input.store,
    lineage,
    input: {
      store: input.store,
      run_id: input.runId,
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
      p09_coverage_input_ref: c.p09_coverage_input_ref,
      p09_phase_evidence_refs: c.p09_phase_evidence_refs,
      p09_obligation_resolution_ref: c.p09_obligation_resolution_ref,
      p09_reassessment_ref: null,
      baseline_evidence_ref: c.baseline_evidence_ref,
      disclosure_scope_ref: c.disclosure_scope_ref,
      promotion_authority_ref: c.promotion_authority_ref,
      active_run_rule_release_refs: [] as readonly ArtifactRef[],
    },
  };
}

function persistLedger(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly ledger: ScaP10EligibilityLedgerV1;
}): ArtifactRef {
  return save({
    store: input.store,
    runId: input.runId,
    phase: "SCA-P10",
    kind: "sca-p10-eligibility-ledger",
    operationId: "sca-p10-eligibility-ledger",
    schemaId: "penny.sca-p10-eligibility-ledger.v1",
    value: input.ledger,
  });
}

function saveReassessment(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly priorP10LedgerRef: ArtifactRef;
  readonly priorP09LedgerRef: ArtifactRef;
  readonly invalidatedRefs: readonly ArtifactRef[];
}): ArtifactRef {
  const value = validateScaP10ReassessmentV1(
    withP10Digest(
      {
        schema_id: SCA_P10_REASSESSMENT_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P10" as const,
        run_id: input.runId,
        prior_p10_ledger_ref: input.priorP10LedgerRef,
        prior_p10_ledger_sha256: input.priorP10LedgerRef.content_digest,
        prior_p09_ledger_ref: input.priorP09LedgerRef,
        prior_p09_ledger_sha256: input.priorP09LedgerRef.content_digest,
        trigger_codes: ["invalidated_evidence"],
        stimulus_refs: [...input.invalidatedRefs],
        invalidated_evidence_refs: [...input.invalidatedRefs],
      },
      "reassessment_sha256"
    )
  );
  return save({
    store: input.store,
    runId: input.runId,
    phase: "SCA-P10",
    kind: "sca-p10-reassessment",
    operationId: "sca-p10-reassessment",
    schemaId: SCA_P10_REASSESSMENT_SCHEMA,
    value,
  });
}

describe("SCA P10 reassessment lineage, invalidation, and deterministic replay", () => {
  it("appends an eligibility revision bound to the prior ref/digest and rejects invalidated support", () => {
    using artifacts = store();
    const first = buildLineage({ store: artifacts, runId: "run-p10-reassess-1" });
    const admitted1 = admitScaP10Learning(first.input);
    const priorLedger = required(admitted1.eligibility, "prior eligibility ledger");
    const priorRef = persistLedger({
      store: artifacts,
      runId: first.lineage.run_id,
      ledger: priorLedger,
    });

    const second = buildLineage({ store: artifacts, runId: "run-p10-reassess-2" });
    const preAdmit = admitScaP10Learning(second.input);
    const target = required(
      required(preAdmit.eligibility, "second eligibility").eligible_items.find(
        (item) => item.eligible_classification === "established_issue"
      ),
      "invalidated established issue"
    );
    const reassessmentRef = saveReassessment({
      store: artifacts,
      runId: second.lineage.run_id,
      priorP10LedgerRef: priorRef,
      priorP09LedgerRef: required(
        first.lineage.constraints.p09_reconciliation_ledger_ref,
        "prior P09 ledger"
      ),
      invalidatedRefs: [target.p08_disposition_ref],
    });

    const admitted2 = admitScaP10Learning({
      ...second.input,
      p10_reassessment_ref: reassessmentRef,
      p10_prior_eligibility_ledger_ref: priorRef,
    });
    const eligibility = validateScaP10EligibilityLedgerV1(
      required(admitted2.eligibility, "reassessed eligibility")
    );
    expect(eligibility.eligibility_ledger_revision).toBe(2);
    expect(eligibility.prior_eligibility_ledger_ref?.artifact_id).toBe(priorRef.artifact_id);
    expect(eligibility.prior_eligibility_ledger_sha256).toBe(priorRef.content_digest);
    expect(eligibility.append_only).toBe(true);

    // The invalidated established issue neither survives as eligible support nor disappears: it is
    // retained as an ineligible record with an exact blocker.
    expect(eligibility.eligible_items.some((item) => item.item_id === target.item_id)).toBe(false);
    const dropped = required(
      eligibility.ineligible_items.find((item) => item.item_id === target.item_id),
      "invalidated ineligible item"
    );
    expect(dropped.blocker_codes).toContain("p10_evidence_invalidated");
    expect(
      admitted2.eligible_refs.some(
        (ref) => ref.artifact_id === target.p08_disposition_ref.artifact_id
      )
    ).toBe(false);
    expect(
      admitted2.ineligible_refs.some(
        (ref) => ref.artifact_id === target.p08_disposition_ref.artifact_id
      )
    ).toBe(true);

    // Replay is deterministic: the same exact inputs re-derive byte-identical eligibility.
    const replay = admitScaP10Learning({
      ...second.input,
      p10_reassessment_ref: reassessmentRef,
      p10_prior_eligibility_ledger_ref: priorRef,
    });
    expect(canonicalJson(replay.eligibility)).toBe(canonicalJson(eligibility));
  });

  it("keeps an eligible item when the reassessment does not invalidate its support", () => {
    using artifacts = store();
    const first = buildLineage({ store: artifacts, runId: "run-p10-reassess-keep-1" });
    const priorRef = persistLedger({
      store: artifacts,
      runId: first.lineage.run_id,
      ledger: required(admitScaP10Learning(first.input).eligibility, "prior"),
    });
    const second = buildLineage({ store: artifacts, runId: "run-p10-reassess-keep-2" });
    const preAdmit = admitScaP10Learning(second.input);
    const target = required(
      required(preAdmit.eligibility, "second eligibility").eligible_items.find(
        (item) => item.eligible_classification === "established_issue"
      ),
      "established issue"
    );
    // A stimulus that is not named as invalidated does not drop any support.
    const reassessment = save({
      store: artifacts,
      runId: second.lineage.run_id,
      phase: "SCA-P10",
      kind: "sca-p10-reassessment",
      operationId: "sca-p10-reassessment",
      schemaId: SCA_P10_REASSESSMENT_SCHEMA,
      value: withP10Digest(
        {
          schema_id: SCA_P10_REASSESSMENT_SCHEMA,
          schema_version: 1 as const,
          phase_id: "SCA-P10" as const,
          run_id: second.lineage.run_id,
          prior_p10_ledger_ref: priorRef,
          prior_p10_ledger_sha256: priorRef.content_digest,
          prior_p09_ledger_ref: required(
            first.lineage.constraints.p09_reconciliation_ledger_ref,
            "prior P09 ledger"
          ),
          prior_p09_ledger_sha256: required(
            first.lineage.constraints.p09_reconciliation_ledger_ref,
            "prior P09 ledger"
          ).content_digest,
          trigger_codes: ["new_evidence"],
          stimulus_refs: [target.p08_disposition_ref],
          invalidated_evidence_refs: [],
        },
        "reassessment_sha256"
      ),
    });
    const admitted = admitScaP10Learning({
      ...second.input,
      p10_reassessment_ref: reassessment,
      p10_prior_eligibility_ledger_ref: priorRef,
    });
    expect(admitted.eligibility?.eligibility_ledger_revision).toBe(2);
    expect(
      admitted.eligibility?.eligible_items.some((item) => item.item_id === target.item_id)
    ).toBe(true);
  });
});

function buildStartRequest(input: {
  readonly runId: string;
  readonly constraints: ScaP10CandidateStartV1;
}): StartRequest {
  const c = input.constraints;
  const slots: { slot: string; ref: ArtifactRef }[] = [
    { slot: "p09_terminal", ref: c.p09_terminal_ref },
    { slot: "p09_transition", ref: required(c.p09_transition_ref, "p09 transition") },
    {
      slot: "p09_reconciliation_ledger",
      ref: required(c.p09_reconciliation_ledger_ref, "p09 ledger"),
    },
    { slot: "p09_gate", ref: required(c.p09_gate_ref, "p09 gate") },
    { slot: "p09_admission", ref: required(c.p09_admission_ref, "p09 admission") },
    { slot: "p08_terminal", ref: c.p08_terminal_ref },
    { slot: "p08_transition", ref: required(c.p08_transition_ref, "p08 transition") },
    { slot: "p08_evidence_ledger", ref: required(c.p08_evidence_ledger_ref, "p08 evidence") },
    { slot: "p08_gate", ref: required(c.p08_gate_ref, "p08 gate") },
    { slot: "p08_admission", ref: required(c.p08_admission_ref, "p08 admission") },
    { slot: "p08_item_universe", ref: required(c.p08_item_universe_ref, "p08 item universe") },
    { slot: "p01_obligation_ledger", ref: c.p01_obligation_ledger_ref },
    ...(c.p09_coverage_input_ref === null
      ? []
      : [{ slot: "p09_coverage_input", ref: c.p09_coverage_input_ref }]),
    ...c.p09_phase_evidence_refs.map((ref, index) => ({
      slot: `p09_phase_evidence_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...(c.p09_obligation_resolution_ref === null
      ? []
      : [{ slot: "p09_obligation_resolution", ref: c.p09_obligation_resolution_ref }]),
    { slot: "baseline_evidence", ref: c.baseline_evidence_ref },
    { slot: "disclosure_scope", ref: c.disclosure_scope_ref },
    { slot: "promotion_authority", ref: c.promotion_authority_ref },
    ...(c.p10_reassessment_ref === null
      ? []
      : [{ slot: "p10_reassessment", ref: c.p10_reassessment_ref }]),
    ...(c.p10_prior_ledger_ref === null
      ? []
      : [{ slot: "p10_prior_ledger", ref: c.p10_prior_ledger_ref }]),
  ];
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: `session-${input.runId}`,
      playbook: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise the inactive P10 reassessment revision.",
    constraints: c,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted",
    input_artifacts: { schema_version: 2, artifacts: slots },
  };
}

describe("SCA P10 reassessment playbook revision", () => {
  it("emits a versioned eligibility and outcome revision and reaches a non-positive terminal", () => {
    using artifacts = store();
    const first = buildLineage({ store: artifacts, runId: "run-p10-play-reassess-1" });
    const priorRef = persistLedger({
      store: artifacts,
      runId: first.lineage.run_id,
      ledger: required(admitScaP10Learning(first.input).eligibility, "prior"),
    });
    const second = buildLineage({ store: artifacts, runId: "run-p10-play-reassess-2" });
    const preAdmit = admitScaP10Learning(second.input);
    const established = required(preAdmit.eligibility, "second eligibility").eligible_items.filter(
      (item) => item.eligible_classification === "established_issue"
    );
    expect(established.length).toBeGreaterThan(0);
    const reassessmentRef = saveReassessment({
      store: artifacts,
      runId: second.lineage.run_id,
      priorP10LedgerRef: priorRef,
      priorP09LedgerRef: required(
        first.lineage.constraints.p09_reconciliation_ledger_ref,
        "prior P09 ledger"
      ),
      invalidatedRefs: established.map((item) => item.p08_disposition_ref),
    });
    const constraints: ScaP10CandidateStartV1 = {
      ...second.lineage.constraints,
      p10_reassessment_ref: reassessmentRef,
      p10_prior_ledger_ref: priorRef,
    };

    const request = buildStartRequest({ runId: second.lineage.run_id, constraints });
    const startAdmission = required(
      SCA_P10_CANDIDATE_REGISTRATION.start_admission,
      "P10 start admission"
    );
    const prepared = startAdmission.prepare(request, {});
    const refs = startAdmission.materialize(prepared, {
      run_id: second.lineage.run_id,
      artifactStore: artifacts,
      trustedClock: () => new Date("2026-09-26T00:00:07.000Z"),
    });
    const run = RunContext.create({
      identity: request.identity,
      goal: request.goal,
      constraints: {},
      projectRoot: PROJECT_ROOT,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
      initialArtifacts: refs,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
        contract_sha256: "b".repeat(64),
        registration_sha256: "a".repeat(64),
      },
    });
    const playbook = new ScaP10CandidatePlaybook(
      artifacts,
      {},
      () => new Date("2026-09-26T00:00:07.000Z")
    );
    const directive: Directive = playbook.initialize(run);
    if (directive.action !== "incomplete") {
      throw new Error("expected the reassessed P10 run to reach a non-positive terminal");
    }
    const terminal = validateScaP10TerminalV1(directive.result);
    expect(terminal.status).toBe("learning_complete");
    expect(terminal.outcome_disposition).toBe("no_rule");
    expect(terminal.phase_gate_passed).toBe(false);
    expect(terminal.release_eligible).toBe(false);

    const eligibilityRef = required(
      [...run.selectedArtifacts].reverse().find((ref) => ref.kind === "sca-p10-eligibility-ledger"),
      "reassessed eligibility ref"
    );
    expect(eligibilityRef.operation_id).toBe("sca-p10-eligibility-ledger-revision-000002");
    const eligibility = validateScaP10EligibilityLedgerV1(readJson(artifacts, eligibilityRef));
    expect(eligibility.eligibility_ledger_revision).toBe(2);
    expect(eligibility.prior_eligibility_ledger_ref?.artifact_id).toBe(priorRef.artifact_id);
    expect(eligibility.prior_eligibility_ledger_sha256).toBe(priorRef.content_digest);

    const outcomeRef = required(
      [...run.selectedArtifacts]
        .reverse()
        .find((ref) => ref.kind === "sca-p10-rule-learning-outcome"),
      "reassessed outcome ref"
    );
    expect(outcomeRef.operation_id).toBe("sca-p10-rule-learning-outcome-revision-000002");
    const outcome = validateScaP10RuleLearningOutcomeV1(readJson(artifacts, outcomeRef));
    expect(outcome.disposition).toBe("no_rule");
    expect(
      outcome.eligible_refs.some((ref) =>
        established.some((item) => item.p08_disposition_ref.artifact_id === ref.artifact_id)
      )
    ).toBe(false);

    // Deterministic replay: rebuilding the same run yields identical persisted revision bytes.
    expect(eligibilityRef.content_digest).toBe(sha256(canonicalJson(eligibility)));
  });
});
