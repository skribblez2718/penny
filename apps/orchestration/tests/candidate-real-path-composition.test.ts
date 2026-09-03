import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactRefSchema,
  ArtifactStore,
  Checkpointer,
  DECIDE_CANDIDATE_REGISTRATION,
  OrchestrationEngine,
  OrchestrationRunner,
  PLAN_CANDIDATE_REGISTRATION,
  WorkerExecutor,
  canonicalJson,
  validateContract,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type Directive,
  type JsonValue,
  type ModelClient,
  type PlaybookRegistrationV1,
  type StrategyCoreV1,
} from "../src/index.js";
import { researchSemanticDraftFixture } from "./helpers/research-semantic-draft.js";
import { decisionRequest, persistedDecisionDraft } from "./fixtures/decision-fixtures.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const roots: string[] = [];
let sequence = 0;

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-candidate-chain-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function identity(runId: string, playbook: string) {
  return {
    schema_version: 2 as const,
    run_id: runId,
    session_id: runId,
    playbook,
    engine_owner: "typescript" as const,
  };
}

function terminalOutput(directive: Directive): ArtifactRef {
  if (directive.action !== "complete") {
    throw new Error(`expected complete chain directive, received '${directive.action}'`);
  }
  const output = directive.result.output_artifact_ref;
  return validateContract(ArtifactRefSchema, output, "complete chain output artifact ref");
}

function summary(details: Record<string, JsonValue>): string {
  return `Report body.\nSUMMARY:${JSON.stringify({ confidence: "PROBABLE", ...details })}`;
}

class ResearchChainClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];

  constructor(private readonly artifacts: ArtifactStore) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    switch (invocation.stateId) {
      case "planning":
        return {
          text: summary({ plan_steps: ["inspect exact chain evidence"], plan_complete: true }),
          details: { plan_steps: ["inspect exact chain evidence"], plan_complete: true },
        };
      case "researching":
        return {
          text: summary({ explore_complete: true }),
          details: { explore_complete: true },
        };
      case "synthesizing": {
        const draft = researchSemanticDraftFixture(invocation, this.artifacts, {
          title: "Provider-free composition evidence",
          executiveSummary: "The exact source supports a bounded decision and strategy.",
          claimStatement: "The exact source supports the candidate chain.",
          sectionHeading: "Composition",
          sectionBody: "Research produced the exact semantic product consumed downstream.",
        });
        return {
          text: `${canonicalJson(draft)}\nSUMMARY:{"confidence":"PROBABLE","synthesis_complete":true}`,
          details: { synthesis_complete: true },
        };
      }
      case "validating":
        return {
          text: summary({ verdict: "PASS", unsupported_claims: [], evidence: ["exact source"] }),
          details: { verdict: "PASS", unsupported_claims: [], evidence: ["exact source"] },
        };
      case "critiquing_plan":
      case "critiquing_report":
        return {
          text: summary({ verdict: "APPROVE", issues: [], evidence: ["exact artifact"] }),
          details: { verdict: "APPROVE", issues: [], evidence: ["exact artifact"] },
        };
      default:
        throw new Error(`unexpected Research chain state '${invocation.stateId}'`);
    }
  }
}

class ScriptedChainClient implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  private cursor = 0;

  constructor(private readonly outputs: readonly string[]) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const text = this.outputs[this.cursor];
    this.cursor += 1;
    if (text === undefined) throw new Error("scripted candidate chain output is exhausted");
    return { text };
  }
}

async function executeRegistered(input: {
  readonly root: string;
  readonly artifacts: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly client: ModelClient;
  readonly request: unknown;
  readonly registration?: PlaybookRegistrationV1;
}): Promise<Directive> {
  const engine = new OrchestrationEngine(input.checkpointer, {
    projectRoot: input.root,
    maxSteps: 96,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactRevisions: input.artifacts,
    artifactStore: input.artifacts,
    artifactReader: input.artifacts,
    ...(input.registration === undefined
      ? {}
      : {
          playbookName: input.registration.name,
          playbookRegistration: input.registration,
        }),
  });
  const workers = new WorkerExecutor(input.client, input.artifacts, {
    projectRoot: input.root,
    parallelConcurrency: 2,
    registration: engine.registration,
  });
  workers.setReceiptAuthority(engine.receiptAuthority);
  workers.setLivenessController(engine.liveness);
  return await new OrchestrationRunner(engine, workers).runUntilBoundary(
    engine.handle(input.request)
  );
}

function decideStart(root: string, runId: string, grounded: ArtifactRef) {
  const request = decisionRequest();
  const { decision_question: goal, ...constraints } = request;
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId, "decide"),
    goal,
    constraints,
    project_root: root,
    trust_profile: "hardened-untrusted" as const,
    input_artifacts: {
      schema_version: 2 as const,
      artifacts: [{ slot: "prior-grounded-synthesis", ref: grounded }],
    },
  };
}

function strategyCore(): StrategyCoreV1 {
  return {
    schema_version: 1,
    disposition: "ready",
    applicability_reason: "The exact research and decision products support a bounded strategy.",
    outcomes: [
      {
        statement: "A provider-free candidate chain is demonstrated.",
        desired_outcome_indexes: [0],
        success_signal: "All three terminal semantic products are exact and readable.",
      },
    ],
    dependencies: [],
    request_coverage: {
      current_state_fact_indexes: [0],
      input_artifact_slots: [0, 1],
      hard_constraint_indexes: [0],
      non_goal_indexes: [0],
      uncertainty_indexes: [0],
      prior_decision_indexes: [0],
      blocked_desired_outcome_indexes: [],
    },
    blockers: [],
    confidence: "PROBABLE",
  };
}

