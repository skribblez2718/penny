import type { ArtifactRef } from "../../dist/contracts.js";
import type { PersistArtifactInput } from "../../dist/artifact-store.js";
import { readSemantic, sameRef } from "../../dist/videogen/bounds.js";
import {
  RightsBindingV1Schema,
  ProvenanceBindingV1Schema,
  type DependencyLedgerV1,
  type CrossRunEdgeV1,
} from "../../dist/videogen/rights-ledger.js";
import { validateScript } from "../../dist/videogen/foundation-contracts.js";
import { inspectEditDecision, type EditReferenceEdge } from "../../dist/videogen/edit-decision.js";
import {
  validatePortableManifest,
  portablePathFor,
  type PortableHostV1,
} from "../../dist/videogen/portable-package.js";
import { validateEditDecision } from "../../dist/videogen/edit-decision.js";
import type {
  EditDecisionV1,
  MeasuredEditSourceV1,
  PortableManifestV1,
} from "../../dist/videogen/edit-contracts.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./videogen-foundation-fixtures.js";
import { audioFixture } from "./videogen-audio-fixtures.js";

export const time = (numerator: number, denominator = 1) => ({ numerator, denominator });
export function editFixture(
  f: FoundationFixture,
  options: {
    video_run?: string;
    transformed?: boolean;
    native_mp4?: Uint8Array;
    native_source_seconds?: 2 | 3;
    native_voice?: Uint8Array;
    native_caption?: { ass_bytes: Uint8Array; font_bytes: Uint8Array };
  } = {}
) {
  const audio = audioFixture(f, "supplied", f.run_id, options.native_voice);
  const original = f.raw(
    options.native_mp4 ?? "constructed video fixture; NOT decoded MP4",
    "video/mp4",
    undefined,
    options.video_run ?? f.run_id
  );
  const originalRights = f.rights(original, "video");
  const video =
    options.transformed === true
      ? f.raw("constructed processed video fixture; NOT decoded MP4", "video/mp4")
      : original;
  if (!sameRef(video, original)) f.rights(video, "video");
  const caption = f.raw(
    options.native_caption?.ass_bytes ?? "fixture caption words",
    options.native_caption === undefined ? "text/plain" : "text/x-ass"
  );
  f.rights(caption, "text");
  const font = f.raw(
    options.native_caption?.font_bytes ?? "constructed font fixture; NOT a font parser proof",
    "font/ttf"
  );
  f.rights(font, "text");
  const style = f.json(
    {
      schema_id: "penny.videogen-edit-caption-style.v1",
      schema_version: 1,
      font_ref: font,
      size_px: options.native_caption === undefined ? 24 : 16,
      color_rgba: "ffffffff",
    },
    "penny.videogen-edit-caption-style.v1"
  );
  const outline = f.opaque("fixture prior outline", "text/plain");
  const script = validateScript(
    {
      schema_id: "penny.videogen-script.v1",
      schema_version: 1,
      story_outline_ref: outline,
      scenes: [{ scene_id: "scene_one", ordered_lines: [] }],
      narration_lines: [
        {
          line_id: "line_one",
          text: "Fixture words only, not performed speech.",
          delivery_intent: "neutral",
        },
      ],
      language: "en",
      coverage_shot_ids: ["shot_one"],
    },
    FOUNDATION_LIMITS
  );
  const scriptRef = f.json(script, script.schema_id);
  f.rights(scriptRef, "text");
  const decodeRecord = f.opaque("fixture raw PTS measurement; NOT signed decode custody");
  let transformation: ArtifactRef | undefined;
  let transformationReview: ArtifactRef | undefined;
  if (!sameRef(video, original)) {
    const measurement = f.opaque("fixture processed-source measurement");
    transformationReview = f.json(
      {
        schema_id: "penny.videogen-review-binding.v1",
        schema_version: 1,
        worker_result_ref: f.opaque("fixture review worker bytes"),
        target_ref: video,
        evidence_refs: [measurement],
        model_capability_ref: f.opaque("fixture capability"),
        disposition: "pass",
      },
      "penny.videogen-review-binding.v1"
    );
    transformation = f.json(
      {
        schema_id: "penny.videogen-edit-transformation.v1",
        schema_version: 1,
        original_ref: original,
        processed_ref: video,
        kind: "normalize",
        parameters_ref: f.opaque("fixture normalization parameters"),
        measurement_ref: measurement,
        review_binding_ref: transformationReview,
      },
      "penny.videogen-edit-transformation.v1"
    );
  }
  const measured: MeasuredEditSourceV1 = {
    schema_id: "penny.videogen-edit-source.v1",
    schema_version: 1,
    source_ref: video,
    measured_ticks:
      options.native_mp4 === undefined ? 32 : (options.native_source_seconds ?? 2) * 25,
    timebase: time(1, options.native_mp4 === undefined ? 16 : 25),
    decoded_duration: time(options.native_source_seconds ?? 2),
    source_frame_rate: { numerator: options.native_mp4 === undefined ? 16 : 25, denominator: 1 },
    decode_record_ref: decodeRecord,
    ...(transformation === undefined ? {} : { transformation_ref: transformation }),
  };
  const measuredRef = f.json(measured, measured.schema_id);
  const subjects = [
    video,
    ...(sameRef(video, original) ? [] : [original]),
    audio.source.media_ref,
    caption,
    font,
    scriptRef,
  ];
  const ledger: DependencyLedgerV1 = {
    schema_id: "penny.videogen-dependency-ledger.v1",
    schema_version: 1,
    nodes: subjects.map((ref, i) => {
      const rights = f.current_rights.find((r) => sameRef(r.subject_ref, ref));
      if (rights === undefined) throw new Error("fixture missing rights");
      return {
        stable_id: `asset_${i}`,
        role: "final",
        ref,
        revision: 1,
        rights_ref: rights.rights_ref,
        status: "current",
      };
    }),
    edges: [],
    review_epochs: [],
    invalidations: [],
  };
  const ledgerRef = f.json(ledger, ledger.schema_id);
  const edit = validateEditDecision(
    {
      schema_id: "penny.videogen-edit-decision.v1",
      schema_version: 1,
      canvas: {
        width: 640,
        height: 360,
        fps: { numerator: 24, denominator: 1 },
        color_space: "rec709",
        audio_sample_rate: audio.source.sample_rate,
        channels: "mono",
        video_codec: "h264",
        audio_codec: "aac",
      },
      tracks: [
        {
          track_id: "picture",
          kind: "video",
          order: 0,
          items: [
            {
              kind: "clip",
              item_id: "clip_one",
              source_ref: video,
              source_in: time(1, 4),
              source_out: time(3, 4),
              timeline_start: time(0),
              timeline_end: time(1, 2),
              frame_in: 0,
              frame_out: 12,
              effect_ids: [],
            },
            {
              kind: "gap",
              item_id: "gap_one",
              timeline_start: time(1, 2),
              timeline_end: time(3, 4),
            },
            {
              kind: "clip",
              item_id: "clip_two",
              source_ref: video,
              source_in: time(0),
              source_out: time(1, 4),
              timeline_start: time(3, 4),
              timeline_end: time(1),
              frame_in: 18,
              frame_out: 24,
              effect_ids: [],
            },
          ],
        },
        {
          track_id: "speech",
          kind: "voice",
          order: 1,
          items: [
            {
              kind: "clip",
              item_id: "voice_one",
              source_ref: audio.source.media_ref,
              source_in: time(0),
              source_out: time(1),
              timeline_start: time(0),
              timeline_end: time(1),
              frame_in: 0,
              frame_out: 24,
              sample_in: 0,
              sample_out: 8000,
              gain_envelope: [{ sample_index: 0, gain_db: -6 }],
              effect_ids: [],
            },
          ],
        },
        {
          track_id: "subtitles",
          kind: "caption",
          order: 2,
          items: [
            {
              kind: "caption",
              item_id: "caption_one",
              text_source_ref: caption,
              language: "en",
              timeline_start: time(0),
              timeline_end: time(1),
              style_ref: style,
            },
          ],
        },
      ],
      mix_buses: [
        {
          bus_id: "voice_bus",
          source_track_ids: ["speech"],
          gain_envelope: [{ sample_index: 0, gain_db: -3 }],
          loudness_target_lufs: -16,
        },
      ],
      end_time: time(1),
      cut_boundaries: [time(1, 2), time(3, 4)],
      effect_registry_refs: [],
      source_dependency_ledger_ref: ledgerRef,
      decision_notes_ref: f.opaque("fixture editing intent", "text/plain"),
      audio_policy: "strip_source_audio",
      ...(options.native_mp4 === undefined
        ? {}
        : {
            canvas: {
              width: 512,
              height: 288,
              fps: { numerator: 25, denominator: 1 },
              color_space: "rec601",
              audio_sample_rate: audio.source.sample_rate,
              channels: "mono",
              video_codec: "h264",
              audio_codec: "aac",
            },
            tracks:
              options.native_caption === undefined
                ? [
                    {
                      track_id: "picture",
                      kind: "video",
                      order: 0,
                      items: [
                        {
                          kind: "clip",
                          item_id: "clip_one",
                          source_ref: video,
                          source_in: time(0),
                          source_out: time(2),
                          timeline_start: time(0),
                          timeline_end: time(2),
                          frame_in: 0,
                          frame_out: 50,
                          effect_ids: [],
                        },
                      ],
                    },
                    {
                      track_id: "speech",
                      kind: "voice",
                      order: 1,
                      items: [
                        {
                          kind: "clip",
                          item_id: "voice_one",
                          source_ref: audio.source.media_ref,
                          source_in: time(0),
                          source_out: time(1),
                          timeline_start: time(0),
                          timeline_end: time(1),
                          frame_in: 0,
                          frame_out: 25,
                          sample_in: 0,
                          sample_out: 8000,
                          effect_ids: [],
                        },
                        {
                          kind: "gap",
                          item_id: "voice_tail",
                          timeline_start: time(1),
                          timeline_end: time(2),
                        },
                      ],
                    },
                  ]
                : [
                    {
                      track_id: "picture",
                      kind: "video",
                      order: 0,
                      items: [
                        {
                          kind: "clip",
                          item_id: "clip_one",
                          source_ref: video,
                          source_in: time(1, 5),
                          source_out: time(6, 5),
                          timeline_start: time(0),
                          timeline_end: time(1),
                          frame_in: 0,
                          frame_out: 25,
                          effect_ids: [],
                        },
                        {
                          kind: "gap",
                          item_id: "video_gap",
                          timeline_start: time(1),
                          timeline_end: time(7, 5),
                        },
                        {
                          kind: "clip",
                          item_id: "clip_two",
                          source_ref: video,
                          source_in: time(1),
                          source_out: time(8, 5),
                          timeline_start: time(7, 5),
                          timeline_end: time(2),
                          frame_in: 35,
                          frame_out: 50,
                          effect_ids: [],
                        },
                        {
                          kind: "gap",
                          item_id: "video_tail",
                          timeline_start: time(2),
                          timeline_end: time(3),
                        },
                      ],
                    },
                    {
                      track_id: "speech",
                      kind: "voice",
                      order: 1,
                      items: [
                        {
                          kind: "clip",
                          item_id: "voice_one",
                          source_ref: audio.source.media_ref,
                          source_in: time(0),
                          source_out: time(1),
                          timeline_start: time(0),
                          timeline_end: time(1),
                          frame_in: 0,
                          frame_out: 25,
                          sample_in: 0,
                          sample_out: 8000,
                          gain_envelope: [{ sample_index: 0, gain_db: -6 }],
                          effect_ids: [],
                        },
                        {
                          kind: "gap",
                          item_id: "voice_tail",
                          timeline_start: time(1),
                          timeline_end: time(3),
                        },
                      ],
                    },
                    {
                      track_id: "subtitles",
                      kind: "caption",
                      order: 2,
                      items: [
                        {
                          kind: "caption",
                          item_id: "caption_one",
                          text_source_ref: caption,
                          style_ref: style,
                          language: "en",
                          timeline_start: time(0),
                          timeline_end: time(3),
                        },
                      ],
                    },
                  ],
            mix_buses: [],
            end_time: time(options.native_caption === undefined ? 2 : 3),
            cut_boundaries:
              options.native_caption === undefined ? [] : [time(1), time(7, 5), time(2)],
          }),
    },
    FOUNDATION_LIMITS
  );
  const editRef = f.json(edit, edit.schema_id);
  const crossRunEdges: CrossRunEdgeV1[] = [];
  if (original.run_id !== f.run_id) {
    const rights = readSemantic({
      ...f.host(),
      ref: originalRights,
      schema: RightsBindingV1Schema,
      schema_id: "penny.videogen-rights-binding.v1",
    });
    crossRunEdges.push({
      schema_id: "penny.videogen-cross-run-edge.v1",
      schema_version: 1,
      project_id: f.project_id,
      consumer_run_id: f.run_id,
      source_ref: original,
      rights_ref: originalRights,
      provenance_ref: rights.provenance_ref,
      authorization_ref: f.opaque("fixture exact cross-run authorization"),
    });
  }
  const host: PortableHostV1 = {
    ...f.host(),
    current_dependencies: ledger.nodes.map((n) => ({
      stable_id: n.stable_id,
      ref: n.ref,
      revision: n.revision,
    })),
    measured_source_refs: [measuredRef],
    audio_sources: [{ source_ref: audio.source_ref, measurement_ref: audio.measurement_ref }],
    edit_policy: {
      max_frames: 10000,
      max_samples: 10000000,
      max_duration: time(60),
      sync_tolerance: time(1, 24),
      max_width: 1920,
      max_height: 1080,
      max_abs_gain_db: 60,
    },
    cross_run_edges: crossRunEdges,
    package_policy: { max_files: 200, max_file_bytes: 1000000, max_payload_bytes: 10000000 },
  };
  return {
    host,
    edit,
    edit_ref: editRef,
    ledger,
    ledger_ref: ledgerRef,
    video,
    original,
    caption,
    font,
    style,
    script_ref: scriptRef,
    outline,
    measured,
    measured_ref: measuredRef,
    audio,
    transformation_ref: transformation,
    transformation_review_ref: transformationReview,
  };
}
export type EditFixture = ReturnType<typeof editFixture>;
export function persistEdit(f: FoundationFixture, edit: unknown): ArtifactRef {
  return f.json(edit, "penny.videogen-edit-decision.v1");
}
export function manifestMetadata(
  f: FoundationFixture,
  operation = "fixture_package"
): PersistArtifactInput["metadata"] {
  return {
    schema_version: 2,
    run_id: f.run_id,
    phase: "fixture_package",
    branch_id: null,
    kind: "videogen-package",
    operation_id: operation,
    version: 1,
    producer: "host:videogen-fixture",
    media_type: "application/json",
    parent_ref: null,
    upstream_refs: [],
    content_schema: { schema_id: "penny.videogen-portable-package.v1", schema_version: 1 },
  };
}
/** Builds structural payload fixtures only, never a saved native project or a decoded master. */
export function packageFixture(f: FoundationFixture, e: EditFixture) {
  const closure = inspectEditDecision(e.host, e.edit_ref);
  const quantization = f.json(closure.quantization, closure.quantization.schema_id);
  const master = f.raw("constructed master fixture; NOT playable media", "video/mp4");
  const project = f.raw("<fixture-not-qualified-native-project/>", "application/x-kdenlive");
  f.rights(master, "video");
  f.rights(project, "text");
  const instructions = f.opaque(
    "Fixture only. Do not open as a qualified native project.",
    "text/plain"
  );
  const credits = f.opaque("fixture license credits", "text/plain");
  const provenance = f.opaque("fixture package provenance", "text/plain");
  const subset = f.json(
    {
      schema_id: "penny.videogen-edit-feature-subset.v1",
      schema_version: 1,
      features: ["hard_cuts", "ordered_clips", "trims", "gaps", "voice_gain", "captions"],
    },
    "penny.videogen-edit-feature-subset.v1"
  );
  const refs = new Map(closure.dependency_refs.map((r) => [r.artifact_id, r]));
  const edges: EditReferenceEdge[] = [...closure.reference_edges];
  function include(ref: ArtifactRef, from?: ArtifactRef): void {
    refs.set(ref.artifact_id, ref);
    if (from !== undefined && !sameRef(from, ref)) edges.push({ from, to: ref });
  }
  for (const ref of [
    master,
    project,
    instructions,
    credits,
    provenance,
    subset,
    e.outline,
    quantization,
  ])
    include(ref);
  for (const ref of [...refs.values()]) {
    const current = f.current_rights.find((r) => sameRef(r.subject_ref, ref));
    if (current === undefined) continue;
    const right = readSemantic({
      ...f.host(),
      ref: current.rights_ref,
      schema: RightsBindingV1Schema,
      schema_id: "penny.videogen-rights-binding.v1",
    });
    include(current.rights_ref, ref);
    include(right.license_ref, current.rights_ref);
    include(right.license_ref, ref);
    include(right.provenance_ref, current.rights_ref);
    for (const consent of right.consent_refs) include(consent, current.rights_ref);
    const prov = readSemantic({
      ...f.host(),
      ref: right.provenance_ref,
      schema: ProvenanceBindingV1Schema,
      schema_id: "penny.videogen-provenance-binding.v1",
    });
    include(prov.producer_receipt_ref, right.provenance_ref);
    for (const source of prov.source_refs) include(source, right.provenance_ref);
  }
  edges.push(
    { from: e.script_ref, to: e.outline },
    { from: master, to: e.edit_ref },
    { from: project, to: e.edit_ref },
    { from: quantization, to: e.edit_ref }
  );
  for (const track of e.edit.tracks)
    for (const item of track.items) {
      if (item.kind === "clip") edges.push({ from: project, to: item.source_ref });
      if (item.kind === "caption")
        edges.push(
          { from: project, to: item.text_source_ref },
          { from: project, to: item.style_ref }
        );
    }
  function roleFor(ref: ArtifactRef): PortableManifestV1["files"][number]["role"] {
    if (sameRef(ref, master)) return "master";
    if (sameRef(ref, project)) return "project";
    if (sameRef(ref, e.video) || sameRef(ref, e.original)) return "original_video";
    if (sameRef(ref, e.audio.source.media_ref)) return "voice_stem";
    if (sameRef(ref, e.caption)) return "caption_source";
    if (sameRef(ref, e.font)) return "title_asset";
    if (sameRef(ref, e.script_ref)) return "script";
    if (sameRef(ref, credits)) return "credit";
    if (
      sameRef(ref, provenance) ||
      ref.content_schema?.schema_id === "penny.videogen-provenance-binding.v1"
    )
      return "provenance";
    if (
      ref.content_schema?.schema_id === "penny.videogen-rights-binding.v1" ||
      f.current_rights.some((r) => {
        const rights = readSemantic({
          ...f.host(),
          ref: r.rights_ref,
          schema: RightsBindingV1Schema,
          schema_id: "penny.videogen-rights-binding.v1",
        });
        return sameRef(rights.license_ref, ref);
      })
    )
      return "license";
    return "documentation";
  }
  const files: PortableManifestV1["files"] = [...refs.values()]
    .map((ref) => {
      const role = roleFor(ref);
      const current = f.current_rights.find((r) => sameRef(r.subject_ref, ref));
      const rights =
        current === undefined
          ? undefined
          : readSemantic({
              ...f.host(),
              ref: current.rights_ref,
              schema: RightsBindingV1Schema,
              schema_id: "penny.videogen-rights-binding.v1",
            });
      const used = e.edit.tracks.flatMap((t) =>
        t.items.filter((i) => i.kind === "clip" && sameRef(i.source_ref, ref)).map((i) => i.item_id)
      );
      return {
        relative_path: portablePathFor(ref, role),
        role,
        sha256: ref.content_digest,
        bytes: ref.byte_length,
        media_type: ref.media_type,
        producer_ref: ref,
        ...(rights === undefined ? {} : { license_ref: rights.license_ref }),
        used_by: ["fixture_package", ...used, ...(sameRef(ref, e.font) ? ["font_main"] : [])],
      };
    })
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  function fileFor(ref: ArtifactRef) {
    const file = files.find((r) => sameRef(r.producer_ref, ref));
    if (file === undefined) throw new Error("fixture missing payload");
    return file;
  }
  const masterFile = fileFor(master);
  const projectFile = fileFor(project);
  const uniqueEdges = new Map(
    edges.map((edge) => {
      const from = fileFor(edge.from).relative_path;
      const to = fileFor(edge.to).relative_path;
      return [`${from}\n${to}`, { from, to }];
    })
  );
  const manifest = validatePortableManifest(
    {
      schema_id: "penny.videogen-portable-package.v1",
      schema_version: 1,
      package_id: "fixture_package",
      accepted_master: {
        relative_path: masterFile.relative_path,
        sha256: masterFile.sha256,
        bytes: masterFile.bytes,
        format: "mp4",
        duration: e.edit.end_time,
      },
      native_project: {
        relative_path: projectFile.relative_path,
        sha256: projectFile.sha256,
        bytes: projectFile.bytes,
        kdenlive_version: "fixture-unqualified",
        mlt_version: "fixture-unqualified",
      },
      edit_decision_ref: e.edit_ref,
      files,
      reference_graph: [...uniqueEdges.values()],
      clip_to_timeline: e.edit.tracks.flatMap((t) =>
        t.items
          .filter((i) => i.kind === "clip")
          .map((i) => ({
            clip_id: i.item_id,
            track_id: t.track_id,
            start: i.timeline_start,
            end: i.timeline_end,
          }))
      ),
      rights_ledger_ref: e.ledger_ref,
      credits_ref: credits,
      provenance_ref: provenance,
      environment: {
        editor_build: "fixture_unqualified",
        mlt_build: "fixture_unqualified",
        os_arch: "fixture",
        decoder_build: "fixture_unqualified",
        encoder_build: "fixture_unqualified",
        dependencies: [{ id: "font_main", digest: e.font.content_digest, packaged: true }],
        config_digest: "1".repeat(64),
      },
      feature_subset_ref: subset,
      known_losses: ["No native, media decode or playback qualification."],
      instructions_relative_path: fileFor(instructions).relative_path,
    },
    FOUNDATION_LIMITS
  );
  return { manifest, master, project, subset };
}
export function replaceItem(
  edit: EditDecisionV1,
  id: string,
  patch: Record<string, unknown>
): unknown {
  return {
    ...edit,
    tracks: edit.tracks.map((t) => ({
      ...t,
      items: t.items.map((i) => (i.item_id === id ? { ...i, ...patch } : i)),
    })),
  };
}
