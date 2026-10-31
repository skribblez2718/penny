/** Provider-free engine/contract evidence only. No AV, editor or production qualification. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OrchestrationEngine } from "../dist/engine.js";
import { validateContract } from "../dist/contracts.js";
import { bindScriptDraft } from "../dist/videogen/admission.js";
import { executionState, slot } from "../dist/videogen/execution-state.js";
import { constructGateDecision, validateGatePacket } from "../dist/videogen/gates.js";
import {
  ScriptDraftV1Schema,
  StoryOutlineV1Schema,
  validateScript,
  validateStoryCanon,
} from "../dist/videogen/foundation-contracts.js";
import { readVideogenStageProduct } from "../dist/videogen/semantic-catalog.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import {
  FoundationFixture,
  FOUNDATION_LIMITS as limits,
} from "./helpers/videogen-foundation-fixtures.js";
import { setup } from "./helpers/videogen-executor-fixture.js";
import {
  videogenStageRequest,
  videogenStageWorkerFixtures,
} from "./helpers/videogen-stage-fixtures.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");

function start(f: FoundationFixture) {
  const request = videogenStageRequest();
  return {
    schema_version: 2 as const,
    action: "start" as const,
    identity: {
      schema_version: 2 as const,
      run_id: f.run_id,
      session_id: f.run_id,
      playbook: "videogen",
      engine_owner: "typescript" as const,
    },
    goal: request.brief,
    constraints: request,
    project_root: projectRoot,
    trust_profile: "hardened-untrusted" as const,
  };
}

function packet(f: FoundationFixture) {
  const context = f.checkpointer.loadRun(start(f).identity);
  const ref = slot(executionState(context), "packet");
  const value: unknown = JSON.parse(f.store.read(ref).toString("utf8"));
  return { ref, value: validateGatePacket(value, limits), context };
}

describe("provider-free videogen conformance", () => {
  it("accepts meaning-preserving script wording while retaining exact outline and coverage bindings", () => {
    using f = new FoundationFixture();
    const fixtures = videogenStageWorkerFixtures();
    const outline = validateContract(StoryOutlineV1Schema, fixtures.story_plan, "outline fixture");
    const draft = validateContract(ScriptDraftV1Schema, fixtures.script_text, "script fixture");
    const outline_ref = f.json(outline, outline.schema_id);
    const alternate = {
      ...draft,
      scenes: draft.scenes.map((scene) => ({
        ...scene,
        ordered_lines: scene.ordered_lines.map((line) => ({ ...line, text: "Hello there." })),
      })),
    };
    const bind = (value: unknown) =>
      bindScriptDraft({
        store: f.store,
        project_id: f.project_id,
        outline_ref,
        draft_ref: f.json(value, draft.schema_id),
        limits,
      });
    const original = bind(draft),
      varied = bind(alternate);
    expect(varied.story_outline_ref).toEqual(original.story_outline_ref);
    expect(varied.coverage_shot_ids).toEqual(original.coverage_shot_ids);
    expect(varied.scenes).toEqual(alternate.scenes);
    expect(varied.scenes).not.toEqual(original.scenes);
    expect(validateScript(varied, limits)).toEqual(varied);
    expect(() => bind({ ...alternate, coverage_shot_ids: ["invented-shot"] })).toThrow();
  });

  it("runs the registered engine and signed worker capture to exact G1 and recovers without effects", async () => {
    using f = new FoundationFixture();
    const x = setup(f);
    const boundary = await x.runner.runUntilBoundary(x.engine.handle(start(f)));
    expect(boundary.action).toBe("await_user");
    const current = packet(f),
      state = executionState(current.context);
    expect(current.context.stateId).toBe("g1");
    const read = (name: string, schema_id: string) =>
      readVideogenStageProduct({
        artifacts: f.store,
        project_id: f.project_id,
        ref: slot(state, name),
        schema_id,
        limits,
      });
    const script = validateScript(read("script", "penny.videogen-script.v1"), limits);
    const canon = validateStoryCanon(read("canon", "penny.videogen-story-canon.v1"), limits);
    expect(script.story_outline_ref).toEqual(slot(state, "story_plan"));
    expect(canon.script_ref).toEqual(slot(state, "script"));
    expect(current.value.presented).toContainEqual({
      role: "story",
      ref: slot(state, "canon"),
      revision: 1,
    });
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
    expect(f.checkpointer.childWorkflowCallsForParent(f.run_id)).toEqual([]);
    const reopened = new OrchestrationEngine(f.checkpointer, {
      projectRoot,
      maxSteps: 200,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactStore: f.store,
      artifactReader: f.store,
      artifactRevisions: f.store,
      playbookRegistration: x.registration,
    });
    expect(
      reopened.handle({ schema_version: 2, action: "recover", identity: current.context.identity })
    ).toEqual(boundary);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });

  it("invalidates the prior script canon and approval after a material G1 refinement", async () => {
    using f = new FoundationFixture();
    const x = setup(f);
    const first = await x.runner.runUntilBoundary(x.engine.handle(start(f)));
    if (first.action !== "await_user") throw new Error("expected G1");
    const old = packet(f),
      oldState = executionState(old.context);
    const next = await x.runner.runUntilBoundary(
      x.engine.handle({
        schema_version: 2,
        action: "respond",
        identity: old.context.identity,
        gate_id: first.gate_id,
        challenge: first.challenge,
        response: constructGateDecision(
          old.value,
          old.ref,
          "refine",
          limits,
          "Replace the ending with a farewell."
        ),
      })
    );
    if (next.action !== "await_user") throw new Error("expected revised G1");
    const revised = packet(f),
      revisedState = executionState(revised.context);
    expect(next.challenge).not.toBe(first.challenge);
    for (const name of ["script", "canon"])
      expect(slot(revisedState, name)).not.toEqual(slot(oldState, name));
    expect(revised.value.presented).not.toContainEqual(old.value.presented[0]);
    expect(() =>
      x.engine.handle({
        schema_version: 2,
        action: "respond",
        identity: old.context.identity,
        gate_id: first.gate_id,
        challenge: first.challenge,
        response: constructGateDecision(old.value, old.ref, "approve", limits),
      })
    ).toThrow();
    expect(packet(f).ref).toEqual(revised.ref);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });

  it("refuses absent private providers before creating a run rather than manufacturing completion", () => {
    using f = new FoundationFixture();
    const engine = new OrchestrationEngine(f.checkpointer, {
      projectRoot,
      maxSteps: 100,
      receiptAuthority: TEST_RECEIPT_AUTHORITY,
      artifactStore: f.store,
      playbookName: "videogen",
    });
    expect(() => engine.handle(start(f))).toThrow(/VIDEOGEN_PRIVATE_CONFIG_MISSING/u);
    expect(f.checkpointer.loadRunById(f.run_id)).toBeUndefined();
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });
});
