import { Type } from "typebox";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import { sameRef } from "./bounds.js";
import { slot, type VideogenExecutionStateV1 } from "./execution-state.js";
import { DeliveryIntentV1Schema } from "./delivery.js";
import { NativeBuildRequestV1Schema } from "./native-contracts.js";
import type { VideogenEffectRecipeV1 } from "./runtime-config.js";
import type { VideogenRuntime } from "./runtime.js";

/** Request bytes select the predecessor; a recipe cannot silently substitute the workflow ledger.
 * This is construction-time integrity, not use-time approval or qualification. */
export function effectPredecessor(
  runtime: VideogenRuntime,
  state: VideogenExecutionStateV1,
  recipe: VideogenEffectRecipeV1,
  fields: Readonly<Record<string, unknown>>
): ArtifactRef {
  let derived: ArtifactRef | undefined;
  const ref = (field: string) =>
    validateContract(ArtifactRefSchema, fields[field], `effect ${field}`);
  switch (fields.schema_id) {
    case "penny.videogen-delivery-operation-request.v1":
      derived = runtime.read(ref("delivery_intent_ref"), DeliveryIntentV1Schema).manifest_ref;
      break;
    case "penny.videogen-native-operation-request.v1":
    case "penny.timeline-master-request.v1":
      derived = runtime.read(ref("native_build_request_ref"), NativeBuildRequestV1Schema).edit_ref;
      break;
    case "penny.video-reference-upload-operation-request.v1":
      derived = ref("canonical_png_ref");
      break;
    case "penny.video-generation-operation-request.v1":
      derived = ref("submitted_graph_ref");
      break;
    case "penny.videogen-raw-media-decode-request.v1":
    case "penny.videogen-av-media-request.v1":
    case "penny.videogen-native-media-request.v1":
      derived = ref("media_ref");
      break;
    case "penny.videogen-voice-job-request.v1":
      derived = ref("asset_intent_ref");
      break;
  }
  const explicit =
    recipe.predecessor_slot === undefined ? undefined : slot(state, recipe.predecessor_slot);
  if (derived !== undefined && explicit !== undefined && !sameRef(derived, explicit))
    throw new Error("VIDEOGEN_EFFECT_PREDECESSOR_CONFLICT");
  const predecessor = derived ?? explicit;
  if (predecessor === undefined || !state.slots.some((s) => sameRef(s.ref, predecessor)))
    throw new Error("VIDEOGEN_EFFECT_SELECTED_PREDECESSOR_REQUIRED");
  return predecessor;
}

export const RuntimeBudgetPolicyEvidenceSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-runtime-budget-policy.v1"),
    schema_version: Type.Literal(1),
    kind: Type.Union([Type.Literal("queue"), Type.Literal("inactivity"), Type.Literal("cleanup")]),
    config_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    operation_kind: Type.String({ minLength: 1 }),
    adapter_id: Type.String({ minLength: 1 }),
    backend_binding_id: Type.String({ minLength: 1 }),
    backend_key_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    interval_ms: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    capacity_policy_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    capacity_binding_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    scope_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
