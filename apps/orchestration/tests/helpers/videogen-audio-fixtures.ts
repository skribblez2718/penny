import { rationalTime } from "../../dist/videogen/rational-time.js";
import { AudioSourceDecodeCustody } from "../../dist/videogen/audio-sources.js";
import { canonicalJson, sha256 } from "../../dist/canonical-json.js";
import { RunContext } from "../../dist/context.js";
import type { InvokeHostOperationDirectiveV1 } from "../../dist/contracts.js";
import { OrchestrationEngine } from "../../dist/engine.js";
import {
  hostOperationPolicyBinding,
  type HostOperationAdapterV1,
  type HostOperationDeclarationV1,
} from "../../dist/host-operations/contracts.js";
import {
  runtimeRegistrationSha256,
  skillContractSha256,
  type PlaybookRegistration,
} from "../../dist/playbooks/registry.js";
import { ReceiptAuthority } from "../../dist/receipts.js";
import {
  AudioRightsBindingV1Schema,
  validateAudioProviderContract,
  type AudioRightsBindingV1,
  type AudioSourceHostV1,
  type AudioProviderContractV1,
  type AudioProviderSelectionV1,
} from "../../dist/videogen/audio-source-admission.js";
import {
  RAW_MEDIA_REQUEST_CONTRACT,
  RAW_MEDIA_RESULT_CONTRACT,
  MEDIA_PCM_CONTRACT,
  type RawMediaDecodeRequestV1,
  type RawMediaDecodeResultV1,
} from "../../dist/videogen/media-contracts.js";
import { MediaEvidenceCustody } from "../../dist/videogen/media-evidence.js";
import { measurePcm16 } from "../../dist/videogen/media-decode.js";
import { AvOwnerFixture } from "./av-media-owner-fixture.js";
import { MEDIA_LIMITS, MEDIA_POLICY, required } from "./videogen-media-fixtures.js";
import {
  HostOperationReceiptV1Schema,
  validateHostOperationReceipt,
  type HostOperationReceiptV1,
} from "../../dist/host-operations/contracts.js";
import type { ArtifactRef } from "../../dist/contracts.js";
import { readSemantic, validateFoundation } from "../../dist/videogen/bounds.js";
import {
  RightsBindingV1Schema,
  validateRightsBinding,
  type CurrentRightsV1,
  type RightsBindingV1,
} from "../../dist/videogen/rights-ledger.js";
import {
  AudioMeasurementV1Schema,
  validateAudioMeasurement,
  validateAudioSource,
  type AudioMeasurementV1,
  type AudioSourceV1,
} from "../../dist/videogen/audio-sources.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./videogen-foundation-fixtures.js";

