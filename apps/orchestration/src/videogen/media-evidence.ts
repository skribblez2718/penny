import { ArtifactStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { Checkpointer } from "../checkpointer.js";
import type { ArtifactRef, HostOperationArtifactContractV1 } from "../contracts.js";
import { HostOperationLeaseAuthority } from "../host-operations/lease-authority.js";
import {
  HostOperationReceiptV1Schema,
  HostOperationResultV1Schema,
  hostOperationPolicyBinding,
  type HostOperationCallRecordV1,
  type HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import { HostOperationArtifactCustody } from "../host-operations/storage.js";
import { validateMp4Video } from "../mp4-media.js";
import { validateCanonicalPng } from "../png-media.js";
import { AudioMeasurementV1Schema, validateAudioMeasurement } from "./audio-sources.js";
import { readExact, readSemantic, sameRef, type FoundationLimitsV1 } from "./bounds.js";
import {
  MediaDecodePolicyV1Schema,
  MediaFrameSelectionV1Schema,
  RawMediaDecodeRequestV1Schema,
  RawMediaDecodeResultV1Schema,
  VideoEvidenceV1Schema,
  RAW_MEDIA_RESULT_CONTRACT,
  validateMediaPolicy,
  validateMediaRequest,
  validateMediaSelection,
  parseMediaJson,
} from "./media-contracts.js";
import {
  inspectCanonicalPcmWav,
  inspectStrictAvcMp4,
  measurePcm16,
  selectMediaFrames,
} from "./media-decode.js";
import { compareTime, rationalTime } from "./rational-time.js";

export interface MediaEvidenceCustodyBindingsV1 {
  readonly project_id: string;
  readonly store: ArtifactStore;
  readonly checkpointer: Checkpointer;
  readonly leases: HostOperationLeaseAuthority;
  readonly limits: FoundationLimitsV1;
  readonly registration_sha256: string;
  readonly declaration: HostOperationDeclarationV1;
  readonly backend_key_sha256: string;
  readonly policy_ref: ArtifactRef;
}
export interface CustodiedMediaEvidenceV1 {
  readonly raw_ref: ArtifactRef;
  readonly receipt_ref: ArtifactRef;
  readonly video_evidence_ref: ArtifactRef | null;
  readonly audio_measurement_ref: ArtifactRef | null;
  readonly production_admission: "blocked";
  readonly missing_qualification: readonly [
    "gated_effect_intent_integration",
    "post_receipt_wrapper_journal_milestone",
    "independent_playback_motion_speech_sync",
    "decoder_deployment_qualification",
  ];
}
function requireValue<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) throw new Error(`media custody missing ${name}`);
  return value;
}
function equal(a: unknown, b: unknown, label: string): void {
  if (canonicalJson(a) !== canonicalJson(b)) throw new Error(`media custody mismatch: ${label}`);
}
/** Uses ONLY existing concrete project/journal/lease/artifact custody, never receipt-shaped inputs.
 * This API takes an exact existing operation ID, not a caller-supplied journal or "verified" bool.
 * No duplicate receipt store/signer, scan, registration, workflow or speculative reference.
 * Existing host receipts have no signature member: this is journal custody, NOT a new signature.
 * Rights, gates, expiry and production authority remain the future retained integration's job. */
