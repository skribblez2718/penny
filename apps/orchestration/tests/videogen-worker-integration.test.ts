/** Sanitized live-shaped text fixtures, not model reviews or production qualification. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../dist/canonical-json.js";
import { executionState, slot } from "../dist/videogen/execution-state.js";
import {
  validateVideogenPrivateConfig,
  type VideogenEffectRecipeV1,
} from "../dist/videogen/runtime-config.js";
import {
  checkGatePacket,
  validateGatePacket,
  type GateBindingHostV1,
} from "../dist/videogen/gates.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./helpers/videogen-foundation-fixtures.js";
import { fixtureProviders, setup } from "./helpers/videogen-executor-fixture.js";
import { videogenStageRequest } from "./helpers/videogen-stage-fixtures.js";

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
const capturedShape = {
  schema_id: "penny.videogen-brief-analysis.v1",
  schema_version: 1,
  known: [
    { topic: "brief", fact: "The supplied original story and exact line are fixed." },
    { topic: "brief", fact: "No recorded narration or playback is supplied." },
  ],
  unknown: [
    {
      topic: "voice",
      consequence: "The request names a selected voice without identifying it.",
      question: "Which existing saved voice was selected?",
    },
  ],
  coverage_hypotheses: ["A stable composition could preserve the simple action."],
  rights_questions: ["External redistribution clearance remains unverified."],
  needs_clarification: true,
  clarifying_questions: ["Which existing saved voice was selected?"],
  confidence: "PROBABLE",
};

describe("videogen worker text and bounded author context integration (provider-free)", () => {
  it("captures live-shaped spaced SUMMARY bytes and reaches genuine clarification without malformed retries", async () => {
    using f = new FoundationFixture();
    const x = setup(f);
    const text = `SUMMARY: ${canonicalJson(capturedShape)}`;
    let calls = 0;
    x.client.runAgent = async (invocation) => {
      expect(invocation.stateId).toBe("brief_analysis");
      calls++;
      return { text }; // No trusted details: the ordinary persisted-output parser must route this.
    };
    const boundary = await x.runner.runUntilBoundary(x.engine.handle(start(f)));
    expect(boundary.action).toBe("await_user");
    expect(calls).toBe(1);
    const c = f.checkpointer.loadRun(start(f).identity);
    expect(c.stateId).toBe("clarify");
    const raw = c.selectedArtifacts.find((ref) => ref.producer === "agent:annie");
    if (raw === undefined) throw new Error("missing exact worker output");
    expect(f.store.readById(raw.artifact_id).toString("utf8")).toBe(text);
    const analysis = slot(executionState(c), "brief_analysis");
    const product: unknown = JSON.parse(f.store.readById(analysis.artifact_id).toString("utf8"));
    const { confidence, ...semantic } = capturedShape;
    expect(confidence).toBe("PROBABLE");
    expect(product).toEqual(semantic);
    const packet = validateGatePacket(
      JSON.parse(f.store.readById(slot(executionState(c), "packet").artifact_id).toString("utf8")),
      FOUNDATION_LIMITS
    );
    expect(packet.kind).toBe("clarification");
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
    expect(f.checkpointer.childWorkflowCallsForParent(f.run_id)).toEqual([]);
  });

  it("still rejects extra fields in a spaced SUMMARY instead of weakening closed phase validation", async () => {
    using f = new FoundationFixture();
    const x = setup(f);
    x.client.runAgent = async () => ({
      text: `SUMMARY: ${canonicalJson({ ...capturedShape, target_state: "delivered" })}`,
    });
    const pending = x.engine.handle(start(f));
    if (pending.action !== "invoke_agent") throw new Error("expected worker directive");
    const [result] = await x.worker.execute(pending);
    if (result === undefined) throw new Error("missing captured result");
    expect(result.details.target_state).toBe("delivered");
    const retry = x.engine.handle({
      schema_version: 2,
      action: "step",
      identity: pending.identity,
      result,
    });
    expect(retry.action).toBe("invoke_agent");
    const c = f.checkpointer.loadRun(start(f).identity);
    expect(c.stateId).toBe("brief_analysis");
    expect(executionState(c).slots.some((row) => row.slot === "brief_analysis")).toBe(false);
    expect(c.met).toBe(false);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });

  it("supplies only explicitly selected exact author context before the first worker and retains ordinary G1 review", async () => {
    using f = new FoundationFixture();
    const base = fixtureProviders(f);
    const author = f.opaque(
      "Synthetic author choices: audience-neutral, stable camera.",
      "text/plain"
    );
    const voice = f.opaque(
      "Synthetic saved voice selection: voice_fixture, not a performance.",
      "text/plain"
    );
    const unrelated = f.opaque("Unselected private backend settings", "text/plain");
    const config = validateVideogenPrivateConfig({
      ...base.config,
      brief_context_refs: [author, voice],
      initial_products: [{ slot: "private_settings", ref: unrelated }],
    });
    const x = setup(f, { ...base, config });
    const original = x.client.runAgent;
    let sawContext = false;
    x.client.runAgent = async (invocation) => {
      if (invocation.stateId !== "brief_analysis") return original(invocation);
      const pending = f.checkpointer.loadRun(start(f).identity).pendingDirective;
      if (pending?.action !== "invoke_agent") throw new Error("missing worker directive");
      const inputs = pending.input_artifacts.artifacts;
      expect(inputs.map((row) => row.slot)).toEqual([
        "Q",
        "L",
        "request",
        "context-0",
        "context-1",
      ]);
      expect(inputs.slice(-2).map((row) => row.ref)).toEqual([author, voice]);
      expect(invocation.inputArtifacts).toEqual(inputs.map((row) => row.ref));
      expect(invocation.task).toContain(
        `INPUT_SLOTS:${canonicalJson(inputs.map(({ slot, ref }) => ({ slot, artifact_id: ref.artifact_id })))}`
      );
      expect(inputs.some((row) => row.ref.artifact_id === unrelated.artifact_id)).toBe(false);
      for (const row of inputs) f.store.readById(row.ref.artifact_id);
      sawContext = true;
      return {
        text: `SUMMARY: ${canonicalJson({
          ...capturedShape,
          known: [
            { topic: "voice", fact: "The exact saved voice selection is supplied in context-1." },
          ],
          unknown: [
            {
              topic: "timing",
              consequence: "No audio exists yet.",
              question: "Later measurement is required.",
            },
          ],
          needs_clarification: false,
          clarifying_questions: [],
        })}`,
      };
    };
    const boundary = await x.runner.runUntilBoundary(x.engine.handle(start(f)));
    expect(sawContext).toBe(true);
    expect(boundary.action).toBe("await_user");
    const c = f.checkpointer.loadRun(start(f).identity);
    expect(c.stateId).toBe("g1");
    expect(
      c.selectedArtifacts.some(
        (ref) => ref.producer === "agent:annie" && ref.phase === "story_check"
      )
    ).toBe(true);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });

  it.each([
    ["asset", true, true],
    ["draft", true, false],
    ["asset", false, false],
  ] as const)(
    "presents only selected asset preparation in G1 (stage=%s, matching asset=%s)",
    async (stage, matchingAsset, included) => {
      using f = new FoundationFixture();
      const base = fixtureProviders(f);
      const asset = base.config.assets[0];
      if (asset === undefined) throw new Error("missing fixture asset");
      const recipe: VideogenEffectRecipeV1 = {
        kind: "media_decode_extract",
        stage,
        subject_id: matchingAsset ? asset.asset_id : "not_an_asset",
        fields: {},
        operands: [],
        input_slots: [],
        budget_ref: asset.rights_ref,
        output_contract_ref: asset.rights_ref,
        backend_key_sha256: "b".repeat(64),
      };
      const config = validateVideogenPrivateConfig({
        ...base.config,
        assets: base.config.assets.map((a) => ({
          ...a,
          source: "voice_studio",
          purpose: "performance",
        })),
      });
      const x = setup(f, { ...base, config, recipes: [recipe] });
      const boundary = await x.runner.runUntilBoundary(x.engine.handle(start(f)));
      expect(boundary.action).toBe("await_user");
      const c = f.checkpointer.loadRun(start(f).identity);
      expect(c.stateId).toBe("g1");
      const packet = validateGatePacket(
        JSON.parse(
          f.store.readById(slot(executionState(c), "packet").artifact_id).toString("utf8")
        ),
        FOUNDATION_LIMITS
      );
      if (packet.kind !== "approval") throw new Error("missing G1 approval packet");
      expect(packet.effect_scope.kinds.includes("media_decode_extract")).toBe(included);
      expect(packet.effect_scope.kinds).not.toContain("video_render");
      expect(packet.effect_scope.kinds).not.toContain("timeline_master");
      expect(packet.effect_scope.subject_ids).toEqual(base.config.assets.map((a) => a.asset_id));
      const host: GateBindingHostV1 = {
        store: f.store,
        checkpointer: f.checkpointer,
        project_id: f.project_id,
        run_id: f.run_id,
        limits: FOUNDATION_LIMITS,
        admitted_destination_id: "local-output",
        current_approvals: [],
        current_presented: packet.presented,
      };
      expect(checkGatePacket(host, packet)).toEqual(packet);
      expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
    }
  );

  it("does not turn picture-only G1 approval into media-preparation authority", async () => {
    using f = new FoundationFixture();
    const x = setup(f);
    await x.runner.runUntilBoundary(x.engine.handle(start(f)));
    const c = f.checkpointer.loadRun(start(f).identity);
    const packet = validateGatePacket(
      JSON.parse(f.store.readById(slot(executionState(c), "packet").artifact_id).toString("utf8")),
      FOUNDATION_LIMITS
    );
    if (packet.kind !== "approval") throw new Error("missing G1 approval packet");
    const host: GateBindingHostV1 = {
      store: f.store,
      checkpointer: f.checkpointer,
      project_id: f.project_id,
      run_id: f.run_id,
      limits: FOUNDATION_LIMITS,
      admitted_destination_id: "local-output",
      current_approvals: [],
      current_presented: packet.presented,
    };
    expect(packet.effect_scope.kinds).not.toContain("media_decode_extract");
    expect(() =>
      checkGatePacket(host, {
        ...packet,
        effect_scope: {
          ...packet.effect_scope,
          kinds: [...packet.effect_scope.kinds, "media_decode_extract"],
        },
      })
    ).toThrow("audio preview intent");
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });

  it("refuses missing or altered context before run creation, and bounds duplicate/oversized selections", () => {
    using f = new FoundationFixture();
    const base = fixtureProviders(f);
    const ref = f.opaque("Synthetic author context", "text/plain");
    expect(() =>
      validateVideogenPrivateConfig({ ...base.config, brief_context_refs: [ref, ref] })
    ).toThrow();
    const oversized = Array.from({ length: 33 }, (_, index) =>
      f.opaque(`Synthetic unique author input ${index}`, "text/plain")
    );
    expect(() =>
      validateVideogenPrivateConfig({ ...base.config, brief_context_refs: oversized })
    ).toThrow();
    for (const changed of [
      { ...ref, artifact_id: `art_${"f".repeat(64)}` },
      { ...ref, content_digest: "f".repeat(64) },
    ]) {
      const x = setup(f, { ...base, config: { ...base.config, brief_context_refs: [changed] } });
      expect(() => x.engine.handle(start(f))).toThrow(/exact artifact mismatch/);
      expect(f.checkpointer.loadRunById(f.run_id)).toBeUndefined();
    }
  });
});
