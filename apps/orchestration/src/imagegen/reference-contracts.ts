import { Type, type Static } from "typebox";
import { ArtifactRefSchema } from "../contracts.js";
import {
  OpaqueIdSchema,
  Sha256Schema,
  TextSchema,
  validateSkillSchema,
} from "../skill-contracts/common.js";

const closed = { additionalProperties: false } as const;
const integer = Type.Integer({ minimum: 0, maximum: 16_384 });
const address = Type.Object(
  {
    node_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" }),
    input_name: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }),
  },
  closed
);
export const ImageEditAreaV1Schema = Type.Union([
  Type.Object({ kind: Type.Literal("whole") }, closed),
  Type.Object({ kind: Type.Literal("mask"), mask_ref: ArtifactRefSchema }, closed),
  Type.Object(
    {
      kind: Type.Literal("rectangle"),
      x: integer,
      y: integer,
      width: Type.Integer({ minimum: 1, maximum: 16_384 }),
      height: Type.Integer({ minimum: 1, maximum: 16_384 }),
    },
    closed
  ),
]);
export const ImageAssetRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-asset-request.v1"),
    schema_version: Type.Literal(1),
    intent_ref: ArtifactRefSchema,
    call_index: Type.Integer({ minimum: 1, maximum: 30 }),
    input: Type.Union([
      Type.Object({ kind: Type.Literal("fresh") }, closed),
      Type.Object(
        {
          kind: Type.Literal("revision"),
          source_ref: ArtifactRefSchema,
          area: ImageEditAreaV1Schema,
        },
        closed
      ),
    ]),
  },
  closed
);
export type ImageAssetRequestV1 = Static<typeof ImageAssetRequestV1Schema>;
export const ImageRevisionCapabilityV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-revision-capability.v1"),
    schema_version: Type.Literal(1),
    method: Type.Union([Type.Literal("img2img"), Type.Literal("inpaint")]),
    implementation_sha256: Sha256Schema,
    source_port: address,
    mask_port: Type.Union([address, Type.Null()]),
    backend_mask_polarity: Type.Union([
      Type.Literal("white_edit"),
      Type.Literal("black_edit"),
      Type.Null(),
    ]),
    input_subfolder: Type.String({
      maxLength: 128,
      pattern: "^(?:[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*)?$",
    }),
  },
  closed
);
export type ImageRevisionCapabilityV1 = Static<typeof ImageRevisionCapabilityV1Schema>;
export const ImageInputBindingV1Schema = Type.Object(
  {
    asset: ImageAssetRequestV1Schema,
    source_ref: ArtifactRefSchema,
    edit_mask_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    backend_mask_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    uploads: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
  },
  closed
);
export type ImageInputBindingV1 = Static<typeof ImageInputBindingV1Schema>;
export const ImageInputUploadRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-input-upload-request.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    profile_snapshot_ref: ArtifactRefSchema,
    reservation_id: OpaqueIdSchema,
    max_renders: Type.Integer({ minimum: 1, maximum: 30 }),
    asset: ImageAssetRequestV1Schema,
    role: Type.Union([Type.Literal("source"), Type.Literal("mask")]),
    png_ref: ArtifactRefSchema,
  },
  closed
);
export type ImageInputUploadRequestV1 = Static<typeof ImageInputUploadRequestV1Schema>;
export const ImageInputUploadReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-input-upload-receipt.v1"),
    schema_version: Type.Literal(1),
    operation_record_id: OpaqueIdSchema,
    request: ImageInputUploadRequestV1Schema,
    locator: Type.Object(
      {
        filename: Type.String({ pattern: "^[a-f0-9]{64}\\.png$" }),
        subfolder: Type.String({
          maxLength: 128,
          pattern: "^(?:[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*)?$",
        }),
        type: Type.Literal("input"),
      },
      closed
    ),
    verified_sha256: Sha256Schema,
  },
  closed
);
export type ImageInputUploadReceiptV1 = Static<typeof ImageInputUploadReceiptV1Schema>;
export const ImageRevisionTransformationV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-revision-transformation.v1"),
    schema_version: Type.Literal(1),
    binding: ImageInputBindingV1Schema,
    method: Type.Union([Type.Literal("img2img"), Type.Literal("inpaint")]),
    raw_sha256: Sha256Schema,
    final_sha256: Sha256Schema,
    descriptor_sha256: Sha256Schema,
    outside_pixels_verified: Type.Integer({ minimum: 0, maximum: 16_777_216 }),
    preservation: Type.Union([Type.Literal("semantic_review"), Type.Literal("exact_outside")]),
  },
  closed
);
export type ImageRevisionTransformationV1 = Static<typeof ImageRevisionTransformationV1Schema>;
export const ImageAssetCallV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-asset-call.v1"),
    schema_version: Type.Literal(1),
    asset: ImageAssetRequestV1Schema,
    image_run_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    max_renders: Type.Integer({ minimum: 1, maximum: 30 }),
    cost_microcredits: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  closed
);
export const ImageAssetResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-asset-result.v1"),
    schema_version: Type.Literal(1),
    origin: Type.Union([Type.Literal("fresh"), Type.Literal("revision"), Type.Literal("supplied")]),
    intent_ref: ArtifactRefSchema,
    png_ref: ArtifactRefSchema,
    source_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    mask_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    raw_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    transformation_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    upload_refs: Type.Array(ArtifactRefSchema, { maxItems: 2, uniqueItems: true }),
    render_receipt_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    validity_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    quality_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
  },
  closed
);
export const ImageAssetCriteriaV1Schema = Type.Object(
  {
    allowed_change: TextSchema({ minBytes: 1, maxBytes: 131_072, multiline: true }),
    preserve_criteria: Type.Array(TextSchema({ minBytes: 1, maxBytes: 131_072, multiline: true }), {
      minItems: 1,
      maxItems: 64,
    }),
  },
  closed
);
export const validateImageAssetRequest = (value: unknown): ImageAssetRequestV1 =>
  validateSkillSchema(ImageAssetRequestV1Schema, value, "image asset request");
export const validateImageInputUploadRequest = (value: unknown): ImageInputUploadRequestV1 =>
  validateSkillSchema(ImageInputUploadRequestV1Schema, value, "image input upload request");
export const validateImageInputUploadReceipt = (value: unknown): ImageInputUploadReceiptV1 =>
  validateSkillSchema(ImageInputUploadReceiptV1Schema, value, "image input upload receipt");

const RevisionCriterionV1Schema = Type.Object(
  {
    criterion: TextSchema({ minBytes: 1, maxBytes: 131_072, multiline: true }),
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")]),
    observation: TextSchema({ minBytes: 1, maxBytes: 131_072, multiline: true }),
  },
  closed
);
export const ImageRevisionReviewV1Schema = Type.Object(
  {
    allowed_change: RevisionCriterionV1Schema,
    preserve_criteria: Type.Array(RevisionCriterionV1Schema, { minItems: 1, maxItems: 64 }),
  },
  closed
);
export type ImageRevisionReviewV1 = Static<typeof ImageRevisionReviewV1Schema>;
export function imageRevisionReviewPasses(
  review: ImageRevisionReviewV1 | undefined,
  criteria: Static<typeof ImageAssetCriteriaV1Schema>
): boolean {
  return (
    review !== undefined &&
    review.allowed_change.criterion === criteria.allowed_change &&
    review.allowed_change.verdict === "pass" &&
    review.preserve_criteria.length === criteria.preserve_criteria.length &&
    review.preserve_criteria.every(
      (entry, i) => entry.criterion === criteria.preserve_criteria[i] && entry.verdict === "pass"
    )
  );
}
