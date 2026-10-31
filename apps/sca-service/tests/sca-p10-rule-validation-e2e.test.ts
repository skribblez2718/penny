import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type {
  ArtifactRef,
  JsonValue,
  OutputArtifactMetadata,
} from "../../orchestration/dist/contracts.js";
import { RunContext } from "../../orchestration/dist/context.js";
import type { HostOperationExecutionContextV1 } from "../../orchestration/dist/host-operations/contracts.js";
import { FileHostOperationResultCache } from "../../orchestration/dist/host-operations/result-cache.js";
import type { ModelClient } from "../../orchestration/dist/model-client.js";
import {
  runtimeRegistrationSha256,
  skillContractSha256,
} from "../../orchestration/dist/playbooks/registry.js";
import { OrchestrationService } from "../../orchestration/dist/service.js";
import {
  SCA_P10_PROPOSING_STATE,
  SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA,
  SCA_P10_VALIDATION_CASE_CLASSES,
  validateScaP10CognitivePayloadV1,
  validateScaP10RuleCandidateProposalV1,
  validateScaP10RuleValidationResultsV1,
  validateScaP10TerminalV1,
} from "../../orchestration/dist/sca/p10-contracts.js";
import {
  SCA_P10_RULE_VALIDATION_RESULT_KIND,
  type ScaP10RuleValidationAdapterResultV1,
  validateScaP10RuleValidationAdapterResultV1,
  validateScaP10RuleValidationRequestV1,
} from "../../orchestration/dist/sca/p10-validation.js";
import { scaP10NativeAggregateDigests } from "../../orchestration/dist/sca/p10-native-tests.js";
import {
  ScaRulePromotionStore,
  createArtifactScaRulePromotionBackendV1,
} from "../../orchestration/dist/sca/p10-promotion.js";
import {
  createScaP10CandidateProductionRegistrationV1,
  createScaP10RuleValidationProductionHostCompositionV1,
} from "../../orchestration/dist/sca/p10-production-host.js";
import { createScaP09CandidateRegistrationV1 } from "../../orchestration/dist/sca/p09-playbook.js";
import {
  SCA_P10_CANDIDATE_PLAYBOOK_NAME,
  ScaP10CandidatePlaybook,
} from "../../orchestration/dist/sca/p10-playbook.js";
import { createScaP10RuleValidationRunnerV1 } from "../src/adapters/semgrep-validation.js";
import { initializePennyState } from "../../orchestration/dist/state/index.js";
import { buildScaP09Lineage } from "../../orchestration/tests/sca-p09-lineage.js";
import { buildScaP10Lineage, driveScaP09 } from "../../orchestration/tests/sca-p10-lineage.js";

/**
 * Provider-free end-to-end regression for the inactive P10 rule-validation host operation.
 *
 * It drives the real `OrchestrationService` host-operation path (engine -> `HostOperationRuntimeOwner`)
 * through the production P10 composition into a controlled fake Semgrep executable. The only
 * substitution is the fake executable: no live Semgrep, cloud, provider, model, network, or target
 * is touched. Durable state is entirely temporary and project-bound. A recovery/restart after the
 * terminal must replay from durable state without a duplicate process effect.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
/**
 * The engine decorates a non-terminal directive result with its liveness snapshot; the persisted
 * terminal artifact never carries it. Strip it before schema validation.
 */
function stripLiveness(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "liveness"));
}
function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "penny-sca-p10-e2e-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
function readJson(store: ArtifactStore, ref: ArtifactRef): unknown {
  return JSON.parse(store.readById(ref.artifact_id).toString("utf8"));
}

/** Synthetic native-shaped executable, NOT captured Semgrep behavior. Its explicit empty match
 * records exercise admission but do not establish real native negative coverage. */
function writeFakeSemgrep(input: {
  readonly root: string;
  readonly counter: string;
  readonly omitNegative?: boolean;
}): {
  readonly executable: string;
  readonly executable_sha256: string;
} {
  const executable = path.join(input.root, "synthetic-native-semgrep.cjs");
  const script = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(input.counter)}, "x");
