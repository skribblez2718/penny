import { ImageRevisionReviewV1Schema } from "../imagegen/reference-contracts.js";
import {
  ImageAssetRequestV1Schema,
  ImageRevisionCapabilityV1Schema,
  ImageInputBindingV1Schema,
} from "../imagegen/reference-contracts.js";
import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  JsonValueSchema,
  type ArtifactRef,
  type JsonValue,
} from "../contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  SchemaIdSchema,
  Sha256Schema,
  SkillSchemaValidationError,
  TextSchema,
  assertOpaqueId,
  assertRfc3339Utc,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "./common.js";

export const IMAGEGEN_MAX_CANDIDATES = 10 as const;
export const IMAGEGEN_MAX_REVISION_ROUNDS = 2 as const;
export const IMAGEGEN_MAX_ACCEPTED_JOBS = 30 as const;
export const IMAGEGEN_MAX_PROMPT_CHARACTERS = 32_768 as const;
export const IMAGEGEN_MAX_PROMPT_BYTES = 131_072 as const;
export const IMAGEGEN_MAX_GRAPH_BYTES = 4_194_304 as const;
export const IMAGEGEN_MAX_IMAGE_BYTES = 67_108_864 as const;
export const IMAGEGEN_MAX_PIXELS = 16_777_216 as const;
export const IMAGEGEN_MAX_RUN_STORAGE_BYTES = 4_294_967_296 as const;

const UINT32_MAX = 0xffff_ffff;
const MAX_PROFILE_DESCRIPTION_BYTES = 4_096;
const MAX_PROFILE_NODES = 1_024;
const MAX_PROFILE_INPUTS_PER_CLASS = 128;
const MAX_REQUIRED_INVENTORY_ITEMS = 1_024;
const MAX_REVIEW_FINDINGS = 128;
const MAX_MANIFEST_LINEAGE = 512;
const NODE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";
const INPUT_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]{0,63}$";
const SAFE_DIRECTORY_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";

const NodeIdSchema = Type.String({ minLength: 1, maxLength: 64, pattern: NODE_ID_PATTERN });
const InputNameSchema = Type.String({ minLength: 1, maxLength: 64, pattern: INPUT_NAME_PATTERN });
const PromptTextSchema = TextSchema({ maxBytes: IMAGEGEN_MAX_PROMPT_BYTES, multiline: true });
const PositiveIntegerSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export const ImageDimensionsV1Schema = Type.Object(
  {
    width: Type.Integer({ minimum: 1, maximum: 16_384 }),
    height: Type.Integer({ minimum: 1, maximum: 16_384 }),
  },
  { additionalProperties: false }
);
export type ImageDimensionsV1 = Readonly<Static<typeof ImageDimensionsV1Schema>>;

export const ImagegenExportRequestV1Schema = Type.Object(
  {
    destination_id: OpaqueIdSchema,
    directory_name: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: SAFE_DIRECTORY_NAME_PATTERN,
    }),
  },
  { additionalProperties: false }
);
export type ImagegenExportRequestV1 = Readonly<Static<typeof ImagegenExportRequestV1Schema>>;

export const ImagegenRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.imagegen-request.v1"),
    schema_version: Type.Literal(1),
    goal: PromptTextSchema,
    profile_id: OpaqueIdSchema,
    count: Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_CANDIDATES }),
    seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    max_revision_rounds: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS }),
    raw_prompt: Type.Union([PromptTextSchema, Type.Null()]),
    dimensions: Type.Union([ImageDimensionsV1Schema, Type.Null()]),
    export: Type.Union([ImagegenExportRequestV1Schema, Type.Null()]),
    asset: Type.Optional(ImageAssetRequestV1Schema),
  },
  { additionalProperties: false }
);
export type ImagegenRequestV1 = Readonly<Static<typeof ImagegenRequestV1Schema>>;

export const ImagegenCallerConstraintsV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    profile_id: Type.Optional(OpaqueIdSchema),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_CANDIDATES })),
    seed: Type.Optional(Type.Integer({ minimum: 0, maximum: UINT32_MAX })),
    max_revision_rounds: Type.Optional(
      Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS })
    ),
    raw_prompt: Type.Optional(Type.Union([PromptTextSchema, Type.Null()])),
    dimensions: Type.Optional(Type.Union([ImageDimensionsV1Schema, Type.Null()])),
    export: Type.Optional(Type.Union([ImagegenExportRequestV1Schema, Type.Null()])),
    asset: Type.Optional(ImageAssetRequestV1Schema),
  },
  { additionalProperties: false }
);
export type ImagegenCallerConstraintsV1 = Readonly<
  Static<typeof ImagegenCallerConstraintsV1Schema>
>;

export interface ImagegenRequestIntentV1 {
  readonly schema_version: 1;
  readonly asset?: Static<typeof ImageAssetRequestV1Schema>;
  readonly goal: string;
  readonly requested_profile_id: string | null;
  readonly count: number;
  readonly requested_seed: number | null;
  readonly max_revision_rounds: number;
  readonly raw_prompt: string | null;
  readonly dimensions: ImageDimensionsV1 | null;
  readonly export: ImagegenExportRequestV1 | null;
}

function assertPromptText(value: string, label: string, trimmedNonEmpty: boolean): void {
  if (value.length > IMAGEGEN_MAX_PROMPT_CHARACTERS) {
    throw new SkillSchemaValidationError(label, [
      `text exceeds ${IMAGEGEN_MAX_PROMPT_CHARACTERS} Unicode code units`,
    ]);
  }
  assertText(value, label, {
    minBytes: trimmedNonEmpty ? 1 : 0,
    maxBytes: IMAGEGEN_MAX_PROMPT_BYTES,
    multiline: true,
    trimmedNonEmpty,
  });
}

export function validateImagegenRequest(value: unknown): ImagegenRequestV1 {
  const request = validateSkillSchema(ImagegenRequestV1Schema, value, "ImagegenRequestV1");
  assertOpaqueId(request.profile_id, "ImagegenRequestV1.profile_id");
  assertPromptText(request.goal, "ImagegenRequestV1.goal", true);
  if (request.raw_prompt !== null) {
    assertPromptText(request.raw_prompt, "ImagegenRequestV1.raw_prompt", true);
  }
  if (request.dimensions !== null) assertImageDimensions(request.dimensions, "request dimensions");
  if (request.export !== null) {
    assertOpaqueId(request.export.destination_id, "ImagegenRequestV1.export.destination_id");
    assertSafeDirectoryName(
      request.export.directory_name,
      "ImagegenRequestV1.export.directory_name"
    );
  }
  return request;
}

