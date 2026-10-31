import { Type } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract, JsonValueSchema } from "../contracts.js";
import { OpaqueIdSchema } from "../skill-contracts/common.js";
import { hostCapacityWorkerKey } from "../host-operations/capacity-contracts.js";
import { inspectVoiceStudioSavedVoice } from "./voice-studio-discovery.js";
import { VoiceStudioTransport } from "./voice-studio-transport.js";
import {
  VoiceStudioTransportV1Schema,
  VoiceStudioLimitsV1Schema,
} from "./voice-studio-contracts.js";
import { MediaDecodePolicyV1Schema } from "./media-contracts.js";
import { VideogenOperationPolicySchema } from "./runtime-adapters.js";
const closed = { additionalProperties: false } as const;
/** GET-only binding generation. Logical worker/resource IDs and limits are operator allocations,
 * not inferred hardware, native process, residency or resolved-model assertions. */
export const VoiceApiBindingRequestSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-voice-api-binding-request.v1"),
    schema_version: Type.Literal(1),
    profile_id: OpaqueIdSchema,
    worker_id: OpaqueIdSchema,
    gpu_resource_ids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 16, uniqueItems: true }),
    voice_id: Type.String({ pattern: "^[a-f0-9]{12}$" }),
    transport: VoiceStudioTransportV1Schema,
    limits: VoiceStudioLimitsV1Schema,
    media_policy: MediaDecodePolicyV1Schema,
    operation_policy: VideogenOperationPolicySchema,
  },
  closed
);
export async function buildVoiceApiBinding(value: unknown, signal: AbortSignal) {
  const r = validateContract(VoiceApiBindingRequestSchema, value, "Voice API binding request");
  if (r.operation_policy.backend_key_sha256 !== hostCapacityWorkerKey(r.worker_id))
    throw new Error("API worker/backend key mismatch");
  const client = new VoiceStudioTransport(r.transport, r.limits);
  const schema = validateContract(
    JsonValueSchema,
    await client.json("GET", "/openapi.json", signal),
    "actual Voice API schema"
  );
  const observed = await inspectVoiceStudioSavedVoice(r.transport, r.limits, r.voice_id, signal);
  const profile = {
    schema_id: "penny.videogen-voice-api-profile.v1",
    schema_version: 1,
    profile_id: r.profile_id,
    backend_binding_id: r.operation_policy.backend_binding_id,
    process_worker_id: r.worker_id,
    gpu_resource_ids: r.gpu_resource_ids,
    service_build_ref: { $artifact: "voice-api-schema" },
    model_sha256: null,
    voice_id: observed.voice.id,
    voice_sha256: observed.voice_sha256,
    sample_sha256: observed.sample_sha256,
    engine: observed.health.engine,
    media_policy_ref: { $artifact: "voice-media-policy" },
    limits: r.limits,
  };
  const artifact = (id: string, schema_id: string, json: unknown) => ({
    id,
    kind: id,
    media_type: "application/json",
    schema_id,
    source: { json: validateContract(JsonValueSchema, json, "binding input") },
  });
  return {
    assurance: "trusted_local_api",
    resolved_runtime_voice: "unknown",
    resolved_model: "unknown",
    physical_exclusivity: "unknown",
    schema_sha256: sha256(canonicalJson(schema)),
    artifacts: [
      artifact("voice-api-schema", "penny.videogen-voice-api-schema.v1", schema),
      artifact("voice-media-policy", r.media_policy.schema_id, r.media_policy),
      artifact("selected-saved-voice", "penny.videogen-voice-studio-voice.v1", observed.voice),
      artifact("voice-api-profile", profile.schema_id, profile),
    ],
    adapter: {
      kind: "voice_job",
      policy: r.operation_policy,
      binding: {
        assurance: "trusted_local_api",
        profile_ref: { $artifact: "voice-api-profile" },
        profile,
        transport: r.transport,
      },
    },
    inspection: observed,
  };
}
