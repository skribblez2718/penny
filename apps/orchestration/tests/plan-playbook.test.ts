import { explicitSealPolicy } from "./helpers/explicit-cycle-policy.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArtifactRefSchema,
  PLAN_PLAYBOOK_REGISTRATION,
  PLAN_PLAYBOOK_NAME,
  OrchestrationService,
  PlanPlaybook,
  canonicalJson,
  validateContract,
  sha256,
  trustedInvocationDigest,
  initializePennyState,
  validateEvidenceAdmission,
  validatePlanRequest,
  validateReviewReceipt,
  specificationStrategySourceItems,
  validateStrategyV2,
  validateStrategyProductEnvelope,
  validateStrategyProductIntegrity,
  type AgentCompletion,
  type AgentInvocation,
  type Directive,
  type InputArtifacts,
  type JsonValue,
  type ModelClient,
  type PlanRequestConstraintsV1,
  type PlaybookRegistration,
  type StrategyCoreV2,
  validateCompositionAssurance,
} from "../dist/index.js";
import {
  genericSpecificationFixture,
  persistedSpecificationDraftV3,
} from "./fixtures/define-fixtures.js";
import { defineRequestConstraints } from "../dist/skill-contracts/define.js";
import { planCurrentSealDiagnosticRef } from "../dist/playbooks/plan.js";
import { persistEvidenceContext } from "./helpers/evidence-context.js";

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

function core(disposition: "ready" | "blocked" | "not_applicable" = "ready"): StrategyCoreV2 {
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
      schema_version: 2,
      disposition,
      applicability_reason: "No planning work applies to the already achieved goal.",
      outcomes: [],
      dependencies: [],
      request_coverage: emptyCoverage,
      blockers: [],
      confidence: "CERTAIN",
      source_item_coverage: [],
      unsupported_strategy_elements: [],
    };
  }
  const ready: StrategyCoreV2 = {
    schema_version: 2,
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
    source_item_coverage: [],
    unsupported_strategy_elements: [],
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

function coreWithSpecification(): StrategyCoreV2 {
  const specification = genericSpecificationFixture().specification;
  const requiredIndexes = specificationStrategySourceItems(specification).flatMap((entry, index) =>
    entry.required ? [index] : []
  );
  const base = core("ready");
  return {
    ...base,
    request_coverage: { ...base.request_coverage, input_artifact_slots: [0] },
    source_item_coverage: requiredIndexes.map((sourceItemIndex) => ({
      source_item_index: sourceItemIndex,
      disposition: "addressed" as const,
      strategy_outcome_indexes: [0, 1],
      rationale: "The specification source item is preserved by the readiness outcomes.",
    })),
    unsupported_strategy_elements: [],
  };
}

function persistedStrategy(value: StrategyCoreV2): string {
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

function start(runId: string, playbook = PLAN_PLAYBOOK_NAME, inputArtifacts?: InputArtifacts) {
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId, playbook),
    goal: "Form a safe transition strategy without execution.",
    constraints: constraints(),
    ...(inputArtifacts === undefined ? {} : { input_artifacts: inputArtifacts }),
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
  };
}

class ScriptedPlanClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  onInvocation?: () => void;
  private next = 0;

  constructor(private readonly outputs: readonly string[]) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    this.onInvocation?.();
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
    evidence: ["Exact latest StrategyV2 satisfies request and lineage checks."],
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

