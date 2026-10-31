import { Type, type Static } from "typebox";
import { validateContract } from "../contracts.js";
const closed = { additionalProperties: false } as const;
const ms = Type.Integer({ minimum: 0, maximum: 86400000 });
export const PlaybackSampleSchema = Type.Object(
  {
    media_ms: ms,
    clock_ms: ms,
    eligible: Type.Boolean(),
    seeking: Type.Boolean(),
  },
  closed
);
export type PlaybackSample = Static<typeof PlaybackSampleSchema>;
/** Diagnostic consistency only. Client reports can be forged. This NEVER produces an approval,
 * a PlaybackReview, a complete_viewing answer, identity or authenticated human watch proof.
 * Kept self-contained so the exact function can also run in the read-only browser program. */
export function reviewPlaybackCoverage(
  samples: readonly PlaybackSample[],
  durationMs: number
): {
  covered_ms: number;
  excluded_intervals: number;
  ranges: { start_ms: number; end_ms: number }[];
} {
  const ranges: { start_ms: number; end_ms: number }[] = [];
  let excluded = 0;
  if (
    samples.length > 65536 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > 86400000
  )
    throw new Error("coverage bounds");
  for (let i = 0; i < samples.length; i++) {
    const b = samples[i];
    if (
      b === undefined ||
      !Number.isSafeInteger(b.media_ms) ||
      !Number.isSafeInteger(b.clock_ms) ||
      b.media_ms < 0 ||
      b.media_ms > durationMs ||
      b.clock_ms < 0 ||
      b.clock_ms > 86400000 ||
      typeof b.eligible !== "boolean" ||
      typeof b.seeking !== "boolean"
    )
      throw new Error("coverage sample bounds");
    const a = samples[i - 1];
    if (a === undefined) continue;
    const media = b.media_ms - a.media_ms,
      wall = b.clock_ms - a.clock_ms;
    if (
      !a.eligible ||
      !b.eligible ||
      a.seeking ||
      b.seeking ||
      media <= 0 ||
      wall <= 0 ||
      wall > 2000 ||
      Math.abs(media - wall) > 250
    ) {
      excluded++;
      continue;
    }
    ranges.push({ start_ms: a.media_ms, end_ms: b.media_ms });
  }
  ranges.sort((a, b) => a.start_ms - b.start_ms);
  const merged: { start_ms: number; end_ms: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start_ms <= last.end_ms)
      last.end_ms = Math.max(last.end_ms, range.end_ms);
    else merged.push({ ...range });
  }
  return {
    covered_ms: merged.reduce((n, r) => n + r.end_ms - r.start_ms, 0),
    excluded_intervals: excluded,
    ranges: merged,
  };
}
export function inspectReportedPlaybackCoverage(value: unknown, durationMs: number) {
  const samples = validateContract(
    Type.Array(PlaybackSampleSchema, { maxItems: 65536 }),
    value,
    "untrusted playback samples"
  );
  return {
    assurance: "untrusted_client_diagnostic_not_human_watch_proof" as const,
    ...reviewPlaybackCoverage(samples, durationMs),
  };
}
