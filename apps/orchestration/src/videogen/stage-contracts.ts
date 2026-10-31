import { Type, type Static } from "typebox";
import { ArtifactRefSchema as Ref, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema as Id, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";
import { RationalTimeSchema as Time, RationalRateSchema as Rate } from "./rational-time.js";
import { ShotModeV1Schema, ShotPortV1Schema } from "./shot-modes.js";
import { MeterSchema, VideogenHostOperationKindSchema as Kind } from "./foundation-contracts.js";
const closed = { additionalProperties: false } as const;
const refs = Type.Array(Ref, { uniqueItems: true, maxItems: 1024 });
const ids = Type.Array(Id, { uniqueItems: true, maxItems: 1024 });
const text = Type.String({ minLength: 1, maxLength: 16384 });
const texts = Type.Array(text, { maxItems: 128 });
const semantic = <N extends string>(name: N) => ({
  schema_id: Type.Literal(`penny.videogen-${name}.v1`),
  schema_version: Type.Literal(1),
});
const disposition = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("repair"),
  Type.Literal("blocked"),
]);
export const AudioEvidenceV1Schema = Type.Object(
  {
    ...semantic("audio-evidence"),
    audio_ref: Ref,
    decode_receipt_ref: Ref,
    codec: Id,
    channels: Type.Union([Type.Literal("mono"), Type.Literal("stereo")]),
    sample_rate: Rate,
    sample_count: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    decoded_duration: Time,
    // null is an explicitly unavailable measurement (including -infinity for digital silence),
    // never zero or an estimated loudness inserted by a decoder.
    peak_dbfs: Type.Union([Type.Number(), Type.Null()]),
    loudness_lufs: Type.Union([Type.Number(), Type.Null()]),
    speech_intervals: Type.Array(Type.Object({ start: Time, end: Time }, closed)),
    script_ref: Type.Optional(Ref),
    chunk_coverage_ref: Type.Optional(Ref),
    alignment_ref: Type.Optional(Ref),
    sync_offsets: Type.Array(Type.Object({ line_id: Id, offset: Time }, closed)),
    unassessed: Type.Array(
      Type.Union([
        Type.Literal("intelligibility"),
        Type.Literal("identity"),
        Type.Literal("word_alignment"),
      ]),
      { uniqueItems: true }
    ),
  },
  closed
);
export const PlaybackReviewV1Schema = Type.Object(
  {
    ...semantic("playback-review"),
    target_ref: Ref,
    target_digest: Sha256Schema,
    reviewer_kind: Type.Union([Type.Literal("human"), Type.Literal("qualified_av")]),
    reviewer_id: Id,
    capability_receipt_ref: Type.Optional(Ref),
    playback_device_profile_ref: Ref,
    complete_viewing: Type.Boolean(),
    heard_audio: Type.Boolean(),
    observations: Type.Array(
      Type.Object(
        {
          time: Time,
          criterion: Id,
          verdict: Type.Union([
            Type.Literal("pass"),
            Type.Literal("fail"),
            Type.Literal("uncertain"),
          ]),
          note: text,
        },
        closed
      ),
      { minItems: 1 }
    ),
    motion_verdict: Type.Union([
      Type.Literal("pass"),
      Type.Literal("fail"),
      Type.Literal("uncertain"),
    ]),
    speech_verdict: Type.Union([
      Type.Literal("pass"),
      Type.Literal("fail"),
      Type.Literal("uncertain"),
    ]),
    sync_verdict: Type.Union([
      Type.Literal("pass"),
      Type.Literal("fail"),
      Type.Literal("uncertain"),
    ]),
    identity_verdict: Type.Union([
      Type.Literal("pass"),
      Type.Literal("fail"),
      Type.Literal("uncertain"),
    ]),
    recorded_at_utc: Rfc3339UtcSchema,
    attestation_ref: Ref,
  },
  closed
);
export const ShotMediaV1Schema = Type.Object(
  {
    ...semantic("shot-media"),
    shot_id: Id,
    stage: Type.Union([Type.Literal("draft"), Type.Literal("final"), Type.Literal("promoted")]),
    clip_ref: Ref,
    route_ref: Ref,
    effect_receipt_ref: Type.Optional(Ref),
    video_evidence_ref: Ref,
    ledger_ref: Ref,
    audio_policy: Type.Union([
      Type.Literal("strip_source_audio"),
      Type.Literal("retain_as_sole_speech"),
      Type.Literal("mix_with_stems"),
    ]),
  },
  closed
);
export const ShotResultV1Schema = Type.Object(
  {
    ...Type.Omit(ShotMediaV1Schema, ["audio_policy"]).properties,
    ...semantic("shot-result"),
    shot_media_ref: Ref,
    objective_binding_ref: Ref,
    quality_binding_ref: Ref,
    disposition,
  },
  closed
);
export const AnimaticV1Schema = Type.Object(
  {
    ...semantic("animatic"),
    story_ref: Ref,
    look_ref: Ref,
    boards: Type.Array(
      Type.Object({ shot_id: Id, png_ref: Ref, start: Time, duration: Time }, closed),
      { minItems: 1 }
    ),
    voice_ref: Type.Optional(Ref),
    timing_ref: Type.Optional(Ref),
    voice_status: Type.Union([
      Type.Literal("actual_approved"),
      Type.Literal("provisional"),
      Type.Literal("none"),
    ]),
    shot_routes: refs,
    edit_ref: Ref,
    review_ref: Ref,
  },
  closed
);
export const AdmittedAssetLedgerV1Schema = Type.Object(
  {
    ...semantic("admitted-asset-ledger"),
    story_ref: Ref,
    g1_decision_ref: Ref,
    intents: Type.Array(
      Type.Object(
        {
          asset_id: Id,
          intent_ref: Ref,
          state: Type.Union([
            Type.Literal("pending_image"),
            Type.Literal("pending_voice"),
            Type.Literal("captured"),
          ]),
          source_ref: Type.Optional(Ref),
          capture_ref: Type.Optional(Ref),
          audio_evidence_ref: Type.Optional(Ref),
        },
        closed
      ),
      { minItems: 1 }
    ),
    required_image_ids: ids,
    required_voice_ids: ids,
    next_asset_id: Type.Optional(Id),
  },
  closed
);
export const NativeBuildResultV1Schema = Type.Object(
  {
    ...semantic("native-build-result"),
    project_ref: Ref,
    normalized_project_ref: Ref,
    roundtrip_edit_ref: Ref,
    dependency_refs: refs,
    open_save_receipt_ref: Ref,
    reopen_receipt_ref: Ref,
    relocation_receipt_ref: Ref,
    render_comparison_ref: Ref,
    diagnostics: texts,
    status: Type.Union([Type.Literal("qualified"), Type.Literal("failed")]),
  },
  closed
);
export const MasterReviewV1Schema = Type.Object(
  {
    ...semantic("master-review"),
    master_ref: Ref,
    decode_ref: Ref,
    audio_evidence_ref: Ref,
    playback_review_ref: Ref,
    used_shot_results: refs,
    caption_check_ref: Ref,
    sync_check_ref: Ref,
    postprocess_evidence_refs: refs,
    disposition,
  },
  closed
);
export const PackageReviewV1Schema = Type.Object(
  {
    ...semantic("package-review"),
    manifest_ref: Ref,
    project_ref: Ref,
    feature_subset_ref: Ref,
    open_save_ref: Ref,
    reopen_ref: Ref,
    relocation_ref: Ref,
    render_comparison_ref: Ref,
    rights_closure_ref: Ref,
    source_closure_ref: Ref,
    disposition,
  },
  closed
);
export const DeliveryReceiptV1Schema = Type.Object(
  {
    ...semantic("delivery-receipt"),
    destination_id: Id,
    exclusive_stage_id: Id,
    final_namespace_id: Id,
    g5_packet_digest: Sha256Schema,
    master_digest: Sha256Schema,
    project_digest: Sha256Schema,
    manifest_digest: Sha256Schema,
    readback_refs: refs,
    fsync_atomicity_ref: Ref,
    outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
  },
  closed
);
export const VideogenTerminalV1Schema = Type.Object(
  {
    ...semantic("terminal"),
    master_ref: Type.Optional(Ref),
    package_manifest_ref: Type.Optional(Ref),
    delivery_ref: Type.Optional(Ref),
    gate_decision_refs: refs,
    ledger_ref: Ref,
    rights_evidence_ref: Type.Optional(Ref),
    master_review_ref: Type.Optional(Ref),
    package_review_ref: Type.Optional(Ref),
    unresolved_operation_ids: ids,
    status: Type.Union([
      Type.Literal("delivered"),
      Type.Literal("incomplete"),
      Type.Literal("cancelled"),
      Type.Literal("error"),
    ]),
    met: Type.Boolean(),
    best_valid_refs: refs,
  },
  closed
);
export type VideogenTerminalV1 = Static<typeof VideogenTerminalV1Schema>;
export type ShotResultV1 = Static<typeof ShotResultV1Schema>;
export interface VideogenSlot {
  readonly slot: string;
  readonly ref: ArtifactRef;
}

