import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, Directive, JsonValue, StartRequest } from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { SCA_PHASE_REGISTRY } from "../dist/sca/phase-registry.js";
import { PLAYBOOK_REGISTRY, validateRegistrationContract } from "../dist/playbooks/registry.js";
import type { Playbook } from "../dist/playbooks/playbook.js";
import {
  SCA_P09_CANDIDATE_PLAYBOOK_NAME,
  SCA_P09_CANDIDATE_REGISTRATION,
  SCA_P09_START_V1_SCHEMA,
  createScaP09CandidateRegistrationV1,
} from "../dist/sca/p09-playbook.js";
import {
  SCA_P09_FINAL_STATE,
  SCA_P09_REASSESSMENT_SCHEMA,
  validateScaP09GateV1,
  validateScaP09ReconciliationLedgerV1,
  validateScaP09TerminalV1,
  validateScaP09ToP10TransitionV1,
  withP09Digest,
  type ScaP09TerminalV1,
} from "../dist/sca/p09-contracts.js";
import { buildScaP09Lineage, type ScaP09LineageV1 } from "./sca-p09-lineage.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p09-playbook-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
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
  const request: StartRequest = {
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
  return request;
}
function drive(
  artifacts: ArtifactStore,
  lineage: ScaP09LineageV1,
  reassessmentRef: ArtifactRef | null = null,
  registration = SCA_P09_CANDIDATE_REGISTRATION
): { readonly run: RunContext; readonly playbook: Playbook; readonly directive: Directive } {
  const startAdmission = required(registration.start_admission, "P09 start admission");
  const request = startRequest(lineage, reassessmentRef);
  const prepared = startAdmission.prepare(request, {});
  const refs = startAdmission.materialize(prepared, {
    run_id: lineage.run_id,
    artifactStore: artifacts,
    trustedClock: () => new Date("2026-09-26T00:00:04.000Z"),
  });
  const run = context(lineage.run_id, refs);
  const playbook = registration.construct({
    artifactStore: artifacts,
    trustedClock: () => new Date("2026-09-26T00:00:04.000Z"),
  });
  const directive = playbook.initialize(run);
  return { run, playbook, directive };
}
function terminalOf(directive: Directive): ScaP09TerminalV1 {
  if (directive.action !== "incomplete") throw new Error("expected P09 terminal directive");
  return validateScaP09TerminalV1(directive.result);
}
function selectedRef(run: RunContext, kind: string): ArtifactRef {
  return required(
    [...run.selectedArtifacts].reverse().find((ref) => ref.kind === kind),
    `selected ${kind} ref`
  );
}

describe("SCA P09 incomplete closeout (absent coverage, unresolved items)", () => {
  it("emits durable non-positive accounting with explicit coverage blockers", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-incomplete",
      kinds: ["source_query", "graph_query"],
    });
    const { run, directive } = drive(artifacts, lineage);
    const terminal = terminalOf(directive);
    expect(terminal.status).toBe("incomplete_closeout");
    expect(terminal.lane).toBe("incomplete_closeout");
    expect(terminal.phase_gate_passed).toBe(false);
    expect(terminal.release_eligible).toBe(false);
    expect(terminal.campaign_complete).toBe(false);
    expect(terminal.p12_release_authorized).toBe(false);
    expect(terminal.nonterminal_campaign).toBe(true);
    expect(terminal.p10_transition_ref).not.toBeNull();
    expect(terminal.missing_downstream_artifacts).toContain(
      "penny.sca-p10-rule-learning-outcome.v1"
    );
    expect(terminal.required_downstream_obligation_ids).toContain("SCA-OBL-REPORT-RECONCILIATION");
    expect(terminal.blocker_codes).toContain("p09_coverage_input_absent");
    expect(terminal.required_result_total).toBeGreaterThan(terminal.required_result_resolved);
    // Every unreachable coverage obligation is checkpointed, never silently dropped.
    const checkpoints = run.selectedArtifacts.filter((ref) => ref.kind === "sca-p09-checkpoint");
    expect(checkpoints.length).toBe(6);
    const ledger = validateScaP09ReconciliationLedgerV1(
      JSON.parse(
        artifacts
          .readById(selectedRef(run, "sca-p09-reconciliation-ledger").artifact_id)
          .toString("utf8")
      )
    );
    expect(ledger.exhaustive_accounting).toBe(true);
    const gate = validateScaP09GateV1(
      JSON.parse(artifacts.readById(selectedRef(run, "sca-p09-gate").artifact_id).toString("utf8"))
    );
    expect(gate.verdict).toBe("pass_blocked");
    expect(gate.lane).toBe("incomplete_closeout");
    expect(gate.coverage_reconciled).toBe(false);
    expect(gate.p01_head_attested).toBe(false);
  });
});

