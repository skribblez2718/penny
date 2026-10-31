import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { Checkpointer, canonicalJson } from "../dist/checkpointer.js";
import {
  EvaluationResultSchema,
  validateContract,
  validateDirective,
  type Confidence,
  type Directive,
  type EvaluationResult,
  type JsonValue,
  type RunIdentity,
  type SkillContract,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import type { AgentCompletion, AgentInvocation, ModelClient } from "../dist/model-client.js";
import {
  hasStateAwareRepair,
  type PlaybookCore,
  type StateAwareRepairCapabilityV1,
} from "../dist/playbooks/playbook.js";
import {
  KB_AGENT_PHASES,
  KNOWLEDGE_BASE_SKILL_CONTRACT,
  KnowledgeBasePlaybook,
} from "../dist/playbooks/knowledge-base.js";
import {
  resolvePlaybook,
  validateRegistrationContract,
  type PlaybookRegistration,
  type PlaybookRegistry,
} from "../dist/playbooks/registry.js";
import {
  RESEARCH_SKILL_CONTRACT,
  ResearchPlaybook,
  researchSummarySchema,
} from "../dist/playbooks/research.js";
import { WorkerExecutor } from "../dist/worker.js";
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

const research = new ResearchPlaybook();
const knowledgeBase = new KnowledgeBasePlaybook();

function routeKey(originState: string, feedbackKind: string): string {
  return `${originState}:${feedbackKind}`;
}

class SummaryClient implements ModelClient {
  constructor(private readonly details: Record<string, JsonValue>) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    for (let index = 0; index < 6; index += 1) {
      invocation.liveness?.({ kind: "model_turn", source: "turn_start" });
    }
    return {
      text: `${invocation.executionPurpose === "routing_repair" ? "" : "deterministic fixture\n"}SUMMARY:${JSON.stringify(
        {
          confidence: "CERTAIN",
          ...this.details,
        }
      )}`,
    };
  }
}

const MUTATING_PLAYBOOK = "mutating-repair-fixture";

