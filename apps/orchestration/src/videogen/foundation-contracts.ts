import { Type, type Static } from "typebox";
import { ArtifactRefSchema, ConfidenceSchema } from "../contracts.js";
import {
  OpaqueIdSchema as Id,
  Sha256Schema,
  Rfc3339UtcSchema,
  assertUnique,
  assertRfc3339Utc,
} from "../skill-contracts/common.js";
import { exactRef, validateFoundation, type FoundationLimitsV1 } from "./bounds.js";
import {
  RationalTimeSchema,
  RationalRateSchema,
  validateRationalTime,
  validateRationalRate,
} from "./rational-time.js";

export const VideogenHostOperationKindSchema = Type.Union([
  Type.Literal("voice_job"),
  Type.Literal("reference_upload"),
  Type.Literal("video_render"),
  Type.Literal("media_decode_extract"),
  Type.Literal("timeline_master"),
  Type.Literal("kdenlive_build_verify"),
  Type.Literal("local_delivery"),
]);
export type VideogenHostOperationKind = Static<typeof VideogenHostOperationKindSchema>;
export const VideogenEffectKindSchema = Type.Union([
  VideogenHostOperationKindSchema,
  Type.Literal("child_imagegen"),
]);
export const MeterSchema = Type.Union([
  Type.Literal("gpu_milliseconds"),
  Type.Literal("cpu_milliseconds"),
  Type.Literal("stored_bytes"),
  Type.Literal("egress_bytes"),
  Type.Literal("cost_microcredits"),
  Type.Literal("attempts"),
  Type.Literal("engine_steps"),
]);
export type VideogenMeter = Static<typeof MeterSchema>;
const text = Type.String({ minLength: 1 });
const count = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const amount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const texts = Type.Array(text);
const ids = Type.Array(Id, { uniqueItems: true });
const refs = Type.Array(ArtifactRefSchema, { uniqueItems: true });
const closed = { additionalProperties: false } as const;
const semantic = <N extends string>(name: N) => ({
  schema_id: Type.Literal(`penny.videogen-${name}.v1`),
  schema_version: Type.Literal(1),
});
export const RouteIdSchema = Type.Union([
  Type.Literal("UC-01"),
  Type.Literal("UC-02"),
  Type.Literal("UC-03"),
  Type.Literal("UC-04"),
  Type.Literal("UC-05"),
  Type.Literal("UC-06"),
  Type.Literal("UC-07"),
  Type.Literal("UC-08"),
  Type.Literal("UC-09"),
  Type.Literal("UC-10"),
  Type.Literal("UC-11"),
  Type.Literal("UC-12"),
  Type.Literal("UC-13"),
  Type.Literal("UC-14"),
  Type.Literal("UC-15"),
  Type.Literal("UC-16"),
  Type.Literal("UC-17"),
  Type.Literal("UC-18"),
]);
export const VideoRequestV1Schema = Type.Object(
  {
    ...semantic("request"),
    brief: text,
    source_refs: Type.Array(
      Type.Object(
        {
          ref: ArtifactRefSchema,
          role: Type.Union([
            Type.Literal("image"),
            Type.Literal("video"),
            Type.Literal("audio"),
            Type.Literal("script"),
            Type.Literal("control"),
            Type.Literal("performance"),
          ]),
          rights_ref: ArtifactRefSchema,
        },
        closed
      )
    ),
    destination_id: Id,
    format_intent: Type.Object(
      {
        container: Id,
        video_codec: Id,
        audio_codec: Id,
        width: count,
        height: count,
        fps: RationalRateSchema,
        audio_rate: RationalRateSchema,
        channels: Type.Union([Type.Literal("mono"), Type.Literal("stereo")]),
        captions_required: Type.Boolean(),
      },
      closed
    ),
    unresolved: ids,
    constraints: Type.Object(
      {
        duration: RationalTimeSchema,
        max_scenes: count,
        max_shots: count,
        max_storage_bytes: count,
        max_cost_units: count,
        max_attempts: count,
      },
      closed
    ),
    requested_routes: Type.Array(RouteIdSchema, { minItems: 1, uniqueItems: true }),
    delegated_decisions: texts,
    must_haves: texts,
    dislikes: texts,
  },
  closed
);
export type VideoRequestV1 = Static<typeof VideoRequestV1Schema>;
export const ProjectEnvelopeV1Schema = Type.Object(
  {
    ...semantic("envelope"),
    request_ref: ArtifactRefSchema,
    private_config_digest: Sha256Schema,
    capability_snapshot_ref: ArtifactRefSchema,
    rights_scope_ref: ArtifactRefSchema,
    storage_reservation_ref: ArtifactRefSchema,
    max_scenes: count,
    max_shots: count,
    max_frames: count,
    max_source_bytes: count,
    max_output_bytes: count,
    max_storage_bytes: count,
    max_active_jobs: count,
    max_attempts: count,
    max_cost_units: count,
    finish_reserve_bytes: amount,
    finish_reserve_cost_units: amount,
    finish_reserve_steps: amount,
    max_elapsed_seconds: Type.Optional(count),
    queue_policy_ref: ArtifactRefSchema,
    inactivity_policy_ref: ArtifactRefSchema,
    cleanup_policy_ref: ArtifactRefSchema,
  },
  closed
);
export type ProjectEnvelopeV1 = Static<typeof ProjectEnvelopeV1Schema>;
export const ExecutionPolicyRefsV1Schema = Type.Object(
  {
    ...semantic("policy-binding"),
    queue_policy_ref: Type.Object(
      { ref: ArtifactRefSchema, max_wait_ms: count, discipline: Type.Literal("FIFO") },
      closed
    ),
    inactivity_policy_ref: Type.Object(
      {
        ref: ArtifactRefSchema,
        active_inactivity_ms: count,
        transport_silence_ms: count,
        renewal_source: Type.Literal("trusted_host_milestone"),
      },
      closed
    ),
    cleanup_policy_ref: Type.Object(
      {
        ref: ArtifactRefSchema,
        cancel_grace_ms: count,
        retention_ms: count,
        quarantine_requires_operator_proof: Type.Literal(true),
      },
      closed
    ),
  },
  closed
);
export type ExecutionPolicyRefsV1 = Static<typeof ExecutionPolicyRefsV1Schema>;
const MeterReadingSchema = Type.Object(
  {
    meter: MeterSchema,
    reserved: amount,
    consumed: amount,
    unit: Type.Union([
      Type.Literal("ms"),
      Type.Literal("byte"),
      Type.Literal("microcredit"),
      Type.Literal("count"),
    ]),
  },
  closed
);
export const BudgetReservationV1Schema = Type.Object(
  {
    ...semantic("budget-reservation"),
    reservation_id: Id,
    scope_gate_ref: ArtifactRefSchema,
    subject_id: Id,
    operation_kind: VideogenEffectKindSchema,
    meters: Type.Array(MeterReadingSchema, { minItems: 1, maxItems: 7 }),
    created_at_utc: Rfc3339UtcSchema,
    expires_at_utc: Rfc3339UtcSchema,
    policy_refs: Type.Object(
      { queue: ArtifactRefSchema, inactivity: ArtifactRefSchema, cleanup: ArtifactRefSchema },
      closed
    ),
    state: Type.Union([
      Type.Literal("held"),
      Type.Literal("settled"),
      Type.Literal("released"),
      Type.Literal("quarantined"),
    ]),
    reason: Type.Union([
      Type.Literal("prepared"),
      Type.Literal("applied"),
      Type.Literal("queue_expired"),
      Type.Literal("pre_submit_cancel"),
      Type.Literal("scope_revoked"),
      Type.Literal("cap_exceeded"),
      Type.Literal("remote_unknown"),
      Type.Literal("terminal_proven"),
      Type.Literal("retention_hold"),
    ]),
  },
  closed
);
export type BudgetReservationV1 = Static<typeof BudgetReservationV1Schema>;
export const METER_UNITS: Readonly<
  Record<VideogenMeter, BudgetReservationV1["meters"][number]["unit"]>