const args = process.argv.slice(2);
if (args.includes("--validate")) { console.log("{}"); process.exit(0); }
const config = args[args.indexOf("--config") + 1], file = args.at(-1);
if (!args.includes("--json") || !fs.statSync(file).isFile()) process.exit(2);
const id = /id: (\\S+)/.exec(fs.readFileSync(config, "utf8"))[1];
const source = fs.readFileSync(file, "utf8");
const expected = source.includes("// ruleid:") ? [3] : [];
const reported = source.includes("danger(") ? [3] : [];
const passed = JSON.stringify(expected) === JSON.stringify(reported);
console.log(JSON.stringify({ config_missing_tests: [], config_missing_fixtests: [], config_with_errors: [], results: { [config]: { checks: ${input.omitNegative === true ? "expected.length === 0 ? {} :" : ""} { [id]: { passed, matches: { [file]: { expected_lines: expected, reported_lines: reported } }, errors: [] } } } }, fixtest_results: {} }));
process.exit(passed ? 0 : 1);
`;
  writeFileSync(executable, script, { mode: 0o700 });
  return { executable, executable_sha256: sha256(readFileSync(executable)) };
}
function fakeInvocations(counter: string): number {
  return existsSync(counter) ? statSync(counter).size : 0;
}

const E2E_NEEDLE = "P10E2ENEEDLE";
const E2E_MATCH_CASE_CLASSES: ReadonlySet<string> = new Set([
  "vulnerable",
  "generalized",
  "retained_vulnerable",
  "held_out",
]);
function e2eFixtures(ruleId: string): {
  readonly case_class: string;
  readonly file_name: string;
  readonly content_base64: string;
}[] {
  return SCA_P10_VALIDATION_CASE_CLASSES.map((caseClass) => ({
    case_class: caseClass,
    file_name: `${caseClass}.php`,
    content_base64: Buffer.from(
      E2E_MATCH_CASE_CLASSES.has(caseClass)
        ? `<?php\n// ruleid: ${ruleId}\ndanger('${E2E_NEEDLE}');\n`
        : `<?php\n// ok: ${ruleId}\necho '${caseClass}';\n`
    ).toString("base64"),
  }));
}

const COVERAGE_FULL: NonNullable<Parameters<typeof buildScaP09Lineage>[0]["coverage"]> = {
  entries: [
    { surface_kind: "normalized_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "graph_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "p04_selected_candidate", coverage_state: "covered", reason: null },
    { surface_kind: "omitted_surface", coverage_state: "omitted", reason: "no omission candidate" },
  ],
};

interface Fixture {
  readonly projectRoot: string;
  readonly canonicalProjectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly store: ArtifactStore;
  readonly cacheRoot: string;
  readonly counter: string;
  readonly identity: {
    readonly schema_version: 2;
    readonly run_id: string;
    readonly session_id: string;
    readonly playbook: string;
    readonly engine_owner: "typescript";
  };
}

function makeModelClient(): ModelClient {
  return {
    async runAgent() {
      throw new Error("the provider-free P10 regression must not invoke a model");
    },
  };
}

function makeService(input: {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cache: FileHostOperationResultCache;
  readonly registration: ReturnType<typeof createScaP10CandidateProductionRegistrationV1>;
  readonly adapters: ReadonlyMap<
    string,
    import("../../orchestration/dist/host-operations/contracts.js").HostOperationAdapterV1
  >;
  readonly useValidator: import("../../orchestration/dist/host-operations/owner.js").HostOperationUseValidatorV1;
}): OrchestrationService {
  return new OrchestrationService({
    projectRoot: input.projectRoot,
    env: input.env,
    modelClient: makeModelClient(),
    playbookRegistration: input.registration,
    hostOperationAdapters: input.adapters,
    hostOperationUseValidator: input.useValidator,
    hostOperationResultCache: input.cache,
  });
}

function identity(runId: string): Fixture["identity"] {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: `session-${runId}`,
    playbook: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
    engine_owner: "typescript",
  };
}