/** These schemas parse documents; parsing is never receipt, rights, playback or native qualification. */
export const ReviewBindingV1Schema = Type.Object(
  {
    ...semantic("review-binding"),
    worker_result_ref: Ref,
    target_ref: Ref,
    evidence_refs: refs,
    model_capability_ref: Ref,
    disposition: Type.Union([
      Type.Literal("pass"),
      Type.Literal("repair"),
      Type.Literal("blocked"),
    ]),
  },
  closed
);
export const ReviewPacketV1Schema = Type.Object(
  {
    ...semantic("review-packet"),
    target_ref: Ref,
    objective_binding_ref: Type.Optional(Ref),
    quality_binding_ref: Type.Optional(Ref),
    video_evidence_ref: Type.Optional(Ref),
    audio_evidence_ref: Type.Optional(Ref),
    playback_ref: Type.Optional(Ref),
    limitations: texts,
  },
  closed
);
export const PromotionProofV1Schema = Type.Object(
  {
    ...semantic("promotion-proof"),
    shot_id: Id,
    draft_clip_ref: Ref,
    draft_evidence_ref: Ref,
    current_ledger_ref: Ref,
    final_criteria_ref: Ref,
    fresh_decode_ref: Ref,
    bytes_identical: Type.Literal(true),
  },
  closed
);
export const RecoveryProofV1Schema = Type.Object(
  {
    ...semantic("recovery-proof"),
    operation_record_ref: Ref,
    original_request_digest: Sha256Schema,
    original_prompt_digest: Type.Optional(Sha256Schema),
    original_descriptor_digest: Type.Optional(Sha256Schema),
    original_locator_digest: Type.Optional(Sha256Schema),
    cached_bytes_digest: Type.Optional(Sha256Schema),
    fence_epoch: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    remote_terminal_proof_ref: Type.Optional(Ref),
    disposition: Type.Union([
      Type.Literal("exact_adopt"),
      Type.Literal("non_acceptance"),
      Type.Literal("remote_unknown"),
      Type.Literal("terminal_failure"),
    ]),
  },
  closed
);

