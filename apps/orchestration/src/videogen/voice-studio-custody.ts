import { verifyHostResultWrapper } from "../host-operations/effect-protocol.js";
import { type TSchema } from "typebox";
import { ArtifactStore } from "../artifact-store.js";
import { Checkpointer } from "../checkpointer.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import { HostOperationLeaseAuthority } from "../host-operations/lease-authority.js";
import { HostOperationArtifactCustody } from "../host-operations/storage.js";
import {
  HostOperationReceiptV1Schema,
  HostOperationResultV1Schema,
  hostOperationPolicyBinding,
  type HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import { validateSkillSchema } from "../skill-contracts/common.js";
import { sameRef, readExact } from "./bounds.js";
import { VoiceStudioAuthority } from "./voice-studio-authority.js";
import {
  VoiceStudioRawResultV1Schema,
  VoiceStudioCorrelationV1Schema,
  VoiceStudioTimingUnavailableV1Schema,
  VoiceStudioAudioEvidenceV1Schema,
  VoiceStudioJobResultV1Schema,
  VOICE_STUDIO_RAW_RESULT,
  VOICE_STUDIO_WAV,
  type VoiceStudioJobResultV1,
} from "./voice-studio-contracts.js";
import { MediaEvidenceCustody } from "./media-evidence.js";
import {
  AudioSourceV1Schema,
  AudioSourceDecodeCustody,
  prepareAudioSourceCapture,
  validateAudioSource,
} from "./audio-sources.js";
import type { AudioSourceHostV1 } from "./audio-source-admission.js";
import { ProvenanceBindingV1Schema } from "./rights-ledger.js";
import {
  MediaDecodePolicyV1Schema,
  RAW_MEDIA_RESULT_CONTRACT,
  validateMediaPolicy,
} from "./media-contracts.js";
import { inspectCanonicalPcmWav, measurePcm16 } from "./media-decode.js";
import { measureVoiceLoudness } from "./voice-audio-meter.js";

function equal(a: unknown, b: unknown): void {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error("Voice Studio custody drift");
}
function required<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("Voice Studio custody missing milestone");
  return v;
}
export interface VoiceStudioCustodyBindingsV1 {
  readonly authority: VoiceStudioAuthority;
  readonly leases: HostOperationLeaseAuthority;
  readonly declaration: HostOperationDeclarationV1;
  readonly registration_sha256: string;
}
/** Post-receipt deterministic adoption in the EXISTING store. Never signs receipts, mutates the
 * operation journal, scans artifacts, decodes through an invented service, or grants G2. Core must
 * select domain refs as a later continuation milestone. The generic receipt-citing wrapper is
 * verified first; domain source admission is distinct from speech/playback/production qualification. */