class MutatingRepairPlaybook implements PlaybookCore, StateAwareRepairCapabilityV1 {
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
  ): EvaluationResult | null {
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

const MUTATING_REGISTRATION: PlaybookRegistration = {
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

// W5 tests the shared router, not Research's sealed-product/review lifecycle. Use native
// classification/bookkeeping with explicit synthetic dispatch and no product fingerprint policy.
// Real Research must refuse a jump to Vera without host-validated product/evidence custody.
class FeedbackRoutingPlaybook implements PlaybookCore, StateAwareRepairCapabilityV1 {
  initialize(context: RunContext): Directive {
    context.research.max_sub_queries = 4;
    context.research.research_round = 1;
    context.transition("validating");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    const next =
      context.stateId === "rendering"
        ? validateDirective({
            schema_version: 2,
            action: "incomplete",
            identity: context.identity,
            status: "incomplete",
            met: false,
            result: {},
            artifacts: context.selectedArtifacts,
            unresolved: ["Synthetic evaluator exhausted its declared repair allowance."],
          })
        : validateDirective({
            schema_version: 2,
            action: "invoke_agent",
            identity: context.identity,
            state_id: context.stateId,
            agent: "fixture-agent",
            attempt: context.stepCount,
            trust_profile: context.trustProfile,
            task: "Return the declared W5 routing fixture SUMMARY.",
            input_artifacts: {
              schema_version: 2,
              artifacts: context.selectedArtifacts.map((ref, index) => ({
                slot: `source-${index}`,
                ref,
              })),
            },
            output_artifact: {
              schema_version: 2,
              run_id: context.identity.run_id,
              phase: context.stateId,
              branch_id: null,
              kind: "agent-output",
              operation_id: `feedback-${context.identity.run_id}-${context.stateId}`,
              version: 1,
              producer: "agent:fixture-agent",
              media_type: "text/plain; charset=utf-8",
              parent_ref: null,
              upstream_refs: context.selectedArtifacts,
            },
          });
    context.pendingDirective = next;
    if (next.action === "incomplete") {
      context.status = "incomplete";
      context.met = false;
      context.terminalDirective = next;
    }
    return next;
  }

  resume(_context: RunContext, _response: JsonValue): Directive {
    throw new Error("W5 fixture has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    return research.cancel(context, reason);
  }

  acceptSummary(): Directive {
    throw new Error("W5 failure must take the declared repair route");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }

  evaluateRepair(context: RunContext, state: string, details: Record<string, JsonValue>) {
    return research.evaluateRepair(context, state, details);
  }

  applyRepairBookkeeping(...args: Parameters<ResearchPlaybook["applyRepairBookkeeping"]>): void {
    research.applyRepairBookkeeping(...args);
  }
}

const FEEDBACK_REGISTRATION: PlaybookRegistration = {
  name: "feedback-routing-fixture",
  ingress: "dedicated_tool",
  liveness: {
    resolver_id: MUTATING_CONTRACT.budget_policy.resolver_id,
    resolve: () => undefined,
    thinking_policy: "agent_ssot",
  },
  contract: {
    ...MUTATING_CONTRACT,
    name: "feedback-routing-fixture",
    repair_routing: {
      schema_version: 1,
      routes: RESEARCH_SKILL_CONTRACT.repair_routing.routes.filter(
        (route) => route.origin_state === "validating"
      ),
    },
    completion_gate: {
      ...MUTATING_CONTRACT.completion_gate,
      allowed_terminal_origins: ["rendering"],
    },
  },
  // Deliberately omit repair_progress_policy: no native semantic candidate exists to measure.
  host_states: ["rendering"],
  worker: {
    kind: "catalog-agent",
    workflow_name: "feedback-routing-fixture",
    guidance: MUTATING_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: new Map(
      ["validating", "researching", "synthesizing"].map((state) => [
        state,
        {
          agent: "fixture-agent",
          result_schema_id: `penny.test.feedback-${state}-summary`,
          result_schema_version: 1,
          schema: researchSummarySchema(state),
          routing_repair_policy: "preserve_source_summary_v1",
        },
      ])
    ),
  },
  completionReceiptPredicates: new Map(),
  construct: () => new FeedbackRoutingPlaybook(),
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
    playbookName: FEEDBACK_REGISTRATION.name,
    playbookRegistry: new Map([[FEEDBACK_REGISTRATION.name, FEEDBACK_REGISTRATION]]),
  });
  const identity: RunIdentity = {
    schema_version: 2,
    run_id: `run-route-${input.maxIterations}-${input.observerThrows ? "off" : "on"}`,
    session_id: "session-route",
    playbook: FEEDBACK_REGISTRATION.name,
    engine_owner: "typescript",
  };
  let current = engine.handle({
    schema_version: 2,
    action: "start",
    identity,
    goal: "Exercise engine-owned repair.",
    constraints: { max_iterations: input.maxIterations },
    project_root: root,
    trust_profile: "trusted-interactive",
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
  const [source] = checkpointer.loadRun(identity).selectedArtifacts;
  if (source === undefined) throw new Error("accepted evaluator report was not retained");
  expect(Buffer.from(artifacts.readById(source.artifact_id)).toString("utf8")).toContain(
    "claim-body-must-not-enter-route-event"
  );
  if (current.action === "invoke_agent") {
    expect(current.input_artifacts.artifacts.map((input) => input.ref)).toEqual([source]);
  } else if (current.action === "incomplete") {
    expect(current.artifacts).toContainEqual(source);
  }
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
    playbookName: FEEDBACK_REGISTRATION.name,
    playbookRegistry: new Map([[FEEDBACK_REGISTRATION.name, FEEDBACK_REGISTRATION]]),
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
  it("uses EvaluationResult and rejects playbook-selected targets or exhaustion", () => {
    const valid = {
      schema_version: 2,
      kind: "evidence_gap",
      detail: "evidence is missing",
      findings: ["claim-1"],
      strategy_delta: "Gather the missing evidence.",
    };
    expect(() => validateContract(EvaluationResultSchema, valid, "evaluation")).not.toThrow();
    expect(() =>
      validateContract(
        EvaluationResultSchema,
        { ...valid, target_state: "researching" },
        "evaluation"
      )
    ).toThrow();
    expect(() =>
      validateContract(EvaluationResultSchema, { ...valid, exhausted: false }, "evaluation")
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
  it("keeps native Research pre-review custody refusal separate from the shared routing fixture", () => {
    const context = researchContext({});
    context.transition("validating");
    expect(research.dispatch(context)).toMatchObject({
      action: "incomplete",
      met: false,
      result: { incomplete_reason: "host_mechanical_validation_failed" },
    });
    expect(FEEDBACK_REGISTRATION.repair_progress_policy).toBeUndefined();
  });

  it("rejects playbook bookkeeping that mutates engine-owned control fields", async () => {
    const root = temporaryRoot();
    using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    const registry: PlaybookRegistry = new Map([
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
  it.each([false, true])(
    "retries repeated malformed metadata with original custody and exact recovery (parallel=%s)",
    async (parallel) => {
      const root = temporaryRoot();
      using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
      using artifacts = new ArtifactStore(path.join(root, "artifacts"));
      const engine = new OrchestrationEngine(checkpointer, {
        projectRoot: root,
        receiptAuthority: TEST_RECEIPT_AUTHORITY,
        artifactRevisions: artifacts,
        artifactStore: artifacts,
        artifactReader: artifacts,
      });
      const runIdentity: RunIdentity = {
        schema_version: 2,
        run_id: `run-metadata-repeat-${parallel}`,
        session_id: "session-metadata-repeat",
        playbook: "research",
        engine_owner: "typescript",
      };
      let current = engine.handle({
        schema_version: 2,
        action: "start",
        identity: runIdentity,
        goal: "Preserve semantic source while correcting metadata",
        constraints: { mode: parallel ? "quick" : "standard" },
        project_root: root,
        trust_profile: "trusted-interactive",
      });
      // Planning is a single assignment; Quick is a one-branch parallel fan.
      let sourceId: string | undefined;
      for (let index = 0; index < 5; index += 1) {
        const workers = new WorkerExecutor(new SummaryClient({ invalid_field: true }), artifacts, {
          projectRoot: root,
          parallelConcurrency: 1,
          registration: engine.registration,
        });
        workers.setReceiptAuthority(engine.receiptAuthority);
        workers.setLivenessController(engine.liveness);
        const results = await workers.execute(current);
        if (results.length !== 1) throw new Error("expected one malformed assignment");
        const result = results[0];
        if (result === undefined) throw new Error("missing malformed result");
        const next = engine.handle({
          schema_version: 2,
          action: "step",
          identity: runIdentity,
          result,
        });
        workers.acceptArtifact(result);
        const assignment =
          next.action === "invoke_agent"
            ? next
            : next.action === "invoke_agents_parallel"
              ? next.branches[0]
              : undefined;
        if (assignment?.routing_repair_binding === undefined)
          throw new Error(`metadata attempt ${index} terminated: ${next.action}`);
        const binding = assignment.routing_repair_binding;
        if (sourceId === undefined) sourceId = binding.source_artifact_ref.artifact_id;
        expect(binding.source_artifact_ref.artifact_id).toBe(sourceId);
        expect(assignment.output_artifact.version).toBe(index + 1);
        expect(assignment.input_artifacts.artifacts.map((input) => input.ref.artifact_id)).toEqual([
          sourceId,
        ]);
        expect(
          engine.handle({ schema_version: 2, action: "recover", identity: runIdentity })
        ).toEqual(next);
        current = next;
      }
      const details = parallel
        ? { explore_complete: true }
        : { plan_complete: true, plan_steps: ["one query"] };
      const workers = new WorkerExecutor(new SummaryClient(details), artifacts, {
        projectRoot: root,
        parallelConcurrency: 1,
        registration: engine.registration,
      });
      workers.setReceiptAuthority(engine.receiptAuthority);
      workers.setLivenessController(engine.liveness);
      const [result] = await workers.execute(current);
      if (result === undefined) throw new Error("corrected metadata absent");
      const next = engine.handle({
        schema_version: 2,
        action: "step",
        identity: runIdentity,
        result,
      });
      workers.acceptArtifact(result);
      expect(next.action).toBe(parallel ? "invoke_agent" : "invoke_agents_parallel");
      expect(checkpointer.loadRun(runIdentity).maxSteps).toBeNull();
      expect(engine.liveness.snapshot(runIdentity.run_id)).toMatchObject({
        malformed_results: 5,
        repair_invocations: 5,
      });
      const cancelled = engine.handle({
        schema_version: 2,
        action: "cancel",
        identity: runIdentity,
        reason: "operator stop",
      });
      expect(cancelled).toMatchObject({ action: "cancelled", met: false });
      expect(
        engine.handle({ schema_version: 2, action: "recover", identity: runIdentity })
      ).toEqual(cancelled);
    }
  );

  it("keeps malformed_result out of declarative repair routes", () => {
    expect(
      [
        ...RESEARCH_SKILL_CONTRACT.repair_routing.routes,
        ...KNOWLEDGE_BASE_SKILL_CONTRACT.repair_routing.routes,
      ].some((route) => route.feedback_kind === "malformed_result")
    ).toBe(false);
  });
});
