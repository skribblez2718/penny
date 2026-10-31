import { readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { validateContract } from "../../dist/contracts.js";
import { ConfinedMediaRunner } from "../../dist/host-operations/confined-media-runner.js";
import { validateMp4Video } from "../../dist/mp4-media.js";
import { rationalTime } from "../../dist/videogen/rational-time.js";
import { inspectImportedAvc, normalizeImportedAvc } from "../../dist/videogen/avc-normalization.js";
import {
  decodeMediaBytes,
  inspectCanonicalPcmWav,
  inspectStrictAvcMp4,
  inspectImportAvcMp4,
  measurePcm16,
} from "../../dist/videogen/media-decode.js";
import {
  MEDIA_LIMITS,
  MEDIA_POLICY,
  MEDIA_SELECTION,
  MediaFixture,
  required,
  suppliedCpuBindings,
} from "./videogen-media-fixtures.js";

const pin = Type.Object(
  { path: Type.String(), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false }
);
const descriptor = Type.Object(
  {
    video: pin,
    audio: pin,
    expected: Type.Object(
      {
        width: Type.Integer({ minimum: 1, maximum: 512 }),
        height: Type.Integer({ minimum: 1, maximum: 512 }),
        frame_count: Type.Integer({ minimum: 1, maximum: 128 }),
        fps: Type.Integer({ minimum: 1, maximum: 60 }),
        max_bytes: Type.Integer({ minimum: 1, maximum: 16777216 }),
      },
      { additionalProperties: false }
    ),
    audio_samples: Type.Integer({ minimum: 1, maximum: 1000000 }),
    audio_rate: Type.Integer({ minimum: 1, maximum: 48000 }),
    report: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
/** Optional explicit PRIVATE cohort inside the existing opt-in CPU suite. No private input,
 * hash, path or job identity is checked into the repository; no API/model work is performed. */
export function registerAvcImportCpuTests(): void {
  const supplied = process.env["VIDEOGEN_MEDIA_IMPORT_FIXTURE"];
  if (supplied === undefined) return;
  const config = validateContract(descriptor, JSON.parse(supplied), "private import cohort");
  const read = (pin: { path: string; sha256: string }): Buffer => {
    const bytes = readFileSync(pin.path);
    if (bytes.length > config.expected.max_bytes || sha256(bytes) !== pin.sha256)
      throw new Error("private cohort pin mismatch");
    return bytes;
  };
  const policy = {
    ...MEDIA_POLICY,
    max_width: 512,
    max_height: 512,
    max_pixels: 262144,
    max_frames: 128,
    max_samples: 1000000,
    max_sample_rate: 48000,
    max_duration: { numerator: 8, denominator: 1 },
    max_decoded_bytes: 67108864,
    max_output_bytes: 16777216,
    max_elapsed_ms: 60000,
  };
  describe("explicit private API-output import compatibility (not a film approval)", () => {
    it("inspects exact raw bytes, fully CPU-decodes all pictures, normalizes with visible lossy delta, and admits canonical bytes through the real owner", async () => {
      using f = new MediaFixture(policy);
      const raw = read(config.video),
        runner = new ConfinedMediaRunner(suppliedCpuBindings(f.root).bindings);
      expect(validateMp4Video(raw, config.expected)).toMatchObject({
        status: "valid",
        metadata: {
          width: config.expected.width,
          height: config.expected.height,
          frame_count: config.expected.frame_count,
        },
      });
      expect(() => inspectStrictAvcMp4(raw, policy)).toThrow();
      const layout = inspectImportedAvc(raw, policy, config.expected);
      expect(layout.pts).toHaveLength(config.expected.frame_count);
      const normalized = await normalizeImportedAvc({
        runner,
        bytes: raw,
        policy,
        expected: config.expected,
        signal: new AbortController().signal,
      });
      expect(normalized.receipt).toMatchObject({
        raw_sha256: sha256(raw),
        normalized_sha256: sha256(normalized.bytes),
        lossless: false,
        byte_equal: false,
        decoded_frame_count: config.expected.frame_count,
      });
      expect(inspectStrictAvcMp4(normalized.bytes, policy).nal_length).toBe(4);
      const request = f.request(normalized.bytes, "video/mp4", [
        {
          start: { numerator: 0, denominator: 1 },
          end: { numerator: config.expected.frame_count, denominator: config.expected.fps },
        },
      ]);
      await f.owner(f.adapter(runner)).dispatch(f.engine, f.prepare(request));
      const record = required(f.checkpointer.hostOperationCallsForRun(f.run_id)[0]);
      expect(record.disposition?.outcome).toBe("completed");
      const evidence = f.evidence().materialize(record.operation_record_id);
      expect(evidence.production_admission).toBe("blocked");
      if (config.report)
        writeFileSync(
          config.report,
          canonicalJson({
            normalization: normalized.receipt,
            owner_operation_id: record.operation_record_id,
            raw_decode_ref: record.operation_result_ref,
            video_evidence_ref: evidence.video_evidence_ref,
            scope:
              "fixture-protocol owner; actual supplied media and confined CPU; no human approval or API job custody claim",
          }),
          { mode: 0o600 }
        );
    }, 120000);
    it("refuses unknown metadata, colour drift, retiming, wrong requested count/dimensions and actual coded corruption", async () => {
      const raw = read(config.video);
      const unknown = Buffer.alloc(8);
      unknown.writeUInt32BE(8);
      unknown.write("uuid", 4);
      expect(() =>
        inspectImportedAvc(Buffer.concat([raw, unknown]), policy, config.expected)
      ).toThrow();
      expect(() =>
        inspectImportedAvc(raw, policy, {
          ...config.expected,
          frame_count: config.expected.frame_count + 1,
        })
      ).toThrow();
      expect(() =>
        inspectImportedAvc(raw, policy, { ...config.expected, width: config.expected.width + 2 })
      ).toThrow();
      const colr = raw.indexOf(Buffer.from("colr")),
        ctts = raw.indexOf(Buffer.from("ctts"));
      expect(colr).toBeGreaterThan(0);
      expect(ctts).toBeGreaterThan(0);
      const color = Buffer.from(raw);
      color[colr + 10] = 255;
      expect(() => inspectImportedAvc(color, policy, config.expected)).toThrow();
      const timing = Buffer.from(raw);
      timing.writeUInt32BE(1, ctts + 16);
      expect(() => inspectImportedAvc(timing, policy, config.expected)).toThrow();
      for (const [marker, delta, value] of [
        ["avcC", 5, 244], // unsupported codec profile, not a broad codec allowlist
        ["elst", 16, 255], // negative/invalid edit offset
        ["data", 12, 255], // invalid UTF-8 in prompt metadata
      ] as const) {
        const offset = raw.indexOf(Buffer.from(marker));
        expect(offset).toBeGreaterThan(0);
        const changed = Buffer.from(raw);
        changed[offset + delta] = value;
        expect(() => inspectImportedAvc(changed, policy, config.expected)).toThrow();
      }
      const uuid = raw.indexOf(Buffer.from("dc45e9bde6d948b7962cd820d923eeef", "hex"));
      expect(uuid).toBeGreaterThan(0);
      const sei = Buffer.from(raw);
      sei[uuid] = 0;
      expect(() => inspectImportedAvc(sei, policy, config.expected)).toThrow();
      const corrupt = Buffer.from(raw);
      const imported = inspectImportAvcMp4(corrupt, policy);
      const media = required(imported.media_ranges[0]);
      let at = media.payload,
        changed = false;
      while (at < media.end) {
        const size = corrupt.readUIntBE(at, imported.nal_length);
        at += imported.nal_length;
        if (((corrupt[at] ?? 0) & 31) === 5) {
          corrupt.fill(255, at + 1, at + size);
          changed = true;
          break;
        }
        at += size;
      }
      expect(changed).toBe(true);
      expect(inspectImportedAvc(corrupt, policy, config.expected).metadata.frame_count).toBe(
        config.expected.frame_count
      );
      using f = new MediaFixture(policy);
      await expect(
        normalizeImportedAvc({
          runner: new ConfinedMediaRunner(suppliedCpuBindings(f.root).bindings),
          bytes: corrupt,
          policy,
          expected: config.expected,
          signal: new AbortController().signal,
        })
      ).rejects.toThrow();
    });
    it("actually decodes the complete supplied job WAV and measures PCM without asserting words, voice identity or intelligibility", async () => {
      using f = new MediaFixture(policy);
      const bytes = read(config.audio),
        source = inspectCanonicalPcmWav(bytes, policy);
      expect(source.samples).toBe(config.audio_samples);
      expect(source.sample_rate).toBe(config.audio_rate);
      const result = await decodeMediaBytes({
        runner: new ConfinedMediaRunner(suppliedCpuBindings(f.root).bindings),
        bytes,
        policy,
        request: f.request(bytes, "audio/wav", [
          {
            start: { numerator: 0, denominator: 1 },
            end: rationalTime(BigInt(source.samples), BigInt(source.sample_rate)),
          },
        ]),
        selection: MEDIA_SELECTION,
        limits: MEDIA_LIMITS,
        signal: new AbortController().signal,
      });
      const audio = required(result.result.audio),
        span = required(audio.spans[0]);
      expect(audio.decoded_sample_count).toBe(source.samples);
      expect(span).toMatchObject(measurePcm16(source.data));
      expect(span.peak_abs_s16).toBeGreaterThan(0);
      expect(required(result.outputs[0]).bytes).toEqual(bytes);
      if (config.report)
        writeFileSync(
          config.report + ".audio.json",
          canonicalJson({
            sha256: sha256(bytes),
            bytes: bytes.length,
            sample_rate: source.sample_rate,
            samples: source.samples,
            duration_seconds: source.samples / source.sample_rate,
            ...measurePcm16(source.data),
            rms_s16: Math.sqrt(Number(span.sum_squares) / source.samples),
            qualification:
              "actual_complete_pcm_decode_measurement_not_words_identity_intelligibility_or_alignment",
          }),
          { mode: 0o600 }
        );
    });
  });
}