> = Object.freeze({
  gpu_milliseconds: "ms",
  cpu_milliseconds: "ms",
  stored_bytes: "byte",
  egress_bytes: "byte",
  cost_microcredits: "microcredit",
  attempts: "count",
  engine_steps: "count",
});
const SceneScriptSchema = Type.Object(
  {
    scene_id: Id,
    ordered_lines: Type.Array(
      Type.Object({ line_id: Id, speaker_id: Id, text, delivery_intent: text }, closed)
    ),
  },
  closed
);
const scriptFields = {
  scenes: Type.Array(SceneScriptSchema, { minItems: 1 }),
  narration_lines: Type.Array(Type.Object({ line_id: Id, text, delivery_intent: text }, closed)),
  language: Id,
  coverage_shot_ids: ids,
};
const workerFields = {
  needs_clarification: Type.Optional(Type.Boolean()),
  clarifying_questions: Type.Optional(texts),
  confidence: Type.Optional(ConfidenceSchema),
};
export const ScriptDraftV1Schema = Type.Object(
  { ...semantic("script-draft"), ...scriptFields, ...workerFields },
  closed
);
export type ScriptDraftV1 = Static<typeof ScriptDraftV1Schema>;
export const ScriptV1Schema = Type.Object(
  { ...semantic("script"), story_outline_ref: ArtifactRefSchema, ...scriptFields },
  closed
);
export type ScriptV1 = Static<typeof ScriptV1Schema>;
const ScenesSchema = Type.Array(Type.Object({ scene_id: Id, order: count, beat: text }, closed), {
  minItems: 1,
});
const ShotsSchema = Type.Array(
  Type.Object(
    {
      shot_id: Id,
      scene_id: Id,
      order: count,
      intent: text,
      action: text,
      observable_end: text,
      camera: text,
      coverage: text,
      continuity_depends_on: ids,
      spoken_line_ids: ids,
    },
    closed
  ),
  { minItems: 1 }
);
export const StoryOutlineV1Schema = Type.Object(
  {
    ...semantic("story-outline"),
    scenes: ScenesSchema,
    shots: ShotsSchema,
    script_brief: Type.Object(
      {
        language: Id,
        scene_line_intents: Type.Array(
          Type.Object({ scene_id: Id, speaker_id: Id, text_intent: text }, closed)
        ),
      },
      closed
    ),
    acceptance_criteria: texts,
    ...workerFields,
  },
  closed
);
export type StoryOutlineV1 = Static<typeof StoryOutlineV1Schema>;
export const LookVoiceSelectionV1Schema = Type.Object(
  {
    ...semantic("look-voice"),
    story_ref: ArtifactRefSchema,
    approved_pngs: Type.Array(
      Type.Object(
        {
          asset_id: Id,
          role: Id,
          revision: count,
          png_ref: ArtifactRefSchema,
          parent_ref: Type.Optional(ArtifactRefSchema),
        },
        closed
      )
    ),
    style_sheet_ref: ArtifactRefSchema,
    voice_identity: Type.Object(
      { voice_id: Id, source: Id, language: Id, consent_ref: ArtifactRefSchema },
      closed
    ),
    performance_ref: ArtifactRefSchema,
    audio_evidence_ref: ArtifactRefSchema,
    timing_ref: ArtifactRefSchema,
    license_refs: refs,
    preview_receipts: refs,
    known_limits: texts,
  },
  closed
);
/** Inert author choices only: runtime outputs are filled from the settled current selection. */
export const LookVoiceTemplateV1Schema = Type.Object(
  {
    ...Type.Omit(LookVoiceSelectionV1Schema, [
      "story_ref",
      "approved_pngs",
      "performance_ref",
      "audio_evidence_ref",
      "timing_ref",
      "preview_receipts",
    ]).properties,
    ...semantic("look-voice-template"),
  },
  closed
);
export type LookVoiceSelectionV1 = Static<typeof LookVoiceSelectionV1Schema>;
export const StoryCanonV1Schema = Type.Object(
  {
    ...semantic("story-canon"),
    brief_ref: ArtifactRefSchema,
    story_version: count,
    audience: text,
    emotion: text,
    style_intent: text,
    fixed_choices: texts,
    delegated_choices: texts,
    script_ref: ArtifactRefSchema,
    scenes: ScenesSchema,
    shots: ShotsSchema,
    acceptance_criteria: Type.Array(text, { minItems: 1 }),
    unresolved: texts,
  },
  closed
);
export type StoryCanonV1 = Static<typeof StoryCanonV1Schema>;
const intentFields = {
  ...semantic("asset-intent"),
  asset_id: Id,
  purpose: Type.Union([
    Type.Literal("look_test"),
    Type.Literal("character"),
    Type.Literal("set"),
    Type.Literal("first_frame"),
    Type.Literal("last_frame"),
    Type.Literal("voice_preview"),
    Type.Literal("performance"),
  ]),
  story_ref: ArtifactRefSchema,
  source: Type.Union([
    Type.Literal("supplied"),
    Type.Literal("imagegen_fresh"),
    Type.Literal("imagegen_revision"),
    Type.Literal("voice_studio"),
  ]),
  input_refs: refs,
  allowed_change: text,
  preserve_criteria: Type.Array(text, { minItems: 1 }),
  consent_ref: ArtifactRefSchema,
  rights_ref: ArtifactRefSchema,
  estimated_meters: Type.Array(Type.Object({ meter: MeterSchema, reserved: amount }, closed), {
    minItems: 1,
    maxItems: 7,
  }),
  attempt_limit: count,
};
export const AssetIntentV1Schema = Type.Union([
  Type.Object({ ...intentFields, scope_status: Type.Literal("proposed") }, closed),
  Type.Object(
    { ...intentFields, scope_status: Type.Literal("approved"), gate_scope_ref: ArtifactRefSchema },
    closed
  ),
]);
export type AssetIntentV1 = Static<typeof AssetIntentV1Schema>;

