import { Checkpointer } from "../dist/checkpointer.js";
import { AudioSourceDecodeCustody } from "../dist/videogen/audio-sources.js";
import { MEDIA_POLICY } from "./helpers/videogen-media-fixtures.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactStore,
  previewArtifactRef,
  type PersistArtifactInput,
} from "../dist/artifact-store.js";
import { canonicalJson } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { readSemantic } from "../dist/videogen/bounds.js";
import {
  AudioSourceV1Schema,
  checkVoiceOnlyProductionAudio,
  inspectCapturedAudioSource,
  prepareAudioSourceCapture,
} from "../dist/videogen/audio-sources.js";
import { RightsBindingV1Schema, type CrossRunEdgeV1 } from "../dist/videogen/rights-ledger.js";
import {
  FoundationFixture,
  FOUNDATION_LIMITS as limits,
} from "./helpers/videogen-foundation-fixtures.js";
import {
  AudioAdmissionFixture,
  audioFixture,
  silentPcmFixture,
} from "./helpers/videogen-audio-fixtures.js";

// Malformed source fixtures remain unknown until the production parser validates them.
function operands(f: FoundationFixture, source: unknown, measurement_ref: ArtifactRef) {
  return { host: f.host(), source, measurement_ref, use: "source" as const };
}