export function parseImagegenRequestIntent(input: {
  readonly goal: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
}): ImagegenRequestIntentV1 {
  const constraints = validateSkillSchema(
    ImagegenCallerConstraintsV1Schema,
    input.constraints,
    "Imagegen caller constraints"
  );
  const goal = input.goal.normalize("NFC");
  assertPromptText(goal, "imagegen goal", true);
  const rawPrompt = constraints.raw_prompt ?? null;
  if (rawPrompt !== null) assertPromptText(rawPrompt, "constraints.raw_prompt", true);
  const requestedProfileId = constraints.profile_id ?? null;
  if (requestedProfileId !== null) assertOpaqueId(requestedProfileId, "constraints.profile_id");
  const exportRequest = constraints.export ?? null;
  if (exportRequest !== null) {
    assertOpaqueId(exportRequest.destination_id, "constraints.export.destination_id");
    assertSafeDirectoryName(exportRequest.directory_name, "constraints.export.directory_name");
  }
  const dimensions = constraints.dimensions ?? null;
  if (dimensions !== null) assertImageDimensions(dimensions, "constraints.dimensions");
  return {
    schema_version: 1,
    goal,
    requested_profile_id: requestedProfileId,
    count: constraints.count ?? 3,
    requested_seed: constraints.seed ?? null,
    max_revision_rounds: constraints.max_revision_rounds ?? 1,
    raw_prompt: rawPrompt,
    dimensions,
    export: exportRequest,
    ...(constraints.asset === undefined ? {} : { asset: constraints.asset }),
  };
}

export function materializeImagegenRequest(input: {
  readonly intent: ImagegenRequestIntentV1;
  readonly profile_id: string;
  readonly seed: number;
}): ImagegenRequestV1 {
  return validateImagegenRequest({
    schema_id: "penny.imagegen-request.v1",
    schema_version: 1,
    goal: input.intent.goal,
    profile_id: input.profile_id,
    count: input.intent.count,
    seed: input.seed,
    max_revision_rounds: input.intent.max_revision_rounds,
    raw_prompt: input.intent.raw_prompt,
    dimensions: input.intent.dimensions,
    export: input.intent.export,
    ...(input.intent.asset === undefined ? {} : { asset: input.intent.asset }),
  });
}

export function imagegenAcceptedJobCeiling(request: ImagegenRequestV1): number {
  const validated = validateImagegenRequest(request);
  return validated.count * (1 + validated.max_revision_rounds);
}

export function imagegenEffectiveSeed(baseSeed: number, slot: number): number {
  if (!Number.isInteger(baseSeed) || baseSeed < 0 || baseSeed > UINT32_MAX) {
    throw new SkillSchemaValidationError("imagegen base seed", [
      "seed must be an unsigned 32-bit integer",
    ]);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= IMAGEGEN_MAX_CANDIDATES) {
    throw new SkillSchemaValidationError("imagegen candidate slot", [
      "slot is outside the supported range",
    ]);
  }
  return (baseSeed + slot) >>> 0;
}

export const ImagegenGraphNodeV1Schema = Type.Object(
  {
    class_type: OpaqueIdSchema,
    inputs: Type.Record(InputNameSchema, JsonValueSchema, {
      maxProperties: MAX_PROFILE_INPUTS_PER_CLASS,
    }),
    _meta: Type.Optional(
      Type.Record(Type.String({ minLength: 1, maxLength: 64 }), JsonValueSchema, {
        maxProperties: 32,
      })
    ),
  },
  { additionalProperties: false }
);
export type ImagegenGraphNodeV1 = Readonly<Static<typeof ImagegenGraphNodeV1Schema>>;

export const ImagegenGraphV1Schema = Type.Record(NodeIdSchema, ImagegenGraphNodeV1Schema, {
  minProperties: 1,
  maxProperties: MAX_PROFILE_NODES,
});
export type ImagegenGraphV1 = Readonly<Static<typeof ImagegenGraphV1Schema>>;

export const ImagegenNodeInputTypeV1Schema = Type.Union([
  Type.Literal("string"),
  Type.Literal("integer"),
  Type.Literal("number"),
  Type.Literal("boolean"),
  Type.Literal("json"),
]);
export type ImagegenNodeInputTypeV1 = Static<typeof ImagegenNodeInputTypeV1Schema>;

export const ImagegenNodeInputPolicyV1Schema = Type.Object(
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
);
export type ImagegenNodeInputPolicyV1 = Readonly<Static<typeof ImagegenNodeInputPolicyV1Schema>>;

export const ImagegenProfileNodeClassV1Schema = Type.Object(
  {
    class_type: OpaqueIdSchema,
    execution_class: Type.Union([
      Type.Literal("pure_compute"),
      Type.Literal("backend_output"),
      Type.Literal("registered_input"),
    ]),
    inputs: Type.Array(ImagegenNodeInputPolicyV1Schema, {
      minItems: 1,
      maxItems: MAX_PROFILE_INPUTS_PER_CLASS,
    }),
  },
  { additionalProperties: false }
);
export type ImagegenProfileNodeClassV1 = Readonly<Static<typeof ImagegenProfileNodeClassV1Schema>>;

export const ImagegenMutationAddressV1Schema = Type.Object(
  {
    node_id: NodeIdSchema,
    input_name: InputNameSchema,
  },
  { additionalProperties: false }
);
export type ImagegenMutationAddressV1 = Readonly<Static<typeof ImagegenMutationAddressV1Schema>>;

const ImagegenMutationMapV1Schema = Type.Object(
  {
    positive_prompt: ImagegenMutationAddressV1Schema,
    negative_prompt: ImagegenMutationAddressV1Schema,
    seed: ImagegenMutationAddressV1Schema,
    width: ImagegenMutationAddressV1Schema,
    height: ImagegenMutationAddressV1Schema,
    batch_size: ImagegenMutationAddressV1Schema,
    filename_prefix: ImagegenMutationAddressV1Schema,
    output_node_id: NodeIdSchema,
  },
  { additionalProperties: false }
);

const ImagegenDimensionPolicyV1Schema = Type.Union([
  Type.Object(
    {
      policy: Type.Literal("allowlist"),
      values: Type.Array(ImageDimensionsV1Schema, { minItems: 1, maxItems: 64 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      policy: Type.Literal("range"),
      min_width: Type.Integer({ minimum: 1, maximum: 16_384 }),
      max_width: Type.Integer({ minimum: 1, maximum: 16_384 }),
      min_height: Type.Integer({ minimum: 1, maximum: 16_384 }),
      max_height: Type.Integer({ minimum: 1, maximum: 16_384 }),
      step: Type.Integer({ minimum: 1, maximum: 4_096 }),
    },
    { additionalProperties: false }
  ),
]);
export type ImagegenDimensionPolicyV1 = Readonly<Static<typeof ImagegenDimensionPolicyV1Schema>>;

const ImagegenFallbackRewriteV1Schema = Type.Object(
  {
    node_id: NodeIdSchema,
    input_name: InputNameSchema,
    value: JsonValueSchema,
  },
  { additionalProperties: false }
);

const ImagegenFallbackV1Schema = Type.Object(
  {
    fallback_id: OpaqueIdSchema,
    when_model_ids_absent: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: MAX_REQUIRED_INVENTORY_ITEMS,
      uniqueItems: true,
    }),
    object_info_sha256: Sha256Schema,
    required_model_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: MAX_REQUIRED_INVENTORY_ITEMS,
      uniqueItems: true,
    }),
    rewrites: Type.Array(ImagegenFallbackRewriteV1Schema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false }
);