export function validateVideoRequest(value: unknown, limits: FoundationLimitsV1): VideoRequestV1 {
  const v = validateFoundation(VideoRequestV1Schema, value, limits);
  validateRationalTime(v.constraints.duration);
  validateRationalRate(v.format_intent.fps);
  validateRationalRate(v.format_intent.audio_rate);
  if (v.constraints.duration.numerator <= 0 || v.constraints.max_scenes > v.constraints.max_shots)
    throw new Error("invalid duration/scene coverage");
  assertUnique(
    v.source_refs.map((x) => x.ref.artifact_id),
    "source refs"
  );
  for (const x of v.source_refs) {
    exactRef(x.ref);
    exactRef(x.rights_ref);
  }
  return v;
}
export function validateProjectEnvelope(
  value: unknown,
  limits: FoundationLimitsV1
): ProjectEnvelopeV1 {
  const v = validateFoundation(ProjectEnvelopeV1Schema, value, limits);
  if (
    v.max_scenes > v.max_shots ||
    v.finish_reserve_bytes >= v.max_storage_bytes ||
    v.finish_reserve_cost_units >= v.max_cost_units ||
    v.finish_reserve_steps < 1
  )
    throw new Error("insufficient finish reserve");
  return v;
}
export function validateExecutionPolicy(
  value: unknown,
  limits: FoundationLimitsV1
): ExecutionPolicyRefsV1 {
  return validateFoundation(ExecutionPolicyRefsV1Schema, value, limits);
}
export function validateBudgetReservation(
  value: unknown,
  limits: FoundationLimitsV1
): BudgetReservationV1 {
  const v = validateFoundation(BudgetReservationV1Schema, value, limits);
  assertUnique(
    v.meters.map((x) => x.meter),
    "meters"
  );
  for (const m of v.meters)
    if (m.unit !== METER_UNITS[m.meter] || m.consumed > m.reserved)
      throw new Error("invalid meter pairing/consumption");
  assertRfc3339Utc(v.created_at_utc, "reservation creation");
  assertRfc3339Utc(v.expires_at_utc, "reservation expiry");
  if (Date.parse(v.expires_at_utc) <= Date.parse(v.created_at_utc))
    throw new Error("invalid reservation lifetime");
  if (
    (v.state === "quarantined" &&
      !["remote_unknown", "retention_hold", "cap_exceeded"].includes(v.reason)) ||
    (v.state === "settled" && v.reason !== "terminal_proven") ||
    (v.state === "released" &&
      !["queue_expired", "pre_submit_cancel", "scope_revoked", "terminal_proven"].includes(
        v.reason
      )) ||
    (v.state === "held" && !["prepared", "applied", "retention_hold"].includes(v.reason))
  )
    throw new Error("invalid reservation disposition");
  return v;
}
export function validateScriptDraft(value: unknown, limits: FoundationLimitsV1): ScriptDraftV1 {
  const v = validateFoundation(ScriptDraftV1Schema, value, limits);
  validateScriptLines(v);
  if (
    v.needs_clarification === true &&
    (v.clarifying_questions === undefined || v.clarifying_questions.length === 0)
  )
    throw new Error("clarification questions required");
  return v;
}
export function validateScript(value: unknown, limits: FoundationLimitsV1): ScriptV1 {
  const v = validateFoundation(ScriptV1Schema, value, limits);
  validateScriptLines(v);
  return v;
}
function validateScriptLines(
  v: Pick<ScriptV1, "scenes" | "narration_lines" | "coverage_shot_ids">
): void {
  assertUnique(
    v.scenes.map((x) => x.scene_id),
    "script scenes"
  );
  const lines = [...v.scenes.flatMap((x) => x.ordered_lines), ...v.narration_lines];
  if (lines.length === 0 || v.coverage_shot_ids.length === 0)
    throw new Error("voice-only words and shot coverage required");
  assertUnique(
    lines.map((x) => x.line_id),
    "spoken lines"
  );
}
export function validateStoryStructure(v: Pick<StoryCanonV1, "scenes" | "shots">): void {
  assertUnique(
    v.scenes.map((x) => x.scene_id),
    "canon scenes"
  );
  assertUnique(
    v.shots.map((x) => x.shot_id),
    "canon shots"
  );
  const scenes = new Set(v.scenes.map((x) => x.scene_id));
  const seen = new Set<string>();
  for (const [i, scene] of v.scenes.entries())
    if (scene.order !== i + 1) throw new Error("scene ordering");
  for (const [i, shot] of v.shots.entries()) {
    if (
      shot.order !== i + 1 ||
      !scenes.has(shot.scene_id) ||
      shot.continuity_depends_on.some((id) => !seen.has(id))
    )
      throw new Error("shot ordering/linkage/cycle");
    seen.add(shot.shot_id);
  }
  if (v.scenes.some((scene) => !v.shots.some((shot) => shot.scene_id === scene.scene_id)))
    throw new Error("uncovered scene");
}
export function validateStoryCanon(value: unknown, limits: FoundationLimitsV1): StoryCanonV1 {
  const v = validateFoundation(StoryCanonV1Schema, value, limits);
  validateStoryStructure(v);
  return v;
}
export function validateAssetIntent(value: unknown, limits: FoundationLimitsV1): AssetIntentV1 {
  const v = validateFoundation(AssetIntentV1Schema, value, limits);
  assertUnique(
    v.estimated_meters.map((x) => x.meter),
    "intent meters"
  );
  if (v.input_refs.some((x) => x.media_type === "image/png") && v.source === "imagegen_fresh")
    throw new Error("fresh image has no PNG parents");
  if (
    v.source === "imagegen_revision" &&
    (v.input_refs.length < 1 ||
      v.input_refs.length > 2 ||
      v.input_refs.some((x) => x.media_type !== "image/png"))
  )
    throw new Error("revision requires canonical source and optional mask PNG");
  const voice = v.purpose === "voice_preview" || v.purpose === "performance";
  if (
    (v.source === "voice_studio" &&
      (!voice ||
        !v.input_refs.some((x) => x.content_schema?.schema_id === "penny.videogen-script.v1"))) ||
    (voice && (v.source === "imagegen_fresh" || v.source === "imagegen_revision")) ||
    (v.source === "supplied" && v.input_refs.length !== 1)
  )
    throw new Error("invalid asset source/purpose binding");
  return v;
}
