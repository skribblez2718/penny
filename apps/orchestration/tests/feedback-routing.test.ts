import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { Checkpointer, canonicalJson } from "../src/checkpointer.js";
import {
  EvaluationResultV2Schema,
  validateContract,
  validateDirective,
  type Confidence,
  type Directive,
  type EvaluationResultV2,
  type JsonValue,
  type RunIdentity,
  type SkillContract,
} from "../src/contracts.js";
import { RunContext } from "../src/context.js";
import { OrchestrationEngine } from "../src/engine.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../src/model-client.js";
import {
  hasStateAwareRepair,
  type PlaybookCoreV1,
  type PlaybookV1,
  type StateAwareRepairCapabilityV1,
} from "../src/playbooks/playbook.js";
import {
  KB_AGENT_PHASES,
  KNOWLEDGE_BASE_SKILL_CONTRACT,
  KnowledgeBasePlaybook,
} from "../src/playbooks/knowledge-base.js";
import {
  resolvePlaybook,
  validateRegistrationContract,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "../src/playbooks/registry.js";
import { RESEARCH_SKILL_CONTRACT, ResearchPlaybook } from "../src/playbooks/research.js";
import { WorkerExecutor } from "../src/worker.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-feedback-routing-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function researchContext(options: {
  iteration?: number;
  maxIterations?: number;
  researchRound?: number;
  maxResearchRounds?: number;
}): RunContext {
  const identity: RunIdentity = {
    schema_version: 2,
    run_id: "run-feedback-research",
    session_id: "session-feedback",
    playbook: "research",
    engine_owner: "typescript",
  };
  const context = RunContext.create({
    identity,
    goal: "feedback routing fixture",
    constraints: { max_iterations: options.maxIterations ?? 3 },
    projectRoot: "/tmp",
    trustProfile: "trusted-interactive",
    maxSteps: 32,
  });
  context.iteration = options.iteration ?? 0;
  context.research.research_round = options.researchRound ?? 0;
  context.research.max_research_rounds = options.maxResearchRounds ?? 2;
  context.research.max_sub_queries = 4;
  return context;
}

function knowledgeBaseContext(): RunContext {
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: "run-feedback-kb",
      session_id: "session-feedback-kb",
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "KB feedback routing fixture",
    constraints: { max_iterations: 3 },
    projectRoot: "/tmp",
    trustProfile: "hardened-untrusted",
    maxSteps: 32,
  });
  context.knowledgeBaseData.action = "ingest";
  return context;
}

const research = new ResearchPlaybook() as PlaybookV1;
const knowledgeBase = new KnowledgeBasePlaybook();

function routeKey(originState: string, feedbackKind: string): string {
  return `${originState}:${feedbackKind}`;
}

class SummaryClient implements ModelClient {
  constructor(private readonly details: Record<string, JsonValue>) {}

  async runAgent(_invocation: AgentInvocation): Promise<AgentCompletion> {
    return {
      text: `deterministic fixture\nSUMMARY:${JSON.stringify({
        confidence: "CERTAIN",
        ...this.details,
      })}`,
    };
  }
}

const MUTATING_PLAYBOOK = "mutating-repair-fixture";

class MutatingRepairPlaybook implements PlaybookCoreV1, StateAwareRepairCapabilityV1 {
  initialize(context: RunContext): Directive {
    context.transition("working");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: "working",
      agent: "fixture-agent",
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      task: "Return a typed repair fixture result.",
      input_artifacts: { schema_version: 2, artifacts: [] },
      output_artifact: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: "working",
        branch_id: null,
        kind: "agent-output",
        operation_id: `mutating-${context.identity.run_id}`,
        version: 1,
        producer: "agent:fixture-agent",
        media_type: "text/plain; charset=utf-8",
        parent_ref: null,
        upstream_refs: [],
      },
    });
    context.pendingDirective = next;
    return next;
  }

  resume(context: RunContext, _response: JsonValue): Directive {
    return this.cancel(context, "fixture resume");
  }

  cancel(context: RunContext, reason: string): Directive {
    const next = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: {},
      artifacts: [],
      unresolved: [reason],
    });
    context.status = "cancelled";
    context.met = false;
    context.pendingDirective = next;
    context.terminalDirective = next;
    return next;
  }

  validateDetails(_state: string, details: Record<string, JsonValue>): Record<string, JsonValue> {
    return details;
  }

  acceptSummary(
    context: RunContext,
    _details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    return this.cancel(context, "fixture accepted without repair");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }

  evaluateRepair(
    _context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): EvaluationResultV2 | null {
    if (state !== "working" || details.needs_repair !== true) return null;
    return {
      schema_version: 2,
      kind: "synthesis_gap",
      detail: "fixture repair",
      findings: [],
      strategy_delta: "Retry under engine control.",
    };
  }

  applyRepairBookkeeping(context: RunContext): void {
    context.stateId = "forged-by-bookkeeping";
  }
}

