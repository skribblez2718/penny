/** Real public tool + service/engine/store paths; cognition only is scripted.
 * This suite establishes composition/custody, not substantive model context use. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrchestrationService,
  initializePennyState,
  parsePersistedProduceReview,
  sha256,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
  type SkillResult,
} from "@penny/orchestration";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord, requireDefined } from "../../../../lib/tests/test-narrowers.js";
import { ordinaryContextFixture } from "../../../../../apps/orchestration/tests/helpers/ordinary-context-fixtures.js";
import { bindProduceReviewFixture } from "../../../../../apps/orchestration/tests/helpers/produce-review-fixture.js";
import skillExtension from "../../index.js";
import { readChainCheckpoint } from "../../chain-checkpoint.js";

class ContextCognition implements ModelClient {
  readonly invocations: AgentInvocation[] = [];
  readonly completions = new Map<AgentInvocation, string>();
  readonly cursors = new Map<string, number>();
  interruptRun: string | undefined;
  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    this.invocations.push(invocation);
    const run = requireDefined(
      invocation.workflowSession,
      "Missing exact workflow identity"
    ).run_id;
    if (run === this.interruptRun) {
      this.interruptRun = undefined;
      throw new Error("offline fixture interruption");
    }
    const cursor = this.cursors.get(run) ?? 0;
    const text = ordinaryContextFixture(invocation.registration.workflow_name).outputs[cursor];
    if (text === undefined) throw new Error(`Unexpected fixture phase ${invocation.stateId}`);
    this.cursors.set(run, cursor + 1);
    // Explicit synthetic reviews need the current owner-selected product/check refs.
    // Other output (including malformed controls) remains byte-for-byte unchanged.
    const bound = bindProduceReviewFixture(invocation, text);
    this.completions.set(invocation, bound);
    return { text: bound };
  }
}
const cognition = new ContextCognition();
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
interface PublicTool {
  name: "skill";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { details: unknown }) => void) | undefined,
    context: unknown
  ): Promise<{ details: SkillResult }>;
}
function isSkillTool(value: unknown): value is PublicTool {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}
const sourceRoot = path.resolve(import.meta.dirname, "../../../../..");
const keys = ["PROJECT_ROOT", "PENNY_STATE_ROOT", "PENNY_SKILLS_DIR", "PI_OBSERVABILITY_ENABLED"];
const original = new Map(keys.map((key) => [key, process.env[key]]));
const owners: OrchestrationService[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cognition.invocations.length = 0;
  cognition.completions.clear();
  cognition.cursors.clear();
  cognition.interruptRun = undefined;
});
function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "penny-public-context-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  process.env.PROJECT_ROOT = projectRoot;
  process.env.PENNY_STATE_ROOT = path.join(root, "state");
  process.env.PENNY_SKILLS_DIR = path.join(sourceRoot, ".pi/skills");
  process.env.PI_OBSERVABILITY_ENABLED = "false";
  initializePennyState(projectRoot, { env: process.env });
  const owner = new OrchestrationService({ projectRoot, env: process.env, playbookName: "plan" });
  owners.push(owner);
  let registered: PublicTool | undefined;
  skillExtension(
    createTestExtensionApi({
      onRegisterTool(value) {
        if (isSkillTool(value)) registered = value;
      },
    })
  );
  const tool = requireDefined(registered, "Missing public skill tool");
  const context = {
    cwd: projectRoot,
    isProjectTrusted: () => true,
    ui: { theme: { fg: (_color: string, text: string) => text }, notify() {} },
  };
  const run = async (
    params: Record<string, unknown>,
    onUpdate?: (update: { details: unknown }) => void
  ) => (await tool.execute("context-test", params, undefined, onUpdate, context)).details;
  return { owner, projectRoot, run };
}
function step(skill: string, session: string) {
  const fixture = ordinaryContextFixture(skill);
  return {
    skill_name: skill,
    session_id: session,
    goal: fixture.goal,
    constraints: fixture.constraints,
  };
}
function product(result: SkillResult) {
  expect(result.success).toBe(true);
  return requireDefined(result.output_artifact_ref, "Missing accepted product");
}

function assertProduceReviewCustody(owner: OrchestrationService, runId: string) {
  const completed = [...cognition.completions].filter(
    ([invocation]) => invocation.workflowSession?.run_id === runId
  );
  expect(completed.map(([invocation]) => invocation.stateId)).toEqual([
    "exploring_artifact_approaches",
    "selecting_artifact_approach",
    "materializing_artifact",
    "critiquing_artifact",
    "verifying_artifact",
  ]);
  expect(completed.every(([invocation]) => invocation.executionPurpose === "phase")).toBe(true);
  for (const [invocation, text] of completed) {
    const state = invocation.stateId;
    if (state !== "critiquing_artifact" && state !== "verifying_artifact") continue;
    const productRef = requireDefined(
      invocation.inputArtifacts.find(
        (ref) =>
          ref.run_id === runId && ref.content_schema?.schema_id === "penny.produced-artifact.v2"
      ),
      "Missing native reviewed product"
    );
    const hostCheckRef =
      state === "verifying_artifact"
        ? requireDefined(
            invocation.inputArtifacts.find(
              (ref) => ref.run_id === runId && ref.kind === "produce-mechanical-checks"
            ),
            "Missing native host checks"
          )
        : undefined;
    const { core } = parsePersistedProduceReview(Buffer.from(text), {
      state,
      productRef,
      ...(hostCheckRef === undefined ? {} : { hostCheckRef }),
    });
    const event = requireDefined(
      owner.checkpointer
        .events(runId)
        .find(
          (event) => event.eventType === "phase_result_accepted" && event.payload.state_id === state
        ),
      "Missing accepted review event"
    );
    if (typeof event.payload.receipt_id !== "string") throw new Error("Missing review receipt ID");
    const result = requireDefined(
      owner.checkpointer.receiptResultById(event.payload.receipt_id),
      "Missing signed review result"
    );
    // Keep the complete raw core, not a SUMMARY-only substitute or reconstructed review.
    expect(owner.artifacts.read(result.output_artifact)).toEqual(Buffer.from(text));
    expect(result.output_artifact.content_digest).toBe(sha256(text));
    expect(result.worker_receipt.output_digest).toBe(sha256(text));
    expect(result.worker_receipt.output_artifact_ref).toEqual(result.output_artifact);
    expect(result.confidence).toBe(core.confidence);
    expect(result.details).toEqual(core.review);
  }
}

describe("universal context through existing public modes (offline real owners)", () => {
  it("runs Plan → Produce with explicit automatic-predecessor context and exact checkpoint designation", async () => {
    const h = harness();
    const result = await h.run({
      chain: [
        step("plan", "chain-plan"),
        { ...step("produce", "chain-produce"), previous_artifact_designation: "context" },
      ],
    });
    product(result);
    assertProduceReviewCustody(h.owner, "chain-produce");
    const first = requireDefined(
      result.chain_results?.[0]?.output_artifact_ref,
      "Missing Plan terminal"
    );
    const consumer = requireDefined(
      h.owner.checkpointer.loadRunById("chain-produce"),
      "Missing consumer"
    );
    expect(consumer.admittedInputArtifacts?.artifacts).toContainEqual({
      slot: "previous-skill-terminal-output",
      designation: "context",
      ref: first,
    });
    for (const invocation of cognition.invocations.filter(
      (inv) => inv.workflowSession?.run_id === "chain-produce"
    )) {
      expect(invocation.inputArtifacts).toContainEqual(first);
      expect(invocation.task).toContain("NONBINDING context slot");
    }
    const chain = readChainCheckpoint(
      requireDefined(result.chain_session_id, "Missing chain ID"),
      h.projectRoot,
      process.env
    );
    expect(chain?.steps[1]?.previous_artifact_designation).toBe("context");
  });

  it("keeps parallel branches independent and supports explicit cross-run contextual fan-in", async () => {
    const h = harness();
    const a = product(await h.run(step("plan", "source-a")));
    const b = product(await h.run(step("plan", "source-b")));
    const parallel = await h.run({
      skills: [
        { ...step("produce", "with-context"), context_artifacts: [a.artifact_id] },
        step("produce", "independent"),
      ],
    });
    expect(parallel.success).toBe(true);
    assertProduceReviewCustody(h.owner, "with-context");
    assertProduceReviewCustody(h.owner, "independent");
    const branch = requireDefined(
      h.owner.checkpointer.loadRunById("with-context"),
      "Missing contextual branch"
    );
    const independent = requireDefined(
      h.owner.checkpointer.loadRunById("independent"),
      "Missing independent branch"
    );
    expect(branch.admittedInputArtifacts?.artifacts.map((binding) => binding.ref)).toEqual([a]);
    expect(independent.admittedInputArtifacts).toBeUndefined();
    const result = await h.run({
      ...step("produce", "fan-in"),
      context_artifacts: [a.artifact_id, b.artifact_id],
    });
    product(result);
    assertProduceReviewCustody(h.owner, "fan-in");
    const fan = requireDefined(h.owner.checkpointer.loadRunById("fan-in"), "Missing fan-in");
    expect(
      fan.admittedInputArtifacts?.artifacts.map((binding) => ({
        designation: binding.designation,
        ref: binding.ref,
      }))
    ).toEqual([
      { designation: "context", ref: a },
      { designation: "context", ref: b },
    ]);
    await expect(
      h.run({
        ...step("produce", "fan-in"),
        input_artifacts: [a.artifact_id],
        context_artifacts: [b.artifact_id],
      })
    ).resolves.toMatchObject({
      success: false,
      state: "refused",
      errors: ["SKILL_RECOVERY_BINDING_INVALID"],
    });
  });

  it("resumes an interrupted contextual chain without replaying its accepted Plan producer", async () => {
    const h = harness();
    cognition.interruptRun = "resumed-produce";
    let chainId: string | undefined;
    await expect(
      h.run(
        {
          chain: [
            step("plan", "accepted-plan"),
            { ...step("produce", "resumed-produce"), previous_artifact_designation: "context" },
          ],
        },
        (update) => {
          if (isRecord(update.details) && typeof update.details.session_id === "string")
            chainId = update.details.session_id;
        }
      )
    ).rejects.toThrow("offline fixture interruption");
    const id = requireDefined(chainId, "Missing exact chain progress ID");
    expect(
      readChainCheckpoint(id, h.projectRoot, process.env)?.steps.map((step) => step.status)
    ).toEqual(["complete", "running"]);
    const before = cognition.invocations.filter(
      (inv) => inv.workflowSession?.run_id === "accepted-plan"
    ).length;
    const original = requireDefined(
      h.owner.checkpointer.loadRunById("resumed-produce"),
      "Missing interrupted consumer"
    ).admittedInputArtifacts;
    const resumed = await h.run({ resume_chain: id });
    product(resumed);
    assertProduceReviewCustody(h.owner, "resumed-produce");
    expect(
      cognition.invocations.filter((inv) => inv.workflowSession?.run_id === "accepted-plan")
    ).toHaveLength(before);
    expect(h.owner.checkpointer.loadRunById("resumed-produce")?.admittedInputArtifacts).toEqual(
      original
    );
  });
});