/** Deliberately SILENT mono PCM fixture. Construction only: no decoder, audition or speech proof. */
export function silentPcmFixture(): Buffer {
  const sampleRate = 8000;
  const sampleCount = 8000;
  const bytesPerSample = 2;
  const payloadBytes = sampleCount * bytesPerSample;
  const wav = Buffer.alloc(44 + payloadBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(payloadBytes, 40);
  return wav;
}
export interface AudioFixture {
  readonly source: AudioSourceV1;
  readonly source_ref: ArtifactRef;
  readonly measurement: AudioMeasurementV1;
  readonly measurement_ref: ArtifactRef;
  readonly receipt: HostOperationReceiptV1;
  readonly rights: RightsBindingV1 | AudioRightsBindingV1;
}
/** Receipt SHAPE only. It is not issued/signed by an owner and is never treated as decode authority. */
export function fixtureDecodeReceipt(
  runId: string,
  outputBytes = silentPcmFixture().length
): HostOperationReceiptV1 {
  return validateHostOperationReceipt({
    schema_version: 1,
    receipt_id: "fixture_decode_shape",
    operation_record_id: "fixture_decode_record",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: "fixture_session",
      playbook: "research",
      engine_owner: "typescript",
    },
    state_id: "fixture_capture",
    attempt: 1,
    operation_id: "fixture_decode",
    operation_kind: "media_decode_extract",
    registration_sha256: "1".repeat(64),
    request_sha256: "2".repeat(64),
    started_at: "2026-10-11T00:00:00Z",
    ended_at: "2026-10-11T00:00:01Z",
    progress_event_count: 0,
    poll_count: 0,
    request_bytes: 0,
    output_artifact_count: 1,
    output_bytes: outputBytes,
    result_sha256: null,
    remote_correlation_sha256: null,
    lease_disposition_receipt_id: "fixture_not_owner_custody",
    disposition: {
      outcome: "completed",
      remote_disposition: "none",
      lease_disposition: "released",
      retryable: false,
      reason_code: null,
    },
  });
}
export function audioFixture(
  f: FoundationFixture,
  sourceKind: AudioSourceV1["source_kind"] = "supplied",
  mediaRunId = f.run_id,
  canonicalFixtureWav: Uint8Array = silentPcmFixture()
): AudioFixture {
  const wav = Buffer.from(canonicalFixtureWav),
    reference = silentPcmFixture();
  const sampleCount = (wav.length - 44) / 2;
  // A bounded canonical tone may be longer than the default one-second fixture.
  reference.writeUInt32LE(wav.length - 8, 4);
  reference.writeUInt32LE(wav.length - 44, 40);
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 1 ||
    sampleCount > 24000 ||
    !wav.subarray(0, 44).equals(reference.subarray(0, 44))
  )
    throw new Error("bounded canonical 8 kHz mono PCM16 fixture required");
  const media = f.raw(wav, "audio/wav", undefined, mediaRunId);
  const consent = f.opaque("fixture consent text, not legal consent");
  const rightsRef = f.rights(media, "voice", [consent]);
  const rights = readSemantic({
    ...f.host(),
    ref: rightsRef,
    schema: RightsBindingV1Schema,
    schema_id: "penny.videogen-rights-binding.v1",
  });
  const receipt = fixtureDecodeReceipt(mediaRunId, wav.length);
  const receiptRef = f.json(receipt, "penny.host-operation-receipt.v1", mediaRunId);
  const measurement = validateAudioMeasurement(
    {
      schema_id: "penny.videogen-audio-measurement.v1",
      schema_version: 1,
      source_ref: media,
      source_track_ids: ["pcm_track"],
      track_codecs: ["canonical_pcm"],
      decoded_sample_count: sampleCount,
      sample_rate: { numerator: 8000, denominator: 1 },
      channels: "mono",
      measured_sync_offsets: [],
      decode_receipt_ref: receiptRef,
    },
    FOUNDATION_LIMITS
  );
  const measurementRef = f.json(measurement, measurement.schema_id);
  const source = validateAudioSource(
    {
      schema_id: "penny.videogen-audio-source.v1",
      schema_version: 1,
      source_kind: sourceKind,
      ...(sourceKind === "registered_generator"
        ? { registered_provider_id: "fixture_unregistered" }
        : {}),
      media_ref: media,
      rights_ref: rightsRef,
      consent_ref: consent,
      role: "narration",
      placement: { numerator: 0, denominator: 1 },
      duration: rationalTime(BigInt(sampleCount), 8000n),
      decoded_audio_ref: receiptRef,
      channels: "mono",
      sample_rate: measurement.sample_rate,
      codec: "canonical_pcm",
      provenance_ref: rights.provenance_ref,
    },
    FOUNDATION_LIMITS
  );
  const sourceRef = f.json(source, source.schema_id);
  return {
    source,
    source_ref: sourceRef,
    measurement,
    measurement_ref: measurementRef,
    receipt,
    rights,
  };
}

/** Canonical-store owner fixture. Only the existing owner executes a constructed raw-PCM
 * protocol adapter. This is NOT native decode, voice synthesis, playback or production. */
