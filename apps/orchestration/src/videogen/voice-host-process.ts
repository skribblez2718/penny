import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateSkillSchema, Sha256Schema, OpaqueIdSchema } from "../skill-contracts/common.js";
import { nativeFileSha256 as voiceHostFileSha256 } from "../host-operations/native-process.js";
export { nativeFileSha256 as voiceHostFileSha256 } from "../host-operations/native-process.js";
export {
  observeNativeHostProcess as observeVoiceHostProcess,
  observeNativeHostGpus as observeVoiceHostGpus,
  readNativeObservationFile as readVoiceHostObservationFile,
} from "../host-operations/native-host-observation.js";
export type { NativeProcessPin as VoiceHostProcessPin } from "../host-operations/native-process.js";
export type { NativeGpuProbe as VoiceHostGpuProbe } from "../host-operations/native-host-observation.js";
const closed = { additionalProperties: false } as const;
export const VoiceHostFilePinSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    sha256: Sha256Schema,
  },
  closed
);
export type VoiceHostFilePin = Static<typeof VoiceHostFilePinSchema>;
/** No recursive discovery, environment/command-line reads, model import, or guessed paths. */
export function verifyVoiceHostFiles(pins: readonly VoiceHostFilePin[]): string {
  if (!pins.length || pins.length > 32768 || new Set(pins.map((p) => p.path)).size !== pins.length)
    throw new Error("voice host file manifest invalid");
  for (const pin of pins) {
    validateSkillSchema(VoiceHostFilePinSchema, pin, "voice host file pin");
    if (voiceHostFileSha256(pin.path) !== pin.sha256) throw new Error("voice host file pin drift");
  }
  // Paths remain private; digest identity includes caller-selected ordering and exact paths.
  return sha256(canonicalJson(pins));
}
export const VoiceHostServiceObservationSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    process_epoch: Sha256Schema,
    service_build_sha256: Sha256Schema,
    model_sha256: Sha256Schema,
    engine: OpaqueIdSchema,
    observed_at_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    models_loaded: Type.Boolean(),
    model_identity_verified: Type.Boolean(),
    gpu_uuids: Type.Array(OpaqueIdSchema, { minItems: 1, maxItems: 16, uniqueItems: true }),
    // Only instrumentation covering ALL synthesis/preview/clone entry points may emit host_exclusive.
    admission: Type.Object(
      {
        mode: Type.Union([Type.Literal("uncontrolled"), Type.Literal("host_exclusive")]),
        backend_binding_id: OpaqueIdSchema,
        active_job_ids: Type.Array(OpaqueIdSchema, { maxItems: 1000, uniqueItems: true }),
        active_unmanaged_calls: Type.Union([
          Type.Integer({ minimum: 0, maximum: 1000 }),
          Type.Null(),
        ]),
      },
      closed
    ),
    jobs: Type.Array(
      Type.Object(
        {
          job_id: OpaqueIdSchema,
          narration_item_id: OpaqueIdSchema,
          status: OpaqueIdSchema,
          narration_sha256: Sha256Schema,
          chunks: Type.Array(
            Type.Object(
              {
                ordinal: Type.Integer({ minimum: 0, maximum: 999 }),
                segment_id: OpaqueIdSchema,
                text_sha256: Sha256Schema,
                voice_id: Type.Union([OpaqueIdSchema, Type.Null()]),
                resolved_voice_sha256: Type.Union([Sha256Schema, Type.Null()]),
                fallback_used: Type.Boolean(),
                status: OpaqueIdSchema,
                error_present: Type.Boolean(),
              },
              closed
            ),
            { maxItems: 1000 }
          ),
        },
        closed
      ),
      { maxItems: 1000 }
    ),
  },
  closed
);
export type VoiceHostServiceObservation = Static<typeof VoiceHostServiceObservationSchema>;