describe("WP-012 exact-artifact real-store read-only admission slice", () => {
  it("round-trips captured canonical semantic bytes across a reopened project store, without writing or granting", () => {
    using f = new FoundationFixture();
    const a = audioFixture(f);
    using reopened = ArtifactStore.openExisting(path.join(f.root, "artifacts"), {
      projectId: f.project_id,
    });
    const persist = vi.spyOn(reopened, "persist");
    const select = vi.spyOn(reopened, "select");
    const host = { ...f.host(), store: reopened };
    expect(
      readSemantic({
        ...host,
        ref: a.source_ref,
        schema: AudioSourceV1Schema,
        schema_id: a.source.schema_id,
      })
    ).toEqual(a.source);
    expect(reopened.read(a.source_ref).toString("utf8")).toBe(canonicalJson(a.source));
    expect(
      inspectCapturedAudioSource({
        host,
        source_ref: a.source_ref,
        measurement_ref: a.measurement_ref,
        use: "edit",
      })
    ).toMatchObject({
      status: "protocol_checked",
      source: a.source,
      measurement: a.measurement,
      source_ref: a.source_ref,
      measurement_ref: a.measurement_ref,
      effect_permission: "none",
      production_admission: "blocked",
      unverified: [
        "decode_receipt_authority",
        "capture_journal_order",
        "speech_playback_and_timing",
      ],
    });
    expect(persist).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(checkVoiceOnlyProductionAudio([a.source], limits).production_admission).toBe("blocked");
    // Prove this is deliberately silent fixture content, not an asserted real decode/playback.
    expect(
      reopened
        .read(a.source.media_ref)
        .subarray(44)
        .every((byte) => byte === 0)
    ).toBe(true);
  });
  it("refuses missing/future receipt operands at capture; later bytes cannot retroactively certify journal ordering", () => {
    using f = new FoundationFixture();
    const a = audioFixture(f);
    const receiptInput = {
      metadata: {
        schema_version: 2,
        run_id: f.run_id,
        phase: "audio_future_fixture",
        branch_id: null,
        kind: "videogen-fixture",
        operation_id: "future_decode_fixture",
        version: 1,
        producer: "host:videogen-fixture",
        media_type: "application/json",
        parent_ref: null,
        upstream_refs: [],
        content_schema: { schema_id: "penny.host-operation-receipt.v1", schema_version: 1 },
      },
      content: canonicalJson(a.receipt),
    } satisfies PersistArtifactInput;
    const future = previewArtifactRef(receiptInput);
    const source = { ...a.source, decoded_audio_ref: future };
    const measurementRef = f.json(
      { ...a.measurement, decode_receipt_ref: future },
      a.measurement.schema_id
    );
    expect(prepareAudioSourceCapture(operands(f, source, measurementRef))).toMatchObject({
      status: "refused",
      reason: "captured_media_or_decode_drift",
    });
    f.store.persist(receiptInput);
    // Existence now is not evidence that an earlier source capture was valid. Always blocked.
    const result = prepareAudioSourceCapture(operands(f, source, measurementRef));
    expect(result).toMatchObject({ status: "protocol_checked", production_admission: "blocked" });
    if (result.status !== "protocol_checked") throw new Error("fixture protocol refused");
    expect(result.unverified).toContain("capture_journal_order");
  });
  it("refuses media/decoded fact/codec/receipt/provenance drift and wrong semantic operands", () => {
    using f = new FoundationFixture();
    const a = audioFixture(f);
    for (const source of [
      { ...a.source, duration: { numerator: 2, denominator: 1 } },
      { ...a.source, sample_rate: { numerator: 16000, denominator: 1 } },
      { ...a.source, channels: "stereo" as const },
      { ...a.source, media_ref: f.opaque("not audio", "audio/wav") },
      { ...a.source, provenance_ref: f.opaque("unrelated") },
      { ...a.source, decoded_audio_ref: a.source_ref },
    ])
      expect(prepareAudioSourceCapture(operands(f, source, a.measurement_ref)).status).toBe(
        "refused"
      );
    for (const patch of [
      { source_ref: a.source_ref },
      { decode_receipt_ref: a.source_ref },
      { decoded_sample_count: 7999 },
      { sample_rate: { numerator: 16000, denominator: 1 } },
      { channels: "stereo" },
      { track_codecs: ["aac"] },
      { source_track_ids: ["one", "two"], track_codecs: ["canonical_pcm", "canonical_pcm"] },
    ]) {
      const ref = f.json({ ...a.measurement, ...patch }, a.measurement.schema_id);
      expect(prepareAudioSourceCapture(operands(f, a.source, ref))).toMatchObject({
        status: "refused",
        reason: "captured_media_or_decode_drift",
      });
    }
    for (const patch of [
      { operation_kind: "voice_job" },
      { identity: { ...a.receipt.identity, run_id: "wrong_run" } },
      { ended_at: "2025-01-01T00:00:00Z" },
      { ended_at: "2026-10-14T00:00:00Z" },
      { decode_verified: true },
    ]) {
      const ref = f.json({ ...a.receipt, ...patch }, "penny.host-operation-receipt.v1");
      const measurementRef = f.json(
        { ...a.measurement, decode_receipt_ref: ref },
        a.measurement.schema_id
      );
      expect(
        prepareAudioSourceCapture(
          operands(f, { ...a.source, decoded_audio_ref: ref }, measurementRef)
        )
      ).toMatchObject({ status: "refused", reason: "captured_media_or_decode_drift" });
    }
    // A later timing or self-source artifact is never a decode receipt, even if it exists.
    const timing = f.json(
      { schema_id: "penny.videogen-timing.v1", schema_version: 1 },
      "penny.videogen-timing.v1"
    );
    const measurementRef = f.json(
      { ...a.measurement, decode_receipt_ref: timing },
      a.measurement.schema_id
    );
    expect(
      prepareAudioSourceCapture(
        operands(f, { ...a.source, decoded_audio_ref: timing }, measurementRef)
      )
    ).toMatchObject({ status: "refused", reason: "invalid_input" });
  });
  it("refuses empty or unsupported captured containers even with matching current rights and measurements", () => {
    using f = new FoundationFixture();
    const a = audioFixture(f);
    const consent = a.source.consent_ref;
    if (consent === undefined) throw new Error("fixture consent missing");
    for (const media of [
      f.raw(Buffer.alloc(0), "audio/wav"),
      f.raw(silentPcmFixture(), "audio/mpeg"),
    ]) {
      const rightsRef = f.rights(media, "voice", [consent]);
      const rights = readSemantic({
        ...f.host(),
        ref: rightsRef,
        schema: RightsBindingV1Schema,
        schema_id: "penny.videogen-rights-binding.v1",
      });
      const source = {
        ...a.source,
        media_ref: media,
        rights_ref: rightsRef,
        provenance_ref: rights.provenance_ref,
      };
      const measurementRef = f.json(
        { ...a.measurement, source_ref: media },
        a.measurement.schema_id
      );
      expect(prepareAudioSourceCapture(operands(f, source, measurementRef))).toMatchObject({
        status: "refused",
        reason: "captured_media_or_decode_drift",
      });
    }
  });
  it("reuses exact host-current rights, consent membership, expiry, territory, scope and revocation", () => {
    using f = new FoundationFixture();
    const a = audioFixture(f);
    const input = operands(f, a.source, a.measurement_ref);
    const current = f.current_rights.find(
      (right) => right.subject_ref.artifact_id === a.source.media_ref.artifact_id
    );
    if (current === undefined) throw new Error("fixture rights missing");
    for (const host of [
      { ...f.host(), current_rights: [] },
      { ...f.host(), current_rights: [{ ...current, status: "revoked" as const }] },
      { ...f.host(), current_rights: [{ ...current, revision: 2 }] },
      { ...f.host(), now_utc: "2027-01-01T00:00:00Z" },
      { ...f.host(), territory: "other-territory" },
      { ...f.host(), current_rights: [], approved: true, consent_verified: true },
    ])
      expect(prepareAudioSourceCapture({ ...input, host })).toMatchObject({
        status: "refused",
        reason: "rights_or_consent",
      });
    const consentMismatch = { ...a.source, consent_ref: f.opaque("unselected consent") };
    expect(prepareAudioSourceCapture({ ...input, source: consentMismatch })).toMatchObject({
      status: "refused",
      reason: "rights_or_consent",
    });
    const rightsRef = f.json({ ...a.rights, allowed_uses: ["source"] }, a.rights.schema_id);
    expect(
      prepareAudioSourceCapture({
        ...input,
        source: { ...a.source, rights_ref: rightsRef },
        host: { ...f.host(), current_rights: [{ ...current, rights_ref: rightsRef }] },
        use: "deliver",
      })
    ).toMatchObject({ status: "refused", reason: "rights_or_consent" });
    expect(
      prepareAudioSourceCapture({
        source: a.source,
        measurement_ref: a.measurement_ref,
        use: "source",
      })
    ).toMatchObject({ status: "refused", reason: "missing_host" });
  });
  it("requires an exact authorized cross-run media edge and rejects another project partition", () => {
    using f = new FoundationFixture();
    using other = new FoundationFixture();
    const a = audioFixture(f, "public_licensed", "upstream_audio_run");
    const input = operands(f, a.source, a.measurement_ref);
    expect(prepareAudioSourceCapture(input)).toMatchObject({
      status: "refused",
      reason: "rights_or_consent",
    });
    const edge: CrossRunEdgeV1 = {
      schema_id: "penny.videogen-cross-run-edge.v1",
      schema_version: 1,
      project_id: f.project_id,
      consumer_run_id: f.run_id,
      source_ref: a.source.media_ref,
      rights_ref: a.source.rights_ref,
      provenance_ref: a.source.provenance_ref,
      authorization_ref: f.opaque("fixture authorized cross-run edge"),
    };
    expect(
      prepareAudioSourceCapture({ ...input, host: { ...f.host(), cross_run_edges: [edge] } }).status
    ).toBe("protocol_checked");
    for (const bad of [
      { ...edge, consumer_run_id: "other_run" },
      { ...edge, provenance_ref: a.source_ref },
      { ...edge, source_ref: { ...a.source.media_ref, operation_id: "swapped" } },
    ])
      expect(
        prepareAudioSourceCapture({ ...input, host: { ...f.host(), cross_run_edges: [bad] } })
          .status
      ).toBe("refused");
    expect(
      prepareAudioSourceCapture({
        ...input,
        host: { ...f.host(), project_id: `prj_${"9".repeat(32)}`, cross_run_edges: [edge] },
      }).status
    ).toBe("refused");
    expect(
      prepareAudioSourceCapture({
        ...input,
        host: { ...f.host(), store: other.store, cross_run_edges: [edge] },
      }).status
    ).toBe("refused");
  });
  it("refuses altered exact manifest refs, duplicate-key/noncanonical JSON and non-current source wrappers", () => {
    using f = new FoundationFixture();
    const a = audioFixture(f);
    const input = {
      host: f.host(),
      source_ref: a.source_ref,
      measurement_ref: a.measurement_ref,
      use: "source" as const,
    };
    for (const patch of [
      { operation_id: "other_operation" },
      { producer: "worker:invented" },
      { byte_length: a.source_ref.byte_length + 1 },
      { run_id: "another_run" },
      { artifact_id: `art_${"f".repeat(64)}` },
      { content_digest: "f".repeat(64) },
    ])
      expect(
        inspectCapturedAudioSource({ ...input, source_ref: { ...a.source_ref, ...patch } }).status
      ).toBe("refused");
    const duplicate = canonicalJson(a.source).replace(
      '"schema_version":1',
      '"schema_version":1,"schema_version":1'
    );
    for (const text of [
      duplicate,
      ` ${canonicalJson(a.source)}`,
      "{bad json",
      Buffer.from([0xff]),
    ]) {
      const ref = f.raw(text, "application/json", a.source.schema_id);
      expect(inspectCapturedAudioSource({ ...input, source_ref: ref })).toMatchObject({
        status: "refused",
        reason: "invalid_input",
      });
    }
    const wrongVersion = {
      ...a.source_ref,
      content_schema: { schema_id: a.source.schema_id, schema_version: 2 },
    };
    expect(inspectCapturedAudioSource({ ...input, source_ref: wrongVersion }).status).toBe(
      "refused"
    );
    expect(
      prepareAudioSourceCapture({
        ...operands(f, a.source, a.measurement_ref),
        source: { ...a.source, captured: true, decode_verified: true },
      })
    ).toMatchObject({ status: "refused", reason: "invalid_input" });
  });
  it("does not mislabel nonvoice subjects or provider IDs as registered rights/receipt authority", () => {
    using f = new FoundationFixture();
    const a = audioFixture(f);
    for (const role of ["music", "sfx", "ambience"])
      expect(
        prepareAudioSourceCapture({
          ...operands(f, a.source, a.measurement_ref),
          source: { ...a.source, role },
        })
      ).toMatchObject({ status: "refused", reason: "rights_or_consent" });
    const generator = audioFixture(f, "registered_generator");
    expect(
      prepareAudioSourceCapture(operands(f, generator.source, generator.measurement_ref))
    ).toMatchObject({
      status: "refused",
      reason: "unsupported_generator",
      production_admission: "blocked",
      effect_permission: "none",
    });
    const notVoiceRights = f.rights(a.source.media_ref, "image");
    // Select only the new binding; duplicated current subjects themselves fail closed in WP-003.
    const selected = f.current_rights.filter(
      (r) => r.rights_ref.artifact_id === notVoiceRights.artifact_id
    );
    expect(
      prepareAudioSourceCapture({
        ...operands(f, a.source, a.measurement_ref),
        source: { ...a.source, rights_ref: notVoiceRights },
        host: { ...f.host(), current_rights: selected },
      })
    ).toMatchObject({ status: "refused", reason: "rights_or_consent" });
  });
  it("keeps an honest machine-readable current-coverage fixture separate from any production claim", () => {
    const coverage: unknown = JSON.parse(
      readFileSync(
        new URL("./fixtures/videogen/audio-sources-current-coverage.v1.json", import.meta.url),
        "utf8"
      )
    );
    expect(coverage).toEqual({
      work_package: "VG-WP-012",
      acceptance: {
        "AC-036": "partial",
      },
      evidence_class:
        "provider-free source/plugin admission, settled-journal custody and canonical reopened-store readback",
      audio_fixture: "silent mono PCM WAV; constructed bytes, not decoded speech",
      source_admission: true,
      generator_service: false,
      production_decode: false,
      production_playback: false,
      operational_skill: false,
      gaps: [
        "gated effect-intent integration and capture wrapper journal milestone",
        "independently qualified decoder deployment",
        "retained source speech clearance and mix gain/QC",
        "audible intelligible correctly timed production speech",
      ],
    });
    expect(
      silentPcmFixture()
        .subarray(44)
        .every((byte) => byte === 0)
    ).toBe(true);
  });
});

