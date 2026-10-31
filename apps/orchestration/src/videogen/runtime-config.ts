import type { InformationChildAuthorityV1 } from "../playbooks/registry.js";
import { VIDEOGEN_OPTIONAL_CHILD_PARENTS } from "./matrix.js";
import type { ImagegenChildPolicyV1 } from "../child-workflows/imagegen-policy.js";
import type { ImagegenRequestV1 } from "../skill-contracts/imagegen.js";
import { Type, type Static } from "typebox";
import { ArtifactRefSchema as Ref, JsonValueSchema, validateContract } from "../contracts.js";
import { OpaqueIdSchema as Id, Sha256Schema } from "../skill-contracts/common.js";
import { FoundationLimitsV1Schema } from "./bounds.js";
import {
  AssetIntentV1Schema,
  ProjectEnvelopeV1Schema,
  MeterSchema,
} from "./foundation-contracts.js";
import { CurrentRightsV1Schema } from "./rights-ledger.js";
import { EditDecisionV1Schema, PortableManifestV1Schema } from "./edit-contracts.js";
import type { HostOperationLeaseAuthority } from "../host-operations/lease-authority.js";
import type { KdenliveFixtureRegistry } from "./kdenlive-registry.js";
import { ShotRouteV1Schema } from "./stage-contracts.js";
import type { ArtifactStore } from "../artifact-store.js";
import type { Checkpointer } from "../checkpointer.js";
import type {
  HostOperationAdapterV1,
  HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import type { TSchema } from "typebox";
import type { VideogenOwnerSelection } from "./owner-selection.js";
const closed = { additionalProperties: false } as const;
/** Private host configuration; never a skill request or a qualification issuer. Every path,
 * endpoint, profile and operation policy comes from the caller. No retained-state installation. */
export const VideogenPrivateConfigV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-private-config.v1"),
    schema_version: Type.Literal(1),
    activation: Type.Union([Type.Literal("disabled"), Type.Literal("enabled")]),
    context: Type.Union([Type.Literal("production"), Type.Literal("isolated_fixture")]),
    config_digest: Sha256Schema,
    territory: Id,
    limits: FoundationLimitsV1Schema,
    envelope: Type.Omit(ProjectEnvelopeV1Schema, ["request_ref"]),
    rights: Type.Array(CurrentRightsV1Schema),
    cross_run_edge_refs: Type.Array(Ref),
    assets: Type.Array(
      Type.Omit(AssetIntentV1Schema, ["story_ref", "scope_status", "gate_scope_ref"]),
      { minItems: 1, maxItems: 128 }
    ),
    routes: Type.Array(ShotRouteV1Schema, { minItems: 1, maxItems: 128 }),
    initial_products: Type.Array(Type.Object({ slot: Id, ref: Ref }, closed), { maxItems: 256 }),
    model_capability_ref: Ref,
    /** Explicit task material for brief analysis, never a configuration/authority projection. */
    brief_context_refs: Type.Optional(
      Type.Array(Ref, { minItems: 1, maxItems: 32, uniqueItems: true })
    ),
    authored_products: Type.Optional(
      Type.Array(
        Type.Object(
          {
            state: Type.Union([
              Type.Literal("story_plan"),
              Type.Literal("script_text"),
              Type.Literal("animatic_plan"),
            ]),
            ref: Ref,
          },
          closed
        ),
        { maxItems: 3 }
      )
    ),
    single_shot_edit: Type.Optional(
      Type.Object(
        {
          shot_id: Id,
          voice_asset_id: Id,
          board_asset_id: Id,
          canvas: EditDecisionV1Schema.properties.canvas,
          duration: EditDecisionV1Schema.properties.end_time,
          caption_ref: Ref,
          style_ref: Ref,
          notes_ref: Ref,
        },
        closed
      )
    ),
    import_authorization_ref: Type.Optional(Ref),
    script_rights_source_slots: Type.Optional(
      Type.Array(Id, { minItems: 1, maxItems: 128, uniqueItems: true })
    ),
    portable: Type.Optional(
      Type.Object(
        {
          package_id: Id,
          credits_ref: Ref,
          provenance_ref: Ref,
          feature_subset_ref: Ref,
          instructions_ref: Ref,
          environment: PortableManifestV1Schema.properties.environment,
          environment_files: Type.Array(Type.Object({ id: Id, ref: Ref }, closed), {
            maxItems: 128,
          }),
          package_policy: Type.Object(
            {
              max_files: Type.Integer({ minimum: 1, maximum: 2048 }),
              max_file_bytes: Type.Integer({ minimum: 1 }),
              max_payload_bytes: Type.Integer({ minimum: 1 }),
            },
            closed
          ),
        },
        closed
      )
    ),
    optional: Type.Object({ research: Type.Boolean(), alternatives: Type.Boolean() }, closed),
  },
  closed
);
export type VideogenPrivateConfigV1 = Static<typeof VideogenPrivateConfigV1Schema>;
/** An immutable request recipe, not executable phase code. Only exact selected artifact slots
 * may substitute top-level request operands; the concrete operation schema validates the result. */