async function runRegression(input: {
  readonly run_id: string;
  readonly kinds: readonly ("source_query" | "graph_query")[];
  readonly proposal_count: number;
  readonly omitNegative?: boolean;
}): Promise<{
  readonly fakeRuns: number;
  readonly journalCount: number;
  readonly candidateCount: number;
}> {
  const root = temporaryRoot();
  const projectRoot = path.join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  const canonicalProjectRoot = realpathSync(projectRoot);
  const env: NodeJS.ProcessEnv = {
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  const state = initializePennyState(canonicalProjectRoot, { env });
  const runId = input.run_id;
  const id = identity(runId);

  const compositionStore = ArtifactStore.openExisting(state.paths.artifacts.root, {
    projectId: state.projectId,
  });
  const cacheRoot = path.join(root, "host-operation-cache");
  const cache = await FileHostOperationResultCache.provision(cacheRoot);

  // Build the full P10 lineage against the exact project-bound artifact store.
  const p09 = buildScaP09Lineage({
    store: compositionStore,
    run_id: runId,
    kinds: [...input.kinds],
    completed_indices: input.kinds.map((_, index) => index),
    disposition_for: () => "confirmed",
    repository_location_for: () => ({ path: "src/example.php", line_start: 10, line_end: 12 }),
    resolutions: "all_due" as const,
    coverage: COVERAGE_FULL,
  });
  const p09Result = driveScaP09({
    store: compositionStore,
    p09,
    registration: createScaP09CandidateRegistrationV1({
      resolve_current_p07_authority_ref: () => p09.p07_authority_ref,
      resolve_current_p01_obligation_head_ref: () => p09.p01_obligation_ledger_ref,
    }),
  });
  const lineage = buildScaP10Lineage({
    store: compositionStore,
    p09,
    p09_result: p09Result,
    baseline_languages: ["php"],
  });

  const counter = path.join(root, "fake-semgrep-invocations");
  const fake = writeFakeSemgrep({ root, counter, omitNegative: input.omitNegative });

  const composition = createScaP10RuleValidationProductionHostCompositionV1({
    store: compositionStore,
    runtime: {
      executable: fake.executable,
      executable_sha256: fake.executable_sha256,
      fixed_arguments: [],
      tool_version: "fake-semgrep-1.0.0",
    },
    run_validation: createScaP10RuleValidationRunnerV1(),
  });
  const registration = createScaP10CandidateProductionRegistrationV1({
    composition,
    resolve_current_p07_authority_ref: () => p09.p07_authority_ref,
    resolve_current_p01_obligation_head_ref: () => lineage.constraints.p01_obligation_ledger_ref,
  });
  expect(registration.host_operations?.declarations).toEqual([composition.declaration]);

  const orchestration = makeService({
    projectRoot: canonicalProjectRoot,
    env,
    cache,
    registration,
    adapters: composition.adapters,
    useValidator: composition.use_validator,
  });

  // Drive the inactive playbook to the exact pending host-operation directive, then persist the
  // durable run and let the real service owner dispatch it.
  const constraints = lineage.constraints;
  const startAdmission = required(registration.start_admission, "P10 start admission");
  const request = (() => {
    const c = constraints;
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
    ];
    return {
      schema_version: 2 as const,
      action: "start" as const,
      identity: id,
      goal: "Run the inactive P10 rule-validation operation over a controlled fake Semgrep.",
      constraints: c,
      project_root: canonicalProjectRoot,
      trust_profile: "hardened-untrusted" as const,
      input_artifacts: { schema_version: 2 as const, artifacts: slots },
    };
  })();
  const prepared = startAdmission.prepare(request, {});
  const refs = startAdmission.materialize(prepared, {
    run_id: runId,
    artifactStore: orchestration.artifacts,
    trustedClock: () => new Date("2026-09-26T00:00:09.000Z"),
  });
  const run = RunContext.create({
    identity: id,
    goal: request.goal,
    constraints: {},
    projectRoot: canonicalProjectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
    initialArtifacts: refs,
    registrationContractBinding: {
      schema_version: 1,
      registration_name: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
      contract_sha256: skillContractSha256(orchestration.engine.contract),
      registration_sha256: runtimeRegistrationSha256(orchestration.engine.registration),
    },
  });
  const playbook = new ScaP10CandidatePlaybook(
    orchestration.artifacts,
    {
      declaration: composition.declaration,
      backend_key_sha256: composition.backend_key_sha256,
      rule_validation_runtime: composition.runtime,
      resolve_current_p07_authority_ref: () => p09.p07_authority_ref,
      resolve_current_p01_obligation_head_ref: () => lineage.constraints.p01_obligation_ledger_ref,
    },
    () => new Date("2026-09-26T00:00:09.000Z")
  );
  const proposalDirective = playbook.initialize(run);
  if (proposalDirective.action !== "invoke_agent") {
    throw new Error("expected the P10 proposal directive");
  }
  const payloadRef = required(proposalDirective.input_artifacts.artifacts[0]?.ref, "payload ref");
  const payload = validateScaP10CognitivePayloadV1(readJson(orchestration.artifacts, payloadRef));
  expect(payload.items.length).toBeGreaterThanOrEqual(input.proposal_count);
  // Distinct rule bytes per proposal: the successor release id is derived from the rule digest, so
  // distinct candidates must carry distinct rules.
  const ruleContent = (index: number): string =>
    Buffer.from(
      `# needle: ${E2E_NEEDLE}\nrules:\n  - id: p10-e2e-rule-${String(index)}\n`
    ).toString("base64");
  const proposal: Record<string, JsonValue> = {
    schema_id: SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA,
    schema_version: 1,
    role: "rule_candidate_proposer",
    payload_sha256: payload.payload_sha256,
    proposals: payload.items.slice(0, input.proposal_count).map((entry, index) => ({
      established_issue_item_id: entry.item_id,
      root_cause_claim: "the exact causal link for the established issue",
      root_cause_evidence_refs: [entry.p08_disposition_ref],
      distinguishing_oracle: null,
      rule_id: `p10-e2e-rule-${String(index)}`,
      rule_language: "php",
      rule_category: "injection",
      rule_content_base64: ruleContent(index),
      fixtures: e2eFixtures(`p10-e2e-rule-${String(index)}`),
      excerpt: "evidence excerpt",
    })),
    no_feasible_rule: false,
    rationale: "one or more feasible single-rule candidates",
    complete: true,
  };
  validateScaP10RuleCandidateProposalV1(proposal);
  const outputMetadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: runId,
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
  const outputRef = orchestration.artifacts.persist({
    metadata: outputMetadata,
    content: `SUMMARY:${canonicalJson(proposal)}`,
  });
  run.selectedArtifacts.push(outputRef);
  const validationDirective = playbook.acceptSummary(run, proposal, "CERTAIN");
  if (validationDirective.action !== "invoke_host_operation")
    throw new Error("expected host validation directive");
  expect(run.stateId).toBe("sca_p10_validating");
  orchestration.checkpointer.createRun(run, "test_p10_validation_pending", { run_id: runId });
  // The engine binds a host liveness policy during its own start path; a manually seeded run must
  // bind the same policy before recovery so the run is not treated as a legacy unmetered run.
  orchestration.engine.liveness.bindPolicy(run);

  const terminal = await orchestration.execute({
    schema_version: 2,
    action: "recover",
    identity: id,
  });
  expect(terminal).toMatchObject({ action: "incomplete", status: "incomplete", met: false });
  if (!("result" in terminal)) throw new Error("P10 terminal directive lacks a result");
  const p10Terminal = validateScaP10TerminalV1(stripLiveness(terminal.result));
  expect(p10Terminal.status).toBe("blocked_invalid");
  expect(p10Terminal.outcome_disposition).toBe("blocked_learning");
  expect(p10Terminal.promotion_performed).toBe(false);
  expect(p10Terminal.phase_gate_passed).toBe(false);
  expect(p10Terminal.release_eligible).toBe(false);
  expect(p10Terminal.p12_release_authorized).toBe(false);

  const journal = orchestration.checkpointer.hostOperationCallsForRun(runId);
  expect(journal).toHaveLength(input.proposal_count);
  expect(journal.every((entry) => entry.lifecycle === "consumed")).toBe(true);
  expect(
    journal.every(
      (entry) =>
        entry.disposition?.outcome === (input.omitNegative === true ? "completed" : "failed")
    )
  ).toBe(true);
  expect(
    journal.every((entry) => entry.disposition?.remote_disposition === "proven_terminal")
  ).toBe(true);
  if (input.omitNegative !== true)
    expect(
      journal.every(
        (entry) => entry.disposition?.reason_code === "p10_independent_fixture_truth_unverified"
      )
    ).toBe(true);
  expect(
    journal.every(
      (entry) =>
        entry.policy_binding.adapter_id === composition.declaration.adapter_id &&
        entry.policy_binding.backend_key_sha256 === composition.backend_key_sha256
    )
  ).toBe(true);
  // Each candidate's result was persisted durably unselected under its own deterministic operation
  // coordinate; distinct version-1 results of one kind coexist without an artifact-selection collision.
  const resultRefs = journal.map((entry) =>
    required(entry.operation_result_ref, "operation result ref")
  );
  expect(new Set(resultRefs.map((ref) => ref.artifact_id)).size).toBe(input.proposal_count);

  const checkpoint = orchestration.checkpointer.loadRun(id);
  const record = required(journal[0], "host operation record");
  const requestRef = record.request_ref;
  const storedRequest = validateScaP10RuleValidationRequestV1(
    readJson(orchestration.artifacts, requestRef)
  );
  expect(storedRequest.runtime.state).toBe("available");
  expect(storedRequest.runtime.executable).toBe(fake.executable);

  // Boundary-only adversaries: no extra executable invocations. The genuine owner E2E above still
  // supplies the production request, artifacts and journal; these direct contexts isolate races.
  const selfTestRunner = createScaP10RuleValidationRunnerV1({
    runner: {
      run: async (processRequest) => {
        const config = required(
          processRequest.arguments[processRequest.arguments.indexOf("--config") + 1],
          "config argument"
        );
        const file = processRequest.arguments.at(-1);
        if (file === undefined) throw new Error("synthetic fresh test target absent");
        const expected = processRequest.arguments.includes("--validate")
          ? []
          : readFileSync(file, "utf8").includes("// ruleid:")
            ? [3]
            : [];
        const stdout = processRequest.arguments.includes("--validate")
          ? "{}"
          : JSON.stringify({
              config_missing_tests: [],
              config_missing_fixtests: [],
              config_with_errors: [],
              results: {
                [config]: {
                  checks: {
                    [storedRequest.rule_id]: {
                      passed: true,
                      matches: {
                        [file]: { expected_lines: expected, reported_lines: expected },
                      },
                      errors: [],
                    },
                  },
                },
              },
              fixtest_results: {},
            });
        return {
          schema_id: "penny.sca-process-result.v1",
          schema_version: 1,
          request_sha256: sha256(canonicalJson(processRequest)),
          status: "succeeded",
          exit_code: 0,
          signal: null,
          stdout,
          stderr: "",
          stdout_sha256: sha256(stdout),
          stderr_sha256: sha256(""),
          stdout_bytes: Buffer.byteLength(stdout),
          stderr_bytes: 0,
          stdout_truncated: false,
          stderr_truncated: false,
          failure_code: "none",
        };
      },
    },
  });

  const contextFor = (
    overrides: Partial<HostOperationExecutionContextV1> = {}
  ): HostOperationExecutionContextV1 => {
    return {
      directive: validationDirective,
      declaration: composition.declaration,
      request_bytes: Buffer.from(canonicalJson(storedRequest)),
      journal: record,
      signal: new AbortController().signal,
      reportActivity() {},
      emitProgress() {},
      beginSubmission() {},
      recordRemoteAccepted() {},
      registerRemoteCancellation() {},
      recordFetched() {},
      readInput(slot) {
        const bound = required(
          validationDirective.input_artifacts.artifacts.find((entry) => entry.slot === slot),
          "exact input"
        );
        return { ref: bound.ref, bytes: compositionStore.readById(bound.ref.artifact_id) };
      },
      readCachedResult: async () => null,
      cacheResult: async (bytes) => ({
        schema_version: 1,
        request_sha256: storedRequest.request_sha256,
        content_sha256: sha256(bytes),
        byte_length: bytes.byteLength,
        bytes,
      }),
      persist() {
        return {
          operation_result_ref: required(resultRefs[0], "raw result ref"),
          output_artifacts: [],
        };
      },
      ...overrides,
    };
  };
  if (input.proposal_count === 1 && input.omitNegative !== true) {
    const raw = validateScaP10RuleValidationAdapterResultV1(
      readJson(compositionStore, required(resultRefs[0], "raw result ref"))
    );
    const rawBytes = Buffer.from(canonicalJson(raw));
    for (const fixed of [
      ["--config", "/other.yml"],
      ["--test"],
      ["--"],
      ["other.php"],
      ["--json"],
      ["innocent"],
    ])
      expect(() =>
        createScaP10RuleValidationProductionHostCompositionV1({
          store: compositionStore,
          runtime: { ...composition.runtime, fixed_arguments: fixed },
          run_validation: selfTestRunner,
        })
      ).toThrow();
    for (const cached of [false, true]) {
      let runCalls = 0,
        cacheWrites = 0;
      let collected = rawBytes;
      let persisted: Uint8Array | undefined;
      let cwd: string | undefined;
      const host = createScaP10RuleValidationProductionHostCompositionV1({
        store: compositionStore,
        runtime: composition.runtime,
        run_validation: async (invocation) => {
          runCalls++;
          cwd = invocation.cwd;
          const result = await selfTestRunner(invocation);
          collected = Buffer.from(canonicalJson(result));
          return result;
        },
      });
      const context = contextFor({
        readCachedResult: async () =>
          cached
            ? {
                schema_version: 1,
                request_sha256: storedRequest.request_sha256,
                content_sha256: sha256(rawBytes),
                byte_length: rawBytes.byteLength,
                bytes: rawBytes,
              }
            : null,
        cacheResult: async (bytes) => {
          cacheWrites++;
          return {
            schema_version: 1,
            request_sha256: storedRequest.request_sha256,
            content_sha256: sha256(bytes),
            byte_length: bytes.byteLength,
            bytes,
          };
        },
        persist(value) {
          const content = value.operation_result?.content;
          persisted = typeof content === "string" ? Buffer.from(content) : content;
          return {
            operation_result_ref: required(resultRefs[0], "result ref"),
            output_artifacts: [],
          };
        },
      });
      const blocked = await host.adapter.run(context);
      expect(blocked.disposition).toEqual({
        outcome: "failed",
        remote_disposition: "proven_terminal",
        lease_disposition: "released",
        retryable: false,
        reason_code: "p10_independent_fixture_truth_unverified",
      });
      expect(persisted).toEqual(collected);
      expect(blocked.operation_result_ref).not.toBeNull();
      expect(runCalls).toBe(cached ? 0 : 1);
      expect(cacheWrites).toBe(cached ? 0 : 1);
      if (cwd !== undefined) expect(existsSync(cwd)).toBe(false);
    }
    for (const stage of [
      "read_hit",
      "read_miss",
      "begin",
      "run",
      "cache_write",
      "fetched",
      "persist",
    ] as const) {
      const abort = new AbortController(),
        reason = new Error(`cancelled during ${stage}`);
      let runCalls = 0,
        writes = 0,
        fetched = 0,
        persists = 0,
        begins = 0;
      let cwd: string | undefined;
      const before = readdirSync(tmpdir())
        .filter((name) => name.startsWith("penny-p10-rule-validation-"))
        .sort();
      const host = createScaP10RuleValidationProductionHostCompositionV1({
        store: compositionStore,
        runtime: composition.runtime,
        run_validation: async (invocation) => {
          runCalls++;
          cwd = invocation.cwd;
          const result = await selfTestRunner(invocation);
          if (stage === "run") abort.abort(reason);
          return result;
        },
      });
      const context = contextFor({
        signal: abort.signal,
        readCachedResult: async () => {
          if (stage === "read_hit" || stage === "read_miss") abort.abort(reason);
          return stage === "read_hit"
            ? {
                schema_version: 1,
                request_sha256: storedRequest.request_sha256,
                content_sha256: sha256(rawBytes),
                byte_length: rawBytes.byteLength,
                bytes: rawBytes,
              }
            : null;
        },
        beginSubmission() {
          begins++;
          if (stage === "begin") abort.abort(reason);
        },
        cacheResult: async (bytes) => {
          writes++;
          if (stage === "cache_write") abort.abort(reason);
          return {
            schema_version: 1,
            request_sha256: storedRequest.request_sha256,
            content_sha256: sha256(bytes),
            byte_length: bytes.byteLength,
            bytes,
          };
        },
        recordFetched() {
          fetched++;
          if (stage === "fetched") abort.abort(reason);
        },
        persist() {
          persists++;
          if (stage === "persist") abort.abort(reason);
          return {
            operation_result_ref: required(resultRefs[0], "result ref"),
            output_artifacts: [],
          };
        },
      });
      await expect(host.adapter.run(context)).rejects.toBe(reason);
      expect(begins).toBe(stage.startsWith("read_") ? 0 : 1);
      expect(runCalls).toBe(["read_hit", "read_miss", "begin"].includes(stage) ? 0 : 1);
      expect(writes).toBe(["cache_write", "fetched", "persist"].includes(stage) ? 1 : 0);
      expect(fetched).toBe(["fetched", "persist"].includes(stage) ? 1 : 0);
      expect(persists).toBe(stage === "persist" ? 1 : 0);
      if (cwd !== undefined) expect(existsSync(cwd)).toBe(false);
      expect(
        readdirSync(tmpdir())
          .filter((name) => name.startsWith("penny-p10-rule-validation-"))
          .sort()
      ).toEqual(before);
    }
  }
  for (const resultRef of resultRefs) {
    expect(resultRef.kind).toBe(SCA_P10_RULE_VALIDATION_RESULT_KIND);
    const storedResult = validateScaP10RuleValidationAdapterResultV1(
      readJson(orchestration.artifacts, resultRef)
    );
    expect(storedResult.validate.status).toBe("passed");
    expect(storedResult.test.status).toBe(input.omitNegative === true ? "failed" : "passed");
    expect(storedResult.test.performance.elapsed_ms).toBeGreaterThan(0);
    expect(storedResult.test.performance.bound_ms).toBe(storedRequest.performance_bound_ms);
    expect(storedResult.cases.every((entry) => entry.status === "passed")).toBe(
      input.omitNegative !== true
    );
    if (input.omitNegative === true)
      expect(storedResult.cases.find((c) => c.case_class === "fixed")?.status).toBe("unrun");
  }
  if (input.proposal_count === 1) {
    // Independently exercise fresh AND cached production admission with an internally valid,
    // re-digested result whose declared bound differs from its exact request. No process rerun.
    const source = validateScaP10RuleValidationAdapterResultV1(
      readJson(orchestration.artifacts, required(resultRefs[0], "first validation result"))
    );
    const { result_sha256: _digest, ...body } = source;
    const changedBody = {
      ...body,
      test: {
        ...body.test,
        performance: {
          ...body.test.performance,
          bound_ms: storedRequest.performance_bound_ms + 1,
        },
      },
    };
    const wrongBound = validateScaP10RuleValidationAdapterResultV1({
      ...changedBody,
      result_sha256: sha256(canonicalJson(changedBody)),
    });
    function forgeInputs(result: ScaP10RuleValidationAdapterResultV1, mode: "config" | "fixture") {
      const collection = {
        ...result.test.collection,
        children: result.test.collection.children.map((c) => {
          const bytes = Buffer.concat([
            Buffer.from(mode === "config" ? c.config_source_base64 : c.source_base64, "base64"),
            Buffer.from("\n// forged historical input\n"),
          ]);
          return mode === "config"
            ? { ...c, config_source_base64: bytes.toString("base64"), config_sha256: sha256(bytes) }
            : { ...c, source_base64: bytes.toString("base64"), fixture_sha256: sha256(bytes) };
        }),
      };
      const { result_sha256: _old, ...body } = result;
      const changed = {
        ...body,
        test: { ...body.test, collection, ...scaP10NativeAggregateDigests(collection) },
      };
      return validateScaP10RuleValidationAdapterResultV1({
        ...changed,
        result_sha256: sha256(canonicalJson(changed)),
      });
    }
    for (const invalidResult of [
      wrongBound,
      forgeInputs(source, "config"),
      forgeInputs(source, "fixture"),
      ...[{ run_id: "other-run" }, { request_sha256: sha256("other-request") }].map((patch) => {
        const changed = { ...body, ...patch };
        return validateScaP10RuleValidationAdapterResultV1({
          ...changed,
          result_sha256: sha256(canonicalJson(changed)),
        });
      }),
    ]) {
      const bytes = Buffer.from(canonicalJson(invalidResult));
      for (const cached of [false, true]) {
        let runnerCalls = 0;
        let publicationAttempts = 0;
        const refusing = createScaP10RuleValidationProductionHostCompositionV1({
          store: compositionStore,
          runtime: composition.runtime,
          run_validation: async (invocation) => {
            runnerCalls += 1;
            // Fresh refusal must reach request/run/bound admission, not fail incidentally on the
            // old temporary paths in the retained result. Recollect synthetic native-shaped bytes
            // under the CURRENT materialization through an in-process process double: zero spawn.
            let fresh = await selfTestRunner(invocation);
            if (
              invalidResult.test.collection.children[0]?.config_sha256 !==
              source.test.collection.children[0]?.config_sha256
            )
              fresh = forgeInputs(fresh, "config");
            if (
              invalidResult.test.collection.children[0]?.fixture_sha256 !==
              source.test.collection.children[0]?.fixture_sha256
            )
              fresh = forgeInputs(fresh, "fixture");
            const { result_sha256: _freshDigest, ...freshBody } = fresh;
            const changed = {
              ...freshBody,
              run_id: invalidResult.run_id,
              request_sha256: invalidResult.request_sha256,
              test: {
                ...freshBody.test,
                performance: {
                  ...freshBody.test.performance,
                  bound_ms: invalidResult.test.performance.bound_ms,
                },
              },
            };
            return validateScaP10RuleValidationAdapterResultV1({
              ...changed,
              result_sha256: sha256(canonicalJson(changed)),
            });
          },
        });
        const unexpectedPublication = (): never => {
          publicationAttempts += 1;
          throw new Error("unexpected publication");
        };
        const context: HostOperationExecutionContextV1 = {
          directive: validationDirective,
          declaration: composition.declaration,
          request_bytes: Buffer.from(canonicalJson(storedRequest)),
          journal: record,
          signal: new AbortController().signal,
          reportActivity() {},
          emitProgress() {},
          beginSubmission() {},
          recordRemoteAccepted() {},
          registerRemoteCancellation() {},
          recordFetched() {},
          readInput(slot) {
            const bound = required(
              validationDirective.input_artifacts.artifacts.find((entry) => entry.slot === slot),
              "exact input"
            );
            return { ref: bound.ref, bytes: compositionStore.readById(bound.ref.artifact_id) };
          },
          readCachedResult: async () =>
            cached
              ? {
                  schema_version: 1,
                  request_sha256: storedRequest.request_sha256,
                  content_sha256: sha256(bytes),
                  byte_length: bytes.byteLength,
                  bytes,
                }
              : null,
          cacheResult: unexpectedPublication,
          persist: unexpectedPublication,
        };
        const refused = await refusing.adapter.run(context);
        expect(refused.disposition.outcome).toBe("failed");
        expect(refused.operation_result_ref).toBeNull();
        expect(publicationAttempts).toBe(0);
        expect(runnerCalls).toBe(cached ? 0 : 1);
      }
    }
  }
  const manifestRef = required(
    [...checkpoint.selectedArtifacts]
      .reverse()
      .find((ref) => ref.kind === "sca-p10-rule-validation-results"),
    "validation manifest ref"
  );
  const manifest = validateScaP10RuleValidationResultsV1(
    readJson(orchestration.artifacts, manifestRef)
  );
  expect(
    manifest.candidates.every(
      (entry) => required(entry.test.performance, "manifest performance").elapsed_ms !== null
    )
  ).toBe(input.omitNegative === true);
  if (input.omitNegative !== true) {
    expect(
      manifest.candidates.every((entry) => entry.required_unrun_case_classes.length === 8)
    ).toBe(true);
    expect(
      manifest.candidates.every((entry) =>
        entry.blocker_codes.includes("p10_independent_fixture_truth_unverified")
      )
    ).toBe(true);
  } else {
    expect(manifest.candidates.every((entry) => entry.test.collection !== null)).toBe(true);
    expect(
      manifest.candidates.every(
        (entry) => !entry.blocker_codes.includes("p10_independent_fixture_truth_unverified")
      )
    ).toBe(true);
  }
  expect(manifest.candidate_count).toBe(input.proposal_count);
  expect(manifest.candidates.every((entry) => !entry.manifest_complete)).toBe(true);
  // Proposer-authored annotations cannot authorize any production learning/promotion.
  const promotions = new ScaRulePromotionStore({
    backend: createArtifactScaRulePromotionBackendV1({
      store: orchestration.artifacts,
      runId,
      phase: "SCA-P10",
    }),
    store: orchestration.artifacts,
    runId,
    phase: "SCA-P10",
  });
  expect(promotions.history().length).toBe(0);
  expect(promotions.currentHead()).toBeNull();
  const promotionHistory = promotions.history().length;

  const fakeRuns = fakeInvocations(counter);
  expect(fakeRuns).toBe(input.proposal_count * 9);

  // Restart boundary: close everything and reopen from durable state only. The terminal must
  // replay exactly and no second process effect may occur.
  orchestration.close();
  compositionStore.close();
  const restarted = makeService({
    projectRoot: canonicalProjectRoot,
    env,
    cache: await FileHostOperationResultCache.provision(cacheRoot),
    registration,
    adapters: new Map(),
    useValidator: {
      validateUse() {
        throw new Error("restart recovery must not re-enter the host operation");
      },
    },
  });
  const recovered = await restarted.execute({
    schema_version: 2,
    action: "recover",
    identity: id,
  });
  if (!("result" in recovered)) throw new Error("recovered terminal directive lacks a result");
  expect(validateScaP10TerminalV1(stripLiveness(recovered.result)).terminal_sha256).toBe(
    p10Terminal.terminal_sha256
  );
  expect(fakeInvocations(counter)).toBe(fakeRuns);
  const restartedJournal = restarted.checkpointer.hostOperationCallsForRun(runId);
  // The restart replays the persisted terminal and the durable promotion head exactly; it never
  // re-promotes a candidate or re-enters the host operation.
  const restartedPromotions = new ScaRulePromotionStore({
    backend: createArtifactScaRulePromotionBackendV1({
      store: restarted.artifacts,
      runId,
      phase: "SCA-P10",
    }),
    store: restarted.artifacts,
    runId,
    phase: "SCA-P10",
  });
  expect(restartedPromotions.history().length).toBe(promotionHistory);
  restarted.close();

  return {
    fakeRuns,
    journalCount: restartedJournal.length,
    candidateCount: manifest.candidate_count,
  };
}

