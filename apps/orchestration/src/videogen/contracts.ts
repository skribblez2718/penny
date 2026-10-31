import { Type, type Static } from "typebox";
import { ComfyInputNameSchema, assertComfyJson } from "../comfy/input-contracts.js";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, JsonValueSchema, type ArtifactRef } from "../contracts.js";
import {
  ImagegenNodeInputTypeV1Schema,
  type ImagegenGraphV1,
  type ImagegenMutationAddressV1,
  type ImagegenProfileNodeClassV1,
} from "../skill-contracts/imagegen.js";
import {
  OpaqueIdSchema,
  Sha256Schema,
  SkillSchemaValidationError,
  assertOpaqueId,
  assertUnique,
  validateSkillSchema,
} from "../skill-contracts/common.js";
import type { Mp4VideoMetadataV1, Mp4ValidationResultV1 } from "../mp4-media.js";

const NodeIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
});
const InputNameSchema = ComfyInputNameSchema;
// Video-only literal input compatibility; image profile schema remains unchanged.
const VideoGraphNodeSchema = Type.Object(
  {
    class_type: OpaqueIdSchema,
    inputs: Type.Record(InputNameSchema, JsonValueSchema, { maxProperties: 128 }),
    _meta: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 64 }), JsonValueSchema, {
        maxProperties: 32,
      })
    ),
  },
  { additionalProperties: false }
);
export const VideoGraphSchema = Type.Record(NodeIdSchema, VideoGraphNodeSchema, {
  minProperties: 1,
  maxProperties: 1024,
});
const VideoNodeClassSchema = Type.Object(
  {
    class_type: OpaqueIdSchema,
    execution_class: Type.Union([
      Type.Literal("pure_compute"),
      Type.Literal("backend_output"),
      Type.Literal("registered_input"),
    ]),
    inputs: Type.Array(
      Type.Object(
        {
          input_name: InputNameSchema,
          value_type: ImagegenNodeInputTypeV1Schema,
          semantic: Type.Union([
            Type.Literal("data"),
            Type.Literal("registered_asset"),
            Type.Literal("canonical_png_input"),
          ]),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 128 }
    ),
  },
  { additionalProperties: false }
);
const SafeSubfolderSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$",
});
const PromptSchema = Type.String({ maxLength: 32_768 });
const UINT32_MAX = 0xffff_ffff;

export const VideogenDimensionsV1Schema = Type.Object(
  {
    width: Type.Integer({ minimum: 64, maximum: 16_384 }),
    height: Type.Integer({ minimum: 64, maximum: 16_384 }),
  },
  { additionalProperties: false }
);
export type VideogenDimensionsV1 = Readonly<Static<typeof VideogenDimensionsV1Schema>>;

const MutationAddressSchema = Type.Object(
  { node_id: NodeIdSchema, input_name: InputNameSchema },
  { additionalProperties: false }
);

const MutationMapSchema = Type.Object(
  {
    positive_prompt: MutationAddressSchema,
    negative_prompt: MutationAddressSchema,
    seed: MutationAddressSchema,
    width: MutationAddressSchema,
    height: MutationAddressSchema,
    frame_count: MutationAddressSchema,
    fps: MutationAddressSchema,
    batch_size: MutationAddressSchema,
    filename_prefix: MutationAddressSchema,
    input_image: Type.Union([MutationAddressSchema, Type.Null()]),
    output_node_id: NodeIdSchema,
  },
  { additionalProperties: false }
);

const VideogenLimitsSchema = Type.Object(
  {
    max_prompt_bytes: Type.Integer({ minimum: 1, maximum: 262_144 }),
    max_graph_bytes: Type.Integer({ minimum: 1, maximum: 8_388_608 }),
    max_request_json_bytes: Type.Integer({ minimum: 1, maximum: 8_388_608 }),
    max_inventory_json_bytes: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    max_history_json_bytes: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    max_upload_bytes: Type.Integer({ minimum: 1, maximum: 67_108_864 }),
    max_video_bytes: Type.Integer({ minimum: 1, maximum: 4_294_967_296 }),
    poll_interval_ms: Type.Integer({ minimum: 1, maximum: 60_000 }),
    max_poll_attempts: Type.Integer({ minimum: 1, maximum: 100_000 }),
    max_transient_poll_failures: Type.Integer({ minimum: 0, maximum: 64 }),
    connect_timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
    read_timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
  },
  { additionalProperties: false }
);