export const ImagegenProfileLimitsV1Schema = Type.Object(
  {
    max_prompt_characters: Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_PROMPT_CHARACTERS }),
    max_prompt_bytes: Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_PROMPT_BYTES }),
    max_graph_bytes: Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_GRAPH_BYTES }),
    max_request_json_bytes: Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_GRAPH_BYTES }),
    max_inventory_json_bytes: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    max_history_json_bytes: Type.Integer({ minimum: 1, maximum: 16_777_216 }),
    max_image_bytes: Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_IMAGE_BYTES }),
    max_pixels: Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_PIXELS }),
    poll_interval_ms: Type.Integer({ minimum: 1, maximum: 60_000 }),
    max_poll_attempts: Type.Integer({ minimum: 1, maximum: 10_000 }),
    max_transient_poll_failures: Type.Integer({ minimum: 0, maximum: 64 }),
    connect_timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
    read_timeout_ms: Type.Integer({ minimum: 1, maximum: 300_000 }),
    candidate_inactivity_ms: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
    workflow_inactivity_ms: Type.Integer({ minimum: 1, maximum: 28_800_000 }),
    max_run_storage_bytes: Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_RUN_STORAGE_BYTES }),
    max_proven_pre_acceptance_retries: Type.Integer({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false }
);
export type ImagegenProfileLimitsV1 = Readonly<Static<typeof ImagegenProfileLimitsV1Schema>>;

export const ImagegenProfileV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.imagegen-profile.v1"),
    schema_version: Type.Literal(1),
    profile_id: OpaqueIdSchema,
    description: TextSchema({
      minBytes: 1,
      maxBytes: MAX_PROFILE_DESCRIPTION_BYTES,
      multiline: true,
    }),
    profile_sha256: Sha256Schema,
    source_graph_sha256: Sha256Schema,
    endpoint: Type.Object(
      {
        scheme: Type.Literal("http"),
        host: Type.Union([Type.Literal("127.0.0.1"), Type.Literal("::1")]),
        port: Type.Integer({ minimum: 1, maximum: 65_535 }),
      },
      { additionalProperties: false }
    ),
    source_graph: ImagegenGraphV1Schema,
    node_classes: Type.Array(ImagegenProfileNodeClassV1Schema, {
      minItems: 1,
      maxItems: MAX_PROFILE_NODES,
    }),
    mutations: ImagegenMutationMapV1Schema,
    dimension_policy: ImagegenDimensionPolicyV1Schema,
    default_dimensions: ImageDimensionsV1Schema,
    required_inventory: Type.Object(
      {
        object_info_sha256: Sha256Schema,
        class_types: Type.Array(OpaqueIdSchema, {
          minItems: 1,
          maxItems: MAX_REQUIRED_INVENTORY_ITEMS,
          uniqueItems: true,
        }),
        model_ids: Type.Array(OpaqueIdSchema, {
          maxItems: MAX_REQUIRED_INVENTORY_ITEMS,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false }
    ),
    fallback: Type.Union([ImagegenFallbackV1Schema, Type.Null()]),
    prompt_scaffold: Type.Object(
      {
        prefix: PromptTextSchema,
        suffix: PromptTextSchema,
        wordless_negative: PromptTextSchema,
      },
      { additionalProperties: false }
    ),
    revision_capability: Type.Optional(ImageRevisionCapabilityV1Schema),
    limits: ImagegenProfileLimitsV1Schema,
  },
  { additionalProperties: false }
);
export type ImagegenProfileV1 = Readonly<Static<typeof ImagegenProfileV1Schema>>;
export type ImagegenProfileBodyV1 = Omit<ImagegenProfileV1, "profile_sha256">;

export function imagegenProfileSha256(profile: ImagegenProfileBodyV1): string {
  return sha256(canonicalJson(profile));
}

function assertImageDimensions(dimensions: ImageDimensionsV1, label: string): void {
  const pixels = dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(pixels) || pixels > IMAGEGEN_MAX_PIXELS) {
    throw new SkillSchemaValidationError(label, ["dimensions exceed the imagegen pixel ceiling"]);
  }
}

export function profilePermitsDimensions(
  profile: ImagegenProfileV1,
  dimensions: ImageDimensionsV1
): boolean {
  assertImageDimensions(dimensions, "image dimensions");
  const policy = profile.dimension_policy;
  if (policy.policy === "allowlist") {
    return policy.values.some(
      (value) => value.width === dimensions.width && value.height === dimensions.height
    );
  }
  return (
    dimensions.width >= policy.min_width &&
    dimensions.width <= policy.max_width &&
    dimensions.height >= policy.min_height &&
    dimensions.height <= policy.max_height &&
    (dimensions.width - policy.min_width) % policy.step === 0 &&
    (dimensions.height - policy.min_height) % policy.step === 0
  );
}

function jsonValueMatchesType(value: JsonValue, type: ImagegenNodeInputTypeV1): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

function profileAddressInput(
  profile: ImagegenProfileV1,
  address: ImagegenMutationAddressV1,
  label: string
): { readonly value: JsonValue; readonly policy: ImagegenNodeInputPolicyV1 } {
  const node = profile.source_graph[address.node_id];
  if (node === undefined) {
    throw new SkillSchemaValidationError(label, [`node '${address.node_id}' does not exist`]);
  }
  if (!Object.hasOwn(node.inputs, address.input_name)) {
    throw new SkillSchemaValidationError(label, [
      `input '${address.input_name}' does not exist on node '${address.node_id}'`,
    ]);
  }
  const classPolicy = profile.node_classes.find(
    (candidate) => candidate.class_type === node.class_type
  );
  const inputPolicy = classPolicy?.inputs.find(
    (candidate) => candidate.input_name === address.input_name
  );
  if (inputPolicy === undefined) {
    throw new SkillSchemaValidationError(label, ["mutation address is not profile-allowlisted"]);
  }
  const value = node.inputs[address.input_name];
  if (value === undefined) {
    throw new SkillSchemaValidationError(label, ["mutation input has no source value"]);
  }
  return { value, policy: inputPolicy };
}

