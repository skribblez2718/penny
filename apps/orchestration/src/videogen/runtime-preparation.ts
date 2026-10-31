import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema as Ref, validateContract, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema as Id, Sha256Schema } from "../skill-contracts/common.js";
import type {
  HostOperationAdapterV1,
  HostOperationDeclarationV1,
  HostOperationExecutionContextV1,
} from "../host-operations/contracts.js";
import { HostOperationReceiptV1Schema } from "../host-operations/contracts.js";
import { normalizeImportedAvc } from "./avc-normalization.js";
import { ConfinedMediaRunner } from "../host-operations/confined-media-runner.js";
import { inspectCanonicalPcmWav, canonicalPcmWav, measurePcm16 } from "./media-decode.js";
import { MediaDecodePolicyV1Schema, type MediaDecodePolicyV1 } from "./media-contracts.js";
import { RationalTimeSchema, rationalTime, quantizeBoundary } from "./rational-time.js";
import {
  SettledEvidenceCustody,
  type SettledEvidenceCustodyBindingsV1,
} from "./settled-evidence-custody.js";
import { sameRef, type FoundationLimitsV1 } from "./bounds.js";
import { parseRuntimeWireJson } from "./runtime-json.js";
import { readVideogenOwnerSelection, VideogenOwnerSelection } from "./owner-selection.js";
import { executionState, slot, setSlot } from "./execution-state.js";
import type { VideogenRuntime } from "./runtime.js";
import type { RunContext } from "../context.js";
import { AudioMeasurementV1Schema, AudioSourceV1Schema } from "./audio-sources.js";
import { AudioEvidenceV1Schema } from "./stage-contracts.js";
import { RightsBindingV1Schema, checkRights } from "./rights-ledger.js";
import { VideoGenerationOperationRequestV1Schema } from "./contracts.js";

const closed = { additionalProperties: false } as const;
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const SourcePreparationRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-media-request.v1"),
    schema_version: Type.Literal(1),
    operation_id: Id,
    subject_id: Id,
    media_ref: Ref,
    source_result_ref: Ref,
    source_receipt_ref: Ref,
    decode_policy_ref: Ref,
    preparation: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("avc_import"),
          width: positive,
          height: positive,
          frame_count: positive,
          fps: positive,
          max_bytes: positive,
        },
        closed
      ),
      Type.Object({ kind: Type.Literal("pcm_silence_pad"), duration: RationalTimeSchema }, closed),
    ]),
  },
  closed
);
export const PREPARED_VIDEO = {
  schema_version: 1,
  port_name: "canonical_video",
  artifact_kind: "videogen-canonical-video",
  schema_id: "penny.videogen-canonical-video.v1",
  schema_version_required: 1,
} as const;
export const PREPARED_PCM = {
  schema_version: 1,
  port_name: "prepared_pcm",
  artifact_kind: "videogen-prepared-pcm",
  schema_id: "penny.videogen-prepared-pcm.v1",
  schema_version_required: 1,
} as const;
export const SourcePreparationResultSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-media-result.v1"),
    schema_version: Type.Literal(1),
    operation_id: Id,
    source_ref: Ref,
    source_result_ref: Ref,
    source_receipt_ref: Ref,
    prepared_sha256: Sha256Schema,
    prepared_bytes: positive,
    preparation: SourcePreparationRequestSchema.properties.preparation,
    // The full bounded transform record is retained, never substituted for the producer receipt.
    transform_receipt: Type.Union([
      Type.Object(
        {
          schema_id: Type.Literal("penny.videogen-avc-normalization.v1"),
          schema_version: Type.Literal(1),
          transform: Type.Literal("cpu_h264_baseline_lossy_reencode_metadata_removed"),
          raw_sha256: Sha256Schema,
          raw_bytes: positive,
          normalized_sha256: Sha256Schema,
          normalized_bytes: positive,
          byte_equal: Type.Boolean(),
          lossless: Type.Literal(false),
          runtime_sha256: Sha256Schema,
          width: positive,
          height: positive,
          decoded_frame_count: positive,
          fps: positive,
          qualification: Type.Literal(
            "media_compatibility_only_not_job_custody_rights_or_playback"
          ),
        },
        closed
      ),
      Type.Object(
        {
          transform: Type.Literal("canonical_pcm_zero_tail_only"),
          raw_sha256: Sha256Schema,
          raw_samples: positive,
          padded_samples: Type.Integer({ minimum: 0 }),
          sample_rate: positive,
          channels: positive,
          speech_trimmed: Type.Literal(false),
          resampled: Type.Literal(false),
        },
        closed
      ),
    ]),
  },
  closed
);
export interface SourcePreparationBindings {
  readonly runner: ConfinedMediaRunner;
  readonly policy: MediaDecodePolicyV1;
  readonly policy_ref: ArtifactRef;
  readonly limits: FoundationLimitsV1;
  readonly owner: VideogenOwnerSelection;
  readonly custody: Omit<
    SettledEvidenceCustodyBindingsV1,
    "declaration" | "backend_key_sha256" | "registration_sha256"
  >;
  readonly sourceDeclaration: (kind: string) => HostOperationDeclarationV1;
}
/** Recheck the exact consumed producer, current source selection and original receipt. No scans,
 * cached caller status, replacement /view bytes or new generation request can grant custody. */
