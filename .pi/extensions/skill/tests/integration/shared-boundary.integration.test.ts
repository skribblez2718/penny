/** Public producer -> shared parser -> compaction, with real durable orchestration.
 * Only cognition is replaced. All stores are isolated temporary fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Checkpointer,
  OrchestrationService,
  canonicalJson,
  initializePennyState,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type ModelClient,
} from "@penny/orchestration";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord, requireDefined } from "../../../../lib/tests/test-narrowers.js";
import { parseCurrentSkillResult, type SkillResult } from "@penny/orchestration";
import { collectExplicitRunIds } from "../../../compaction/index.js";
import { readExactCheckpoints } from "../../../compaction/checkpointer.js";
import type { SessionMessage } from "../../../compaction/pi-messages.js";
import {
  decisionRequest,
  persistedDecisionDraft,
} from "../../../../../apps/orchestration/tests/fixtures/decision-fixtures.js";
import { researchSemanticDraftFixture } from "../../../../../apps/orchestration/tests/helpers/research-semantic-draft.js";
import { validateGroundedSynthesis } from "../../../../../apps/orchestration/dist/skill-contracts/research.js";
import { persistEvidenceContext } from "../../../../../apps/orchestration/tests/helpers/evidence-context.js";
import { readChainCheckpoint, saveChainCheckpoint } from "../../chain-checkpoint.js";
import skillExtension from "../../index.js";
import { PlaybookUiOwner } from "../../playbook-ui.js";
import {
  registerTrustedQuestionnaireTransport,
  renderedQuestionsDigest,
  resolveTrustedQuestionnaireTransport,
  consumeTrustedQuestionnaireTransport,
  revokeTrustedQuestionnaireTransport,
} from "../../execution-receipts.js";

const sourceRoot = path.resolve(import.meta.dirname, "../../../../..");
const envKeys = [
  "PROJECT_ROOT",
  "PENNY_STATE_ROOT",
  "PENNY_SKILLS_DIR",
  "PI_OBSERVABILITY_ENABLED",
];
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const owners: OrchestrationService[] = [];

function summary(value: Record<string, unknown>): string {
  return `Fixture evidence.\nSUMMARY:${canonicalJson({ confidence: "CERTAIN", ...value })}`;
}

class CognitionFixture implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  artifacts: OrchestrationService["artifacts"] | undefined;
  interruptRun: string | undefined;
  interruptState: string | undefined;
  clarifyRun: string | undefined;
  readonly clarifyRuns = new Set<string>();
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const runId = invocation.workflowSession?.run_id;
    if (runId === this.interruptRun && invocation.stateId === this.interruptState) {
      this.interruptRun = undefined;
      throw new Error("fixture process interruption");
    }
    if (
      (runId === this.clarifyRun || (runId !== undefined && this.clarifyRuns.has(runId))) &&
      invocation.stateId === "synthesizing"
    ) {
      if (runId !== undefined) this.clarifyRuns.delete(runId);
      this.clarifyRun = undefined;
      return {
        text: summary({
          synthesis_complete: false,
          needs_clarification: true,
          clarifying_questions: ["Which source scope is intended?"],
        }),
      };
    }
    switch (invocation.stateId) {
      case "planning":
        return { text: summary({ plan_steps: ["one"], plan_complete: true }) };
      case "researching":
        return { text: summary({ explore_complete: true }) };
      case "synthesizing":
        return {
          text: `${canonicalJson(
            researchSemanticDraftFixture(
              invocation,
              requireDefined(this.artifacts, "fixture artifact store missing")
            )
          )}\nSUMMARY:{"confidence":"CERTAIN","synthesis_complete":true}`,
        };
      case "validating":
        return {
          text: summary({
            verdict: "PASS",
            unsupported_claims: [],
            evidence: ["Exact fixture checked."],
          }),
        };
      case "analyzing_decision":
        return {
          text: summary({
            analysis_complete: true,
            gap_kind: "none",
            repair_owner: "none",
            findings: [],
            strategy_delta: "Proceed.",
          }),
        };
      case "deciding":
        return { text: persistedDecisionDraft() };
      case "verifying_decision":
        return {
          text: summary({
            verdict: "PASS",
            gap_kind: "none",
            repair_owner: "none",
            findings: [],
            evidence: ["Exact fixture checked."],
            strategy_delta: "Proceed.",
          }),
        };
      case "critiquing_decision":
        return {
          text: summary({
            verdict: "APPROVE",
            gap_kind: "none",
            repair_owner: "none",
            findings: [],
            evidence: ["Exact fixture checked."],
            strategy_delta: "Approve.",
          }),
        };
      default:
        throw new Error(`unexpected fixture state: ${invocation.stateId}`);
    }
  }
  reset(): void {
    this.invocations.length = 0;
    this.artifacts = undefined;
    this.interruptRun = undefined;
    this.interruptState = undefined;
    this.clarifyRun = undefined;
    this.clarifyRuns.clear();
  }
}
const cognition = new CognitionFixture();
vi.mock("@penny/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penny/orchestration")>();
  return {
    ...actual,
    OrchestrationService: class extends actual.OrchestrationService {
      constructor(options: ConstructorParameters<typeof actual.OrchestrationService>[0]) {
        super({ ...options, modelClient: cognition });
      }
    },
  };
});

interface PublicSkillTool {
  name: "skill";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { details: unknown }) => void) | undefined,
    context: unknown
  ): Promise<{ details: SkillResult; content: Array<{ type: "text"; text: string }> }>;
  renderResult(
    result: { details: SkillResult; content: Array<{ type: "text"; text: string }> },
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown
  ): { render(width: number): string[] };
}
function isSkillTool(value: unknown): value is PublicSkillTool {
  return (
    isRecord(value) &&
    value.name === "skill" &&
    typeof value.execute === "function" &&
    typeof value.renderResult === "function"
  );
}
function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "penny-shared-boundary-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  process.env.PROJECT_ROOT = projectRoot;
  process.env.PENNY_STATE_ROOT = path.join(root, "state");
  process.env.PENNY_SKILLS_DIR = path.join(sourceRoot, ".pi/skills");
  process.env.PI_OBSERVABILITY_ENABLED = "false";
  const state = initializePennyState(projectRoot, { env: process.env });
  const owner = new OrchestrationService({
    projectRoot,
    env: process.env,
    playbookName: "research",
  });
  owners.push(owner);
  cognition.artifacts = owner.artifacts;
  const register = (): PublicSkillTool => {
    let tool: PublicSkillTool | undefined;
    skillExtension(
      createTestExtensionApi({
        onRegisterTool(value) {
          if (isSkillTool(value)) tool = value;
        },
      })
    );
    return requireDefined(tool, "public skill tool missing");
  };
  const context = {
    cwd: projectRoot,
    isProjectTrusted: () => true,
    ui: { theme: { fg: (_color: string, text: string) => text }, notify() {} },
  };
  return { owner, projectRoot, register, context, state };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) owner.close();
  cognition.reset();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function explicitCore(owner: OrchestrationService, name: string): ArtifactRef {
  const fixture: unknown = JSON.parse(
    readFileSync(
      path.join(
        sourceRoot,
        "apps/orchestration/tests/fixtures/skills/research/positive-vectors.json"
      ),
      "utf8"
    )
  );
  if (!isRecord(fixture)) throw new Error("positive core fixture missing");
  return owner.artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: name,
      phase: "sealing_core",
      branch_id: null,
      kind: "semantic-core",
      operation_id: name,
      version: 1,
      producer: "host:fixture",
      media_type: "application/json",
      content_schema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson(validateGroundedSynthesis(fixture.grounded_synthesis)),
  });
}
function exchange(details: SkillResult): SessionMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "skill", arguments: {} }],
    },
    { role: "toolResult", toolName: "skill", toolCallId: "call", content: "Result", details },
  ];
}

async function interruptedChain(name: "research" | "decide") {
  const h = harness();
  const explicit =
    name === "decide"
      ? persistEvidenceContext(h.owner.artifacts, "explicit").ref
      : explicitCore(h.owner, "explicit-core");
  const extra =
    name === "decide"
      ? persistEvidenceContext(h.owner.artifacts, "extra").ref
      : explicitCore(h.owner, "extra-core");
  const goal = name === "research" ? "Integrate {previous}" : decisionRequest().decision_question;
  const { decision_question: _question, ...decisionConstraints } = decisionRequest();
  const constraints = name === "research" ? { mode: "quick" } : decisionConstraints;
  cognition.interruptRun = "second-run";
  cognition.interruptState = name === "research" ? "researching" : "deciding";
  let chainId: string | undefined;
  await expect(
    h.register().execute(
      "interrupted-chain",
      {
        chain: [
          {
            skill_name: "research",
            session_id: "first-run",
            goal: "Create the predecessor",
            constraints: { mode: "quick" },
          },
          {
            skill_name: name,
            session_id: "second-run",
            goal,
            constraints,
            input_artifacts: [explicit.artifact_id],
          },
        ],
      },
      undefined,
      (update) => {
        if (isRecord(update.details) && typeof update.details.session_id === "string")
          chainId = update.details.session_id;
      },
      h.context
    )
  ).rejects.toThrow("fixture process interruption");
  const id = requireDefined(chainId, "chain progress did not provide its exact ID");
  const checkpoint = requireDefined(
    readChainCheckpoint(id, h.projectRoot),
    "durable chain missing"
  );
  expect(checkpoint.steps.map((step) => step.status)).toEqual(["complete", "running"]);
  const predecessor = requireDefined(
    checkpoint.steps[0]?.output_artifact_ref,
    "predecessor missing"
  );
  expect(checkpoint.steps[0]?.handoff_artifact_ref).toEqual(predecessor);
  const originalRun = requireDefined(
    h.owner.checkpointer.loadRunById("second-run"),
    "second run missing"
  );
  const request = requireDefined(
    originalRun.selectedArtifacts.find(
      (ref) => ref.kind === (name === "research" ? "research-request" : "decision-request")
    ),
    "admitted request missing"
  );
  const refs = [predecessor, explicit].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  expect(h.owner.artifacts.metadata(request).upstream_refs).toEqual(refs);
  expect(originalRun.pendingDirective?.action).toBe("invoke_agent");
  return {
    ...h,
    id,
    checkpoint,
    predecessor,
    explicit,
    extra,
    request,
    originalRun,
    goal: goal.replaceAll("{previous}", predecessor.artifact_id),
    constraints,
    name,
  };
}

describe("current shared-boundary public integration", () => {
  it.each(["research", "decide"] as const)(
    "recovers interrupted SECOND chain %s with predecessor + explicit inputs and skips completed work",
    async (name) => {
      const h = await interruptedChain(name);
      const preserved = new Map(
        h.originalRun.selectedArtifacts.map((ref) => [ref.artifact_id, h.owner.artifacts.read(ref)])
      );
      const priorCalls = cognition.invocations.length;
      const firstCalls = cognition.invocations.filter(
        (item) => item.workflowSession?.run_id === "first-run"
      ).length;
      const originalBytes = h.owner.artifacts.read(h.request);
      const result = await h
        .register()
        .execute("resume", { resume_chain: h.id }, undefined, undefined, h.context);
      expect(result.details.success, result.details.errors.join("; ")).toBe(true);
      expect(parseCurrentSkillResult(result.details)).toEqual(result.details);
      expect(result.details.chain_results?.map((item) => item.session_id)).toEqual([
        "first-run",
        "second-run",
      ]);
      expect(
        cognition.invocations.filter((item) => item.workflowSession?.run_id === "first-run")
      ).toHaveLength(firstCalls);
      const recoveredInvocation = requireDefined(
        cognition.invocations[priorCalls],
        "recovered worker absent"
      );
      expect(recoveredInvocation.workflowSession?.run_id).toBe("second-run");
      expect(recoveredInvocation.stateId).toBe(h.originalRun.stateId);
      const pending = h.originalRun.pendingDirective;
      if (pending?.action !== "invoke_agent") throw new Error("original worker missing");
      expect(recoveredInvocation.inputArtifacts).toEqual(
        pending.input_artifacts.artifacts.map((binding) => binding.ref)
      );
      expect(h.owner.artifacts.read(h.request)).toEqual(originalBytes);
      for (const [id, bytes] of preserved) expect(h.owner.artifacts.readById(id)).toEqual(bytes);
      expect(readChainCheckpoint(h.id, h.projectRoot)?.chain_status).toBe("complete");
      expect(h.owner.checkpointer.completionAdmission("second-run")).toBeDefined();
    }
  );

  it.each(["research", "decide"] as const)(
    "refuses omitted/added/removed/replaced/corrupt %s recovery refs without changing admission",
    async (name) => {
      const h = await interruptedChain(name);
      const snapshot = h.originalRun.snapshot();
      const events = h.owner.checkpointer.events("second-run");
      const requestBytes = h.owner.artifacts.read(h.request);
      const calls = cognition.invocations.length;
      const tool = h.register();
      for (const ids of [
        undefined,
        [],
        [h.predecessor.artifact_id],
        [h.explicit.artifact_id],
        [h.predecessor.artifact_id, h.explicit.artifact_id, h.extra.artifact_id],
        [h.predecessor.artifact_id, h.extra.artifact_id],
      ]) {
        await expect(
          tool.execute(
            "wrong-input",
            {
              skill_name: name,
              session_id: "second-run",
              goal: h.goal,
              constraints: h.constraints,
              ...(ids === undefined ? {} : { input_artifacts: ids }),
            },
            undefined,
            undefined,
            h.context
          )
        ).resolves.toMatchObject({
          details: { success: false, state: "refused", errors: ["SKILL_RECOVERY_BINDING_INVALID"] },
        });
      }
      await expect(
        tool.execute(
          "changed-request",
          {
            skill_name: name,
            session_id: "second-run",
            goal: `${h.goal} changed`,
            constraints: h.constraints,
            input_artifacts: [h.predecessor.artifact_id, h.explicit.artifact_id],
          },
          undefined,
          undefined,
          h.context
        )
      ).resolves.toMatchObject({
        details: { success: false, state: "refused", errors: ["SKILL_RECOVERY_BINDING_INVALID"] },
      });
      const firstStep = requireDefined(h.checkpoint.steps[0], "completed checkpoint step missing");
      firstStep.handoff_artifact_ref = h.extra;
      saveChainCheckpoint(h.checkpoint, h.projectRoot);
      await expect(
        tool.execute(
          "wrong-chain-predecessor",
          { resume_chain: h.id },
          undefined,
          undefined,
          h.context
        )
      ).resolves.toMatchObject({
        details: {
          success: false,
          state: "failed",
          errors: [`Chain stopped at step 2/2 (${name}): SKILL_RECOVERY_BINDING_INVALID`],
        },
      });
      firstStep.handoff_artifact_ref = h.predecessor;
      saveChainCheckpoint(h.checkpoint, h.projectRoot);
      const step = requireDefined(h.checkpoint.steps[1], "second checkpoint step missing");
      step.input_artifacts = [h.extra.artifact_id];
      saveChainCheckpoint(h.checkpoint, h.projectRoot);
      await expect(
        tool.execute("wrong-chain-input", { resume_chain: h.id }, undefined, undefined, h.context)
      ).resolves.toMatchObject({
        details: {
          success: false,
          state: "failed",
          errors: [`Chain stopped at step 2/2 (${name}): SKILL_RECOVERY_BINDING_INVALID`],
        },
      });
      step.input_artifacts = [h.explicit.artifact_id];
      saveChainCheckpoint(h.checkpoint, h.projectRoot);
      const bytes = h.owner.artifacts.read(h.explicit);
      for (const ref of [h.explicit, h.request]) {
        const objectFile = path.join(
          h.state.paths.artifacts.root,
          "objects",
          "sha256",
          ref.content_digest.slice(0, 2),
          ref.content_digest.slice(2)
        );
        const originalBytes = readFileSync(objectFile);
        try {
          writeFileSync(objectFile, "corrupt fixture bytes");
          await expect(
            tool.execute("corrupt", { resume_chain: h.id }, undefined, undefined, h.context)
          ).rejects.toThrow(/failed exact-byte verification/u);
        } finally {
          writeFileSync(objectFile, originalBytes);
        }
      }
      expect(cognition.invocations).toHaveLength(calls);
      expect(h.owner.checkpointer.loadRunById("second-run")?.snapshot()).toEqual(snapshot);
      expect(h.owner.checkpointer.events("second-run")).toEqual(events);
      expect(h.owner.artifacts.read(h.request)).toEqual(requestBytes);
      expect(h.owner.artifacts.read(h.explicit)).toEqual(bytes);
      const recovered = await tool.execute(
        "unchanged-after-refusal",
        { resume_chain: h.id },
        undefined,
        undefined,
        h.context
      );
      expect(recovered.details.success, recovered.details.errors.join("; ")).toBe(true);
    }
  );

  it("carries an actual chain clarification into compaction as the exact step run, not the chain session", async () => {
    const h = harness();
    cognition.clarifyRun = "clarifying-step";
    const result = await h.register().execute(
      "clarification",
      {
        chain: [
          {
            skill_name: "research",
            session_id: "completed-step",
            goal: "Create predecessor",
            constraints: { mode: "quick" },
          },
          {
            skill_name: "research",
            session_id: "clarifying-step",
            goal: "Use {previous}",
            constraints: { mode: "quick" },
          },
        ],
      },
      undefined,
      undefined,
      h.context
    );
    const pending = h.owner.checkpointer.loadRunById("clarifying-step")?.pendingDirective;
    if (pending?.action !== "await_user") throw new Error("real clarification gate missing");
    expect(result.details.continuation).toEqual({
      kind: "clarification",
      identity: pending.identity,
      gate_id: pending.gate_id,
      challenge: pending.challenge,
      resume_invocation: {
        skill_name: "research",
        session_id: "clarifying-step",
        goal: `Use ${requireDefined(result.details.chain_results?.[0]?.output_artifact_ref, "completed predecessor missing").artifact_id}`,
        constraints: { mode: "quick" },
      },
    });
    expect(result.details.chain_results).toHaveLength(1);
    const ids = collectExplicitRunIds(exchange(result.details));
    expect(ids).toContain("clarifying-step");
    expect(ids).not.toContain(result.details.chain_session_id);
    expect(readExactCheckpoints(ids, h.projectRoot).runs.map((run) => run.run_id)).toEqual([
      "clarifying-step",
    ]);
  });

  it("renders actual parallel waits as separate actionable branches without consuming native capability or rerunning a successful sibling", async () => {
    const h = harness();
    cognition.clarifyRuns.add("ordinary-wait");
    cognition.clarifyRuns.add("native-wait");
    const input = explicitCore(h.owner, "parallel-input");
    const completeNative = vi.fn(() => ({ text: "fixture native completion" }));
    let nativeCapability: string | undefined;
    let disposeNative: (() => void) | undefined;
    vi.spyOn(PlaybookUiOwner.prototype, "prepare").mockImplementation(async (value) => {
      if (value.directive.identity.run_id !== "native-wait") return undefined;
      const questions = value.directive.questions.map((question) => ({
        ...question,
        label: "Native branch",
        options: [],
        allowOther: true,
      }));
      const capability = requireDefined(
        registerTrustedQuestionnaireTransport(
          questions,
          {
            runId: value.directive.identity.run_id,
            gateId: value.directive.gate_id,
            challenge: value.directive.challenge,
            artifactRef: { fixture: "candidate" },
            transportRef: { fixture: "transport" },
            renderedQuestionsDigest: renderedQuestionsDigest(questions),
          },
          { complete: completeNative, revoke() {} }
        ),
        "native transport missing"
      );
      nativeCapability = capability;
      disposeNative = () => {
        revokeTrustedQuestionnaireTransport(capability);
        value.service.close();
      };
      return {
        capability,
        text: "Use the native questionnaire for this branch only.",
        dispose: disposeNative,
      };
    });
    try {
      const tool = h.register();
      const ordinary = {
        skill_name: "research",
        session_id: "ordinary-wait",
        goal: "Clarify the explicit source scope",
        constraints: { mode: "quick" },
        input_artifacts: [input.artifact_id],
      };
      const result = await tool.execute(
        "parallel-waits",
        {
          skills: [
            ordinary,
            {
              skill_name: "research",
              session_id: "native-wait",
              goal: "Native branch clarification",
              constraints: { mode: "quick" },
            },
            {
              skill_name: "research",
              session_id: "successful-sibling",
              goal: "Complete independently",
              constraints: { mode: "quick" },
            },
          ],
        },
        undefined,
        undefined,
        { ...h.context, hasUI: true, mode: "tui" }
      );
      expect(parseCurrentSkillResult(result.details)).toBe(result.details);
      const children = requireDefined(result.details.parallel_results, "parallel children missing");
      expect(children.map((child) => child.session_id)).toEqual([
        "ordinary-wait",
        "native-wait",
        "successful-sibling",
      ]);
      expect(children.map((child) => child.success)).toEqual([false, false, true]);
      const ordinaryChild = requireDefined(children[0], "ordinary child missing");
      const nativeChild = requireDefined(children[1], "native child missing");
      expect(ordinaryChild.continuation?.resume_invocation).toEqual(ordinary);
      const capability = requireDefined(nativeCapability, "native fixture never prepared");
      expect(nativeChild.escalation?.trustedTransportCapability).toBe(capability);
      expect(result.details.continuation).toBeUndefined();
      const text = result.content.map((item) => item.text).join("\n");
      for (const [index, child] of children.entries()) {
        expect(text).toContain(`Branch ${index + 1}: research (session ${child.session_id})`);
      }
      const ordinarySection = requireDefined(
        text.split("Branch 1:")[1]?.split("Branch 2:")[0],
        "ordinary text missing"
      );
      const nativeSection = requireDefined(
        text.split("Branch 2:")[1]?.split("Branch 3:")[0],
        "native text missing"
      );
      expect(ordinarySection).toContain("Which source scope is intended?");
      const literal = requireDefined(
        /skill\((\{[\s\S]*\})\)/u.exec(ordinarySection)?.[1],
        "exact retry invocation missing"
      );
      const retry: unknown = JSON.parse(literal);
      expect(retry).toEqual({
        ...ordinary,
        constraints: { mode: "quick", user_response: "<answer from questionnaire>" },
      });
      expect(ordinarySection).not.toContain(capability);
      expect(nativeSection).toContain(`"trustedTransportCapability": "${capability}"`);
      expect(nativeSection).toContain('"session_id": "native-wait"');
      expect(nativeSection).not.toContain("user_response");
      expect(text).toContain("do not rerun successful siblings");
      const calls = cognition.invocations.length;
      for (const themeName of ["light", "dark"]) {
        const theme = { fg: (_color: string, body: string) => body, name: themeName };
        const expanded = tool
          .renderResult(result, { expanded: true, isPartial: false }, theme)
          .render(120)
          .join("\n");
        expect(expanded).toContain("Which source scope is intended?");
        expect(expanded).toContain(capability);
        expect(expanded).toContain('"session_id": "ordinary-wait"');
        expect(expanded).toContain(input.artifact_id);
        const collapsed = tool
          .renderResult(result, { expanded: false, isPartial: false }, theme)
          .render(120)
          .join("\n");
        expect(collapsed).toContain("2/3 awaiting user input");
      }
      expect(cognition.invocations).toHaveLength(calls);
      expect(completeNative).not.toHaveBeenCalled();
      const transport = requireDefined(
        resolveTrustedQuestionnaireTransport(capability),
        "rendering consumed native capability"
      );
      expect(transport.binding).toMatchObject({
        runId: "native-wait",
        gateId: nativeChild.continuation?.gate_id,
        challenge: nativeChild.continuation?.challenge,
      });
      // Explicit test-only consumption proves one-time routing, not a fabricated human answer.
      expect(consumeTrustedQuestionnaireTransport(capability)?.binding).toEqual(transport.binding);
      expect(consumeTrustedQuestionnaireTransport(capability)).toBeUndefined();
      expect(completeNative).not.toHaveBeenCalled();
    } finally {
      disposeNative?.();
    }
  });

  it.each(["single", "chain"] as const)(
    "over-capacity %s output fails without changing completed engine/chain state or artifacts",
    async (mode) => {
      const h = harness();
      const originalEvents = Checkpointer.prototype.events;
      let inspecting = false;
      vi.spyOn(Checkpointer.prototype, "events").mockImplementation(function (
        this: Checkpointer,
        runId: string
      ) {
        const events = originalEvents.call(this, runId);
        if (inspecting || runId !== "capacity-run") return events;
        inspecting = true;
        try {
          if (this.loadRunById(runId)?.terminalDirective?.action !== "complete") return events;
          const event = requireDefined(events[0], "terminal run has no events");
          return Array.from({ length: 129 }, () => ({
            ...event,
            payload: { agent: "x".repeat(32_768) },
          }));
        } finally {
          inspecting = false;
        }
      });
      const step = {
        skill_name: "research",
        session_id: "capacity-run",
        goal: "Capacity fixture",
        constraints: { mode: "quick" },
      };
      let chainId: string | undefined;
      await expect(
        h.register().execute(
          "capacity",
          mode === "single" ? step : { chain: [step] },
          undefined,
          (update) => {
            if (
              isRecord(update.details) &&
              update.details.mode === "chain" &&
              typeof update.details.session_id === "string"
            )
              chainId = update.details.session_id;
          },
          h.context
        )
      ).rejects.toThrow("invalid current skill result");
      if (mode === "chain")
        expect(
          readChainCheckpoint(requireDefined(chainId, "capacity chain ID missing"), h.projectRoot)
            ?.chain_status
        ).toBe("complete");
      const run = requireDefined(
        h.owner.checkpointer.loadRunById("capacity-run"),
        "completed run lost"
      );
      expect(run.terminalDirective?.action).toBe("complete");
      const saved = new Map(
        run.selectedArtifacts.map((ref) => [ref.artifact_id, h.owner.artifacts.read(ref)])
      );
      vi.restoreAllMocks();
      const replay = await h
        .register()
        .execute(
          "capacity-replay",
          mode === "single"
            ? step
            : { resume_chain: requireDefined(chainId, "capacity chain ID missing") },
          undefined,
          undefined,
          h.context
        );
      expect(replay.details.success).toBe(true);
      expect(h.owner.checkpointer.loadRunById("capacity-run")?.snapshot()).toEqual(run.snapshot());
      for (const [id, bytes] of saved) expect(h.owner.artifacts.readById(id)).toEqual(bytes);
    }
  );
});
