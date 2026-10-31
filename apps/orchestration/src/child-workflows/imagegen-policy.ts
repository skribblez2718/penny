import { Type, type Static } from "typebox";
import { ChildWorkflowProgressLeaseBindingV1Schema } from "../contracts.js";
import {
  OpaqueIdSchema,
  Sha256Schema,
  assertUnique,
  validateSkillSchema,
} from "../skill-contracts/common.js";

/** Separate authority: never extends the seven ordinary generic-child peers or their one-call cap. */
export const ImagegenChildPolicyV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    authorization_id: Type.Literal("operator.controlled-imagegen-child.v1"),
    max_nesting_depth: Type.Literal(1),
    max_active_children: Type.Literal(1),
    max_calls: Type.Integer({ minimum: 1, maximum: 30 }),
    project_concurrency_limit: Type.Integer({ minimum: 1, maximum: 32 }),
    asset_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 30 }),
    parent_states: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 30 }),
    provider_registration_sha256: Sha256Schema,
    progress_lease: ChildWorkflowProgressLeaseBindingV1Schema,
  },
  { additionalProperties: false }
);
export type ImagegenChildPolicyV1 = Readonly<Static<typeof ImagegenChildPolicyV1Schema>>;
export function validateImagegenChildPolicy(value: unknown): ImagegenChildPolicyV1 {
  const policy = validateSkillSchema(ImagegenChildPolicyV1Schema, value, "ImagegenChildPolicyV1");
  assertUnique(policy.asset_ids, "imagegen child asset IDs");
  assertUnique(policy.parent_states, "imagegen child parent states");
  return policy;
}
export const IMAGEGEN_CHILD_OUTPUT = Object.freeze({
  schema_version: 1 as const,
  port_name: "asset_result",
  schema_id: "penny.image-asset-result.v1",
  schema_version_required: 1,
  artifact_kind: "image-asset-result",
});