describe("SCA P09 accepted progression", () => {
  it("requires every required result while remaining explicitly non-authorizing", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-accepted",
      kinds: ["source_query", "graph_query"],
      completed_indices: [0, 1],
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
    const { run, directive } = drive(artifacts, lineage);
    const terminal = terminalOf(directive);
    expect(terminal.status).toBe("accepted_progression");
    expect(terminal.lane).toBe("accepted_progression");
    expect(terminal.required_result_resolved).toBe(terminal.required_result_total);
    // A local readiness signal is never phase acceptance, release, or campaign completion.
    expect(terminal.phase_gate_passed).toBe(false);
    expect(terminal.release_eligible).toBe(false);
    expect(terminal.campaign_complete).toBe(false);
    const gate = validateScaP09GateV1(
      JSON.parse(artifacts.readById(selectedRef(run, "sca-p09-gate").artifact_id).toString("utf8"))
    );
    expect(gate.verdict).toBe("pass_ready");
    expect(gate.retained_required_gaps).toBe(false);
    expect(gate.blocker_codes).toEqual([]);
    const handoff = validateScaP09ToP10TransitionV1(
      JSON.parse(
        artifacts
          .readById(selectedRef(run, "sca-p09-to-p10-transition").artifact_id)
          .toString("utf8")
      )
    );
    expect(handoff.phase_gate_passed).toBe(false);
    expect(handoff.p10_rule_learning_authorized_by_this_transition).toBe(false);
    expect(handoff.required_gaps_retained).toBe(true);
    expect(handoff.eligible_refs.length).toBeGreaterThan(0);
    const eligibleIds = new Set(handoff.eligible_refs.map((ref) => ref.artifact_id));
    for (const ref of handoff.ineligible_refs) {
      expect(eligibleIds.has(ref.artifact_id)).toBe(false);
    }
  });
});

describe("SCA P09 class-integrity guard: post-failure downgrade", () => {
  it("blocks a required-result item satisfied while its P07 action was never invoked", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-downgrade",
      kinds: ["source_query"],
      completed_indices: [],
      disposition_for: () => "confirmed",
    });
    const { directive } = drive(artifacts, lineage);
    const terminal = terminalOf(directive);
    expect(terminal.status).toBe("blocked_invalid");
    expect(terminal.lane).toBeUndefined();
    expect(terminal.p10_transition_ref).toBeNull();
    expect(terminal.blocker_codes).toContain(
      "p09_post_failure_downgrade::blocked_action_satisfied"
    );
  });
});

describe("SCA P09 non-reconcilable checkpoint and cancellation", () => {
  it("admits a cancelled P08 result as accounting-only with no ledger or handoff", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-cancelled-p08",
      kinds: ["source_query"],
      cancelled: true,
    });
    const { directive, run } = drive(artifacts, lineage);
    const terminal = terminalOf(directive);
    expect(terminal.status).toBe("incomplete_closeout");
    expect(terminal.reconciliation_ledger_ref).toBeNull();
    expect(terminal.gate_ref).toBeNull();
    expect(terminal.p10_transition_ref).toBeNull();
    expect(terminal.blocker_codes).toContain("p08_cancelled_non_reconcilable_checkpoint");
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p09-reconciliation-ledger")).toBe(
      false
    );
  });

  it("records a cancelled terminal with no reconciliation or handoff", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-cancel",
      kinds: ["source_query"],
    });
    const { playbook, run } = drive(artifacts, lineage);
    const directive = playbook.cancel(run, "operator cancelled");
    if (directive.action !== "cancelled") throw new Error("expected cancelled directive");
    const terminal = validateScaP09TerminalV1(directive.result);
    expect(terminal.status).toBe("cancelled");
    expect(terminal.reconciliation_ledger_ref).toBeNull();
    expect(terminal.gate_ref).toBeNull();
    expect(terminal.p10_transition_ref).toBeNull();
    expect(terminal.blocker_codes).toEqual(["p09_cancelled"]);
  });
});