export class VoiceStudioCaptureCustody {
  constructor(readonly bindings: VoiceStudioCustodyBindingsV1) {
    if (
      !(bindings.authority instanceof VoiceStudioAuthority) ||
      !(bindings.leases instanceof HostOperationLeaseAuthority) ||
      !(bindings.authority.bindings.store instanceof ArtifactStore) ||
      !(bindings.authority.bindings.checkpointer instanceof Checkpointer)
    )
      throw new Error("Voice Studio concrete custody required");
  }
  private verify(operationRecordId: string) {
    const { authority: a, leases, declaration } = this.bindings,
      b = a.bindings;
    const record = HostOperationArtifactCustody.fromArtifactStore(b.store).verifyForProject(
      a.current().gate.project_id,
      required(b.checkpointer.hostOperationCall(operationRecordId))
    );
    if (
      !["settled", "consumed"].includes(record.lifecycle) ||
      record.operation_kind !== "voice_job" ||
      record.disposition?.outcome !== "completed" ||
      record.registration_sha256 !== this.bindings.registration_sha256
    )
      throw new Error("Voice Studio exact settled voice job required");
    equal(record.expected_result, VOICE_STUDIO_RAW_RESULT);
    equal(record.policy_binding, hostOperationPolicyBinding(declaration, a.backend_key_sha256));
    const rawRef = required(record.operation_result_ref),
      receiptRef = required(record.host_receipt_ref),
      platformRef = required(record.platform_result_ref),
      plan = required(record.persistence_plan);
    const raw = a.read(
      rawRef,
      VoiceStudioRawResultV1Schema,
      "penny.videogen-voice-studio-raw-result.v1"
    );
    const request = a.parseRequest(
      readExact(b.store, a.current().gate.project_id, record.request_ref, b.limits.max_json_bytes)
    );
    verifyHostResultWrapper(b.store, record);
    a.validateRequest(request, record.directive);
    equal(raw.correlation, a.readCorrelation(required(record.remote_correlation_id)));
    if (
      raw.operation_id !== record.operation_id ||
      raw.request_sha256 !== record.request_sha256 ||
      raw.correlation.request_sha256 !== record.request_sha256 ||
      raw.correlation.profile_sha256 !== request.profile_ref.content_digest ||
      raw.job.job_id !== raw.correlation.job_id ||
      raw.job.narration_item_id !== raw.correlation.narration_item_id ||
      raw.job.status !== "completed" ||
      raw.job.errored !== 0 ||
      raw.job.completed !== request.expected_chunk_ids.length ||
      raw.job.total_chunks !== raw.job.completed ||
      raw.job.percent !== 100
    )
      throw new Error("Voice Studio raw acceptance/coverage identity");
    if (!sameRef(a.coverage(raw.correlation, request, raw.narration), raw.coverage_ref))
      throw new Error("Voice Studio coverage selection drift");
    const disposition = required(leases.dispositionForOperation(record.operation_record_id));
    equal(disposition.disposition, record.disposition);
    equal(disposition.lease, record.lease);
    if (
      disposition.receipt_id !== record.lease_disposition_receipt_id ||
      disposition.remote_correlation_sha256 !== record.remote_correlation_sha256 ||
      disposition.backend_key_sha256 !== a.backend_key_sha256
    )
      throw new Error("Voice Studio lease settlement drift");
    const platform = a.read(
      platformRef,
      HostOperationResultV1Schema,
      "penny.host-operation-result.v1"
    );
    equal(platform, {
      schema_version: 1,
      operation_record_id: record.operation_record_id,
      identity: record.identity,
      state_id: record.state_id,
      attempt: record.attempt,
      operation_id: record.operation_id,
      operation_kind: record.operation_kind,
      registration_sha256: record.registration_sha256,
      request_sha256: record.request_sha256,
      lease: record.lease,
      disposition: record.disposition,
      operation_result_ref: rawRef,
      output_artifacts: record.output_artifacts,
    });
    const receipt = a.read(
      receiptRef,
      HostOperationReceiptV1Schema,
      "penny.host-operation-receipt.v1"
    );
    equal(receipt.identity, record.identity);
    equal(receipt.disposition, record.disposition);
    if (
      receipt.receipt_id !==
        `hop_receipt_${sha256(canonicalJson({ operation_record_id: record.operation_record_id, disposition_receipt_id: disposition.receipt_id }))}` ||
      receipt.operation_record_id !== record.operation_record_id ||
      receipt.operation_id !== record.operation_id ||
      receipt.operation_kind !== "voice_job" ||
      receipt.registration_sha256 !== record.registration_sha256 ||
      receipt.request_sha256 !== record.request_sha256 ||
      receipt.result_sha256 !== rawRef.content_digest ||
      receipt.lease_disposition_receipt_id !== disposition.receipt_id ||
      receipt.remote_correlation_sha256 !== record.remote_correlation_sha256 ||
      receipt.output_artifact_count !== 2 ||
      receipt.output_bytes !==
        rawRef.byte_length + record.output_artifacts.reduce((n, r) => n + r.byte_length, 0) ||
      receipt.request_bytes !== record.request_ref.byte_length ||
      receipt.state_id !== record.state_id ||
      receipt.attempt !== record.attempt ||
      receipt.started_at !== record.started_at ||
      receipt.ended_at < receipt.started_at ||
      receipt.progress_event_count !== record.progress_event_count ||
      receipt.poll_count !== record.fetched?.poll_count
    )
      throw new Error("Voice Studio owner receipt drift");
    if (
      receiptRef.producer !== "host:host-operation-owner" ||
      platformRef.producer !== "host:host-operation-owner"
    )
      throw new Error("Voice Studio owner identity drift");
    equal(b.store.metadata(receiptRef).upstream_refs, [record.request_ref, platformRef]);
    equal(b.store.metadata(platformRef).upstream_refs, [
      record.request_ref,
      rawRef,
      ...record.output_artifacts,
    ]);
    const wavRef = required(record.output_artifacts[0]);
    if (
      record.output_artifacts.length !== 1 ||
      plan.outputs.length !== 1 ||
      wavRef.content_digest !== raw.wav_sha256 ||
      wavRef.byte_length !== raw.wav_bytes ||
      wavRef.media_type !== "audio/wav"
    )
      throw new Error("Voice Studio complete WAV plan");
    equal(plan.disposition, record.disposition);
    for (const [ref, p] of [
      [rawRef, plan.operation_result],
      [wavRef, required(plan.outputs[0])],
    ] as const) {
      if (
        ref.content_digest !== p.content_sha256 ||
        ref.byte_length !== p.byte_length ||
        ref.operation_id !== p.operation_id ||
        ref.version !== p.version ||
        ref.media_type !== p.media_type ||
        ref.kind !== p.artifact_kind ||
        ref.content_schema?.schema_id !== p.schema_id ||
        ref.content_schema.schema_version !== p.schema_version_required ||
        ref.producer !== `host:${declaration.adapter_id}` ||
        ref.run_id !== record.identity.run_id ||
        ref.phase !== record.state_id
      )
        throw new Error("Voice Studio persistence identity drift");
    }
    if (wavRef.kind !== VOICE_STUDIO_WAV.artifact_kind)
      throw new Error("Voice Studio WAV output contract");
    const bytes = readExact(
      b.store,
      a.current().gate.project_id,
      wavRef,
      a.profile.limits.max_wav_bytes
    );
    const policy = validateMediaPolicy(
      a.read(
        a.profile.media_policy_ref,
        MediaDecodePolicyV1Schema,
        "penny.videogen-media-decode-policy.v1"
      )
    );
    const pcm = inspectCanonicalPcmWav(bytes, policy);
    if (
      pcm.samples !== raw.samples ||
      pcm.sample_rate !== raw.sample_rate.numerator ||
      raw.sample_rate.denominator !== 1 ||
      raw.channels !== (pcm.channels === 1 ? "mono" : "stereo")
    )
      throw new Error("Voice Studio PCM identity drift");
    equal(measurePcm16(pcm.data), { peak_abs_s16: raw.peak_abs_s16, sum_squares: raw.sum_squares });
    const measuredMeters = a.finalMeters(record);
    return { record, rawRef, receiptRef, request, raw, wavRef, bytes, pcm, measuredMeters };
  }
  private persist(
    record: ReturnType<VoiceStudioCaptureCustody["verify"]>["record"],
    name: string,
    bytes: string | Buffer,
    upstream: ArtifactRef[],
    schema?: TSchema
  ): ArtifactRef {
    const a = this.bindings.authority,
      b = a.bindings;
    const schemaId = `penny.videogen-${name}.v1`,
      kind = `videogen-${name}`,
      operationId = `voice-capture:${record.operation_record_id}:${name}`;
    if (schema !== undefined) {
      const value: unknown = JSON.parse(bytes.toString());
      validateSkillSchema(schema, value, "Voice Studio wrapper");
    }
    const content = Buffer.from(bytes),
      existing = b.store.refFor(
        record.identity.run_id,
        record.state_id,
        null,
        kind,
        operationId,
        1
      );
    if (existing !== null) {
      if (
        existing.content_digest !== sha256(content) ||
        existing.byte_length !== content.length ||
        existing.producer !== "host:videogen-voice-custody" ||
        existing.media_type !== (schema ? "application/json" : "audio/wav") ||
        (schema
          ? existing.content_schema?.schema_id !== schemaId
          : existing.content_schema !== undefined)
      )
        throw new Error("Voice Studio wrapper conflict");
      equal(b.store.metadata(existing).upstream_refs, upstream);
      readExact(b.store, a.current().gate.project_id, existing, content.length);
      return existing;
    }
    const ref = b.store.persist({
      metadata: {
        schema_version: 2,
        run_id: record.identity.run_id,
        phase: record.state_id,
        branch_id: null,
        kind,
        operation_id: operationId,
        version: 1,
        producer: "host:videogen-voice-custody",
        media_type: schema ? "application/json" : "audio/wav",
        parent_ref: null,
        upstream_refs: upstream,
        ...(schema ? { content_schema: { schema_id: schemaId, schema_version: 1 } } : {}),
      },
      content,
    });
    if (!b.store.read(ref).equals(content)) throw new Error("Voice Studio wrapper readback");
    return ref;
  }
  capture(operationRecordId: string) {
    const v = this.verify(operationRecordId),
      { record, rawRef, receiptRef, request: r, raw } = v;
    const mediaRef = this.persist(record, "voice-performance", v.bytes, [
      rawRef,
      v.wavRef,
      receiptRef,
      r.script_ref,
      r.voice_ref,
      r.chunk_plan_ref,
      r.service_build_ref,
      r.profile_ref,
      raw.coverage_ref,
    ]);
    const provenance = {
      schema_id: "penny.videogen-provenance-binding.v1",
      schema_version: 1,
      subject_ref: mediaRef,
      source_refs: [
        r.script_ref,
        r.voice_ref,
        r.chunk_plan_ref,
        r.service_build_ref,
        r.profile_ref,
        raw.coverage_ref,
        rawRef,
      ],
      producer_receipt_ref: receiptRef,
    };
    const provenanceRef = this.persist(
      record,
      "provenance-binding",
      canonicalJson(provenance),
      [mediaRef, rawRef, receiptRef],
      ProvenanceBindingV1Schema
    );
    const correlationRef = this.persist(
      record,
      "voice-studio-correlation",
      canonicalJson(raw.correlation),
      [rawRef, receiptRef],
      VoiceStudioCorrelationV1Schema
    );
    const script = this.bindings.authority.validateRequest(r, record.directive).script;
    const timingRef = this.persist(
      record,
      "voice-studio-timing-unavailable",
      canonicalJson({
        schema_id: "penny.videogen-voice-studio-timing-unavailable.v1",
        schema_version: 1,
        performance_ref: mediaRef,
        script_ref: r.script_ref,
        source_sample_rate: raw.sample_rate,
        measured_samples: raw.samples,
        uncertain_line_ids: [
          ...script.scenes.flatMap((s) => s.ordered_lines),
          ...script.narration_lines,
        ].map((l) => l.line_id),
        alignment: "unavailable",
        sync_route: "blocked",
      }),
      [mediaRef, rawRef, receiptRef, r.script_ref],
      VoiceStudioTimingUnavailableV1Schema
    );
    return {
      media_ref: mediaRef,
      provenance_ref: provenanceRef,
      receipt_ref: receiptRef,
      timing_unavailable_ref: timingRef,
      job_correlation_ref: correlationRef,
      chunk_status_ref: raw.coverage_ref,
      sync_route: "alignment_unavailable" as const,
    };
  }
  /** Caller first drives the EXISTING media_decode_extract operation on capture().media_ref,
   * then supplies its concrete settled custody and current rights for that exact canonical audio. */
  materialize(input: {
    readonly operation_record_id: string;
    readonly decode_operation_record_id: string;
    readonly decode: MediaEvidenceCustody;
    readonly audio_custody: AudioSourceDecodeCustody;
    /** Compatibility-only scope check. Supplied rights/clock projections never grant use. */
    readonly host?: AudioSourceHostV1;
    readonly rights_ref: ArtifactRef;
  }): { result_ref: ArtifactRef; result: VoiceStudioJobResultV1 } {
    if (
      !(input.decode instanceof MediaEvidenceCustody) ||
      !(input.audio_custody instanceof AudioSourceDecodeCustody)
    )
      throw new Error("existing decode custody required");
    const v = this.verify(input.operation_record_id),
      c = this.capture(input.operation_record_id),
      h = this.bindings.authority.current().rights;
    if (
      input.host !== undefined &&
      (input.host.store !== h.store ||
        input.host.project_id !== h.project_id ||
        input.host.run_id !== h.run_id)
    )
      throw new Error("Voice Studio source host mismatch");
    const actualDecode = required(
      this.bindings.authority.bindings.checkpointer.hostOperationCall(
        input.decode_operation_record_id
      )
    );
    equal(
      input.decode.verifySettled(input.decode_operation_record_id, RAW_MEDIA_RESULT_CONTRACT)
        .record,
      actualDecode
    );
    if (actualDecode.identity.run_id !== h.run_id)
      throw new Error("Voice Studio decode run mismatch");
    const decoded = input.decode.materialize(input.decode_operation_record_id),
      measurementRef = required(decoded.audio_measurement_ref);
    const source = validateAudioSource(
      {
        schema_id: "penny.videogen-audio-source.v1",
        schema_version: 1,
        source_kind: "voice_studio",
        media_ref: c.media_ref,
        rights_ref: input.rights_ref,
        consent_ref: v.request.consent_ref,
        role: v.request.role,
        placement: v.request.placement,
        duration: v.raw.duration,
        decoded_audio_ref: decoded.receipt_ref,
        channels: v.raw.channels,
        sample_rate: v.raw.sample_rate,
        codec: "canonical_pcm",
        provenance_ref: c.provenance_ref,
      },
      h.limits
    );
    const checked = prepareAudioSourceCapture({
      host: { ...h, audio_decode_custody: input.audio_custody },
      source,
      measurement_ref: measurementRef,
      use: "preview",
    });
    if (checked.status !== "protocol_checked" || checked.source_admission !== "admitted")
      throw new Error("Voice Studio captured source/decode/rights not admitted");
    const sourceRef = this.persist(
      v.record,
      "audio-source",
      canonicalJson(source),
      [
        c.media_ref,
        c.provenance_ref,
        input.rights_ref,
        source.decoded_audio_ref,
        measurementRef,
        c.receipt_ref,
      ],
      AudioSourceV1Schema
    );
    // Exact samples provide duration/energy/loudness only. No inferred speech interval or alignment.
    const evidence = {
      schema_id: "penny.videogen-audio-evidence.v1",
      schema_version: 1,
      audio_ref: c.media_ref,
      decode_receipt_ref: decoded.receipt_ref,
      codec: "canonical_pcm",
      channels: source.channels,
      sample_rate: source.sample_rate,
      sample_count: v.raw.samples,
      decoded_duration: v.raw.duration,
      ...measureVoiceLoudness(v.pcm.data, v.pcm.channels, v.pcm.sample_rate),
      speech_intervals: [],
      script_ref: v.request.script_ref,
      chunk_coverage_ref: c.chunk_status_ref,
      sync_offsets: [],
      unassessed: ["intelligibility", "identity", "word_alignment"],
    };
    const evidenceRef = this.persist(
      v.record,
      "audio-evidence",
      canonicalJson(evidence),
      [c.media_ref, decoded.receipt_ref, measurementRef, c.chunk_status_ref],
      VoiceStudioAudioEvidenceV1Schema
    );
    const output = [
      c.media_ref,
      sourceRef,
      evidenceRef,
      c.timing_unavailable_ref,
      c.job_correlation_ref,
      c.chunk_status_ref,
      c.provenance_ref,
      measurementRef,
    ];
    const result = validateSkillSchema(
      VoiceStudioJobResultV1Schema,
      {
        schema_id: "penny.videogen-voice-job-result.v1",
        schema_version: 1,
        operation_id: v.request.operation_id,
        input_digests: [
          ...new Set([
            v.record.request_sha256,
            ...v.record.input_artifacts.artifacts.map((x) => x.ref.content_digest),
          ]),
        ],
        output_refs: output,
        measured_meters: v.measuredMeters,
        receipt_ref: c.receipt_ref,
        audio_source_ref: sourceRef,
        audio_evidence_ref: evidenceRef,
        timing_ref: null,
        timing_unavailable_ref: c.timing_unavailable_ref,
        job_correlation_ref: c.job_correlation_ref,
        chunk_status_ref: c.chunk_status_ref,
        sync_route: "alignment_unavailable",
        source_admission: "admitted",
        production_admission: "blocked",
      },
      "VoiceStudioJobResultV1"
    );
    return {
      result,
      result_ref: this.persist(
        v.record,
        "voice-job-result",
        canonicalJson(result),
        [v.rawRef, c.receipt_ref, ...output],
        VoiceStudioJobResultV1Schema
      ),
    };
  }
}
