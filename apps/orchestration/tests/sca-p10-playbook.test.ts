import {
  scaP10NativeAggregateDigests,
  scaP10NativeCaseV1,
  scaP10NativeCollectionComplete,
  scaP10NativeCollectionExit,
  type ScaP10NativeCollectionV1,
} from "../dist/sca/p10-native-tests.js";
import { scaP10RuleValidationArguments } from "../dist/sca/p10-validation.js";
import { deriveScaP10PerformanceCaseV1 } from "../dist/sca/p10-contracts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type {
  ArtifactRef,
  Directive,
  JsonValue,
  OutputArtifactMetadata,
  StartRequest,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { PLAYBOOK_REGISTRY, validateRegistrationContract } from "../dist/playbooks/registry.js";
import { SCA_PHASE_REGISTRY } from "../dist/sca/phase-registry.js";
import {
  SCA_P10_CANDIDATE_PLAYBOOK_NAME,
  SCA_P10_CANDIDATE_REGISTRATION,
  ScaP10CandidatePlaybook,
  type ScaP10HostOperationJournalV1,
} from "../dist/sca/p10-playbook.js";
import {
  SCA_P10_FINAL_STATE,
  SCA_P10_PROPOSING_STATE,
  SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA,
  SCA_P10_RULE_VALIDATION_OPERATION_KIND,
  SCA_P10_RULE_VALIDATION_RESULTS_SCHEMA,
  SCA_P10_VALIDATION_CASE_CLASSES,
  validateScaP10CognitivePayloadV1,
  validateScaP10GateV1,
  validateScaP10RuleCandidateProposalV1,
  validateScaP10RuleCandidateRegistryV1,
  validateScaP10RuleLearningOutcomeV1,
  validateScaP10RulePromotionDecisionsV1,
  validateScaP10RuleValidationResultsV1,
  validateScaP10TerminalV1,
  validateScaP10ToP11TransitionV1,
  type ScaP10TerminalV1,
  type ScaP10ValidationCaseClassV1,
} from "../dist/sca/p10-contracts.js";
import {
  SCA_P10_RULE_VALIDATION_REQUEST_KIND,
  SCA_P10_RULE_VALIDATION_RESULT_KIND,
  validateScaP10RuleValidationAdapterResultV1,
  validateScaP10RuleValidationRequestV1,
} from "../dist/sca/p10-validation.js";
import {
  ScaRulePromotionStore,
  createArtifactScaRulePromotionBackendV1,
} from "../dist/sca/p10-promotion.js";
import { buildScaP09Lineage } from "./sca-p09-lineage.js";
import { buildScaP10Lineage, driveScaP09 } from "./sca-p10-lineage.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p10-playbook-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}

