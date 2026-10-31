import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import {
  ArtifactRefSchema,
  JsonValueSchema,
  validateContract,
  type ArtifactRef,
  type JsonValue,
} from "../../dist/contracts.js";
import {
  ConfinedNativeBindingsSchema,
  ConfinedNativeRunner,
} from "../../dist/host-operations/confined-native-runner.js";
import { ConfinedMediaRunner } from "../../dist/host-operations/confined-media-runner.js";
import { hostCapacityWorkerKey } from "../../dist/host-operations/capacity-contracts.js";
import {
  assembleVideogenEffects,
  VideogenCpuBindingsSchema,
  type VideogenAdapterManifestV1,
} from "../../dist/videogen/runtime-adapters.js";
import {
  buildVideogenRuntimeManifest,
  type VideogenRuntimeManifestV1,
} from "../../dist/videogen/runtime-manifest.js";
import {
  validateVideogenPrivateConfig,
  type VideogenEffectRecipeV1,
} from "../../dist/videogen/runtime-config.js";
import { KdenliveFixtureRegistry } from "../../dist/videogen/kdenlive-registry.js";
import { buildVideoSubmittedGraph } from "../../dist/videogen/graph-builder.js";
import {
  validateVideogenProfile,
  validateVideogenProfileSnapshot,
} from "../../dist/videogen/contracts.js";
import { NativeQualifiedRawResultV1Schema } from "../../dist/videogen/native-contracts.js";
import { ManifestVideogenFixture } from "./videogen-manifest-fixture.js";
import { setup } from "./videogen-executor-fixture.js";
import { editFixture, time } from "./videogen-edit-fixtures.js";
import { saved, XML_LIMITS } from "./videogen-native-fixtures.js";
import { suppliedCpuBindings, MEDIA_POLICY, syntheticVideo } from "./videogen-media-fixtures.js";
import { syntheticVideogenProfile } from "./videogen-fixtures.js";
import { capacityPolicy, meters } from "./capacity-fixtures.js";
import { canonicalPcmWav } from "../../dist/videogen/media-decode.js";
import { encodeCanonicalPng } from "../../dist/png-media.js";
import { RightsBindingV1Schema, type RightsBindingV1 } from "../../dist/videogen/rights-ledger.js";

/** All rights, model reviews, performance measurements and playback prerequisites in this
 * fixture are explicitly synthetic. Only native/CPU work and owner/delivery IO are real. */
export class DefaultNativeFixture extends ManifestVideogenFixture {
  override [Symbol.dispose](): void {
    if (process.env["VIDEOGEN_NATIVE_TEST_RETAIN"] !== "1") {
      super[Symbol.dispose]();
      return;
    }
    const output = process.env["VIDEOGEN_NATIVE_TEST_OUTPUT"];
    if (!output) throw new Error("retained test output path required");
    this.checkpointer.close();
    this.store.close();
    writeFileSync(
      path.join(output, "retained-default-root.json"),
      canonicalJson({ root: this.root }),
      { mode: 0o600 }
    );
  }
  private license: ArtifactRef | undefined;
  override rights(
    subject: ArtifactRef,
    kind: RightsBindingV1["subject_kind"] = "image",
    consents: ArtifactRef[] = []
  ): ArtifactRef {
    const old = super.rights(subject, kind, consents);
    this.license ??= this.opaque(
      "SYNTHETIC COMMON TEST GRANT ONLY. Not legal clearance.",
      "text/plain"
    );
    const value = validateContract(
      RightsBindingV1Schema,
      JSON.parse(this.store.read(old).toString()),
      "fixture grant"
    );
    const ref = this.json({ ...value, license_ref: this.license }, value.schema_id);
    const last = this.current_rights.at(-1);
    if (!last) throw new Error("fixture grant missing");
    last.rights_ref = ref;
    return ref;
  }
}