export function validateImagegenProfile(value: unknown): ImagegenProfileV1 {
  const profile = validateSkillSchema(ImagegenProfileV1Schema, value, "ImagegenProfileV1");
  assertOpaqueId(profile.profile_id, "ImagegenProfileV1.profile_id");
  assertText(profile.description, "ImagegenProfileV1.description", {
    minBytes: 1,
    maxBytes: MAX_PROFILE_DESCRIPTION_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  for (const [name, valueText] of Object.entries(profile.prompt_scaffold)) {
    assertPromptText(valueText, `ImagegenProfileV1.prompt_scaffold.${name}`, false);
  }
  const sourceGraphSha256 = sha256(canonicalJson(profile.source_graph));
  if (sourceGraphSha256 !== profile.source_graph_sha256) {
    throw new SkillSchemaValidationError("ImagegenProfileV1.source_graph_sha256", [
      "digest does not match the canonical source graph",
    ]);
  }
  const { profile_sha256: profileSha256, ...profileBody } = profile;
  if (profileSha256 !== imagegenProfileSha256(profileBody)) {
    throw new SkillSchemaValidationError("ImagegenProfileV1.profile_sha256", [
      "digest does not match the canonical profile body",
    ]);
  }
  const classTypes = profile.node_classes.map((entry) => entry.class_type);
  assertUnique(classTypes, "ImagegenProfileV1.node_classes class types");
  const classMap = new Map(profile.node_classes.map((entry) => [entry.class_type, entry]));
  for (const [index, entry] of profile.node_classes.entries()) {
    assertOpaqueId(entry.class_type, `ImagegenProfileV1.node_classes[${index}].class_type`);
    assertUnique(
      entry.inputs.map((input) => input.input_name),
      `ImagegenProfileV1.node_classes[${index}] input names`
    );
  }
  for (const [nodeId, node] of Object.entries(profile.source_graph)) {
    const policy = classMap.get(node.class_type);
    if (policy === undefined) {
      throw new SkillSchemaValidationError("ImagegenProfileV1.source_graph", [
        `node '${nodeId}' class is not profile-allowlisted`,
      ]);
    }
    const policyInputs = new Map(policy.inputs.map((input) => [input.input_name, input]));
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      const inputPolicy = policyInputs.get(inputName);
      if (inputPolicy === undefined) {
        throw new SkillSchemaValidationError("ImagegenProfileV1.source_graph", [
          `node '${nodeId}' input '${inputName}' is not profile-allowlisted`,
        ]);
      }
      if (!jsonValueMatchesType(inputValue, inputPolicy.value_type)) {
        throw new SkillSchemaValidationError("ImagegenProfileV1.source_graph", [
          `node '${nodeId}' input '${inputName}' violates its declared type`,
        ]);
      }
      if (
        inputPolicy.semantic === "registered_asset" &&
        (typeof inputValue !== "string" ||
          !profile.required_inventory.model_ids.includes(inputValue))
      ) {
        throw new SkillSchemaValidationError("ImagegenProfileV1.source_graph", [
          `node '${nodeId}' asset input '${inputName}' is not bound to required inventory`,
        ]);
      }
    }
  }
  const capability = profile.revision_capability;
  const pngPorts = Object.entries(profile.source_graph).flatMap(([nodeId, node]) =>
    Object.entries(node.inputs)
      .filter(
        ([name]) =>
          classMap.get(node.class_type)?.inputs.find((p) => p.input_name === name)?.semantic ===
          "canonical_png_input"
      )
      .map(([name]) => `${nodeId}\u0000${name}`)
  );
  const inputClasses = profile.node_classes.filter((x) => x.execution_class === "registered_input");
  if (capability !== undefined) {
    if (
      profile.fallback !== null ||
      (capability.method === "img2img"
        ? capability.mask_port !== null || capability.backend_mask_polarity !== null
        : capability.mask_port === null || capability.backend_mask_polarity === null)
    )
      throw new Error("revision method/polarity/ports or fallback invalid");
    const ports = [
      capability.source_port,
      ...(capability.mask_port === null ? [] : [capability.mask_port]),
    ];
    const keys = ports.map((x) => `${x.node_id}\u0000${x.input_name}`);
    assertUnique(keys, "revision input ports");
    if (canonicalJson([...keys].sort()) !== canonicalJson([...pngPorts].sort()))
      throw new Error("revision requires exactly the approved canonical PNG ports");
    for (const address of ports) {
      const bound = profileAddressInput(profile, address, "revision input port");
      const node = profile.source_graph[address.node_id];
      if (
        bound.policy.semantic !== "canonical_png_input" ||
        bound.policy.value_type !== "string" ||
        bound.value !== "" ||
        node === undefined ||
        classMap.get(node.class_type)?.execution_class !== "registered_input"
      )
        throw new Error("revision port must be an empty host-bound registered input");
    }
    if (
      inputClasses.some(
        (x) => !ports.some((p) => profile.source_graph[p.node_id]?.class_type === x.class_type)
      )
    )
      throw new Error("unbound input class");
  } else if (pngPorts.length !== 0 || inputClasses.length !== 0)
    throw new Error("registered input requires revision capability");
  const expectedMutationTypes = {
    positive_prompt: "string",
    negative_prompt: "string",
    seed: "integer",
    width: "integer",
    height: "integer",
    batch_size: "integer",
    filename_prefix: "string",
  } as const;
  const addresses = Object.entries(profile.mutations).filter(
    (entry): entry is [keyof typeof expectedMutationTypes, ImagegenMutationAddressV1] =>
      entry[0] !== "output_node_id"
  );
  assertUnique(
    [
      ...addresses.map(([, address]) => `${address.node_id}\u0000${address.input_name}`),
      ...(capability === undefined
        ? []
        : [
            capability.source_port,
            ...(capability.mask_port === null ? [] : [capability.mask_port]),
          ].map((a) => `${a.node_id}\u0000${a.input_name}`)),
    ],
    "ImagegenProfileV1 mutation addresses"
  );
  for (const [name, address] of addresses) {
    const input = profileAddressInput(profile, address, `ImagegenProfileV1.mutations.${name}`);
    if (input.policy.semantic !== "data") {
      throw new SkillSchemaValidationError(`ImagegenProfileV1.mutations.${name}`, [
        "caller-controlled mutations cannot select registered assets",
      ]);
    }
    if (input.policy.value_type !== expectedMutationTypes[name]) {
      throw new SkillSchemaValidationError(`ImagegenProfileV1.mutations.${name}`, [
        `mutation requires a ${expectedMutationTypes[name]} input`,
      ]);
    }
  }
  const outputNode = profile.source_graph[profile.mutations.output_node_id];
  if (outputNode === undefined) {
    throw new SkillSchemaValidationError("ImagegenProfileV1.mutations.output_node_id", [
      "output node does not exist",
    ]);
  }
  const backendOutputClasses = profile.node_classes.filter(
    (entry) => entry.execution_class === "backend_output"
  );
  if (
    backendOutputClasses.length !== 1 ||
    backendOutputClasses[0]?.class_type !== outputNode.class_type
  ) {
    throw new SkillSchemaValidationError("ImagegenProfileV1.node_classes", [
      "exactly the declared output node class must use backend_output authority",
    ]);
  }
  for (const [nodeId, node] of Object.entries(profile.source_graph)) {
    if (
      nodeId !== profile.mutations.output_node_id &&
      classMap.get(node.class_type)?.execution_class === "backend_output"
    ) {
      throw new SkillSchemaValidationError("ImagegenProfileV1.source_graph", [
        `non-output node '${nodeId}' uses backend_output authority`,
      ]);
    }
  }
  if (profile.dimension_policy.policy === "allowlist") {
    const dimensionKeys = profile.dimension_policy.values.map(
      (dimensions) => `${dimensions.width}x${dimensions.height}`
    );
    assertUnique(dimensionKeys, "ImagegenProfileV1 dimension allowlist");
    for (const dimensions of profile.dimension_policy.values) {
      assertImageDimensions(dimensions, "ImagegenProfileV1 dimension allowlist");
    }
  } else if (
    profile.dimension_policy.min_width > profile.dimension_policy.max_width ||
    profile.dimension_policy.min_height > profile.dimension_policy.max_height
  ) {
    throw new SkillSchemaValidationError("ImagegenProfileV1.dimension_policy", [
      "minimum dimensions must not exceed maximum dimensions",
    ]);
  }
  assertImageDimensions(profile.default_dimensions, "ImagegenProfileV1.default_dimensions");
  if (!profilePermitsDimensions(profile, profile.default_dimensions)) {
    throw new SkillSchemaValidationError("ImagegenProfileV1.default_dimensions", [
      "default dimensions are outside the profile policy",
    ]);
  }
  const maximumPixels =
    profile.dimension_policy.policy === "allowlist"
      ? Math.max(
          ...profile.dimension_policy.values.map(
            (dimensions) => dimensions.width * dimensions.height
          )
        )
      : profile.dimension_policy.max_width * profile.dimension_policy.max_height;
  if (maximumPixels > profile.limits.max_pixels) {
    throw new SkillSchemaValidationError("ImagegenProfileV1.limits.max_pixels", [
      "dimension policy can exceed the profile pixel limit",
    ]);
  }
  if (profile.limits.candidate_inactivity_ms > profile.limits.workflow_inactivity_ms) {
    throw new SkillSchemaValidationError("ImagegenProfileV1.limits", [
      "candidate inactivity interval exceeds workflow inactivity interval",
    ]);
  }
  if (
    Buffer.byteLength(canonicalJson(profile.source_graph), "utf8") > profile.limits.max_graph_bytes
  ) {
    throw new SkillSchemaValidationError("ImagegenProfileV1.source_graph", [
      "canonical graph exceeds the profile graph byte limit",
    ]);
  }
  assertUnique(profile.required_inventory.class_types, "required inventory class types");
  assertUnique(profile.required_inventory.model_ids, "required inventory model IDs");
  if (profile.fallback !== null) {
    assertOpaqueId(profile.fallback.fallback_id, "ImagegenProfileV1.fallback.fallback_id");
    assertUnique(profile.fallback.when_model_ids_absent, "fallback absent model IDs");
    assertUnique(profile.fallback.required_model_ids, "fallback required model IDs");
    if (
      profile.fallback.when_model_ids_absent.some(
        (modelId) => !profile.required_inventory.model_ids.includes(modelId)
      )
    ) {
      throw new SkillSchemaValidationError("ImagegenProfileV1.fallback", [
        "fallback trigger is not part of the primary required inventory",
      ]);
    }
    const rewriteAddresses: string[] = [];
    for (const [index, rewrite] of profile.fallback.rewrites.entries()) {
      const input = profileAddressInput(
        profile,
        rewrite,
        `ImagegenProfileV1.fallback.rewrites[${index}]`
      );
      if (!jsonValueMatchesType(rewrite.value, input.policy.value_type)) {
        throw new SkillSchemaValidationError(`ImagegenProfileV1.fallback.rewrites[${index}]`, [
          "fallback rewrite violates the registered input type",
        ]);
      }
      if (
        input.policy.semantic === "registered_asset" &&
        (typeof rewrite.value !== "string" ||
          !profile.fallback.required_model_ids.includes(rewrite.value))
      ) {
        throw new SkillSchemaValidationError(`ImagegenProfileV1.fallback.rewrites[${index}]`, [
          "fallback asset rewrite is not bound to the fallback inventory",
        ]);
      }
      rewriteAddresses.push(`${rewrite.node_id}\u0000${rewrite.input_name}`);
    }
    assertUnique(rewriteAddresses, "fallback rewrite addresses");
  }
  return profile;
}

export const ImagegenProfileSnapshotV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.imagegen-profile-snapshot.v1"),
    schema_version: Type.Literal(1),
    profile: ImagegenProfileV1Schema,
    approved_profile_sha256: Sha256Schema,
    source_graph_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ImagegenProfileSnapshotV1 = Readonly<Static<typeof ImagegenProfileSnapshotV1Schema>>;

export function validateImagegenProfileSnapshot(value: unknown): ImagegenProfileSnapshotV1 {
  const snapshot = validateSkillSchema(
    ImagegenProfileSnapshotV1Schema,
    value,
    "ImagegenProfileSnapshotV1"
  );
  const profile = validateImagegenProfile(snapshot.profile);
  if (
    snapshot.approved_profile_sha256 !== profile.profile_sha256 ||
    snapshot.source_graph_sha256 !== profile.source_graph_sha256
  ) {
    throw new SkillSchemaValidationError("ImagegenProfileSnapshotV1", [
      "snapshot digests diverge from the exact profile",
    ]);
  }
  return snapshot;
}

export const ImageFrameV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-frame.v1"),
    schema_version: Type.Literal(1),
    brief: PromptTextSchema,
    hard_requirements: Type.Array(PromptTextSchema, { maxItems: 64, uniqueItems: true }),
    material_ambiguities: Type.Array(PromptTextSchema, { maxItems: 32, uniqueItems: true }),
  },
  { additionalProperties: false }
);
export type ImageFrameV1 = Readonly<Static<typeof ImageFrameV1Schema>>;

