import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLAN_CANDIDATE_REGISTRATION,
  PLAN_PLAYBOOK_NAME,
  PLAN_UNSEALED_EVALUATION_NAME,
  PLAN_UNSEALED_EVALUATION_REGISTRATION,
  OrchestrationService,
  PlanPlaybook,
  canonicalJson,
  initializePennyState,
  validateEvidenceAdmission,
  validateReviewReceipt,
  validateStrategy,
  validateStrategyProductEnvelope,
  validateStrategyProductIntegrity,
  type AgentCompletion,
  type AgentInvocation,
  type Directive,
  type JsonValue,
  type ModelClient,
  type PlanRequestConstraintsV1,
  type PlaybookRegistrationV1,
  type StrategyCoreV1,
} from "../src/index.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
let sequence = 0;

function environment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-plan-playbook-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return env;
}

function constraints(): PlanRequestConstraintsV1 {
  return {
    schema_version: 1,
    desired_outcomes: ["A safe transition is ready.", "Rollback remains possible."],
    current_state: { status: "provided", facts: ["The current system is active."] },
    hard_constraints: ["Do not execute the transition."],
    non_goals: ["Do not create executor tasks."],
    known_uncertainties: [{ statement: "The transition window may move.", material: true }],
    prior_decisions: [
      { statement: "Retain the current platform.", binding_effect: "No platform migration." },
    ],
  };
}

function core(disposition: "ready" | "blocked" | "not_applicable" = "ready"): StrategyCoreV1 {
  const emptyCoverage = {
    current_state_fact_indexes: [],
    input_artifact_slots: [],
    hard_constraint_indexes: [],
    non_goal_indexes: [],
    uncertainty_indexes: [],
    prior_decision_indexes: [],
    blocked_desired_outcome_indexes: [],
  };
  if (disposition === "not_applicable") {
    return {
      schema_version: 1,
      disposition,
      applicability_reason: "No planning work applies to the already achieved goal.",
      outcomes: [],
      dependencies: [],
      request_coverage: emptyCoverage,
      blockers: [],
      confidence: "CERTAIN",
    };
  }
  const ready: StrategyCoreV1 = {
    schema_version: 1,
    disposition,
    applicability_reason: "The supplied request requires a bounded strategy.",
    outcomes: [
      {
        statement: "Transition readiness is established.",
        desired_outcome_indexes: [0],
        success_signal: "Readiness evidence is complete.",
      },
      {
        statement: "Rollback viability is retained.",
        desired_outcome_indexes: [1],
        success_signal: "Rollback evidence remains valid.",
      },
    ],
    dependencies: [{ from_outcome_index: 0, to_outcome_index: 1, kind: "informational" }],
    request_coverage: {
      current_state_fact_indexes: [0],
      input_artifact_slots: [],
      hard_constraint_indexes: [0],
      non_goal_indexes: [0],
      uncertainty_indexes: [0],
      prior_decision_indexes: [0],
      blocked_desired_outcome_indexes: [],
    },
    blockers: [],
    confidence: "PROBABLE",
  };
  if (disposition === "ready") return ready;
  const firstOutcome = ready.outcomes[0];
  if (firstOutcome === undefined) throw new Error("ready strategy first outcome is absent");
  return {
    ...ready,
    disposition: "blocked",
    outcomes: [firstOutcome],
    dependencies: [],
    request_coverage: { ...ready.request_coverage, blocked_desired_outcome_indexes: [1] },
    blockers: ["Rollback access is unavailable."],
    confidence: "POSSIBLE",
  };
}

