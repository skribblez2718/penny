import {
  SourcePreparationRequestSchema,
  sourcePreparationAdapter,
  materializeSourcePreparation,
  type SourcePreparationBindings,
} from "./runtime-preparation.js";
import { Type } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema as Ref,
  validateContract,
  type ArtifactRef,
  type HostOperationArtifactContractV1,
} from "../contracts.js";
import { OpaqueIdSchema } from "../skill-contracts/common.js";
import { encodeCanonicalPng } from "../png-media.js";
import type { HostOperationAdapterV1 } from "../host-operations/contracts.js";
import { isCanonicalHostOperationExecutionContextV1 } from "../host-operations/owner.js";
import { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import { compareNativeMedia, NativeMediaComparisonV1Schema } from "./native-media-comparison.js";
import { EditDecisionV1Schema } from "./edit-contracts.js";
import { sameRef, type FoundationLimitsV1 } from "./bounds.js";
import {
  MediaFrameSelectionV1Schema,
  VideoEvidenceV1Schema,
  MEDIA_FRAME_CONTRACT,
  MEDIA_PCM_CONTRACT,
  type MediaDecodePolicyV1,
} from "./media-contracts.js";
import {
  decodeMediaBytes,
  canonicalPcmWav,
  inspectCanonicalPcmWav,
  measurePcm16,
  selectMediaFrames,
} from "./media-decode.js";
import { rationalTime, quantizeBoundary, RationalTimeSchema } from "./rational-time.js";
import { parseRuntimeWireJson } from "./runtime-json.js";
import { SettledEvidenceCustody } from "./settled-evidence-custody.js";

import { AudioEvidenceV1Schema } from "./stage-contracts.js";
import { AudioSourceV1Schema, AudioMeasurementV1Schema } from "./audio-sources.js";
import { CurrentRightsV1Schema, RightsBindingV1Schema } from "./rights-ledger.js";
import type { VideogenRuntime } from "./runtime.js";
import type { RunContext } from "../context.js";
import { executionState, setSlot } from "./execution-state.js";

const closed = { additionalProperties: false } as const;
const contract = (name: string): HostOperationArtifactContractV1 => ({
  schema_version: 1,
  port_name: name,
  artifact_kind: name,
  schema_id: `penny.videogen-${name}.v1`,
  schema_version_required: 1,
});
export const NATIVE_MEDIA_REQUEST = contract("native-media-request"),
  NATIVE_MEDIA_RESULT = contract("native-media-result");
export const NativeMediaRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-media-request.v1"),
    schema_version: Type.Literal(1),
    operation_id: OpaqueIdSchema,
    media_ref: Ref,
    edit_ref: Ref,
    decode_policy_ref: Ref,
    frame_selection_ref: Ref,
    required_spans: Type.Array(
      Type.Object({ start: RationalTimeSchema, end: RationalTimeSchema }, closed),
      { minItems: 1, maxItems: 128 }
    ),
  },
  closed
);
export const SourceMediaRequestSchema = Type.Object(
  {
    ...Type.Omit(NativeMediaRequestSchema, ["edit_ref"]).properties,
    audio_policy: Type.Optional(Type.Union([Type.Literal("forbid"), Type.Literal("measure_pcm")])),
  },
  closed
);
const SourceResultSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-media-result.v1"),
    schema_version: Type.Literal(1),
    operation_id: OpaqueIdSchema,
    source_ref: Ref,
    raw_video: RawMediaDecodeResultV1Schema,
  },
  closed
);
const ResultSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-media-result.v1"),
    schema_version: Type.Literal(1),
    operation_id: OpaqueIdSchema,
    source_ref: Ref,
    edit_ref: Ref,
    comparison: NativeMediaComparisonV1Schema,
    frame_indices: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, maxItems: 128 }),
    outputs: Type.Array(
      Type.Object(
        {
          sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          bytes: Type.Integer({ minimum: 1 }),
          media_type: Type.String(),
        },
        closed
      ),
      { minItems: 2, maxItems: 129 }
    ),
  },
  closed
);

/** Narrow native-output decode, explicitly separate from strict imported-AV admission. Uses
 * the actual confined CPU profile and complete clocks; unknown LUFS/words/alignment stay unknown. */