const MUTATING_CONTRACT: SkillContract = {
  ...RESEARCH_SKILL_CONTRACT,
  name: MUTATING_PLAYBOOK,
  repair_routing: {
    schema_version: 1,
    routes: [
      {
        schema_version: 1,
        origin_state: "working",
        feedback_kind: "synthesis_gap",
        repair: { action: "transition", target_state: "working" },
        budget: {
          counter: "iteration",
          limit_source: "run.max_iterations",
          reserved_attempts: 0,
        },
        on_exhaustion: {
          action: "transition",
          target_state: "working",
          reset_counter: false,
        },
      },
    ],
  },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: ["working"],
    required_visited_states: [],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: "penny.test.mutating-repair-result",
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "allow_any" },
  },
};

const MUTATING_REGISTRATION: PlaybookRegistrationV1 = {
  name: MUTATING_PLAYBOOK,
  contract: MUTATING_CONTRACT,
  ingress: "dedicated_tool",
  liveness: {
    resolver_id: MUTATING_CONTRACT.budget_policy.resolver_id,
    resolve: () => undefined,
    thinking_policy: "agent_ssot",
  },
  worker: {
    kind: "catalog-agent",
    workflow_name: MUTATING_PLAYBOOK,
    guidance: MUTATING_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: new Map([
      [
        "working",
        {
          agent: "fixture-agent",
          result_schema_id: "penny.test.mutating-repair-summary",
          result_schema_version: 1,
          schema: Type.Object(
            { needs_repair: Type.Literal(true) },
            { additionalProperties: false }
          ),
        },
      ],
    ]),
  },
  completionReceiptPredicates: new Map(),
  construct: () => new MutatingRepairPlaybook(),
};

async function stepWithSummary(input: {
  engine: OrchestrationEngine;
  artifacts: ArtifactStore;
  projectRoot: string;
  directive: Extract<Directive, { action: "invoke_agent" }>;
  details: Record<string, JsonValue>;
}): Promise<Directive> {
  const workers = new WorkerExecutor(new SummaryClient(input.details), input.artifacts, {
    projectRoot: input.projectRoot,
    parallelConcurrency: 1,
    registration: input.engine.registration,
  });
  workers.setReceiptAuthority(input.engine.receiptAuthority);
  const result = (await workers.execute(input.directive))[0];
  if (result === undefined) throw new Error("worker produced no result");
  const next = input.engine.handle({
    schema_version: 2,
    action: "step",
    identity: input.directive.identity,
    result,
  });
  workers.acceptArtifact(result);
  return next;
}

function requireInvocation(directive: Directive): Extract<Directive, { action: "invoke_agent" }> {
  if (directive.action !== "invoke_agent") {
    throw new Error(`expected invoke_agent, received '${directive.action}'`);
  }
  return directive;
}

function workerState(directive: Directive): string {
  if (directive.action === "invoke_agent" || directive.action === "invoke_agents_parallel") {
    return directive.state_id;
  }
  throw new Error(`expected worker directive, received '${directive.action}'`);
}

async function researchRouteScenario(input: {
  maxIterations: number;
  observerThrows: boolean;
}): Promise<{
  next: Directive;
  recovered: Directive;
  routePayload: Record<string, JsonValue>;
}> {
  const root = temporaryRoot();
  const checkpointer = new Checkpointer(
    path.join(root, "orchestration.db"),
    input.observerThrows
      ? () => {
          throw new Error("observability disabled by deterministic fixture");
        }
      : undefined
  );
  const artifacts = new ArtifactStore(path.join(root, "artifacts"));
  const engine = new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: 32,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactRevisions: artifacts,
    artifactStore: artifacts,
    artifactReader: artifacts,
  });
  const identity: RunIdentity = {
    schema_version: 2,
    run_id: `run-route-${input.maxIterations}-${input.observerThrows ? "off" : "on"}`,
    session_id: "session-route",
    playbook: "research",
    engine_owner: "typescript",
  };
  let current = engine.handle({
    schema_version: 2,
    action: "start",
    identity,
    goal: "Exercise engine-owned repair.",
    constraints: { mode: "quick", max_iterations: input.maxIterations },
    project_root: root,
    trust_profile: "trusted-interactive",
  });
  current = await stepWithSummary({
    engine,
    artifacts,
    projectRoot: root,
    directive: requireInvocation(current),
    details: { explore_complete: true },
  });
  // Typed semantic drafting now enters deterministic host projection immediately. This focused W5
  // fixture isolates the unchanged engine-owned validating route by placing the already-durable
  // post-research run at that registered evaluator boundary before Synthia is invoked.
  const validatingContext = checkpointer.loadRun(identity);
  validatingContext.transition("validating");
  current = research.dispatch(validatingContext);
  checkpointer.saveRun(validatingContext, "feedback_fixture_validating", {
    run_id: identity.run_id,
    state_id: "validating",
  });
  current = await stepWithSummary({
    engine,
    artifacts,
    projectRoot: root,
    directive: requireInvocation(current),
    details: {
      verdict: "FAIL",
      unsupported_claims: ["claim-body-must-not-enter-route-event"],
      evidence: [{ source: "fixture" }],
      evidence_needed: ["private-evidence-request-must-not-enter-route-event"],
    },
  });
  const event = [...checkpointer.events(identity.run_id)]
    .reverse()
    .find((candidate) => candidate.payload.feedback_route_evidence_v1 !== undefined);
  const routePayload = event?.payload.feedback_route_evidence_v1;
  if (routePayload === null || typeof routePayload !== "object" || Array.isArray(routePayload)) {
    throw new Error("route event has no typed evidence payload");
  }
  const restarted = new OrchestrationEngine(checkpointer, {
    projectRoot: root,
    maxSteps: 32,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
  });
  const recovered = restarted.handle({
    schema_version: 2,
    action: "recover",
    identity,
  });
  artifacts.close();
  checkpointer.close();
  return { next: current, recovered, routePayload };
}