function sourceCustody(
  b: Pick<SourcePreparationBindings, "owner" | "custody" | "sourceDeclaration" | "limits">,
  request: ReturnType<typeof parseRequest>,
  registration: string
) {
  const receipt = validateContract(
    HostOperationReceiptV1Schema,
    parseRuntimeWireJson(b.custody.store.read(request.source_receipt_ref), b.limits),
    "preparation source receipt"
  );
  const record = b.custody.checkpointer.hostOperationCall(receipt.operation_record_id);
  const kind = request.preparation.kind === "avc_import" ? "video_render" : "voice_job";
  if (
    !record ||
    record.lifecycle !== "consumed" ||
    record.operation_kind !== kind ||
    record.identity.run_id !== readVideogenOwnerSelection(b.owner).gate.run_id ||
    !record.operation_result_ref ||
    !record.host_receipt_ref ||
    !sameRef(record.operation_result_ref, request.source_result_ref) ||
    !sameRef(record.host_receipt_ref, request.source_receipt_ref) ||
    !record.output_artifacts.some((ref) => sameRef(ref, request.media_ref))
  )
    throw new Error("preparation exact consumed producer required");
  const declaration = b.sourceDeclaration(kind);
  new SettledEvidenceCustody({
    ...b.custody,
    declaration,
    registration_sha256: registration,
    backend_key_sha256: record.policy_binding.backend_key_sha256,
  }).verifySettled(record.operation_record_id, declaration.result);
  const current = readVideogenOwnerSelection(b.owner).gate.checkpointer.loadRunById(
    record.identity.run_id
  );
  if (
    !current ||
    current.terminalDirective ||
    !sameRef(
      slot(
        executionState(current),
        kind === "video_render" ? `clip-${request.subject_id}` : "performance"
      ),
      request.media_ref
    )
  )
    throw new Error("preparation current selected raw source required");
  const rightsHost = readVideogenOwnerSelection(b.owner).rights;
  const grant = rightsHost.current_rights.find((row) =>
    sameRef(row.subject_ref, request.media_ref)
  );
  if (!grant) throw new Error("preparation source rights are not selected");
  checkRights(rightsHost, request.media_ref, grant.rights_ref, "preview");
  if (request.preparation.kind === "avc_import") {
    const generation = validateContract(
      VideoGenerationOperationRequestV1Schema,
      parseRuntimeWireJson(b.custody.store.read(record.request_ref), b.limits),
      "original render request"
    );
    const p = request.preparation;
    if (
      generation.shot_id !== request.subject_id ||
      generation.dimensions.width !== p.width ||
      generation.dimensions.height !== p.height ||
      generation.frame_count !== p.frame_count ||
      generation.fps !== p.fps
    )
      throw new Error("preparation original render dimensions/timing drift");
  }
}
function parseRequest(bytes: Uint8Array, limits: FoundationLimitsV1) {
  return validateContract(
    SourcePreparationRequestSchema,
    parseRuntimeWireJson(bytes, limits),
    "source preparation request"
  );
}
/** A complete canonical PCM source is preserved byte-for-byte in the data section. */
export function padCanonicalPcmTail(
  raw: Buffer,
  policy: MediaDecodePolicyV1,
  duration: Static<typeof RationalTimeSchema>
) {
  const pcm = inspectCanonicalPcmWav(raw, policy),
    samples = quantizeBoundary(
      duration,
      { numerator: pcm.sample_rate, denominator: 1 },
      policy.max_samples
    );
  if (
    samples.residual.numerator !== 0 ||
    samples.index < pcm.samples ||
    samples.index * pcm.channels * 2 + 44 > policy.max_output_bytes
  )
    throw new Error("VOICE_FIT_REQUIRES_HUMAN: no speech trimming or oversized padding");
  const data = Buffer.alloc(samples.index * pcm.channels * 2);
  pcm.data.copy(data);
  const bytes = canonicalPcmWav(data, pcm.channels, pcm.sample_rate);
  return {
    bytes,
    receipt: {
      transform: "canonical_pcm_zero_tail_only",
      raw_sha256: sha256(raw),
      raw_samples: pcm.samples,
      padded_samples: samples.index - pcm.samples,
      sample_rate: pcm.sample_rate,
      channels: pcm.channels,
      speech_trimmed: false,
      resampled: false,
    },
  };
}
export function sourcePreparationAdapter(
  b: SourcePreparationBindings
): Pick<HostOperationAdapterV1, "run"> {
  return {
    async run(ctx: HostOperationExecutionContextV1) {
      const request = parseRequest(ctx.request_bytes, b.limits);
      sourceCustody(b, request, ctx.directive.registration_sha256);
      const policy = validateContract(
        MediaDecodePolicyV1Schema,
        parseRuntimeWireJson(ctx.readInput("decode-policy").bytes, b.limits),
        "preparation policy"
      );
      if (
        !sameRef(request.decode_policy_ref, b.policy_ref) ||
        canonicalJson(policy) !== canonicalJson(b.policy)
      )
        throw new Error("preparation pinned policy required");
      const raw = Buffer.from(ctx.readInput("media").bytes);
      ctx.beginSubmission();
      let done = false;
      ctx.registerRemoteCancellation(async () =>
        done
          ? { remote_disposition: "proven_terminal", reason_code: "cpu_closed" }
          : { remote_disposition: "may_continue", reason_code: "cpu_cleanup_pending" }
      );
      try {
        let bytes: Buffer, transform_receipt;
        if (request.preparation.kind === "avc_import") {
          const normalized = await normalizeImportedAvc({
            runner: b.runner,
            policy,
            bytes: raw,
            expected: {
              width: request.preparation.width,
              height: request.preparation.height,
              frame_count: request.preparation.frame_count,
              fps: request.preparation.fps,
              max_bytes: request.preparation.max_bytes,
            },
            signal: ctx.signal,
          });
          bytes = normalized.bytes;
          transform_receipt = normalized.receipt;
        } else {
          const padded = padCanonicalPcmTail(raw, policy, request.preparation.duration);
          bytes = padded.bytes;
          transform_receipt = padded.receipt;
        }
        ctx.signal.throwIfAborted();
        sourceCustody(b, request, ctx.directive.registration_sha256);
        const content = canonicalJson(
          validateContract(
            SourcePreparationResultSchema,
            {
              schema_id: "penny.videogen-native-media-result.v1",
              schema_version: 1,
              operation_id: request.operation_id,
              source_ref: request.media_ref,
              source_result_ref: request.source_result_ref,
              source_receipt_ref: request.source_receipt_ref,
              prepared_sha256: sha256(bytes),
              prepared_bytes: bytes.length,
              preparation: request.preparation,
              transform_receipt,
            },
            "source preparation result"
          )
        );
        ctx.recordFetched({
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
          ...ctx.persist({
            disposition,
            operation_result: {
              contract: ctx.declaration.result,
              media_type: "application/json",
              content,
            },
            outputs: [
              {
                contract: request.preparation.kind === "avc_import" ? PREPARED_VIDEO : PREPARED_PCM,
                media_type: request.preparation.kind === "avc_import" ? "video/mp4" : "audio/wav",
                content: bytes,
              },
            ],
          }),
        };
      } finally {
        done = true;
      }
    },
  };
}
/** Called in the existing settled→consumed continuation. Selection and the owner consumption
 * commit share the source-checkpoint fence; canonical bytes have their OWN operation receipt. */
export function materializeSourcePreparation(
  r: VideogenRuntime,
  c: RunContext,
  custody: ReturnType<SettledEvidenceCustody["verifySettled"]>,
  subject: string
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(r.store.read(custody.rawRef).toString());
  } catch {
    return false;
  }
  if (value === null || typeof value !== "object" || !("preparation" in value)) return false;
  const raw = validateContract(SourcePreparationResultSchema, value, "settled preparation"),
    request = custody.read(
      custody.record.request_ref,
      SourcePreparationRequestSchema,
      "penny.videogen-native-media-request.v1"
    ),
    output = custody.record.output_artifacts[0];
  if (
    !output ||
    custody.record.output_artifacts.length !== 1 ||
    raw.operation_id !== custody.record.operation_id ||
    !sameRef(raw.source_ref, request.media_ref) ||
    !sameRef(raw.source_result_ref, request.source_result_ref) ||
    !sameRef(raw.source_receipt_ref, request.source_receipt_ref) ||
    canonicalJson(raw.preparation) !== canonicalJson(request.preparation) ||
    output.content_digest !== raw.prepared_sha256 ||
    output.byte_length !== raw.prepared_bytes
  )
    throw new Error("settled preparation exact output drift");
  if (request.subject_id !== subject) throw new Error("preparation subject drift");
  const owners = r.providers.host_owners;
  if (!owners) throw new Error("preparation concrete owners required");
  sourceCustody(
    {
      owner: new VideogenOwnerSelection({
        store: r.store,
        checkpointer: r.checkpointer,
        project_id: r.project_id,
        run_id: c.identity.run_id,
      }),
      limits: r.config.limits,
      custody: {
        store: r.store,
        checkpointer: r.checkpointer,
        project_id: r.project_id,
        leases: owners.leases,
        limits: r.config.limits,
      },
      sourceDeclaration: (kind) => {
        const provider = r.providers.effects.get(kind);
        if (!provider) throw new Error("preparation producer declaration missing");
        return provider.declaration;
      },
    },
    request,
    custody.record.registration_sha256
  );
  const selectedRaw = slot(
    executionState(c),
    raw.preparation.kind === "avc_import" ? `clip-${subject}` : "performance"
  );
  if (!sameRef(selectedRaw, request.media_ref))
    throw new Error("preparation current continuation selection drift");
  r.store.read(output);
  const s = executionState(c),
    rightsRef = r.inheritRights(
      c,
      output,
      [request.media_ref],
      custody.receiptRef,
      raw.preparation.kind === "avc_import" ? "video" : "voice"
    );
  setSlot(c, s, `preparation-${subject}`, custody.rawRef);
  if (raw.preparation.kind === "avc_import") {
    setSlot(c, s, `raw-clip-${subject}`, request.media_ref);
    setSlot(c, s, `clip-${subject}`, output);
  } else {
    const policy = r.read(request.decode_policy_ref, MediaDecodePolicyV1Schema),
      pcm = inspectCanonicalPcmWav(r.store.read(output), policy),
      duration = rationalTime(BigInt(pcm.samples), BigInt(pcm.sample_rate)),
      rights = r.read(rightsRef, RightsBindingV1Schema),
      previous = r.read(slot(s, `audio_source-${subject}`), AudioSourceV1Schema),
      channels = pcm.channels === 1 ? "mono" : "stereo",
      measurement = r.seal(
        c,
        "audio-measurement",
        {
          schema_id: "penny.videogen-audio-measurement.v1",
          schema_version: 1,
          source_ref: output,
          source_track_ids: ["pcm_track"],
          track_codecs: ["canonical_pcm"],
          decoded_sample_count: pcm.samples,
          sample_rate: { numerator: pcm.sample_rate, denominator: 1 },
          channels,
          measured_sync_offsets: [],
          decode_receipt_ref: custody.receiptRef,
        },
        [custody.rawRef, custody.receiptRef, output],
        AudioMeasurementV1Schema
      ),
      source = r.seal(
        c,
        "audio-source",
        {
          ...previous,
          media_ref: output,
          rights_ref: rightsRef,
          duration,
          decoded_audio_ref: custody.receiptRef,
          provenance_ref: rights.provenance_ref,
        },
        [custody.rawRef, custody.receiptRef, measurement, rightsRef],
        AudioSourceV1Schema
      ),
      peak = measurePcm16(pcm.data).peak_abs_s16,
      evidence = r.seal(
        c,
        "audio-evidence",
        {
          schema_id: "penny.videogen-audio-evidence.v1",
          schema_version: 1,
          audio_ref: output,
          decode_receipt_ref: custody.receiptRef,
          codec: "canonical_pcm",
          channels,
          sample_rate: { numerator: pcm.sample_rate, denominator: 1 },
          sample_count: pcm.samples,
          decoded_duration: duration,
          peak_dbfs: peak ? 20 * Math.log10(peak / 32768) : null,
          loudness_lufs: null,
          speech_intervals: [],
          sync_offsets: [],
          unassessed: ["intelligibility", "identity", "word_alignment"],
        },
        [custody.rawRef, custody.receiptRef, measurement],
        AudioEvidenceV1Schema
      );
    setSlot(c, s, "raw-performance", request.media_ref);
    setSlot(c, s, "performance", output);
    setSlot(c, s, `audio_source-${subject}`, source);
    setSlot(c, s, `audio_measurement-${subject}`, measurement);
    setSlot(c, s, `audio_evidence-${subject}`, evidence);
  }
  return true;
}
