import type { ArtifactRef } from "../contracts.js";
import { assertUnique } from "../skill-contracts/common.js";
import {
  readExact,
  readSemantic,
  sameRef,
  validateFoundation,
  type FoundationLimitsV1,
} from "./bounds.js";
import {
  inspectCapturedAudioSource,
  validateAudioMeasurement,
  AudioMeasurementV1Schema,
  type AudioSourceV1,
} from "./audio-sources.js";
import {
  addTime,
  compareTime,
  measuredDuration,
  quantizeBoundary,
  subtractTime,
  validateRationalRate,
  validateRationalTime,
  type RationalTime,
} from "./rational-time.js";
import {
  checkLedgerCurrent,
  checkRights,
  DependencyLedgerV1Schema,
  ProvenanceBindingV1Schema,
  type CurrentDependencyIndexV1,
  type RightsHostV1,
} from "./rights-ledger.js";
import {
  EditDecisionV1Schema,
  EditCaptionStyleV1Schema,
  EditTransformationV1Schema,
  EditReviewBindingV1Schema,
  EditQuantizationV1Schema,
  MeasuredEditSourceV1Schema,
  type EditDecisionV1,
  type EditQuantizationV1,
} from "./edit-contracts.js";

export interface EditPolicyV1 {
  readonly max_frames: number;
  readonly max_samples: number;
  readonly max_duration: RationalTime;
  readonly sync_tolerance: RationalTime;
  readonly max_width: number;
  readonly max_height: number;
  readonly max_abs_gain_db: number;
}
/** Construction-time host selections, NOT an ingress or caller proof callback. */
export interface EditHostV1 extends RightsHostV1 {
  readonly current_dependencies: CurrentDependencyIndexV1;
  readonly measured_source_refs: readonly ArtifactRef[];
  readonly audio_sources: readonly {
    readonly source_ref: ArtifactRef;
    readonly measurement_ref: ArtifactRef;
  }[];
  readonly edit_policy: EditPolicyV1;
}
export interface EditReferenceEdge {
  readonly from: ArtifactRef;
  readonly to: ArtifactRef;
}
export interface EditClosureV1 {
  readonly status: "structural_checked";
  readonly edit: EditDecisionV1;
  readonly edit_ref: ArtifactRef;
  readonly quantization: EditQuantizationV1;
  readonly dependency_refs: readonly ArtifactRef[];
  readonly reference_edges: readonly EditReferenceEdge[];
  readonly external_evidence_refs: readonly ArtifactRef[];
  readonly production_admission: "blocked";
  readonly effect_permission: "none";
  readonly unverified: readonly string[];
}
const zero: RationalTime = { numerator: 0, denominator: 1 };
export function isExternalEditEvidence(ref: ArtifactRef): boolean {
  return [
    "penny.host-operation-receipt.v1",
    "penny.videogen-review-binding.v1",
    "penny.videogen-playback-review.v1",
    "penny.videogen-master-review.v1",
    "penny.videogen-package-review.v1",
    "penny.videogen-delivery-receipt.v1",
    "penny.videogen-native-build-result.v1",
    "penny.videogen-gate-packet.v1",
    "penny.videogen-gate-decision.v1",
  ].includes(ref.content_schema?.schema_id ?? "");
}
function checkPolicy(policy: EditPolicyV1): void {
  for (const value of [
    policy.max_frames,
    policy.max_samples,
    policy.max_width,
    policy.max_height,
    policy.max_abs_gain_db,
  ])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("finite edit policy required");
  validateRationalTime(policy.max_duration);
  validateRationalTime(policy.sync_tolerance);
  if (policy.max_duration.numerator <= 0 || policy.sync_tolerance.numerator < 0)
    throw new Error("edit duration/sync policy");
}
export function validateEditDecision(value: unknown, limits: FoundationLimitsV1): EditDecisionV1 {
  const edit = validateFoundation(EditDecisionV1Schema, value, limits);
  validateRationalRate(edit.canvas.fps);
  validateRationalRate(edit.canvas.audio_sample_rate);
  validateRationalTime(edit.end_time);
  assertUnique(
    edit.tracks.map((track) => track.track_id),
    "track IDs"
  );
  assertUnique(
    edit.tracks.flatMap((track) => track.items.map((item) => item.item_id)),
    "global placement IDs"
  );
  assertUnique(
    edit.mix_buses.map((bus) => bus.bus_id),
    "bus IDs"
  );
  if (edit.effect_registry_refs.length > 0)
    throw new Error("effect/transition registry integration unsupported");
  if (edit.audio_policy !== "strip_source_audio")
    throw new Error("source speech/mix clearance integration unsupported");
  if (edit.end_time.numerator <= 0) throw new Error("positive edit end required");
  const captionTracks = edit.tracks.filter((t) => t.kind === "caption");
  const captions = captionTracks.flatMap((t) => t.items.filter((i) => i.kind === "caption"));
  if (
    captionTracks.length > 1 ||
    new Set(captions.map((c) => c.text_source_ref.artifact_id)).size > 1 ||
    new Set(captions.map((c) => c.style_ref.artifact_id)).size > 1
  )
    throw new Error("multiple active caption sources/styles unqualified");
  for (const [index, track] of edit.tracks.entries()) {
    if (track.order !== index) throw new Error("tracks must have unique ordered positions");
    let end = zero;
    for (const item of track.items) {
      validateRationalTime(item.timeline_start);
      validateRationalTime(item.timeline_end);
      if (
        compareTime(item.timeline_start, end) !== 0 ||
        compareTime(item.timeline_start, item.timeline_end) >= 0 ||
        compareTime(item.timeline_end, edit.end_time) > 0
      )
        throw new Error("overlap, implicit gap or invalid half-open span");
      if (item.kind === "caption" && track.kind !== "caption")
        throw new Error("caption track mismatch");
      if (item.kind === "clip") {
        if (track.kind === "caption") throw new Error("clip on caption track");
        validateRationalTime(item.source_in);
        validateRationalTime(item.source_out);
        if (item.speed_map !== undefined || item.effect_ids.length > 0)
          throw new Error("unqualified speed map/effect; never drop");
        if (
          item.source_in.numerator < 0 ||
          compareTime(item.source_in, item.source_out) >= 0 ||
          compareTime(
            subtractTime(item.source_out, item.source_in),
            subtractTime(item.timeline_end, item.timeline_start)
          ) !== 0
        )
          throw new Error("source trim/span mismatch");
      }
      end = item.timeline_end;
    }
    if (compareTime(end, edit.end_time) !== 0) throw new Error("explicit terminal gap required");
  }
  const expectedCuts = edit.tracks
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.items.flatMap((i) => [i.timeline_start, i.timeline_end]))
    .filter((t) => compareTime(t, zero) > 0 && compareTime(t, edit.end_time) < 0)
    .sort(compareTime)
    .filter((t, i, all) => i === 0 || compareTime(t, all[i - 1] ?? zero) !== 0);
  if (
    edit.cut_boundaries.length !== expectedCuts.length ||
    edit.cut_boundaries.some((t, i) => compareTime(t, expectedCuts[i] ?? zero) !== 0)
  )
    throw new Error("cut boundary coverage/order mismatch");
  const routed = new Set<string>();
  for (const bus of edit.mix_buses) {
    for (const id of bus.source_track_ids) {
      const track = edit.tracks.find((t) => t.track_id === id);
      if (track === undefined || !["voice", "audio"].includes(track.kind) || routed.has(id))
        throw new Error("dangling/non-audio/duplicate bus routing");
      routed.add(id);
    }
  }
  return edit;
}