export const VideogenProfileV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-profile.v1"),
    schema_version: Type.Literal(1),
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    source_graph_sha256: Sha256Schema,
    mode: Type.Union([Type.Literal("t2v"), Type.Literal("i2v")]),
    endpoint: Type.Object(
      {
        scheme: Type.Literal("http"),
        host: Type.Union([Type.Literal("127.0.0.1"), Type.Literal("::1")]),
        port: Type.Integer({ minimum: 1, maximum: 65_535 }),
      },
      { additionalProperties: false }
    ),
    source_graph: VideoGraphSchema,
    node_classes: Type.Array(VideoNodeClassSchema, {
      minItems: 1,
      maxItems: 1_024,
    }),
    mutations: MutationMapSchema,
    dimensions: Type.Array(VideogenDimensionsV1Schema, {
      minItems: 1,
      maxItems: 64,
    }),
    frame_counts: Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), {
      minItems: 1,
      maxItems: 64,
    }),
    fps_values: Type.Array(Type.Integer({ minimum: 1, maximum: 240 }), {
      minItems: 1,
      maxItems: 32,
    }),
    required_inventory: Type.Object(
      {
        class_types: Type.Array(OpaqueIdSchema, {
          minItems: 1,
          maxItems: 1_024,
          uniqueItems: true,
        }),
        model_ids: Type.Array(OpaqueIdSchema, {
          minItems: 1,
          maxItems: 1_024,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false }
    ),
    input_subfolder: SafeSubfolderSchema,
    limits: VideogenLimitsSchema,
  },
  { additionalProperties: false }
);
export type VideogenProfileV1 = Readonly<Static<typeof VideogenProfileV1Schema>>;
export type VideogenProfileBodyV1 = Omit<VideogenProfileV1, "profile_sha256">;

export const VideogenProfileSnapshotV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-profile-snapshot.v1"),
    schema_version: Type.Literal(1),
    profile: VideogenProfileV1Schema,
    approved_profile_sha256: Sha256Schema,
    source_graph_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type VideogenProfileSnapshotV1 = Readonly<Static<typeof VideogenProfileSnapshotV1Schema>>;

export const ComfyInputDescriptorV1Schema = Type.Object(
  {
    filename: Type.String({
      minLength: 1,
      maxLength: 255,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$",
    }),
    subfolder: SafeSubfolderSchema,
    type: Type.Literal("input"),
  },
  { additionalProperties: false }
);
export type ComfyInputDescriptorV1 = Readonly<Static<typeof ComfyInputDescriptorV1Schema>>;

export const ComfyOutputDescriptorV1Schema = Type.Object(
  {
    filename: Type.String({
      minLength: 1,
      maxLength: 255,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$",
    }),
    subfolder: Type.String({
      maxLength: 512,
      pattern: "^(?:[A-Za-z0-9][A-Za-z0-9._/-]{0,511})?$",
    }),
    type: Type.Union([Type.Literal("output"), Type.Literal("temp")]),
  },
  { additionalProperties: false }
);
export type ComfyOutputDescriptorV1 = Readonly<Static<typeof ComfyOutputDescriptorV1Schema>>;

export const VideoReferenceUploadOperationRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.video-reference-upload-operation-request.v1"),
    schema_version: Type.Literal(1),
    operation_id: Type.Optional(OpaqueIdSchema),
    run_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    profile_snapshot_ref: ArtifactRefSchema,
    canonical_png_ref: ArtifactRefSchema,
    canonical_png_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type VideoReferenceUploadOperationRequestV1 = Readonly<
  Static<typeof VideoReferenceUploadOperationRequestV1Schema>