const COVERAGE_FULL: NonNullable<Parameters<typeof buildScaP09Lineage>[0]["coverage"]> = {
  entries: [
    { surface_kind: "normalized_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "graph_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "p04_selected_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "omitted_surface", coverage_state: "omitted", reason: "no omission candidate" },
  ],
};

/** Minimal mutable fake of the durable host-operation journal projection P10 resolves results from. */
interface FakeJournalRecord {
  readonly state_id: string;
  readonly operation_id: string;
  readonly request_ref: ArtifactRef;
  readonly operation_result_ref: ArtifactRef | null;
  readonly disposition: {
    readonly outcome: "completed";
    readonly remote_disposition: "proven_terminal";
    readonly lease_disposition: "released";
    readonly retryable: false;
    readonly reason_code: null;
  };
}
function fakeJournal(): FakeJournal {
  const records: FakeJournalRecord[] = [];
  return { records, journal: { hostOperationCallsForRun: () => records } };
}
interface FakeJournal {
  readonly records: FakeJournalRecord[];
  readonly journal: ScaP10HostOperationJournalV1;
}

interface Prepared {
  readonly artifacts: ArtifactStore;
  readonly run: RunContext;
  readonly playbook: ScaP10CandidatePlaybook;
  readonly journal: FakeJournal;
}

function prepare(input: {
  readonly runId: string;
  readonly confirmed: boolean;
  readonly accepted: boolean;
  readonly kinds?: readonly ("source_query" | "graph_query" | "application_test")[];
}): Prepared {
  const artifacts = store();
  const kinds = input.kinds ?? (["source_query"] as const);
  const p09 = buildScaP09Lineage({
    store: artifacts,
    run_id: input.runId,
    kinds,
    completed_indices: kinds.map((_, index) => index),
    disposition_for: () => (input.confirmed ? "confirmed" : "inconclusive"),
    repository_location_for: () => ({ path: "src/example.php", line_start: 10, line_end: 12 }),
    ...(input.accepted ? { resolutions: "all_due" as const, coverage: COVERAGE_FULL } : {}),
  });
  const result = driveScaP09({ store: artifacts, p09 });
  const lineage = buildScaP10Lineage({
    store: artifacts,
    p09,
    p09_result: result,
    baseline_languages: ["php"],
  });
  const registration = SCA_P10_CANDIDATE_REGISTRATION;
  const startAdmission = required(registration.start_admission, "P10 start admission");
  const constraints = lineage.constraints;
  const slots: { slot: string; ref: ArtifactRef }[] = [];
  const push = (slot: string, ref: ArtifactRef | null | undefined): void => {
    if (ref !== null && ref !== undefined) slots.push({ slot, ref });
  };
  push("p09_terminal", constraints.p09_terminal_ref);
  push("p09_transition", constraints.p09_transition_ref);
  push("p09_reconciliation_ledger", constraints.p09_reconciliation_ledger_ref);
  push("p09_gate", constraints.p09_gate_ref);
  push("p09_admission", constraints.p09_admission_ref);
  push("p08_terminal", constraints.p08_terminal_ref);
  push("p08_transition", constraints.p08_transition_ref);
  push("p08_evidence_ledger", constraints.p08_evidence_ledger_ref);
  push("p08_gate", constraints.p08_gate_ref);
  push("p08_admission", constraints.p08_admission_ref);
  push("p08_item_universe", constraints.p08_item_universe_ref);
  push("p01_obligation_ledger", constraints.p01_obligation_ledger_ref);
  push("p09_coverage_input", constraints.p09_coverage_input_ref);
  constraints.p09_phase_evidence_refs.forEach((ref, index) => {
    push(`p09_phase_evidence_${String(index).padStart(4, "0")}`, ref);
  });
  push("p09_obligation_resolution", constraints.p09_obligation_resolution_ref);
  push("baseline_evidence", constraints.baseline_evidence_ref);
  push("disclosure_scope", constraints.disclosure_scope_ref);
  push("promotion_authority", constraints.promotion_authority_ref);
  push("p10_reassessment", constraints.p10_reassessment_ref);
  push("p10_prior_ledger", constraints.p10_prior_ledger_ref);
  const request: StartRequest = {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: input.runId,
      session_id: `session-${input.runId}`,
      playbook: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise inactive P10.",
    constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted",
    input_artifacts: { schema_version: 2, artifacts: slots },
  };
  const prepared = startAdmission.prepare(request, {});
  const refs = startAdmission.materialize(prepared, {
    run_id: input.runId,
    artifactStore: artifacts,
    trustedClock: () => new Date("2026-09-26T00:00:06.000Z"),
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
  const journal = fakeJournal();
  const playbook = new ScaP10CandidatePlaybook(
    artifacts,
    {
      rule_validation_runtime: {
        executable: "/synthetic/semgrep",
        executable_sha256: sha256("synthetic"),
        fixed_arguments: [],
        tool_version: "synthetic",
      },
    },
    () => new Date("2026-09-26T00:00:06.000Z"),
    journal.journal
  );
  return { artifacts, run, playbook, journal };
}

function selectedRef(run: RunContext, kind: string): ArtifactRef {
  return required(
    [...run.selectedArtifacts].reverse().find((ref) => ref.kind === kind),
    `selected ${kind} ref`
  );
}
function readObject(artifacts: ArtifactStore, ref: ArtifactRef): unknown {
  return JSON.parse(artifacts.readById(ref.artifact_id).toString("utf8"));
}
/** Read the durable promotion store projection for a test run. */
function promotionHead(artifacts: ArtifactStore, runId: string): ScaRulePromotionStore {
  return new ScaRulePromotionStore({
    backend: createArtifactScaRulePromotionBackendV1({ store: artifacts, runId, phase: "SCA-P10" }),
    store: artifacts,
    runId,
    phase: "SCA-P10",
  });
}
function terminalOf(directive: {
  readonly action: string;
  readonly result?: unknown;
}): ScaP10TerminalV1 {
  if (directive.action !== "incomplete") throw new Error("expected P10 terminal directive");
  return validateScaP10TerminalV1(directive.result);
}

/**
 * Drive the real playbook through every pending host validation in registry order, fabricating one
 * exact host result per candidate, until it reaches a terminal directive.
 */
function driveCandidates(input: {
  readonly artifacts: ArtifactStore;
  readonly run: RunContext;
  readonly playbook: ScaP10CandidatePlaybook;
  readonly journal: FakeJournal;
  readonly registry: ReturnType<typeof validateScaP10RuleCandidateRegistryV1>;
  readonly initial: Directive;
  readonly optionsFor?: (candidateId: string) => { readonly failVulnerable?: boolean };
}): Directive {
  const done = new Set<string>();
  let directive = input.initial;
  while (directive.action === "invoke_host_operation") {
    const next = input.registry.candidates.find((candidate) => !done.has(candidate.candidate_id));
    if (next === undefined) throw new Error("no pending candidate to validate");
    persistValidationResult(
      input.artifacts,
      input.run,
      input.journal,
      next.candidate_id,
      next.current_revision_ref,
      input.optionsFor?.(next.candidate_id) ?? {}
    );
    done.add(next.candidate_id);
    input.run.pendingDirective = null;
    directive = input.playbook.dispatch(input.run);
  }
  return directive;
}

/**
 * Real fixture source bytes for every required case class. Case classes whose rule is expected to
 * match carry the needle the controlled fake Semgrep scans for; the others do not. A controlled
 * host runner derives each observation from these bytes rather than from a self-reported envelope.
 */
const MATCH_CASE_CLASSES: ReadonlySet<ScaP10ValidationCaseClassV1> = new Set([
  "vulnerable",
  "generalized",
  "retained_vulnerable",
  "held_out",
  "broader_regression",
  "performance",
]);
function fixturesForRule(ruleId: string): {
  readonly case_class: ScaP10ValidationCaseClassV1;
  readonly file_name: string;
  readonly content_base64: string;
}[] {
  return SCA_P10_VALIDATION_CASE_CLASSES.map((caseClass) => ({
    case_class: caseClass,
    file_name: `${caseClass}.php`,
    content_base64: Buffer.from(
      MATCH_CASE_CLASSES.has(caseClass)
        ? `<?php\n// ruleid: ${ruleId}\ndanger('P10NEEDLE');\n`
        : `<?php\n// ok: ${ruleId}\necho '${caseClass}';\n`
    ).toString("base64"),
  }));
}
function candidateProposal(input: {
  readonly payloadSha256: string;
  readonly items: readonly {
    readonly item_id: string;
    readonly p08_disposition_ref: ArtifactRef;
  }[];
  readonly label: (index: number) => string;
}): Record<string, JsonValue> {
  return {
    schema_id: SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA,
    schema_version: 1,
    role: "rule_candidate_proposer",
    payload_sha256: input.payloadSha256,
    proposals: input.items
      .map((item, index) => ({
        established_issue_item_id: item.item_id,
        root_cause_claim: `the exact causal link for ${input.label(index)}`,
        root_cause_evidence_refs: [item.p08_disposition_ref],
        distinguishing_oracle: null,
        rule_id: `p10-rule-${String(index)}`,
        rule_language: "php" as const,
        rule_category: "injection",
        rule_content_base64: Buffer.from(`rules:\n  - id: p10-rule-${String(index)}\n`).toString(
          "base64"
        ),
        fixtures: fixturesForRule(`p10-rule-${String(index)}`),
        excerpt: "evidence excerpt",
      }))
      .sort((left, right) =>
        left.established_issue_item_id < right.established_issue_item_id ? -1 : 1
      ),
    no_feasible_rule: false,
    rationale: "one or more feasible single-rule candidates",
    complete: true,
  };
}
/** Persist a summary artifact carrying one proposal, exactly as the worker would. */
function persistProposal(
  artifacts: ArtifactStore,
  run: RunContext,
  proposal: Record<string, JsonValue>
): void {
  const outputMetadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: run.identity.run_id,
    phase: SCA_P10_PROPOSING_STATE,
    branch_id: null,
    kind: "sca-p10-rule-candidate-proposal",
    operation_id: "sca-p10-rule-candidate-proposal",
    version: 1,
    producer: "agent:ida",
    media_type: "text/plain",
    content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  const outputRef = artifacts.persist({
    metadata: outputMetadata,
    content: `SUMMARY:${canonicalJson(proposal)}`,
  });
  run.selectedArtifacts.push(outputRef);
}
/** Mock-host contract fixture only; NOT production qualification or independently approved truth. */
function persistValidationResult(
  artifacts: ArtifactStore,
  run: RunContext,
  journal: FakeJournal,
  candidateId: string,
  ruleRevisionRef: ArtifactRef,
  options: { readonly failVulnerable?: boolean } = {}
): void {
  const runId = run.identity.run_id;
  const requestRef = required(
    artifacts.refFor(
      runId,
      "SCA-P10",
      null,
      SCA_P10_RULE_VALIDATION_REQUEST_KIND,
      `sca-p10-rule-validation-request-${candidateId}`,
      1
    ),
    "validation request ref"
  );
  const request = validateScaP10RuleValidationRequestV1(
    JSON.parse(artifacts.readById(requestRef.artifact_id).toString("utf8"))
  );
  // Synthetic native-shaped exact reports: not live Semgrep qualification.
  const collection: ScaP10NativeCollectionV1 = {
    protocol: "semgrep_test_json_file_v1",
    children: request.fixtures.map((fixture) => {
      const config = "/synthetic/root/rules/r.yml",
        file = `/synthetic/root/fixtures/${fixture.file_name}`;
      const invocation = {
        schema_id: "penny.sca-process-request.v1",
        schema_version: 1,
        executable: request.runtime.executable,
        executable_sha256: request.runtime.executable_sha256,
        arguments: scaP10RuleValidationArguments("test", {
          fixedArguments: [],
          ruleConfigPath: config,
          fixturePath: file,
        }),
        cwd: "/synthetic/root",
        environment: [
          { name: "HOME", value: "/synthetic/root" },
          { name: "PATH", value: "/usr/bin:/bin" },
          { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
          { name: "SEMGREP_SEND_METRICS", value: "off" },
        ],
        timeout_ms: request.timeout_ms,
        max_stdout_bytes: request.max_output_bytes,
        max_stderr_bytes: request.max_output_bytes,
      };
      const invocation_json = canonicalJson(invocation),
        invocation_sha256 = sha256(invocation_json);
      const expected = MATCH_CASE_CLASSES.has(fixture.case_class) ? [3] : [];
      const failed = options.failVulnerable === true && fixture.case_class === "vulnerable";
      const stdout = JSON.stringify({
        config_missing_tests: [],
        config_missing_fixtests: [],
        config_with_errors: [],
        results: {
          [config]: {
            checks: {
              [request.rule_id]: {
                passed: !failed,
                matches: {
                  [file]: { expected_lines: expected, reported_lines: failed ? [] : expected },
                },
                errors: [],
              },
            },
          },
        },
        fixtest_results: {},
      });
      const processResult = {
        schema_id: "penny.sca-process-result.v1",
        schema_version: 1,
        request_sha256: invocation_sha256,
        status: failed ? "nonzero_exit" : "succeeded",
        exit_code: failed ? 1 : 0,
        signal: null,
        stdout,
        stderr: "",
        stdout_sha256: sha256(stdout),
        stderr_sha256: sha256(""),
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        failure_code: failed ? "nonzero_exit" : "none",
      };
      return {
        case_class: fixture.case_class,
        file_name: fixture.file_name,
        fixture_sha256: fixture.fixture_ref.content_digest,
        source_base64: artifacts.readById(fixture.fixture_ref.artifact_id).toString("base64"),
        rule_id: request.rule_id,
        config_path: config,
        config_source_base64: request.rule_content_base64,
        config_sha256: request.rule_sha256,
        fixture_path: file,
        invocation_json,
        invocation_sha256,
        process_result_json: canonicalJson(processResult),
        exit_status: failed ? 1 : 0,
        completed: true,
        stdout,
        stderr: "",
        stdout_sha256: sha256(stdout),
        stderr_sha256: sha256(""),
      };
    }),
  };
  const test = {
    collection,
    ...scaP10NativeAggregateDigests(collection),
    exit_status: scaP10NativeCollectionExit(collection),
    status: scaP10NativeCollectionComplete(collection) ? ("passed" as const) : ("failed" as const),
    performance: {
      clock: "host_monotonic" as const,
      scope: "complete_test_collection" as const,
      elapsed_ms: 1,
      bound_ms: request.performance_bound_ms,
    },
  };
  const validateInvocation = {
    schema_id: "penny.sca-process-request.v1",
    schema_version: 1,
    executable: request.runtime.executable,
    executable_sha256: request.runtime.executable_sha256,
    arguments: scaP10RuleValidationArguments("validate", {
      fixedArguments: [],
      ruleConfigPath: "/synthetic/root/rules/r.yml",
    }),
    cwd: "/synthetic/root",
    environment: [
      { name: "HOME", value: "/synthetic/root" },
      { name: "PATH", value: "/usr/bin:/bin" },
      { name: "SEMGREP_ENABLE_VERSION_CHECK", value: "0" },
      { name: "SEMGREP_SEND_METRICS", value: "off" },
    ],
    timeout_ms: request.timeout_ms,
    max_stdout_bytes: request.max_output_bytes,
    max_stderr_bytes: request.max_output_bytes,
  };
  const validateResult = {
    schema_id: "penny.sca-process-result.v1",
    schema_version: 1,
    request_sha256: sha256(canonicalJson(validateInvocation)),
    status: "succeeded",
    exit_code: 0,
    signal: null,
    stdout: "{}",
    stderr: "",
    stdout_sha256: sha256("{}"),
    stderr_sha256: sha256(""),
    stdout_bytes: 2,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    failure_code: "none",
  };
  const body = {
    schema_id: "penny.sca-p10-rule-validation-result.v1",
    schema_version: 1 as const,
    run_id: runId,
    candidate_id: candidateId,
    rule_revision_ref: ruleRevisionRef,
    rule_revision_sha256: ruleRevisionRef.content_digest,
    request_sha256: request.request_sha256,
    validate: {
      invocation_sha256: validateResult.request_sha256,
      executable_sha256: request.runtime.executable_sha256,
      exit_status: 0,
      raw_result_sha256: sha256("{}"),
      invocation_json: canonicalJson(validateInvocation),
      process_result_json: canonicalJson(validateResult),
      status: "passed" as const,
    },
    test,
    cases: request.fixtures.map((fixture, index) => {
      const child = collection.children[index];
      if (child === undefined) throw new Error("synthetic child missing");
      return {
        case_class: fixture.case_class,
        ...(fixture.case_class === "performance"
          ? deriveScaP10PerformanceCaseV1(test)
          : scaP10NativeCaseV1(child, fixture.expected_outcome)),
      };
    }),
  };
  const result = validateScaP10RuleValidationAdapterResultV1({
    ...body,
    result_sha256: sha256(canonicalJson(body)),
  });
  const resultRef = artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "SCA-P10",
      branch_id: null,
      kind: SCA_P10_RULE_VALIDATION_RESULT_KIND,
      operation_id: `sca-p10-rule-validation-result-${candidateId}`,
      version: 1,
      producer: "host:sca-p10-rule-validation",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.sca-p10-rule-validation-result.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson(result),
  });
  run.selectedArtifacts.push(resultRef);
  // Record the exact result on the durable host-operation journal, exactly as the owner would after
  // persisting the unselected result for this candidate's operation id.
  journal.records.push({
    state_id: "sca_p10_validating",
    operation_id: `sca-p10-rule-validation-${candidateId}`,
    request_ref: requestRef,
    operation_result_ref: resultRef,
    disposition: {
      outcome: "completed",
      remote_disposition: "proven_terminal",
      lease_disposition: "released",
      retryable: false,
      reason_code: null,
    },
  });
}

describe("SCA P10 no-rule honest completion", () => {
  it("emits a legitimate no_rule outcome with a non-authorizing handoff and non-positive terminal", () => {
    const { artifacts, run, playbook } = prepare({
      runId: "run-p10-norule",
      confirmed: false,
      accepted: false,
    });
    const terminal = terminalOf(playbook.initialize(run));
    expect(terminal.status).toBe("learning_complete");
    expect(terminal.outcome_disposition).toBe("no_rule");
    expect(terminal.promotion_performed).toBe(false);
    expect(terminal.phase_gate_passed).toBe(false);
    expect(terminal.release_eligible).toBe(false);
    expect(terminal.campaign_complete).toBe(false);
    expect(terminal.p12_release_authorized).toBe(false);
    expect(terminal.missing_downstream_artifacts).toContain("penny.sca-p11-report.v1");
    expect(terminal.p11_transition_ref).not.toBeNull();
    const outcome = validateScaP10RuleLearningOutcomeV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-learning-outcome"))
    );
    expect(outcome.disposition).toBe("no_rule");
    expect(outcome.candidate_count).toBe(0);
    const gate = validateScaP10GateV1(readObject(artifacts, selectedRef(run, "sca-p10-gate")));
    expect(gate.verdict).toBe("pass_ready");
    const handoff = validateScaP10ToP11TransitionV1(
      readObject(artifacts, selectedRef(run, "sca-p10-to-p11-transition"))
    );
    expect(handoff.p11_reporting_authorized_by_this_transition).toBe(false);
    expect(handoff.required_gaps_retained).toBe(true);
  });
});

describe("SCA P10 mock-host contract: candidate and promotion", () => {
  it("validates a proposed candidate, promotes it atomically, and emits a separate rescan revision", () => {
    const { artifacts, run, playbook, journal } = prepare({
      runId: "run-p10-validated",
      confirmed: true,
      accepted: true,
    });
    const proposalDirective = playbook.initialize(run);
    if (proposalDirective.action !== "invoke_agent") {
      throw new Error("expected P10 proposal directive");
    }
    expect(proposalDirective.state_id).toBe(SCA_P10_PROPOSING_STATE);
    expect(proposalDirective.agent).toBe("ida");
    const payloadRef = required(proposalDirective.input_artifacts.artifacts[0]?.ref, "payload ref");
    const payload = validateScaP10CognitivePayloadV1(readObject(artifacts, payloadRef));
    const item = required(payload.items[0], "payload item");
    const proposal = candidateProposal({
      payloadSha256: payload.payload_sha256,
      items: [{ item_id: item.item_id, p08_disposition_ref: item.p08_disposition_ref }],
      label: () => "the established issue",
    });
    validateScaP10RuleCandidateProposalV1(proposal);
    persistProposal(artifacts, run, proposal);
    const validationDirective = playbook.acceptSummary(run, proposal, "CERTAIN");
    expect(validationDirective.action).toBe("invoke_host_operation");
    const registry = validateScaP10RuleCandidateRegistryV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-candidate-registry"))
    );
    const candidate = required(registry.candidates[0], "registered candidate");
    persistValidationResult(
      artifacts,
      run,
      journal,
      candidate.candidate_id,
      candidate.current_revision_ref
    );
    run.pendingDirective = null;
    const terminal = terminalOf(playbook.dispatch(run));
    expect(terminal.status).toBe("learning_complete");
    expect(terminal.outcome_disposition).toBe("validated_candidate");
    expect(terminal.promotion_performed).toBe(true);
    expect(terminal.promotion_receipt_ref).not.toBeNull();
    expect(terminal.p12_release_authorized).toBe(false);
    const manifest = validateScaP10RuleValidationResultsV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-validation-results"))
    );
    expect(manifest.schema_id).toBe(SCA_P10_RULE_VALIDATION_RESULTS_SCHEMA);
    expect(manifest.candidates[0]?.manifest_complete).toBe(true);
    const decisions = validateScaP10RulePromotionDecisionsV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-promotion-decisions"))
    );
    expect(decisions.decisions[0]?.decision).toBe("promoted");
    expect(decisions.decisions[0]?.receipt_ref).not.toBeNull();
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p10-rescan-directive")).toBe(true);
  });
});