describe("WP-012 canonical reopened-store source admission, not media qualification", () => {
  it("admits all four captured source kinds and all five roles using existing settled PCM custody", async () => {
    using f = new AudioAdmissionFixture();
    const capture = await f.captured();
    using store = ArtifactStore.openExisting(f.store.root, { projectId: f.project_id });
    using journal = Checkpointer.openExisting(f.checkpointer.dbPath, undefined, {
      projectId: f.project_id,
    });
    const persist = vi.spyOn(store, "persist");
    const select = vi.spyOn(store, "select");
    const transition = vi.spyOn(journal, "transitionHostOperationCall");
    for (const kind of [
      "voice_studio",
      "supplied",
      "public_licensed",
      "registered_generator",
    ] as const) {
      for (const role of ["dialogue", "narration", "music", "sfx", "ambience"] as const) {
        const a = f.source(capture, kind, role);
        const host = {
          ...f.host(store, journal),
          ...(kind === "registered_generator"
            ? { current_audio_provider_contracts: [f.provider(a.source).selection] }
            : {}),
        };
        const input = {
          host,
          source_ref: a.source_ref,
          measurement_ref: a.measurement_ref,
          use: "edit" as const,
        };
        expect(inspectCapturedAudioSource(input), `${kind}/${role}`).toMatchObject({
          status: "protocol_checked",
          source_admission: "admitted",
          source: a.source,
          measurement_ref: a.measurement_ref,
          production_admission: "blocked",
          effect_permission: "none",
          unverified: [
            "gated_effect_intent_integration",
            "capture_journal_order",
            "decoder_deployment_qualification",
            "speech_playback_and_timing",
          ],
        });
        expect(store.read(a.source_ref).toString("utf8")).toBe(canonicalJson(a.source));
        expect(inspectCapturedAudioSource(input)).toMatchObject({ source_admission: "admitted" });
      }
    }
    expect(persist).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(journal.hostOperationCallsForRun(f.run_id)).toHaveLength(1);
    expect(
      store
        .read(capture.media_ref)
        .subarray(44)
        .every((byte) => byte === 0)
    ).toBe(true);
  });
  it("requires original canonical project/journal capability and rejects shadow stores, policies and partitions", async () => {
    using f = new AudioAdmissionFixture();
    const a = f.source(await f.captured(), "public_licensed", "ambience");
    using shadow = ArtifactStore.provision(path.join(f.root, "shadow-audio"), {
      projectId: f.project_id,
    });
    expect(() => new AudioSourceDecodeCustody({ ...f.custodyBindings, store: shadow })).toThrow(
      /canonical/
    );
    using other = new AudioAdmissionFixture();
    const input = {
      host: f.host(),
      source: a.source,
      measurement_ref: a.measurement_ref,
      use: "source" as const,
    };
    expect(
      prepareAudioSourceCapture({
        ...input,
        host: {
          ...f.host(),
          audio_decode_custody: new AudioSourceDecodeCustody(other.custodyBindings),
        },
      }).status
    ).toBe("refused");
    const policy = f.json({ ...MEDIA_POLICY, max_samples: 7999 }, MEDIA_POLICY.schema_id);
    const custody = new AudioSourceDecodeCustody({ ...f.custodyBindings, policy_ref: policy });
    expect(
      prepareAudioSourceCapture({ ...input, host: { ...f.host(), audio_decode_custody: custody } })
    ).toMatchObject({ status: "refused", reason: "captured_media_or_decode_drift" });
    const wrong = new AudioSourceDecodeCustody({
      ...f.custodyBindings,
      registration_sha256: "f".repeat(64),
    });
    expect(
      prepareAudioSourceCapture({ ...input, host: { ...f.host(), audio_decode_custody: wrong } })
        .status
    ).toBe("refused");
  });
});
