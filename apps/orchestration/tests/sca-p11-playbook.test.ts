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
import { PLAYBOOK_REGISTRY, validateRegistrationContract } from "../dist/playbooks/registry.js";
import { SCA_PHASE_REGISTRY } from "../dist/sca/phase-registry.js";
import {
  SCA_P11_CANDIDATE_PLAYBOOK_NAME,
  ScaP11CandidatePlaybook,
  buildScaP11CandidateRegistrationWithBindingV1,
} from "../dist/sca/p11-playbook.js";
import {
  SCA_P11_REVIEWING_STATE,
  validateScaP11CognitivePayloadV1,
  validateScaP11GateV1,
  validateScaP11ReportJsonV1,
  validateScaP11ReportSarifV1,
  validateScaP11ReportV1,
  validateScaP11SemanticReviewV1,
  validateScaP11TerminalV1,
  validateScaP11ToP12TransitionV1,
  validateScaP11ValidationRecordsV1,
} from "../dist/sca/p11-contracts.js";
import { SCA_P11_QUALIFIED_CVSS_FIXTURE } from "../dist/sca/p11-scoring.js";
import {
  buildScaP11Lineage,
  slotsForP11,
  stubScaP11ReviewOutput,
  P11_PROJECT_ROOT,
} from "./sca-p11-lineage.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p11-playbook-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
function selectedRef(run: RunContext, kind: string): ArtifactRef {
  return required(
    [...run.selectedArtifacts].reverse().find((ref) => ref.kind === kind),
    `selected ${kind}`
  );
}
function readObject(artifacts: ArtifactStore, ref: ArtifactRef): unknown {
  return JSON.parse(artifacts.readById(ref.artifact_id).toString("utf8"));
}

interface Harness {
  readonly artifacts: ArtifactStore;
  readonly run: RunContext;
  readonly playbook: ScaP11CandidatePlaybook;
}

function prepare(input: {
  readonly runId: string;
  readonly reportPolicyComplete: boolean;
  readonly p10Status?: "learning_complete" | "learning_incomplete";
  readonly scorer: boolean;
}): Harness {
  const artifacts = store();
  const lineage = buildScaP11Lineage({
    store: artifacts,
    run_id: input.runId,
    confirmed: true,
    accepted: true,
    report_policy_complete: input.reportPolicyComplete,
    ...(input.p10Status === undefined ? {} : { p10_status: input.p10Status }),
  });
  const registration = buildScaP11CandidateRegistrationWithBindingV1(
    input.scorer ? { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE } : {}
  );
  const startAdmission = required(registration.start_admission, "P11 start admission");
  const constraints = lineage.constraints;
  const request: StartRequest = {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: `session-${input.runId}`,
      playbook: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise inactive P11.",
    constraints,
    project_root: P11_PROJECT_ROOT,
    trust_profile: "hardened-untrusted",
    input_artifacts: { schema_version: 2, artifacts: slotsForP11(constraints) },
  };
  const prepared = startAdmission.prepare(request, {});
  const refs = startAdmission.materialize(prepared, {
    run_id: input.runId,
    artifactStore: artifacts,
    trustedClock: () => new Date("2026-10-02T00:00:06.000Z"),
  });
  const run = RunContext.create({
    identity: request.identity,
    goal: request.goal,
    constraints: {},
    projectRoot: P11_PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
    initialArtifacts: refs,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
      contract_sha256: "b".repeat(64),
      registration_sha256: "a".repeat(64),
    },
  });
  const playbook = new ScaP11CandidatePlaybook(
    artifacts,
    input.scorer ? { scorer: SCA_P11_QUALIFIED_CVSS_FIXTURE } : {},
    () => new Date("2026-10-02T00:00:06.000Z")
  );
  return { artifacts, run, playbook };
}

