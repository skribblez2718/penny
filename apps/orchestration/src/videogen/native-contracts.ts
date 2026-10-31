import { NativePhaseHeaderSchema } from "./native-phase-protocol.js";
import { NativeMediaComparisonV1Schema } from "./native-media-comparison.js";
import { Type, type Static } from "typebox";
import { ArtifactRefSchema, type HostOperationArtifactContractV1 } from "../contracts.js";
import { OpaqueIdSchema as Id, Sha256Schema } from "../skill-contracts/common.js";
const closed = { additionalProperties: false } as const;
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const NativeBuildRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-build-request.v1"),
    schema_version: Type.Literal(1),
    edit_ref: ArtifactRefSchema,
    accepted_master_ref: Type.Optional(ArtifactRefSchema),
    assets: Type.Array(
      Type.Object(
        {
          source_ref: ArtifactRefSchema,
          role: Id,
          relative_path: Type.String({ minLength: 1, maxLength: 512 }),
        },
        closed
      ),
      { minItems: 1, maxItems: 1024 }
    ),
    fixture_digest: Sha256Schema,
    editor_build_digest: Sha256Schema,
    mlt_build_digest: Sha256Schema,
    feature_subset_digest: Sha256Schema,
    output_root_selector: Id,
    limits: Type.Object(
      {
        max_xml_bytes: positive,
        max_assets: positive,
        max_duration_frames: positive,
        max_normalize_ms: positive,
      },
      closed
    ),
  },
  closed
);
/** A policy/build template is not an authored edit, resource closure or accepted master. */
export const NativeBuildTemplateV1Schema = Type.Object(
  {
    ...Type.Omit(NativeBuildRequestV1Schema, ["edit_ref", "accepted_master_ref", "assets"])
      .properties,
    schema_id: Type.Literal("penny.videogen-native-build-template.v1"),
  },
  closed
);
export type NativeBuildRequestV1 = Static<typeof NativeBuildRequestV1Schema>;
export const NativeOperationRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-operation-request.v1"),
    schema_version: Type.Literal(1),
    operation_id: Id,
    native_build_request_ref: ArtifactRefSchema,
  },
  closed
);
export const NATIVE_REQUEST_CONTRACT = {
  artifact_kind: "videogen-native-operation-request",
  schema_id: "penny.videogen-native-operation-request.v1",
  schema_version: 1,
  port_name: "videogen-native-operation-request",
  schema_version_required: 1,
} satisfies HostOperationArtifactContractV1;
export const NATIVE_RESULT_CONTRACT = {
  artifact_kind: "videogen-native-raw-result",
  schema_id: "penny.videogen-native-raw-result.v1",
  schema_version: 1,
  port_name: "videogen-native-raw-result",
  schema_version_required: 1,
} satisfies HostOperationArtifactContractV1;
export const NATIVE_PROJECT_CONTRACT = {
  artifact_kind: "videogen-native-project",
  schema_id: "penny.videogen-native-project-bytes.v1",
  schema_version: 1,
  port_name: "videogen-native-project",
  schema_version_required: 1,
} satisfies HostOperationArtifactContractV1;
export const NATIVE_RENDER_CONTRACT = {
  artifact_kind: "videogen-native-render",
  schema_id: "penny.videogen-native-render-bytes.v1",
  schema_version: 1,
  port_name: "videogen-native-render",
  schema_version_required: 1,
} satisfies HostOperationArtifactContractV1;

const NativeUnqualifiedRawResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-native-raw-result.v1"),
    schema_version: Type.Literal(1),
    operation_id: Id,
    request_sha256: Sha256Schema,
    registry_digest: Sha256Schema,
    outputs: Type.Array(
      Type.Object(
        {
          verb: Type.Union([
            Type.Literal("open_save_normalize"),
            Type.Literal("close_reopen_readback"),
            Type.Literal("relocate_reopen_readback"),
            Type.Literal("render_compare"),
          ]),
          sha256: Sha256Schema,
          bytes: positive,
        },
        closed
      ),
      { minItems: 4, maxItems: 4 }
    ),
    status: Type.Literal("constructed_unqualified"),
    unverified: Type.Array(
      Type.Union([
        Type.Literal("actual_editor_automation_qualification"),
        Type.Literal("full_decode_native_render_comparison"),
        Type.Literal("relocated_font_fidelity"),
        Type.Literal("manual_trim_gain_caption_edit"),
      ]),
      { minItems: 4, maxItems: 4, uniqueItems: true }
    ),
  },
  closed
);

const {
  status: _status,
  unverified: _unverified,
  ...rawFields
} = NativeUnqualifiedRawResultV1Schema.properties;
export const NativeQualifiedRawResultV1Schema = Type.Object(
  {
    ...rawFields,
    status: Type.Literal("qualified"),
    accepted_master_ref: ArtifactRefSchema,
    phases: Type.Array(NativePhaseHeaderSchema, { minItems: 4, maxItems: 4 }),
    comparison: NativeMediaComparisonV1Schema,
  },
  closed
);
export const NativeObservedRawResultV1Schema = Type.Object(
  {
    ...rawFields,
    status: Type.Literal("observed"),
    phases: Type.Array(NativePhaseHeaderSchema, { minItems: 4, maxItems: 4 }),
    unverified: Type.Array(Type.Literal("full_decode_native_render_comparison"), {
      minItems: 1,
      maxItems: 1,
    }),
  },
  closed
);
export const NativeRawResultV1Schema = Type.Union([
  NativeUnqualifiedRawResultV1Schema,
  NativeObservedRawResultV1Schema,
  NativeQualifiedRawResultV1Schema,
]);
export type NativeQualifiedRawResultV1 = Static<typeof NativeQualifiedRawResultV1Schema>;