export const VideogenEffectRecipeV1Schema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("voice_job"),
      Type.Literal("reference_upload"),
      Type.Literal("video_render"),
      Type.Literal("media_decode_extract"),
      Type.Literal("timeline_master"),
      Type.Literal("kdenlive_build_verify"),
      Type.Literal("local_delivery"),
    ]),
    stage: Type.Union([
      Type.Literal("asset"),
      Type.Literal("draft"),
      Type.Literal("rough"),
      Type.Literal("final"),
      Type.Literal("finished"),
      Type.Literal("delivery"),
    ]),
    subject_id: Id,
    fields: Type.Record(Type.String(), JsonValueSchema),
    operands: Type.Array(Type.Object({ field: Id, slot: Id }, closed), { maxItems: 128 }),
    input_slots: Type.Array(Id, { maxItems: 128, uniqueItems: true }),
    input_bindings: Type.Optional(
      Type.Array(Type.Object({ slot: Id, source_slot: Id }, closed), { maxItems: 128 })
    ),
    predecessor_slot: Type.Optional(Id),
    rights_source_slots: Type.Optional(
      Type.Array(Id, { minItems: 1, maxItems: 128, uniqueItems: true })
    ),
    // Legacy explicit fixture providers may carry a prebuilt reservation. Compiled adapters
    // require a closed policy and derive the actual reservation from the current gate.
    budget_ref: Type.Optional(Ref),
    budget_policy: Type.Optional(
      Type.Object(
        {
          lifetime_ms: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
          meters: Type.Array(
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
      )
    ),
    output_contract_ref: Ref,
    backend_key_sha256: Sha256Schema,
  },
  closed
);
export type VideogenEffectRecipeV1 = Static<typeof VideogenEffectRecipeV1Schema>;
export interface VideogenEffectProviderV1 {
  readonly native?: {
    readonly registry: KdenliveFixtureRegistry;
    readonly edit_policy: import("./edit-decision.js").EditPolicyV1;
  };
  readonly media?: { readonly policy_ref: import("../contracts.js").ArtifactRef };
  readonly declaration: HostOperationDeclarationV1;
  readonly request_schema: TSchema;
  /** Constructor only; not a phase evaluator or completion predicate. Uses actual run owners. */
  readonly createAdapter: (owners: {
    readonly owner: VideogenOwnerSelection;
    readonly store: ArtifactStore;
    readonly checkpointer: Checkpointer;
    readonly leases?: HostOperationLeaseAuthority;
    readonly capacity?: {
      readonly runtime: import("../host-operations/capacity-runtime.js").HostOperationCapacityRuntimeBinding;
      readonly authority: import("../host-operations/capacity-authority.js").HostOperationCapacityAuthority;
    };
  }) => HostOperationAdapterV1;
}
export const VideogenInformationTriggerV1Schema = Type.Object(
  {
    trigger_state: Type.Unsafe<
      | "brief_analysis"
      | "story_plan"
      | "story_check"
      | "route_choice"
      | "draft_verify"
      | "master_verify"
    >(Type.Union(VIDEOGEN_OPTIONAL_CHILD_PARENTS.map((state) => Type.Literal(state)))),
    child_name: Type.Union([
      Type.Literal("assess"),
      Type.Literal("decide"),
      Type.Literal("define"),
      Type.Literal("diagnose"),
      Type.Literal("plan"),
      Type.Literal("produce"),
      Type.Literal("research"),
    ]),
    request: JsonValueSchema,
    input_slots: Type.Array(Id, { maxItems: 32, uniqueItems: true }),
  },
  closed
);
export type VideogenInformationTriggerV1 = Static<typeof VideogenInformationTriggerV1Schema>;
export interface VideogenRuntimeProvidersV1 {
  readonly information_child?: InformationChildAuthorityV1;
  readonly information_triggers?: readonly VideogenInformationTriggerV1[];
  readonly imagegen_child?: ImagegenChildPolicyV1;
  readonly image_requests?: ReadonlyMap<string, ImagegenRequestV1>;
  readonly image_calls?: ReadonlyMap<
    string,
    { readonly profile_sha256: string; readonly cost_microcredits: number }
  >;
  readonly project_id: string;
  /** Concrete composition-root owners, never JSON data or a verdict callback. */
  readonly host_owners?: {
    readonly leases: HostOperationLeaseAuthority;
    readonly state_root: string;
  };
  readonly result_cache?: import("../host-operations/result-cache.js").HostOperationResultCacheV1;
  readonly capacity_options?: import("../host-operations/capacity-runtime.js").HostOperationCapacityRuntimeOptions;
  readonly config: VideogenPrivateConfigV1;
  readonly recipes: readonly VideogenEffectRecipeV1[];
  readonly effects: ReadonlyMap<string, VideogenEffectProviderV1>;
}
export function validateVideogenPrivateConfig(value: unknown): VideogenPrivateConfigV1 {
  const config = validateContract(
    VideogenPrivateConfigV1Schema,
    value,
    "videogen private configuration"
  );
  if (
    new Set((config.authored_products ?? []).map((x) => x.state)).size !==
      (config.authored_products ?? []).length ||
    new Set(config.assets.map((x) => x.asset_id)).size !== config.assets.length ||
    new Set(config.routes.map((x) => x.shot_id)).size !== config.routes.length ||
    new Set(config.initial_products.map((x) => x.slot)).size !== config.initial_products.length
  )
    throw new Error("duplicate videogen configured identity");
  return config;
}