describe("SCA P09 append-only reassessment", () => {
  it("emits a versioned ledger that binds the earlier snapshot by exact ref and digest", () => {
    using artifacts = store();
    const first = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-ver-1",
      kinds: ["source_query"],
    });
    const driven1 = drive(artifacts, first);
    const ledger1Ref = selectedRef(driven1.run, "sca-p09-reconciliation-ledger");
    const ledger1 = validateScaP09ReconciliationLedgerV1(
      JSON.parse(artifacts.readById(ledger1Ref.artifact_id).toString("utf8"))
    );
    expect(ledger1.ledger_revision ?? 1).toBe(1);

    const second = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-ver-2",
      kinds: ["source_query"],
    });
    const reassessmentRef = saveReassessment(artifacts, {
      run_id: second.run_id,
      prior_ledger_ref: ledger1Ref,
      stimulus_ref: second.p08_terminal_ref,
    });
    const driven2 = drive(artifacts, second, reassessmentRef);
    const ledger2Ref = selectedRef(driven2.run, "sca-p09-reconciliation-ledger");
    const ledger2 = validateScaP09ReconciliationLedgerV1(
      JSON.parse(artifacts.readById(ledger2Ref.artifact_id).toString("utf8"))
    );
    expect(ledger2.ledger_revision).toBe(2);
    expect(ledger2.append_only).toBe(true);
    expect(ledger2.prior_p09_ledger_ref?.artifact_id).toBe(ledger1Ref.artifact_id);
    expect(ledger2.prior_p09_ledger_sha256).toBe(ledger1Ref.content_digest);
    expect(ledger2Ref.operation_id).not.toBe(ledger1Ref.operation_id);
  });
});

describe("SCA P09 idempotent recovery", () => {
  it("converges on the same exact artifacts for duplicate delivery of one run", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-idempotent",
      kinds: ["source_query"],
    });
    const first = drive(artifacts, lineage);
    const second = drive(artifacts, lineage);
    expect(selectedRef(second.run, "sca-p09-reconciliation-ledger").artifact_id).toBe(
      selectedRef(first.run, "sca-p09-reconciliation-ledger").artifact_id
    );
    expect(selectedRef(second.run, "sca-p09-gate").artifact_id).toBe(
      selectedRef(first.run, "sca-p09-gate").artifact_id
    );
    expect(selectedRef(second.run, "sca-p09-terminal").artifact_id).toBe(
      selectedRef(first.run, "sca-p09-terminal").artifact_id
    );
    expect(terminalOf(second.directive)).toEqual(terminalOf(first.directive));
  });
});

