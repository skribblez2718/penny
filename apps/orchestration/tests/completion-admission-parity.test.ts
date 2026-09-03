/**
 * P1.1 — pre-change completion-admission parity pin.
 *
 * This suite characterizes valid positive and honest negative outcomes across the
 * approved start/step/respond/recover/direct-host boundary categories. It deliberately
 * asserts only public directives and durable replay truth: later W7 admission
 * evidence may be added without changing these outcomes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer, canonicalJson, sha256 } from "../src/checkpointer.js";
import type {
  Confidence,
  Directive,
  JsonValue,
  RunIdentity,
  SkillContract,
} from "../src/contracts.js";
import { validateDirective } from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine } from "../src/engine.js";
import { readManifest, readPolicy } from "../src/kb/filesystem.js";
import { checkpointDirectOperationResult } from "../src/kb/operation-starts.js";
import { initKb, lintKb } from "../src/kb/workflows.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import type { PlaybookCoreV1 } from "../src/playbooks/playbook.js";
import { type PlaybookRegistrationV1, type PlaybookRegistryV1 } from "../src/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT } from "../src/playbooks/research.js";
import { WorkerExecutor } from "../src/worker.js";
import { installGrantedProfile } from "./fixtures/kb-profile-fixture.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { requireValue } from "./helpers/narrowing.js";

const PARITY_PLAYBOOK = "completion-admission-parity";
const PARITY_SESSION = "session-completion-admission-parity";
const KB_PROFILE = "kbp_completion_admission_parity";
const KB_SESSION = "session_completion_admission_parity";
const ENGINE_MAX_STEPS = 16;
const WORKER_CONCURRENCY = 1;

type Outcome = "positive" | "negative";
type EntryPath = "start" | "step" | "respond";
type TerminalDirective = Extract<Directive, { result: Record<string, unknown> }>;

const roots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `penny-completion-parity-${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parityIdentity(runId: string): RunIdentity {
  return {
    schema_version: 2,
    run_id: runId,
    session_id: PARITY_SESSION,
    playbook: PARITY_PLAYBOOK,
    engine_owner: "typescript",
  };
}

function requiredOutcome(value: JsonValue | undefined): Outcome {
  if (value === "positive" || value === "negative") return value;
  throw new Error("parity fixture requires a positive or negative outcome");
}

function requiredEntryPath(value: JsonValue | undefined): EntryPath {
  if (value === "start" || value === "step" || value === "respond") return value;
  throw new Error("parity fixture requires a start, step, or respond entry path");
}

function requireTerminal(value: Directive, label: string): TerminalDirective {
  if ("result" in value) return value;
  throw new Error(`${label}: expected a terminal directive, received '${value.action}'`);
}

function completeContext(
  context: RunContext,
  outcome: Outcome,
  via: EntryPath | "direct-host"
): TerminalDirective {
  const action = outcome === "positive" ? "complete" : "incomplete";
  context.transition(action);
  context.status = action;
  context.met = outcome === "positive";
  context.pendingDirective = null;
  const terminal = requireTerminal(
    validateDirective({
      schema_version: 2,
      action,
      identity: context.identity,
      status: action,
      met: context.met,
      result: { outcome, via },
      artifacts: context.selectedArtifacts,
      unresolved: outcome === "positive" ? [] : ["completion condition was not met"],
    }),
    `${via} ${outcome}`
  );
  context.terminalDirective = terminal;
  return terminal;
}

class ParityPlaybook implements PlaybookCoreV1 {
  initialize(context: RunContext): Directive {
    const outcome = requiredOutcome(context.constraints.fixture_outcome);
    const entryPath = requiredEntryPath(context.constraints.fixture_path);
    context.transition(outcome === "positive" ? "report_writing" : "researching");
    if (entryPath === "start") return completeContext(context, outcome, entryPath);
    if (entryPath === "step") return this.dispatch(context);

    const pending = validateDirective({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: context.stateId,
      gate_id: `gate_${context.identity.run_id}`,
      challenge: `challenge_${context.identity.run_id}`,
      payload_digest: sha256(canonicalJson({ run_id: context.identity.run_id })),
      questions: [{ id: "outcome", prompt: "Choose the characterized terminal outcome." }],
    });
    context.status = "awaiting_user";
    context.pendingDirective = pending;
    return pending;
  }

  dispatch(context: RunContext): Directive {
    const pending = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: context.stateId,
      agent: "parity-agent",
      attempt: 1,
      trust_profile: context.trustProfile,
      task: "Return the preselected parity outcome.",
      input_artifacts: { schema_version: 2, artifacts: [] },
      output_artifact: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: context.stateId,
        branch_id: null,
        kind: "agent-output",
        operation_id: `parity_${context.identity.run_id}_${context.stateId}`,
        version: 1,
        producer: "agent:parity-agent",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [],
      },
    });
    context.pendingDirective = pending;
    return pending;
  }

  resume(context: RunContext, response: JsonValue): Directive {
    return completeContext(context, requiredOutcome(response), "respond");
  }

  cancel(context: RunContext): Directive {
    return completeContext(context, "negative", "respond");
  }

  validateDetails(_state: string, details: Record<string, JsonValue>): Record<string, JsonValue> {
    requiredOutcome(details.outcome);
    return details;
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    return completeContext(context, requiredOutcome(details.outcome), "step");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}

const PARITY_CONTRACT: SkillContract = {
  ...RESEARCH_SKILL_CONTRACT,
  name: PARITY_PLAYBOOK,
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: ["complete"],
    required_visited_states: [],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: "penny.orchestration.terminal-result",
      product_schema_version: 2,
    },
    unresolved_policy: { mode: "allow_any" },
  },
};

const PARITY_RESULT_SCHEMA = Type.Object(
  { outcome: Type.Union([Type.Literal("positive"), Type.Literal("negative")]) },
  { additionalProperties: false }
);

const PARITY_REGISTRATION: PlaybookRegistrationV1 = {
  name: PARITY_PLAYBOOK,
  contract: PARITY_CONTRACT,
  ingress: "dedicated_tool",
  liveness: {
    resolver_id: PARITY_CONTRACT.budget_policy.resolver_id,
    resolve: () => undefined,
    thinking_policy: "agent_ssot",
  },
  worker: {
    kind: "catalog-agent",
    workflow_name: PARITY_PLAYBOOK,
    guidance: PARITY_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: new Map([
      [
        "report_writing",
        {
          agent: "parity-agent",
          result_schema_id: "penny.test.completion-parity-summary",
          result_schema_version: 1,
          schema: PARITY_RESULT_SCHEMA,
        },
      ],
      [
        "researching",
        {
          agent: "parity-agent",
          result_schema_id: "penny.test.completion-parity-summary",
          result_schema_version: 1,
          schema: PARITY_RESULT_SCHEMA,
        },
      ],
    ]),
  },
  completionReceiptPredicates: new Map(),
  construct: () => new ParityPlaybook(),
};

const PARITY_REGISTRY: PlaybookRegistryV1 = new Map([
  [PARITY_REGISTRATION.name, PARITY_REGISTRATION],
]);

function parityRuntime(root: string): {
  checkpointer: Checkpointer;
  engine: OrchestrationEngine;
} {
  const checkpointer = new Checkpointer(path.join(root, "orchestration-v2.db"));
  return {
    checkpointer,
    engine: new OrchestrationEngine(checkpointer, {
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      projectRoot: root,
      maxSteps: ENGINE_MAX_STEPS,
      playbookName: PARITY_PLAYBOOK,
      playbookRegistry: PARITY_REGISTRY,
    }),
  };
}

function parityStartRequest(
  root: string,
  runId: string,
  entryPath: EntryPath,
  outcome: Outcome
): unknown {
  return {
    schema_version: 2,
    action: "start",
    identity: parityIdentity(runId),
    goal: "Characterize completion-admission parity.",
    constraints: { fixture_path: entryPath, fixture_outcome: outcome },
    project_root: root,
    trust_profile: "trusted-interactive",
  };
}

function expectTerminalTruth(
  terminal: TerminalDirective,
  outcome: Outcome,
  via: EntryPath | "direct-host"
): void {
  const expected = outcome === "positive";
  expect(terminal).toMatchObject({
    action: expected ? "complete" : "incomplete",
    status: expected ? "complete" : "incomplete",
    met: expected,
    result: { outcome, via },
    unresolved: expected ? [] : ["completion condition was not met"],
  });
}

function expectExactReplay(
  engine: OrchestrationEngine,
  identity: RunIdentity,
  terminal: TerminalDirective
): void {
  expect(engine.handle({ schema_version: 2, action: "status", identity })).toEqual(terminal);
  expect(engine.handle({ schema_version: 2, action: "recover", identity })).toEqual(terminal);
}

class OutcomeClient implements ModelClient {
  constructor(private readonly outcome: Outcome) {}

  async runAgent(_invocation: AgentInvocation): Promise<AgentCompletion> {
    return {
      text: `characterized ${this.outcome} phase output\nSUMMARY:${JSON.stringify({ confidence: "CERTAIN", outcome: this.outcome })}`,
      confidence: "CERTAIN",
      details: { outcome: this.outcome },
    };
  }
}

describe("P1.1 completion-admission parity pin", () => {
  it.each<Outcome>(["positive", "negative"])(
    "preserves the %s terminal through start and exact status/recover replay",
    (outcome) => {
      const root = temporaryRoot(`start-${outcome}`);
      const { checkpointer, engine } = parityRuntime(root);
      const runId = `run_start_${outcome}`;
      const terminal = requireTerminal(
        engine.handle(parityStartRequest(root, runId, "start", outcome)),
        `start ${outcome}`
      );

      expectTerminalTruth(terminal, outcome, "start");
      expectExactReplay(engine, parityIdentity(runId), terminal);
      checkpointer.close();
    }
  );

  it.each<Outcome>(["positive", "negative"])(
    "preserves the %s terminal through step with its accepted receipt",
    async (outcome) => {
      const root = temporaryRoot(`step-${outcome}`);
      const { checkpointer, engine } = parityRuntime(root);
      const runId = `run_step_${outcome}`;
      const pending = engine.handle(parityStartRequest(root, runId, "step", outcome));
      if (pending.action !== "invoke_agent") {
        throw new Error(`step ${outcome}: expected invoke_agent, received '${pending.action}'`);
      }
      const workers = new WorkerExecutor(
        new OutcomeClient(outcome),
        new ArtifactStore(path.join(root, "artifacts")),
        {
          projectRoot: root,
          parallelConcurrency: WORKER_CONCURRENCY,
          registration: PARITY_REGISTRATION,
        }
      );
      workers.setReceiptAuthority(engine.receiptAuthority);
      const phaseResult = requireValue(
        (await workers.execute(pending))[0],
        `step ${outcome} phase result`
      );
      const terminal = requireTerminal(
        engine.handle({
          schema_version: 2,
          action: "step",
          identity: parityIdentity(runId),
          result: phaseResult,
        }),
        `step ${outcome}`
      );

      expectTerminalTruth(terminal, outcome, "step");
      expect(terminal.artifacts).toEqual([phaseResult.output_artifact]);
      expect(checkpointer.receiptResult(phaseResult.worker_receipt)).toEqual(phaseResult);
      expectExactReplay(engine, parityIdentity(runId), terminal);
      checkpointer.close();
    }
  );

  it.each<Outcome>(["positive", "negative"])(
    "preserves the %s terminal through a challenge-bound respond",
    (outcome) => {
      const root = temporaryRoot(`respond-${outcome}`);
      const { checkpointer, engine } = parityRuntime(root);
      const runId = `run_respond_${outcome}`;
      const pending = engine.handle(parityStartRequest(root, runId, "respond", outcome));
      if (pending.action !== "await_user") {
        throw new Error(`respond ${outcome}: expected await_user, received '${pending.action}'`);
      }
      const terminal = requireTerminal(
        engine.handle({
          schema_version: 2,
          action: "respond",
          identity: parityIdentity(runId),
          gate_id: pending.gate_id,
          challenge: pending.challenge,
          response: outcome,
        }),
        `respond ${outcome}`
      );

      expectTerminalTruth(terminal, outcome, "respond");
      expectExactReplay(engine, parityIdentity(runId), terminal);
      checkpointer.close();
    }
  );
});

function createLintRun(input: {
  checkpointer: Checkpointer;
  projectRoot: string;
  runId: string;
}): RunIdentity {
  const identity: RunIdentity = {
    schema_version: 2,
    run_id: input.runId,
    session_id: KB_SESSION,
    playbook: "knowledge-base",
    engine_owner: "typescript",
  };
  const context = RunContext.create({
    identity,
    goal: "Run the deterministic host lint.",
    constraints: { action: "lint", kb_profile_id: KB_PROFILE },
    projectRoot: input.projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: ENGINE_MAX_STEPS,
  });
  input.checkpointer.createRun(context, "lint_parity_started", {
    run_id: input.runId,
  });
  return identity;
}

function knowledgeBaseEngine(root: string, checkpointer: Checkpointer): OrchestrationEngine {
  return new OrchestrationEngine(checkpointer, {
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    projectRoot: root,
    maxSteps: ENGINE_MAX_STEPS,
    playbookName: "knowledge-base",
  });
}

describe("P1.1 direct-host terminal parity", () => {
  it("preserves a positive deterministic lint and its exact evidence-backed replay", () => {
    const projectRoot = temporaryRoot("direct-positive");
    const kbRoot = path.join(projectRoot, "private-kb");
    installGrantedProfile({
      projectRoot,
      kbRoot,
      profileId: KB_PROFILE,
      sessionId: KB_SESSION,
    });
    initKb({ kbRoot, profileId: KB_PROFILE, runId: "run_lint_init" }, "Parity KB");
    const checkpointer = new Checkpointer(path.join(projectRoot, "lint-control.db"));
    const runId = "run_direct_positive";
    const identity = createLintRun({ checkpointer, projectRoot, runId });
    const result = lintKb({ kbRoot, profileId: KB_PROFILE, runId, checkpointer });
    const manifest = readManifest(kbRoot);
    const replay = checkpointDirectOperationResult({
      checkpointer,
      run_id: runId,
      result,
      kb_id: manifest.kb_id,
      policy_sha256: sha256(canonicalJson(readPolicy(kbRoot))),
    });
    const terminal = requireTerminal(
      requireValue(checkpointer.loadRun(identity).terminalDirective, "positive direct terminal"),
      "positive direct terminal"
    );

    expect(replay).toEqual(result);
    expect(replay).toMatchObject({ action: "lint", status: "complete", met: true });
    expect(replay.artifacts).toHaveLength(1);
    expect(terminal).toMatchObject({
      action: "complete",
      status: "complete",
      met: true,
      result: replay,
      unresolved: replay.unresolved,
    });
    expect(checkpointer.completionAdmission(runId)).toMatchObject({
      origin_state: "intake",
      evidence_refs: [{ kind: "kb_artifact", reference_id: replay.artifacts[0]?.artifact_id }],
    });
    expectExactReplay(knowledgeBaseEngine(projectRoot, checkpointer), identity, terminal);
    checkpointer.close();
  });

  it("preserves an honest negative deterministic lint from an uninitialized KB", () => {
    const projectRoot = temporaryRoot("direct-negative");
    const kbRoot = path.join(projectRoot, "private-kb");
    installGrantedProfile({
      projectRoot,
      kbRoot,
      profileId: KB_PROFILE,
      sessionId: KB_SESSION,
    });
    const checkpointer = new Checkpointer(path.join(projectRoot, "lint-control.db"));
    const runId = "run_direct_negative";
    const identity = createLintRun({ checkpointer, projectRoot, runId });
    const result = lintKb({ kbRoot, profileId: KB_PROFILE, runId, checkpointer });
    const replay = checkpointDirectOperationResult({
      checkpointer,
      run_id: runId,
      result,
    });
    const terminal = requireTerminal(
      requireValue(checkpointer.loadRun(identity).terminalDirective, "negative direct terminal"),
      "negative direct terminal"
    );

    expect(replay).toMatchObject({ action: "lint", status: "refused", met: false });
    expect(terminal).toMatchObject({
      action: "incomplete",
      status: "incomplete",
      met: false,
      result: replay,
      unresolved: replay.unresolved,
    });
    expectExactReplay(knowledgeBaseEngine(projectRoot, checkpointer), identity, terminal);
    checkpointer.close();
  });
});