describe("SCA P10 mock-host contract: multi-candidate learning", () => {
  it("builds and validates more than one candidate without an artifact selection collision", () => {
    const { artifacts, run, playbook, journal } = prepare({
      runId: "run-p10-multi-candidate",
      confirmed: true,
      accepted: true,
      kinds: ["source_query", "graph_query"],
    });
    const proposalDirective = playbook.initialize(run);
    if (proposalDirective.action !== "invoke_agent") {
      throw new Error("expected P10 proposal directive");
    }
    const payloadRef = required(proposalDirective.input_artifacts.artifacts[0]?.ref, "payload ref");
    const payload = validateScaP10CognitivePayloadV1(readObject(artifacts, payloadRef));
    expect(payload.items.length).toBeGreaterThan(1);
    const proposal = candidateProposal({
      payloadSha256: payload.payload_sha256,
      items: payload.items.map((entry) => ({
        item_id: entry.item_id,
        p08_disposition_ref: entry.p08_disposition_ref,
      })),
      label: (index) => `issue ${String(index)}`,
    });
    validateScaP10RuleCandidateProposalV1(proposal);
    persistProposal(artifacts, run, proposal);
    const firstDirective = playbook.acceptSummary(run, proposal, "CERTAIN");
    expect(firstDirective.action).toBe("invoke_host_operation");
    const registry = validateScaP10RuleCandidateRegistryV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-candidate-registry"))
    );
    expect(registry.candidate_count).toBeGreaterThan(1);
    const terminal = terminalOf(
      driveCandidates({ artifacts, run, playbook, journal, registry, initial: firstDirective })
    );
    expect(terminal.status).toBe("learning_complete");
    expect(terminal.outcome_disposition).toBe("validated_candidate");
    expect(terminal.promotion_performed).toBe(true);
    const manifest = validateScaP10RuleValidationResultsV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-validation-results"))
    );
    expect(manifest.candidate_count).toBe(registry.candidate_count);
    expect(manifest.candidates.every((entry) => entry.manifest_complete)).toBe(true);
    const outcome = validateScaP10RuleLearningOutcomeV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-learning-outcome"))
    );
    expect(outcome.validated_candidate_count).toBe(registry.candidate_count);
    expect(outcome.blocked_candidate_count).toBe(0);
  });

  it("accounts for a mixed validated/mismatched native collection as blocked", () => {
    const { artifacts, run, playbook, journal } = prepare({
      runId: "run-p10-mixed-quarantined",
      confirmed: true,
      accepted: true,
      kinds: ["source_query", "graph_query"],
    });
    const proposalDirective = playbook.initialize(run);
    if (proposalDirective.action !== "invoke_agent") {
      throw new Error("expected P10 proposal directive");
    }
    const payloadRef = required(proposalDirective.input_artifacts.artifacts[0]?.ref, "payload ref");
    const payload = validateScaP10CognitivePayloadV1(readObject(artifacts, payloadRef));
    const proposal = candidateProposal({
      payloadSha256: payload.payload_sha256,
      items: payload.items.map((entry) => ({
        item_id: entry.item_id,
        p08_disposition_ref: entry.p08_disposition_ref,
      })),
      label: (index) => `issue ${String(index)}`,
    });
    persistProposal(artifacts, run, proposal);
    const firstDirective = playbook.acceptSummary(run, proposal, "CERTAIN");
    expect(firstDirective.action).toBe("invoke_host_operation");
    const registry = validateScaP10RuleCandidateRegistryV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-candidate-registry"))
    );
    expect(registry.candidate_count).toBeGreaterThan(1);
    const lastCandidateId = registry.candidates[registry.candidates.length - 1]?.candidate_id;
    const directive = driveCandidates({
      artifacts,
      run,
      playbook,
      journal,
      registry,
      initial: firstDirective,
      optionsFor: (candidateId) => ({ failVulnerable: candidateId === lastCandidateId }),
    });
    const terminal = terminalOf(directive);
    expect(terminal.status).toBe("blocked_invalid");
    expect(terminal.outcome_disposition).toBe("blocked_learning");
    const outcome = validateScaP10RuleLearningOutcomeV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-learning-outcome"))
    );
    expect(outcome.candidate_count).toBe(registry.candidate_count);
    expect(outcome.validated_candidate_count).toBe(registry.candidate_count - 1);
    expect(outcome.quarantined_candidate_count).toBe(0);
    expect(outcome.blocked_candidate_count).toBe(1);
  });

  it("reports a mixed validated/unrun manifest as blocked with exhaustive accounting", () => {
    const { artifacts, run, playbook, journal } = prepare({
      runId: "run-p10-mixed-unrun",
      confirmed: true,
      accepted: true,
      kinds: ["source_query", "graph_query"],
    });
    const proposalDirective = playbook.initialize(run);
    if (proposalDirective.action !== "invoke_agent") {
      throw new Error("expected P10 proposal directive");
    }
    const payloadRef = required(proposalDirective.input_artifacts.artifacts[0]?.ref, "payload ref");
    const payload = validateScaP10CognitivePayloadV1(readObject(artifacts, payloadRef));
    const proposal = candidateProposal({
      payloadSha256: payload.payload_sha256,
      items: payload.items.map((entry) => ({
        item_id: entry.item_id,
        p08_disposition_ref: entry.p08_disposition_ref,
      })),
      label: (index) => `issue ${String(index)}`,
    });
    persistProposal(artifacts, run, proposal);
    const firstDirective = playbook.acceptSummary(run, proposal, "CERTAIN");
    expect(firstDirective.action).toBe("invoke_host_operation");
    const registry = validateScaP10RuleCandidateRegistryV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-candidate-registry"))
    );
    expect(registry.candidate_count).toBeGreaterThan(1);
    const first = required(registry.candidates[0], "first candidate");
    // Only one candidate receives a host result; the others stay required-but-unrun. Force the
    // finalization state, which is exactly the recovery path after an uncompleted validation.
    persistValidationResult(
      artifacts,
      run,
      journal,
      first.candidate_id,
      first.current_revision_ref
    );
    run.pendingDirective = null;
    run.transition(SCA_P10_FINAL_STATE);
    const terminal = terminalOf(playbook.dispatch(run));
    expect(terminal.status).toBe("blocked_invalid");
    expect(terminal.outcome_disposition).toBe("blocked_learning");
    expect(terminal.promotion_performed).toBe(false);
    const outcome = validateScaP10RuleLearningOutcomeV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-learning-outcome"))
    );
    expect(outcome.candidate_count).toBe(registry.candidate_count);
    expect(outcome.validated_candidate_count).toBe(1);
    expect(outcome.blocked_candidate_count).toBe(registry.candidate_count - 1);
    expect(outcome.quarantined_candidate_count).toBe(0);
    const manifest = validateScaP10RuleValidationResultsV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-validation-results"))
    );
    expect(manifest.candidate_count).toBe(registry.candidate_count);
    expect(manifest.candidates.filter((entry) => entry.manifest_complete).length).toBe(1);
    expect(
      manifest.candidates.some((entry) => entry.required_unrun_case_classes.length === 8)
    ).toBe(true);
  });

  it("re-derives finalize after a later promotion without promoting a candidate twice", () => {
    const { artifacts, run, playbook, journal } = prepare({
      runId: "run-p10-later-promotion-replay",
      confirmed: true,
      accepted: true,
      kinds: ["source_query", "graph_query"],
    });
    const proposalDirective = playbook.initialize(run);
    if (proposalDirective.action !== "invoke_agent") {
      throw new Error("expected P10 proposal directive");
    }
    const payloadRef = required(proposalDirective.input_artifacts.artifacts[0]?.ref, "payload ref");
    const payload = validateScaP10CognitivePayloadV1(readObject(artifacts, payloadRef));
    const proposal = candidateProposal({
      payloadSha256: payload.payload_sha256,
      items: payload.items.map((entry) => ({
        item_id: entry.item_id,
        p08_disposition_ref: entry.p08_disposition_ref,
      })),
      label: (index) => `issue ${String(index)}`,
    });
    persistProposal(artifacts, run, proposal);
    const firstDirective = playbook.acceptSummary(run, proposal, "CERTAIN");
    expect(firstDirective.action).toBe("invoke_host_operation");
    const registry = validateScaP10RuleCandidateRegistryV1(
      readObject(artifacts, selectedRef(run, "sca-p10-rule-candidate-registry"))
    );
    expect(registry.candidate_count).toBeGreaterThan(1);
    const terminal = terminalOf(
      driveCandidates({ artifacts, run, playbook, journal, registry, initial: firstDirective })
    );
    expect(terminal.status).toBe("learning_complete");
    expect(terminal.promotion_performed).toBe(true);
    const promotedHistory = promotionHead(artifacts, run.identity.run_id).history().length;
    expect(promotedHistory).toBe(registry.candidate_count);

    // Recovery re-derivation: the run is re-dispatched at the same validating state, exactly as a
    // restart re-derives a pending directive. Every candidate already promoted, so finalize must
    // converge on the durable promotion journal and must never promote a candidate a second time
    // atop the later head. The terminal artifact is intentionally write-once (its own
    // selected-artifact snapshot differs once it exists), so the re-derivation fails closed on the
    // immutable terminal rather than overwriting it — but it must leave the promotion store intact.
    run.pendingDirective = null;
    run.terminalDirective = null;
    expect(() => playbook.dispatch(run)).toThrow(/sca-p10-terminal.*immutable prior bytes/);
    expect(promotionHead(artifacts, run.identity.run_id).history().length).toBe(promotedHistory);
  });
});