>;

export const VideoReferenceUploadReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.video-reference-upload-receipt.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    canonical_png_ref: ArtifactRefSchema,
    canonical_png_sha256: Sha256Schema,
    canonical_png_bytes: Type.Integer({ minimum: 1, maximum: 67_108_864 }),
    remote_descriptor: ComfyInputDescriptorV1Schema,
    status: Type.Literal("uploaded_verified"),
  },
  { additionalProperties: false }
);
export type VideoReferenceUploadReceiptV1 = Readonly<
  Static<typeof VideoReferenceUploadReceiptV1Schema>
>;

export const VideogenRenderSpecV1Schema = Type.Object(
  {
    mode: Type.Union([Type.Literal("t2v"), Type.Literal("i2v")]),
    positive_prompt: PromptSchema,
    negative_prompt: PromptSchema,
    seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    dimensions: VideogenDimensionsV1Schema,
    frame_count: Type.Integer({ minimum: 1, maximum: 65_535 }),
    fps: Type.Integer({ minimum: 1, maximum: 240 }),
  },
  { additionalProperties: false }
);
export type VideogenRenderSpecV1 = Readonly<Static<typeof VideogenRenderSpecV1Schema>>;

export const VideoSubmittedGraphV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.video-submitted-graph.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    shot_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    profile_snapshot_ref: ArtifactRefSchema,
    mode: Type.Union([Type.Literal("t2v"), Type.Literal("i2v")]),
    dimensions: VideogenDimensionsV1Schema,
    frame_count: Type.Integer({ minimum: 1, maximum: 65_535 }),
    fps: Type.Integer({ minimum: 1, maximum: 240 }),
    seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    input_upload_receipt_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    input_descriptor: Type.Union([ComfyInputDescriptorV1Schema, Type.Null()]),
    output_node_id: NodeIdSchema,
    graph: VideoGraphSchema,
  },
  { additionalProperties: false }
);
export type VideoSubmittedGraphV1 = Readonly<Static<typeof VideoSubmittedGraphV1Schema>>;

export const VideoGenerationOperationRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.video-generation-operation-request.v1"),
    schema_version: Type.Literal(1),
    operation_id: Type.Optional(OpaqueIdSchema),
    run_id: OpaqueIdSchema,
    shot_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    profile_snapshot_ref: ArtifactRefSchema,
    submitted_graph_ref: ArtifactRefSchema,
    submitted_graph_sha256: Sha256Schema,
    mode: Type.Union([Type.Literal("t2v"), Type.Literal("i2v")]),
    dimensions: VideogenDimensionsV1Schema,
    frame_count: Type.Integer({ minimum: 1, maximum: 65_535 }),
    fps: Type.Integer({ minimum: 1, maximum: 240 }),
  },
  { additionalProperties: false }
);
export type VideoGenerationOperationRequestV1 = Readonly<
  Static<typeof VideoGenerationOperationRequestV1Schema>
>;

const VideoMetadataSchema = Type.Object(
  {
    container: Type.Literal("iso-bmff"),
    codec: Type.Union([Type.Literal("h264"), Type.Literal("hevc")]),
    width: Type.Integer({ minimum: 1, maximum: 16_384 }),
    height: Type.Integer({ minimum: 1, maximum: 16_384 }),
    frame_count: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    fps: Type.Number({ exclusiveMinimum: 0, maximum: 1_000 }),
    duration_seconds: Type.Number({ exclusiveMinimum: 0, maximum: 86_400 }),
    major_brand: Type.String({ minLength: 4, maxLength: 4 }),
    compatible_brands: Type.Array(Type.String({ minLength: 4, maxLength: 4 }), {
      maxItems: 64,
    }),
    byte_length: Type.Integer({ minimum: 1, maximum: 4_294_967_296 }),
    sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ValidationResultSchema = Type.Union([
  Type.Object(
    { status: Type.Literal("valid"), metadata: VideoMetadataSchema },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      status: Type.Literal("invalid"),
      reason_code: Type.String({ minLength: 1, maxLength: 64 }),
      detail: Type.String({ minLength: 1, maxLength: 512 }),
      byte_length: Type.Integer({ minimum: 0, maximum: 4_294_967_296 }),
      sha256: Sha256Schema,
    },
    { additionalProperties: false }
  ),
]);

export const VideoValidationReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.video-validation-receipt.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    shot_id: OpaqueIdSchema,
    prompt_id_sha256: Sha256Schema,
    validation: ValidationResultSchema,
  },
  { additionalProperties: false }
);
export type VideoValidationReceiptV1 = Readonly<Static<typeof VideoValidationReceiptV1Schema>>;