export class AudioAdmissionFixture implements Disposable {
  readonly base = new AvOwnerFixture();
  readonly store = this.base.store;
  readonly checkpointer = this.base.checkpointer;
  readonly project_id = this.base.project_id;
  readonly run_id = this.base.run_id;
  readonly root = this.base.root;
  readonly state_root = this.base.state_root;
  readonly current_rights: CurrentRightsV1[] = [];
  readonly policy_ref = this.base.json(MEDIA_POLICY, MEDIA_POLICY.schema_id);
  readonly declaration: HostOperationDeclarationV1 = {
    ...this.base.declaration,
    request: RAW_MEDIA_REQUEST_CONTRACT,
    result: RAW_MEDIA_RESULT_CONTRACT,
  };
  readonly registration: PlaybookRegistration = {
    ...this.base.registration,
    host_operations: { schema_version: 1, max_active_per_run: 1, declarations: [this.declaration] },
  };
  readonly engine = new OrchestrationEngine(this.checkpointer, {
    projectRoot: this.root,
    maxSteps: 20,
    receiptAuthority: ReceiptAuthority.createEphemeral(),
    artifactStore: this.store,
    artifactReader: this.store,
    artifactRevisions: this.store,
    playbookRegistration: this.registration,
  });
  raw = this.base.raw.bind(this.base);
  json = this.base.json.bind(this.base);
  readonly custodyBindings = {
    state_root: this.state_root,
    project_id: this.project_id,
    store: this.store,
    checkpointer: this.checkpointer,
    leases: this.base.leases,
    limits: MEDIA_LIMITS,
    declaration: this.declaration,
    registration_sha256: runtimeRegistrationSha256(this.registration),
    backend_key_sha256: this.base.backend,
    policy_ref: this.policy_ref,
  };
  host(store = this.store, checkpointer = this.checkpointer): AudioSourceHostV1 {
    return {
      store,
      project_id: this.project_id,
      run_id: this.run_id,
      limits: MEDIA_LIMITS,
      now_utc: new Date(Date.now() + 1000).toISOString(),
      territory: "test-territory",
      current_rights: this.current_rights,
      cross_run_edges: [],
      audio_decode_custody: new AudioSourceDecodeCustody({
        ...this.custodyBindings,
        store,
        checkpointer,
      }),
    };
  }
  async captured(): Promise<{
    media_ref: ArtifactRef;
    measurement_ref: ArtifactRef;
    receipt_ref: ArtifactRef;
    operation_record_id: string;
  }> {
    const request: RawMediaDecodeRequestV1 = {
      schema_id: "penny.videogen-raw-media-decode-request.v1",
      schema_version: 1,
      operation_id: "audio-fixture-operation",
      media_ref: this.raw(silentPcmFixture(), "audio/wav"),
      decode_policy_ref: this.policy_ref,
      frame_selection_ref: this.base.selection_ref,
      required_spans: [
        { start: { numerator: 0, denominator: 1 }, end: { numerator: 1, denominator: 1 } },
      ],
      audio_policy: "measure_pcm",
    };
    const requestRef = this.json(
      request,
      request.schema_id,
      RAW_MEDIA_REQUEST_CONTRACT.artifact_kind
    );
    const identity = {
      schema_version: 2,
      run_id: this.run_id,
      session_id: "session-audio",
      playbook: "research",
      engine_owner: "typescript",
    } as const;
    const directive: InvokeHostOperationDirectiveV1 = {
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity,
      state_id: "media-fixture",
      attempt: 1,
      operation_id: request.operation_id,
      operation_kind: "media_decode_extract",
      registration_sha256: runtimeRegistrationSha256(this.registration),
      request_ref: requestRef,
      request_sha256: requestRef.content_digest,
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "media", ref: request.media_ref },
          { slot: "decode-policy", ref: request.decode_policy_ref },
          { slot: "frame-selection", ref: request.frame_selection_ref },
        ],
      },
      expected_result: RAW_MEDIA_RESULT_CONTRACT,
      policy_binding: hostOperationPolicyBinding(this.declaration, this.base.backend),
    };
    const context = RunContext.create({
      identity,
      goal: "audio source admission protocol fixture",
      constraints: {},
      projectRoot: this.root,
      trustProfile: "trusted-interactive",
      maxSteps: 20,
      registrationContractBinding: {
        schema_version: 1,
        registration_name: this.registration.name,
        contract_sha256: skillContractSha256(this.registration.contract),
        registration_sha256: directive.registration_sha256,
      },
      initialArtifacts: [requestRef, ...directive.input_artifacts.artifacts.map((a) => a.ref)],
    });
    context.transition(directive.state_id);
    context.pendingDirective = directive;
    this.checkpointer.createRun(context, "audio_fixture_started", {});
    this.engine.liveness.bindPolicy(context);
    const adapter: HostOperationAdapterV1 = {
      adapter_id: this.declaration.adapter_id,
      inspectRequest: () => ({
        schema_version: 1,
        operation_kind: "media_decode_extract",
        adapter_id: this.declaration.adapter_id,
        backend_binding_id: this.declaration.backend_binding_id,
        backend_key_sha256: this.base.backend,
      }),
      run: async (c) => {
        c.beginSubmission();
        const bytes = this.store.read(request.media_ref);
        const result: RawMediaDecodeResultV1 = {
          schema_id: "penny.videogen-raw-media-decode-result.v1",
          schema_version: 1,
          operation_id: request.operation_id,
          source_ref: request.media_ref,
          request_sha256: c.directive.request_sha256,
          policy_sha256: this.policy_ref.content_digest,
          selection_sha256: this.base.selection_ref.content_digest,
          required_spans: request.required_spans,
          decode_scope: "entire_source_including_preroll",
          container_policy: MEDIA_POLICY.metadata_policy,
          video: null,
          audio: {
            codec: "canonical_pcm",
            channels: "mono",
            sample_rate: 8000,
            decoded_sample_count: 8000,
            duration: { numerator: 1, denominator: 1 },
            spans: [
              {
                start_sample: 0,
                end_sample: 8000,
                slot: "pcm-0",
                ...measurePcm16(bytes.subarray(44)),
              },
            ],
          },
          outputs: [
            {
              slot: "pcm-0",
              media_type: "audio/wav",
              sha256: sha256(bytes),
              byte_length: bytes.length,
            },
          ],
          qualification: "raw_decode_only_not_playback_or_production",
        };
        const content = canonicalJson(result);
        c.recordFetched({
          schema_version: 1,
          content_sha256: sha256(content),
          byte_length: Buffer.byteLength(content),
          item_count: 1,
          poll_count: 0,
        });
        const disposition = {
          outcome: "completed",
          remote_disposition: "proven_terminal",
          lease_disposition: "released",
          retryable: false,
          reason_code: null,
        } as const;
        return {
          disposition,
          ...c.persist({
            disposition,
            operation_result: {
              contract: RAW_MEDIA_RESULT_CONTRACT,
              media_type: "application/json",
              content,
            },
            outputs: [{ contract: MEDIA_PCM_CONTRACT, media_type: "audio/wav", content: bytes }],
          }),
        };
      },
    };
    await this.base.owner(adapter).dispatch(this.engine, directive);
    const record = required(this.checkpointer.hostOperationCallsForRun(this.run_id)[0]);
    const evidence = new MediaEvidenceCustody(this.custodyBindings).materialize(
      record.operation_record_id
    );
    return {
      media_ref: request.media_ref,
      measurement_ref: required(evidence.audio_measurement_ref),
      receipt_ref: evidence.receipt_ref,
      operation_record_id: record.operation_record_id,
    };
  }
  source(
    capture: Awaited<ReturnType<AudioAdmissionFixture["captured"]>>,
    kind: AudioSourceV1["source_kind"],
    role: AudioSourceV1["role"],
    voiceUse: "none" | "performed" | "cloned" = "none"
  ): AudioFixture {
    const consent = this.raw("fixture consent only", "text/plain");
    const provenance = {
      schema_id: "penny.videogen-provenance-binding.v1",
      schema_version: 1,
      subject_ref: capture.media_ref,
      source_refs: [],
      producer_receipt_ref: capture.receipt_ref,
    };
    const provenanceRef = this.json(provenance, provenance.schema_id);
    const speech = role === "narration" || role === "dialogue" || kind === "voice_studio";
    const baseRights = {
      schema_version: 1,
      subject_ref: capture.media_ref,
      revision: 1,
      provenance_ref: provenanceRef,
      license_ref: this.raw("fixture license only", "text/plain"),
      consent_refs: speech || voiceUse !== "none" ? [consent] : [],
      allowed_uses: ["source", "preview", "motion", "edit", "deliver"],
      territories: ["test-territory"],
      credits: ["fixture credit"],
      valid_from_utc: "2026-01-01T00:00:00Z",
      expires_at_utc: "2027-01-01T00:00:00Z",
    };
    const rights = speech
      ? validateRightsBinding(
          { ...baseRights, schema_id: "penny.videogen-rights-binding.v1", subject_kind: "voice" },
          MEDIA_LIMITS
        )
      : validateFoundation(
          AudioRightsBindingV1Schema,
          {
            ...baseRights,
            schema_id: "penny.videogen-audio-rights-binding.v1",
            subject_kind: "audio",
            allowed_roles: [role],
            voice_use: voiceUse,
          },
          MEDIA_LIMITS
        );
    const rightsRef = this.json(rights, rights.schema_id);
    this.current_rights.splice(0, this.current_rights.length, {
      subject_ref: capture.media_ref,
      rights_ref: rightsRef,
      revision: 1,
      status: "cleared",
    });
    const source = validateAudioSource(
      {
        schema_id: "penny.videogen-audio-source.v1",
        schema_version: 1,
        source_kind: kind,
        ...(kind === "registered_generator" ? { registered_provider_id: "fixture-provider" } : {}),
        media_ref: capture.media_ref,
        rights_ref: rightsRef,
        ...(speech || voiceUse !== "none" ? { consent_ref: consent } : {}),
        role,
        placement: { numerator: 0, denominator: 1 },
        duration: { numerator: 1, denominator: 1 },
        decoded_audio_ref: capture.receipt_ref,
        channels: "mono",
        sample_rate: { numerator: 8000, denominator: 1 },
        codec: "canonical_pcm",
        provenance_ref: provenanceRef,
      },
      MEDIA_LIMITS
    );
    const measurement = readSemantic({
      ...this.host(),
      ref: capture.measurement_ref,
      schema: AudioMeasurementV1Schema,
      schema_id: "penny.videogen-audio-measurement.v1",
    });
    const receipt = readSemantic({
      ...this.host(),
      ref: capture.receipt_ref,
      schema: HostOperationReceiptV1Schema,
      schema_id: "penny.host-operation-receipt.v1",
    });
    return {
      source,
      source_ref: this.json(source, source.schema_id),
      measurement,
      measurement_ref: capture.measurement_ref,
      receipt,
      rights,
    };
  }
  provider(source: AudioSourceV1): {
    contract: AudioProviderContractV1;
    selection: AudioProviderSelectionV1;
  } {
    const contract = validateAudioProviderContract(
      {
        schema_id: "penny.videogen-audio-provider-contract.v1",
        schema_version: 1,
        provider_id: "fixture-provider",
        media_producer: source.media_ref.producer,
        allowed_roles: [source.role],
        allowed_uses: ["source", "edit"],
        media_type: "audio/wav",
        codec: "canonical_pcm",
        channels: ["mono"],
        sample_rates: [{ numerator: 8000, denominator: 1 }],
        max_samples: 8000,
        max_duration: { numerator: 1, denominator: 1 },
        capture_meter: { meter: "stored_bytes", unit: "byte", limit: source.media_ref.byte_length },
        captured_outputs: [{ media_ref: source.media_ref, provenance_ref: source.provenance_ref }],
        valid_from_utc: "2026-01-01T00:00:00Z",
        expires_at_utc: "2027-01-01T00:00:00Z",
      },
      MEDIA_LIMITS
    );
    return {
      contract,
      selection: {
        provider_id: contract.provider_id,
        contract_ref: this.json(contract, contract.schema_id),
      },
    };
  }
  [Symbol.dispose](): void {
    this.base[Symbol.dispose]();
  }
}