export const ShotRouteV1Schema = Type.Object(
  {
    ...semantic("shot-route"),
    shot_id: Id,
    mode: ShotModeV1Schema,
    qualified_profile_snapshot_ref: Ref,
    source_refs: refs,
    timing_target: Time,
    acceptance_criteria: Type.Array(text, { minItems: 1, maxItems: 128 }),
    rights_refs: refs,
    required_gate: Type.Union([Type.Literal("G3"), Type.Literal("G4")]),
    estimated_meters: Type.Array(
      Type.Object(
        {
          meter: MeterSchema,
          reserved: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        },
        closed
      ),
      { minItems: 1, maxItems: 7 }
    ),
  },
  closed
);
export const PreparedGraphV1Schema = Type.Object(
  {
    ...semantic("prepared-graph"),
    source_graph_ref: Ref,
    source_digest: Sha256Schema,
    snapshot_ref: Ref,
    node_policy_ref: Ref,
    inventory_attestation_ref: Ref,
    port_bindings: Type.Array(ShotPortV1Schema, { maxItems: 128 }),
    allowed_mutations: Type.Array(Type.Object({ node_id: Id, input_name: Id }, closed), {
      minItems: 1,
      maxItems: 128,
    }),
    submitted_graph_digest: Sha256Schema,
    output_node: Id,
    output_field: Id,
    shot_id: Id,
    mode: Type.Union([
      Type.Literal("t2v"),
      Type.Literal("i2v"),
      Type.Literal("flf2v"),
      Type.Literal("controlled"),
      Type.Literal("camera"),
      Type.Literal("speech_conditioned"),
      Type.Literal("specialty"),
    ]),
  },
  closed
);
const outcomeBase = { ...semantic("operation-outcome"), operation_id: Id, kind: Kind };
export const OperationOutcomeV1Schema = Type.Union([
  Type.Object(
    { ...outcomeBase, status: Type.Literal("succeeded"), result_ref: Ref, receipt_ref: Ref },
    closed
  ),
  Type.Object(
    {
      ...outcomeBase,
      status: Type.Literal("refused"),
      reason: Type.Union([
        Type.Literal("invalid_input"),
        Type.Literal("unapproved"),
        Type.Literal("unqualified"),
        Type.Literal("rights"),
        Type.Literal("resource"),
        Type.Literal("unsupported"),
        Type.Literal("stale"),
        Type.Literal("corrupt"),
      ]),
    },
    closed
  ),
  Type.Object(
    {
      ...outcomeBase,
      status: Type.Literal("blocked"),
      reason: Type.Union([
        Type.Literal("clarification"),
        Type.Literal("child_wait"),
        Type.Literal("queue_expired"),
        Type.Literal("dependency"),
        Type.Literal("capacity"),
      ]),
    },
    closed
  ),
  Type.Object(
    {
      ...outcomeBase,
      status: Type.Literal("remote_unknown"),
      quarantine_ref: Ref,
      correlation_digest: Sha256Schema,
    },
    closed
  ),
  Type.Object(
    {
      ...outcomeBase,
      status: Type.Literal("failed"),
      reason: Type.Union([
        Type.Literal("remote_terminal"),
        Type.Literal("invalid_media"),
        Type.Literal("decode"),
        Type.Literal("package"),
        Type.Literal("delivery"),
        Type.Literal("security"),
      ]),
    },
    closed
  ),
  Type.Object(
    {
      ...outcomeBase,
      status: Type.Literal("cancelled"),
      cancel_receipt_ref: Ref,
      remote_disposition: Type.Union([Type.Literal("proven_stopped"), Type.Literal("quarantined")]),
    },
    closed
  ),
]);
export const HostStageResultV1Schema = Type.Object(
  {
    ...semantic("host-stage-result"),
    state_id: Id,
    selected_input_refs: refs,
    product_refs: refs,
    operation_outcomes: Type.Array(OperationOutcomeV1Schema, { maxItems: 1024 }),
    journal_receipt_refs: refs,
    ledger_ref: Ref,
  },
  closed
);