async function reachState(
  service: OrchestrationService,
  runId: string,
  target: string,
  inputArtifacts?: InputArtifacts
): Promise<Directive> {
  let next = service.engine.handle(start(runId, PLAN_PLAYBOOK_NAME, inputArtifacts));
  while (next.action === "invoke_agent" && next.state_id !== target) {
    const [result] = await service.workers.execute(next);
    if (result === undefined) throw new Error("worker result absent");
    next = service.engine.handle({
      schema_version: 2,
      action: "step",
      identity: identity(runId),
      result,
    });
  }
  if (next.action !== "invoke_agent" || next.state_id !== target)
    throw new Error(`expected ${target}`);
  return next;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider-free orchestrated plan workflow", () => {
  it("carries a completed stage-3 Define through strict Plan reviews, integrity, envelope and completion", async () => {
    const env = environment();
    const fixture = genericSpecificationFixture();
    const defineOutputs = [
      `Framed.\nSUMMARY:${canonicalJson({
        confidence: "CERTAIN",
        orientation_complete: true,
        gap_kind: "none",
        repair_owner: "none",
        selected_profile_id: "generic",
        profile_selection_basis: "Caller requested generic.",
        route: "author",
        route_reason: "No outstanding question.",
        clarification_questions: [],
        evidence_questions: [],
        findings: [],
        specification_delta: "Preserve caller boundaries.",
      })}`,
      Buffer.from(persistedSpecificationDraftV3(fixture.draft)).toString("utf8"),
      `Valid.\nSUMMARY:${canonicalJson({
        confidence: "CERTAIN",
        verdict: "PASS",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["Exact source checked."],
        specification_delta: "No change required.",
      })}`,
      `Usable.\nSUMMARY:${canonicalJson({
        confidence: "CERTAIN",
        verdict: "APPROVE",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["Latest specification checked."],
        specification_delta: "No revision required.",
      })}`,
    ];
    using producer = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "define",
      modelClient: new ScriptedPlanClient(defineOutputs),
    });
    const defined = completeDirective(
      await producer.execute({
        schema_version: 2,
        action: "start",
        identity: identity("wp8-reviewed-define", "define"),
        goal: fixture.request.goal,
        constraints: {
          schema_version: 2,
          request: defineRequestConstraints(fixture.request),
          specification_assurance: "semantic_only",
        },
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      })
    );
    const spec = defined.artifacts.find((ref) => ref.kind === "specification");
    if (spec === undefined) throw new Error("completed Define omitted its specification");
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(coreWithSpecification()),
      veraPass(),
      carrenApprove(),
    ]);
    using consumer = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      playbookName: "plan",
      modelClient: client,
    });
    const strictStart = {
      ...start("wp8-reviewed-plan", PLAN_PLAYBOOK_NAME, {
        schema_version: 2,
        artifacts: [{ slot: "prior_specification", ref: spec }],
      }),
      constraints: {
        schema_version: 2,
        request: constraints(),
        specification_assurance: "reviewed_definition" as const,
      },
    };
    const planned = completeDirective(await consumer.execute(strictStart));
    const assuranceRef = planned.artifacts.find((ref) => ref.kind === "composition-assurance");
    if (assuranceRef === undefined) throw new Error("Plan omitted its assurance graph");
    expect(
      validateCompositionAssurance(readJson(consumer, assuranceRef.artifact_id))
    ).toMatchObject({
      mode: "reviewed_definition",
      specification_ref: spec,
      producer: { run_id: "wp8-reviewed-define" },
    });
    const validity = planned.artifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "validity"
    );
    const quality = planned.artifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "quality"
    );
    const integrity = planned.artifacts.find((ref) => ref.kind === "strategy-product-integrity");
    const envelope = planned.artifacts.find((ref) => ref.kind === "strategy-product-envelope");
    if (
      validity === undefined ||
      quality === undefined ||
      integrity === undefined ||
      envelope === undefined
    )
      throw new Error("Plan omitted its reviewed completion graph");
    for (const receipt of [validity, quality])
      expect(validateReviewReceipt(readJson(consumer, receipt.artifact_id)).subject).toMatchObject({
        specification_assurance_ref: assuranceRef,
      });
    expect(
      validateStrategyProductIntegrity(readJson(consumer, integrity.artifact_id))
    ).toMatchObject({ specification_assurance_ref: assuranceRef });
    expect(validateStrategyProductEnvelope(readJson(consumer, envelope.artifact_id))).toMatchObject(
      { specification_assurance_ref: assuranceRef }
    );
    const verifier = client.invocations.find((entry) => entry.stateId === "verifying_strategy");
    const sourceIndex = planned.artifacts.find(
      (ref) => ref.kind === "plan-specification-source-index"
    );
    if (verifier === undefined || sourceIndex === undefined)
      throw new Error("strict Plan mechanical evidence inputs absent");
    const statement = verifier.task
      .split("\n")
      .find((line) => line.startsWith("HOST_MECHANICAL_CHECKS:"));
    if (statement === undefined) throw new Error("strict Plan mechanical evidence absent");
    expect(statement).toContain(canonicalJson(assuranceRef));
    expect(statement).toContain(canonicalJson(sourceIndex));
    expect(statement).toContain('"specification_source_index"');
    expect(statement).toContain('"specification_assurance_binding"');
    expect(consumer.checkpointer.completionAdmission("wp8-reviewed-plan")).toBeDefined();
    expect(consumer.engine.handle(strictStart)).toEqual(planned);
    expect(() =>
      consumer.engine.handle({
        ...strictStart,
        constraints: { ...strictStart.constraints, specification_assurance: "semantic_only" },
      })
    ).toThrow("SPECIFICATION_ASSURANCE_BINDING_INVALID");
  });
  it("passes the reviewed product and both reports to evidence repair without promoting them to proof", async () => {
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core("ready")),
      veraPass(),
      carrenGap("evidence_gap"),
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
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-plan-evidence-repair-${sequence}`;
    const terminal = completeDirective(await service.execute(start(runId)));
    expect(outputRef(terminal)).toMatchObject({ version: 1 });
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
      "orienting_strategy",
      "gathering_strategy_evidence",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("repaired run is absent");
    const find = (phase: string, kind: string, version: number) => {
      const ref = context.selectedArtifacts.find(
        (entry) => entry.phase === phase && entry.kind === kind && entry.version === version
      );
      if (ref === undefined) throw new Error(`missing ${phase} ${kind} v${version}`);
      return ref;
    };
    const products = context.selectedArtifacts.filter(
      (ref) => ref.phase === "sealing_strategy" && ref.kind === "strategy"
    );
    expect(products).toHaveLength(2);
    expect(products.map((ref) => ref.version)).toEqual([1, 1]);
    expect(new Set(products.map((ref) => ref.artifact_id)).size).toBe(2);
    expect(new Set(products.map((ref) => ref.operation_id)).size).toBe(2);
    for (const ref of products) {
      expect(
        service.artifacts.refFor(runId, "sealing_strategy", null, "strategy", ref.operation_id, 1)
      ).toEqual(ref);
    }
    const [firstProduct, finalProduct] = products;
    if (firstProduct === undefined || finalProduct === undefined)
      throw new Error("repaired products are absent");
    expect(outputRef(terminal).artifact_id).toBe(finalProduct.artifact_id);
    const veraReport = find("verifying_strategy", "agent-output", 1);
    const carrenReport = find("critiquing_strategy", "agent-output", 1);
    for (const index of [4, 5, 6]) {
      const invocation = client.invocations[index];
      if (invocation === undefined) throw new Error(`missing repair invocation ${index}`);
      expect(invocation.inputArtifacts).toEqual(
        expect.arrayContaining([firstProduct, veraReport, carrenReport])
      );
      expect(invocation.inputArtifacts.filter((ref) => ref.kind === "strategy")).toEqual([
        firstProduct,
      ]);
    }
    expect(client.invocations[7]?.inputArtifacts).toContainEqual(finalProduct);
    const validity = context.selectedArtifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "validity" && ref.version === 2
    );
    const quality = context.selectedArtifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "quality" && ref.version === 1
    );
    if (validity === undefined || quality === undefined)
      throw new Error("repaired receipt chain is absent");
    expect(validateReviewReceipt(readJson(service, quality.artifact_id))).toMatchObject({
      subject: { product_ref: { artifact_id: finalProduct.artifact_id } },
      prior_review_receipt_ref: { artifact_id: validity.artifact_id },
    });
  });

  it("carries the exact reviewed product and both historical reports through alternating Carren and Vera gaps", async () => {
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core("ready")),
      veraPass(),
      carrenGap("analysis_gap"),
      orientationPass("Replacement orientation addresses the quality gap."),
      persistedStrategy(core("blocked")),
      veraGap("product_gap"),
      persistedStrategy(core("ready")),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-plan-alternating-repair-${sequence}`;
    // Input slots are stable exact-ID addresses; the first create has no local product.
    const productSlots: string[][] = [];
    client.onInvocation = () => {
      const pending = service.checkpointer.loadRunById(runId)?.pendingDirective;
      if (pending?.action !== "invoke_agent") throw new Error("pending invocation is absent");
      productSlots.push(
        pending.input_artifacts.artifacts
          .filter((entry) => entry.ref.kind === "strategy")
          .map((entry) => `${entry.slot}:${entry.ref.artifact_id}`)
      );
    };

    const terminal = completeDirective(await service.execute(start(runId)));
    const finalRef = outputRef(terminal);
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("repaired run is absent");
    const at = (phase: string, artifactKind: string, version: number) => {
      const ref = context.selectedArtifacts.find(
        (artifact) =>
          artifact.phase === phase && artifact.kind === artifactKind && artifact.version === version
      );
      if (ref === undefined) throw new Error(`missing ${phase} ${artifactKind} v${version}`);
      return ref;
    };
    const products = context.selectedArtifacts.filter(
      (ref) => ref.phase === "sealing_strategy" && ref.kind === "strategy"
    );
    expect(products).toHaveLength(3);
    expect(products.map((ref) => ref.version)).toEqual([1, 1, 1]);
    expect(new Set(products.map((ref) => ref.artifact_id)).size).toBe(3);
    expect(new Set(products.map((ref) => ref.operation_id)).size).toBe(3);
    for (const ref of products) {
      expect(
        service.artifacts.refFor(runId, "sealing_strategy", null, "strategy", ref.operation_id, 1)
      ).toEqual(ref);
    }
    const veraReports = [1, 2, 3].map((version) =>
      at("verifying_strategy", "agent-output", version)
    );
    const carrenReports = [1, 2].map((version) =>
      at("critiquing_strategy", "agent-output", version)
    );
    expect(finalRef).toMatchObject({ artifact_id: products[2]?.artifact_id, version: 1 });
    const inputIds = (index: number) =>
      client.invocations[index]?.inputArtifacts.map((ref) => ref.artifact_id);
    const expectInput = (
      index: number,
      productOrder: number,
      veraVersion: number,
      carrenVersion: number
    ) => {
      const invocation = client.invocations[index];
      if (invocation === undefined) throw new Error(`invocation ${index} is absent`);
      const productRef = products[productOrder - 1];
      const veraRef = veraReports[veraVersion - 1];
      const carrenRef = carrenReports[carrenVersion - 1];
      if (productRef === undefined || veraRef === undefined || carrenRef === undefined) {
        throw new Error("exact repair inputs are absent");
      }
      const ids = invocation.inputArtifacts.map((ref) => ref.artifact_id);
      expect(ids).toEqual(
        expect.arrayContaining([productRef.artifact_id, veraRef.artifact_id, carrenRef.artifact_id])
      );
      expect(invocation.inputArtifacts.filter((ref) => ref.kind === "strategy")).toEqual([
        productRef,
      ]);
      expect(
        invocation.inputArtifacts.filter(
          (ref) => ref.phase === "verifying_strategy" && ref.kind === "agent-output"
        )
      ).toEqual([veraRef]);
      expect(
        invocation.inputArtifacts.filter(
          (ref) => ref.phase === "critiquing_strategy" && ref.kind === "agent-output"
        )
      ).toEqual([carrenRef]);
    };
    expect(client.invocations[1]?.inputArtifacts.filter((ref) => ref.kind === "strategy")).toEqual(
      []
    );
    expect(inputIds(1)).not.toContain(products[0]?.artifact_id);
    expect(productSlots[1]).toEqual([]);
    expect(productSlots[5]).toEqual([`latest-strategy:${products[0]?.artifact_id}`]);
    expect(productSlots[7]).toEqual([`latest-strategy:${products[1]?.artifact_id}`]);
    // Framing/analysis and each author see the sealed subject, not just its draft.
    expectInput(4, 1, 1, 1);
    expectInput(5, 1, 1, 1);
    expectInput(6, 2, 1, 1);
    expectInput(7, 2, 2, 1);
    expectInput(8, 3, 2, 1);
    expectInput(9, 3, 3, 1);
    expect(client.invocations[7]?.task).toContain("historical feedback, never approval");
    // Final PASS/APPROVE and host receipts bind the third sealed product, never a prior review.
    const finalVeraReport = veraReports[2];
    const finalCarrenReport = carrenReports[1];
    if (finalVeraReport === undefined || finalCarrenReport === undefined)
      throw new Error("final reports are absent");
    expect(service.artifacts.metadata(finalVeraReport).upstream_refs).toContainEqual(products[2]);
    expect(service.artifacts.metadata(finalCarrenReport).upstream_refs).toContainEqual(products[2]);
    const validity = context.selectedArtifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "validity" && ref.version === 2
    );
    const quality = context.selectedArtifacts.find(
      (ref) => ref.kind === "review-receipt" && ref.branch_id === "quality" && ref.version === 1
    );
    if (validity === undefined || quality === undefined)
      throw new Error("current review receipts are absent");
    expect(validateReviewReceipt(readJson(service, validity.artifact_id))).toMatchObject({
      verdict: "PASS",
      subject: { product_ref: { artifact_id: products[2]?.artifact_id } },
    });
    expect(validateReviewReceipt(readJson(service, quality.artifact_id))).toMatchObject({
      verdict: "APPROVE",
      subject: { product_ref: { artifact_id: products[2]?.artifact_id } },
      prior_review_receipt_ref: { artifact_id: validity.artifact_id },
    });
    const integrity = context.selectedArtifacts.find(
      (ref) => ref.kind === "strategy-product-integrity"
    );
    const envelope = context.selectedArtifacts.find(
      (ref) => ref.kind === "strategy-product-envelope"
    );
    if (integrity === undefined || envelope === undefined)
      throw new Error("current completion graph is absent");
    expect(
      validateStrategyProductIntegrity(readJson(service, integrity.artifact_id))
    ).toMatchObject({
      status: "PASS",
      strategy_ref: { artifact_id: products[2]?.artifact_id },
      vera_report_ref: { artifact_id: finalVeraReport.artifact_id },
      carren_report_ref: { artifact_id: finalCarrenReport.artifact_id },
      validity_receipt_ref: { artifact_id: validity.artifact_id },
      quality_receipt_ref: { artifact_id: quality.artifact_id },
    });
    expect(validateStrategyProductEnvelope(readJson(service, envelope.artifact_id))).toMatchObject({
      status: "complete",
      strategy_ref: { artifact_id: products[2]?.artifact_id },
      integrity_ref: { artifact_id: integrity.artifact_id },
    });
    expect(service.checkpointer.completionAdmission(runId)).toBeDefined();
  });

  it.each(["ready", "blocked", "not_applicable"] as const)(
    "completes a reviewed canonical %s StrategyV2 and exact product envelope",
    async (disposition) => {
      const client = new ScriptedPlanClient(happyOutputs(disposition));
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
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
        content_schema: { schema_id: "penny.strategy.v2", schema_version: 2 },
      });
      expect(
        validateStrategyV2(readJson(service, String(ref.artifact_id)), {
          strictSourceValidation: true,
        })
      ).toMatchObject({
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

  it("consumes one exact SpecificationV1 and emits a fully traceable StrategyV2", async () => {
    sequence += 1;
    const runId = `run-plan-specification-${sequence}`;
    const definition = genericSpecificationFixture();
    const client = new ScriptedPlanClient([
      orientationPass("The request is compatible with the supplied generic specification."),
      persistedStrategy(coreWithSpecification()),
      veraPass(),
      carrenApprove(true),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    const specificationRef = service.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: `run-define-source-${sequence}`,
        phase: "sealing_specification",
        branch_id: null,
        kind: "specification",
        operation_id: `sealed-specification-${sequence}`,
        version: 1,
        producer: "host:specification-sealer",
        media_type: "application/json",
        content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(definition.specification),
    });
    const terminal = completeDirective(
      await service.execute(
        start(runId, PLAN_PLAYBOOK_NAME, {
          schema_version: 2,
          artifacts: [{ slot: "prior_specification", ref: specificationRef }],
        })
      )
    );
    const productRef = terminal.artifacts.find(
      (artifact) => artifact.artifact_id === String(outputRef(terminal).artifact_id)
    );
    if (productRef === undefined) throw new Error("terminal StrategyV2 ref is absent");
    const strategy = validateStrategyV2(readJson(service, productRef.artifact_id), {
      specification: definition.specification,
      specificationArtifactId: specificationRef.artifact_id,
      strictSourceValidation: true,
    });
    const requiredItems = specificationStrategySourceItems(definition.specification).filter(
      (entry) => entry.required
    );
    expect(strategy.source_item_coverage).toHaveLength(requiredItems.length);
    expect(strategy.source_item_coverage.every((entry) => entry.disposition === "addressed")).toBe(
      true
    );
    expect(strategy.unsupported_strategy_elements).toEqual([]);
    expect(strategy.source_lineage.input_artifact_ids).toEqual([specificationRef.artifact_id]);
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    expect(client.invocations[1]?.inputArtifacts).toContainEqual(specificationRef);
    expect(client.invocations[1]?.task).toContain("complete replacement StrategyDraftV2");
    const sourceIndexRef = terminal.artifacts.find(
      (ref) => ref.kind === "plan-specification-source-index"
    );
    if (sourceIndexRef === undefined) throw new Error("exact source index is absent");
    for (const invocation of client.invocations) {
      expect(invocation.inputArtifacts).toContainEqual(sourceIndexRef);
      expect(invocation.task).toContain(
        "fully read both prior-specification and plan-specification-source-index"
      );
      expect(invocation.task).not.toContain("MECHANICALLY_PROJECTED_SPECIFICATION_SOURCE_ITEMS");
    }
  });

  it("refuses a judgment-free Vera report without granting PASS through routing repair", async () => {
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core()),
      'Validity review.\nSUMMARY:{"confidence":"PROBABLE"}',
      routingOnly(veraPass()),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    const terminal = await service.execute(start(`run-plan-no-judgment-${++sequence}`));
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
    ]);
    expect(service.checkpointer.completionAdmission(terminal.identity.run_id)).toBeUndefined();
  });

  it("preserves one EvidenceContext ref without flattening the native request, strategy, or task prose", async () => {
    sequence += 1;
    const runId = `run-plan-evidence-context-${sequence}`;
    const evidenceAwareCore = core("blocked");
    const client = new ScriptedPlanClient([
      orientationEvidenceGap(),
      evidencePacket(),
      persistedStrategy({
        ...evidenceAwareCore,
        request_coverage: {
          ...evidenceAwareCore.request_coverage,
          input_artifact_slots: [0],
        },
      }),
      veraPass(),
      carrenApprove(true),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    const evidenceContext = persistEvidenceContext(service.artifacts, "plan-playbook");
    const terminal = completeDirective(
      await service.execute(
        start(runId, PLAN_PLAYBOOK_NAME, {
          schema_version: 2,
          artifacts: [{ slot: "evidence_context", ref: evidenceContext.ref }],
        })
      )
    );
    const run = service.checkpointer.loadRunById(runId);
    if (run === undefined) throw new Error("completed Plan run is absent");
    const requestRef = run.selectedArtifacts.find(
      (artifact) => artifact.kind === "plan-request" && artifact.phase === "intake"
    );
    if (requestRef === undefined) throw new Error("admitted PlanRequestV1 ref is absent");
    const nativeRequest = validatePlanRequest(readJson(service, requestRef.artifact_id));
    expect(nativeRequest.schema_version).toBe(1);
    expect(nativeRequest.goal).toBe("Form a safe transition strategy without execution.");
    expect(nativeRequest.input_artifact_ids).toEqual([evidenceContext.ref.artifact_id]);
    expect(nativeRequest.desired_outcomes).toEqual(constraints().desired_outcomes);
    expect(nativeRequest.current_state).toEqual(constraints().current_state);
    expect(nativeRequest.hard_constraints).toEqual(constraints().hard_constraints);
    expect(nativeRequest.non_goals).toEqual(constraints().non_goals);
    expect(nativeRequest.known_uncertainties).toEqual(constraints().known_uncertainties);
    expect(nativeRequest.prior_decisions).toEqual(constraints().prior_decisions);
    expect(service.artifacts.metadata(requestRef).upstream_refs).toEqual([evidenceContext.ref]);

    const terminalRef = outputRef(terminal);
    const productRef = terminal.artifacts.find(
      (artifact) => artifact.artifact_id === String(terminalRef.artifact_id)
    );
    if (productRef === undefined) throw new Error("terminal StrategyV2 ref is absent");
    const strategy = validateStrategyV2(readJson(service, productRef.artifact_id), {
      strictSourceValidation: true,
    });
    expect(strategy.request).toEqual(nativeRequest);
    expect(strategy.source_lineage.input_artifact_ids).toEqual([evidenceContext.ref.artifact_id]);
    expect(
      service.artifacts
        .metadata(productRef)
        .upstream_refs.filter(
          (artifact) => artifact.artifact_id === evidenceContext.ref.artifact_id
        )
    ).toEqual([evidenceContext.ref]);

    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "orienting_strategy",
      "gathering_strategy_evidence",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    for (const invocation of client.invocations) {
      expect(
        invocation.inputArtifacts.filter(
          (artifact) => artifact.artifact_id === evidenceContext.ref.artifact_id
        )
      ).toEqual([evidenceContext.ref]);
      expect(invocation.task).not.toContain(evidenceContext.statementMarker);
    }
    const admissionRef = terminal.artifacts.find(
      (artifact) => artifact.kind === "evidence-admission"
    );
    if (admissionRef === undefined) throw new Error("Strategy EvidenceAdmissionV1 ref is absent");
    const admission = validateEvidenceAdmission(readJson(service, admissionRef.artifact_id));
    expect(admission.domain).toBe("strategy");
    expect(admission.source_artifact_ref.artifact_id).not.toBe(evidenceContext.ref.artifact_id);
  });

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
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
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
      validateStrategyV2(readJson(service, String(outputRef(terminal).artifact_id)), {
        strictSourceValidation: true,
      }).disposition
    ).toBe("blocked");
  });

  it("routes Vera product_gap to Piper, reseals a distinct product, and re-verifies before Carren", async () => {
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
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
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
    expect(outputRef(terminal)).toMatchObject({ version: 1 });
    expect(
      validateStrategyV2(readJson(service, String(outputRef(terminal).artifact_id)), {
        strictSourceValidation: true,
      }).disposition
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
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
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
    expect(outputRef(terminal)).toMatchObject({ version: 1 });
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
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const terminal = await service.execute(start(`run-plan-major-approve-${sequence}`));
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations.map((invocation) => invocation.stateId)).toEqual([
      "orienting_strategy",
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    expect(
      client.invocations.some((invocation) => invocation.executionPurpose === "routing_repair")
    ).toBe(false);
  });

  it("offers a new correction only after a same-run sealed product, not from old feedback", async () => {
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core()).replace("STRATEGY_CORE:", "BROKEN_CORE:"),
      persistedStrategy(core()),
      veraGap("product_gap"),
      persistedStrategy(core()).replace("STRATEGY_CORE:", "BROKEN_CORE:"),
      persistedStrategy(core("blocked")),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-plan-epoch-${sequence}`;
    const terminal = completeDirective(await service.execute(start(runId)));
    expect(outputRef(terminal)).toMatchObject({ kind: "strategy", version: 1 });
    const authors = client.invocations.filter((entry) => entry.stateId === "strategizing");
    expect(authors).toHaveLength(4);
    expect(authors[1]?.inputArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toHaveLength(
      1
    );
    expect(authors[2]?.inputArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toHaveLength(
      0
    );
    expect(authors[3]?.inputArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toHaveLength(
      1
    );
    const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts;
    if (selected === undefined) throw new Error("run checkpoint absent");
    const diagnostics = selected.filter((ref) => ref.kind === "seal-diagnostic");
    expect(diagnostics).toHaveLength(2);
    const first: unknown = readJson(service, diagnostics[0]?.artifact_id ?? "missing");
    const second: unknown = readJson(service, diagnostics[1]?.artifact_id ?? "missing");
    expect(first).toMatchObject({
      rejection_ordinal: 1,
      epoch_anchor_ref: null,
      corrections_used: 0,
    });
    expect(second).toMatchObject({
      rejection_ordinal: 1,
      corrections_used: 0,
      epoch_anchor_ref: selected.find((ref) => ref.kind === "strategy" && ref.version === 1),
    });
    const snapshot = service.checkpointer.loadRunById(runId);
    if (snapshot === undefined) throw new Error("run checkpoint absent");
    const imported = selected.find((ref) => ref.kind === "strategy" && ref.version === 1);
    if (imported === undefined) throw new Error("first product absent");
    snapshot.selectedArtifacts.push({ ...imported, run_id: "foreign-run", version: 100 });
    const secondDiagnostic = diagnostics[1];
    if (secondDiagnostic === undefined) throw new Error("second diagnostic absent");
    snapshot.selectedArtifacts.push({ ...secondDiagnostic, run_id: "foreign-run", version: 101 });
    expect(planCurrentSealDiagnosticRef(snapshot)).toBeUndefined();
    expect(client.invocations.map((entry) => entry.stateId).slice(-3)).toEqual([
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
  });

  it("persists the final rejection and labels its exact draft, not an accepted product", async () => {
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core()).replace("STRATEGY_CORE:", "BROKEN_CORE:"),
      persistedStrategy(core()).replace("STRATEGY_CORE:", "BROKEN_CORE:"),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: explicitSealPolicy(PLAN_PLAYBOOK_REGISTRATION, 1),
    });
    sequence += 1;
    const runId = `run-plan-final-seal-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("negative terminal absent");
    expect(terminal.result).toMatchObject({
      met: false,
      output_artifact_label: "rejected draft (not a sealed product)",
      seal_diagnostics: { corrections_used: 1, correction_limit: 1, disposition: "exhausted" },
    });
    const selected = service.checkpointer.loadRunById(runId)?.selectedArtifacts;
    if (selected === undefined) throw new Error("run checkpoint absent");
    const diagnostics = selected.filter((ref) => ref.kind === "seal-diagnostic");
    expect(diagnostics).toHaveLength(2);
    const last = diagnostics[1];
    if (last === undefined) throw new Error("final seal diagnostic absent");
    expect(readJson(service, last.artifact_id)).toMatchObject({
      rejected_draft_ref: terminal.result.output_artifact_ref,
      previous_diagnostic_ref: diagnostics[0],
      rejection_ordinal: 2,
    });
    expect(terminal.result.seal_diagnostics).toMatchObject({ latest_diagnostic_ref: last });
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("run checkpoint absent");
    // Wrong-run feedback with a higher version cannot consume this epoch's allowance.
    context.selectedArtifacts.push({ ...last, run_id: "foreign-run", version: 100 });
    expect(planCurrentSealDiagnosticRef(context)).toEqual(last);
  });

  it("adopts an interrupted first diagnostic before dispatching its only correction", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistration = {
      ...PLAN_PLAYBOOK_REGISTRATION,
      construct: (options) =>
        new PlanPlaybook(
          options.artifactRevisions,
          options.artifactStore,
          options.checkpointer,
          (point) => {
            if (!interrupted && point === "sealing_strategy:feedback-persistence") {
              interrupted = true;
              throw new Error("injected diagnostic interruption");
            }
          }
        ),
    };
    sequence += 1;
    const runId = `run-plan-diagnostic-recover-${sequence}`;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedPlanClient([
          orientationPass(),
          persistedStrategy(core()).replace("STRATEGY_CORE:", "BROKEN_CORE:"),
        ]),
        playbookRegistration: registration,
      });
      await expect(first.execute(start(runId))).rejects.toThrow(
        /injected diagnostic interruption/u
      );
      expect(first.checkpointer.loadRunById(runId)?.stateId).toBe("sealing_strategy");
    }
    const client = new ScriptedPlanClient([persistedStrategy(core()), veraPass(), carrenApprove()]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    const terminal = completeDirective(
      await recovered.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      })
    );
    expect(outputRef(terminal)).toMatchObject({ kind: "strategy", version: 1 });
    expect(client.invocations.map((entry) => entry.stateId)).toEqual([
      "strategizing",
      "verifying_strategy",
      "critiquing_strategy",
    ]);
    expect(
      recovered.checkpointer
        .loadRunById(runId)
        ?.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic")
    ).toHaveLength(1);
  });

  it("recovers after host sealing persistence and continues the exact review graph", async () => {
    const env = environment();
    let interrupted = false;
    const registration: PlaybookRegistration = {
      ...PLAN_PLAYBOOK_REGISTRATION,
      construct: (options) =>
        new PlanPlaybook(
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
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
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
      persistedStrategy({
        ...core(),
        outcomes: core().outcomes.map((outcome) => ({
          ...outcome,
          success_signal: `Revised signal 1.`,
        })),
      }),
      veraGap("product_gap"),
      persistedStrategy({
        ...core(),
        outcomes: core().outcomes.map((outcome) => ({
          ...outcome,
          success_signal: `Revised signal 2.`,
        })),
      }),
      veraGap("product_gap"),
      persistedStrategy({
        ...core(),
        outcomes: core().outcomes.map((outcome) => ({
          ...outcome,
          success_signal: `Revised signal 3.`,
        })),
      }),
      veraGap("product_gap"),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: { ...environment(), PENNY_ORCHESTRATION_MAX_ITERATIONS: "3" },
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
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
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
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
    const contract = PLAN_PLAYBOOK_REGISTRATION.contract;
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

  it("fails closed for active drift and exactly replays a historical terminal", async () => {
    const env = environment();
    sequence += 1;
    let activeIdentity: Directive["identity"];
    let terminal: TerminalDirective;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedPlanClient(happyOutputs("ready")),
        playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
      });
      const active = service.handle(start(`run-plan-active-contract-binding-${sequence}`));
      expect(active.action).toBe("invoke_agent");
      activeIdentity = active.identity;
      terminal = completeDirective(
        await service.execute(start(`run-plan-terminal-contract-binding-${sequence}`))
      );
    }
    const drifted: PlaybookRegistration = {
      ...PLAN_PLAYBOOK_REGISTRATION,
      contract: {
        ...PLAN_PLAYBOOK_REGISTRATION.contract,
        objective: `${PLAN_PLAYBOOK_REGISTRATION.contract.objective} Drift fixture.`,
      },
    };
    using replay = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: new ScriptedPlanClient([]),
      playbookRegistration: drifted,
    });
    for (const action of ["status", "recover"] as const) {
      expect(
        await replay.execute({ schema_version: 2, action, identity: activeIdentity })
      ).toMatchObject({
        action: "error",
        result: { code: "REGISTRATION_CONTRACT_MISMATCH", checkpoint_unchanged: true },
      });
      expect(
        await replay.execute({ schema_version: 2, action, identity: terminal.identity })
      ).toEqual(terminal);
    }
  });

  it("rejects a stale semantic input before RunContext creation", () => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedPlanClient([]),
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
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
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
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
    expect(canonicalJson(PLAN_PLAYBOOK_REGISTRATION.contract)).not.toMatch(
      /tabitha|task_graph|execution_state|approval_state|approval_gate|approval_product|sandbox enforcement/iu
    );
    expect(client.invocations).toHaveLength(0);
  });
  it("continues productive seal and review repair beyond the former imposed limits", async () => {
    const client = new ScriptedPlanClient([
      orientationPass(),
      ...Array.from(
        { length: 4 },
        (_value, index) =>
          `Correction ${index}\n` +
          persistedStrategy(core()).replace(
            /(?:ASSESSMENT_DRAFT|DIAGNOSIS_CORE|DECISION_CORE|STRATEGY_CORE|PRODUCED_ARTIFACT_DRAFT):/u,
            "BROKEN_CORE:"
          )
      ),
      persistedStrategy(core()),
      ...Array.from({ length: 4 }, (_value, index) => [
        veraGap("product_gap"),
        persistedStrategy({
          ...core(),
          outcomes: core().outcomes.map((outcome) => ({
            ...outcome,
            success_signal: `Revised signal ${index}.`,
          })),
        }),
      ]).flat(),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    sequence += 1;
    const runId = `run-plan-productive-unlimited-${sequence}`;
    const terminal = await service.execute(start(runId));
    expect(terminal.action).toBe("complete");
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("productive run checkpoint missing");
    expect(context.maxSteps).toBeNull();
    expect(context.maxIterations).toBeNull();
    expect(context.iteration).toBe(4);
    expect(context.selectedArtifacts.filter((ref) => ref.kind === "seal-diagnostic")).toHaveLength(
      4
    );
    expect(
      client.invocations.filter((invocation) => invocation.stateId === "strategizing")
    ).toHaveLength(9);
    expect(
      await service.execute({ schema_version: 2, action: "recover", identity: terminal.identity })
    ).toEqual(terminal);
  });
  it.each(["NORMAL", "VALID_INCONCLUSIVE"])(
    "keeps UNVERIFIABLE distinct from a valid product (%s) and recovers durably",
    async (variant) => {
      const env = environment();
      const runId = `run-plan-unverifiable-${++sequence}`;
      const report = summary({
        verdict: "UNVERIFIABLE",
        gap_kind: "verification_incomplete",
        repair_owner: "none",
        findings: ["Available evidence cannot establish this claim."],
        evidence: ["The admitted basis does not supply an independent observation."],
        strategy_delta:
          "Retain the product and report; do not reauthor for a verification limitation.",
      });
      let terminal: Directive;
      {
        const client = new ScriptedPlanClient([
          orientationPass(),
          variant === "NORMAL" ? persistedStrategy(core()) : persistedStrategy(core("blocked")),
          report,
        ]);
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          modelClient: client,
          playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
        });
        terminal = await service.execute(start(runId));
        expect(terminal).toMatchObject({
          action: "incomplete",
          met: false,
          result: {
            incomplete_reason: "verification_incomplete",
            verification_findings: ["Available evidence cannot establish this claim."],
            evidence_limitations: [
              "The admitted basis does not supply an independent observation.",
            ],
          },
        });
        if (terminal.action !== "incomplete") throw new Error("negative terminal absent");
        expect(
          terminal.artifacts.some(
            (ref) => ref.phase === "verifying_strategy" && ref.kind === "agent-output"
          )
        ).toBe(true);
        expect(terminal.result.best_partial_artifact_refs).toHaveLength(1);
        const context = service.checkpointer.loadRunById(runId);
        if (context === undefined) throw new Error("durable run absent");
        expect(context.selectedArtifacts.some((ref) => ref.kind === "review-receipt")).toBe(false);
        expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
        expect(client.invocations.map((entry) => entry.stateId)).toEqual([
          "orienting_strategy",
          "strategizing",
          "verifying_strategy",
        ]);
      }
      const client = new ScriptedPlanClient([]);
      using recovered = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
      });
      expect(
        await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations).toHaveLength(0);
      expect(recovered.checkpointer.completionAdmission(runId)).toBeUndefined();
    }
  );

  it.each(["verifying_strategy", "critiquing_strategy"])(
    "preserves the complete structured source judgment through routing-only repair at %s",
    async (state) => {
      const source = state === "verifying_strategy" ? veraPass() : carrenApprove();
      const client = new ScriptedPlanClient([
        orientationPass(),
        persistedStrategy(core()),
        ...(state === "critiquing_strategy" ? [veraPass()] : []),
        source,
        routingOnly(source),
        ...(state === "verifying_strategy" ? [carrenApprove()] : []),
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env: environment(),
        modelClient: client,
        playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
      });
      const runId = `run-plan-preserved-${++sequence}`;
      const pending = await reachState(service, runId, state);
      const [captured] = await service.workers.execute(pending);
      if (captured === undefined) throw new Error("captured result absent");
      const repair = service.engine.handle({
        schema_version: 2,
        action: "step",
        identity: identity(runId),
        result: { ...captured, details: {} },
      });
      expect(repair).toMatchObject({ action: "invoke_agent", execution_purpose: "routing_repair" });
      const terminal = completeDirective(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      );
      expect(terminal.met).toBe(true);
      const receipt = terminal.artifacts.find(
        (ref) =>
          ref.kind === "review-receipt" &&
          ref.branch_id === (state === "verifying_strategy" ? "validity" : "quality")
      );
      if (receipt === undefined) throw new Error("positive receipt absent");
      expect(
        validateReviewReceipt(readJson(service, receipt.artifact_id)).review_report_ref
      ).toEqual(captured.output_artifact);
      expect(
        service.artifacts.readById(captured.output_artifact.artifact_id).toString("utf8")
      ).toBe(source);
    }
  );

  it.each([
    ["verifying_strategy", "verdict"],
    ["verifying_strategy", "unverifiable"],
    ["verifying_strategy", "evidence"],
    ["verifying_strategy", "confidence"],
    ["critiquing_strategy", "verdict"],
    ["critiquing_strategy", "evidence"],
    ["critiquing_strategy", "strategy_delta"],
  ])("refuses source judgment mutation at %s (%s)", async (state, field) => {
    const source =
      field === "unverifiable"
        ? summary({
            verdict: "UNVERIFIABLE",
            gap_kind: "verification_incomplete",
            repair_owner: "none",
            findings: ["Verification evidence unavailable."],
            evidence: ["No independent observation."],
            strategy_delta: "Preserve limitations, not an author repair.",
          })
        : state === "verifying_strategy"
          ? veraGap("product_gap")
          : carrenGap("product_gap");
    let replacement =
      field === "verdict"
        ? state === "verifying_strategy"
          ? veraPass()
          : carrenApprove()
        : source;
    if (field === "unverifiable") replacement = veraGap("product_gap");
    if (field === "evidence")
      replacement = replacement
        .replace("Exact latest product check failed.", "Different check.")
        .replace("The exact latest product has a material quality defect.", "Different check.");
    if (field === "confidence")
      replacement = replacement.replace('"confidence":"PROBABLE"', '"confidence":"CERTAIN"');
    if (field === "strategy_delta")
      replacement = replacement.replace(
        "before another complete review cycle.",
        "with a different plan."
      );
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core()),
      ...(state === "critiquing_strategy" ? [veraPass()] : []),
      source,
      routingOnly(replacement),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    const runId = `run-plan-mutation-${++sequence}`;
    const pending = await reachState(service, runId, state);
    const [captured] = await service.workers.execute(pending);
    if (captured === undefined) throw new Error("captured result absent");
    service.engine.handle({
      schema_version: 2,
      action: "step",
      identity: identity(runId),
      result: { ...captured, details: {} },
    });
    const terminal = await service.execute({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(terminal).toMatchObject({ action: "incomplete", met: false });
    expect(client.invocations.at(-1)?.executionPurpose).toBe("routing_repair");
    expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
    expect(
      service.checkpointer
        .events(runId)
        .some((event) => event.eventType === "routing_repair_accepted")
    ).toBe(false);
  });

  it("binds native mechanical evidence to the current product and signed verifier task only", async () => {
    const client = new ScriptedPlanClient([
      orientationPass(),
      persistedStrategy(core()),
      veraGap("product_gap"),
      persistedStrategy({
        ...core(),
        outcomes: core().outcomes.map((outcome) => ({
          ...outcome,
          success_signal: `Revised signal fixture.`,
        })),
      }),
      veraPass(),
      carrenApprove(),
    ]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    const runId = `run-plan-mechanics-${++sequence}`;
    const first = await reachState(service, runId, "verifying_strategy");
    if (first.action !== "invoke_agent") throw new Error("verifier absent");
    const [checked] = await service.workers.execute(first);
    if (checked === undefined) throw new Error("signed verifier result absent");
    expect(checked.worker_receipt.trusted_invocation_digest).toBe(
      trustedInvocationDigest({
        identity: first.identity,
        state_id: first.state_id,
        branch_id: null,
        agent: first.agent,
        attempt: first.attempt,
        trust_profile: first.trust_profile,
        model_override: first.model_override ?? null,
        task_sha256: sha256(first.task),
        input_artifacts: first.input_artifacts,
        output_artifact: first.output_artifact,
      })
    );
    service.engine.handle({
      schema_version: 2,
      action: "step",
      identity: identity(runId),
      result: checked,
    });
    const terminal = completeDirective(
      await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    const reviews = client.invocations.filter((entry) => entry.stateId === "verifying_strategy");
    expect(reviews).toHaveLength(2);
    const statements: string[] = [];
    for (const invocation of reviews) {
      const line = invocation.task
        .split("\n")
        .find((entry) => entry.startsWith("HOST_MECHANICAL_CHECKS:"));
      if (line === undefined) throw new Error("mechanical evidence absent");
      const product = invocation.inputArtifacts.find(
        (ref) => ref.phase === "sealing_strategy" && ref.kind === "strategy"
      );
      const draftRef = invocation.inputArtifacts.find((ref) => ref.kind === "strategy-draft");
      if (product === undefined || draftRef === undefined)
        throw new Error("mechanical inputs absent");
      expect(line).toContain(`"product_ref":${canonicalJson(product)}`);
      expect(line).toContain('"scope":"host_mechanical_only_not_semantic_or_effect_absence"');
      expect(line).toContain('"source_refs":');
      for (const ref of invocation.inputArtifacts.filter((ref) =>
        ["plan-request", "strategy-draft", "evidence-admission"].includes(ref.kind)
      ))
        expect(line).toContain(canonicalJson(ref));
      expect(line).toContain(
        canonicalJson({ kind: "raw_strategy_draft_bytes", sha256: draftRef.content_digest })
      );
      statements.push(line);
    }
    expect(statements[0]).not.toBe(statements[1]);
    expect(
      client.invocations
        .filter((entry) => entry.stateId !== "verifying_strategy")
        .every(
          (entry) =>
            !entry.task.split("\n").some((line) => line.startsWith("HOST_MECHANICAL_CHECKS:"))
        )
    ).toBe(true);
    expect(terminal.met).toBe(true);
  });

  it.each([false, true])(
    "fails mechanical validation closed before verifier dispatch (recovery=%s)",
    async (recovery) => {
      const env = environment();
      const runId = `run-plan-mechanical-failure-${++sequence}`;
      let invalid = false;
      const client = new ScriptedPlanClient([orientationPass(), persistedStrategy(core())]);
      const registration: PlaybookRegistration = {
        ...PLAN_PLAYBOOK_REGISTRATION,
        construct: (options) => {
          const store = options.artifactStore;
          if (store === undefined) throw new Error("host store absent");
          const read = store.readById.bind(store);
          vi.spyOn(store, "readById").mockImplementation((id) => {
            const bytes = read(id);
            return invalid && store.refById(id)?.kind === "strategy"
              ? Buffer.concat([bytes, Buffer.from(" ")])
              : bytes;
          });
          return new PlanPlaybook(
            options.artifactRevisions,
            store,
            options.checkpointer,
            (point) => {
              if (!recovery && point === "sealing_strategy:artifact-persistence") invalid = true;
            }
          );
        },
      };
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: registration,
      });
      let terminal: Directive;
      if (recovery) {
        await reachState(service, runId, "verifying_strategy");
        invalid = true;
        terminal = await service.execute({
          schema_version: 2,
          action: "recover",
          identity: identity(runId),
        });
      } else terminal = await service.execute(start(runId));
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: { incomplete_reason: "host_mechanical_validation_failed" },
      });
      expect(client.invocations.map((entry) => entry.stateId)).toEqual([
        "orienting_strategy",
        "strategizing",
      ]);
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      invalid = false;
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
    }
  );

  it.each(["verifying_strategy", "critiquing_strategy"])(
    "stalls the exact parsed candidate and repeated failed checks at %s across restart",
    async (reviewer) => {
      const env = environment();
      const runId = `run-plan-stall-${++sequence}`;
      const gap =
        reviewer === "verifying_strategy" ? veraGap("product_gap") : carrenGap("product_gap");
      {
        const client = new ScriptedPlanClient([
          orientationPass(),
          persistedStrategy(core()),
          ...(reviewer === "critiquing_strategy" ? [veraPass()] : []),
          gap,
        ]);
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          modelClient: client,
          playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
        });
        const pending = await reachState(service, runId, reviewer);
        const [result] = await service.workers.execute(pending);
        if (result === undefined) throw new Error("first failed check absent");
        expect(
          service.engine.handle({
            schema_version: 2,
            action: "step",
            identity: identity(runId),
            result,
          })
        ).toMatchObject({ action: "invoke_agent", state_id: "strategizing" });
      }
      // New bytes, new raw digest and product identities do not make a new semantic candidate.
      const same = persistedStrategy(core()).replace("CORE:{", "CORE:{ ");
      const repeated = gap
        .replace("preserve exact lineage.", "use a different strategy.")
        .replace("before another complete review cycle.", "using a different strategy.");
      const client = new ScriptedPlanClient([
        same,
        ...(reviewer === "critiquing_strategy" ? [veraPass()] : []),
        repeated,
      ]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
      });
      const terminal = await service.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: {
          incomplete_reason: "repair_stalled",
          stalled: true,
          repair_stall: {
            origin_state: reviewer,
            feedback_kind: "product_gap",
          },
        },
      });
      if (terminal.action !== "incomplete") throw new Error("stall terminal absent");
      const stall = terminal.result.repair_stall;
      if (stall === null || typeof stall !== "object" || Array.isArray(stall))
        throw new Error("stall diagnostics absent");
      expect(stall.feedback_report_refs).toHaveLength(1);
      expect(client.invocations.filter((entry) => entry.stateId === "strategizing")).toHaveLength(
        1
      );
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("stall checkpoint absent");
      expect(context.iteration).toBe(1);
      expect(context.maxIterations).toBeNull();
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      const calls = client.invocations.length;
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations).toHaveLength(calls);
    }
  );

  it.each(["verifying_strategy", "critiquing_strategy"])(
    "continues changed candidates but detects A/B/A recurrence at %s",
    async (reviewer) => {
      for (const recurrence of [false, true]) {
        const gap =
          reviewer === "verifying_strategy" ? veraGap("product_gap") : carrenGap("product_gap");
        const a = persistedStrategy(core());
        const b = persistedStrategy({
          ...core(),
          outcomes: core().outcomes.map((outcome) => ({
            ...outcome,
            success_signal: `Revised signal fixture.`,
          })),
        });
        const cycle = (candidate: string, failed: boolean) => [
          candidate,
          ...(reviewer === "critiquing_strategy"
            ? [veraPass(), failed ? gap : carrenApprove()]
            : [failed ? gap : veraPass(), ...(failed ? [] : [carrenApprove()])]),
        ];
        const client = new ScriptedPlanClient([
          orientationPass(),
          ...cycle(a, true),
          ...cycle(b, true),
          ...cycle(a, recurrence),
        ]);
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env: environment(),
          modelClient: client,
          playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
        });
        const terminal = await service.execute(start(`run-plan-recurrence-${++sequence}`));
        expect(terminal.action).toBe(recurrence ? "incomplete" : "complete");
        if (recurrence)
          expect(terminal).toMatchObject({ result: { incomplete_reason: "repair_stalled" } });
        expect(client.invocations.filter((entry) => entry.stateId === "strategizing")).toHaveLength(
          3
        );
      }
    }
  );

  it.each([
    "intact",
    "changed",
    "missing",
    "duplicate",
    "conflicting_duplicate",
    "indented_duplicate",
    "incomplete_line",
  ])(
    "recovers frozen contextual verifier evidence across restart or refuses %s evidence",
    async (mode) => {
      const env = environment();
      const runId = `run-plan-context-mechanical-${++sequence}`;
      let original: Extract<Directive, { action: "invoke_agent" }>;
      {
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          modelClient: new ScriptedPlanClient([
            orientationPass(),
            persistedStrategy(core()),
            veraPass(),
            carrenApprove(),
            orientationPass(),
            persistedStrategy(core()),
          ]),
          playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
        });
        // Context is an actually completed, reviewed native product, not a forged fixture ref.
        const producer = completeDirective(await service.execute(start(`${runId}-producer`)));
        const contextRef = validateContract(
          ArtifactRefSchema,
          producer.result.output_artifact_ref,
          "accepted context"
        );
        const pending = await reachState(service, runId, "verifying_strategy", {
          schema_version: 2,
          artifacts: [{ slot: "restart-context", designation: "context", ref: contextRef }],
        });
        if (pending.action !== "invoke_agent")
          throw new Error("pending contextual verifier absent");
        original = structuredClone(pending);
        const statement = pending.task
          .split("\n")
          .find((line) => line.startsWith("HOST_MECHANICAL_CHECKS:"));
        if (statement === undefined) throw new Error("mechanical statement absent");
        expect(pending.task.indexOf("NONBINDING exact contextual artifacts")).toBeGreaterThan(
          pending.task.indexOf(statement)
        );
        expect(pending.task.endsWith(statement)).toBe(false);
        expect(pending.input_artifacts.artifacts).toContainEqual({
          slot: "restart-context",
          designation: "context",
          ref: contextRef,
        });
        if (mode !== "intact") {
          const context = service.checkpointer.loadRunById(runId);
          if (context?.pendingDirective?.action !== "invoke_agent")
            throw new Error("checkpoint absent");
          const task = original.task;
          context.pendingDirective.task =
            mode === "changed"
              ? task.replace(
                  statement,
                  statement.replace('"schema_version":1', '"schema_version":2')
                )
              : mode === "missing"
                ? task.replace(statement, "")
                : mode === "duplicate"
                  ? `${task}\n${statement}`
                  : mode === "conflicting_duplicate"
                    ? `${task.replace(statement, "HOST_MECHANICAL_CHECKS:{}")}\n${statement}`
                    : mode === "indented_duplicate"
                      ? `${task}\n ${statement}`
                      : task.replace(statement, `${statement} trailing bytes`);
          service.checkpointer.saveRun(context, "fixture_frozen_task_tampered", {});
        }
      }
      const client = new ScriptedPlanClient([veraPass(), carrenApprove()]);
      using recovered = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
      });
      const next = recovered.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      if (mode === "intact") {
        if (next.action !== "invoke_agent") throw new Error("contextual recovery refused");
        expect(next.task).toBe(original.task);
        expect(next.input_artifacts).toEqual(original.input_artifacts);
        const saved = recovered.checkpointer.loadRunById(runId);
        expect(saved?.pendingDirective).toEqual(next);
        completeDirective(
          await recovered.execute({
            schema_version: 2,
            action: "recover",
            identity: identity(runId),
          })
        );
        expect(client.invocations[0]?.task).toBe(original.task);
        expect(recovered.checkpointer.completionAdmission(runId)).toBeDefined();
      } else {
        expect(next).toMatchObject({
          action: "incomplete",
          met: false,
          result: { incomplete_reason: "host_mechanical_validation_failed" },
        });
        expect(client.invocations).toHaveLength(0);
        expect(recovered.checkpointer.completionAdmission(runId)).toBeUndefined();
        expect(
          recovered.engine.handle({
            schema_version: 2,
            action: "recover",
            identity: identity(runId),
          })
        ).toEqual(next);
      }
    }
  );

  it.each([
    ["verifying_strategy", "analysis_gap"],
    ["critiquing_strategy", "analysis_gap"],
    ["verifying_strategy", "evidence_gap"],
    ["critiquing_strategy", "evidence_gap"],
  ] as const)(
    "measures changed upstream content then identical replacement recurrence at %s/%s across restart",
    async (reviewer, kind) => {
      const env = environment();
      const runId = `run-plan-upstream-${++sequence}`;
      const gap = reviewer === "verifying_strategy" ? veraGap(kind) : carrenGap(kind);
      // Only substantive report prose changes. Routing fields, draft and failed checks stay exact.
      const reports = (changed: boolean) =>
        kind === "analysis_gap"
          ? [
              orientationPass().replace(
                "Report body.",
                changed
                  ? "Rollback access now has independent supporting evidence."
                  : "Rollback access is only an assumption."
              ),
            ]
          : [
              orientationEvidenceGap(),
              evidencePacket().replace(
                "Report body.",
                changed
                  ? "A second source establishes the missing fact."
                  : "The first source does not establish the missing fact."
              ),
            ];
      const cycle = (changed: boolean) => [
        ...reports(changed),
        persistedStrategy(core()),
        ...(reviewer === "critiquing_strategy" ? [veraPass()] : []),
        gap,
      ];
      {
        using service = new OrchestrationService({
          projectRoot: PROJECT_ROOT,
          env,
          modelClient: new ScriptedPlanClient(cycle(false)),
          playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
        });
        const pending = await reachState(service, runId, reviewer);
        const [result] = await service.workers.execute(pending);
        if (result === undefined) throw new Error("first failed review absent");
        expect(
          service.engine.handle({
            schema_version: 2,
            action: "step",
            identity: identity(runId),
            result,
          })
        ).toMatchObject({ action: "invoke_agent", state_id: "orienting_strategy" });
      }
      const client = new ScriptedPlanClient([...cycle(true), ...cycle(true)]);
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
      });
      let pending = service.engine.handle({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      while (pending.action === "invoke_agent" && pending.state_id !== reviewer) {
        const [result] = await service.workers.execute(pending);
        if (result === undefined) throw new Error("repair result absent");
        pending = service.engine.handle({
          schema_version: 2,
          action: "step",
          identity: identity(runId),
          result,
        });
      }
      if (pending.action !== "invoke_agent" || pending.state_id !== reviewer)
        throw new Error("second review absent");
      const [result] = await service.workers.execute(pending);
      if (result === undefined) throw new Error("second failed review absent");
      expect(
        service.engine.handle({
          schema_version: 2,
          action: "step",
          identity: identity(runId),
          result,
        })
      ).toMatchObject({ action: "invoke_agent", state_id: "orienting_strategy" });
      const beforeRecurrence = service.checkpointer.loadRunById(runId);
      if (beforeRecurrence === undefined) throw new Error("repair checkpoint absent");
      const usedBeforeRecurrence = beforeRecurrence.iteration;
      const terminal = await service.execute({
        schema_version: 2,
        action: "recover",
        identity: identity(runId),
      });
      expect(terminal).toMatchObject({
        action: "incomplete",
        met: false,
        result: {
          incomplete_reason: "repair_stalled",
          repair_stall: { origin_state: reviewer, feedback_kind: kind },
        },
      });
      const context = service.checkpointer.loadRunById(runId);
      if (context === undefined) throw new Error("stall checkpoint absent");
      // Evidence-gap routing itself has a registered charge; the repeated reviewer has none.
      expect(context.iteration).toBe(usedBeforeRecurrence + (kind === "evidence_gap" ? 1 : 0));
      const operandState =
        kind === "analysis_gap" ? "orienting_strategy" : "gathering_strategy_evidence";
      const operands = context.selectedArtifacts.filter(
        (ref) => ref.phase === operandState && ref.kind === "agent-output"
      );
      expect(operands).toHaveLength(3);
      const drafts = context.selectedArtifacts.filter((ref) => ref.kind === "strategy-draft");
      expect(drafts).toHaveLength(3);
      expect(new Set(drafts.map((ref) => ref.content_digest)).size).toBe(1);
      const reviews = context.selectedArtifacts.filter(
        (ref) => ref.phase === reviewer && ref.kind === "agent-output"
      );
      expect(reviews).toHaveLength(3);
      expect(new Set(reviews.map((ref) => ref.content_digest)).size).toBe(1);
      const [first, changed, replacement] = operands;
      if (first === undefined || changed === undefined || replacement === undefined)
        throw new Error("upstream operands absent");
      expect(changed.artifact_id).not.toBe(first.artifact_id);
      expect(changed.content_digest).not.toBe(first.content_digest);
      expect(replacement.artifact_id).not.toBe(changed.artifact_id);
      expect(replacement.content_digest).toBe(changed.content_digest);
      for (const operand of [changed, replacement]) {
        const review = client.invocations.find(
          (entry) =>
            entry.stateId === reviewer &&
            entry.inputArtifacts.some((ref) => ref.artifact_id === operand.artifact_id)
        );
        if (review === undefined)
          throw new Error("review did not receive its exact changed/replacement operand");
      }
      expect(client.invocations.filter((entry) => entry.stateId === "strategizing")).toHaveLength(
        2
      );
      expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
      const calls = client.invocations.length;
      expect(
        await service.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
      ).toEqual(terminal);
      expect(client.invocations).toHaveLength(calls);
    }
  );

  it("declines recurrence measurement when upstream semantic content cannot be verified", async () => {
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: new ScriptedPlanClient([orientationPass(), persistedStrategy(core())]),
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    const runId = `run-plan-unmeasurable-${++sequence}`;
    await reachState(service, runId, "verifying_strategy");
    const context = service.checkpointer.loadRunById(runId);
    if (context === undefined) throw new Error("review checkpoint absent");
    const playbook = new PlanPlaybook(service.artifacts, service.artifacts, service.checkpointer);
    const details = {
      verdict: "FAIL",
      gap_kind: "analysis_gap",
      repair_owner: "piper",
      findings: ["Unchanged finding."],
      evidence: ["Same check."],
      strategy_delta: "Try again.",
    };
    expect(playbook.repairProgressFingerprint(context, "verifying_strategy", details)).toMatch(
      /^[a-f0-9]{64}$/u
    );
    const read = service.artifacts.readById.bind(service.artifacts);
    vi.spyOn(service.artifacts, "readById").mockImplementation((id) =>
      service.artifacts.refById(id)?.phase === "orienting_strategy"
        ? Buffer.from("Unavailable source content.")
        : read(id)
    );
    expect(playbook.repairProgressFingerprint(context, "verifying_strategy", details)).toBeNull();
    expect(
      new PlanPlaybook().repairProgressFingerprint(context, "verifying_strategy", details)
    ).toBeNull();
  });

  it("recomputes the identical pending mechanical statement across a fresh owner restart", async () => {
    const env = environment();
    const runId = `run-plan-mechanical-restart-${++sequence}`;
    let originalTask: string;
    {
      using service = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new ScriptedPlanClient([orientationPass(), persistedStrategy(core())]),
        playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
      });
      const pending = await reachState(service, runId, "verifying_strategy");
      if (pending.action !== "invoke_agent") throw new Error("pending verifier absent");
      originalTask = pending.task;
    }
    const client = new ScriptedPlanClient([veraPass(), carrenApprove()]);
    using recovered = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env,
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    completeDirective(
      await recovered.execute({ schema_version: 2, action: "recover", identity: identity(runId) })
    );
    const invocation = client.invocations[0];
    if (invocation === undefined) throw new Error("recovered verifier absent");
    expect(invocation.task).toBe(originalTask);
    expect(invocation.task).toContain("HOST_MECHANICAL_CHECKS:");
  });

  it("refuses mechanically inconsistent exact draft/product lineage without author repair", async () => {
    const client = new ScriptedPlanClient([orientationPass(), persistedStrategy(core())]);
    using service = new OrchestrationService({
      projectRoot: PROJECT_ROOT,
      env: environment(),
      modelClient: client,
      playbookRegistration: PLAN_PLAYBOOK_REGISTRATION,
    });
    const runId = `run-plan-lineage-failure-${++sequence}`;
    const pending = await reachState(service, runId, "verifying_strategy");
    const context = service.checkpointer.loadRunById(runId);
    if (pending.action !== "invoke_agent" || context === undefined)
      throw new Error("pending review absent");
    const draftRef = pending.input_artifacts.artifacts.find(
      (entry) => entry.ref.kind === "strategy-draft"
    )?.ref;
    if (draftRef === undefined) throw new Error("draft absent");
    const metadata = service.artifacts.metadata(draftRef);
    if (metadata.schema_version !== 2) throw new Error("expected current draft metadata");
    const replacement = service.artifacts.persist({
      metadata: { ...metadata, version: metadata.version + 1, parent_ref: draftRef },
      content: persistedStrategy({
        ...core(),
        outcomes: core().outcomes.map((outcome) => ({
          ...outcome,
          success_signal: "Changed source signal.",
        })),
      }),
    });
    context.selectedArtifacts.push(replacement);
    service.checkpointer.saveRun(context, "fixture_divergent_draft_selected", {});
    const terminal = await service.execute({
      schema_version: 2,
      action: "recover",
      identity: identity(runId),
    });
    expect(terminal).toMatchObject({
      action: "incomplete",
      met: false,
      result: { incomplete_reason: "host_mechanical_validation_failed" },
    });
    expect(client.invocations).toHaveLength(2);
    expect(service.checkpointer.completionAdmission(runId)).toBeUndefined();
  });
  it("keeps verification inability closed and separate from repair-owned failures", () => {
    const worker = PLAN_PLAYBOOK_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("catalog worker absent");
    const phase = worker.phases.get("verifying_strategy");
    if (phase === undefined) throw new Error("verification schema absent");
    const details = {
      verdict: "UNVERIFIABLE",
      gap_kind: "verification_incomplete",
      repair_owner: "none",
      findings: ["Verification capability unavailable."],
      evidence: ["No independent observation."],
      strategy_delta: "Retain limitations without author repair.",
    };
    expect(validateContract(phase.schema, details, "verification inability")).toEqual(details);
    for (const invalid of [
      { ...details, verdict: "PASS" },
      { ...details, verdict: "FAIL" },
      { ...details, gap_kind: "product_gap" },
      { ...details, repair_owner: "echo" },
      { ...details, findings: [] },
      { ...details, evidence: [] },
      { ...details, invented: true },
    ])
      expect(() =>
        validateContract(phase.schema, invalid, "invalid verification inability")
      ).toThrow();
  });
});
