import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { canonicalJson } from "../dist/canonical-json.js";
import { runVideogenRuntimeCli } from "../dist/videogen-runtime-cli.js";
import {
  syntheticVideogenProfile,
  syntheticVideogenInventory,
} from "./helpers/videogen-fixtures.js";
import { bindRuntimeNativeRequest } from "../dist/videogen/runtime-native.js";
import { describe, expect, it } from "vitest";
import { RunContext } from "../dist/context.js";
import { validateContract } from "../dist/contracts.js";
import { LocalApiOperationMeter } from "../dist/host-operations/local-api-meter.js";
import {
  padCanonicalPcmTail,
  SourcePreparationRequestSchema,
} from "../dist/videogen/runtime-preparation.js";
import { canonicalPcmWav, inspectCanonicalPcmWav } from "../dist/videogen/media-decode.js";
import { prepareSingleShotEdit } from "../dist/videogen/runtime-single-shot.js";
import { VideogenRuntime } from "../dist/videogen/runtime.js";
import { saveExecution, executionState, setSlot, slot } from "../dist/videogen/execution-state.js";
import { EditDecisionV1Schema } from "../dist/videogen/edit-contracts.js";
import {
  NativeBuildTemplateV1Schema,
  NativeBuildRequestV1Schema,
} from "../dist/videogen/native-contracts.js";
import { LookVoiceTemplateV1Schema } from "../dist/videogen/foundation-contracts.js";
import { fixtureProviders, setup } from "./helpers/videogen-executor-fixture.js";
import { FoundationFixture } from "./helpers/videogen-foundation-fixtures.js";
import { MEDIA_POLICY } from "./helpers/videogen-media-fixtures.js";
import {
  videogenStageRequest,
  videogenStageWorkerFixtures,
} from "./helpers/videogen-stage-fixtures.js";
import { editFixture } from "./helpers/videogen-edit-fixtures.js";
import { capacityPolicy, meters } from "./helpers/capacity-fixtures.js";
import { DependencyLedgerV1Schema } from "../dist/videogen/rights-ledger.js";
import { constructGateDecision, validateGatePacket } from "../dist/videogen/gates.js";
import { JsonValueSchema } from "../dist/contracts.js";