export const VideoGenerationOperationReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.video-generation-operation-receipt.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    shot_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    submitted_graph_ref: ArtifactRefSchema,
    submitted_graph_sha256: Sha256Schema,
    prompt_id: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
    }),
    remote_descriptor: ComfyOutputDescriptorV1Schema,
    poll_count: Type.Integer({ minimum: 1, maximum: 100_000 }),
    status: Type.Union([Type.Literal("persisted"), Type.Literal("downloaded_invalid")]),
    validation: ValidationResultSchema,
  },
  { additionalProperties: false }
);
export type VideoGenerationOperationReceiptV1 = Readonly<
  Static<typeof VideoGenerationOperationReceiptV1Schema>
>;

export function videogenProfileSha256(profile: VideogenProfileBodyV1): string {
  return sha256(canonicalJson(profile));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function graphInput(
  profile: VideogenProfileV1,
  address: ImagegenMutationAddressV1,
  label: string
): unknown {
  const node = profile.source_graph[address.node_id];
  if (node === undefined || !Object.hasOwn(node.inputs, address.input_name)) {
    throw new SkillSchemaValidationError(label, [
      "mutation address is absent from the source graph",
    ]);
  }
  return node.inputs[address.input_name];
}

export function validateVideogenProfile(value: unknown): VideogenProfileV1 {
  assertComfyJson(value);
  const profile = validateSkillSchema(VideogenProfileV1Schema, value, "VideogenProfileV1");
  assertOpaqueId(profile.profile_id, "VideogenProfileV1.profile_id");
  if (Buffer.byteLength(canonicalJson(profile.source_graph)) > profile.limits.max_graph_bytes)
    throw new Error("video source graph byte limit");
  const sourceDigest = sha256(canonicalJson(profile.source_graph));
  if (sourceDigest !== profile.source_graph_sha256) {
    throw new SkillSchemaValidationError("VideogenProfileV1.source_graph_sha256", [
      "digest does not match the canonical source graph",
    ]);
  }
  const { profile_sha256: profileDigest, ...body } = profile;
  if (profileDigest !== videogenProfileSha256(body)) {
    throw new SkillSchemaValidationError("VideogenProfileV1.profile_sha256", [
      "digest does not match the canonical profile body",
    ]);
  }
  assertUnique(
    profile.node_classes.map((entry) => entry.class_type),
    "VideogenProfileV1 node classes"
  );
  for (const [index, entry] of profile.node_classes.entries()) {
    assertOpaqueId(entry.class_type, `VideogenProfileV1.node_classes[${index}].class_type`);
    assertUnique(
      entry.inputs.map((input) => input.input_name),
      `VideogenProfileV1.node_classes[${index}] inputs`
    );
  }
  const classMap = new Map(
    profile.node_classes.map((entry: ImagegenProfileNodeClassV1) => [entry.class_type, entry])
  );
  for (const [nodeId, node] of Object.entries(profile.source_graph)) {
    const policy = classMap.get(node.class_type);
    if (policy === undefined) {
      throw new SkillSchemaValidationError("VideogenProfileV1.source_graph", [
        `node '${nodeId}' uses an unregistered class`,
      ]);
    }
    const inputs = new Map(policy.inputs.map((entry) => [entry.input_name, entry]));
    if (policy.inputs.some((p) => !Object.hasOwn(node.inputs, p.input_name)))
      throw new Error("video source graph missing declared input");
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      const inputPolicy = inputs.get(inputName);
      if (inputPolicy === undefined) {
        throw new SkillSchemaValidationError("VideogenProfileV1.source_graph", [
          `node '${nodeId}' input '${inputName}' is not allowlisted`,
        ]);
      }
      const valueTypeValid =
        inputPolicy.value_type === "json" ||
        (inputPolicy.value_type === "string" && typeof inputValue === "string") ||
        (inputPolicy.value_type === "boolean" && typeof inputValue === "boolean") ||
        (inputPolicy.value_type === "number" &&
          typeof inputValue === "number" &&
          Number.isFinite(inputValue)) ||
        (inputPolicy.value_type === "integer" &&
          typeof inputValue === "number" &&
          Number.isSafeInteger(inputValue));
      if (!valueTypeValid) {
        throw new SkillSchemaValidationError("VideogenProfileV1.source_graph", [
          `node '${nodeId}' input '${inputName}' violates its declared type`,
        ]);
      }
      if (
        inputPolicy.semantic === "registered_asset" &&
        (typeof inputValue !== "string" ||
          !profile.required_inventory.model_ids.includes(inputValue))
      ) {
        throw new SkillSchemaValidationError("VideogenProfileV1.source_graph", [
          `node '${nodeId}' input '${inputName}' is not bound to required inventory`,
        ]);
      }
    }
    if (!profile.required_inventory.class_types.includes(node.class_type)) {
      throw new SkillSchemaValidationError("VideogenProfileV1.required_inventory", [
        `source node class '${node.class_type}' is absent from required inventory`,
      ]);
    }
  }
  const outputNode = profile.source_graph[profile.mutations.output_node_id];
  const outputPolicy = outputNode === undefined ? undefined : classMap.get(outputNode.class_type);
  if (outputNode === undefined || outputPolicy?.execution_class !== "backend_output") {
    throw new SkillSchemaValidationError("VideogenProfileV1.mutations.output_node_id", [
      "output node must exist and use backend_output authority",
    ]);
  }
  const otherOutput = Object.entries(profile.source_graph).find(
    ([nodeId, node]) =>
      nodeId !== profile.mutations.output_node_id &&
      classMap.get(node.class_type)?.execution_class === "backend_output"
  );
  if (otherOutput !== undefined) {
    throw new SkillSchemaValidationError("VideogenProfileV1.node_classes", [
      "only the declared output node may use backend_output authority",
    ]);
  }
  const typedMutations: ReadonlyArray<
    readonly [string, ImagegenMutationAddressV1, "string" | "number"]
  > = [
    ["positive_prompt", profile.mutations.positive_prompt, "string"],
    ["negative_prompt", profile.mutations.negative_prompt, "string"],
    ["seed", profile.mutations.seed, "number"],
    ["width", profile.mutations.width, "number"],
    ["height", profile.mutations.height, "number"],
    ["frame_count", profile.mutations.frame_count, "number"],
    ["fps", profile.mutations.fps, "number"],
    ["batch_size", profile.mutations.batch_size, "number"],
    ["filename_prefix", profile.mutations.filename_prefix, "string"],
  ];
  for (const [name, address, expectedType] of typedMutations) {
    const found = graphInput(profile, address, `mutations.${name}`);
    if (typeof found !== expectedType) {
      throw new SkillSchemaValidationError(`VideogenProfileV1.mutations.${name}`, [
        "source input has the wrong primitive type",
      ]);
    }
  }
  if (profile.mode === "i2v" && profile.mutations.input_image === null) {
    throw new SkillSchemaValidationError("VideogenProfileV1.mutations.input_image", [
      "i2v profile requires an input image mutation",
    ]);
  }
  if (profile.mode === "t2v" && profile.mutations.input_image !== null) {
    throw new SkillSchemaValidationError("VideogenProfileV1.mutations.input_image", [
      "t2v profile must not expose an input image mutation",
    ]);
  }
  if (profile.mutations.input_image !== null) {
    const found = graphInput(profile, profile.mutations.input_image, "mutations.input_image");
    if (typeof found !== "string") {
      throw new SkillSchemaValidationError("VideogenProfileV1.mutations.input_image", [
        "source input image value must be a string",
      ]);
    }
  }
  assertUnique(
    profile.dimensions.map((entry) => `${entry.width}x${entry.height}`),
    "VideogenProfileV1 dimensions"
  );
  assertUnique(profile.frame_counts.map(String), "VideogenProfileV1 frame counts");
  assertUnique(profile.fps_values.map(String), "VideogenProfileV1 fps values");
  return profile;
}