export function createNativeMediaAdapter(b: {
  readonly runner: ConfinedMediaRunner;
  readonly policy: MediaDecodePolicyV1;
  readonly policy_ref: ArtifactRef;
  readonly limits: FoundationLimitsV1;
  readonly adapter_id: string;
  readonly backend_binding_id: string;
  readonly backend_key_sha256: string;
  readonly preparation?: SourcePreparationBindings;
}): HostOperationAdapterV1 {
  const parseRequest = (bytes: Uint8Array) =>
    validateContract(
      Type.Union([
        NativeMediaRequestSchema,
        SourceMediaRequestSchema,
        SourcePreparationRequestSchema,
      ]),
      parseRuntimeWireJson(bytes, b.limits),
      "runtime decode request"
    );
  const inspect: HostOperationAdapterV1["inspectRequest"] = (input) => {
    const r = parseRequest(input.request_bytes);
    if (
      input.directive.operation_id !== r.operation_id ||
      !sameRef(r.decode_policy_ref, b.policy_ref) ||
      canonicalJson(input.directive.input_artifacts.artifacts) !==
        canonicalJson([
          { slot: "media", ref: r.media_ref },
          ...("edit_ref" in r ? [{ slot: "edit", ref: r.edit_ref }] : []),
          ...("preparation" in r
            ? [
                { slot: "source-result", ref: r.source_result_ref },
                { slot: "source-receipt", ref: r.source_receipt_ref },
              ]
            : []),
          { slot: "decode-policy", ref: r.decode_policy_ref },
          ...("frame_selection_ref" in r
            ? [{ slot: "frame-selection", ref: r.frame_selection_ref }]
            : []),
        ])
    )
      throw new Error("native decode exact request operands");
    return {
      schema_version: 1,
      operation_kind: "media_decode_extract",
      adapter_id: b.adapter_id,
      backend_binding_id: b.backend_binding_id,
      backend_key_sha256: b.backend_key_sha256,
    };
  };
  return {
    adapter_id: b.adapter_id,
    inspectRequest: inspect,
    async run(ctx) {
      if (
        !isCanonicalHostOperationExecutionContextV1(ctx) ||
        ctx.journal.lifecycle !== "lease_acquired"
      )
        throw new Error("native decode original fresh owner required");
      inspect({
        directive: ctx.directive,
        declaration: ctx.declaration,
        request_bytes: ctx.request_bytes,
        input_artifacts: ctx.directive.input_artifacts,
      });
      const r = parseRequest(ctx.request_bytes);
      if ("preparation" in r) {
        if (!b.preparation) throw new Error("explicit preparation binding required");
        return sourcePreparationAdapter(b.preparation).run(ctx);
      }
      const selection = validateContract(
        MediaFrameSelectionV1Schema,
        parseRuntimeWireJson(ctx.readInput("frame-selection").bytes, b.limits),
        "native selection"
      );
      const policy = validateContract(
        MediaDecodePolicyV1Schema,
        parseRuntimeWireJson(ctx.readInput("decode-policy").bytes, b.limits),
        "native policy"
      );
      if (canonicalJson(policy) !== canonicalJson(b.policy))
        throw new Error("native decode policy drift");
      const bytes = Buffer.from(ctx.readInput("media").bytes);
      ctx.beginSubmission();
      let closedProcess = false;
      ctx.registerRemoteCancellation(async () =>
        closedProcess
          ? { remote_disposition: "proven_terminal", reason_code: "cpu_closed" }
          : { remote_disposition: "may_continue", reason_code: "cpu_cleanup_pending" }
      );
      const outputs: { bytes: Buffer; media_type: string }[] = [];
      let comparison;
      try {
        if (!("edit_ref" in r)) {
          const decoded = await decodeMediaBytes({
            runner: b.runner,
            policy: b.policy,
            limits: b.limits,
            selection,
            bytes,
            signal: ctx.signal,
            request: {
              ...r,
              schema_id: "penny.videogen-raw-media-decode-request.v1",
              audio_policy: r.audio_policy ?? "forbid",
            },
          });
          const content = canonicalJson({
            schema_id: NATIVE_MEDIA_RESULT.schema_id,
            schema_version: 1,
            operation_id: r.operation_id,
            source_ref: r.media_ref,
            raw_video: decoded.result,
          });
          ctx.reportActivity("source_full_decode", 1);
          ctx.recordFetched({
            schema_version: 1,
            content_sha256: sha256(content),
            byte_length: Buffer.byteLength(content),
            item_count: decoded.outputs.length,
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
            ...ctx.persist({
              disposition,
              operation_result: {
                contract: NATIVE_MEDIA_RESULT,
                media_type: "application/json",
                content,
              },
              outputs: decoded.outputs.map((o) => ({
                contract: o.media_type === "image/png" ? MEDIA_FRAME_CONTRACT : MEDIA_PCM_CONTRACT,
                media_type: o.media_type,
                content: o.bytes,
              })),
            }),
          };
        }
        const edit = validateContract(
            EditDecisionV1Schema,
            parseRuntimeWireJson(ctx.readInput("edit").bytes, b.limits),
            "native edit"
          ),
          frameCount = quantizeBoundary(edit.end_time, edit.canvas.fps, b.policy.max_frames).index;
        comparison = await compareNativeMedia({
          runner: b.runner,
          policy: b.policy,
          limits: b.limits,
          master: bytes,
          render: bytes,
          width: edit.canvas.width,
          height: edit.canvas.height,
          frame_rate: edit.canvas.fps,
          duration_frames: frameCount,
          signal: ctx.signal,
        });
        const pts = Array.from({ length: frameCount }, (_, i) =>
          rationalTime(
            BigInt(i) * BigInt(edit.canvas.fps.denominator),
            BigInt(edit.canvas.fps.numerator)
          )
        );
        const chosen = selectMediaFrames(
          pts,
          r.required_spans,
          selection,
          b.policy.max_selected_frames
        );
        const rgba = (
            await b.runner.run({
              verb: "av_video_rgba",
              bytes,
              policy: b.policy,
              signal: ctx.signal,
            })
          ).stdout,
          size = edit.canvas.width * edit.canvas.height * 4;
        if (rgba.length !== size * frameCount) throw new Error("native RGBA count");
        for (const i of chosen)
          outputs.push({
            bytes: Buffer.from(
              encodeCanonicalPng({
                width: edit.canvas.width,
                height: edit.canvas.height,
                rgba: rgba.subarray(i * size, (i + 1) * size),
              })
            ),
            media_type: "image/png",
          });
        const pcm = (
          await b.runner.run({
            verb: "av_audio_s16le",
            bytes,
            policy: b.policy,
            signal: ctx.signal,
          })
        ).stdout;
        if (pcm.length !== comparison.audio_samples * 2 || sha256(pcm) !== comparison.pcm_sha256)
          throw new Error("native PCM comparison drift");
        outputs.push({ bytes: canonicalPcmWav(pcm, 1, 48000), media_type: "audio/wav" });
        const value = validateContract(
          ResultSchema,
          {
            schema_id: NATIVE_MEDIA_RESULT.schema_id,
            schema_version: 1,
            operation_id: r.operation_id,
            source_ref: r.media_ref,
            edit_ref: r.edit_ref,
            comparison,
            frame_indices: chosen,
            outputs: outputs.map((o) => ({
              sha256: sha256(o.bytes),
              bytes: o.bytes.length,
              media_type: o.media_type,
            })),
          },
          "native decoded product"
        );
        const content = canonicalJson(value);
        if (
          outputs.reduce((n, o) => n + o.bytes.length, Buffer.byteLength(content)) >
          b.policy.max_output_bytes
        )
          throw new Error("native media output byte cap");
        ctx.reportActivity("native_full_decode", 1);
        ctx.recordFetched({
          schema_version: 1,
          content_sha256: sha256(content),
          byte_length: Buffer.byteLength(content),
          item_count: outputs.length,
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
          ...ctx.persist({
            disposition,
            operation_result: {
              contract: NATIVE_MEDIA_RESULT,
              media_type: "application/json",
              content,
            },
            outputs: outputs.map((o) => ({
              contract: o.media_type === "image/png" ? MEDIA_FRAME_CONTRACT : MEDIA_PCM_CONTRACT,
              media_type: o.media_type,
              content: o.bytes,
            })),
          }),
        };
      } finally {
        closedProcess = true;
      }
    },
  };
}

/** Project semantic evidence only after exact existing settlement, never from a raw PASS flag. */
export function materializeRuntimeMedia(
  r: VideogenRuntime,
  c: RunContext,
  recordId: string,
  registration: string,
  stage: string,
  subject: string
): void {
  const owners = r.providers.host_owners,
    provider = r.providers.effects.get("media_decode_extract"),
    record = r.checkpointer.hostOperationCall(recordId);
  if (!owners || !provider?.media || !record?.operation_result_ref)
    throw new Error("runtime media concrete custody required");
  const binding = {
    project_id: r.project_id,
    store: r.store,
    checkpointer: r.checkpointer,
    leases: owners.leases,
    limits: r.config.limits,
    registration_sha256: registration,
    declaration: provider.declaration,
    backend_key_sha256: record.policy_binding.backend_key_sha256,
    policy_ref: provider.media.policy_ref,
  };
  const s = executionState(c),
    videoSlot =
      stage === "rough"
        ? "rough_video"
        : stage === "finished"
          ? "master_video"
          : `video-${subject}`,
    audioSlot = stage === "rough" ? "rough_audio" : "master_audio";
  const custody = new SettledEvidenceCustody(binding).verifySettled(recordId, NATIVE_MEDIA_RESULT);
  if (materializeSourcePreparation(r, c, custody, subject)) return;
  const either = custody.read(
    custody.rawRef,
    Type.Union([SourceResultSchema, ResultSchema]),
    NATIVE_MEDIA_RESULT.schema_id
  );
  if ("raw_video" in either) {
    const raw = either.raw_video,
      request = custody.read(
        record.request_ref,
        SourceMediaRequestSchema,
        NATIVE_MEDIA_REQUEST.schema_id
      );
    if (
      (raw.video === null && raw.audio === null) ||
      !sameRef(raw.source_ref, request.media_ref) ||
      raw.operation_id !== record.operation_id ||
      raw.request_sha256 !==
        sha256(
          canonicalJson({
            ...request,
            schema_id: "penny.videogen-raw-media-decode-request.v1",
            audio_policy: request.audio_policy ?? "forbid",
          })
        ) ||
      raw.policy_sha256 !== request.decode_policy_ref.content_digest ||
      raw.selection_sha256 !== request.frame_selection_ref.content_digest ||
      canonicalJson(raw.required_spans) !== canonicalJson(request.required_spans) ||
      raw.outputs.length !== record.output_artifacts.length
    )
      throw new Error("runtime video timing/custody missing");
    for (const [i, ref] of record.output_artifacts.entries()) {
      const d = raw.outputs[i];
      if (
        !d ||
        d.sha256 !== ref.content_digest ||
        d.byte_length !== ref.byte_length ||
        d.media_type !== ref.media_type
      )
        throw new Error("runtime source frame custody drift");
      r.store.read(ref);
    }
    if (raw.audio !== null && raw.video === null) {
      const asset = r.config.assets.find((a) => a.asset_id === subject);
      if (
        stage !== "asset" ||
        !asset ||
        !["supplied", "public_licensed"].includes(asset.source) ||
        !asset.input_refs.some((ref) => sameRef(ref, raw.source_ref)) ||
        request.audio_policy !== "measure_pcm"
      )
        throw new Error("supplied audio exact approved asset required");
      const selection = validateContract(
        Type.Object({ rights: Type.Array(CurrentRightsV1Schema) }),
        c.playbookData.videogen_owner_selection,
        "supplied audio grants"
      );
      const selected = selection.rights.find(
        (v) => sameRef(v.subject_ref, raw.source_ref) && v.status === "cleared"
      );
      if (!selected || !sameRef(selected.rights_ref, asset.rights_ref))
        throw new Error("supplied audio current grant required");
      const rights = r.read(selected.rights_ref, RightsBindingV1Schema),
        audio = raw.audio;
      const measurement = r.seal(
        c,
        "audio-measurement",
        {
          schema_id: "penny.videogen-audio-measurement.v1",
          schema_version: 1,
          source_ref: raw.source_ref,
          source_track_ids: ["pcm_track"],
          track_codecs: ["canonical_pcm"],
          decoded_sample_count: audio.decoded_sample_count,
          sample_rate: { numerator: audio.sample_rate, denominator: 1 },
          channels: audio.channels,
          measured_sync_offsets: [],
          decode_receipt_ref: custody.receiptRef,
        },
        [custody.rawRef, custody.receiptRef],
        AudioMeasurementV1Schema
      );
      const source = r.seal(
        c,
        "audio-source",
        {
          schema_id: "penny.videogen-audio-source.v1",
          schema_version: 1,
          source_kind: asset.source,
          media_ref: raw.source_ref,
          rights_ref: selected.rights_ref,
          consent_ref: asset.consent_ref,
          role: "narration",
          placement: { numerator: 0, denominator: 1 },
          duration: audio.duration,
          decoded_audio_ref: custody.receiptRef,
          channels: audio.channels,
          sample_rate: { numerator: audio.sample_rate, denominator: 1 },
          codec: "canonical_pcm",
          provenance_ref: rights.provenance_ref,
        },
        [custody.rawRef, custody.receiptRef, measurement],
        AudioSourceV1Schema
      );
      const peak = Math.max(...audio.spans.map((s) => s.peak_abs_s16));
      const evidence = r.seal(
        c,
        "audio-evidence",
        {
          schema_id: "penny.videogen-audio-evidence.v1",
          schema_version: 1,
          audio_ref: raw.source_ref,
          decode_receipt_ref: custody.receiptRef,
          codec: "canonical_pcm",
          channels: audio.channels,
          sample_rate: { numerator: audio.sample_rate, denominator: 1 },
          sample_count: audio.decoded_sample_count,
          decoded_duration: audio.duration,
          peak_dbfs: peak === 0 ? null : 20 * Math.log10(peak / 32768),
          loudness_lufs: null,
          speech_intervals: [],
          sync_offsets: [],
          unassessed: ["intelligibility", "identity", "word_alignment"],
        },
        [custody.rawRef, custody.receiptRef, ...record.output_artifacts],
        AudioEvidenceV1Schema
      );
      setSlot(c, s, `audio_source-${subject}`, source);
      setSlot(c, s, `audio_measurement-${subject}`, measurement);
      setSlot(c, s, `audio_evidence-${subject}`, evidence);
      return;
    }
    if (!raw.video || raw.audio !== null)
      throw new Error("source decode strict single-media contract required");
    const video = r.seal(
      c,
      "video-evidence",
      {
        schema_id: "penny.videogen-video-evidence.v1",
        schema_version: 1,
        source_clip_ref: raw.source_ref,
        decode_profile_ref: request.decode_policy_ref,
        container_validation_ref: custody.rawRef,
        full_decode_ref: custody.rawRef,
        frames: raw.video.frames
          .map((f, i) => ({ ...f, png_ref: record.output_artifacts[i] }))
          .map(({ index, pts, png_ref }) => ({ index, pts, png_ref })),
        limits: {
          max_frames: raw.video.frames.length,
          max_bytes: r.config.envelope.max_output_bytes,
          selection_rule_id: "span-boundaries-and-nearest-even-v1",
        },
        unassessed: ["motion", "speech", "sound", "sync"],
      },
      [custody.rawRef, custody.receiptRef, ...record.output_artifacts],
      VideoEvidenceV1Schema
    );
    setSlot(c, s, videoSlot, video);
    setSlot(
      c,
      s,
      `measured-${subject}`,
      r.seal(
        c,
        "edit-source",
        {
          schema_id: "penny.videogen-edit-source.v1",
          schema_version: 1,
          source_ref: raw.source_ref,
          measured_ticks: raw.video.decoded_frame_count,
          timebase: rationalTime(
            BigInt(raw.video.duration.numerator),
            BigInt(raw.video.duration.denominator) * BigInt(raw.video.decoded_frame_count)
          ),
          decoded_duration: raw.video.duration,
          source_frame_rate: rationalTime(
            BigInt(raw.video.decoded_frame_count) * BigInt(raw.video.duration.denominator),
            BigInt(raw.video.duration.numerator)
          ),
          decode_record_ref: custody.rawRef,
        },
        [custody.rawRef, custody.receiptRef],
        MeasuredEditSourceV1Schema
      )
    );
    return;
  }
  const raw = custody.read(custody.rawRef, ResultSchema, NATIVE_MEDIA_RESULT.schema_id),
    request = custody.read(
      record.request_ref,
      NativeMediaRequestSchema,
      NATIVE_MEDIA_REQUEST.schema_id
    );
  if (
    !sameRef(raw.source_ref, request.media_ref) ||
    !sameRef(raw.edit_ref, request.edit_ref) ||
    raw.operation_id !== record.operation_id ||
    raw.comparison.master_sha256 !== request.media_ref.content_digest ||
    raw.outputs.length !== record.output_artifacts.length ||
    raw.frame_indices.length + 1 !== raw.outputs.length
  )
    throw new Error("native decode custody operands");
  for (const [i, ref] of record.output_artifacts.entries()) {
    const d = raw.outputs[i];
    if (
      !d ||
      d.sha256 !== ref.content_digest ||
      d.bytes !== ref.byte_length ||
      d.media_type !== ref.media_type
    )
      throw new Error("native decode output custody");
    r.store.read(ref);
  }
  const pcmRef = record.output_artifacts.at(-1);
  if (!pcmRef) throw new Error("native PCM missing");
  const pcm = inspectCanonicalPcmWav(r.store.read(pcmRef), {
    ...r.read(request.decode_policy_ref, MediaDecodePolicyV1Schema),
    max_input_bytes: r.config.envelope.max_output_bytes,
  });
  if (
    pcm.samples !== raw.comparison.audio_samples ||
    pcm.sample_rate !== 48000 ||
    pcm.channels !== 1 ||
    sha256(pcm.data) !== raw.comparison.pcm_sha256
  )
    throw new Error("native PCM summary custody");
  const video = r.seal(
    c,
    "video-evidence",
    {
      schema_id: "penny.videogen-video-evidence.v1",
      schema_version: 1,
      source_clip_ref: raw.source_ref,
      decode_profile_ref: request.decode_policy_ref,
      container_validation_ref: custody.rawRef,
      full_decode_ref: custody.rawRef,
      frames: raw.frame_indices.map((index, i) => ({
        index,
        pts: rationalTime(
          BigInt(index) * BigInt(raw.comparison.video_step),
          BigInt(raw.comparison.video_timescale)
        ),
        png_ref: record.output_artifacts[i],
      })),
      limits: {
        max_frames: raw.frame_indices.length,
        max_bytes: r.config.envelope.max_output_bytes,
        selection_rule_id: "span-boundaries-and-nearest-even-v1",
      },
      unassessed: ["motion", "speech", "sound", "sync"],
    },
    [custody.rawRef, custody.receiptRef, ...record.output_artifacts],
    VideoEvidenceV1Schema
  );
  const peak = measurePcm16(pcm.data).peak_abs_s16;
  const audio = r.seal(
    c,
    "audio-evidence",
    {
      schema_id: "penny.videogen-audio-evidence.v1",
      schema_version: 1,
      audio_ref: raw.source_ref,
      decode_receipt_ref: custody.receiptRef,
      codec: "canonical_pcm",
      channels: "mono",
      sample_rate: { numerator: 48000, denominator: 1 },
      sample_count: pcm.samples,
      decoded_duration: rationalTime(BigInt(pcm.samples), 48000n),
      peak_dbfs: peak === 0 ? null : 20 * Math.log10(peak / 32768),
      loudness_lufs: null,
      speech_intervals: [],
      sync_offsets: [],
      unassessed: ["intelligibility", "identity", "word_alignment"],
    },
    [custody.rawRef, custody.receiptRef, pcmRef],
    AudioEvidenceV1Schema
  );
  setSlot(c, s, videoSlot, video);
  setSlot(c, s, audioSlot, audio);
}
import { MediaDecodePolicyV1Schema, RawMediaDecodeResultV1Schema } from "./media-contracts.js";
import { MeasuredEditSourceV1Schema } from "./edit-contracts.js";
