import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { canonicalJson } from "../dist/canonical-json.js";
import { validateContract } from "../dist/contracts.js";
import { VIDEOGEN_WORKERS, validateVideogenWorker, workerState } from "../dist/videogen/workers.js";
import {
  VIDEOGEN_FLOW,
  VIDEOGEN_REPAIR_ROUTING,
  VIDEOGEN_STATE_OPERATIONS,
  VIDEOGEN_WORKER_PHASES,
} from "../dist/videogen/matrix.js";
import {
  VIDEOGEN_STATE_PORTS,
  videogenStatePorts,
  preflightVideogenStateInputs,
} from "../dist/videogen/state-ports.js";
import {
  readVideogenStageProduct,
  parseVideogenStageJson,
  videogenSemanticSchema,
} from "../dist/videogen/semantic-catalog.js";
import { validateVideogenStageSemantics } from "../dist/videogen/stage-validation.js";
import {
  AudioEvidenceV1Schema,
  ShotResultV1Schema,
  VideogenTerminalV1Schema,
  OperationOutcomeV1Schema,
} from "../dist/videogen/stage-contracts.js";
import {
  FoundationFixture,
  FOUNDATION_LIMITS as limits,
} from "./helpers/videogen-foundation-fixtures.js";
import {
  videogenStageWorkerFixtures,
  videogenStageRequest,
  videogenStageEnvelope,
  videogenStageAudio,
} from "./helpers/videogen-stage-fixtures.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = path.join(root, ".pi/skills/videogen");
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected fixture object");
  return value;
}
const knownSlots = new Set([
  "target",
  "evidence",
  "frame",
  "profile_a",
  "profile_b",
  "evidence_a",
  "evidence_b",
]);
describe("videogen phase contract fixtures (not production qualification)", () => {
  const fixtures = videogenStageWorkerFixtures();
  for (const [state, worker] of Object.entries(VIDEOGEN_WORKERS)) {
    if (!workerState(state)) throw new Error("unrecognized state");
    it(`${state}: validates its complete closed product and static prompt schema`, () => {
      expect(() => validateVideogenWorker(state, fixtures[state], knownSlots)).not.toThrow();
      expect(() =>
        validateVideogenWorker(state, { ...record(fixtures[state]), target_state: "delivered" })
      ).toThrow();
      expect(() =>
        validateVideogenWorker(state, {
          ...record(fixtures[state]),
          artifact_ref: { artifact_id: "fabricated" },
        })
      ).toThrow();
      const prompt = readFileSync(
        path.join(packageRoot, "assets/prompts", `${worker.agent}-${state}.md`),
        "utf8"
      );
      const schema = prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1];
      if (schema === undefined) throw new Error("missing complete prompt schema");
      const parsed: unknown = JSON.parse(schema);
      expect(parsed).toEqual(worker.schema);
      for (const token of [
        "## Mission",
        "## Exact Artifact Handoff",
        "artifact_read",
        "next_range",
        "missing_input:",
        "## SUMMARY",
        "owner",
        "complete",
      ])
        expect(prompt).toContain(token);
    });
  }
  it("requires actual Skribble script authorship between outline and coverage", () => {
    expect(VIDEOGEN_FLOW.edges).toContainEqual(["story_plan", "script_text"]);
    expect(VIDEOGEN_FLOW.edges).toContainEqual(["script_text", "story_check"]);
    expect(VIDEOGEN_FLOW.edges).not.toContainEqual(["story_plan", "story_check"]);
    expect(VIDEOGEN_WORKERS.script_text.agent).toBe("skribble");
    expect(() =>
      validateVideogenWorker("script_text", {
        ...record(fixtures.script_text),
        story_outline_ref: "model invented",
      })
    ).toThrow();
  });
  it("keeps clarification finite, explicit and non-authorizing", () => {
    expect(() =>
      validateVideogenWorker("brief_analysis", {
        ...record(fixtures.brief_analysis),
        needs_clarification: true,
      })
    ).toThrow(/questions/u);
    expect(() =>
      validateVideogenWorker("brief_analysis", {
        ...record(fixtures.brief_analysis),
        needs_clarification: true,
        clarifying_questions: ["Which audience?"],
      })
    ).not.toThrow();
  });
  it("refuses unknown/empty criteria, contradictory PASS and invented evidence slots", () => {
    expect(() =>
      validateVideogenWorker("master_verify", { ...record(fixtures.master_verify), criteria: [] })
    ).toThrow(/PASS/u);
    expect(() =>
      validateVideogenWorker("master_verify", {
        ...record(fixtures.master_verify),
        violations: ["missing full decode"],
      })
    ).toThrow(/PASS/u);
    expect(() =>
      validateVideogenWorker("master_verify", fixtures.master_verify, new Set(["target"]))
    ).toThrow(/unavailable/u);
    expect(() =>
      validateVideogenWorker("master_critique", {
        ...record(fixtures.master_critique),
        unassessed: [],
      })
    ).toThrow(/AV/u);
  });
  it("permits a blocked objective review without invented criteria", () => {
    expect(() =>
      validateVideogenWorker("master_verify", {
        ...record(fixtures.master_verify),
        criteria: [],
        disposition: "blocked",
        violations: ["missing objective evidence"],
      })
    ).not.toThrow();
  });
  it("pins all states/ports, one owner per cognitive state and exact YAML default", () => {
    expect([...VIDEOGEN_FLOW.states].sort()).toEqual(Object.keys(VIDEOGEN_STATE_PORTS).sort());
    expect(new Set(VIDEOGEN_FLOW.states).size).toBe(VIDEOGEN_FLOW.states.length);
    for (const [state, phase] of VIDEOGEN_WORKER_PHASES) {
      expect(workerState(state)).toBe(true);
      expect("allowed_tools" in phase).toBe(false);
      expect(typeof phase.agent).toBe("string");
    }
    for (const state of VIDEOGEN_FLOW.states)
      for (const port of videogenStatePorts(state))
        if (port.schema_id !== null)
          expect(() => videogenSemanticSchema(port.schema_id ?? "")).not.toThrow();
    expect(() => videogenStatePorts("unregistered_state")).toThrow();
  });
  it("pins seven effect kinds and never turns workers/children/short continuations into kinds", () => {
    const kinds = [...new Set(Object.values(VIDEOGEN_STATE_OPERATIONS).flat())].sort();
    expect(kinds).toEqual([
      "kdenlive_build_verify",
      "local_delivery",
      "media_decode_extract",
      "reference_upload",
      "timeline_master",
      "video_render",
      "voice_job",
    ]);
    expect(VIDEOGEN_STATE_OPERATIONS.voice_capture).toEqual(["voice_job"]);
    expect(VIDEOGEN_STATE_OPERATIONS.finish_apply).toEqual([
      "timeline_master",
      "media_decode_extract",
      "kdenlive_build_verify",
    ]);
    for (const state of [
      "image_child",
      "child_call",
      "animatic_build",
      ...Object.keys(VIDEOGEN_WORKERS),
    ])
      expect(VIDEOGEN_STATE_OPERATIONS[state]).toBeUndefined();
  });
  it("pins unique engine-native repairs, finish reserve and honest exhaustion", () => {
    const keys = new Set<string>();
    for (const route of VIDEOGEN_REPAIR_ROUTING.routes) {
      const key = `${route.origin_state}:${route.feedback_kind}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
      expect(route.budget).toEqual({
        counter: "iteration",
        limit_source: "run.max_iterations",
        reserved_attempts: 1,
      });
      expect(route.on_exhaustion).toEqual({
        action: "transition",
        target_state: "incomplete",
        reset_counter: false,
      });
      expect(VIDEOGEN_FLOW.edges).toContainEqual([route.origin_state, route.repair.target_state]);
    }
    expect(VIDEOGEN_REPAIR_ROUTING.routes).toContainEqual(
      expect.objectContaining({
        origin_state: "master_verify",
        feedback_kind: "product_gap",
        repair: { action: "transition", target_state: "final_prepare" },
      })
    );
  });
  it("makes every contract state and honest terminal reachable without a delivered shortcut", () => {
    const visited = new Set(["admit"]);
    let size = 0;
    while (size !== visited.size) {
      size = visited.size;
      for (const [from, to] of VIDEOGEN_FLOW.edges) if (visited.has(from)) visited.add(to);
    }
    expect([...visited].sort()).toEqual([...VIDEOGEN_FLOW.states].sort());
    expect(VIDEOGEN_FLOW.edges.filter(([, to]) => to === "delivered")).toEqual([
      ["completion_check", "delivered"],
    ]);
    expect(new Set(VIDEOGEN_FLOW.edges.map((x) => x.join("→"))).size).toBe(
      VIDEOGEN_FLOW.edges.length
    );
  });
  it("keeps the hidden executor prompt set exact without claiming production qualification", () => {
    const expected = Object.entries(VIDEOGEN_WORKERS)
      .map(([state, w]) => `${w.agent}-${state}.md`)
      .sort();
    expect(readdirSync(path.join(packageRoot, "assets/prompts")).sort()).toEqual(expected);
    expect(readFileSync(path.join(packageRoot, "SKILL.md"), "utf8")).toContain(
      "disable-model-invocation: true"
    );
    expect(readFileSync(path.join(packageRoot, "README.md"), "utf8")).toContain(
      "does not activate a deployment"
    );
  });
  it("mirrors the full contract descriptor in strict JSON HTML, not the high-level 16 nodes", () => {
    const html = readFileSync(path.join(packageRoot, "resources/flow.html"), "utf8");
    const rawN = html.split("const N = ")[1]?.split(";\n      const E = ")[0];
    const rawE = html.split("const E = ")[1]?.split(";\n      const graph =")[0];
    if (rawN === undefined || rawE === undefined) throw new Error("missing flow constants");
    const nodes = record(JSON.parse(rawN));
    const rawEdges: unknown = JSON.parse(rawE);
    const edges = validateContract(
      Type.Array(
        Type.Object({
          from: Type.String(),
          to: Type.String(),
          kind: Type.String(),
          label: Type.String(),
        })
      ),
      rawEdges,
      "diagram edges"
    );
    expect(Object.keys(nodes).sort()).toEqual([...VIDEOGEN_FLOW.states].sort());
    expect(edges.map((x) => `${x.from}→${x.to}`).sort()).toEqual(
      VIDEOGEN_FLOW.edges.map((x) => x.join("→")).sort()
    );
    expect(Object.keys(nodes).length).toBeGreaterThan(16);
    expect(html).not.toMatch(/innerHTML\s*=|fetch\(|<script[^>]*src=/u);
  });
});
describe("videogen exact stage inputs with real temporary stores", () => {
  it("inherits every current gate through review and later gate states", () => {
    const gates = (state: string, origin?: string) =>
      videogenStatePorts(state, origin)
        .filter((port) => /^G[1-5]$/u.test(port.name))
        .map((port) => port.name)
        .sort();
    expect(gates("story_check")).toEqual([]);
    expect(gates("reference_verify")).toEqual(["G1"]);
    expect(gates("g3")).toEqual(["G1", "G2"]);
    expect(gates("rough_review")).toEqual(["G1", "G2", "G3"]);
    expect(gates("master_verify")).toEqual(["G1", "G2", "G3", "G4"]);
    expect(gates("g5")).toEqual(["G1", "G2", "G3", "G4"]);
    expect(gates("completion_check")).toEqual(["G1", "G2", "G3", "G4", "G5"]);
    expect(gates("evidence_synthesis", "master_verify")).toEqual(["G1", "G2", "G3", "G4"]);
  });
  it("requires closed host-selected child/synthesis return controls and two distinct refs", () => {
    using f = new FoundationFixture();
    const req = f.json(videogenStageRequest(), "penny.videogen-request.v1");
    const Q = f.json(videogenStageEnvelope(req), "penny.videogen-envelope.v1");
    const L = f.json(
      {
        schema_id: "penny.videogen-dependency-ledger.v1",
        schema_version: 1,
        nodes: [],
        edges: [],
        review_epochs: [],
        invalidations: [],
      },
      "penny.videogen-dependency-ledger.v1"
    );
    const a = f.opaque("captured fixture A"),
      b = f.opaque("contradictory fixture B");
    const base = { artifacts: f.store, project_id: f.project_id, limits, max_input_bytes: 100000 };
    const bindings = [
      { slot: "Q", ref: Q },
      { slot: "L", ref: L },
    ];
    const child = {
      ...base,
      state: "child_call",
      controls: { parent_state: "brief_analysis" },
      bindings: [...bindings, { slot: "child_request", ref: a }],
    };
    expect(() => preflightVideogenStateInputs(child)).not.toThrow();
    expect(() => preflightVideogenStateInputs({ ...child, controls: undefined })).toThrow();
    expect(() =>
      preflightVideogenStateInputs({ ...child, controls: { parent_state: "g1" } })
    ).toThrow();
    expect(() =>
      preflightVideogenStateInputs({
        ...child,
        controls: { parent_state: "brief_analysis", approve: true },
      })
    ).toThrow();
    const synthesis = {
      ...base,
      state: "evidence_synthesis",
      controls: { return_state: "story_check" },
      bindings: [
        ...bindings,
        { slot: "conflicting_evidence-0", ref: a },
        { slot: "conflicting_evidence-1", ref: b },
      ],
    };
    expect(() => preflightVideogenStateInputs(synthesis)).not.toThrow();
    expect(() =>
      preflightVideogenStateInputs({ ...synthesis, controls: { return_state: "g1" } })
    ).toThrow();
    expect(() =>
      preflightVideogenStateInputs({
        ...synthesis,
        bindings: [...bindings, { slot: "conflicting_evidence-0", ref: a }],
      })
    ).toThrow(/two distinct/u);
    expect(() =>
      preflightVideogenStateInputs({
        ...synthesis,
        bindings: [
          ...bindings,
          { slot: "conflicting_evidence-0", ref: a },
          { slot: "conflicting_evidence-1", ref: a },
        ],
      })
    ).toThrow(/two distinct/u);
  });
  it("rereads fixed worker semantics rather than trusting a schema-labelled PASS", () => {
    using f = new FoundationFixture();
    const wrongType = f.raw(
      canonicalJson(videogenStageWorkerFixtures().master_verify),
      "application/octet-stream",
      "penny.videogen-objective-review.v1"
    );
    expect(() =>
      readVideogenStageProduct({
        artifacts: f.store,
        project_id: f.project_id,
        ref: wrongType,
        schema_id: "penny.videogen-objective-review.v1",
        limits,
      })
    ).toThrow(/schema binding/u);
    const forged = f.json(
      { ...record(videogenStageWorkerFixtures().master_verify), criteria: [] },
      "penny.videogen-objective-review.v1"
    );
    expect(() =>
      readVideogenStageProduct({
        artifacts: f.store,
        project_id: f.project_id,
        ref: forged,
        schema_id: "penny.videogen-objective-review.v1",
        limits,
      })
    ).toThrow(/PASS/u);
  });

  it("validates exact caller request bytes without inventing run/effect admission", () => {
    using f = new FoundationFixture();
    const ref = f.json(videogenStageRequest(), "penny.videogen-request.v1");
    const input = {
      state: "admit",
      artifacts: f.store,
      project_id: f.project_id,
      limits,
      max_input_bytes: 100000,
      bindings: [{ slot: "request", ref }],
    };
    expect(() => preflightVideogenStateInputs(input)).not.toThrow();
    expect(() => preflightVideogenStateInputs({ ...input, bindings: [] })).toThrow(/cardinality/u);
    expect(() => preflightVideogenStateInputs({ ...input, max_input_bytes: 1 })).toThrow(/byte/u);
    expect(() =>
      preflightVideogenStateInputs({
        ...input,
        bindings: [
          { slot: "request", ref },
          { slot: "request", ref },
        ],
      })
    ).toThrow(/unique|duplicate/u);
    expect(() =>
      preflightVideogenStateInputs({
        ...input,
        bindings: [
          { slot: "request", ref },
          { slot: "execute", ref },
        ],
      })
    ).toThrow(/undeclared/u);
    expect(() =>
      preflightVideogenStateInputs({
        ...input,
        bindings: [{ slot: "request", ref: { ...ref, content_digest: "f".repeat(64) } }],
      })
    ).toThrow();
  });
  it("validates inherited Q/L and exact cross-run predecessors, refusing missing/schema-lied bytes", () => {
    using f = new FoundationFixture();
    const req = f.json(videogenStageRequest(), "penny.videogen-request.v1");
    const Q = f.json(videogenStageEnvelope(req), "penny.videogen-envelope.v1");
    const L = f.json(
      {
        schema_id: "penny.videogen-dependency-ledger.v1",
        schema_version: 1,
        nodes: [],
        edges: [],
        review_epochs: [],
        invalidations: [],
      },
      "penny.videogen-dependency-ledger.v1"
    );
    const brief = f.json(
      videogenStageWorkerFixtures().brief_analysis,
      "penny.videogen-brief-analysis.v1",
      "earlier-run"
    );
    const input = {
      state: "story_plan",
      artifacts: f.store,
      project_id: f.project_id,
      limits,
      max_input_bytes: 100000,
      bindings: [
        { slot: "Q", ref: Q },
        { slot: "L", ref: L },
        { slot: "brief", ref: brief },
      ],
    };
    expect(() => preflightVideogenStateInputs(input)).not.toThrow();
    expect(() =>
      preflightVideogenStateInputs({
        ...input,
        bindings: input.bindings.filter((x) => x.slot !== "L"),
      })
    ).toThrow(/cardinality/u);
    const forged = f.json({ not_a_brief: true }, "penny.videogen-brief-analysis.v1");
    expect(() =>
      preflightVideogenStateInputs({
        ...input,
        bindings: input.bindings.map((x) => (x.slot === "brief" ? { ...x, ref: forged } : x)),
      })
    ).toThrow();
  });
  it("bounds and rejects duplicate/noncanonical/extra/deep JSON while preserving decimal measurements", () => {
    using f = new FoundationFixture();
    const ref = f.opaque("fixture captured bytes, not audio proof");
    const audio = videogenStageAudio(ref);
    const bytes = Buffer.from(canonicalJson(audio));
    expect(() => parseVideogenStageJson(bytes, AudioEvidenceV1Schema, limits)).not.toThrow();
    const stored = f.json(audio, "penny.videogen-audio-evidence.v1");
    expect(() =>
      readVideogenStageProduct({
        artifacts: f.store,
        project_id: f.project_id,
        ref: stored,
        schema_id: "penny.videogen-audio-evidence.v1",
        limits,
      })
    ).not.toThrow();
    expect(() =>
      parseVideogenStageJson(
        Buffer.from('{"schema_id":"x","schema_id":"y"}'),
        AudioEvidenceV1Schema,
        limits
      )
    ).toThrow(/duplicate/u);
    expect(() =>
      parseVideogenStageJson(
        Buffer.from(JSON.stringify(audio, null, 2)),
        AudioEvidenceV1Schema,
        limits
      )
    ).toThrow(/canonical/u);
    expect(() =>
      parseVideogenStageJson(bytes, AudioEvidenceV1Schema, { ...limits, max_json_bytes: 1 })
    ).toThrow(/byte/u);
    expect(() =>
      parseVideogenStageJson(
        Buffer.from("[".repeat(40) + "0" + "]".repeat(40)),
        Type.Unknown(),
        limits
      )
    ).toThrow(/limit/u);
    expect(() =>
      parseVideogenStageJson(bytes, AudioEvidenceV1Schema, { ...limits, max_text_bytes: 1 })
    ).toThrow(/text/u);
  });
});
describe("videogen host record consistency is not qualification", () => {
  it("rejects sample/time drift, overlapping speech and incomplete captured voice queues", () => {
    using f = new FoundationFixture();
    const ref = f.opaque("fixture");
    const audio = videogenStageAudio(ref);
    expect(() => validateVideogenStageSemantics(audio.schema_id, audio)).not.toThrow();
    expect(() =>
      validateVideogenStageSemantics(audio.schema_id, { ...audio, sample_count: 47999 })
    ).toThrow(/duration/u);
    expect(() =>
      validateVideogenStageSemantics(audio.schema_id, {
        ...audio,
        speech_intervals: [...audio.speech_intervals, ...audio.speech_intervals],
      })
    ).toThrow(/order/u);
    const queue = {
      schema_id: "penny.videogen-admitted-asset-ledger.v1",
      schema_version: 1,
      story_ref: ref,
      g1_decision_ref: ref,
      intents: [{ asset_id: "voice1", intent_ref: ref, state: "captured", capture_ref: ref }],
      required_image_ids: [],
      required_voice_ids: ["voice1"],
    };
    expect(() => validateVideogenStageSemantics(queue.schema_id, queue)).toThrow(/audio evidence/u);
  });
  it("cannot turn a model/still record into qualified playback or a mismatched target", () => {
    using f = new FoundationFixture();
    const ref = f.opaque("fixture");
    const p = {
      schema_id: "penny.videogen-playback-review.v1",
      schema_version: 1,
      target_ref: ref,
      target_digest: ref.content_digest,
      reviewer_kind: "qualified_av",
      reviewer_id: "fixture-reviewer",
      playback_device_profile_ref: ref,
      complete_viewing: false,
      heard_audio: false,
      observations: [
        {
          time: { numerator: 0, denominator: 1 },
          criterion: "speech",
          verdict: "uncertain",
          note: "fixture is not playback",
        },
      ],
      motion_verdict: "uncertain",
      speech_verdict: "uncertain",
      sync_verdict: "uncertain",
      identity_verdict: "uncertain",
      recorded_at_utc: "2026-10-18T00:00:00Z",
      attestation_ref: ref,
    };
    expect(() => validateVideogenStageSemantics(p.schema_id, p)).toThrow(/capability/u);
    expect(() =>
      validateVideogenStageSemantics(p.schema_id, {
        ...p,
        reviewer_kind: "human",
        target_digest: "a".repeat(64),
      })
    ).toThrow(/target/u);
  });
  it("enforces exact ShotResult fields and closed outcome vocabulary", () => {
    using f = new FoundationFixture();
    const ref = f.opaque("fixture");
    const shot = {
      schema_id: "penny.videogen-shot-result.v1",
      schema_version: 1,
      shot_media_ref: ref,
      shot_id: "shot1",
      stage: "draft",
      clip_ref: ref,
      route_ref: ref,
      video_evidence_ref: ref,
      objective_binding_ref: ref,
      quality_binding_ref: ref,
      ledger_ref: ref,
      disposition: "blocked",
    };
    expect(() => validateContract(ShotResultV1Schema, shot, "shot result")).not.toThrow();
    expect(() =>
      validateContract(
        ShotResultV1Schema,
        { ...shot, audio_policy: "strip_source_audio" },
        "shot result"
      )
    ).toThrow();
    expect(() =>
      validateContract(
        OperationOutcomeV1Schema,
        {
          schema_id: "penny.videogen-operation-outcome.v1",
          schema_version: 1,
          operation_id: "fixture-op",
          kind: "video_render",
          status: "partial_success",
        },
        "outcome"
      )
    ).toThrow();
  });
  it("rejects false positive terminals while retaining honest best partial refs", () => {
    using f = new FoundationFixture();
    const ref = f.opaque("fixture");
    const terminal = {
      schema_id: "penny.videogen-terminal.v1",
      schema_version: 1,
      gate_decision_refs: [],
      ledger_ref: ref,
      unresolved_operation_ids: [],
      status: "incomplete",
      met: false,
      best_valid_refs: [ref],
    };
    expect(() => validateContract(VideogenTerminalV1Schema, terminal, "terminal")).not.toThrow();
    expect(() => validateVideogenStageSemantics(terminal.schema_id, terminal)).not.toThrow();
    expect(() =>
      validateVideogenStageSemantics(terminal.schema_id, {
        ...terminal,
        status: "delivered",
        met: true,
      })
    ).toThrow(/closure/u);
    expect(() =>
      validateVideogenStageSemantics(terminal.schema_id, { ...terminal, met: true })
    ).toThrow(/status/u);
  });
});
