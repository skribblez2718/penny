import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  OrchestrationService,
  canonicalJson,
  canonicalizeDefinitionRequest,
  defineRequestConstraints,
  initializePennyState,
  specificationStrategySourceItems,
  validateCompositionAssurance,
  validateDefinitionTraceV1,
  validatePlanRequest,
  validateSpecification,
  validateStrategyV2,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type ModelClient,
  type StrategyCoreV2,
} from "@penny/orchestration";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";
import {
  genericDefinitionFrame,
  genericSpecificationCore,
  genericSpecificationFixture,
  persistedSpecificationDraftV3,
} from "../../../../../apps/orchestration/tests/fixtures/define-fixtures.js";
import createSkillExtension from "../../index.js";

class ScriptedClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private readonly scripts = new Map<string, string[]>();

  set(runId: string, outputs: string[]): void {
    this.scripts.set(runId, outputs);
  }
  reset(): void {
    this.scripts.clear();
    this.invocations.length = 0;
  }
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const runId = invocation.workflowSession?.run_id;
    if (runId === undefined) throw new Error("worker missing run correlation");
    const text = this.scripts.get(runId)?.shift();
    if (text === undefined) throw new Error(`unexpected worker in ${runId}/${invocation.stateId}`);
    return { text };
  }
}
const scripted = new ScriptedClient();

// Replace only the provider: the adapter, OrchestrationService, runner, checkpointer,
// artifact store, and assurance admission are all production implementations.
vi.mock("@penny/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penny/orchestration")>();
  return {
    ...actual,
    OrchestrationService: class extends actual.OrchestrationService {
      constructor(options: ConstructorParameters<typeof actual.OrchestrationService>[0]) {
        super({ ...options, modelClient: scripted });
      }
    },
  };
});

interface SkillTool {
  readonly name: "skill";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown
  ): Promise<{
    readonly details: {
      readonly success: boolean;
      readonly errors: string[];
      readonly output_artifact_ref?: ArtifactRef;
      readonly input_assurance?: {
        readonly mode: string;
        readonly specification_artifact_id: string | null;
        readonly assurance_ref: ArtifactRef;
      };
      readonly chain_session_id?: string;
    };
  }>;
}
function isSkillTool(value: unknown): value is SkillTool {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}