export const ImagePromptPlanV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-prompt-plan.v1"),
    schema_version: Type.Literal(1),
    positive_prompt: PromptTextSchema,
    negative_prompt: PromptTextSchema,
    raw_prompt_preserved: Type.Boolean(),
    strategy_delta: Type.Union([PromptTextSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ImagePromptPlanV1 = Readonly<Static<typeof ImagePromptPlanV1Schema>>;

export const ImageGenerationIntentV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-generation-intent.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    slot: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_CANDIDATES - 1 }),
    revision: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS }),
    base_seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    effective_seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    dimensions: ImageDimensionsV1Schema,
    profile_snapshot_ref: ArtifactRefSchema,
    prompt_plan_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type ImageGenerationIntentV1 = Readonly<Static<typeof ImageGenerationIntentV1Schema>>;

export const ImagegenFallbackDispositionV1Schema = Type.Union([
  Type.Object({ status: Type.Literal("not_applied") }, { additionalProperties: false }),
  Type.Object(
    { status: Type.Literal("applied"), fallback_id: OpaqueIdSchema },
    { additionalProperties: false }
  ),
]);
export type ImagegenFallbackDispositionV1 = Readonly<
  Static<typeof ImagegenFallbackDispositionV1Schema>
>;

export const ImageSubmittedGraphV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-submitted-graph.v1"),
    schema_version: Type.Literal(1),
    builder_schema_id: Type.Literal("penny.image-graph-builder.v1"),
    profile_snapshot_ref: ArtifactRefSchema,
    profile_sha256: Sha256Schema,
    source_graph_sha256: Sha256Schema,
    submitted_graph_sha256: Sha256Schema,
    slot: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_CANDIDATES - 1 }),
    revision: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS }),
    effective_seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    dimensions: ImageDimensionsV1Schema,
    fallback_disposition: ImagegenFallbackDispositionV1Schema,
    graph: ImagegenGraphV1Schema,
    reference: Type.Optional(ImageInputBindingV1Schema),
  },
  { additionalProperties: false }
);
export type ImageSubmittedGraphV1 = Readonly<Static<typeof ImageSubmittedGraphV1Schema>>;