describe("W5 typed evaluation and declared routes", () => {
  it("uses EvaluationResultV2 and rejects playbook-selected targets or exhaustion", () => {
    const valid = {
      schema_version: 2,
      kind: "evidence_gap",
      detail: "evidence is missing",
      findings: ["claim-1"],
      strategy_delta: "Gather the missing evidence.",
    };
    expect(() => validateContract(EvaluationResultV2Schema, valid, "evaluation")).not.toThrow();
    expect(() =>
      validateContract(
        EvaluationResultV2Schema,
        { ...valid, target_state: "researching" },
        "evaluation"
      )
    ).toThrow();
    expect(() =>
      validateContract(EvaluationResultV2Schema, { ...valid, exhausted: false }, "evaluation")
    ).toThrow();
  });

  it("exposes state-aware repair and produces every declared research and KB route", () => {
    expect(hasStateAwareRepair(research)).toBe(true);
    expect(hasStateAwareRepair(knowledgeBase)).toBe(true);

    const produced = new Set<string>();
    const evidence = research.evaluateRepair?.(
      researchContext({ researchRound: 0, maxResearchRounds: 2 }),
      "validating",
      {
        verdict: "FAIL",
        unsupported_claims: ["claim-1"],
        evidence_needed: ["source-1"],
      }
    );
    const synthesis = research.evaluateRepair?.(
      researchContext({ researchRound: 2, maxResearchRounds: 2 }),
      "validating",
      {
        verdict: "FAIL",
        unsupported_claims: ["claim-1"],
        evidence_needed: ["source-1"],
      }
    );
    if (evidence !== null && evidence !== undefined)
      produced.add(routeKey("validating", evidence.kind));
    if (synthesis !== null && synthesis !== undefined)
      produced.add(routeKey("validating", synthesis.kind));
    const quality = research.evaluateRepair?.(researchContext({}), "critiquing_report", {
      verdict: "NEEDS_REVISION",
      issues: ["quality"],
    });
    if (quality !== null && quality !== undefined) {
      produced.add(routeKey("critiquing_report", quality.kind));
    }

    const kbContext = knowledgeBaseContext();
    const lint = knowledgeBase.evaluateRepair(kbContext, "lint", {
      complete: true,
      blocking_count: 1,
    });
    const verify = knowledgeBase.evaluateRepair(kbContext, "verify", {
      complete: true,
      unsupported: 1,
    });
    if (lint !== null) produced.add(routeKey("lint", lint.kind));
    if (verify !== null) produced.add(routeKey("verify", verify.kind));
    for (const phase of KB_AGENT_PHASES) {
      const incomplete = knowledgeBase.evaluateRepair(kbContext, phase, { complete: false });
      if (incomplete !== null) produced.add(routeKey(phase, incomplete.kind));
    }

    const declared = [
      ...RESEARCH_SKILL_CONTRACT.repair_routing.routes,
      ...KNOWLEDGE_BASE_SKILL_CONTRACT.repair_routing.routes,
    ].map((route) => routeKey(route.origin_state, route.feedback_kind));
    expect([...produced].sort()).toEqual([...declared].sort());
  });

  it("fails registration on duplicate, unreachable, and invalid-target routes", () => {
    const shipped = resolvePlaybook("research");
    if (shipped === undefined) throw new Error("research registration unavailable");
    const first = shipped.contract.repair_routing.routes[0];
    if (first === undefined) throw new Error("research route unavailable");

    expect(() =>
      validateRegistrationContract({
        ...shipped,
        contract: {
          ...shipped.contract,
          repair_routing: {
            schema_version: 1,
            routes: [...shipped.contract.repair_routing.routes, structuredClone(first)],
          },
        },
      })
    ).toThrow(/duplicate repair route/);
    expect(() =>
      validateRegistrationContract({
        ...shipped,
        contract: {
          ...shipped.contract,
          repair_routing: {
            schema_version: 1,
            routes: [
              {
                ...structuredClone(first),
                origin_state: "not-a-registered-state",
              },
            ],
          },
        },
      })
    ).toThrow(/unreachable/);
    expect(() =>
      validateRegistrationContract({
        ...shipped,
        contract: {
          ...shipped.contract,
          repair_routing: {
            schema_version: 1,
            routes: [
              {
                ...structuredClone(first),
                repair: { ...first.repair, target_state: "not-a-registered-state" },
              },
            ],
          },
        },
      })
    ).toThrow(/not in 'research' state descriptor/);
  });
});

