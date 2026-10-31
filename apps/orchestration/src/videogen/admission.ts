import { Type, type Static } from "typebox";
import { canonicalJson } from "../canonical-json.js";
import type { ArtifactStore } from "../artifact-store.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema as Id, Sha256Schema, assertUnique } from "../skill-contracts/common.js";
import {
  readExact,
  readSemantic,
  sameRef,
  validateFoundation,
  validateFoundationLimits,
  FoundationLimitsV1Schema,
  type FoundationLimitsV1,
} from "./bounds.js";
import {
  VideoRequestV1Schema,
  ProjectEnvelopeV1Schema,
  ExecutionPolicyRefsV1Schema,
  ScriptDraftV1Schema,
  StoryOutlineV1Schema,
  validateVideoRequest,
  validateProjectEnvelope,
  validateExecutionPolicy,
  validateScriptDraft,
  validateScript,
  validateStoryStructure,
  validateStoryCanon,
  type VideoRequestV1,
  type ProjectEnvelopeV1,
  type ExecutionPolicyRefsV1,
  type ScriptV1,
  type StoryCanonV1,
  RouteIdSchema,
} from "./foundation-contracts.js";
import { checkRights, type RightsHostV1 } from "./rights-ledger.js";
import { quantizeBoundary } from "./rational-time.js";
const closed = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const amount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** Auxiliary host admission snapshots. They close omitted foundation bindings, not external products. */
const RouteCapabilitySchema = Type.Object(
  {
    route_id: RouteIdSchema,
    profile_snapshot_ref: ArtifactRefSchema,
    qualification_ref: ArtifactRefSchema,
    output_contract_ref: ArtifactRefSchema,
  },
  closed
);
export const CapabilitySnapshotV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-capability-snapshot.v1"),
    schema_version: Type.Literal(1),
    private_config_digest: Sha256Schema,
    routes: Type.Array(RouteCapabilitySchema, { minItems: 1 }),
    formats: Type.Array(
      Type.Object(
        {
          container: Id,
          video_codec: Id,
          audio_codec: Id,
          channels: Type.Union([Type.Literal("mono"), Type.Literal("stereo")]),
        },
        closed
      ),
      { minItems: 1 }
    ),
    max_width: count,
    max_height: count,
    max_duration_seconds: count,
  },
  closed
);
export type CapabilitySnapshotV1 = Static<typeof CapabilitySnapshotV1Schema>;
export const AdmissionConfigV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-admission-config.v1"),
    schema_version: Type.Literal(1),
    private_config_digest: Sha256Schema,
    capability_snapshot_ref: ArtifactRefSchema,
    rights_scope_ref: ArtifactRefSchema,
    policy_binding_ref: ArtifactRefSchema,
    limits_ref: ArtifactRefSchema,
    local_destination_ids: Type.Array(Id, { minItems: 1, uniqueItems: true }),
    microcredits_per_cost_unit: count,
  },
  closed
);
export type AdmissionConfigV1 = Static<typeof AdmissionConfigV1Schema>;
export const AdmissionCapacityV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-admission-capacity.v1"),
    schema_version: Type.Literal(1),
    request_ref: ArtifactRefSchema,
    consumer_run_id: Id,
    owner_snapshot_ref: ArtifactRefSchema,
    storage_bytes_held: count,
    cost_microcredits_held: count,
    engine_steps_held: count,
    finish_bytes_held: count,
    finish_microcredits_held: count,
    finish_steps_held: count,
    spent_microcredits: amount,
    used_storage_bytes: amount,
  },
  closed
);
export type AdmissionCapacityV1 = Static<typeof AdmissionCapacityV1Schema>;
export interface VideogenAdmissionHostV1 extends RightsHostV1 {
  readonly current_config_ref: ArtifactRef;
  readonly private_config_digest: string;
  readonly current_capacity_ref: ArtifactRef;
  readonly current_qualified_routes: readonly CapabilitySnapshotV1["routes"][number][];
  readonly admitted_destination_id: string;
}
export type VideoAdmissionResultV1 =
  | {
      readonly status: "prepared";
      readonly request: VideoRequestV1;
      readonly envelope: ProjectEnvelopeV1;
      readonly policy: ExecutionPolicyRefsV1;
      readonly selected_refs: readonly ArtifactRef[];
      readonly effect_permission: "none";
    }
  | {
      readonly status: "needs_clarification";
      readonly fields: readonly string[];
      readonly questions: readonly string[];
      readonly effect_permission: "none";
    }
  | {
      readonly status: "refused";
      readonly reason: "invalid_input" | "missing_host" | "authority_or_capacity";
      readonly effect_permission: "none";
    };
