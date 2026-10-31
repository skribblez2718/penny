import { describe, expect, it } from "vitest";
import {
  AudioSourceV1Schema,
  AudioMeasurementV1Schema,
  checkSourceClipAudioDisposition,
  checkVoiceOnlyProductionAudio,
  prepareAudioSourceCapture,
  validateAudioMeasurement,
  validateAudioSource,
} from "../dist/videogen/audio-sources.js";
import { validateFoundation } from "../dist/videogen/bounds.js";
import {
  FoundationFixture,
  FOUNDATION_LIMITS as limits,
} from "./helpers/videogen-foundation-fixtures.js";
import { audioFixture } from "./helpers/videogen-audio-fixtures.js";

describe("WP-012 closed AudioSourceV1 contract (not live audio)", () => {
  it("accepts exactly four source discriminators and all five stem roles; an unregistered generator refuses", () => {
    using f = new FoundationFixture();
    for (const kind of [
      "voice_studio",
      "supplied",
      "public_licensed",
      "registered_generator",
    ] as const) {
      const fixture = audioFixture(f, kind);
      for (const role of ["dialogue", "narration", "music", "sfx", "ambience"] as const)
        expect(validateAudioSource({ ...fixture.source, role }, limits)).toMatchObject({
          source_kind: kind,
          role,
        });
      expect(
        prepareAudioSourceCapture({
          host: f.host(),
          source: fixture.source,
          measurement_ref: fixture.measurement_ref,
          use: "source",
        })
      ).toMatchObject(
        kind === "registered_generator"
          ? { status: "refused", reason: "unsupported_generator" }
          : {
              status: "protocol_checked",
              source_admission: "unverified",
              production_admission: "blocked",
              effect_permission: "none",
            }
      );
    }
  });
  it("requires every normative captured field and rejects invented timing/receipt/self-source variants", () => {
    using f = new FoundationFixture();
    const { source, source_ref } = audioFixture(f);
    const timingRef = {
      ...source_ref,
      content_schema: { schema_id: "penny.videogen-timing.v1", schema_version: 1 },
    };
    for (const field of [
      "media_ref",
      "rights_ref",
      "consent_ref",
      "decoded_audio_ref",
      "provenance_ref",
    ]) {
      for (const ref of [source_ref, timingRef]) {
        const validation = () => validateAudioSource({ ...source, [field]: ref }, limits);
        if (field === "decoded_audio_ref") expect(validation).toThrow();
        else expect(validation).toThrow(/capture cannot depend/);
      }
    }
    for (const key of Object.keys(source).filter((key) => key !== "consent_ref")) {
      const missing: Record<string, unknown> = { ...source };
      delete missing[key];
      expect(() => validateAudioSource(missing, limits), key).toThrow();
    }
    for (const extra of [
      { source_id: "invented" },
      { timing_ref: source.media_ref },
      { script_ref: source.media_ref },
      { receipt_ref: source.decoded_audio_ref },
      { audio_source_ref: source.media_ref },
      { captured: true },
      { decoded: true },
      { rights_cleared: true },
      { source_admission: "admitted" },
      { registered_provider_id: "not_for_supplied" },
    ])
      expect(() => validateAudioSource({ ...source, ...extra }, limits)).toThrow();
    for (const bad of [
      { ...source, source_kind: "voice" },
      { ...source, source_kind: "other_registered" },
      { ...source, source_kind: "registered_generator" },
      { ...source, source_kind: "registered_generator", registered_provider_id: "" },
      { ...source, schema_version: 2 },
      { ...source, schema_id: "penny.audio-source.v1" },
      { ...source, role: "speech" },
      { ...source, codec: "aac" },
      { ...source, channels: 2 },
    ])
      expect(() => validateAudioSource(bad, limits)).toThrow();
  });
  it("rejects non-receipt decode refs at schema and semantic-validation boundaries", () => {
    using f = new FoundationFixture();
    const { source, measurement } = audioFixture(f);
    for (const ref of [
      source.media_ref,
      source.rights_ref,
      {
        ...source.decoded_audio_ref,
        content_schema: { schema_id: "penny.other-receipt.v1", schema_version: 1 },
      },
      {
        ...source.decoded_audio_ref,
        content_schema: { schema_id: "penny.host-operation-receipt.v1", schema_version: 2 },
      },
    ]) {
      const badSource = { ...source, decoded_audio_ref: ref };
      const badMeasurement = { ...measurement, decode_receipt_ref: ref };
      expect(() => validateFoundation(AudioSourceV1Schema, badSource, limits)).toThrow();
      expect(() => validateAudioSource(badSource, limits)).toThrow();
      expect(() => validateFoundation(AudioMeasurementV1Schema, badMeasurement, limits)).toThrow();
      expect(() => validateAudioMeasurement(badMeasurement, limits)).toThrow();
    }
    expect(validateAudioSource(source, limits).decoded_audio_ref).toEqual(source.decoded_audio_ref);
    expect(validateAudioMeasurement(measurement, limits).decode_receipt_ref).toEqual(
      measurement.decode_receipt_ref
    );
  });
  it("requires consent for performed speech including supplied/public voice and voice studio", () => {
    using f = new FoundationFixture();
    const { source } = audioFixture(f);
    const { consent_ref: _consent, ...without } = source;
    for (const kind of ["supplied", "public_licensed", "voice_studio"] as const)
      expect(() => validateAudioSource({ ...without, source_kind: kind }, limits)).toThrow();
    expect(() =>
      validateFoundation(AudioSourceV1Schema, { ...without, source_kind: "voice_studio" }, limits)
    ).toThrow();
    expect(validateAudioSource({ ...without, role: "music" }, limits).role).toBe("music");
  });
  it("bounds canonical rational times/rates, exact refs, JSON depth/bytes, unsafe integers and exotic inputs", () => {
    using f = new FoundationFixture();
    const { source } = audioFixture(f);
    for (const bad of [
      { ...source, placement: { numerator: -1, denominator: 1 } },
      { ...source, duration: { numerator: 0, denominator: 1 } },
      { ...source, duration: { numerator: 2, denominator: 2 } },
      { ...source, duration: { numerator: 1, denominator: 0 } },
      { ...source, sample_rate: { numerator: 16000, denominator: 2 } },
      { ...source, sample_rate: { numerator: 0, denominator: 1 } },
      { ...source, duration: { numerator: 1.5, denominator: 1 } },
      { ...source, placement: { numerator: Number.MAX_SAFE_INTEGER, denominator: 1 } },
      {
        ...source,
        media_ref: { ...source.media_ref, store_ref: `artifact://sha256/${"f".repeat(64)}` },
      },
      { ...source, media_ref: { ...source.media_ref, version: 0 } },
      { ...source, media_ref: { ...source.media_ref, byte_length: Number.MAX_SAFE_INTEGER + 1 } },
    ])
      expect(() => validateAudioSource(bad, limits)).toThrow();
    for (const policy of [
      { ...limits, max_depth: 1 },
      { ...limits, max_nodes: 1 },
      { ...limits, max_json_bytes: 64 },
      { ...limits, max_text_bytes: 16 },
    ])
      expect(() => validateAudioSource(source, policy)).toThrow();
    const cyclic: Record<string, unknown> = { ...source };
    cyclic["cycle"] = cyclic;
    expect(() => validateAudioSource(cyclic, limits)).toThrow();
    const getter = {
      ...source,
      get unexpected() {
        throw new Error("must not run");
      },
    };
    expect(() => validateAudioSource(getter, limits)).toThrow(/non-JSON properties/);
  });
  it("keeps decoded measurements closed and rejects ambiguous track/codec/line coverage", () => {
    using f = new FoundationFixture();
    const { measurement } = audioFixture(f);
    for (const bad of [
      { ...measurement, decoded_sample_count: 0 },
      { ...measurement, source_track_ids: [] },
      {
        ...measurement,
        source_track_ids: ["a", "a"],
        track_codecs: ["canonical_pcm", "canonical_pcm"],
      },
      { ...measurement, source_track_ids: ["a", "b"] },
      {
        ...measurement,
        measured_sync_offsets: [
          { line_id: "a", offset: { numerator: 0, denominator: 1 } },
          { line_id: "a", offset: { numerator: 0, denominator: 1 } },
        ],
      },
      {
        ...measurement,
        measured_sync_offsets: [{ line_id: "a", offset: { numerator: 2, denominator: 2 } }],
      },
      { ...measurement, intelligible: true },
      { ...measurement, audible: true },
      { ...measurement, timing_ref: measurement.source_ref },
    ])
      expect(() => validateAudioMeasurement(bad, limits)).toThrow();
  });
});