export function validateVideogenProfileSnapshot(value: unknown): VideogenProfileSnapshotV1 {
  assertComfyJson(value);
  const snapshot = validateSkillSchema(
    VideogenProfileSnapshotV1Schema,
    value,
    "VideogenProfileSnapshotV1"
  );
  validateVideogenProfile(snapshot.profile);
  if (
    snapshot.approved_profile_sha256 !== snapshot.profile.profile_sha256 ||
    snapshot.source_graph_sha256 !== snapshot.profile.source_graph_sha256
  ) {
    throw new SkillSchemaValidationError("VideogenProfileSnapshotV1", [
      "snapshot digests do not match the embedded profile",
    ]);
  }
  return snapshot;
}

export function validateVideoReferenceUploadOperationRequest(
  value: unknown
): VideoReferenceUploadOperationRequestV1 {
  return validateSkillSchema(
    VideoReferenceUploadOperationRequestV1Schema,
    value,
    "VideoReferenceUploadOperationRequestV1"
  );
}

export function validateVideoReferenceUploadReceipt(value: unknown): VideoReferenceUploadReceiptV1 {
  return validateSkillSchema(
    VideoReferenceUploadReceiptV1Schema,
    value,
    "VideoReferenceUploadReceiptV1"
  );
}

export function validateVideogenRenderSpec(value: unknown): VideogenRenderSpecV1 {
  const spec = validateSkillSchema(VideogenRenderSpecV1Schema, value, "VideogenRenderSpecV1");
  if (utf8Bytes(spec.positive_prompt) > 131_072 || utf8Bytes(spec.negative_prompt) > 131_072) {
    throw new SkillSchemaValidationError("VideogenRenderSpecV1", [
      "prompt bytes exceed the hard limit",
    ]);
  }
  return spec;
}