describe("W5 engine-owned state-aware repair", () => {
  it("rejects playbook bookkeeping that mutates engine-owned control fields", async () => {
    const root = temporaryRoot();
    using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const registry: PlaybookRegistryV1 = new Map([
      [MUTATING_REGISTRATION.name, MUTATING_REGISTRATION],
    ]);
    const engine = new OrchestrationEngine(checkpointer, {
      projectRoot: root,
      maxSteps: 16,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      playbookName: MUTATING_PLAYBOOK,
      playbookRegistry: registry,
    });
    const identity: RunIdentity = {
      schema_version: 2,
      run_id: "run-mutating-repair",
      session_id: "session-mutating-repair",
      playbook: MUTATING_PLAYBOOK,
      engine_owner: "typescript",
    };
    const pending = requireInvocation(
      engine.handle({
        schema_version: 2,
        action: "start",
        identity,
        goal: "Reject mutating bookkeeping.",
        constraints: {},
        project_root: root,
        trust_profile: "trusted-interactive",
      })
    );
    await expect(
      stepWithSummary({
        engine,
        artifacts,
        projectRoot: root,
        directive: pending,
        details: { needs_repair: true },
      })
    ).rejects.toThrow(/bookkeeping modified engine-owned control fields/);
    const durable = checkpointer.loadRun(identity);
    expect(durable.stateId).toBe("working");
    expect(durable.pendingDirective).toEqual(pending);
  });

  it("executes the declared retry and stores only digest route evidence", async () => {
    const routed = await researchRouteScenario({ maxIterations: 3, observerThrows: false });
    expect(workerState(routed.next)).toBe("researching");
    expect(canonicalJson(routed.recovered)).toBe(canonicalJson(routed.next));
    expect(routed.routePayload).toMatchObject({
      schema_version: 1,
      origin_state: "validating",
      feedback_kind: "evidence_gap",
      disposition: "repair",
      target_state: "researching",
      budget: {
        counter: "iteration",
        used_before: 0,
        limit: 3,
        used_after: 1,
      },
    });
    const eventBytes = canonicalJson(routed.routePayload);
    expect(eventBytes).not.toContain("claim-body-must-not-enter-route-event");
    expect(eventBytes).not.toContain("private-evidence-request-must-not-enter-route-event");
    expect(eventBytes).toMatch(/detail_sha256/);
    expect(eventBytes).toMatch(/strategy_delta_sha256/);
    expect(eventBytes).not.toContain("findings");
    expect(eventBytes).not.toContain('"strategy_delta"');
    expect(eventBytes).not.toContain('"detail"');
  });

  it("executes the declared exhaustion target and remains observability-independent", async () => {
    const observed = await researchRouteScenario({ maxIterations: 1, observerThrows: false });
    const disabled = await researchRouteScenario({ maxIterations: 1, observerThrows: true });
    expect(observed.next).toMatchObject({ action: "incomplete", met: false });
    expect(disabled.next).toMatchObject({ action: "incomplete", met: false });
    expect(observed.routePayload).toEqual(disabled.routePayload);
    expect(observed.routePayload).toMatchObject({
      disposition: "exhausted",
      target_state: "rendering",
      budget: { used_before: 0, limit: 1, used_after: 0 },
    });
    expect(canonicalJson(observed.recovered)).toBe(canonicalJson(observed.next));
    expect(canonicalJson(disabled.recovered)).toBe(canonicalJson(disabled.next));
  });
});

describe("P1.2 malformed routing remains isolated", () => {
  it("keeps malformed_result out of declarative repair routes", () => {
    expect(
      [
        ...RESEARCH_SKILL_CONTRACT.repair_routing.routes,
        ...KNOWLEDGE_BASE_SKILL_CONTRACT.repair_routing.routes,
      ].some((route) => route.feedback_kind === "malformed_result")
    ).toBe(false);
  });
});