export function validateImageSubmittedGraph(value: unknown): ImageSubmittedGraphV1 {
  const submitted = validateSkillSchema(
    ImageSubmittedGraphV1Schema,
    value,
    "ImageSubmittedGraphV1"
  );
  if (submitted.submitted_graph_sha256 !== sha256(canonicalJson(submitted.graph))) {
    throw new SkillSchemaValidationError("ImageSubmittedGraphV1.submitted_graph_sha256", [
      "digest does not match the canonical submitted graph",
    ]);
  }
  if (Buffer.byteLength(canonicalJson(submitted), "utf8") > IMAGEGEN_MAX_GRAPH_BYTES) {
    throw new SkillSchemaValidationError("ImageSubmittedGraphV1", [
      "submitted graph document exceeds its byte ceiling",
    ]);
  }
  return submitted;
}

export const ImageCandidateRevisionV1Schema = Type.Object(
  {
    slot: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_CANDIDATES - 1 }),
    revision: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS }),
    image_artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
    image_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ImageCandidateRevisionV1 = Readonly<Static<typeof ImageCandidateRevisionV1Schema>>;

export const ImageSlotStateV1Schema = Type.Union([
  Type.Literal("unattempted"),
  Type.Literal("prepared"),
  Type.Literal("submitting"),
  Type.Literal("submitted"),
  Type.Literal("reviewable"),
  Type.Literal("under_review"),
  Type.Literal("critic_failed"),
  Type.Literal("accepted"),
  Type.Literal("operational_failed"),
  Type.Literal("remote_failed"),
  Type.Literal("remote_unknown"),
  Type.Literal("downloaded_invalid"),
  Type.Literal("cancelled"),
  Type.Literal("skipped_after_prior_failure"),
]);
export type ImageSlotStateV1 = Static<typeof ImageSlotStateV1Schema>;

export const ImageSlotRecordV1Schema = Type.Object(
  {
    slot: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_CANDIDATES - 1 }),
    state: ImageSlotStateV1Schema,
    revision: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS }),
    effective_seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    submitted_graph_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    image_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    validation_receipt_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    operation_receipt_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    disposition_receipt_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    vera_report_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    carren_report_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    review_epoch: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    reason_code: Type.Union([OpaqueIdSchema, Type.Null()]),
    lease_disposition: Type.Union([
      Type.Literal("released"),
      Type.Literal("quarantined"),
      Type.Null(),
    ]),
    remote_may_continue: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type ImageSlotRecordV1 = Readonly<Static<typeof ImageSlotRecordV1Schema>>;

export const ImageSlotLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-slot-ledger.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    count: Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_CANDIDATES }),
    base_seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    review_epoch: Type.Integer({ minimum: 0 }),
    slots: Type.Array(ImageSlotRecordV1Schema, {
      minItems: 1,
      maxItems: IMAGEGEN_MAX_CANDIDATES,
    }),
  },
  { additionalProperties: false }
);
export type ImageSlotLedgerV1 = Readonly<Static<typeof ImageSlotLedgerV1Schema>>;

export const ImageGenerationOperationRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-generation-operation-request.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    reservation_id: OpaqueIdSchema,
    asset: Type.Optional(ImageAssetRequestV1Schema),
    reference: Type.Optional(ImageInputBindingV1Schema),
    max_renders: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    profile_snapshot_ref: ArtifactRefSchema,
    submitted_graph_ref: ArtifactRefSchema,
    submitted_graph_sha256: Sha256Schema,
    slot: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_CANDIDATES - 1 }),
    revision: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS }),
    effective_seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    dimensions: ImageDimensionsV1Schema,
  },
  { additionalProperties: false }
);
export type ImageGenerationOperationRequestV1 = Readonly<
  Static<typeof ImageGenerationOperationRequestV1Schema>
>;

export function validateImageGenerationOperationRequest(
  value: unknown
): ImageGenerationOperationRequestV1 {
  const request = validateSkillSchema(
    ImageGenerationOperationRequestV1Schema,
    value,
    "ImageGenerationOperationRequestV1"
  );
  if (
    request.submitted_graph_ref.content_digest !== request.submitted_graph_sha256 ||
    request.profile_snapshot_ref.content_schema?.schema_id !== "penny.imagegen-profile-snapshot.v1"
  ) {
    throw new SkillSchemaValidationError("ImageGenerationOperationRequestV1", [
      "request refs do not bind the declared graph/profile digests",
    ]);
  }
  return request;
}

export const ImageValidationReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-validation-receipt.v1"),
    schema_version: Type.Literal(1),
    slot: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_CANDIDATES - 1 }),
    revision: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS }),
    status: Type.Union([Type.Literal("valid"), Type.Literal("invalid")]),
    response_status: Type.Integer({ minimum: 100, maximum: 599 }),
    response_media_type: TextSchema({ minBytes: 1, maxBytes: 128, multiline: false }),
    raw_sha256: Sha256Schema,
    raw_byte_length: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_IMAGE_BYTES }),
    canonical_sha256: Type.Union([Sha256Schema, Type.Null()]),
    canonical_byte_length: Type.Union([
      Type.Integer({ minimum: 1, maximum: IMAGEGEN_MAX_IMAGE_BYTES }),
      Type.Null(),
    ]),
    dimensions: Type.Union([ImageDimensionsV1Schema, Type.Null()]),
    decoder: Type.Literal("penny.png-media.v1"),
    reason_code: Type.Union([OpaqueIdSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ImageValidationReceiptV1 = Readonly<Static<typeof ImageValidationReceiptV1Schema>>;

export function validateImageValidationReceipt(value: unknown): ImageValidationReceiptV1 {
  const receipt = validateSkillSchema(
    ImageValidationReceiptV1Schema,
    value,
    "ImageValidationReceiptV1"
  );
  const valid = receipt.status === "valid";
  if (
    valid !==
    (receipt.canonical_sha256 !== null &&
      receipt.canonical_byte_length !== null &&
      receipt.dimensions !== null &&
      receipt.reason_code === null)
  ) {
    throw new SkillSchemaValidationError("ImageValidationReceiptV1", [
      "valid status requires complete canonical image evidence and no reason",
    ]);
  }
  if (!valid && receipt.reason_code === null) {
    throw new SkillSchemaValidationError("ImageValidationReceiptV1", [
      "invalid status requires a reason code",
    ]);
  }
  return receipt;
}

export const ImageGenerationOperationReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-generation-operation-receipt.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    reservation_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    submitted_graph_ref: ArtifactRefSchema,
    slot: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_CANDIDATES - 1 }),
    revision: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS }),
    effective_seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    status: Type.Union([Type.Literal("persisted"), Type.Literal("downloaded_invalid")]),
    prompt_id_sha256: Sha256Schema,
    poll_count: Type.Integer({ minimum: 0, maximum: 10_000 }),
    validation: ImageValidationReceiptV1Schema,
    storage_commit_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type ImageGenerationOperationReceiptV1 = Readonly<
  Static<typeof ImageGenerationOperationReceiptV1Schema>