describe("SCA P09 model-free, tool-free, host-only authority", () => {
  it("declares no worker phase, host operation, or provider guard and emits no dispatch", () => {
    const registration = SCA_P09_CANDIDATE_REGISTRATION;
    expect(registration.worker.kind).toBe("none");
    expect(registration.worker.phases.size).toBe(0);
    expect(registration.host_operations).toBeUndefined();
    expect(registration.contract.io.request.schema_id).toBe(SCA_P09_START_V1_SCHEMA);
    expect(registration.contract.io.input_ports).toEqual([]);
    for (const port of registration.contract.io.active_output_ports) {
      expect(port.direction).toBe("output");
    }
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-model-free",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = drive(artifacts, lineage);
    expect(["incomplete", "cancelled"]).toContain(directive.action);
    expect(playbook.rebindPendingDirective(run)).not.toBeNull();
    expect(run.stateId).toBe(SCA_P09_FINAL_STATE);
  });

  it("attests the P01 obligation-ledger head only with independent production resolvers", () => {
    using artifacts = store();
    const lineage = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-attested",
      kinds: ["source_query"],
    });
    const registration = createScaP09CandidateRegistrationV1({
      resolve_current_p07_authority_ref: () => lineage.p07_authority_ref,
      resolve_current_p01_obligation_head_ref: () => lineage.p01_obligation_ledger_ref,
    });
    const { run, directive } = drive(artifacts, lineage, null, registration);
    const terminal = terminalOf(directive);
    const gate = validateScaP09GateV1(
      JSON.parse(
        artifacts
          .readById(
            required(
              [...run.selectedArtifacts].reverse().find((ref) => ref.kind === "sca-p09-gate"),
              "gate ref"
            ).artifact_id
          )
          .toString("utf8")
      )
    );
    expect(gate.p01_head_attested).toBe(true);
    expect(terminal.status).toBe("incomplete_closeout");
  });

  it("derives the gate's P08 authority truth from the recorded admission, not a mere resolver", () => {
    using artifacts = store();
    const attested = buildScaP09Lineage({
      store: artifacts,
      run_id: "run-p09-attested-p08",
      kinds: ["source_query"],
      attest_p07_authority: true,
    });
    const registration = createScaP09CandidateRegistrationV1({
      resolve_current_p07_authority_ref: () => attested.p07_authority_ref,
      resolve_current_p01_obligation_head_ref: () => attested.p01_obligation_ledger_ref,
    });
    const { run } = drive(artifacts, attested, null, registration);
    const gate = validateScaP09GateV1(
      JSON.parse(artifacts.readById(selectedRef(run, "sca-p09-gate").artifact_id).toString("utf8"))
    );
    expect(gate.p08_authority_attested).toBe(true);
    expect(gate.p01_head_attested).toBe(true);
  });
});

describe("SCA P09 inactive registration proof", () => {
  it("stays absent from every active registry and changes no public playbook", () => {
    expect(SCA_P09_CANDIDATE_REGISTRATION.name).toBe("sca-p09-candidate");
    expect(SCA_PHASE_REGISTRY.has("sca-p09-candidate")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("sca-p09-candidate")).toBe(false);
    expect([...PLAYBOOK_REGISTRY.keys()]).not.toContain("sca-p09-candidate");
    expect(validateRegistrationContract(SCA_P09_CANDIDATE_REGISTRATION)).toBe(
      SCA_P09_CANDIDATE_REGISTRATION.contract
    );
    expect(SCA_P09_CANDIDATE_REGISTRATION.host_states).toEqual([
      "sca_p09_reconciling",
      "sca_p09_finalizing",
    ]);
  });
});

/** Host-issued P09 reassessment over an earlier ledger; no model, tool, or host operation. */
function saveReassessment(
  artifacts: ArtifactStore,
  input: {
    readonly run_id: string;
    readonly prior_ledger_ref: ArtifactRef;
    readonly stimulus_ref: ArtifactRef;
  }
): ArtifactRef {
  const value = withP09Digest(
    {
      schema_id: SCA_P09_REASSESSMENT_SCHEMA,
      schema_version: 1,
      phase_id: "SCA-P09",
      run_id: input.run_id,
      prior_p09_ledger_ref: input.prior_ledger_ref,
      prior_p09_ledger_sha256: input.prior_ledger_ref.content_digest,
      trigger_codes: ["new_evidence"],
      stimulus_refs: [input.stimulus_ref],
      invalidated_evidence_refs: [],
    },
    "reassessment_sha256"
  );
  return artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: input.run_id,
      phase: "SCA-P09",
      branch_id: null,
      kind: "sca-p09-reassessment",
      operation_id: "sca-p09-reassessment",
      version: 1,
      producer: "host:sca-p09-lineage",
      media_type: "application/json",
      content_schema: { schema_id: SCA_P09_REASSESSMENT_SCHEMA, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [input.prior_ledger_ref, input.stimulus_ref],
    },
    content: canonicalJson(value),
  });
}