export function validateVideoSubmittedGraph(value: unknown): VideoSubmittedGraphV1 {
  assertComfyJson(value);
  return validateSkillSchema(VideoSubmittedGraphV1Schema, value, "VideoSubmittedGraphV1");
}

export function validateVideoGenerationOperationRequest(
  value: unknown
): VideoGenerationOperationRequestV1 {
  return validateSkillSchema(
    VideoGenerationOperationRequestV1Schema,
    value,
    "VideoGenerationOperationRequestV1"
  );
}

export function validateVideoValidationReceipt(value: unknown): VideoValidationReceiptV1 {
  return validateSkillSchema(VideoValidationReceiptV1Schema, value, "VideoValidationReceiptV1");
}

export function validateVideoGenerationOperationReceipt(
  value: unknown
): VideoGenerationOperationReceiptV1 {
  return validateSkillSchema(
    VideoGenerationOperationReceiptV1Schema,
    value,
    "VideoGenerationOperationReceiptV1"
  );
}

export function asVideoValidationResult(value: Mp4ValidationResultV1):
  | { readonly status: "valid"; readonly metadata: Mp4VideoMetadataV1 }
  | {
      readonly status: "invalid";
      readonly reason_code: string;
      readonly detail: string;
      readonly byte_length: number;
      readonly sha256: string;
    } {
  return value;
}

export function assertRefEqual(left: ArtifactRef, right: ArtifactRef, label: string): void {
  if (canonicalJson(left) !== canonicalJson(right))
    throw new Error(`${label} artifact reference differs`);
}

export type VideogenGraphV1 = ImagegenGraphV1;