>;

export function validateImageGenerationOperationReceipt(
  value: unknown
): ImageGenerationOperationReceiptV1 {
  const receipt = validateSkillSchema(
    ImageGenerationOperationReceiptV1Schema,
    value,
    "ImageGenerationOperationReceiptV1"
  );
  const validation = validateImageValidationReceipt(receipt.validation);
  if (
    (receipt.status === "persisted") !== (validation.status === "valid") ||
    receipt.slot !== validation.slot ||
    receipt.revision !== validation.revision
  ) {
    throw new SkillSchemaValidationError("ImageGenerationOperationReceiptV1", [
      "operation status or candidate identity diverges from validation",
    ]);
  }
  return receipt;
}

const ImageReviewFindingV1Schema = Type.Object(
  {
    finding_id: OpaqueIdSchema,
    slot: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_CANDIDATES - 1 }),
    revision: Type.Integer({ minimum: 0, maximum: IMAGEGEN_MAX_REVISION_ROUNDS }),
    code: OpaqueIdSchema,
    detail: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    blocking: Type.Boolean(),
  },
  { additionalProperties: false }
);

const ImageReviewedCandidateV1Schema = Type.Object(
  {
    candidate: ImageCandidateRevisionV1Schema,
    approved: Type.Boolean(),
    finding_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_REVIEW_FINDINGS, uniqueItems: true }),
  },
  { additionalProperties: false }
);

export const ImageValidityReportV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-validity-report.v1"),
    schema_version: Type.Literal(1),
    revision_review: Type.Optional(ImageRevisionReviewV1Schema),
    review_epoch: Type.Integer({ minimum: 1 }),
    candidates: Type.Array(ImageReviewedCandidateV1Schema, {
      minItems: 1,
      maxItems: IMAGEGEN_MAX_CANDIDATES,
    }),
    findings: Type.Array(ImageReviewFindingV1Schema, { maxItems: MAX_REVIEW_FINDINGS }),
  },
  { additionalProperties: false }
);
export type ImageValidityReportV1 = Readonly<Static<typeof ImageValidityReportV1Schema>>;

export const ImageQualityReportV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-quality-report.v1"),
    schema_version: Type.Literal(1),
    revision_review: Type.Optional(ImageRevisionReviewV1Schema),
    review_epoch: Type.Integer({ minimum: 1 }),
    candidates: Type.Array(ImageReviewedCandidateV1Schema, {
      minItems: 1,
      maxItems: IMAGEGEN_MAX_CANDIDATES,
    }),
    findings: Type.Array(ImageReviewFindingV1Schema, { maxItems: MAX_REVIEW_FINDINGS }),
    ranking: Type.Array(ImageCandidateRevisionV1Schema, {
      minItems: 1,
      maxItems: IMAGEGEN_MAX_CANDIDATES,
    }),
  },
  { additionalProperties: false }
);
export type ImageQualityReportV1 = Readonly<Static<typeof ImageQualityReportV1Schema>>;

export const ImageSelectionReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-selection-receipt.v1"),
    schema_version: Type.Literal(1),
    review_epoch: Type.Integer({ minimum: 1 }),
    eligible: Type.Array(ImageCandidateRevisionV1Schema, {
      minItems: 1,
      maxItems: IMAGEGEN_MAX_CANDIDATES,
    }),
    selected: ImageCandidateRevisionV1Schema,
    ranking_source_ref: ArtifactRefSchema,
    validity_source_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type ImageSelectionReceiptV1 = Readonly<Static<typeof ImageSelectionReceiptV1Schema>>;

export const ImagegenStorageReservationReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-storage-reservation-receipt.v1"),
    schema_version: Type.Literal(1),
    reservation_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    admission_sha256: Sha256Schema,
    reserved_bytes: PositiveIntegerSchema,
    base_seed: Type.Integer({ minimum: 0, maximum: UINT32_MAX }),
    partition_ceiling_bytes: PositiveIntegerSchema,
    warning_threshold_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    guaranteed_remaining_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    state: Type.Literal("active"),
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ImagegenStorageReservationReceiptV1 = Readonly<
  Static<typeof ImagegenStorageReservationReceiptV1Schema>
>;

export const ImagegenStorageCommitReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-storage-commit-receipt.v1"),
    schema_version: Type.Literal(1),
    commit_id: OpaqueIdSchema,
    reservation_id: OpaqueIdSchema,
    commit_key: OpaqueIdSchema,
    committed_delta_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    committed_total_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    reserved_bytes: PositiveIntegerSchema,
    committed_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ImagegenStorageCommitReceiptV1 = Readonly<
  Static<typeof ImagegenStorageCommitReceiptV1Schema>
>;

export const ImagegenStorageReleaseReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-storage-release-receipt.v1"),
    schema_version: Type.Literal(1),
    release_id: OpaqueIdSchema,
    reservation_id: OpaqueIdSchema,
    committed_bytes_retained: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    unused_bytes_released: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    released_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ImagegenStorageReleaseReceiptV1 = Readonly<
  Static<typeof ImagegenStorageReleaseReceiptV1Schema>
>;

export const ImagegenReadinessRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.imagegen-readiness-request.v1"),
    schema_version: Type.Literal(1),
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    profile_snapshot_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type ImagegenReadinessRequestV1 = Readonly<Static<typeof ImagegenReadinessRequestV1Schema>>;

export const ImagegenReadinessReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.imagegen-readiness-receipt.v1"),
    schema_version: Type.Literal(1),
    status: Type.Literal("ready"),
    profile_id: OpaqueIdSchema,
    profile_sha256: Sha256Schema,
    profile_snapshot_ref: ArtifactRefSchema,
    inventory_sha256: Sha256Schema,
    fallback_disposition: ImagegenFallbackDispositionV1Schema,
  },
  { additionalProperties: false }
);
export type ImagegenReadinessReceiptV1 = Readonly<Static<typeof ImagegenReadinessReceiptV1Schema>>;

export const ImagegenExportOperationRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.imagegen-export-operation-request.v1"),
    schema_version: Type.Literal(1),
    run_id: OpaqueIdSchema,
    export: ImagegenExportRequestV1Schema,
    selected_filename: Type.String({ minLength: 1, maxLength: 255 }),
    files: Type.Array(
      Type.Object(
        {
          filename: Type.String({ minLength: 1, maxLength: 255 }),
          source_ref: ArtifactRefSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 2, maxItems: IMAGEGEN_MAX_CANDIDATES + 2 }
    ),
  },
  { additionalProperties: false }
);
export type ImagegenExportOperationRequestV1 = Readonly<
  Static<typeof ImagegenExportOperationRequestV1Schema>