function product<T extends Parameters<typeof readSemantic>[0]["schema"]>(
  host: RightsHostV1,
  ref: ArtifactRef,
  schema: T,
  schema_id: string
) {
  return readSemantic({
    store: host.store,
    project_id: host.project_id,
    ref,
    schema,
    schema_id,
    limits: host.limits,
  });
}
function sufficient(total: number, used: number, finish: number, required: number): boolean {
  return BigInt(total) - BigInt(used) - BigInt(finish) >= BigInt(required);
}
// Pre-ingress skeleton is auxiliary, not a weaker VideoRequest product. It can only ask questions.
const RequestSkeletonV1Schema = Type.Object(
  {
    ...Type.Partial(VideoRequestV1Schema).properties,
    schema_id: Type.Literal("penny.videogen-request.v1"),
    schema_version: Type.Literal(1),
    format_intent: Type.Optional(Type.Partial(VideoRequestV1Schema.properties.format_intent)),
    constraints: Type.Optional(Type.Partial(VideoRequestV1Schema.properties.constraints)),
  },
  closed
);
/** Read-only host preparation BEFORE RunContext/effects. Not an atomic resource arbiter or a grant. */
export function prepareVideoAdmission(input: {
  host?: VideogenAdmissionHostV1;
  request_ref: ArtifactRef;
  envelope_ref: ArtifactRef;
}): VideoAdmissionResultV1 {
  const host = input.host;
  if (host === undefined)
    return { status: "refused", reason: "missing_host", effect_permission: "none" };
  let request: VideoRequestV1;
  try {
    validateFoundationLimits(host.limits);
    const skeleton = product(
      host,
      input.request_ref,
      RequestSkeletonV1Schema,
      "penny.videogen-request.v1"
    );
    const missing = Object.keys(VideoRequestV1Schema.properties).filter(
      (key) => !(key in skeleton)
    );
    if (skeleton.format_intent !== undefined)
      for (const key of Object.keys(VideoRequestV1Schema.properties.format_intent.properties))
        if (!(key in skeleton.format_intent)) missing.push(`format_intent.${key}`);
    if (skeleton.constraints !== undefined)
      for (const key of Object.keys(VideoRequestV1Schema.properties.constraints.properties))
        if (!(key in skeleton.constraints)) missing.push(`constraints.${key}`);
    if (missing.length > 0)
      return {
        status: "needs_clarification",
        fields: missing,
        questions: missing.map(
          (field) => `Supply ${field} before admission; this does not authorize compute.`
        ),
        effect_permission: "none",
      };
    request = validateVideoRequest(skeleton, host.limits);
  } catch {
    return { status: "refused", reason: "invalid_input", effect_permission: "none" };
  }
  if (request.unresolved.length > 0)
    return {
      status: "needs_clarification",
      fields: request.unresolved,
      questions: request.unresolved.map(
        (field) => `Resolve ${field} before admission; an answer does not authorize compute.`
      ),
      effect_permission: "none",
    };
  try {
    const config = product(
      host,
      host.current_config_ref,
      AdmissionConfigV1Schema,
      "penny.videogen-admission-config.v1"
    );
    const envelope = validateProjectEnvelope(
      product(host, input.envelope_ref, ProjectEnvelopeV1Schema, "penny.videogen-envelope.v1"),
      host.limits
    );
    if (
      !sameRef(envelope.request_ref, input.request_ref) ||
      envelope.private_config_digest !== host.private_config_digest ||
      config.private_config_digest !== host.private_config_digest ||
      !sameRef(envelope.capability_snapshot_ref, config.capability_snapshot_ref) ||
      !sameRef(envelope.rights_scope_ref, config.rights_scope_ref) ||
      !sameRef(envelope.storage_reservation_ref, host.current_capacity_ref) ||
      request.destination_id !== host.admitted_destination_id ||
      !config.local_destination_ids.includes(request.destination_id)
    )
      throw new Error("current config/destination/reservation mismatch");
    const limits = product(
      host,
      config.limits_ref,
      FoundationLimitsV1Schema,
      "penny.videogen-foundation-limits.v1"
    );
    if (canonicalJson(limits) !== canonicalJson(host.limits))
      throw new Error("representation policy binding mismatch");
    const policy = validateExecutionPolicy(
      product(
        host,
        config.policy_binding_ref,
        ExecutionPolicyRefsV1Schema,
        "penny.videogen-policy-binding.v1"
      ),
      host.limits
    );
    if (
      !sameRef(envelope.queue_policy_ref, policy.queue_policy_ref.ref) ||
      !sameRef(envelope.inactivity_policy_ref, policy.inactivity_policy_ref.ref) ||
      !sameRef(envelope.cleanup_policy_ref, policy.cleanup_policy_ref.ref)
    )
      throw new Error("execution policy ref mismatch");
    for (const ref of [
      config.rights_scope_ref,
      envelope.queue_policy_ref,
      envelope.inactivity_policy_ref,
      envelope.cleanup_policy_ref,
    ])
      readExact(host.store, host.project_id, ref, host.limits.max_json_bytes);
    const capabilities = product(
      host,
      config.capability_snapshot_ref,
      CapabilitySnapshotV1Schema,
      "penny.videogen-capability-snapshot.v1"
    );
    const qualified = validateFoundation(
      Type.Array(RouteCapabilitySchema),
      host.current_qualified_routes,
      host.limits
    );
    assertUnique(
      qualified.map((x) => x.route_id),
      "current qualified routes"
    );
    assertUnique(
      capabilities.routes.map((x) => x.route_id),
      "snapshot routes"
    );
    if (
      capabilities.private_config_digest !== host.private_config_digest ||
      request.format_intent.width > capabilities.max_width ||
      request.format_intent.height > capabilities.max_height ||
      request.constraints.duration.numerator >
        BigInt(capabilities.max_duration_seconds) * BigInt(request.constraints.duration.denominator)
    )
      throw new Error("capability configuration/size/duration mismatch");
    if (
      !capabilities.formats.some(
        (x) =>
          x.container === request.format_intent.container &&
          x.video_codec === request.format_intent.video_codec &&
          x.audio_codec === request.format_intent.audio_codec &&
          x.channels === request.format_intent.channels
      )
    )
      throw new Error("unsupported output format");
    for (const id of request.requested_routes) {
      const route = capabilities.routes.find((x) => x.route_id === id);
      const installed = qualified.find((x) => x.route_id === id);
      if (
        route === undefined ||
        installed === undefined ||
        !sameRef(route.profile_snapshot_ref, installed.profile_snapshot_ref) ||
        !sameRef(route.qualification_ref, installed.qualification_ref) ||
        !sameRef(route.output_contract_ref, installed.output_contract_ref)
      )
        throw new Error("unqualified route");
      for (const ref of [
        route.profile_snapshot_ref,
        route.qualification_ref,
        route.output_contract_ref,
      ])
        readExact(host.store, host.project_id, ref, host.limits.max_json_bytes);
    }
    if (
      request.constraints.max_scenes > envelope.max_scenes ||
      request.constraints.max_shots > envelope.max_shots ||
      request.constraints.max_attempts > envelope.max_attempts ||
      request.constraints.max_storage_bytes > envelope.max_storage_bytes ||
      request.constraints.max_cost_units > envelope.max_cost_units
    )
      throw new Error("request exceeds envelope");
    quantizeBoundary(request.constraints.duration, request.format_intent.fps, envelope.max_frames);
    let sourceBytes = 0n;
    for (const source of request.source_refs) {
      const ref = source.ref;
      sourceBytes += BigInt(ref.byte_length);
      if (
        (source.role === "image" && ref.media_type !== "image/png") ||
        ((source.role === "audio" || source.role === "performance") &&
          ref.media_type !== "audio/wav") ||
        (source.role === "video" && ref.media_type !== "video/mp4") ||
        (source.role === "script" && ref.content_schema?.schema_id !== "penny.videogen-script.v1")
      )
        throw new Error("incorrect source role/media");
      readExact(host.store, host.project_id, ref, envelope.max_source_bytes);
      checkRights(host, ref, source.rights_ref, "source");
    }
    if (sourceBytes > BigInt(envelope.max_source_bytes)) throw new Error("aggregate source bytes");
    const capacity = product(
      host,
      host.current_capacity_ref,
      AdmissionCapacityV1Schema,
      "penny.videogen-admission-capacity.v1"
    );
    const conversion = BigInt(config.microcredits_per_cost_unit);
    const cost = BigInt(request.constraints.max_cost_units) * conversion;
    const finishCost = BigInt(envelope.finish_reserve_cost_units) * conversion;
    if (
      cost > BigInt(host.limits.max_integer) ||
      finishCost > BigInt(host.limits.max_integer) ||
      !sameRef(capacity.request_ref, input.request_ref) ||
      capacity.consumer_run_id !== host.run_id ||
      envelope.finish_reserve_bytes < 1 ||
      envelope.finish_reserve_cost_units < 1 ||
      capacity.finish_bytes_held < envelope.finish_reserve_bytes ||
      BigInt(capacity.finish_microcredits_held) < finishCost ||
      capacity.finish_steps_held < envelope.finish_reserve_steps ||
      !sufficient(
        capacity.storage_bytes_held,
        capacity.used_storage_bytes,
        capacity.finish_bytes_held,
        request.constraints.max_storage_bytes
      ) ||
      !sufficient(
        capacity.cost_microcredits_held,
        capacity.spent_microcredits,
        capacity.finish_microcredits_held,
        Number(cost)
      ) ||
      capacity.engine_steps_held <= capacity.finish_steps_held
    )
      throw new Error("insufficient held production/finish capacity");
    readExact(host.store, host.project_id, capacity.owner_snapshot_ref, host.limits.max_json_bytes);
    return {
      status: "prepared",
      request,
      envelope,
      policy,
      selected_refs: [
        input.request_ref,
        input.envelope_ref,
        host.current_config_ref,
        config.capability_snapshot_ref,
        config.rights_scope_ref,
        host.current_capacity_ref,
        config.policy_binding_ref,
        config.limits_ref,
      ],
      effect_permission: "none",
    };
  } catch {
    return { status: "refused", reason: "authority_or_capacity", effect_permission: "none" };
  }
}