function persistedStrategy(value: StrategyCoreV1): string {
  return `The strategy covers outcomes, dependencies, assumptions, risks, information gaps, constraints, non-goals, contingencies, trade-offs, and disposition.\nSTRATEGY_CORE:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
}

function identity(runId: string, playbook = PLAN_PLAYBOOK_NAME) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook,
    engine_owner: "typescript" as const,
  };
}

function start(runId: string, playbook = PLAN_PLAYBOOK_NAME) {
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId, playbook),
    goal: "Form a safe transition strategy without execution.",
    constraints: constraints(),
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}

class ScriptedPlanClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private next = 0;

  constructor(private readonly outputs: readonly string[]) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const output = this.outputs[this.next];
    this.next += 1;
    if (output === undefined) throw new Error("scripted Plan output is exhausted");
    return { text: output };
  }
}

type TerminalDirective = Extract<Directive, { result: Record<string, JsonValue> }>;

function completeDirective(value: Directive): TerminalDirective {
  if (value.action !== "complete") {
    throw new Error(`expected complete directive, received '${value.action}'`);
  }
  return value;
}

function outputRef(value: TerminalDirective) {
  const ref = value.result.output_artifact_ref;
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
    throw new Error("terminal output ref is absent");
  }
  return ref;
}

function summary(details: Record<string, JsonValue>): string {
  return `Report body.\nSUMMARY:${JSON.stringify({ confidence: "PROBABLE", ...details })}`;
}

function routingOnly(output: string): string {
  const marker = output.lastIndexOf("SUMMARY:");
  if (marker < 0) throw new Error("scripted routing summary is absent");
  return output.slice(marker);
}

function orientationPass(
  label = "Goal, current state, constraints, and dependencies mapped."
): string {
  return summary({
    orientation_complete: true,
    gap_kind: "none",
    repair_owner: "none",
    findings: [label],
    strategy_delta: "Proceed with bounded strategy authorship.",
  });
}

function orientationEvidenceGap(): string {
  return summary({
    orientation_complete: false,
    gap_kind: "evidence_gap",
    repair_owner: "echo",
    findings: ["The admitted migration evidence must be inspected."],
    strategy_delta: "Inspect the exact admitted source only.",
  });
}

function evidencePacket(): string {
  return summary({
    evidence_complete: false,
    findings: ["The admitted source does not resolve rollback access."],
    unresolved: ["Rollback access remains unavailable."],
  });
}

function veraPass(): string {
  return summary({
    verdict: "PASS",
    gap_kind: "none",
    repair_owner: "none",
    findings: [],
    evidence: ["Exact latest StrategyV1 satisfies request and lineage checks."],
    strategy_delta: "Advance the exact product to quality critique.",
  });
}

function veraGap(kind: "evidence_gap" | "analysis_gap" | "product_gap"): string {
  return summary({
    verdict: "FAIL",
    gap_kind: kind,
    repair_owner: kind === "evidence_gap" ? "echo" : "piper",
    findings: [`Vera found a ${kind}.`],
    evidence: ["Exact latest product check failed."],
    strategy_delta: `Repair the ${kind} and preserve exact lineage.`,
  });
}

function carrenApprove(minor = false): string {
  return summary({
    verdict: "APPROVE",
    gap_kind: "none",
    repair_owner: "none",
    findings: minor ? [{ severity: "minor", message: "One phrase could be shorter." }] : [],
    evidence: ["The Vera-passed strategy is coherent and strategy-useful."],
    strategy_delta: "Approve the exact latest product.",
  });
}

function carrenGap(kind: "evidence_gap" | "analysis_gap" | "product_gap"): string {
  return summary({
    verdict: "NEEDS_REVISION",
    gap_kind: kind,
    repair_owner: kind === "evidence_gap" ? "echo" : "piper",
    findings: [{ severity: "major", message: `Carren found a ${kind}.` }],
    evidence: ["The exact latest product has a material quality defect."],
    strategy_delta: `Repair the ${kind} before another complete review cycle.`,
  });
}

function readJson(service: OrchestrationService, artifactId: string): unknown {
  return JSON.parse(service.artifacts.readById(artifactId).toString("utf8"));
}

function happyOutputs(disposition: Parameters<typeof core>[0] = "ready") {
  return [orientationPass(), persistedStrategy(core(disposition)), veraPass(), carrenApprove(true)];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider-free orchestrated plan candidate", () => {
  it.each(["ready", "blocked", "not_applicable"] as const)(
    "completes a reviewed canonical %s StrategyV1 and exact product envelope",
    async (disposition) => {
      const client = new ScriptedPlanClient(happyOutputs(disposition));
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
      });
      sequence += 1;
      const terminal = completeDirective(
        await service.execute(start(`run-plan-${disposition}-${sequence}`))
      );
      const ref = outputRef(terminal);
      expect(ref).toMatchObject({
        phase: "sealing_strategy",
        kind: "strategy",
        producer: "host:strategy-sealer",
        content_schema: { schema_id: "penny.strategy.v1", schema_version: 1 },
      });
      expect(validateStrategy(readJson(service, String(ref.artifact_id)))).toMatchObject({
        disposition,
        execution_started: false,
      });
      expect(terminal).toMatchObject({
        action: "complete",
        met: true,
        unresolved: [],
        result: { execution_started: false, execution_authorized: false },
      });
      expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
        "orienting_strategy",
        "strategizing",
        "verifying_strategy",
        "critiquing_strategy",
      ]);
      expect(client.invocations.map((invocation) => invocation.agent)).toEqual([
        "piper",
        "piper",
        "vera",
        "carren",
      ]);
      expect(client.invocations[1]?.inputArtifacts.map((artifact) => artifact.phase)).toEqual(
        expect.arrayContaining(["intake", "orienting_strategy"])
      );
      expect(client.invocations[2]?.inputArtifacts.map((artifact) => artifact.phase)).toEqual(
        expect.arrayContaining(["intake", "orienting_strategy", "strategizing", "sealing_strategy"])
      );
      expect(client.invocations[3]?.inputArtifacts.map((artifact) => artifact.phase)).toEqual(
        expect.arrayContaining([
          "intake",
          "orienting_strategy",
          "strategizing",
          "sealing_strategy",
          "verifying_strategy",
        ])
      );
      const admission = terminal.artifacts.find(
        (artifact) => artifact.kind === "evidence-admission"
      );
      const validity = terminal.artifacts.find(
        (artifact) => artifact.kind === "review-receipt" && artifact.branch_id === "validity"
      );
      const quality = terminal.artifacts.find(
        (artifact) => artifact.kind === "review-receipt" && artifact.branch_id === "quality"
      );
      const integrity = terminal.artifacts.find(
        (artifact) => artifact.kind === "strategy-product-integrity"
      );
      const envelope = terminal.artifacts.find(
        (artifact) => artifact.kind === "strategy-product-envelope"
      );
      if (
        admission === undefined ||
        validity === undefined ||
        quality === undefined ||
        integrity === undefined ||
        envelope === undefined
      ) {
        throw new Error("exact reviewed strategy graph is incomplete");
      }
      expect(validateEvidenceAdmission(readJson(service, admission.artifact_id))).toMatchObject({
        domain: "strategy",
        classification: "basis_sufficient",
        evidence_required: false,
        source_artifact_ref: { phase: "orienting_strategy" },
      });
      expect(validateReviewReceipt(readJson(service, validity.artifact_id))).toMatchObject({
        review_kind: "validity",
        reviewer: "vera",
        verdict: "PASS",
      });
      expect(validateReviewReceipt(readJson(service, quality.artifact_id))).toMatchObject({
        review_kind: "quality",
        reviewer: "carren",
        verdict: "APPROVE",
        prior_review_receipt_ref: { artifact_id: validity.artifact_id },
      });
      const integrityValue = validateStrategyProductIntegrity(
        readJson(service, integrity.artifact_id)
      );
      expect(integrityValue).toMatchObject({
        status: "PASS",
        strategy_ref: { artifact_id: ref.artifact_id },
        execution_started: false,
        execution_authorized: false,
        admission_ref: { artifact_id: admission.artifact_id },
      });
      expect(() =>
        validateStrategyProductIntegrity({ ...integrityValue, checks: ["canonical_strategy"] })
      ).toThrow(/checks/u);
      expect(() =>
        validateStrategyProductIntegrity({
          ...integrityValue,
          execution_receipt_ids: [
            integrityValue.execution_receipt_ids[0],
            integrityValue.execution_receipt_ids[0],
          ],
        })
      ).toThrow(/duplicate/u);
      expect(
        validateStrategyProductEnvelope(readJson(service, envelope.artifact_id))
      ).toMatchObject({
        status: "complete",
        strategy_ref: { artifact_id: ref.artifact_id },
        integrity_ref: { artifact_id: integrity.artifact_id },
      });
      expect(service.checkpointer.completionAdmission(terminal.identity.run_id)).toBeDefined();
    }
  );

  it("routes one closed Piper evidence gap through Echo using admitted refs only", async () => {
    const client = new ScriptedPlanClient([
      orientationEvidenceGap(),
      evidencePacket(),
      persistedStrategy(core("blocked")),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(start(`run-plan-evidence-gap-${sequence}`))
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "orienting_strategy",
      "gathering_strategy_evidence",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    expect(client.invocations[1]).toMatchObject({ agent: "echo" });
    expect(client.invocations[1]?.task).toContain(
      "narrowly targeted read-only local inspection or web retrieval"
    );
    expect(client.invocations[1]?.task).toContain("Record a precise source locator");
    expect(client.invocations[1]?.task).toContain("report the gap honestly as unresolved");
    expect(client.invocations[1]?.inputArtifacts.map((artifact) => artifact.phase)).toContain(
      "strategy_evidence_gate"
    );
    expect(client.invocations[2]?.inputArtifacts.map((artifact) => artifact.phase)).toEqual(
      expect.arrayContaining(["strategy_evidence_gate", "gathering_strategy_evidence"])
    );
    const admission = terminal.artifacts.find((artifact) => artifact.kind === "evidence-admission");
    if (admission === undefined) throw new Error("strategy evidence admission is absent");
    expect(validateEvidenceAdmission(readJson(service, admission.artifact_id))).toMatchObject({
      classification: "strategy_blocking_evidence_gap",
      evidence_required: true,
    });
    expect(
      validateStrategy(readJson(service, String(outputRef(terminal).artifact_id))).disposition
    ).toBe("blocked");
  });

  it("routes Vera product_gap to Piper, reseals version 2, and re-verifies before Carren", async () => {
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core("ready")),
      veraGap("product_gap"),
      persistedStrategy(core("blocked")),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(start(`run-plan-vera-product-gap-${sequence}`))
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    expect(outputRef(terminal)).toMatchObject({ version: 2 });
    expect(
      validateStrategy(readJson(service, String(outputRef(terminal).artifact_id))).disposition
    ).toBe("blocked");
  });

  it("routes Carren analysis_gap to Piper orientation and invalidates the prior receipt chain", async () => {
    const client = new ScriptedPlanClient([
      orientationPass("Initial orientation."),
      persistedStrategy(core()),
      veraPass(),
      carrenGap("analysis_gap"),
      orientationPass("Replacement orientation repairs the quality gap."),
      persistedStrategy(core()),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(start(`run-plan-carren-analysis-gap-${sequence}`))
    );
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    expect(outputRef(terminal)).toMatchObject({ version: 2 });
    expect(
      terminal.artifacts.filter(
        (artifact) => artifact.kind === "review-receipt" && artifact.branch_id === "validity"
      )
    ).toHaveLength(1);
    expect(
      terminal.artifacts.find(
        (artifact) => artifact.kind === "review-receipt" && artifact.branch_id === "validity"
      )
    ).toMatchObject({ version: 2 });
  });

  it("does not accept Carren APPROVE when a major finding is present", async () => {
    const majorApprove = summary({
      verdict: "APPROVE",
      gap_kind: "none",
      repair_owner: "none",
      findings: [{ severity: "major", message: "Material framing defect." }],
      evidence: ["The strategy overstates readiness."],
      strategy_delta: "Piper must repair the product framing.",
    });
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core()),
      veraPass(),
      majorApprove,
      routingOnly(carrenGap("product_gap")),
      persistedStrategy(core()),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(start(`run-plan-major-approve-${sequence}`))
    );
    expect(client.invocations[4]).toMatchObject({
      stateId: "critiquing_strategy",
      executionPurpose: "routing_repair",
    });
    expect(outputRef(terminal)).toMatchObject({ version: 2 });
  });

  it("recovers after host sealing persistence and continues the exact review graph", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistrationV1 = {
      ...PLAN_CANDIDATE_REGISTRATION,
      construct: (options) =>
        new PlanPlaybook(
          true,
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "sealing_strategy:artifact-persistence") {
              interrupted = true;
              throw new Error("injected host interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-plan-recover-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedPlanClient([orientationPass(), persistedStrategy(core())]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(/injected host interruption/u);
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_strategy");
    }
    const recoveredClient = new ScriptedPlanClient([veraPass(), carrenApprove()]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: recoveredClient,
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    const terminal = completeDirective(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    expect(outputRef(terminal)).toMatchObject({ kind: "strategy", version: 1 });
    expect(recoveredClient.invocations.map((invocation) => invocation.stateId)).toEqual([
      "verifying_strategy",
      "critiquing_strategy",
    ]);
  });

  it("terminalizes repeated product gaps when the finite repair budget is exhausted", async () => {
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core()),
      veraGap("product_gap"),
      persistedStrategy(core()),
      veraGap("product_gap"),
      persistedStrategy(core()),
      veraGap("product_gap"),
      persistedStrategy(core()),
      veraGap("product_gap"),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-plan-repair-exhaust-${sequence}`));
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: {
        execution_started: false,
        execution_authorized: false,
        incomplete_reason: "repair_budget_exhausted",
        exhausted: true,
        exhaustion_reason: "verifying_strategy:product_gap",
      },
    });
    expect(
      client.invocations.filter((invocation) => invocation.stateId === "strategizing")
    ).toHaveLength(4);
    expect(
      client.invocations.some((invocation) => invocation.stateId === "critiquing_strategy")
    ).toBe(false);
  });

  it.each([
    {
      reason: "model_turn_budget_exhausted" as const,
      result: {
        incomplete_reason: "model_turn_budget_exhausted",
        exhausted: true,
        exhaustion_reason: "model_turn_budget_exhausted",
      },
    },
    {
      reason: "identical_error_stall" as const,
      result: {
        incomplete_reason: "identical_error_stall",
        stalled: true,
        stall_reason: "identical_error_stall",
      },
    },
  ])("preserves exact typed liveness reason $reason on incomplete", ({ reason, result }) => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedPlanClient([]),
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-plan-liveness-${reason}-${sequence}`;
    expect(service.handle(start(runId))).toMatchObject({ action: "invoke_agent" });
    const terminal = service.engine.exhaust(identity(runId), reason);
    expect(terminal).toMatchObject({
      action: "incomplete",
      status: "incomplete",
      met: false,
      result: {
        ...result,
        liveness: { terminal_reason: reason },
      },
      unresolved: [reason],
    });
  });

  it("declares every engine-owned closed repair route without a clarification action", () => {
    const contract = PLAN_CANDIDATE_REGISTRATION.contract;
    expect(contract.behavior.stopping).toEqual({
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "incomplete",
    });
    expect(canonicalJson(contract)).not.toMatch(/await_user|awaiting_user/iu);
    const routes = contract.repair_routing.routes;
    expect(
      routes.map(
        (route) => `${route.origin_state}:${route.feedback_kind}->${route.repair.target_state}`
      )
    ).toEqual([
      "orienting_strategy:evidence_gap->strategy_evidence_gate",
      "verifying_strategy:evidence_gap->orienting_strategy",
      "verifying_strategy:analysis_gap->orienting_strategy",
      "verifying_strategy:product_gap->strategizing",
      "critiquing_strategy:evidence_gap->orienting_strategy",
      "critiquing_strategy:analysis_gap->orienting_strategy",
      "critiquing_strategy:product_gap->strategizing",
    ]);
    expect(routes.every((route) => route.on_exhaustion.target_state === "incomplete")).toBe(true);
    expect(routes.every((route) => route.on_exhaustion.reset_counter === false)).toBe(true);
  });

  it("fails closed when active or terminal replay uses a drifted candidate registration contract", async () => {
    const env = environment();
    sequence += 1;
    let activeIdentity: Directive["identity"];
    let terminal: TerminalDirective;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedPlanClient(happyOutputs("ready")),
        playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
      });
      const active = service.handle(start(`run-plan-active-contract-binding-${sequence}`));
      expect(active.action).toBe("invoke_agent");
      activeIdentity = active.identity;
      terminal = completeDirective(
        await service.execute(start(`run-plan-terminal-contract-binding-${sequence}`))
      );
    }
    const drifted: PlaybookRegistrationV1 = {
      ...PLAN_CANDIDATE_REGISTRATION,
      contract: {
        ...PLAN_CANDIDATE_REGISTRATION.contract,
        objective: `${PLAN_CANDIDATE_REGISTRATION.contract.objective} Drift fixture.`,
      },
    };
    using replay = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedPlanClient([]),
      playbookRegistration: drifted,
    });
    for (const identity of [activeIdentity, terminal.identity]) {
      for (const action of ["status", "recover"] as const) {
        expect(await replay.execute({ schema_version: 2, action, identity })).toMatchObject({
          action: "error",
          result: { code: "REGISTRATION_CONTRACT_MISMATCH", checkpoint_unchanged: true },
        });
      }
    }
  });

  it("retains the Piper-only unsealed ablation without review semantics", async () => {
    const client = new ScriptedPlanClient([persistedStrategy(core())]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_UNSEALED_EVALUATION_REGISTRATION,
    });
    sequence += 1;
    const terminal = completeDirective(
      await service.execute(start(`run-plan-unsealed-${sequence}`, PLAN_UNSEALED_EVALUATION_NAME))
    );
    expect(outputRef(terminal)).toMatchObject({ kind: "strategy-draft", phase: "strategizing" });
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual(["strategizing"]);
    expect(terminal.artifacts.some((artifact) => artifact.kind === "review-receipt")).toBe(false);
  });

  it("rejects a stale semantic input before RunContext creation", () => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedPlanClient([]),
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    const prior = service.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "prior-decide-run",
        phase: "sealing_decision",
        branch_id: null,
        kind: "semantic-core",
        operation_id: "prior-decision",
        version: 1,
        producer: "host:decision-sealer",
        media_type: "application/json",
        content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: "{}",
    });
    sequence += 1;
    const runId = `run-plan-stale-input-${sequence}`;
    expect(() =>
      service.handle({
        ...start(runId),
        input_artifacts: {
          schema_version: 2,
          artifacts: [
            { slot: "prior_decision", ref: { ...prior, content_digest: "0".repeat(64) } },
          ],
        },
      })
    ).toThrow(/COMPOSITION_ARTIFACT_STALE/u);
    expect(service.checkpointer.loadRunById(runId)).toBeUndefined();
  });

  it("cancels without dispatch and exposes no execution or approval state", () => {
    const client = new ScriptedPlanClient([]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_CANDIDATE_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-plan-cancel-${sequence}`;
    expect(service.handle(start(runId))).toMatchObject({
      action: "invoke_agent",
      state_id: "orienting_strategy",
      agent: "piper",
    });
    const cancelled = service.handle({
      schema_version: 2,
      action: "cancel",
      identity: identity(runId),
      reason: "caller stopped planning",
    });
    expect(cancelled).toMatchObject({
      action: "cancelled",
      met: false,
      result: { execution_started: false, execution_authorized: false },
    });
    expect(canonicalJson(PLAN_CANDIDATE_REGISTRATION.contract)).not.toMatch(
      /tabitha|task_graph|execution_state|approval_state|approval_gate|approval_product|sandbox enforcement/iu
    );
    expect(client.invocations).toHaveLength(0);
  });
});