/** Exact canonical reads + current rights/ledger + measured timing. No decode, mix or native call. */
export function inspectEditDecision(host: EditHostV1, editRef: ArtifactRef): EditClosureV1 {
  checkPolicy(host.edit_policy);
  if (editRef.run_id !== host.run_id) throw new Error("edit must belong to current run");
  const edit = validateEditDecision(
    readSemantic({
      ...host,
      ref: editRef,
      schema: EditDecisionV1Schema,
      schema_id: "penny.videogen-edit-decision.v1",
    }),
    host.limits
  );
  const policy = host.edit_policy;
  if (
    compareTime(edit.end_time, policy.max_duration) > 0 ||
    edit.canvas.width > policy.max_width ||
    edit.canvas.height > policy.max_height
  )
    throw new Error("edit project cap");
  const ledgerRef = edit.source_dependency_ledger_ref;
  if (ledgerRef.run_id !== host.run_id) throw new Error("current ledger run mismatch");
  const ledger = checkLedgerCurrent(
    host,
    readSemantic({
      ...host,
      ref: ledgerRef,
      schema: DependencyLedgerV1Schema,
      schema_id: "penny.videogen-dependency-ledger.v1",
    }),
    host.current_dependencies,
    "edit"
  );
  const dependencies = new Map<string, ArtifactRef>();
  const external = new Map<string, ArtifactRef>();
  const edges: EditReferenceEdge[] = [];
  function include(ref: ArtifactRef, from?: ArtifactRef): void {
    readExact(host.store, host.project_id, ref, host.limits.max_integer);
    const target = isExternalEditEvidence(ref) ? external : dependencies;
    const previous = target.get(ref.artifact_id);
    if (previous !== undefined && !sameRef(previous, ref))
      throw new Error("conflicting exact dependency ref");
    target.set(ref.artifact_id, ref);
    if (
      from !== undefined &&
      !isExternalEditEvidence(ref) &&
      !isExternalEditEvidence(from) &&
      !sameRef(from, ref) &&
      !edges.some((e) => sameRef(e.from, from) && sameRef(e.to, ref))
    )
      edges.push({ from, to: ref });
  }
  function owned(ref: ArtifactRef, from?: ArtifactRef): void {
    if (ref.run_id !== host.run_id) throw new Error("host record from another run");
    include(ref, from);
  }
  function cleared(ref: ArtifactRef, from: ArtifactRef): void {
    const node = ledger.nodes.find((n) => sameRef(n.ref, ref));
    if (node?.rights_ref === undefined) throw new Error("used asset missing exact ledger rights");
    const rights = checkRights(host, ref, node.rights_ref, "edit");
    const kinds =
      ref.media_type === "video/mp4"
        ? ["video"]
        : ref.media_type === "audio/wav"
          ? ["voice", "performer"]
          : ref.media_type === "image/png"
            ? ["image"]
            : ref.media_type.startsWith("text/") ||
                ref.media_type.startsWith("font/") ||
                ref.content_schema?.schema_id === "penny.videogen-script.v1"
              ? ["text"]
              : [rights.subject_kind];
    if (!kinds.includes(rights.subject_kind))
      throw new Error("asset media/rights subject kind mismatch");
    include(ref, from);
    include(node.rights_ref, ref);
    include(rights.provenance_ref, node.rights_ref);
    include(rights.license_ref, node.rights_ref);
    for (const consent of rights.consent_refs) include(consent, node.rights_ref);
    const provenance = readSemantic({
      ...host,
      ref: rights.provenance_ref,
      schema: ProvenanceBindingV1Schema,
      schema_id: "penny.videogen-provenance-binding.v1",
    });
    // Provenance subject is identity, not a dependency edge back to the subject (no cycle).
    for (const source of provenance.source_refs) {
      const sourceNode = ledger.nodes.find((n) => sameRef(n.ref, source));
      if (sourceNode?.rights_ref === undefined)
        throw new Error("provenance original absent from rights ledger");
      checkRights(host, source, sourceNode.rights_ref, "edit");
      include(source, rights.provenance_ref);
    }
    include(provenance.producer_receipt_ref, rights.provenance_ref);
  }
  include(editRef);
  owned(ledgerRef, editRef);
  owned(edit.decision_notes_ref, editRef);
  for (const node of ledger.nodes) {
    include(node.ref, ledgerRef);
    if (node.rights_ref !== undefined) cleared(node.ref, ledgerRef);
    else if (node.ref.run_id !== host.run_id)
      throw new Error("unapproved cross-run control record");
    if (node.approval_ref !== undefined) owned(node.approval_ref);
  }
  assertUnique(
    host.measured_source_refs.map((r) => r.artifact_id),
    "measured source records"
  );
  const measured = host.measured_source_refs.map((ref) => {
    owned(ref);
    const facts = readSemantic({
      ...host,
      ref,
      schema: MeasuredEditSourceV1Schema,
      schema_id: "penny.videogen-edit-source.v1",
    });
    validateRationalRate(facts.source_frame_rate);
    if (
      compareTime(
        measuredDuration(facts.measured_ticks, facts.timebase),
        facts.decoded_duration
      ) !== 0
    )
      throw new Error("decoded PTS duration drift");
    return { ref, facts };
  });
  assertUnique(
    measured.map((m) => m.facts.source_ref.artifact_id),
    "measured source identities"
  );
  const audio = host.audio_sources.map((binding) => {
    const checked = inspectCapturedAudioSource({ host, ...binding, use: "edit" });
    if (checked.status !== "protocol_checked")
      throw new Error(`audio predecessor refused: ${checked.reason}`);
    owned(binding.source_ref);
    owned(binding.measurement_ref, binding.source_ref);
    const source = checked.source;
    for (const ref of [
      source.media_ref,
      source.rights_ref,
      source.provenance_ref,
      source.decoded_audio_ref,
      ...(source.consent_ref === undefined ? [] : [source.consent_ref]),
    ])
      include(ref, binding.source_ref);
    return { binding, source };
  });
  assertUnique(
    audio.map((a) => a.source.media_ref.artifact_id),
    "audio source identities"
  );
  const usedMeasured = new Set<string>();
  const usedAudio = new Set<string>();
  function gainCheck(
    points: readonly { sample_index: number; gain_db: number }[],
    start: number,
    end: number
  ): void {
    if (points.length !== 1) throw new Error("gain automation unqualified");
    for (const p of points)
      if (
        p.sample_index !== start ||
        p.sample_index >= end ||
        Math.abs(p.gain_db) > policy.max_abs_gain_db
      )
        throw new Error("gain outside placement/policy");
  }
  const boundaries: EditQuantizationV1["boundaries"] = [];
  let videoCount = 0;
  let speechCount = 0;
  for (const track of edit.tracks) {
    let frames = 0;
    let samples = 0;
    for (const item of track.items) {
      const fi = quantizeBoundary(item.timeline_start, edit.canvas.fps, policy.max_frames);
      const fo = quantizeBoundary(item.timeline_end, edit.canvas.fps, policy.max_frames);
      const si = quantizeBoundary(
        item.timeline_start,
        edit.canvas.audio_sample_rate,
        policy.max_samples
      );
      const so = quantizeBoundary(
        item.timeline_end,
        edit.canvas.audio_sample_rate,
        policy.max_samples
      );
      for (const residual of [fi.residual, fo.residual, si.residual, so.residual])
        if (
          compareTime(
            { ...residual, numerator: Math.abs(residual.numerator) },
            policy.sync_tolerance
          ) > 0
        )
          throw new Error("declared sync tolerance exceeded");
      if (
        item.kind !== "gap" &&
        ((["video", "caption"].includes(track.kind) && fo.index <= fi.index) ||
          (["voice", "audio"].includes(track.kind) && so.index <= si.index))
      )
        throw new Error("zero-length quantized placement");
      frames += fo.index - fi.index;
      samples += so.index - si.index;
      if (
        !Number.isSafeInteger(frames) ||
        !Number.isSafeInteger(samples) ||
        frames !== fo.index ||
        samples !== so.index
      )
        throw new Error("cumulative absolute boundary drift");
      boundaries.push({
        item_id: item.item_id,
        frame_in: fi.index,
        frame_out: fo.index,
        sample_in: si.index,
        sample_out: so.index,
        frame_residuals: [fi.residual, fo.residual],
        sample_residuals: [si.residual, so.residual],
      });
      if (item.kind === "clip") {
        cleared(item.source_ref, editRef);
        if (
          item.frame_in !== fi.index ||
          item.frame_out !== fo.index ||
          (item.sample_in !== undefined && item.sample_in !== si.index) ||
          (item.sample_out !== undefined && item.sample_out !== so.index) ||
          (item.sample_in === undefined) !== (item.sample_out === undefined)
        )
          throw new Error("chosen absolute frame/sample indices drift");
        if (item.gain_envelope !== undefined) {
          if (track.kind === "video") throw new Error("video gain is not strip-before-stems");
          gainCheck(item.gain_envelope, si.index, so.index);
        }
        if (track.kind === "video") {
          videoCount++;
          const source = measured.find((m) => sameRef(m.facts.source_ref, item.source_ref));
          if (
            source === undefined ||
            item.source_ref.media_type !== "video/mp4" ||
            item.source_ref.byte_length === 0
          )
            throw new Error("measured original video required; proxy not source");
          usedMeasured.add(source.ref.artifact_id);
          include(source.ref, editRef);
          include(source.facts.source_ref, source.ref);
          owned(source.facts.decode_record_ref, source.ref);
          if (compareTime(item.source_out, source.facts.decoded_duration) > 0)
            throw new Error("trim exceeds decoded source PTS");
          if (source.facts.audio_measurement_ref !== undefined) {
            owned(source.facts.audio_measurement_ref, source.ref);
            const m = validateAudioMeasurement(
              readSemantic({
                ...host,
                ref: source.facts.audio_measurement_ref,
                schema: AudioMeasurementV1Schema,
                schema_id: "penny.videogen-audio-measurement.v1",
              }),
              host.limits
            );
            if (!sameRef(m.source_ref, item.source_ref))
              throw new Error("embedded audio source mismatch");
            include(m.decode_receipt_ref, source.facts.audio_measurement_ref);
          }
          if (source.facts.transformation_ref !== undefined) {
            owned(source.facts.transformation_ref, source.ref);
            const t = readSemantic({
              ...host,
              ref: source.facts.transformation_ref,
              schema: EditTransformationV1Schema,
              schema_id: "penny.videogen-edit-transformation.v1",
            });
            if (
              !sameRef(t.processed_ref, item.source_ref) ||
              sameRef(t.original_ref, t.processed_ref) ||
              sameRef(t.original_ref, source.ref)
            )
              throw new Error("transformation original/processed lineage mismatch");
            cleared(t.original_ref, source.facts.transformation_ref);
            owned(t.parameters_ref, source.facts.transformation_ref);
            owned(t.measurement_ref, source.facts.transformation_ref);
            owned(t.review_binding_ref);
            const review = readSemantic({
              ...host,
              ref: t.review_binding_ref,
              schema: EditReviewBindingV1Schema,
              schema_id: "penny.videogen-review-binding.v1",
            });
            if (
              !sameRef(review.target_ref, t.processed_ref) ||
              review.disposition !== "pass" ||
              !review.evidence_refs.some((r) => sameRef(r, t.measurement_ref))
            )
              throw new Error("transformation current exact-target review required");
            for (const ref of [
              review.worker_result_ref,
              review.model_capability_ref,
              ...review.evidence_refs,
            ])
              owned(ref);
          }
        } else {
          if (item.sample_in === undefined || item.sample_out === undefined)
            throw new Error("audio sample indices mandatory");
          const selected = audio.find((a) => sameRef(a.source.media_ref, item.source_ref));
          if (selected === undefined) throw new Error("exact captured audio predecessor required");
          const source: AudioSourceV1 = selected.source;
          speechCount++;
          usedAudio.add(selected.binding.source_ref.artifact_id);
          include(selected.binding.source_ref, editRef);
          if (
            compareTime(item.source_out, source.duration) > 0 ||
            compareTime(addTime(source.placement, item.source_in), item.timeline_start) !== 0 ||
            source.channels !== edit.canvas.channels ||
            source.sample_rate.numerator !== edit.canvas.audio_sample_rate.numerator ||
            source.sample_rate.denominator !== edit.canvas.audio_sample_rate.denominator
          )
            throw new Error("audio trim/placement/normalization mismatch");
        }
      } else if (item.kind === "caption") {
        cleared(item.text_source_ref, editRef);
        owned(item.style_ref, editRef);
        const style = readSemantic({
          ...host,
          ref: item.style_ref,
          schema: EditCaptionStyleV1Schema,
          schema_id: "penny.videogen-edit-caption-style.v1",
        });
        if (
          !item.text_source_ref.media_type.startsWith("text/") ||
          item.text_source_ref.byte_length === 0 ||
          style.font_ref.byte_length === 0 ||
          !["font/ttf", "font/otf"].includes(style.font_ref.media_type)
        )
          throw new Error("caption text/font dependency mismatch");
        cleared(style.font_ref, item.style_ref);
      }
    }
  }
  if (videoCount === 0 || speechCount === 0)
    throw new Error("moving clips and captured speech required");
  if (usedMeasured.size !== measured.length || usedAudio.size !== audio.length)
    throw new Error("unused/mismatched host source selection");
  const totalFrames = quantizeBoundary(edit.end_time, edit.canvas.fps, policy.max_frames).index;
  const totalSamples = quantizeBoundary(
    edit.end_time,
    edit.canvas.audio_sample_rate,
    policy.max_samples
  ).index;
  for (const bus of edit.mix_buses) gainCheck(bus.gain_envelope, 0, totalSamples);
  const quantization = validateFoundation(
    EditQuantizationV1Schema,
    {
      schema_id: "penny.videogen-edit-quantization.v1",
      schema_version: 1,
      edit_ref: editRef,
      total_frames: totalFrames,
      total_samples: totalSamples,
      boundaries,
    },
    host.limits
  );
  return {
    status: "structural_checked",
    edit,
    edit_ref: editRef,
    quantization,
    dependency_refs: [...dependencies.values()],
    reference_edges: edges,
    external_evidence_refs: [...external.values()],
    production_admission: "blocked",
    effect_permission: "none",
    unverified: [
      "decode_and_review_journal_authority",
      "strip_resample_mix_and_caption_execution",
      "audible_intelligible_timed_speech",
      "native_interoperability",
      "current_g5_and_delivery",
    ],
  };
}
