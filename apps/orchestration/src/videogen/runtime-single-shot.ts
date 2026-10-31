import type { VideogenRuntime } from "./runtime.js";
import type { RunContext } from "../context.js";
import { executionState, slot, setSlot } from "./execution-state.js";
import { AudioSourceV1Schema } from "./audio-sources.js";
import { EditDecisionV1Schema, EditCaptionStyleV1Schema } from "./edit-contracts.js";
import { ShotResultV1Schema } from "./stage-contracts.js";
import { compareTime, quantizeBoundary } from "./rational-time.js";

/** Closed one-shot composition only. Real measured/padded narration covers the full endpoint;
 * picture is trimmed, never looped, frozen, stretched or black-padded. No review is issued. */
export function prepareSingleShotEdit(
  r: VideogenRuntime,
  c: RunContext,
  stage: "animatic" | "rough"
): void {
  const policy = r.config.single_shot_edit;
  if (!policy) throw new Error("single shot edit policy missing");
  const s = executionState(c);
  if (s.shot_ids.length !== 1 || s.shot_ids[0] !== policy.shot_id)
    throw new Error("single shot exact canonical coverage required");
  const audio = r.read(slot(s, `audio_source-${policy.voice_asset_id}`), AudioSourceV1Schema);
  if (
    compareTime(audio.duration, policy.duration) !== 0 ||
    audio.channels !== policy.canvas.channels
  )
    throw new Error(
      "VOICE_FIT_REQUIRES_HUMAN: current narration must fit explicit silence-pad operation"
    );
  const video =
    stage === "rough"
      ? r.read(slot(s, `draft-${policy.shot_id}`), ShotResultV1Schema).clip_ref
      : slot(s, `png-${policy.board_asset_id}`);
  const frames = quantizeBoundary(policy.duration, policy.canvas.fps, r.config.envelope.max_frames);
  const samples = quantizeBoundary(policy.duration, audio.sample_rate, Number.MAX_SAFE_INTEGER);
  if (frames.residual.numerator || samples.residual.numerator)
    throw new Error("single shot exact endpoint mapping required");
  const style = r.read(policy.style_ref, EditCaptionStyleV1Schema);
  for (const ref of [video, audio.media_ref, policy.caption_ref, policy.style_ref, style.font_ref])
    setSlot(c, s, `edit_asset_${ref.content_digest.slice(0, 24)}`, ref);
  const zero = { numerator: 0, denominator: 1 };
  const clip = (item_id: string, source_ref: typeof video) => ({
    kind: "clip" as const,
    item_id,
    source_ref,
    source_in: zero,
    source_out: policy.duration,
    timeline_start: zero,
    timeline_end: policy.duration,
    frame_in: 0,
    frame_out: frames.index,
    effect_ids: [],
  });
  const edit = r.seal(
    c,
    "edit-decision",
    {
      schema_id: "penny.videogen-edit-decision.v1",
      schema_version: 1,
      canvas: { ...policy.canvas, audio_sample_rate: audio.sample_rate },
      tracks: [
        { track_id: "picture", kind: "video", order: 0, items: [clip("picture", video)] },
        {
          track_id: "narration",
          kind: "voice",
          order: 1,
          items: [
            { ...clip("narration", audio.media_ref), sample_in: 0, sample_out: samples.index },
          ],
        },
        {
          track_id: "captions",
          kind: "caption",
          order: 2,
          items: [
            {
              kind: "caption",
              item_id: "captions",
              text_source_ref: policy.caption_ref,
              language: "en",
              timeline_start: zero,
              timeline_end: policy.duration,
              style_ref: policy.style_ref,
            },
          ],
        },
      ],
      mix_buses: [],
      end_time: policy.duration,
      cut_boundaries: [],
      effect_registry_refs: [],
      source_dependency_ledger_ref: slot(s, "L"),
      decision_notes_ref: policy.notes_ref,
      audio_policy: "strip_source_audio",
    },
    [video, slot(s, `audio_source-${policy.voice_asset_id}`), policy.caption_ref, policy.style_ref],
    EditDecisionV1Schema
  );
  setSlot(c, s, stage === "animatic" ? "animatic_edit" : "rough_edit_template", edit);
}
