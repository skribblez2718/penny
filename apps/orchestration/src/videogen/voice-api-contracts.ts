import { Type, type Static } from "typebox";
import { ArtifactRefSchema as Ref, JsonValueSchema } from "../contracts.js";
import { OpaqueIdSchema as Id, Sha256Schema as Hash } from "../skill-contracts/common.js";
import {
  VoiceStudioJobV1Schema,
  VoiceStudioNarrationV1Schema,
  VoiceStudioVoiceV1Schema,
  VoiceStudioRawResultV1Schema,
  VoiceStudioProfileV1Schema,
} from "./voice-studio-contracts.js";
import { mediaArtifactContract } from "./media-contracts.js";
const closed = { additionalProperties: false } as const;
/** Logical API capacity worker/resources, not native process or physical-device certificates.
 * service_build_ref cites the actual inspected schema/build input; model resolution is unknown. */
export const VoiceApiProfileSchema = Type.Object(
  {
    ...Type.Omit(VoiceStudioProfileV1Schema, ["schema_id", "model_sha256"]).properties,
    schema_id: Type.Literal("penny.videogen-voice-api-profile.v1"),
    model_sha256: Type.Null(),
  },
  closed
);
export type VoiceApiProfile = Static<typeof VoiceApiProfileSchema>;
export const VOICE_API_ADAPTER_ID = "videogen.voice-trusted-local-api.v1";
export const VOICE_API_RAW_RESULT = mediaArtifactContract(
  "voice_api_result",
  "voice-api-raw-result"
);
export const VoiceApiCorrelationSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-voice-api-correlation.v1"),
    schema_version: Type.Literal(1),
    assurance: Type.Literal("trusted_local_api"),
    request_sha256: Hash,
    profile_sha256: Hash,
    backend_binding_id: Id,
    job_id: Id,
    narration_item_id: Id,
  },
  closed
);
export type VoiceApiCorrelation = Static<typeof VoiceApiCorrelationSchema>;
/** API-custodied request/readback facts, not independently resolved execution/chunk evidence. */
export const VoiceApiCoverageSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-voice-api-coverage.v1"),
    schema_version: Type.Literal(1),
    assurance: Type.Literal("trusted_local_api"),
    correlation: VoiceApiCorrelationSchema,
    script_ref: Ref,
    chunk_plan_ref: Ref,
    selected_saved_voice: VoiceStudioVoiceV1Schema,
    request_text: Type.String({ minLength: 1, maxLength: 500000 }),
    expected_chunk_ids: Type.Array(Id, { minItems: 1, maxItems: 1000 }),
    narration: VoiceStudioNarrationV1Schema,
    job: VoiceStudioJobV1Schema,
    resolved_runtime_voice: Type.Literal("unknown"),
    per_chunk_execution: Type.Literal("unknown"),
    fallback_used: Type.Literal("unknown"),
    external_work_exclusion: Type.Literal("unknown"),
    raw_responses: Type.Array(
      Type.Object(
        {
          method: Type.Union([Type.Literal("GET"), Type.Literal("POST")]),
          route: Type.String({ minLength: 1, maxLength: 256 }),
          body: JsonValueSchema,
        },
        closed
      ),
      { minItems: 1, maxItems: 10000 }
    ),
  },
  closed
);
export const VoiceApiRawResultSchema = Type.Object(
  {
    ...Type.Omit(VoiceStudioRawResultV1Schema, ["schema_id", "correlation"]).properties,
    schema_id: Type.Literal("penny.videogen-voice-api-raw-result.v1"),
    correlation: VoiceApiCorrelationSchema,
    coverage: VoiceApiCoverageSchema,
  },
  closed
);
export type VoiceApiRawResult = Static<typeof VoiceApiRawResultSchema>;