describe("SCA P10 rule-validation host operation over a controlled fake Semgrep", () => {
  it("blocks annotation-only qualification and recovers without a duplicate process effect", async () => {
    const result = await runRegression({
      run_id: "sca-p10-rule-validation-e2e",
      kinds: ["source_query"],
      proposal_count: 1,
    });
    expect(result.fakeRuns).toBe(9);
    expect(result.journalCount).toBe(1);
    expect(result.candidateCount).toBe(1);
  }, 60_000);

  it("blocks every annotation-only candidate exhaustively and recovers idempotently", async () => {
    const result = await runRegression({
      run_id: "sca-p10-rule-validation-multi-e2e",
      kinds: ["source_query", "graph_query"],
      proposal_count: 2,
    });
    expect(result.candidateCount).toBe(2);
    expect(result.fakeRuns).toBe(18);
    expect(result.journalCount).toBe(2);
  }, 120_000);
  it("retains empty native negative checks as blocked through owner consumption and recovery", async () => {
    const result = await runRegression({
      run_id: "sca-p10-native-negative-blocked",
      kinds: ["source_query"],
      proposal_count: 1,
      omitNegative: true,
    });
    expect(result.fakeRuns).toBe(9);
    expect(result.journalCount).toBe(1);
  }, 60_000);
});