export function defaultNativeManifest(
  f: DefaultNativeFixture,
  port: number,
  pluginInventory?: readonly string[]
) {
  const nativePath = process.env["VIDEOGEN_NATIVE_TEST_BINDINGS"],
    fontPath = process.env["VIDEOGEN_NATIVE_TEST_FONT"],
    priorPath = process.env["VIDEOGEN_NATIVE_TEST_PRIOR_RAW"];
  if (!nativePath || !fontPath || (!priorPath && !pluginInventory))
    throw new Error("explicit private native bindings/font/prior resource inventory required");
  const native = validateContract(
      ConfinedNativeBindingsSchema,
      JSON.parse(readFileSync(nativePath, "utf8")),
      "private native binding"
    ),
    cpu = validateContract(
      VideogenCpuBindingsSchema,
      suppliedCpuBindings(f.root).bindings,
      "CPU runtime binding"
    );
  const nativeRunner = new ConfinedNativeRunner(native),
    cpuRunner = new ConfinedMediaRunner(cpu);
  const editor = nativeRunner.editorDigest,
    renderer = nativeRunner.rendererDigest,
    mlt = native.runtime_files.find((p) => p.target.endsWith("/libmlt-7.so.7.41.0"))?.sha256;
  if (!editor || !renderer || !mlt) throw new Error("actual native pins missing");
  const video = syntheticVideo(
    suppliedCpuBindings(f.root).fixture_ffmpeg,
    path.join(f.root, "source.mp4"),
    false,
    {
      width: 512,
      height: 288,
      fps: 25,
      duration: 3,
    }
  );
  const ass = Buffer.from(
    saved("caption.ass")
      .toString()
      .replace("00:00:02.00,00:00:07.00", "00:00:00.00,00:00:03.00")
      .replace("Arial", "DejaVu Sans")
  );
  const pcm = Buffer.alloc(48000);
  for (let i = 0; i < 24000; i++)
    pcm.writeInt16LE(Math.round(8192 * Math.sin((i * Math.PI * 2 * 440) / 8000)), i * 2);
  const e = editFixture(f, {
    native_voice: canonicalPcmWav(pcm, 1, 8000),
    native_mp4: video,
    native_source_seconds: 3,
    native_caption: { ass_bytes: ass, font_bytes: readFileSync(fontPath) },
  });
  // Test measurements and consent/rights are supplied prerequisites, never decoder/host proof.
  f.rights(e.style, "text");

  const policy = {
    ...MEDIA_POLICY,
    max_width: 512,
    max_height: 288,
    max_pixels: 512 * 288,
    max_frames: 175,
    max_samples: 480000,
    max_sample_rate: 48000,
    max_duration: time(4),
    max_input_bytes: 16777216,
    max_output_bytes: 134217728,
    max_decoded_bytes: 134217728,
    max_selected_frames: 8,
    max_elapsed_ms: 30000,
    cpu_seconds: 20,
  };
  const policyRef = f.json(policy, policy.schema_id),
    selection = f.json(
      {
        schema_id: "penny.videogen-media-frame-selection.v1",
        schema_version: 1,
        selection_rule_id: "span-boundaries-and-nearest-even-v1",
        timepoints: [],
        midpoint_count: 1,
      },
      "penny.videogen-media-frame-selection.v1"
    );
  const fixturePins = validateContract(
    Type.Array(
      Type.Object({ path: Type.String(), sha256: Type.String() }, { additionalProperties: false })
    ),
    JSON.parse(process.env["VIDEOGEN_NATIVE_TEST_FIXTURES"] ?? "[]"),
    "saved fixture pins"
  );
  const fixtures = [
    ...["single.kdenlive", "caption.kdenlive", "ordered.kdenlive"].map((name) => {
      const file = path.join(f.root, name),
        bytes = saved(name);
      writeFileSync(file, bytes, { mode: 0o600 });
      return { path: file, sha256: sha256(bytes), max_bytes: XML_LIMITS.max_bytes };
    }),
    ...fixturePins.map((pin, i) => {
      const bytes = readFileSync(pin.path);
      if (sha256(bytes) !== pin.sha256) throw new Error("saved fixture pin drift");
      const file = path.join(f.root, `extra-${i}.kdenlive`);
      writeFileSync(file, bytes, { mode: 0o600 });
      return { path: file, sha256: pin.sha256, max_bytes: XML_LIMITS.max_bytes };
    }),
  ];
  const registry = new KdenliveFixtureRegistry({
    editor_build_digest: editor,
    mlt_build_digest: mlt,
    fixtures: fixtures.map((pin) => ({ bytes: readFileSync(pin.path), sha256: pin.sha256 })),
    limits: XML_LIMITS,
  });
  const common = {
    backend_binding_id: "synthetic-local-fixture",
    backend_key_sha256: hostCapacityWorkerKey("synthetic-local-worker"),
    lease_profile_id: "synthetic-local-lease",
    lease_duration_ms: 180000,
    lease_renew_after_ms: 10000,
    queue_inactivity_ms: 60000,
    operation_inactivity_ms: 180000,
    max_request_bytes: 1048576,
    max_input_bytes: 67108864,
    max_output_bytes: 268435456,
    max_progress_events: 256,
  };
  const nativeBinding = {
    runtime: native,
    comparison: { runtime: cpu, policy },
    edit_policy: e.host.edit_policy,
    process_policy: {
      max_input_bytes: 16777216,
      max_output_bytes: 16777216,
      max_writable_bytes: 268435456,
      max_writable_inodes: 4096,
      max_diagnostic_bytes: 1048576,
      inactivity_ms: 90000,
      max_elapsed_ms: 120000,
      address_space_bytes: 3221225472,
      cpu_seconds: 90,
      max_processes: 65536,
      max_open_files: 256,
    },
    output_root_selector: "native-output",
    registry: { editor_build_digest: editor, mlt_build_digest: mlt, fixtures, limits: XML_LIMITS },
  };
  const original = syntheticVideogenProfile({ port });
  const { profile_sha256, ...body } = original;
  void profile_sha256;
  const modified = {
    ...body,
    dimensions: [{ width: 512, height: 288 }],
    frame_counts: [75],
    fps_values: [25],
    limits: { ...body.limits, max_video_bytes: 16777216 },
  };
  const profile = validateVideogenProfile({
    ...modified,
    profile_sha256: sha256(canonicalJson(modified)),
  });
  const snapshot = validateVideogenProfileSnapshot({
    schema_id: "penny.videogen-profile-snapshot.v1",
    schema_version: 1,
    profile,
    approved_profile_sha256: profile.profile_sha256,
    source_graph_sha256: profile.source_graph_sha256,
  });
  const profileRef = f.json(snapshot, snapshot.schema_id),
    graph = buildVideoSubmittedGraph({
      run_id: f.run_id,
      shot_id: "shot1",
      profile_snapshot: snapshot,
      profile_snapshot_ref: profileRef,
      spec: {
        mode: "t2v",
        positive_prompt: "Synthetic local media; no real model job.",
        negative_prompt: "none",
        seed: 7,
        dimensions: { width: 512, height: 288 },
        frame_count: 75,
        fps: 25,
      },
      input_upload_receipt: null,
      input_upload_receipt_ref: null,
    }),
    graphRef = f.json(graph, graph.schema_id);
  const destination = path.join(f.root, "destination"),
    cache = path.join(f.root, "cache");
  mkdirSync(destination, { mode: 0o700 });
  mkdirSync(cache, { mode: 0o700 });
  const adapters: VideogenAdapterManifestV1[] = [
    {
      kind: "video_render",
      policy: common,
      binding: {
        worker_id: "synthetic-local-worker",
        legacy_http: true,
        profiles: [profile],
        approved_profile_sha256_by_id: { [profile.profile_id]: profile.profile_sha256 },
      },
    },
    {
      kind: "media_decode_extract",
      policy: common,
      binding: { mode: "runtime", runtime: cpu, policy_ref: policyRef, policy },
    },
    { kind: "timeline_master", policy: common, binding: nativeBinding },
    { kind: "kdenlive_build_verify", policy: common, binding: nativeBinding },
    {
      kind: "local_delivery",
      policy: common,
      binding: {
        edit_policy: e.host.edit_policy,
        package_policy: { max_files: 1000, max_file_bytes: 67108864, max_payload_bytes: 268435456 },
        destinations: [
          {
            destination_id: "fixture-local",
            root: destination,
            max_files: 1000,
            max_bytes: 268435456,
            reserve_bytes: 1,
          },
        ],
      },
    },
  ];
  const effects = assembleVideogenEffects(adapters, e.host.limits),
    output = f.opaque("Synthetic expected-output policy, not permission"),
    recipes: VideogenEffectRecipeV1[] = [];
  const add = (
    kind: VideogenEffectRecipeV1["kind"],
    stage: VideogenEffectRecipeV1["stage"],
    fields: Record<string, JsonValue>,
    operands: VideogenEffectRecipeV1["operands"],
    input_bindings: NonNullable<VideogenEffectRecipeV1["input_bindings"]>,
    rights_source_slots?: string[]
  ) =>
    recipes.push({
      kind,
      stage,
      subject_id: stage === "draft" || stage === "final" ? "shot1" : "production",
      fields,
      operands,
      input_slots: [],
      input_bindings,
      output_contract_ref: output,
      backend_key_sha256: common.backend_key_sha256,
      budget_policy: {
        lifetime_ms: 3600000,
        meters: [
          { meter: "attempts", reserved: 1 },
          { meter: "stored_bytes", reserved: 100000000 },
        ],
      },
      ...(rights_source_slots ? { rights_source_slots } : {}),
    });
  recipes.push({
    kind: "media_decode_extract",
    stage: "asset",
    subject_id: "voice1",
    fields: {
      schema_id: "penny.videogen-native-media-request.v1",
      schema_version: 1,
      audio_policy: "measure_pcm",
      required_spans: [{ start: time(0), end: time(3) }],
    },
    operands: [
      { field: "media_ref", slot: "supplied_voice" },
      { field: "decode_policy_ref", slot: "decode_policy" },
      { field: "frame_selection_ref", slot: "frame_selection" },
    ],
    input_slots: [],
    input_bindings: [
      { slot: "media", source_slot: "supplied_voice" },
      { slot: "decode-policy", source_slot: "decode_policy" },
      { slot: "frame-selection", source_slot: "frame_selection" },
    ],
    output_contract_ref: output,
    backend_key_sha256: common.backend_key_sha256,
    budget_policy: {
      lifetime_ms: 3600000,
      meters: [
        { meter: "attempts", reserved: 1 },
        { meter: "stored_bytes", reserved: 100000000 },
      ],
    },
  });
  for (const stage of ["draft", "final"] as const) {
    add(
      "video_render",
      stage,
      {
        schema_id: "penny.video-generation-operation-request.v1",
        schema_version: 1,
        run_id: f.run_id,
        shot_id: "shot1",
        profile_id: profile.profile_id,
        profile_sha256: profile.profile_sha256,
        submitted_graph_sha256: graphRef.content_digest,
        mode: "t2v",
        dimensions: { width: 512, height: 288 },
        frame_count: 75,
        fps: 25,
      },
      [
        { field: "profile_snapshot_ref", slot: "profile" },
        { field: "submitted_graph_ref", slot: "submitted" },
      ],
      [
        { slot: "profile_snapshot", source_slot: "profile" },
        { slot: "submitted_graph", source_slot: "submitted" },
      ],
      ["licensed_source"]
    );
    add(
      "media_decode_extract",
      stage,
      {
        schema_id: "penny.videogen-native-media-request.v1",
        schema_version: 1,
        required_spans: [{ start: time(0), end: time(3) }],
      },
      [
        { field: "media_ref", slot: "clip-shot1" },
        { field: "decode_policy_ref", slot: "decode_policy" },
        { field: "frame_selection_ref", slot: "frame_selection" },
      ],
      [
        { slot: "media", source_slot: "clip-shot1" },
        { slot: "decode-policy", source_slot: "decode_policy" },
        { slot: "frame-selection", source_slot: "frame_selection" },
      ]
    );
  }
  for (const stage of ["rough", "finished"] as const) {
    const req = stage === "rough" ? "rough_native_request" : "native_request",
      media = stage === "rough" ? "rough_cut" : "master",
      edit = stage === "rough" ? "rough_edit" : "final_edit";
    add(
      "timeline_master",
      stage,
      { schema_id: "penny.timeline-master-request.v1", schema_version: 1 },
      [{ field: "native_build_request_ref", slot: req }],
      []
    );
    add(
      "media_decode_extract",
      stage,
      {
        schema_id: "penny.videogen-native-media-request.v1",
        schema_version: 1,
        required_spans: [{ start: time(0), end: time(3) }],
      },
      [
        { field: "media_ref", slot: media },
        { field: "edit_ref", slot: edit },
        { field: "decode_policy_ref", slot: "decode_policy" },
        { field: "frame_selection_ref", slot: "frame_selection" },
      ],
      [
        { slot: "media", source_slot: media },
        { slot: "edit", source_slot: edit },
        { slot: "decode-policy", source_slot: "decode_policy" },
        { slot: "frame-selection", source_slot: "frame_selection" },
      ]
    );
  }
  add(
    "kdenlive_build_verify",
    "finished",
    { schema_id: "penny.videogen-native-operation-request.v1", schema_version: 1 },
    [{ field: "native_build_request_ref", slot: "native_request" }],
    []
  );
  add(
    "local_delivery",
    "delivery",
    { schema_id: "penny.videogen-delivery-operation-request.v1", schema_version: 1 },
    [{ field: "delivery_intent_ref", slot: "delivery_intent" }],
    [{ slot: "delivery-intent", source_slot: "delivery_intent" }]
  );
  const base = setup(f).providers.config,
    png = f.raw(
      encodeCanonicalPng({ width: 1, height: 1, rgba: Buffer.from([30, 60, 90, 255]) }),
      "image/png"
    ),
    opaque = f.opaque("Explicitly synthetic packaging/model prerequisite", "text/plain");
  f.rights(png);
  const look = f.json(
    {
      schema_id: "penny.videogen-look-voice-template.v1",
      schema_version: 1,
      style_sheet_ref: opaque,
      voice_identity: {
        voice_id: "voice1",
        source: "supplied",
        language: "en",
        consent_ref: opaque,
      },
      license_refs: [],
      known_limits: ["SYNTHETIC TEST. No performed speech, model qualification or real clearance."],
    },
    "penny.videogen-look-voice-template.v1"
  );
  const nativeTemplate = f.json(
    {
      schema_id: "penny.videogen-native-build-template.v1",
      schema_version: 1,
      fixture_digest: sha256(saved("single.kdenlive")),
      editor_build_digest: editor,
      mlt_build_digest: mlt,
      feature_subset_digest: registry.digest,
      output_root_selector: "native-output",
      limits: {
        max_xml_bytes: 262144,
        max_assets: 16,
        max_duration_frames: 10000,
        max_normalize_ms: 120000,
      },
    },
    "penny.videogen-native-build-template.v1"
  );
  // This inventory selects package resources, never an earlier qualification verdict.
  const pluginDigests =
    pluginInventory ??
    (() => {
      if (!priorPath) throw new Error("explicit observed resource inventory missing");
      const prior = validateContract(
        NativeQualifiedRawResultV1Schema,
        JSON.parse(readFileSync(priorPath, "utf8")),
        "previous resource inventory, NOT reused proof"
      );
      return prior.phases.flatMap((p) =>
        p.processes.flatMap((p) => p.plugins.map((p) => p.sha256))
      );
    })();
  const environment_files = [...new Set(pluginDigests)].map((digest, i) => {
    const pin = native.runtime_files.find((p) => p.sha256 === digest);
    if (!pin) throw new Error("observed resource absent from pins");
    const ref = f.raw(readFileSync(pin.source), "application/octet-stream");
    f.rights(ref, "text");
    return { id: `plugin_${i}`, ref };
  });
  environment_files.push({ id: "font_main", ref: e.font });
  const subset = f.json(
    {
      schema_id: "penny.videogen-edit-feature-subset.v1",
      schema_version: 1,
      features: ["hard_cuts", "ordered_clips", "trims", "gaps", "voice_gain", "captions"],
    },
    "penny.videogen-edit-feature-subset.v1"
  );
  const commonProducts = [
    { slot: "licensed_source", ref: e.video },
    { slot: "profile", ref: profileRef },
    { slot: "submitted", ref: graphRef },
    { slot: "png-image1", ref: png },
    { slot: "supplied_voice", ref: e.audio.source.media_ref },
    { slot: "performance", ref: e.audio.source.media_ref },
    { slot: "look_template", ref: look },
    { slot: "native_request_template", ref: nativeTemplate },
    { slot: "decode_policy", ref: policyRef },
    { slot: "frame_selection", ref: selection },
  ];
  const sourceRights = f.current_rights.find(
    (r) => r.subject_ref.artifact_id === e.video.artifact_id
  );
  if (!sourceRights) throw new Error("fixture source rights missing");
  // Import only rights-bearing supplied dependencies. Old fixture script/ledger are templates,
  // not current package operands; current script/outline and native resources are host-derived.
  const config = validateVideogenPrivateConfig({
    ...base,
    limits: {
      ...base.limits,
      max_text_bytes: 1048576,
      max_json_bytes: 16777216,
      max_collection_items: 8192,
      max_nodes: 500000,
      max_depth: 48,
    },
    envelope: {
      ...base.envelope,
      max_frames: 175,
      max_source_bytes: 268435456,
      max_output_bytes: 268435456,
      max_storage_bytes: 2000000000,
      max_attempts: 100,
      max_cost_units: 100,
      finish_reserve_bytes: 1000,
    },
    rights: f.current_rights,
    import_authorization_ref: opaque,
    script_rights_source_slots: ["licensed_source"],
    assets: [
      {
        ...base.assets[0],
        input_refs: [png],
        rights_ref: f.current_rights.find((r) => r.subject_ref.artifact_id === png.artifact_id)
          ?.rights_ref,
      },
      {
        schema_id: "penny.videogen-asset-intent.v1",
        schema_version: 1,
        asset_id: "voice1",
        purpose: "performance",
        source: "supplied",
        input_refs: [e.audio.source.media_ref],
        allowed_change: "none",
        preserve_criteria: ["Synthetic tone only, not performed narration"],
        consent_ref: e.audio.source.consent_ref ?? opaque,
        rights_ref: e.audio.source.rights_ref,
        estimated_meters: [
          { meter: "attempts", reserved: 1 },
          { meter: "stored_bytes", reserved: 100000000 },
        ],
        attempt_limit: 1,
      },
    ],
    routes: [
      {
        ...base.routes[0],
        qualified_profile_snapshot_ref: profileRef,
        timing_target: time(3),
        mode: {
          ...base.routes[0]?.mode,
          shot_id: "shot1",
          mode: "t2v",
          profile_snapshot_ref: profileRef,
          rights_refs: [sourceRights.rights_ref],
          target: {
            width: 512,
            height: 288,
            frame_count: 75,
            fps: { numerator: 25, denominator: 1 },
            duration: time(3),
          },
        },
      },
    ],
    initial_products: commonProducts,
    single_shot_edit: {
      shot_id: "shot1",
      voice_asset_id: "voice1",
      board_asset_id: "image1",
      canvas: e.edit.canvas,
      duration: time(3),
      caption_ref: e.caption,
      style_ref: e.style,
      notes_ref: opaque,
    },
    portable: {
      package_id: "synthetic_native_package",
      credits_ref: f.opaque("Synthetic fixture credits. NOT rights clearance.", "text/plain"),
      provenance_ref: f.opaque(
        "Synthetic test provenance; native observations are obtained on this run.",
        "text/plain"
      ),
      instructions_ref: f.opaque(
        "Synthetic test package. NOT a production-qualified film. Relink only listed relative resources in the pinned editor environment.",
        "text/plain"
      ),
      feature_subset_ref: subset,
      package_policy: { max_files: 1000, max_file_bytes: 67108864, max_payload_bytes: 268435456 },
      environment: {
        editor_build: editor,
        mlt_build: mlt,
        os_arch: `${process.platform}_${process.arch}`,
        decoder_build: cpuRunner.runtimeDigest,
        encoder_build: renderer,
        config_digest: sha256(
          canonicalJson(
            [native.driver, ...native.runtime_files].map((p) => ({
              target: p.target,
              sha256: p.sha256,
            }))
          )
        ),
        dependencies: environment_files.map((f) => ({
          id: f.id,
          digest: f.ref.content_digest,
          packaged: true,
        })),
      },
      environment_files,
    },
  });
  const capacity = {
    policy: {
      ...capacityPolicy(),
      queue_wait_ms: 180000,
      active_inactivity_ms: 180000,
      cleanup_grace_ms: 60000,
      resources: [
        {
          resource_id: "synthetic-cpu-accounting",
          max_slots: 1,
          protected_finish_slots: 0,
          limits: meters(1000),
          protected_finish: meters(0),
        },
      ],
      bindings: [...effects].map(([kind, p]) => ({
        binding_id: kind,
        operation_kind: kind,
        adapter_id: p.declaration.adapter_id,
        backend_binding_id: p.declaration.backend_binding_id,
        worker_id: "synthetic-local-worker",
        resource_ids: ["synthetic-cpu-accounting"],
        purpose:
          kind === "timeline_master" ||
          kind === "kdenlive_build_verify" ||
          kind === "local_delivery"
            ? ("finish" as const)
            : ("work" as const),
      })),
    },
    measurement_file: path.join(f.root, "synthetic-meter.json"),
    demands: [...effects.keys()].map((kind) => ({
      operation_kind: kind,
      binding_id: kind,
      demands: [{ resource_id: "synthetic-cpu-accounting", slots: 1, meters: meters(1) }],
    })),
  };
  const artifacts: VideogenRuntimeManifestV1["artifacts"] = [],
    ids = new Map<string, string>();
  function template(v: JsonValue): JsonValue {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(template);
    if ("artifact_id" in v) {
      const ref = validateContract(ArtifactRefSchema, v, "input ref");
      let id = ids.get(ref.artifact_id);
      if (!id) {
        id = `input_${ids.size}`;
        ids.set(ref.artifact_id, id);
        const bytes = f.store.read(ref);
        let parsed: JsonValue | undefined;
        try {
          parsed = validateContract(JsonValueSchema, JSON.parse(bytes.toString()), "input JSON");
        } catch {
          parsed = ref.media_type === "application/json" ? bytes.toString() : undefined;
        }
        if (parsed !== undefined)
          artifacts.push({
            id,
            kind: ref.kind,
            media_type: ref.media_type,
            ...(ref.content_schema ? { schema_id: ref.content_schema.schema_id } : {}),
            source: { json: template(parsed) },
          });
        else {
          const file = path.join(f.root, `${id}.bin`);
          writeFileSync(file, bytes, { mode: 0o600 });
          artifacts.push({
            id,
            kind: ref.kind,
            media_type: ref.media_type,
            source: {
              file: { path: file, sha256: sha256(bytes), max_bytes: Math.max(1, bytes.length) },
            },
          });
        }
      }
      return { $artifact: id };
    }
    return Object.fromEntries(
      Object.entries(v).map(([k, v]) => [
        k,
        k === "submitted_graph_sha256"
          ? { $artifact_digest: ids.get(graphRef.artifact_id) ?? "missing" }
          : template(v),
      ])
    );
  }
  const manifest = buildVideogenRuntimeManifest({
    artifacts,
    config: template(validateContract(JsonValueSchema, config, "config JSON")),
    recipes: recipes.map((v) => template(validateContract(JsonValueSchema, v, "recipe JSON"))),
    adapters: adapters.map((v) => template(validateContract(JsonValueSchema, v, "adapter JSON"))),
    capacity,
    result_cache_root: cache,
  });
  return { manifest, capacity, video, destination, e, policy, policyRef, selection, cpu };
}
