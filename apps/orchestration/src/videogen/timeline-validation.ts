import { Type, type Static } from "typebox";
import { ArtifactRefSchema } from "../contracts.js";
import { OpaqueIdSchema as Id, assertUnique } from "../skill-contracts/common.js";
import { validateFoundation, type FoundationLimitsV1 } from "./bounds.js";
import {
  RationalTimeSchema,
  RationalRateSchema,
  validateRationalTime,
  validateRationalRate,
  compareTime,
  subtractTime,
  addTime,
  measuredDuration,
  quantizeBoundary,
  type RationalTime,
} from "./rational-time.js";
const closed = { additionalProperties: false } as const;
/** Host-internal measured source and base hard-cut timing slice. Not EditDecisionV1 or native editing. */
export const TimelineTimingV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-timeline-timing.v1"),
    schema_version: Type.Literal(1),
    fps: RationalRateSchema,
    sample_rate: RationalRateSchema,
    end_time: RationalTimeSchema,
    sources: Type.Array(
      Type.Object(
        {
          source_id: Id,
          ref: ArtifactRefSchema,
          measured_ticks: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          timebase: RationalTimeSchema,
          decoded_duration: RationalTimeSchema,
          source_frame_rate: RationalRateSchema,
        },
        closed
      )
    ),
    items: Type.Array(
      Type.Union([
        Type.Object(
          {
            kind: Type.Literal("clip"),
            item_id: Id,
            track_id: Id,
            source_id: Id,
            source_in: RationalTimeSchema,
            source_out: RationalTimeSchema,
            timeline_start: RationalTimeSchema,
            timeline_end: RationalTimeSchema,
          },
          closed
        ),
        Type.Object(
          {
            kind: Type.Literal("gap"),
            item_id: Id,
            track_id: Id,
            timeline_start: RationalTimeSchema,
            timeline_end: RationalTimeSchema,
          },
          closed
        ),
      ]),
      { minItems: 1 }
    ),
  },
  closed
);
export type TimelineTimingV1 = Static<typeof TimelineTimingV1Schema>;
export interface TimelineTimingPolicyV1 {
  readonly max_frames: number;
  readonly max_samples: number;
  readonly max_duration: RationalTime;
  readonly sync_tolerance: RationalTime;
}
/** Quantize absolute boundaries once. Explicit gaps required; no overlap, speed guessing or source-rate reinterpretation. */
export function validateTimelineTiming(
  value: unknown,
  limits: FoundationLimitsV1,
  policy: TimelineTimingPolicyV1
) {
  const v = validateFoundation(TimelineTimingV1Schema, value, limits);
  validateRationalRate(v.fps);
  validateRationalRate(v.sample_rate);
  validateRationalTime(v.end_time);
  validateRationalTime(policy.max_duration);
  validateRationalTime(policy.sync_tolerance);
  if (
    policy.sync_tolerance.numerator < 0 ||
    v.end_time.numerator <= 0 ||
    compareTime(v.end_time, policy.max_duration) > 0
  )
    throw new Error("timeline duration/sync policy");
  assertUnique(
    v.sources.map((x) => x.source_id),
    "source IDs"
  );
  assertUnique(
    v.items.map((x) => x.item_id),
    "global item IDs"
  );
  const sources = new Map(v.sources.map((x) => [x.source_id, x]));
  for (const source of v.sources) {
    validateRationalRate(source.source_frame_rate);
    validateRationalTime(source.decoded_duration);
    if (
      compareTime(
        measuredDuration(source.measured_ticks, source.timebase),
        source.decoded_duration
      ) !== 0
    )
      throw new Error("measured PTS duration mismatch");
  }
  const tracks = new Map<string, { time: RationalTime; frames: number; samples: number }>();
  const boundaries = v.items.map((item) => {
    validateRationalTime(item.timeline_start);
    validateRationalTime(item.timeline_end);
    if (
      item.timeline_start.numerator < 0 ||
      compareTime(item.timeline_start, item.timeline_end) >= 0 ||
      compareTime(item.timeline_end, v.end_time) > 0
    )
      throw new Error("invalid half-open edit span");
    const prior = tracks.get(item.track_id);
    const expectedStart = prior?.time ?? { numerator: 0, denominator: 1 };
    if (compareTime(item.timeline_start, expectedStart) !== 0)
      throw new Error("overlap or implicit gap");
    if (item.kind === "clip") {
      const source = sources.get(item.source_id);
      if (
        source === undefined ||
        item.source_in.numerator < 0 ||
        compareTime(item.source_in, item.source_out) >= 0 ||
        compareTime(item.source_out, source.decoded_duration) > 0 ||
        compareTime(
          subtractTime(item.source_out, item.source_in),
          subtractTime(item.timeline_end, item.timeline_start)
        ) !== 0
      )
        throw new Error("source trim/span mismatch or unsupported speed");
    }
    const startFrame = quantizeBoundary(item.timeline_start, v.fps, policy.max_frames);
    const endFrame = quantizeBoundary(item.timeline_end, v.fps, policy.max_frames);
    const startSample = quantizeBoundary(item.timeline_start, v.sample_rate, policy.max_samples);
    const endSample = quantizeBoundary(item.timeline_end, v.sample_rate, policy.max_samples);
    if (
      item.kind !== "gap" &&
      (endFrame.index <= startFrame.index || endSample.index <= startSample.index)
    )
      throw new Error("zero-length quantized non-gap");
    for (const residual of [
      startFrame.residual,
      endFrame.residual,
      startSample.residual,
      endSample.residual,
    ])
      if (
        compareTime(
          { numerator: Math.abs(residual.numerator), denominator: residual.denominator },
          policy.sync_tolerance
        ) > 0
      )
        throw new Error("declared sync tolerance exceeded");
    const frames = (prior?.frames ?? 0) + endFrame.index - startFrame.index;
    const samples = (prior?.samples ?? 0) + endSample.index - startSample.index;
    if (
      !Number.isSafeInteger(frames) ||
      !Number.isSafeInteger(samples) ||
      frames !== endFrame.index ||
      samples !== endSample.index
    )
      throw new Error("cumulative boundary drift");
    tracks.set(item.track_id, {
      time: addTime(expectedStart, subtractTime(item.timeline_end, item.timeline_start)),
      frames,
      samples,
    });
    return {
      item_id: item.item_id,
      frame_in: startFrame.index,
      frame_out: endFrame.index,
      sample_in: startSample.index,
      sample_out: endSample.index,
      frame_residuals: [startFrame.residual, endFrame.residual],
      sample_residuals: [startSample.residual, endSample.residual],
    };
  });
  const totalFrames = quantizeBoundary(v.end_time, v.fps, policy.max_frames).index;
  const totalSamples = quantizeBoundary(v.end_time, v.sample_rate, policy.max_samples).index;
  for (const track of tracks.values())
    if (
      compareTime(track.time, v.end_time) !== 0 ||
      Math.abs(track.frames - totalFrames) > 1 ||
      Math.abs(track.samples - totalSamples) > 1
    )
      throw new Error("track end/drift mismatch; explicit terminal gap required");
  return { timeline: v, boundaries, total_frames: totalFrames, total_samples: totalSamples };
}