describe("explicit runtime source preparation and authored inputs, not production qualification", () => {
  it("preserves every original sample, pads only zeros, and refuses trimming, fractional endpoints and oversized output", () => {
    const policy = { ...MEDIA_POLICY, max_samples: 240000, max_sample_rate: 24000 };
    const data = Buffer.alloc(24 * 2);
    data.writeInt16LE(1234, 0);
    data.writeInt16LE(-321, 46);
    const raw = canonicalPcmWav(data, 1, 24000),
      duration = { numerator: 1, denominator: 500 };
    const padded = padCanonicalPcmTail(raw, policy, duration),
      pcm = inspectCanonicalPcmWav(padded.bytes, policy);
    expect(pcm.sample_rate).toBe(24000);
    expect(pcm.samples).toBe(48);
    expect(pcm.data.subarray(0, data.length)).toEqual(data);
    expect(pcm.data.subarray(data.length)).toEqual(Buffer.alloc(data.length));
    expect(padded.receipt).toMatchObject({
      padded_samples: 24,
      speech_trimmed: false,
      resampled: false,
    });
    expect(padCanonicalPcmTail(raw, policy, { numerator: 1, denominator: 1000 }).bytes).toEqual(
      raw
    );
    expect(() => padCanonicalPcmTail(raw, policy, { numerator: 1, denominator: 2000 })).toThrow(
      "no speech trimming"
    );
    expect(() => padCanonicalPcmTail(raw, policy, { numerator: 1, denominator: 999 })).toThrow();
    expect(() => padCanonicalPcmTail(raw, { ...policy, max_output_bytes: 80 }, duration)).toThrow();
  });
  it("requires exact original result/receipt source operands and an explicitly closed preparation choice", () => {
    using f = new FoundationFixture();
    const ref = f.opaque("test-only source");
    const value = {
      schema_id: "penny.videogen-native-media-request.v1",
      schema_version: 1,
      operation_id: "prepare",
      subject_id: "shot",
      media_ref: ref,
      source_result_ref: ref,
      source_receipt_ref: ref,
      decode_policy_ref: ref,
      preparation: { kind: "pcm_silence_pad", duration: { numerator: 5, denominator: 1 } },
    };
    expect(validateContract(SourcePreparationRequestSchema, value, "test")).toEqual(value);
    const { source_receipt_ref, ...missing } = value;
    void source_receipt_ref;
    expect(() => validateContract(SourcePreparationRequestSchema, missing, "test")).toThrow();
    expect(() =>
      validateContract(
        SourcePreparationRequestSchema,
        { ...value, preparation: { kind: "trim_speech" } },
        "test"
      )
    ).toThrow();
    expect(() =>
      validateContract(SourcePreparationRequestSchema, { ...value, command: "run" }, "test")
    ).toThrow();
  });
  it("accepts inert choice templates without fabricated performance or edit artifacts", () => {
    using f = new FoundationFixture();
    const ref = f.opaque("test-only declared author choice");
    expect(
      validateContract(
        LookVoiceTemplateV1Schema,
        {
          schema_id: "penny.videogen-look-voice-template.v1",
          schema_version: 1,
          style_sheet_ref: ref,
          voice_identity: {
            voice_id: "voice",
            source: "voice_studio",
            language: "en",
            consent_ref: ref,
          },
          license_refs: [],
          known_limits: ["not a performance"],
        },
        "look"
      )
    ).not.toHaveProperty("performance_ref");
    expect(
      validateContract(
        NativeBuildTemplateV1Schema,
        {
          schema_id: "penny.videogen-native-build-template.v1",
          schema_version: 1,
          fixture_digest: "a".repeat(64),
          editor_build_digest: "b".repeat(64),
          mlt_build_digest: "c".repeat(64),
          feature_subset_digest: "d".repeat(64),
          output_root_selector: "test",
          limits: {
            max_xml_bytes: 1024,
            max_assets: 4,
            max_duration_frames: 125,
            max_normalize_ms: 1000,
          },
        },
        "native"
      )
    ).not.toHaveProperty("edit_ref");
  });
  it("allows zero compute allocation on separately capped storage/network carriers, not on unnamed noncompute resources", () => {
    using f = new FoundationFixture();
    const base = capacityPolicy(),
      policy = {
        ...base,
        external_work_policy: "penny_serialized_api" as const,
        resources: [
          ...base.resources,
          {
            max_slots: 1,
            protected_finish_slots: 0,
            resource_id: "storage",
            limits: { ...meters(0), stored_bytes: 1000 },
            protected_finish: meters(0),
          },
          {
            max_slots: 1,
            protected_finish_slots: 0,
            resource_id: "network",
            limits: { ...meters(0), egress_bytes: 1000 },
            protected_finish: meters(0),
          },
        ],
      };
    const binding = {
      assurance: "trusted_local_api",
      storage_resource_id: "storage",
      network_resource_id: "network",
      tariffs: meters(0),
      max_socket_observations: 8,
      resources: policy.resources.map((r) => ({
        resource_id: r.resource_id,
        cpu_slots: ["storage", "network"].includes(r.resource_id) ? 0 : 1,
        gpu_slots: 0,
      })),
    };
    expect(new LocalApiOperationMeter(f.store, policy, binding).binding).toEqual(binding);
    expect(
      () =>
        new LocalApiOperationMeter(f.store, policy, {
          ...binding,
          resources: binding.resources.map((r) => ({ ...r, cpu_slots: 0 })),
        })
    ).toThrow("allocation mapping");
  });
  it("assembles one current-picture edit from measured narration without stale fixture-shaped products", () => {
    using f = new FoundationFixture();
    const e = editFixture(f),
      providers = fixtureProviders(f);
    const config = {
      ...providers.config,
      single_shot_edit: {
        shot_id: "shot1",
        voice_asset_id: "voice",
        board_asset_id: "board",
        canvas: { ...e.edit.canvas, channels: e.audio.source.channels },
        duration: e.audio.source.duration,
        caption_ref: e.caption,
        style_ref: e.style,
        notes_ref: f.opaque("synthetic edit author notes"),
      },
    };
    const runtime = new VideogenRuntime(f.store, f.checkpointer, f.project_id, {
      ...providers,
      config,
    });
    const c = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: f.run_id,
        session_id: f.run_id,
        playbook: "videogen",
        engine_owner: "typescript",
      },
      goal: "Synthetic contract test, not a film",
      constraints: {},
      projectRoot: f.root,
      trustProfile: "hardened-untrusted",
      maxSteps: 100,
    });
    saveExecution(c, {
      schema_version: 1,
      config_digest: runtime.binding_digest,
      slots: [],
      shot_ids: ["shot1"],
      shot_index: 0,
      asset_index: 0,
      effect_index: 0,
      effects: [],
    });
    const s = executionState(c);
    setSlot(c, s, "L", e.ledger_ref);
    setSlot(c, s, "audio_source-voice", e.audio.source_ref);
    setSlot(c, s, "png-board", e.video);
    prepareSingleShotEdit(runtime, c, "animatic");
    const edit = runtime.read(slot(executionState(c), "animatic_edit"), EditDecisionV1Schema);
    expect(edit.canvas.audio_sample_rate).toEqual(e.audio.source.sample_rate);
    const audio = edit.tracks.find((t) => t.kind === "voice")?.items[0];
    if (!audio || audio.kind !== "clip") throw new Error("voice clip missing");
    expect(audio.source_ref).toEqual(e.audio.source.media_ref);
    expect(audio.source_out).toEqual(e.audio.source.duration);
    expect(audio.sample_out).toBe(e.audio.measurement.decoded_sample_count);
    expect(edit.end_time).toEqual(config.single_shot_edit.duration);
    const template = f.json(
      {
        schema_id: "penny.videogen-native-build-template.v1",
        schema_version: 1,
        fixture_digest: "a".repeat(64),
        editor_build_digest: "b".repeat(64),
        mlt_build_digest: "c".repeat(64),
        feature_subset_digest: "d".repeat(64),
        output_root_selector: "test",
        limits: {
          max_xml_bytes: 4096,
          max_assets: 8,
          max_duration_frames: 125,
          max_normalize_ms: 1000,
        },
      },
      "penny.videogen-native-build-template.v1"
    );
    setSlot(c, executionState(c), "native_request_template", template);
    const bound = runtime.read(
      bindRuntimeNativeRequest(runtime, c, slot(executionState(c), "animatic_edit")),
      NativeBuildRequestV1Schema
    );
    expect(bound.schema_id).toBe("penny.videogen-native-build-request.v1");
    expect(bound.accepted_master_ref).toBeUndefined();
    expect(bound.assets.map((a) => a.source_ref.artifact_id)).toContain(
      e.audio.source.media_ref.artifact_id
    );
    expect(bound.assets.map((a) => a.source_ref.artifact_id)).toContain(e.font.artifact_id);

    const changed = f.json(
      { ...e.audio.source, duration: { numerator: 2, denominator: 1 } },
      "penny.videogen-audio-source.v1"
    );
    setSlot(c, executionState(c), "audio_source-voice", changed);
    expect(() => prepareSingleShotEdit(runtime, c, "animatic")).toThrow("VOICE_FIT_REQUIRES_HUMAN");
  });
  it("pins complete source-graph contracts through a GET-only CLI inspection and refuses a changed model enum", async () => {
    using f = new FoundationFixture();
    const calls: string[] = [];
    let drift = false;
    const server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      const inventory = syntheticVideogenInventory();
      if (drift)
        inventory.ModelLoader.input.required.model_name = [
          ["unapproved.safetensors"],
          { default: "unapproved.safetensors" },
        ];
      res.setHeader("Content-Type", "application/json");
      res.end(canonicalJson(inventory));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test address missing");
      const request = path.join(f.root, "request.json"),
        output = path.join(f.root, "inventory.json");
      writeFileSync(
        request,
        canonicalJson({
          schema_id: "penny.videogen-comfy-inspection-request.v1",
          schema_version: 1,
          profile: syntheticVideogenProfile({ port: address.port, mode: "t2v" }),
        }),
        { mode: 0o600 }
      );
      let text = "";
      await runVideogenRuntimeCli(
        ["inspect-comfy", `--requestfile=${request}`, `--outputfile=${output}`],
        {},
        undefined,
        (value) => {
          text += value;
        }
      );
      expect(text).toContain("object_info_only_not_generation_or_model_residency");
      expect(JSON.parse(readFileSync(output, "utf8"))).toHaveProperty("ModelLoader");
      expect(calls).toEqual(["GET /object_info"]);
      drift = true;
      const refused = path.join(f.root, "refused.json");
      await expect(
        runVideogenRuntimeCli(
          ["inspect-comfy", `--requestfile=${request}`, `--outputfile=${refused}`],
          {},
          undefined,
          () => {}
        )
      ).rejects.toThrow();
      expect(existsSync(refused)).toBe(false);
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    }
  });
  it("routes exact host-authored story/script through real continuations and reviewers to an unchanged G1", async () => {
    using f = new FoundationFixture();
    const providers = fixtureProviders(f),
      products = videogenStageWorkerFixtures();
    const authored_products = (["story_plan", "script_text"] as const).map((state) => ({
      state,
      ref: f.json(
        products[state],
        state === "story_plan"
          ? "penny.videogen-story-outline.v1"
          : "penny.videogen-script-draft.v1"
      ),
    }));
    const supplied = { ...providers, config: { ...providers.config, authored_products } };
    const x = setup(f, supplied);
    const calls: string[] = [];
    const original = x.client.runAgent;
    x.client.runAgent = (invocation) => {
      calls.push(invocation.stateId);
      if (authored_products.some((p) => p.state === invocation.stateId))
        throw new Error("host author product was incorrectly dispatched");
      return original(invocation);
    };
    const request = videogenStageRequest();
    const identity = {
      schema_version: 2 as const,
      run_id: f.run_id,
      session_id: f.run_id,
      playbook: "videogen",
      engine_owner: "typescript" as const,
    };
    const boundary = await x.runner.runUntilBoundary(
      x.engine.handle({
        schema_version: 2,
        action: "start",
        identity,
        goal: request.brief,
        constraints: request,
        project_root: path.resolve(import.meta.dirname, "../../.."),
        trust_profile: "hardened-untrusted",
      })
    );
    expect(boundary.action).toBe("await_user");
    expect(calls).toContain("story_check");
    expect(calls).not.toContain("story_plan");
    expect(calls).not.toContain("script_text");
    const c = f.checkpointer.loadRun(identity),
      s = executionState(c);
    expect(s.slots.some((row) => row.slot === "script")).toBe(true);
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toHaveLength(0);
    const runtime = new VideogenRuntime(f.store, f.checkpointer, f.project_id, supplied);
    expect(runtime.acceptAuthored(c)).toBe(false);
    const priorLedgerRef = slot(s, "L"),
      priorLedger = runtime.read(priorLedgerRef, DependencyLedgerV1Schema),
      packetRef = slot(s, "packet"),
      packet = validateGatePacket(
        JSON.parse(f.store.read(packetRef).toString()),
        supplied.config.limits
      );
    expect(priorLedger.nodes.some((node) => node.stable_id === "G1")).toBe(false);
    // Isolated bookkeeping test only. A playbook response cannot commit engine gate authority.
    runtime.resume(
      c,
      validateContract(
        JsonValueSchema,
        constructGateDecision(packet, packetRef, "approve", supplied.config.limits),
        "fixture reply"
      )
    );
    const approved = executionState(c),
      ledger = runtime.read(slot(approved, "L"), DependencyLedgerV1Schema);
    for (const name of ["G1", "intent-image1"])
      expect(
        ledger.nodes.some(
          (node) =>
            node.status === "current" && node.ref.artifact_id === slot(approved, name).artifact_id
        )
      ).toBe(true);
    expect(runtime.read(priorLedgerRef, DependencyLedgerV1Schema)).toEqual(priorLedger);
    expect(c.playbookData.videogen_owner_selection).toMatchObject({ approvals: [] });
    expect(f.checkpointer.hostOperationCallsForRun(f.run_id)).toEqual([]);
  });
});
