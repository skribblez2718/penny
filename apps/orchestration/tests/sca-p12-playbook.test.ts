import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef, RunIdentity } from "../dist/contracts.js";
import { PLAYBOOK_REGISTRY } from "../dist/playbooks/registry.js";
import { SCA_PHASE_REGISTRY } from "../dist/sca/phase-registry.js";
import {
  SCA_P12_CANDIDATE_PLAYBOOK_NAME,
  SCA_P12_TERMINAL_SCHEMA,
  validateScaP12PhaseGateIndexV1,
  validateScaP12TerminalV1,
} from "../dist/sca/p12-contracts.js";
import { buildScaP12TerminalV1, evaluateScaP12PhaseGateIndexV1 } from "../dist/sca/p12-release.js";
import {
  SCA_P12_CANDIDATE_REGISTRATION,
  scaP12TerminalDirective,
} from "../dist/sca/p12-playbook.js";
import { asTerminalDirective, buildScaP12Lineage, prepareP12 } from "./sca-p12-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function makeStore(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p12-playbook-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function fakeRef(n: number): ArtifactRef {
  const digest = String(n).padStart(64, "c");
  return {
    schema_version: 2 as const,
    artifact_id: `art_${String(n).padStart(64, "d")}`,
    run_id: "run-p12-positive",
    phase: "SCA-P12",
    branch_id: null,
    kind: "sca-p12-release-record",
    operation_id: `op-${n}`,
    version: 1,
    producer: "host:test",
    media_type: "application/json",
    content_schema: { schema_id: SCA_P12_TERMINAL_SCHEMA, schema_version: 1 },
    byte_length: 1,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

describe("inactive SCA P12 candidate playbook", () => {
  it("is absent from the active phase and playbook registries", () => {
    expect(SCA_PHASE_REGISTRY.has(SCA_P12_CANDIDATE_PLAYBOOK_NAME)).toBe(false);
    expect(PLAYBOOK_REGISTRY.has(SCA_P12_CANDIDATE_PLAYBOOK_NAME)).toBe(false);
    expect([...PLAYBOOK_REGISTRY.keys()]).not.toContain(SCA_P12_CANDIDATE_PLAYBOOK_NAME);
    expect(SCA_P12_CANDIDATE_REGISTRATION.name).toBe(SCA_P12_CANDIDATE_PLAYBOOK_NAME);
    expect(SCA_P12_CANDIDATE_REGISTRATION.worker.kind).toBe("none");
  });

  it("never releases a synthetic reporting_complete lineage; synthetic gates fail closed", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-p12-release",
      lane: "reporting_complete",
    });
    const harness = prepareP12({ store, runId: "run-p12-release", lineage });
    const terminal = asTerminalDirective(harness.playbook.initialize(harness.run));
    const parsed = validateScaP12TerminalV1(terminal.result);
    expect(parsed.status).toBe("verification_incomplete");
    expect(parsed.status).not.toBe("released_complete");
    expect(parsed.campaign_complete).toBe(false);
    expect(parsed.release_eligible).toBe(false);
    expect(terminal.action).toBe("incomplete");
    expect(terminal.met).toBe(false);
    expect(parsed.blocker_codes.some((code) => code.startsWith("p12_phase_gate"))).toBe(true);
  });

  it("re-verifies each AC-Pnn gate with verifyScaPhaseGateV3; self-sealed gates fail closed", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-p12-phasegate",
      lane: "reporting_complete",
    });
    const index = validateScaP12PhaseGateIndexV1(
      JSON.parse(store.readById(lineage.phase_gate_index_ref.artifact_id).toString("utf8"))
    );
    // No host-supplied qualification definition: every self-sealed gate is unverifiable and the
    // index fails closed (the strong `verifyScaPhaseGateV3` path never trusts wire shape alone).
    const noDefinitions = evaluateScaP12PhaseGateIndexV1({ store, index });
    expect(noDefinitions.complete).toBe(false);
    expect(noDefinitions.blocker_codes).toContain("p12_phase_gate_definition_absent_sca-p01");
    expect(noDefinitions.derived_exclusions.identity_ids).toEqual([]);
  });

  it("projects a released_complete terminal into a positive completion directive (guarded facts)", () => {
    const identity: RunIdentity = {
      schema_version: 2,
      run_id: "run-p12-positive",
      session_id: "session-p12-positive",
      playbook: SCA_P12_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    };
    const reportRef = fakeRef(1);
    const releasedComplete = buildScaP12TerminalV1({
      status: "released_complete",
      lane: "accepted_progression",
      release_record_ref: fakeRef(2),
      gate_ref: fakeRef(3),
      release_approval_ref: fakeRef(4),
      p11_terminal_ref: fakeRef(5),
      report_ref: reportRef,
      campaign_complete: true,
      release_eligible: true,
      incomplete_marker: null,
      selected_artifact_refs: [],
      blocker_codes: [],
    });
    const positive = scaP12TerminalDirective({
      identity,
      terminal: releasedComplete,
      artifacts: [],
      unresolved: [],
    });
    expect(positive.action).toBe("complete");
    expect(positive.status).toBe("complete");
    expect(positive.met).toBe(true);
    expect(positive.unresolved).toEqual([]);

    const incomplete = buildScaP12TerminalV1({
      status: "verification_incomplete",
      lane: "accepted_progression",
      release_record_ref: null,
      gate_ref: null,
      release_approval_ref: null,
      p11_terminal_ref: fakeRef(5),
      report_ref: reportRef,
      campaign_complete: false,
      release_eligible: false,
      incomplete_marker: "⚠ INCOMPLETE — missing: p12_phase_gate_index_incomplete",
      selected_artifact_refs: [],
      blocker_codes: ["p12_phase_gate_index_incomplete"],
    });
    const nonPositive = scaP12TerminalDirective({
      identity,
      terminal: incomplete,
      artifacts: [],
      unresolved: incomplete.blocker_codes,
    });
    expect(nonPositive.action).toBe("incomplete");
    expect(nonPositive.status).toBe("incomplete");
    expect(nonPositive.met).toBe(false);
    expect(nonPositive.unresolved).toEqual(["p12_phase_gate_index_incomplete"]);
  });

  it("refuses to reach the human gate from synthetic lineage (no release_refused)", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-p12-refused",
      lane: "reporting_complete",
    });
    const harness = prepareP12({ store, runId: "run-p12-refused", lineage });
    const terminal = asTerminalDirective(harness.playbook.initialize(harness.run));
    const parsed = validateScaP12TerminalV1(terminal.result);
    expect(parsed.status).toBe("verification_incomplete");
    expect(parsed.release_eligible).toBe(false);
    expect(parsed.campaign_complete).toBe(false);
  });

  it("never releases a reporting_incomplete P11 lane", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-p12-incomplete",
      lane: "reporting_incomplete",
    });
    const harness = prepareP12({ store, runId: "run-p12-incomplete", lineage });
    const terminal = asTerminalDirective(harness.playbook.initialize(harness.run));
    const parsed = validateScaP12TerminalV1(terminal.result);
    expect(parsed.status).toBe("verification_incomplete");
    expect(parsed.release_eligible).toBe(false);
    expect(parsed.campaign_complete).toBe(false);
    expect(parsed.incomplete_marker ?? "").toContain("⚠ INCOMPLETE — missing:");
    expect(terminal.artifacts.some((ref) => ref.kind === "sca-p12-checkpoint")).toBe(true);
  });

  it("blocks a non-reportable P11 terminal with durable accounting", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-p12-blocked",
      lane: "blocked_invalid",
    });
    const harness = prepareP12({ store, runId: "run-p12-blocked", lineage });
    const terminal = asTerminalDirective(harness.playbook.initialize(harness.run));
    const parsed = validateScaP12TerminalV1(terminal.result);
    expect(parsed.status).toBe("blocked_invalid");
    expect(parsed.release_eligible).toBe(false);
    expect(parsed.missing_downstream_artifacts.length).toBeGreaterThan(0);
    expect(parsed.required_downstream_obligation_ids.length).toBeGreaterThan(0);
  });

  it("maps a P11 cancelled terminal to a durable P12 cancelled terminal", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-p12-p11cancel",
      lane: "cancelled",
    });
    const harness = prepareP12({ store, runId: "run-p12-p11cancel", lineage });
    const terminal = asTerminalDirective(harness.playbook.initialize(harness.run));
    const parsed = validateScaP12TerminalV1(terminal.result);
    expect(parsed.status).toBe("cancelled");
    expect(parsed.release_record_ref).toBeNull();
    expect(parsed.gate_ref).toBeNull();
    expect(parsed.release_approval_ref).toBeNull();
    expect(parsed.blocker_codes).toContain("p11_cancelled_non_reportable");
    expect(terminal.action).toBe("incomplete");
    expect(terminal.met).toBe(false);
  });

  it("is permanently non-positive under the provider-free compatibility fixture", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-p12-fixture",
      lane: "reporting_complete",
    });
    const harness = prepareP12({ store, runId: "run-p12-fixture", lineage, binding: {} });
    const terminal = asTerminalDirective(harness.playbook.initialize(harness.run));
    const parsed = validateScaP12TerminalV1(terminal.result);
    expect(parsed.status).not.toBe("released_complete");
    expect(parsed.release_eligible).toBe(false);
    expect(parsed.campaign_complete).toBe(false);
  });

  it("cancels durably without any release state", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-p12-cancel",
      lane: "reporting_complete",
    });
    const harness = prepareP12({ store, runId: "run-p12-cancel", lineage });
    harness.playbook.initialize(harness.run);
    const terminal = asTerminalDirective(
      harness.playbook.cancel(harness.run, "operator cancelled")
    );
    const parsed = validateScaP12TerminalV1(terminal.result);
    expect(parsed.status).toBe("cancelled");
    expect(parsed.release_record_ref).toBeNull();
    expect(parsed.gate_ref).toBeNull();
    expect(parsed.blocker_codes).toContain("p12_cancelled");
  });

  it("re-binds the persisted terminal byte-identically on restart with no duplicate artifacts", () => {
    const store = makeStore();
    const lineage = buildScaP12Lineage({
      store,
      run_id: "run-p12-restart",
      lane: "reporting_complete",
    });
    const harness = prepareP12({ store, runId: "run-p12-restart", lineage });
    const first = asTerminalDirective(harness.playbook.initialize(harness.run));
    harness.run.pendingDirective = null;
    const rebound = asTerminalDirective(harness.playbook.dispatch(harness.run));
    expect(canonicalJson(rebound.result)).toBe(canonicalJson(first.result));
    expect(rebound.action).toBe("incomplete");
    const terminals = harness.run.selectedArtifacts.filter(
      (ref) => ref.kind === "sca-p12-terminal"
    );
    expect(new Set(terminals.map((ref) => ref.artifact_id)).size).toBe(1);
  });
});
