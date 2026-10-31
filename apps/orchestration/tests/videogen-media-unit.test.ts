import { describe, expect, it } from "vitest";
import { canonicalJson } from "../dist/canonical-json.js";
import {
  parseMediaJson,
  RawMediaDecodeRequestV1Schema,
  validateMediaPolicy,
  validateMediaRequest,
  validateMediaSelection,
} from "../dist/videogen/media-contracts.js";
import {
  canonicalPcmWav,
  inspectCanonicalPcmWav,
  inspectStrictAvcMp4,
  measurePcm16,
  selectMediaFrames,
} from "../dist/videogen/media-decode.js";
import { checkVoiceOnlyProductionAudio } from "../dist/videogen/audio-sources.js";
import {
  MEDIA_LIMITS,
  MEDIA_POLICY,
  MEDIA_SELECTION,
  MediaFixture,
  pcmAsset,
} from "./helpers/videogen-media-fixtures.js";

describe("bounded media raw primitives (deterministic, no external programs)", () => {
  it("validates canonical closed JSON before execution and rejects duplicate keys, size, shape, spans and policy drift", () => {
    using f = new MediaFixture();
    const r = f.request(pcmAsset());
    expect(
      validateMediaRequest(
        parseMediaJson(RawMediaDecodeRequestV1Schema, Buffer.from(canonicalJson(r)), MEDIA_LIMITS),
        MEDIA_POLICY
      )
    ).toEqual(r);
    for (const text of [
      canonicalJson(r).replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
      ` ${canonicalJson(r)}`,
      "[]",
      "{",
      "\ufffd",
    ])
      expect(() =>
        parseMediaJson(RawMediaDecodeRequestV1Schema, Buffer.from(text), MEDIA_LIMITS)
      ).toThrow();
    expect(() =>
      parseMediaJson(RawMediaDecodeRequestV1Schema, Buffer.alloc(100), {
        ...MEDIA_LIMITS,
        max_json_bytes: 99,
      })
    ).toThrow(/byte limit/);
    expect(() => validateMediaRequest({ ...r, command: "anything" }, MEDIA_POLICY)).toThrow();
    for (const spans of [
      [],
      [{ start: { numerator: -1, denominator: 1 }, end: { numerator: 1, denominator: 1 } }],
      [{ start: { numerator: 1, denominator: 1 }, end: { numerator: 1, denominator: 1 } }],
      [...r.required_spans, ...r.required_spans],
    ])
      expect(() => validateMediaRequest({ ...r, required_spans: spans }, MEDIA_POLICY)).toThrow();
    expect(validateMediaSelection(MEDIA_SELECTION, MEDIA_POLICY)).toEqual(MEDIA_SELECTION);
    for (const timepoints of [
      [{ numerator: 2, denominator: 2 }],
      [{ numerator: -1, denominator: 1 }],
      [{ numerator: 99, denominator: 1 }],
      [
        { numerator: 0, denominator: 1 },
        { numerator: 0, denominator: 1 },
      ],
    ])
      expect(() =>
        validateMediaSelection({ ...MEDIA_SELECTION, timepoints }, MEDIA_POLICY)
      ).toThrow();
    expect(() => validateMediaPolicy({ ...MEDIA_POLICY, cpu_seconds: 0 })).toThrow();
    expect(() =>
      validateMediaPolicy({ ...MEDIA_POLICY, inactivity_ms: MEDIA_POLICY.max_elapsed_ms + 1 })
    ).toThrow();
  });
  it("measures actual signed PCM samples, including silence and negative full scale; never claims speech", () => {
    const data = Buffer.alloc(8);
    [-32768, -1, 0, 32767].forEach((x, i) => data.writeInt16LE(x, i * 2));
    expect(measurePcm16(data)).toEqual({ peak_abs_s16: 32768, sum_squares: "2147418114" });
    expect(measurePcm16(Buffer.alloc(4))).toEqual({ peak_abs_s16: 0, sum_squares: "0" });
    expect(() => measurePcm16(Buffer.alloc(3))).toThrow();
    expect(() => canonicalPcmWav(Buffer.alloc(3), 2, 8000)).toThrow();
    expect(checkVoiceOnlyProductionAudio([], MEDIA_LIMITS).production_admission).toBe("blocked");
  });
  it("rejects noncanonical WAV, metadata, oversized samples/rate and truncated representations", () => {
    const wav = pcmAsset();
    expect(inspectCanonicalPcmWav(wav, MEDIA_POLICY).samples).toBe(8000);
    const badFormat = Buffer.from(wav);
    badFormat.writeUInt16LE(3, 20);
    const badChannels = Buffer.from(wav);
    badChannels.writeUInt16LE(3, 22);
    const badRate = Buffer.from(wav);
    badRate.writeUInt32LE(1000000, 24);
    const badSize = Buffer.from(wav);
    badSize.writeUInt32LE(1, 40);
    for (const b of [
      badFormat,
      badChannels,
      badRate,
      badSize,
      wav.subarray(0, 43),
      Buffer.concat([wav, Buffer.from("LIST")]),
    ])
      expect(() => inspectCanonicalPcmWav(b, MEDIA_POLICY)).toThrow();
    expect(() => inspectCanonicalPcmWav(wav, { ...MEDIA_POLICY, max_samples: 7999 })).toThrow();
    expect(() => inspectStrictAvcMp4(wav, MEDIA_POLICY)).toThrow();
  });
  it("selects span endpoints and actual rational PTS, including nearest-even ties, bounded midpoints and out-of-span refusal", () => {
    const pts = [0, 1, 2, 3, 4].map((n) => ({ numerator: n, denominator: 1 }));
    const spans = [
      { start: { numerator: 1, denominator: 1 }, end: { numerator: 4, denominator: 1 } },
    ];
    expect(
      selectMediaFrames(
        pts,
        spans,
        { ...MEDIA_SELECTION, midpoint_count: 0, timepoints: [{ numerator: 3, denominator: 2 }] },
        4
      )
    ).toEqual([1, 2, 3]);
    expect(selectMediaFrames(pts, spans, MEDIA_SELECTION, 4)).toEqual([1, 2, 3]);
    expect(() => selectMediaFrames(pts, spans, MEDIA_SELECTION, 2)).toThrow(/frame limit/);
    expect(() =>
      selectMediaFrames(
        pts,
        spans,
        { ...MEDIA_SELECTION, timepoints: [{ numerator: 0, denominator: 1 }] },
        4
      )
    ).toThrow(/outside/);
  });
});