function planStart(root: string, runId: string, grounded: ArtifactRef, decision: ArtifactRef) {
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: identity(runId, "plan"),
    goal: "Demonstrate an exact provider-free Research to Decide to Plan chain.",
    constraints: {
      schema_version: 1,
      desired_outcomes: ["A provider-free candidate chain is demonstrated."],
      current_state: { status: "provided", facts: ["Research and Decide completed."] },
      hard_constraints: ["Do not execute or call a provider."],
      non_goals: ["Do not taskify the strategy."],
      known_uncertainties: [
        { statement: "No live semantic quality was measured.", material: true },
      ],
      prior_decisions: [
        {
          statement: "Keep candidates disabled.",
          binding_effect: "No enablement or promotion is authorized.",
        },
      ],
    },
    project_root: root,
    trust_profile: "hardened-untrusted" as const,
    input_artifacts: {
      schema_version: 2 as const,
      artifacts: [
        { slot: "prior-grounded-synthesis", ref: grounded },
        { slot: "prior-decision", ref: decision },
      ],
    },
  };
}

describe("provider-free real-path candidate composition", () => {
  it("executes Research → Decide → Plan with actual terminal semantic products", async () => {
    const root = temporaryRoot();
    using artifacts = new ArtifactStore(path.join(root, "artifacts"));
    using checkpointer = new Checkpointer(path.join(root, "orchestration.db"));
    sequence += 1;

    const researchClient = new ResearchChainClient(artifacts);
    const research = terminalOutput(
      await executeRegistered({
        root,
        artifacts,
        checkpointer,
        client: researchClient,
        request: {
          schema_version: 2,
          action: "start",
          identity: identity(`chain-research-${sequence}`, "research"),
          goal: "Establish exact evidence for a provider-free candidate chain.",
          constraints: { mode: "quick" },
          project_root: root,
          trust_profile: "hardened-untrusted",
        },
      })
    );
    expect(research.content_schema).toEqual({
      schema_id: "penny.grounded-synthesis.v1",
      schema_version: 1,
    });

    const decideClient = new ScriptedChainClient([
      summary({
        analysis_complete: true,
        gap_kind: "none",
        repair_owner: "none",
        findings: ["All request alternatives and exact imported evidence were mapped."],
        strategy_delta: "Proceed to decision authorship.",
      }),
      persistedDecisionDraft("selected"),
      summary({
        verdict: "PASS",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["Exact request, analysis, imported synthesis, draft, and decision agree."],
        strategy_delta: "Proceed to quality review.",
      }),
      summary({
        verdict: "APPROVE",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["The exact Vera-passed decision is useful and defensible."],
        strategy_delta: "Approve the exact decision.",
      }),
    ]);
    const decision = terminalOutput(
      await executeRegistered({
        root,
        artifacts,
        checkpointer,
        client: decideClient,
        registration: DECIDE_CANDIDATE_REGISTRATION,
        request: decideStart(root, `chain-decide-${sequence}`, research),
      })
    );
    expect(decision.content_schema).toEqual({ schema_id: "penny.decision.v2", schema_version: 2 });
    expect(decideClient.invocations[0]?.inputArtifacts.map((ref) => ref.artifact_id)).toContain(
      research.artifact_id
    );

    const planClient = new ScriptedChainClient([
      summary({
        orientation_complete: true,
        gap_kind: "none",
        repair_owner: "none",
        findings: ["Goal, current state, constraints, and both exact imports were mapped."],
        strategy_delta: "Proceed to strategy authorship.",
      }),
      `The strategy preserves implementation freedom while covering current state, outcomes, assumptions, risks, contingencies, trade-offs, and decision points.\nSTRATEGY_CORE:${canonicalJson(strategyCore())}\nSUMMARY:{"confidence":"PROBABLE","complete":true}`,
      summary({
        verdict: "PASS",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["Exact request, imports, orientation, draft, and strategy agree."],
        strategy_delta: "Proceed to quality review.",
      }),
      summary({
        verdict: "APPROVE",
        gap_kind: "none",
        repair_owner: "none",
        findings: [],
        evidence: ["The exact Vera-passed strategy is coherent and bounded."],
        strategy_delta: "Approve the exact strategy.",
      }),
    ]);
    const strategy = terminalOutput(
      await executeRegistered({
        root,
        artifacts,
        checkpointer,
        client: planClient,
        registration: PLAN_CANDIDATE_REGISTRATION,
        request: planStart(root, `chain-plan-${sequence}`, research, decision),
      })
    );
    expect(strategy.content_schema).toEqual({ schema_id: "penny.strategy.v1", schema_version: 1 });
    expect(planClient.invocations[0]?.inputArtifacts.map((ref) => ref.artifact_id)).toEqual(
      expect.arrayContaining([research.artifact_id, decision.artifact_id])
    );

    const staleClient = new ScriptedChainClient([]);
    await expect(
      executeRegistered({
        root,
        artifacts,
        checkpointer,
        client: staleClient,
        registration: PLAN_CANDIDATE_REGISTRATION,
        request: planStart(root, `chain-plan-stale-${sequence}`, research, {
          ...decision,
          content_digest: "0".repeat(64),
        }),
      })
    ).rejects.toThrow(/COMPOSITION_ARTIFACT_STALE/u);
    expect(checkpointer.runExists(`chain-plan-stale-${sequence}`)).toBe(false);
    expect(staleClient.invocations).toHaveLength(0);
  });
});
