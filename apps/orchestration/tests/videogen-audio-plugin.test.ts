import { AudioSourceDecodeCustody } from "../dist/videogen/audio-sources.js";
import { describe, expect, it, vi } from "vitest";
import {
  AudioProviderContractV1Schema,
  AudioRightsBindingV1Schema,
  validateAudioProviderContract,
} from "../dist/videogen/audio-source-admission.js";
import {
  prepareAudioSourceCapture,
  checkSourceClipAudioDisposition,
  checkVoiceOnlyProductionAudio,
} from "../dist/videogen/audio-sources.js";
import { readSemantic, validateFoundation } from "../dist/videogen/bounds.js";
import { AudioAdmissionFixture, fixtureDecodeReceipt } from "./helpers/videogen-audio-fixtures.js";
import { MEDIA_LIMITS as limits } from "./helpers/videogen-media-fixtures.js";

const use = "edit" as const;
describe("artifact-only host-selected audio provider admission (no generator service)", () => {
  it("requires a separately selected exact contract, never a provider ID, request authority or callback", async () => {
    using f = new AudioAdmissionFixture();
    const capture = await f.captured();
    const a = f.source(capture, "registered_generator", "music");
    const { selection } = f.provider(a.source);
    const input = { host: f.host(), source: a.source, measurement_ref: a.measurement_ref, use };
    expect(prepareAudioSourceCapture(input)).toMatchObject({
      status: "refused",
      reason: "unsupported_generator",
    });
    for (const source of [
      { ...a.source, approved: true },
      { ...a.source, provider_contract_ref: selection.contract_ref },
      { ...a.source, provider_contract: () => true },
    ])
      expect(prepareAudioSourceCapture({ ...input, source })).toMatchObject({
        status: "refused",
        reason: "invalid_input",
      });
    for (const current_audio_provider_contracts of [
      [{ ...selection, provider_id: "wrong-provider" }],
      [selection, selection],
      [{ ...selection, contract_ref: a.source_ref }],
      [{ ...selection, contract_ref: { ...selection.contract_ref, operation_id: "wrong" } }],
    ])
      expect(
        prepareAudioSourceCapture({
          ...input,
          host: { ...f.host(), current_audio_provider_contracts },
        })
      ).toMatchObject({ status: "refused", reason: "unsupported_generator" });
    expect(
      prepareAudioSourceCapture({
        ...input,
        host: { ...f.host(), current_audio_provider_contracts: [selection] },
      })
    ).toMatchObject({
      status: "protocol_checked",
      source_admission: "admitted",
      production_admission: "blocked",
      effect_permission: "none",
    });
    // Withdrawal is immediate, even though every artifact and provider ID is unchanged.
    expect(prepareAudioSourceCapture(input).status).toBe("refused");
  });
  it("checks closed role, use, meter/unit, codec, capture bytes/provenance, rate, channels, limits and lifetime", async () => {
    using f = new AudioAdmissionFixture();
    const a = f.source(await f.captured(), "registered_generator", "sfx");
    const { contract } = f.provider(a.source);
    for (const patch of [
      { provider_id: "wrong-provider" },
      { allowed_roles: ["music"] },
      { allowed_uses: ["source"] },
      {
        capture_meter: {
          meter: "stored_bytes",
          unit: "byte",
          limit: a.source.media_ref.byte_length - 1,
        },
      },
      { capture_meter: { meter: "gpu_milliseconds", unit: "byte", limit: 999999 } },
      { capture_meter: { meter: "stored_bytes", unit: "ms", limit: 999999 } },
      { capture_meter: { meter: "stored_bytes", unit: "byte", limit: -1 } },
      { capture_meter: { meter: "stored_bytes", unit: "byte", limit: 1.5 } },
      {
        capture_meter: { meter: "stored_bytes", unit: "byte", limit: Number.MAX_SAFE_INTEGER + 1 },
      },
      { codec: "aac" },
      { media_type: "audio/mpeg" },
      { media_producer: "host:other-provider" },
      { channels: ["stereo"] },
      { sample_rates: [{ numerator: 16000, denominator: 1 }] },
      { sample_rates: [{ numerator: 16000, denominator: 2 }] },
      { max_samples: 7999 },
      { max_duration: { numerator: 1, denominator: 2 } },
      { captured_outputs: [] },
      { captured_outputs: [{ media_ref: a.source_ref, provenance_ref: a.source.provenance_ref }] },
      {
        captured_outputs: [{ media_ref: a.source.media_ref, provenance_ref: a.source.rights_ref }],
      },
      { captured_outputs: [...contract.captured_outputs, ...contract.captured_outputs] },
      { valid_from_utc: "2027-01-01T00:00:00Z", expires_at_utc: "2028-01-01T00:00:00Z" },
      { expires_at_utc: "2026-01-02T00:00:00Z" },
      { approved: true },
    ]) {
      const ref = f.json({ ...contract, ...patch }, contract.schema_id);
      expect(
        prepareAudioSourceCapture({
          host: {
            ...f.host(),
            current_audio_provider_contracts: [
              { provider_id: contract.provider_id, contract_ref: ref },
            ],
          },
          source: a.source,
          measurement_ref: a.measurement_ref,
          use,
        }),
        JSON.stringify(patch)
      ).toMatchObject({ status: "refused", reason: "unsupported_generator" });
    }
    const changedCapture = { ...a.source, duration: { numerator: 1, denominator: 2 } };
    const { selection } = f.provider(changedCapture);
    expect(
      prepareAudioSourceCapture({
        host: { ...f.host(), current_audio_provider_contracts: [selection] },
        source: changedCapture,
        measurement_ref: a.measurement_ref,
        use,
      })
    ).toMatchObject({ status: "refused", reason: "captured_media_or_decode_drift" });
    expect(validateAudioProviderContract(contract, limits)).toEqual(contract);
    expect(validateFoundation(AudioProviderContractV1Schema, contract, limits)).toEqual(contract);
  });
  it("checks current nonvoice rights and consent for performed/cloned material, not merely a nonvoice label", async () => {
    using f = new AudioAdmissionFixture();
    const capture = await f.captured();
    for (const voiceUse of ["performed", "cloned"] as const) {
      const a = f.source(capture, "public_licensed", "music", voiceUse);
      const input = { host: f.host(), source: a.source, measurement_ref: a.measurement_ref, use };
      expect(prepareAudioSourceCapture(input)).toMatchObject({
        status: "protocol_checked",
        source_admission: "admitted",
      });
      const { consent_ref: _consent, ...missing } = a.source;
      for (const source of [
        missing,
        { ...a.source, consent_ref: f.raw("unselected consent", "text/plain") },
        { ...a.source, role: "ambience" },
        { ...a.source, provenance_ref: f.raw("unselected provenance", "text/plain") },
      ])
        expect(prepareAudioSourceCapture({ ...input, source })).toMatchObject({
          status: "refused",
          reason: "rights_or_consent",
        });
      for (const host of [
        { ...f.host(), current_rights: [] },
        {
          ...f.host(),
          current_rights: f.current_rights.map((r) => ({ ...r, status: "revoked" as const })),
        },
        { ...f.host(), current_rights: f.current_rights.map((r) => ({ ...r, revision: 2 })) },
        { ...f.host(), now_utc: "2027-01-01T00:00:00Z" },
        { ...f.host(), now_utc: "2025-01-01T00:00:00Z" },
        { ...f.host(), territory: "wrong-territory" },
      ])
        expect(prepareAudioSourceCapture({ ...input, host })).toMatchObject({
          status: "refused",
          reason: "rights_or_consent",
        });
      const rights = readSemantic({
        ...f.host(),
        ref: a.source.rights_ref,
        schema: AudioRightsBindingV1Schema,
        schema_id: "penny.videogen-audio-rights-binding.v1",
      });
      for (const patch of [
        { allowed_roles: ["ambience"] },
        { allowed_uses: ["source"] },
        { consent_refs: [] },
        { subject_ref: a.source_ref },
        { approved: true },
      ]) {
        const ref = f.json({ ...rights, ...patch }, rights.schema_id);
        expect(
          prepareAudioSourceCapture({
            ...input,
            host: {
              ...f.host(),
              current_rights: f.current_rights.map((r) => ({ ...r, rights_ref: ref })),
            },
            source: { ...a.source, rights_ref: ref },
          })
        ).toMatchObject({ status: "refused", reason: "rights_or_consent" });
      }
    }
  });
  it("does not promote orphan/mismatched receipts or wrappers, fake capabilities, or missing capture evidence", async () => {
    using f = new AudioAdmissionFixture();
    const a = f.source(await f.captured(), "supplied", "narration");
    const input = { host: f.host(), source: a.source, measurement_ref: a.measurement_ref, use };
    const receiptRef = f.json(fixtureDecodeReceipt(f.run_id), "penny.host-operation-receipt.v1");
    const orphanMeasurement = f.json(
      { ...a.measurement, decode_receipt_ref: receiptRef },
      a.measurement.schema_id
    );
    expect(
      prepareAudioSourceCapture({
        ...input,
        source: { ...a.source, decoded_audio_ref: receiptRef },
        measurement_ref: orphanMeasurement,
      })
    ).toMatchObject({ status: "refused", reason: "captured_media_or_decode_drift" });
    const copy = f.json(a.measurement, a.measurement.schema_id);
    expect(prepareAudioSourceCapture({ ...input, measurement_ref: copy })).toMatchObject({
      status: "refused",
      reason: "captured_media_or_decode_drift",
    });
    const forged: unknown = Object.create(AudioSourceDecodeCustody.prototype);
    const fakeHost: unknown = { ...f.host(), audio_decode_custody: { inspect: () => true } };
    // Keep malformed host input unknown; exercise the real public boundary without a type escape.
    expect(
      Reflect.apply(prepareAudioSourceCapture, undefined, [{ ...input, host: fakeHost }])
    ).toMatchObject({ status: "refused", reason: "captured_media_or_decode_drift" });
    expect(
      Reflect.apply(prepareAudioSourceCapture, undefined, [
        { ...input, host: { ...f.host(), audio_decode_custody: forged } },
      ])
    ).toMatchObject({ status: "refused", reason: "captured_media_or_decode_drift" });
    const persist = vi.spyOn(f.store, "persist");
    const refFor = vi.spyOn(f.store, "refFor").mockReturnValue(null);
    expect(prepareAudioSourceCapture(input)).toMatchObject({
      status: "refused",
      reason: "captured_media_or_decode_drift",
    });
    expect(persist).not.toHaveBeenCalled();
    refFor.mockRestore();
    const record = f.checkpointer.hostOperationCallsForRun(f.run_id)[0];
    if (!record) throw new Error("missing expected settled journal");
    const lookup = vi
      .spyOn(f.checkpointer, "hostOperationCall")
      .mockReturnValue({ ...record, lifecycle: "prepared" });
    expect(prepareAudioSourceCapture(input).status).toBe("refused");
    lookup.mockRestore();
    const { audio_decode_custody: _custody, ...onlyProtocol } = f.host();
    expect(prepareAudioSourceCapture({ ...input, host: onlyProtocol })).toMatchObject({
      status: "protocol_checked",
      source_admission: "unverified",
      production_admission: "blocked",
    });
  });
  it("retains duplicate embedded-speech/disposition and voice-only production refusals for admitted sources", async () => {
    using f = new AudioAdmissionFixture();
    const capture = await f.captured();
    const a = f.source(capture, "supplied", "dialogue");
    expect(
      prepareAudioSourceCapture({
        host: f.host(),
        source: a.source,
        measurement_ref: a.measurement_ref,
        use,
      })
    ).toMatchObject({ source_admission: "admitted" });
    for (const audio_policy of ["retain_as_sole_speech", "mix_with_stems"])
      expect(
        checkSourceClipAudioDisposition(
          { audio_policy, source_measurements: [a.measurement], stems: [a.source] },
          limits
        )
      ).toEqual({ status: "refused", reason: "duplicate_speech" });
    expect(
      checkSourceClipAudioDisposition(
        {
          audio_policy: "strip_source_audio",
          source_measurements: [],
          stems: [a.source, a.source],
        },
        limits
      )
    ).toEqual({ status: "refused", reason: "duplicate_speech" });
    expect(checkVoiceOnlyProductionAudio([a.source], limits)).toMatchObject({
      status: "blocked",
      reason: "speech_proof_missing",
      production_admission: "blocked",
    });
    const music = f.source(capture, "supplied", "music");
    expect(checkVoiceOnlyProductionAudio([music.source], limits)).toMatchObject({
      status: "refused",
      reason: "nonvoice_stem",
    });
  });
  it("reuses explicit cross-run rights edges for nonvoice sources, never mere possession", async () => {
    using f = new AudioAdmissionFixture();
    const a = f.source(await f.captured(), "public_licensed", "ambience");
    const host = { ...f.host(), run_id: "consumer-audio" };
    const input = { host, source: a.source, measurement_ref: a.measurement_ref, use };
    expect(prepareAudioSourceCapture(input)).toMatchObject({
      status: "refused",
      reason: "rights_or_consent",
    });
    const edge = {
      schema_id: "penny.videogen-cross-run-edge.v1",
      schema_version: 1,
      project_id: f.project_id,
      consumer_run_id: host.run_id,
      source_ref: a.source.media_ref,
      rights_ref: a.source.rights_ref,
      provenance_ref: a.source.provenance_ref,
      authorization_ref: f.raw("fixture cross-run authorization", "text/plain"),
    } as const;
    expect(
      prepareAudioSourceCapture({ ...input, host: { ...host, cross_run_edges: [edge] } })
    ).toMatchObject({ status: "protocol_checked", source_admission: "admitted" });
    for (const bad of [
      { ...edge, source_ref: a.source_ref },
      { ...edge, rights_ref: a.source_ref },
      { ...edge, provenance_ref: a.source_ref },
      { ...edge, consumer_run_id: "wrong" },
    ])
      expect(
        prepareAudioSourceCapture({ ...input, host: { ...host, cross_run_edges: [bad] } }).status
      ).toBe("refused");
  });
  it("rejects canonical byte/codec/sample drift after journal settlement without writing or decoding", async () => {
    using f = new AudioAdmissionFixture();
    const a = f.source(await f.captured(), "supplied", "sfx");
    const input = { host: f.host(), source: a.source, measurement_ref: a.measurement_ref, use };
    const original = f.store.read.bind(f.store);
    const persist = vi.spyOn(f.store, "persist");
    for (const mutate of [
      (bytes: Buffer) => {
        bytes.writeUInt16LE(3, 20);
      },
      (bytes: Buffer) => {
        bytes.writeUInt32LE(16000, 24);
        bytes.writeUInt32LE(32000, 28);
      },
      (bytes: Buffer) => {
        bytes.writeInt16LE(1, 44);
      },
      (bytes: Buffer) => {
        bytes.write("JUNK", 36);
      },
    ]) {
      const read = vi.spyOn(f.store, "read").mockImplementation((ref) => {
        const bytes = original(ref);
        if (ref.artifact_id === a.source.media_ref.artifact_id) mutate(bytes);
        return bytes;
      });
      expect(prepareAudioSourceCapture(input)).toMatchObject({
        status: "refused",
        reason: "captured_media_or_decode_drift",
      });
      expect(persist).not.toHaveBeenCalled();
      read.mockRestore();
    }
    expect(prepareAudioSourceCapture(input)).toMatchObject({ source_admission: "admitted" });
  });
});