describe("WP-012 conservative source-clip disposition and voice-only policy", () => {
  it("requires explicit disposition and stripping before stems; never executes media mutation", () => {
    using f = new FoundationFixture();
    const { source, measurement } = audioFixture(f);
    const selection = {
      audio_policy: "strip_source_audio",
      source_measurements: [measurement],
      stems: [source],
    };
    expect(checkSourceClipAudioDisposition(selection, limits)).toEqual({
      status: "protocol_checked",
      required_action: "strip_before_stems",
    });
    for (const bad of [
      { ...selection, audio_policy: "auto" },
      { source_measurements: [measurement], stems: [source] },
      { ...selection, cleared: true },
      { ...selection, source_has_speech: false },
      { ...selection, source_measurements: [measurement, measurement] },
    ])
      expect(checkSourceClipAudioDisposition(bad, limits)).toEqual({
        status: "refused",
        reason: "invalid_input",
      });
  });
  it("prevents double speech under retain/mix and duplicate stems even when refs differ", () => {
    using f = new FoundationFixture();
    const { source, measurement } = audioFixture(f);
    for (const audio_policy of ["retain_as_sole_speech", "mix_with_stems"])
      expect(
        checkSourceClipAudioDisposition(
          { audio_policy, source_measurements: [measurement], stems: [source] },
          limits
        )
      ).toEqual({ status: "refused", reason: "duplicate_speech" });
    const alias = { ...source, media_ref: { ...source.media_ref, operation_id: "another_ref" } };
    expect(
      checkSourceClipAudioDisposition(
        { audio_policy: "strip_source_audio", source_measurements: [], stems: [source, alias] },
        limits
      )
    ).toEqual({ status: "refused", reason: "duplicate_speech" });
    expect(
      checkSourceClipAudioDisposition(
        { audio_policy: "retain_as_sole_speech", source_measurements: [measurement], stems: [] },
        limits
      )
    ).toEqual({ status: "blocked", reason: "source_speech_clearance_unverified" });
    expect(
      checkSourceClipAudioDisposition(
        { audio_policy: "retain_as_sole_speech", source_measurements: [], stems: [] },
        limits
      )
    ).toEqual({ status: "refused", reason: "invalid_input" });
    expect(
      checkSourceClipAudioDisposition(
        {
          audio_policy: "mix_with_stems",
          source_measurements: [measurement],
          stems: [{ ...source, role: "music" }],
        },
        limits
      )
    ).toEqual({ status: "blocked", reason: "mix_gain_and_qc_unverified" });
  });
  it("rejects nonvoice stems and absent/silent speech without pretending fixtures prove intelligibility", () => {
    using f = new FoundationFixture();
    const { source } = audioFixture(f);
    for (const role of ["music", "sfx", "ambience"])
      expect(checkVoiceOnlyProductionAudio([{ ...source, role }], limits)).toEqual({
        status: "refused",
        reason: "nonvoice_stem",
        production_admission: "blocked",
      });
    expect(checkVoiceOnlyProductionAudio([], limits)).toEqual({
      status: "refused",
      reason: "speech_required",
      production_admission: "blocked",
    });
    // The fixture has nonempty sample counts and a speech ROLE, but its PCM is all silence.
    expect(checkVoiceOnlyProductionAudio([source], limits)).toEqual({
      status: "blocked",
      reason: "speech_proof_missing",
      production_admission: "blocked",
    });
    expect(
      checkVoiceOnlyProductionAudio([{ ...source, intelligible: true, audible: true }], limits)
    ).toEqual({ status: "refused", reason: "invalid_input", production_admission: "blocked" });
  });
});