>;

export function validateImagegenReadinessRequest(value: unknown): ImagegenReadinessRequestV1 {
  return validateSkillSchema(ImagegenReadinessRequestV1Schema, value, "ImagegenReadinessRequestV1");
}

export function validateImagegenReadinessReceipt(value: unknown): ImagegenReadinessReceiptV1 {
  return validateSkillSchema(ImagegenReadinessReceiptV1Schema, value, "ImagegenReadinessReceiptV1");
}

export function validateImagegenExportOperationRequest(
  value: unknown
): ImagegenExportOperationRequestV1 {
  return validateSkillSchema(
    ImagegenExportOperationRequestV1Schema,
    value,
    "ImagegenExportOperationRequestV1"
  );
}

export const ImagegenExportReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-export-receipt.v1"),
    schema_version: Type.Literal(1),
    destination_id: OpaqueIdSchema,
    directory_name: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: SAFE_DIRECTORY_NAME_PATTERN,
    }),
    files: Type.Array(
      Type.Object(
        {
          filename: Type.String({
            minLength: 1,
            maxLength: 128,
            pattern: SAFE_DIRECTORY_NAME_PATTERN,
          }),
          source_artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
          byte_length: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          sha256: Sha256Schema,
        },
        { additionalProperties: false }
      ),
      { minItems: 2, maxItems: 32 }
    ),
    selected_filename: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: SAFE_DIRECTORY_NAME_PATTERN,
    }),
    completed_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ImagegenExportReceiptV1 = Readonly<Static<typeof ImagegenExportReceiptV1Schema>>;

export const ImagegenManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.imagegen-manifest.v1"),
    schema_version: Type.Literal(1),
    request_ref: ArtifactRefSchema,
    profile_snapshot_ref: ArtifactRefSchema,
    ledger_ref: ArtifactRefSchema,
    review_epoch: Type.Integer({ minimum: 1 }),
    selected_image_ref: ArtifactRefSchema,
    selection_receipt_ref: ArtifactRefSchema,
    storage_reservation_ref: ArtifactRefSchema,
    export_receipt_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    lineage_refs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: MAX_MANIFEST_LINEAGE,
    }),
  },
  { additionalProperties: false }
);
export type ImagegenManifestV1 = Readonly<Static<typeof ImagegenManifestV1Schema>>;

export const ImageProductEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.image-product-envelope.v1"),
    schema_version: Type.Literal(1),
    manifest_ref: ArtifactRefSchema,
    selected_image_ref: ArtifactRefSchema,
    selection_receipt_ref: ArtifactRefSchema,
    ledger_ref: ArtifactRefSchema,
    unresolved_count: Type.Literal(0),
  },
  { additionalProperties: false }
);
export type ImageProductEnvelopeV1 = Readonly<Static<typeof ImageProductEnvelopeV1Schema>>;

function assertSafeDirectoryName(value: string, label: string): void {
  if (
    value === "." ||
    value === ".." ||
    !new RegExp(SAFE_DIRECTORY_NAME_PATTERN, "u").test(value) ||
    value.includes("..")
  ) {
    throw new SkillSchemaValidationError(label, ["directory name is not a bounded safe leaf name"]);
  }
}

export function validateImagegenReviewSet(input: {
  readonly expected: readonly ImageCandidateRevisionV1[];
  readonly validity: unknown;
  readonly quality: unknown;
}): { readonly validity: ImageValidityReportV1; readonly quality: ImageQualityReportV1 } {
  const validity = validateSkillSchema(
    ImageValidityReportV1Schema,
    input.validity,
    "ImageValidityReportV1"
  );
  const quality = validateSkillSchema(
    ImageQualityReportV1Schema,
    input.quality,
    "ImageQualityReportV1"
  );
  const expected = [...input.expected].sort((left, right) => left.slot - right.slot);
  const identity = (candidate: ImageCandidateRevisionV1): string =>
    canonicalJson({
      slot: candidate.slot,
      revision: candidate.revision,
      image_artifact_id: candidate.image_artifact_id,
      image_sha256: candidate.image_sha256,
    });
  const expectedIdentities = expected.map(identity);
  assertUnique(expectedIdentities, "image review expected candidates");
  for (const [label, candidates] of [
    ["Vera", validity.candidates.map((entry) => entry.candidate)],
    ["Carren", quality.candidates.map((entry) => entry.candidate)],
    ["Carren ranking", quality.ranking],
  ] as const) {
    const actual = [...candidates].sort((left, right) => left.slot - right.slot).map(identity);
    if (canonicalJson(actual) !== canonicalJson(expectedIdentities)) {
      throw new SkillSchemaValidationError(`${label} image review`, [
        "candidate set does not exactly cover the active review epoch",
      ]);
    }
  }
  if (validity.review_epoch !== quality.review_epoch) {
    throw new SkillSchemaValidationError("image review epoch", [
      "Vera and Carren reports name different epochs",
    ]);
  }
  for (const [label, report] of [
    ["Vera", validity],
    ["Carren", quality],
  ] as const) {
    const findingIds = report.findings.map((finding) => finding.finding_id);
    assertUnique(findingIds, `${label} finding IDs`);
    const known = new Set(findingIds);
    for (const candidate of report.candidates) {
      if (candidate.finding_ids.some((findingId) => !known.has(findingId))) {
        throw new SkillSchemaValidationError(`${label} candidate findings`, [
          "candidate cites an unknown finding",
        ]);
      }
      const blocking = candidate.finding_ids.some((findingId) =>
        report.findings.some((finding) => finding.finding_id === findingId && finding.blocking)
      );
      if (candidate.approved === blocking) {
        throw new SkillSchemaValidationError(`${label} candidate approval`, [
          "approval must be the inverse of current blocking findings",
        ]);
      }
    }
  }
  return { validity, quality };
}

export function validateImageSelectionReceipt(value: unknown): ImageSelectionReceiptV1 {
  const receipt = validateSkillSchema(
    ImageSelectionReceiptV1Schema,
    value,
    "ImageSelectionReceiptV1"
  );
  const selected = canonicalJson(receipt.selected);
  if (!receipt.eligible.some((candidate) => canonicalJson(candidate) === selected)) {
    throw new SkillSchemaValidationError("ImageSelectionReceiptV1", [
      "selected candidate is not in the eligible set",
    ]);
  }
  assertUnique(
    receipt.eligible.map((candidate) => `${candidate.slot}:${candidate.revision}`),
    "ImageSelectionReceiptV1 eligible candidates"
  );
  return receipt;
}

export function assertImagegenTimestamp(value: string, label: string): void {
  assertRfc3339Utc(value, label);
}

export function imagegenArtifactRefSet(refs: readonly ArtifactRef[]): readonly ArtifactRef[] {
  const ids = refs.map((ref) => ref.artifact_id);
  assertUnique(ids, "imagegen artifact refs");
  return [...refs].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

export function validateImagegenSchemaId(value: string): string {
  return validateSkillSchema(SchemaIdSchema, value, "imagegen schema ID");
}