/** Answer the single review call with a stub reviewer, then return the terminal directive. */
function runToTerminal(input: {
  readonly harness: Harness;
  readonly directive: Directive;
}): ReturnType<typeof validateScaP11TerminalV1> {
  const { artifacts, run, playbook } = input.harness;
  let directive = input.directive;
  if (directive.action !== "invoke_agent" || directive.state_id !== SCA_P11_REVIEWING_STATE) {
    throw new Error("SCA P11 did not open with the review call");
  }
  const reportRef = selectedRef(run, "sca-p11-report-json");
  const payloadRef = selectedRef(run, "sca-p11-cognitive-payload");
  const payload = validateScaP11CognitivePayloadV1(readObject(artifacts, payloadRef));
  const review = stubScaP11ReviewOutput({
    run_id: run.identity.run_id,
    report_ref: reportRef,
    payload,
  });
  validateScaP11SemanticReviewV1(review);
  run.pendingDirective = null;
  directive = playbook.acceptSummary(run, review, "CERTAIN");
  if (directive.action !== "incomplete") throw new Error("SCA P11 did not reach a terminal");
  return validateScaP11TerminalV1(directive.result);
}

describe("SCA P11 reporting candidate", () => {
  it("derives a complete report set, gate, and non-authorizing handoff through the provider-free fixture", () => {
    const runId = "run-p11-complete";
    const harness = prepare({ runId, reportPolicyComplete: true, scorer: true });
    const terminal = runToTerminal({
      harness,
      directive: harness.playbook.initialize(harness.run),
    });
    expect(terminal.status).toBe("reporting_complete");
    for (const literal of [
      terminal.phase_gate_passed,
      terminal.release_eligible,
      terminal.campaign_complete,
      terminal.p12_release_authorized,
      terminal.release_adjudication_performed,
    ]) {
      expect(literal).toBe(false);
    }
    expect(terminal.nonterminal_campaign).toBe(true);
    expect(terminal.report_status).toBe("complete");

    const gate = validateScaP11GateV1(
      readObject(harness.artifacts, selectedRef(harness.run, "sca-p11-gate"))
    );
    expect(gate.verdict).toBe("pass_ready");

    const handoff = validateScaP11ToP12TransitionV1(
      readObject(harness.artifacts, selectedRef(harness.run, "sca-p11-to-p12-transition"))
    );
    expect(handoff.p12_release_authorized_by_this_transition).toBe(false);
    expect(handoff.release_eligible).toBe(false);
    expect(handoff.campaign_complete).toBe(false);
    expect(handoff.campaign_completion_claimed).toBe(false);
    expect(handoff.required_gaps_retained).toBe(true);

    // One accepted set, three representations, identical findings.
    const report = validateScaP11ReportJsonV1(
      readObject(harness.artifacts, selectedRef(harness.run, "sca-p11-report-json"))
    );
    const sarif = validateScaP11ReportSarifV1(
      readObject(harness.artifacts, selectedRef(harness.run, "sca-p11-report-sarif"))
    );
    const markdown = harness.artifacts
      .readById(selectedRef(harness.run, "sca-p11-report-markdown").artifact_id)
      .toString("utf8");
    const jsonIds = report.findings.map((finding) => finding.finding_id).sort();
    const sarifIds = sarif.results.map((result) => result.finding_id).sort();
    const markdownIds = [...markdown.matchAll(/^### (sca11find_[a-f0-9]{64}) — /gmu)]
      .map((match) => match[1] ?? "")
      .sort();
    expect(sarifIds).toEqual(jsonIds);
    expect(markdownIds).toEqual(jsonIds);
    expect(jsonIds.length).toBeGreaterThan(0);

    const validation = validateScaP11ValidationRecordsV1(
      readObject(harness.artifacts, selectedRef(harness.run, "sca-p11-validation-records"))
    );
    expect(validation.deterministic_passed).toBe(true);
    expect(validation.semantic_passed).toBe(true);
    const projection = validateScaP11ReportV1(
      readObject(harness.artifacts, selectedRef(harness.run, "sca-p11-report"))
    );
    expect(projection.status).toBe("complete");
  });

  it("retains an honest incomplete report when the content authority omits a finding", () => {
    const runId = "run-p11-incomplete";
    const harness = prepare({ runId, reportPolicyComplete: false, scorer: true });
    const terminal = runToTerminal({
      harness,
      directive: harness.playbook.initialize(harness.run),
    });
    expect(terminal.status).toBe("reporting_incomplete");
    expect(terminal.report_status).toBe("incomplete");
    const gate = validateScaP11GateV1(
      readObject(harness.artifacts, selectedRef(harness.run, "sca-p11-gate"))
    );
    expect(gate.verdict).toBe("pass_blocked");
    const report = validateScaP11ReportJsonV1(
      readObject(harness.artifacts, selectedRef(harness.run, "sca-p11-report-json"))
    );
    expect(report.status).toBe("incomplete");
    expect(report.missing_sections.length).toBeGreaterThan(0);
  });

  it("refuses a non-reportable P10 checkpoint without fabricating a report", () => {
    const runId = "run-p11-nonreportable";
    const artifacts = store();
    const lineage = buildScaP11Lineage({
      store: artifacts,
      run_id: runId,
      confirmed: true,
      accepted: true,
      report_policy_complete: true,
    });
    const cancelledTerminal = {
      schema_id: "penny.sca-p10-terminal.v1",
      schema_version: 1,
      phase_id: "SCA-P10",
      status: "cancelled",
      learning_outcome_ref: null,
      gate_ref: null,
      p11_transition_ref: null,
      p11_handoff_ready: false,
      eligibility_ledger_ref: null,
      promotion_performed: false,
      promotion_receipt_ref: null,
      outcome_disposition: null,
      eligible_refs: [],
      ineligible_refs: [],
      missing_downstream_artifacts: ["penny.sca-p11-report.v1"],
      required_downstream_obligation_ids: ["SCA-OBL-P11-ACCEPTANCE"],
      selected_artifact_refs: [],
      blocker_codes: ["p10_cancelled"],
      phase_gate_passed: false,
      release_eligible: false,
      campaign_complete: false,
      nonterminal_campaign: true,
      p12_release_authorized: false,
      report_or_release_adjudication_performed: false,
      terminal_sha256: "0".repeat(64),
    };
    const body = Object.fromEntries(
      Object.entries(cancelledTerminal).filter(([key]) => key !== "terminal_sha256")
    );
    const value = { ...body, terminal_sha256: sha256(canonicalJson(body)) };
    const metadata: OutputArtifactMetadata = {
      schema_version: 2,
      run_id: runId,
      phase: "SCA-P10",
      branch_id: null,
      kind: "sca-p10-terminal",
      operation_id: "sca-p11-nonreportable-terminal",
      version: 1,
      producer: "host:sca-p11-lineage",
      media_type: "application/json",
      content_schema: { schema_id: "penny.sca-p10-terminal.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    };
    const cancelledRef = artifacts.persist({ metadata, content: canonicalJson(value) });
    const constraints = { ...lineage.constraints, p10_terminal_ref: cancelledRef };
    const registration = buildScaP11CandidateRegistrationWithBindingV1({});
    const startAdmission = required(registration.start_admission, "P11 start admission");
    const startRequest: StartRequest = {
      schema_version: 2,
      action: "start",
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: `session-${runId}`,
        playbook: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      goal: "Exercise inactive P11 non-reportable lane.",
      constraints,
      project_root: P11_PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
      input_artifacts: {
        schema_version: 2,
        artifacts: slotsForP11(constraints),
      },
    };
    const prepared = startAdmission.prepare(startRequest, {});
    const refs = startAdmission.materialize(prepared, {
      run_id: runId,
      artifactStore: artifacts,
      trustedClock: () => new Date("2026-10-02T00:00:06.000Z"),
    });
    const run = RunContext.create({
      identity: startRequest.identity,
      goal: startRequest.goal,
      constraints: {},
      projectRoot: P11_PROJECT_ROOT,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
      initialArtifacts: refs,
    });
    const playbook = new ScaP11CandidatePlaybook(artifacts, {});
    const directive = playbook.initialize(run);
    if (directive.action !== "incomplete") throw new Error("expected a non-positive terminal");
    const terminal = validateScaP11TerminalV1(directive.result);
    expect(terminal.status).toBe("blocked_invalid");
    expect(terminal.report_ref).toBeNull();
    expect(terminal.p12_transition_ref).toBeNull();
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p11-report-json")).toBe(false);
  });

  it("is absent from every active and public registry", () => {
    expect(SCA_PHASE_REGISTRY.has(SCA_P11_CANDIDATE_PLAYBOOK_NAME)).toBe(false);
    expect(PLAYBOOK_REGISTRY.has(SCA_P11_CANDIDATE_PLAYBOOK_NAME)).toBe(false);
    const registration = buildScaP11CandidateRegistrationWithBindingV1({});
    validateRegistrationContract(registration);
    expect(registration.name).toBe(SCA_P11_CANDIDATE_PLAYBOOK_NAME);
  });
});