const projectRoot = path.resolve(import.meta.dirname, "../../../../..");
const roots: string[] = [];
const originalProjectRoot = process.env.PROJECT_ROOT;
const originalStateRoot = process.env.PENNY_STATE_ROOT;
const originalObservability = process.env.PI_OBSERVABILITY_ENABLED;
afterEach(() => {
  scripted.reset();
  if (originalProjectRoot === undefined) delete process.env.PROJECT_ROOT;
  else process.env.PROJECT_ROOT = originalProjectRoot;
  if (originalStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = originalStateRoot;
  if (originalObservability === undefined) delete process.env.PI_OBSERVABILITY_ENABLED;
  else process.env.PI_OBSERVABILITY_ENABLED = originalObservability;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(): { tool: SkillTool; owner: OrchestrationService } {
  const root = mkdtempSync(path.join(tmpdir(), "penny-skill-assurance-"));
  roots.push(root);
  process.env.PROJECT_ROOT = projectRoot;
  process.env.PENNY_STATE_ROOT = path.join(root, "state");
  process.env.PI_OBSERVABILITY_ENABLED = "false";
  initializePennyState(projectRoot, { env: process.env });
  const owner = new OrchestrationService({ projectRoot, env: process.env, playbookName: "plan" });
  let tool: SkillTool | undefined;
  createSkillExtension(
    createTestExtensionApi({
      onRegisterTool(value) {
        if (isSkillTool(value)) tool = value;
      },
    })
  );
  if (tool === undefined) throw new Error("skill tool was not registered");
  return { owner, tool };
}
function context() {
  return {
    cwd: projectRoot,
    isProjectTrusted: () => true,
    ui: { theme: { fg: (_color: string, text: string) => text }, notify: () => undefined },
  };
}
function summary(fields: Record<string, unknown>): string {
  return `Report.\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", ...fields })}`;
}
const defineOrientation = summary({
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
  specification_delta: "Preserve all caller boundaries.",
});
const definePass = summary({
  verdict: "PASS",
  gap_kind: "none",
  repair_owner: "none",
  findings: [],
  evidence: ["Exact source checked."],
  specification_delta: "No change required.",
});
const defineApprove = summary({
  verdict: "APPROVE",
  gap_kind: "none",
  repair_owner: "none",
  findings: [],
  evidence: ["Latest specification checked."],
  specification_delta: "No revision required.",
});
function createOutputs(): string[] {
  return [
    defineOrientation,
    Buffer.from(persistedSpecificationDraftV3(genericSpecificationFixture().draft)).toString(
      "utf8"
    ),
    definePass,
    defineApprove,
  ];
}
const planRequest = {
  schema_version: 1,
  desired_outcomes: ["A bounded transition is ready for planning."],
  current_state: { status: "provided", facts: ["The reviewed specification is available."] },
  hard_constraints: [],
  non_goals: [],
  known_uncertainties: [],
  prior_decisions: [],
};
const strictPlan = {
  schema_version: 2,
  request: planRequest,
  specification_assurance: "reviewed_definition",
};
function planOutputs(specification: ReturnType<typeof validateSpecification>): string[] {
  const required = specificationStrategySourceItems(specification).flatMap((item, index) =>
    item.required ? [index] : []
  );
  const core: StrategyCoreV2 = {
    schema_version: 2,
    disposition: "ready",
    applicability_reason: "The reviewed specification supports a bounded plan.",
    outcomes: [
      {
        statement: "A bounded transition is ready for planning.",
        desired_outcome_indexes: [0],
        success_signal: "The specification requirements and acceptance conditions are covered.",
      },
    ],
    dependencies: [],
    request_coverage: {
      current_state_fact_indexes: [0],
      input_artifact_slots: [0],
      hard_constraint_indexes: [],
      non_goal_indexes: [],
      uncertainty_indexes: [],
      prior_decision_indexes: [],
      blocked_desired_outcome_indexes: [],
    },
    blockers: [],
    confidence: "CERTAIN",
    source_item_coverage: required.map((source_item_index) => ({
      source_item_index,
      disposition: "addressed",
      strategy_outcome_indexes: [0],
      rationale: "The bounded outcome preserves the reviewed specification item.",
    })),
    unsupported_strategy_elements: [],
  };
  return [
    summary({
      orientation_complete: true,
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      strategy_delta: "Proceed to strategy.",
    }),
    `Bounded strategy.\nSTRATEGY_CORE:${canonicalJson(core)}\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", complete: true })}`,
    summary({
      verdict: "PASS",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["Exact reviewed strategy checked."],
      strategy_delta: "Proceed to quality review.",
    }),
    summary({
      verdict: "APPROVE",
      gap_kind: "none",
      repair_owner: "none",
      findings: [],
      evidence: ["Latest strategy checked."],
      strategy_delta: "Approve.",
    }),
  ];
}
function outputRef(result: Awaited<ReturnType<SkillTool["execute"]>>): ArtifactRef {
  expect(result.details.success, result.details.errors.join(", ")).toBe(true);
  const ref = result.details.output_artifact_ref;
  if (ref === undefined) throw new Error("complete skill omitted terminal core ref");
  return ref;
}
function readSpec(owner: OrchestrationService, ref: ArtifactRef) {
  expect(ref.kind).toBe("specification");
  expect(ref.content_schema).toEqual({ schema_id: "penny.specification.v1", schema_version: 1 });
  return validateSpecification(
    JSON.parse(owner.artifacts.readById(ref.artifact_id).toString("utf8"))
  );
}
function assertAssurance(owner: OrchestrationService, runId: string, ref: ArtifactRef): void {
  const run = owner.checkpointer.loadRunById(runId);
  if (run === undefined) throw new Error("consumer run missing");
  const assuranceRef = run.selectedArtifacts.find((item) => item.kind === "composition-assurance");
  if (assuranceRef === undefined) throw new Error("consumer assurance missing");
  const assurance = validateCompositionAssurance(
    JSON.parse(owner.artifacts.readById(assuranceRef.artifact_id).toString("utf8"))
  );
  expect(assurance).toMatchObject({
    mode: "reviewed_definition",
    specification_ref: ref,
    producer: { run_id: ref.run_id },
  });
  expect(assurance.checked_artifacts.flatMap((item) => item.roles)).toContain("trace");
  expect(owner.checkpointer.completionAdmission(runId)).toBeDefined();
}

describe("Define/Plan real skill entrypoint assurance", () => {
  it("refuses strict Plan on an uncommitted exact SpecificationV1 without creating a consumer run", async () => {
    const { owner, tool } = harness();
    using _disposable = owner;
    const specification: ArtifactRef = owner.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: "uncommitted-definition",
        phase: "sealing_specification",
        branch_id: null,
        kind: "specification",
        operation_id: "uncommitted-product",
        version: 1,
        producer: "host:specification-sealer",
        media_type: "application/json",
        content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(genericSpecificationFixture().specification),
    });
    const result = await tool.execute(
      "strict-refusal",
      {
        skill_name: "plan",
        session_id: "strict-plan-refusal",
        goal: "Plan a bounded next step.",
        input_artifacts: [specification.artifact_id],
        constraints: strictPlan,
      },
      undefined,
      undefined,
      context()
    );
    expect(result.details.success).toBe(false);
    expect(result.details.errors).toContain("SPECIFICATION_ASSURANCE_UNAVAILABLE");
    expect(owner.checkpointer.runExists("strict-plan-refusal")).toBe(false);
    expect(scripted.invocations).toHaveLength(0);
  });

  it("completes real Define → strict Plan by exact single IDs and by chain {previous}", async () => {
    const { owner, tool } = harness();
    using _disposable = owner;
    const fixture = genericSpecificationFixture();
    const defineConstraints = {
      schema_version: 2,
      request: defineRequestConstraints(fixture.request),
      specification_assurance: "reviewed_definition",
    };
    scripted.set("single-define", createOutputs());
    const defined = outputRef(
      await tool.execute(
        "single-define",
        {
          skill_name: "define",
          session_id: "single-define",
          goal: fixture.request.goal,
          constraints: defineConstraints,
        },
        undefined,
        undefined,
        context()
      )
    );
    const specification = readSpec(owner, defined);
    const traceRef = owner.checkpointer
      .loadRunById("single-define")
      ?.selectedArtifacts.find((item) => item.kind === "definition-trace");
    if (traceRef === undefined) throw new Error("completed Define omitted trace");
    expect(
      validateDefinitionTraceV1(
        JSON.parse(owner.artifacts.readById(traceRef.artifact_id).toString("utf8"))
      ).product_ref
    ).toEqual(defined);
    expect(owner.checkpointer.completionAdmission("single-define")).toBeDefined();
    expect(
      scripted.invocations
        .filter((item) => item.workflowSession?.run_id === "single-define")
        .map((item) => item.stateId)
    ).toEqual([
      "framing_definition",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);

    scripted.set("single-plan", planOutputs(specification));
    const planResult = await tool.execute(
      "single-plan",
      {
        skill_name: "plan",
        session_id: "single-plan",
        goal: "Plan the bounded transition.",
        input_artifacts: [defined.artifact_id],
        constraints: strictPlan,
      },
      undefined,
      undefined,
      context()
    );
    const strategy = outputRef(planResult);
    expect(strategy.content_schema).toEqual({ schema_id: "penny.strategy.v2", schema_version: 2 });
    expect(
      validateStrategyV2(
        JSON.parse(owner.artifacts.readById(strategy.artifact_id).toString("utf8"))
      ).source_lineage.input_artifact_ids
    ).toContain(defined.artifact_id);
    expect(planResult.details.input_assurance).toMatchObject({
      mode: "reviewed_definition",
      specification_artifact_id: defined.artifact_id,
    });
    assertAssurance(owner, "single-plan", defined);
    const admittedPlan = owner.checkpointer.loadRunById("single-plan")?.snapshot();
    const callsBeforeReplay = scripted.invocations.length;
    const replay = await tool.execute(
      "single-plan-replay",
      {
        skill_name: "plan",
        session_id: "single-plan",
        goal: "Plan the bounded transition.",
        input_artifacts: [defined.artifact_id],
        constraints: strictPlan,
      },
      undefined,
      undefined,
      context()
    );
    expect(outputRef(replay)).toEqual(strategy);
    for (const changed of [
      { input_artifacts: [defined.artifact_id], constraints: planRequest },
      { input_artifacts: [], constraints: strictPlan },
    ]) {
      const refused = await tool.execute(
        "single-plan-changed-admission",
        {
          skill_name: "plan",
          session_id: "single-plan",
          goal: "Plan the bounded transition.",
          ...changed,
        },
        undefined,
        undefined,
        context()
      );
      expect(refused.details.success).toBe(false);
      expect(
        refused.details.errors.some(
          (error) =>
            error.startsWith("SPECIFICATION_ASSURANCE_") ||
            error === "SKILL_RECOVERY_BINDING_INVALID"
        )
      ).toBe(true);
      expect(owner.checkpointer.loadRunById("single-plan")?.snapshot()).toEqual(admittedPlan);
    }
    expect(scripted.invocations).toHaveLength(callsBeforeReplay);
    const defineReplay = await tool.execute(
      "single-define-replay",
      {
        skill_name: "define",
        session_id: "single-define",
        goal: fixture.request.goal,
        constraints: defineConstraints,
      },
      undefined,
      undefined,
      context()
    );
    expect(outputRef(defineReplay)).toEqual(defined);
    expect(scripted.invocations).toHaveLength(callsBeforeReplay);
    expect(
      scripted.invocations
        .filter((item) => item.workflowSession?.run_id === "single-plan")
        .map((item) => item.stateId)
    ).toEqual(["orienting_strategy", "strategizing", "verifying_strategy", "critiquing_strategy"]);

    scripted.set("chain-define", createOutputs());
    scripted.set("chain-plan", planOutputs(specification));
    const chained = await tool.execute(
      "chain",
      {
        chain: [
          {
            skill_name: "define",
            goal: fixture.request.goal,
            session_id: "chain-define",
            constraints: defineConstraints,
          },
          {
            skill_name: "plan",
            goal: "Plan from {previous}",
            session_id: "chain-plan",
            constraints: strictPlan,
          },
        ],
      },
      undefined,
      undefined,
      context()
    );
    expect(chained.details.success, chained.details.errors.join(", ")).toBe(true);
    const chainTerminal = owner.checkpointer.loadRunById("chain-define")?.terminalDirective;
    if (chainTerminal?.action !== "complete") throw new Error("chain Define did not complete");
    const chainSpec = chainTerminal.result.output_artifact_ref;
    if (!isRecord(chainSpec) || typeof chainSpec.artifact_id !== "string")
      throw new Error("chain Define omitted core");
    const exactRef = owner.checkpointer
      .loadRunById("chain-define")
      ?.selectedArtifacts.find(
        (item) => item.kind === "specification" && item.artifact_id === chainSpec.artifact_id
      );
    if (exactRef === undefined)
      throw new Error("chain terminal core is not the selected specification");
    readSpec(owner, exactRef);
    assertAssurance(owner, "chain-plan", exactRef);
    const chainPlan = owner.checkpointer.loadRunById("chain-plan");
    const chainRequestRef = chainPlan?.selectedArtifacts.find(
      (item) => item.kind === "plan-request"
    );
    const chainStrategyRef = chainPlan?.selectedArtifacts.find((item) => item.kind === "strategy");
    if (chainRequestRef === undefined || chainStrategyRef === undefined)
      throw new Error("chain Plan omitted request or terminal strategy");
    expect(
      validatePlanRequest(
        JSON.parse(owner.artifacts.readById(chainRequestRef.artifact_id).toString("utf8"))
      )
    ).toMatchObject({
      goal: `Plan from ${exactRef.artifact_id}`,
      input_artifact_ids: [exactRef.artifact_id],
    });
    expect(
      validateStrategyV2(
        JSON.parse(owner.artifacts.readById(chainStrategyRef.artifact_id).toString("utf8"))
      ).source_lineage.input_artifact_ids
    ).toEqual([exactRef.artifact_id]);
    expect(
      scripted.invocations
        .filter((item) => item.workflowSession?.run_id === "chain-plan")[0]
        ?.inputArtifacts.map((ref) => ref.artifact_id)
    ).toContain(exactRef.artifact_id);
  });

  it("completes strict Define revision from an exact reviewed parent", async () => {
    const { owner, tool } = harness();
    using _disposable = owner;
    const fixture = genericSpecificationFixture();
    scripted.set("revision-parent", createOutputs());
    const parent = outputRef(
      await tool.execute(
        "revision-parent",
        {
          skill_name: "define",
          session_id: "revision-parent",
          goal: fixture.request.goal,
          constraints: {
            schema_version: 2,
            request: defineRequestConstraints(fixture.request),
            specification_assurance: "semantic_only",
          },
        },
        undefined,
        undefined,
        context()
      )
    );
    const constraints = { ...defineRequestConstraints(fixture.request), mode: "revise" };
    const request = canonicalizeDefinitionRequest({
      goal: fixture.request.goal,
      constraints,
      exactInputArtifactIds: [parent.artifact_id],
    });
    const core = genericSpecificationCore(genericDefinitionFrame(request));
    const draft = {
      ...core,
      specification_report: "This complete revision preserves the parent boundary.",
      objectives: core.objectives.map((entry, index) =>
        index === 0 ? { ...entry, source_item_indexes: [...entry.source_item_indexes, 6] } : entry
      ),
      source_coverage: [
        ...core.source_coverage,
        {
          source_item_index: 6,
          disposition: "incorporated" as const,
          rationale: "The exact parent anchors this revision.",
        },
      ],
    };
    scripted.set("strict-revision", [
      defineOrientation,
      Buffer.from(persistedSpecificationDraftV3(draft, request)).toString("utf8"),
      definePass,
      defineApprove,
    ]);
    const revisedResult = await tool.execute(
      "strict-revision",
      {
        skill_name: "define",
        session_id: "strict-revision",
        goal: fixture.request.goal,
        input_artifacts: [parent.artifact_id],
        constraints: {
          schema_version: 2,
          request: constraints,
          specification_assurance: "reviewed_definition",
        },
      },
      undefined,
      undefined,
      context()
    );
    const revised = outputRef(revisedResult);
    const revisedSpec = validateSpecification(
      JSON.parse(owner.artifacts.readById(revised.artifact_id).toString("utf8")),
      { priorSpecification: readSpec(owner, parent) }
    );
    expect(revisedSpec.source_lineage.prior_specification_artifact_id).toBe(parent.artifact_id);
    const revisionTraceRef = owner.checkpointer
      .loadRunById("strict-revision")
      ?.selectedArtifacts.find((item) => item.kind === "definition-trace");
    if (revisionTraceRef === undefined) throw new Error("completed revision omitted trace");
    expect(
      validateDefinitionTraceV1(
        JSON.parse(owner.artifacts.readById(revisionTraceRef.artifact_id).toString("utf8"))
      ).product_ref
    ).toEqual(revised);
    expect(revisedResult.details.input_assurance).toMatchObject({
      mode: "reviewed_definition",
      specification_artifact_id: parent.artifact_id,
    });
    assertAssurance(owner, "strict-revision", parent);
    expect(
      scripted.invocations
        .filter((item) => item.workflowSession?.run_id === "strict-revision")
        .map((item) => item.stateId)
    ).toEqual([
      "framing_definition",
      "authoring_specification",
      "verifying_specification",
      "critiquing_specification",
    ]);
  });
});