/** Bind worker text only to the exact outline, never accept a worker's refs or identity. */
export function bindScriptDraft(input: {
  store: ArtifactStore;
  project_id: string;
  outline_ref: ArtifactRef;
  draft_ref: ArtifactRef;
  limits: FoundationLimitsV1;
}): ScriptV1 {
  const outline = readSemantic({
    ...input,
    ref: input.outline_ref,
    schema: StoryOutlineV1Schema,
    schema_id: "penny.videogen-story-outline.v1",
  });
  validateStoryStructure(outline);
  if (
    outline.needs_clarification === true ||
    outline.script_brief.scene_line_intents.some(
      (line) => !outline.scenes.some((scene) => scene.scene_id === line.scene_id)
    )
  )
    throw new Error("story outline unresolved or script-intent scene mismatch");
  const draft = validateScriptDraft(
    readSemantic({
      ...input,
      ref: input.draft_ref,
      schema: ScriptDraftV1Schema,
      schema_id: "penny.videogen-script-draft.v1",
    }),
    input.limits
  );
  if (
    draft.needs_clarification === true ||
    draft.language !== outline.script_brief.language ||
    draft.scenes.length !== outline.scenes.length ||
    draft.scenes.some((scene, i) => scene.scene_id !== outline.scenes[i]?.scene_id) ||
    draft.coverage_shot_ids.length !== outline.shots.length ||
    draft.coverage_shot_ids.some((id, i) => id !== outline.shots[i]?.shot_id)
  )
    throw new Error("script draft coverage/language unresolved");
  const lines = new Set(
    [...draft.scenes.flatMap((x) => x.ordered_lines), ...draft.narration_lines].map(
      (x) => x.line_id
    )
  );
  if (
    outline.shots.some((x) => x.spoken_line_ids.some((id) => !lines.has(id))) ||
    [...lines].some((id) => !outline.shots.some((x) => x.spoken_line_ids.includes(id)))
  )
    throw new Error("spoken line coverage mismatch");
  return validateScript(
    {
      schema_id: "penny.videogen-script.v1",
      schema_version: 1,
      story_outline_ref: input.outline_ref,
      scenes: draft.scenes,
      narration_lines: draft.narration_lines,
      language: draft.language,
      coverage_shot_ids: draft.coverage_shot_ids,
    },
    input.limits
  );
}
export function checkCanonScript(
  canonValue: unknown,
  scriptValue: unknown,
  scriptRef: ArtifactRef,
  limits: FoundationLimitsV1
): StoryCanonV1 {
  const canon = validateStoryCanon(canonValue, limits);
  const script = validateScript(scriptValue, limits);
  if (
    !sameRef(canon.script_ref, scriptRef) ||
    canon.scenes.length !== script.scenes.length ||
    canon.scenes.some((x, i) => x.scene_id !== script.scenes[i]?.scene_id) ||
    canon.shots.length !== script.coverage_shot_ids.length ||
    canon.shots.some((x, i) => x.shot_id !== script.coverage_shot_ids[i])
  )
    throw new Error("canon/script exact coverage mismatch");
  const lines = [...script.scenes.flatMap((x) => x.ordered_lines), ...script.narration_lines].map(
    (x) => x.line_id
  );
  if (
    canon.shots.some((x) => x.spoken_line_ids.some((id) => !lines.includes(id))) ||
    lines.some((id) => !canon.shots.some((x) => x.spoken_line_ids.includes(id)))
  )
    throw new Error("canon/script line coverage");
  return canon;
}