describe("SCA P10 inactive registration and cancellation", () => {
  it("stays absent from every active registry and declares a model-free host operation", () => {
    const registration = SCA_P10_CANDIDATE_REGISTRATION;
    expect(registration.name).toBe("sca-p10-candidate");
    expect(SCA_PHASE_REGISTRY.has("sca-p10-candidate")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("sca-p10-candidate")).toBe(false);
    expect(validateRegistrationContract(registration)).toBe(registration.contract);
    expect(registration.host_operations?.declarations[0]?.operation_kind).toBe(
      SCA_P10_RULE_VALIDATION_OPERATION_KIND
    );
    expect(registration.host_states).toEqual([
      "sca_p10_classifying",
      "sca_p10_validating",
      "sca_p10_finalizing",
    ]);
    const phase =
      registration.worker.kind === "catalog-agent"
        ? registration.worker.phases.get(SCA_P10_PROPOSING_STATE)
        : undefined;
    expect(phase?.allowed_tools).toEqual([]);
    expect(phase?.provider_opening_guard).toBe("sca_p10_payload_disclosure_v1");
    expect(phase?.required_model?.override).toBe("ollama/deepseek-v4.1-flash:cloud");
  });

  it("records a cancelled terminal with no learning or promotion state", () => {
    const { run, playbook } = prepare({
      runId: "run-p10-cancel",
      confirmed: false,
      accepted: false,
    });
    const directive = playbook.cancel(run, "operator cancelled");
    if (directive.action !== "cancelled") throw new Error("expected cancelled directive");
    const terminal = validateScaP10TerminalV1(directive.result);
    expect(terminal.status).toBe("cancelled");
    expect(terminal.learning_outcome_ref).toBeNull();
    expect(terminal.promotion_performed).toBe(false);
    expect(terminal.p11_transition_ref).toBeNull();
  });
});