export class MediaEvidenceCustody {
  private readonly b: MediaEvidenceCustodyBindingsV1;
  private readonly custody: HostOperationArtifactCustody;
  constructor(bindings: MediaEvidenceCustodyBindingsV1) {
    if (
      !(bindings.store instanceof ArtifactStore) ||
      !(bindings.checkpointer instanceof Checkpointer) ||
      !(bindings.leases instanceof HostOperationLeaseAuthority)
    )
      throw new Error("media evidence requires concrete existing owners");
    bindings.store.assertBoundProject(bindings.project_id);
    this.b = {
      ...bindings,
      limits: structuredClone(bindings.limits),
      declaration: structuredClone(bindings.declaration),
      policy_ref: structuredClone(bindings.policy_ref),
    };
    this.custody = HostOperationArtifactCustody.fromArtifactStore(bindings.store);
  }
  /** Shared receipt/journal verification for additive raw media contracts. No decoder or PASS hook. */
  verifySettled(operationRecordId: string, expected: HostOperationArtifactContractV1) {
    const b = this.b;
    const record = this.custody.verifyForProject(
      b.project_id,
      requireValue(b.checkpointer.hostOperationCall(operationRecordId), "journal")
    );
    if (
      (record.lifecycle !== "settled" && record.lifecycle !== "consumed") ||
      record.disposition?.outcome !== "completed" ||
      record.operation_kind !== "media_decode_extract" ||
      record.registration_sha256 !== b.registration_sha256
    )
      throw new Error("media custody requires exact completed settled operation");
    equal(
      record.policy_binding,
      hostOperationPolicyBinding(b.declaration, b.backend_key_sha256),
      "current declaration/backend"
    );
    equal(record.expected_result, expected, "raw result contract");
    const rawRef = requireValue(record.operation_result_ref, "raw result");
    const receiptRef = requireValue(record.host_receipt_ref, "owner receipt");
    const platformRef = requireValue(record.platform_result_ref, "platform result");
    const plan = requireValue(record.persistence_plan, "raw persistence plan");
    const disposition = requireValue(
      b.leases.dispositionForOperation(record.operation_record_id),
      "lease disposition"
    );
    equal(disposition.disposition, record.disposition, "lease outcome");
    equal(disposition.lease, record.lease, "lease identity");
    if (
      disposition.receipt_id !== record.lease_disposition_receipt_id ||
      disposition.backend_key_sha256 !== b.backend_key_sha256 ||
      disposition.remote_correlation_sha256 !== record.remote_correlation_sha256
    )
      throw new Error("media lease disposition drift");
    const read = <T extends Parameters<typeof readSemantic>[0]["schema"]>(
      ref: ArtifactRef,
      schema: T,
      schemaId: string
    ) =>
      readSemantic({
        store: b.store,
        project_id: b.project_id,
        ref,
        schema,
        schema_id: schemaId,
        limits: b.limits,
      });
    const platform = read(
      platformRef,
      HostOperationResultV1Schema,
      "penny.host-operation-result.v1"
    );
    equal(
      platform,
      {
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
      },
      "platform result"
    );
    const receipt = read(
      receiptRef,
      HostOperationReceiptV1Schema,
      "penny.host-operation-receipt.v1"
    );
    if (
      receipt.operation_record_id !== record.operation_record_id ||
      receipt.operation_id !== record.operation_id ||
      receipt.operation_kind !== record.operation_kind ||
      receipt.registration_sha256 !== record.registration_sha256 ||
      receipt.request_sha256 !== record.request_sha256 ||
      receipt.result_sha256 !== rawRef.content_digest ||
      receipt.output_artifact_count !== record.output_artifacts.length + 1 ||
      receipt.output_bytes !==
        rawRef.byte_length + record.output_artifacts.reduce((n, ref) => n + ref.byte_length, 0) ||
      receipt.lease_disposition_receipt_id !== disposition.receipt_id ||
      receipt.remote_correlation_sha256 !== record.remote_correlation_sha256 ||
      receipt.request_bytes !== record.request_ref.byte_length ||
      receipt.started_at !== record.started_at ||
      receipt.progress_event_count !== record.progress_event_count ||
      receipt.poll_count !== (record.fetched?.poll_count ?? 0)
    )
      throw new Error("media owner receipt identity/count drift");
    equal(receipt.identity, record.identity, "receipt run");
    equal(receipt.disposition, record.disposition, "receipt outcome");
    if (
      receipt.state_id !== record.state_id ||
      receipt.attempt !== record.attempt ||
      receipt.ended_at < receipt.started_at
    )
      throw new Error("media receipt visit/time drift");
    const expectedReceiptId = `hop_receipt_${sha256(canonicalJson({ operation_record_id: record.operation_record_id, disposition_receipt_id: disposition.receipt_id }))}`;
    if (receipt.receipt_id !== expectedReceiptId) throw new Error("media receipt identity drift");
    const receiptMeta = b.store.metadata(receiptRef);
    const platformMeta = b.store.metadata(platformRef);
    if (
      receiptRef.producer !== "host:host-operation-owner" ||
      platformRef.producer !== "host:host-operation-owner"
    )
      throw new Error("media owner producer drift");
    equal(
      receiptMeta.upstream_refs,
      [record.request_ref, platformRef],
      "receipt platform provenance"
    );
    equal(
      platformMeta.upstream_refs,
      [record.request_ref, rawRef, ...record.output_artifacts],
      "platform raw provenance"
    );
    return { record, rawRef, receiptRef, platformRef, plan, read };
  }
  /** Validate raw→settled owner receipt→domain wrapper, or exactly adopt already written wrapper.
   * A crash before/after a wrapper cannot invoke decode. The owner journal remains unchanged:
   * it has no later-wrapper milestone API. The caller must retain returned exact refs explicitly. */
  materialize(operationRecordId: string): CustodiedMediaEvidenceV1 {
    const b = this.b;
    const { record, rawRef, receiptRef, plan, read } = this.verifySettled(
      operationRecordId,
      RAW_MEDIA_RESULT_CONTRACT
    );
    const raw = read(
      rawRef,
      RawMediaDecodeResultV1Schema,
      "penny.videogen-raw-media-decode-result.v1"
    );
    const request = read(
      record.request_ref,
      RawMediaDecodeRequestV1Schema,
      "penny.videogen-raw-media-decode-request.v1"
    );
    equal(
      record.input_artifacts.artifacts,
      [
        { slot: "media", ref: request.media_ref },
        { slot: "decode-policy", ref: request.decode_policy_ref },
        { slot: "frame-selection", ref: request.frame_selection_ref },
      ],
      "exact input slots"
    );
    if (!sameRef(request.decode_policy_ref, b.policy_ref))
      throw new Error("media current policy drift");
    const policy = validateMediaPolicy(
      read(b.policy_ref, MediaDecodePolicyV1Schema, "penny.videogen-media-decode-policy.v1")
    );
    validateMediaRequest(request, policy);
    const selection = validateMediaSelection(
      read(
        request.frame_selection_ref,
        MediaFrameSelectionV1Schema,
        "penny.videogen-media-frame-selection.v1"
      ),
      policy
    );
    if (
      !sameRef(raw.source_ref, request.media_ref) ||
      raw.operation_id !== record.operation_id ||
      request.operation_id !== record.operation_id ||
      raw.request_sha256 !== record.request_sha256 ||
      raw.policy_sha256 !== b.policy_ref.content_digest ||
      raw.selection_sha256 !== request.frame_selection_ref.content_digest ||
      raw.container_policy !== policy.metadata_policy ||
      (raw.video === null) === (raw.audio === null)
    )
      throw new Error("media raw identity drift");
    equal(raw.required_spans, request.required_spans, "used spans");
    equal(plan.disposition, record.disposition, "raw plan disposition");
    const allRefs = [rawRef, ...record.output_artifacts];
    const allPlans = [plan.operation_result, ...plan.outputs];
    if (
      allRefs.length !== allPlans.length ||
      raw.outputs.length !== record.output_artifacts.length ||
      new Set(raw.outputs.map((o) => o.slot)).size !== raw.outputs.length
    )
      throw new Error("media raw output coverage");
    allRefs.forEach((ref, i) => {
      const planned = requireValue(allPlans[i], "output plan");
      if (
        ref.byte_length !== planned.byte_length ||
        ref.content_digest !== planned.content_sha256 ||
        ref.kind !== planned.artifact_kind ||
        ref.media_type !== planned.media_type ||
        ref.operation_id !== planned.operation_id ||
        ref.version !== planned.version ||
        ref.content_schema?.schema_id !== planned.schema_id ||
        ref.content_schema.schema_version !== planned.schema_version_required ||
        ref.producer !== `host:${b.declaration.adapter_id}` ||
        ref.run_id !== record.identity.run_id ||
        ref.phase !== record.state_id
      )
        throw new Error("media raw plan/producer drift");
      if (i > 0) {
        const o = requireValue(raw.outputs[i - 1], "raw descriptor");
        if (
          o.sha256 !== ref.content_digest ||
          o.byte_length !== ref.byte_length ||
          o.media_type !== ref.media_type
        )
          throw new Error("media raw output digest drift");
      }
    });
    if (allRefs.reduce((n, ref) => n + ref.byte_length, 0) > policy.max_output_bytes)
      throw new Error("media persisted output policy drift");
    const outputRef = (slot: string): ArtifactRef => {
      const index = raw.outputs.findIndex((o) => o.slot === slot);
      if (index < 0) throw new Error("media output slot missing");
      return requireValue(record.output_artifacts[index], "output ref");
    };
    let videoRef: ArtifactRef | null = null;
    let audioRef: ArtifactRef | null = null;
    if (raw.video !== null) {
      if (
        raw.video.frames.length === 0 ||
        raw.video.frames.length !== raw.outputs.length ||
        raw.video.frames.length > policy.max_selected_frames
      )
        throw new Error("media video frame coverage");
      const v = raw.video;
      if (
        v.decoded_frame_count > policy.max_frames ||
        v.width > policy.max_width ||
        v.height > policy.max_height ||
        v.width * v.height > policy.max_pixels ||
        v.width * v.height * 4 * v.decoded_frame_count > policy.max_decoded_bytes ||
        compareTime(v.duration, policy.max_duration) > 0
      )
        throw new Error("media video policy drift");
      const sourceBytes = readExact(b.store, b.project_id, raw.source_ref, policy.max_input_bytes);
      inspectStrictAvcMp4(sourceBytes, policy);
      const structural = validateMp4Video(sourceBytes, {
        width: v.width,
        height: v.height,
        frame_count: v.decoded_frame_count,
        fps: (v.decoded_frame_count * v.duration.denominator) / v.duration.numerator,
        max_bytes: policy.max_input_bytes,
      });
      if (structural.status !== "valid") throw new Error("media source structural drift");
      const expectedPts = Array.from({ length: v.decoded_frame_count }, (_, i) =>
        rationalTime(
          BigInt(i) * BigInt(v.duration.numerator),
          BigInt(v.duration.denominator) * BigInt(v.decoded_frame_count)
        )
      );
      equal(
        raw.video.frames.map((f) => f.index),
        selectMediaFrames(
          expectedPts,
          request.required_spans,
          selection,
          policy.max_selected_frames
        ),
        "requested frame coverage"
      );
      let last = -1;
      for (const frame of raw.video.frames) {
        equal(
          frame.pts,
          requireValue(expectedPts[frame.index], "source frame PTS"),
          "exact frame PTS"
        );
        const ref = outputRef(frame.slot);
        const info = validateCanonicalPng(
          readExact(b.store, b.project_id, ref, policy.max_output_bytes)
        );
        if (
          ref.media_type !== "image/png" ||
          info.width !== raw.video.width ||
          info.height !== raw.video.height ||
          frame.index <= last ||
          frame.index >= raw.video.decoded_frame_count ||
          !raw.required_spans.some(
            (s) => compareTime(frame.pts, s.start) >= 0 && compareTime(frame.pts, s.end) < 0
          )
        )
          throw new Error("media PNG/index/PTS drift");
        last = frame.index;
      }
      const evidence = {
        schema_id: "penny.videogen-video-evidence.v1",
        schema_version: 1,
        source_clip_ref: raw.source_ref,
        decode_profile_ref: b.policy_ref,
        container_validation_ref: rawRef,
        full_decode_ref: rawRef,
        frames: raw.video.frames.map((f) => ({
          index: f.index,
          pts: f.pts,
          png_ref: outputRef(f.slot),
        })),
        limits: {
          max_frames: policy.max_selected_frames,
          max_bytes: policy.max_output_bytes,
          selection_rule_id: selection.selection_rule_id,
        },
        unassessed: ["motion", "speech", "sound", "sync"],
      };
      parseMediaJson(VideoEvidenceV1Schema, Buffer.from(canonicalJson(evidence)), b.limits);
      videoRef = this.persistWrapper(record, "video-evidence", evidence, [
        rawRef,
        receiptRef,
        ...record.output_artifacts,
      ]);
    }
    if (raw.audio !== null) {
      const a = raw.audio;
      if (
        raw.source_ref.media_type !== "audio/wav" ||
        request.audio_policy !== "measure_pcm" ||
        a.spans.length !== raw.required_spans.length ||
        a.spans.length !== raw.outputs.length
      )
        throw new Error("media PCM coverage");
      const source = inspectCanonicalPcmWav(
        readExact(b.store, b.project_id, raw.source_ref, policy.max_input_bytes),
        policy
      );
      if (
        a.sample_rate !== source.sample_rate ||
        a.decoded_sample_count !== source.samples ||
        a.channels !== (source.channels === 1 ? "mono" : "stereo")
      )
        throw new Error("media PCM source drift");
      equal(
        a.duration,
        rationalTime(BigInt(source.samples), BigInt(source.sample_rate)),
        "decoded audio duration"
      );
      for (const [index, span] of a.spans.entries()) {
        const requiredSpan = requireValue(request.required_spans[index], "requested audio span");
        equal(
          requiredSpan.start,
          rationalTime(BigInt(span.start_sample), BigInt(source.sample_rate)),
          "audio span start"
        );
        equal(
          requiredSpan.end,
          rationalTime(BigInt(span.end_sample), BigInt(source.sample_rate)),
          "audio span end"
        );
        const pcm = inspectCanonicalPcmWav(
          readExact(b.store, b.project_id, outputRef(span.slot), policy.max_output_bytes),
          policy
        );
        const expected = source.data.subarray(
          span.start_sample * source.channels * 2,
          span.end_sample * source.channels * 2
        );
        if (
          span.start_sample < 0 ||
          span.end_sample > source.samples ||
          span.start_sample >= span.end_sample ||
          !pcm.data.equals(expected) ||
          pcm.sample_rate !== source.sample_rate ||
          pcm.channels !== source.channels
        )
          throw new Error("media decoded PCM range drift");
        equal(
          measurePcm16(pcm.data),
          { peak_abs_s16: span.peak_abs_s16, sum_squares: span.sum_squares },
          "PCM measurements"
        );
      }
      // Existing AudioMeasurementV1 has no partial-span vocabulary. Do not mislabel concatenated
      // spans as a full performance or fabricate LUFS, speech intervals, alignment or AudioEvidence.
      const span = a.spans[0];
      if (a.spans.length === 1 && span?.start_sample === 0 && span.end_sample === source.samples) {
        const measurement = validateAudioMeasurement(
          {
            schema_id: "penny.videogen-audio-measurement.v1",
            schema_version: 1,
            source_ref: raw.source_ref,
            source_track_ids: ["pcm-track-0"],
            track_codecs: ["canonical_pcm"],
            decoded_sample_count: a.decoded_sample_count,
            sample_rate: { numerator: a.sample_rate, denominator: 1 },
            channels: a.channels,
            measured_sync_offsets: [],
            decode_receipt_ref: receiptRef,
          },
          b.limits
        );
        parseMediaJson(AudioMeasurementV1Schema, Buffer.from(canonicalJson(measurement)), b.limits);
        audioRef = this.persistWrapper(record, "audio-measurement", measurement, [
          rawRef,
          receiptRef,
          ...record.output_artifacts,
        ]);
      }
    }
    return {
      raw_ref: rawRef,
      receipt_ref: receiptRef,
      video_evidence_ref: videoRef,
      audio_measurement_ref: audioRef,
      production_admission: "blocked",
      missing_qualification: [
        "gated_effect_intent_integration",
        "post_receipt_wrapper_journal_milestone",
        "independent_playback_motion_speech_sync",
        "decoder_deployment_qualification",
      ],
    };
  }
  private persistWrapper(
    record: HostOperationCallRecordV1,
    name: string,
    value: unknown,
    upstream: ArtifactRef[]
  ): ArtifactRef {
    const content = canonicalJson(value);
    const b = this.b;
    const operationId = `media-evidence:${record.operation_record_id}:${name}`;
    const kind = `videogen-${name}`;
    const existing = b.store.refFor(
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
        existing.media_type !== "application/json" ||
        existing.producer !== "host:videogen-media-evidence"
      )
        throw new Error("media evidence wrapper coordinate conflict");
      equal(b.store.metadata(existing).upstream_refs, upstream, "wrapper custody edges");
      b.store.read(existing);
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
        producer: "host:videogen-media-evidence",
        media_type: "application/json",
        content_schema: { schema_id: `penny.videogen-${name}.v1`, schema_version: 1 },
        parent_ref: null,
        upstream_refs: upstream,
      },
      content,
    });
    equal(b.store.read(ref).toString("utf8"), content, "wrapper readback");
    return ref;
  }
}
