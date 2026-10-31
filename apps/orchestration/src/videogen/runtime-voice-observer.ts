import type { NativeManagedWorkerRegistry } from "../host-operations/native-capacity.js";
import { Type, type Static } from "typebox";
import { ArtifactRefSchema, validateContract } from "../contracts.js";
import { VoiceStudioProfileV1Schema } from "./voice-studio-contracts.js";
import { VoiceHostFilePinSchema } from "./voice-host-process.js";
import {
  VoiceStudioProcessObserver,
  VoiceStudioServiceObservationFile,
} from "./voice-studio-process-observer.js";

const closed = { additionalProperties: false } as const;
const filename = Type.String({ minLength: 1, maxLength: 4096 });
/** Host-private JSON only. No executable modules, callbacks, commands or readiness verdicts. */
export const VoiceStudioHostProcessBindingSchema = Type.Object(
  {
    process: Type.Object(
      {
        pid: Type.Integer({ minimum: 1, maximum: 2147483647 }),
        boot_id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
        start_ticks: Type.String({ pattern: "^[0-9]+$", maxLength: 32 }),
        executable: VoiceHostFilePinSchema,
        cwd: filename,
      },
      closed
    ),
    source_files: Type.Array(VoiceHostFilePinSchema, { minItems: 1, maxItems: 4096 }),
    runtime_files: Type.Array(VoiceHostFilePinSchema, { minItems: 1, maxItems: 32768 }),
    model_files: Type.Array(VoiceHostFilePinSchema, { minItems: 1, maxItems: 4096 }),
    gpu: Type.Object(
      {
        executable: VoiceHostFilePinSchema,
        timeout_ms: Type.Integer({ minimum: 1, maximum: 30000 }),
        max_output_bytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
      },
      closed
    ),
    gpu_uuids: Type.Array(Type.String({ pattern: "^GPU-[a-f0-9-]+$", maxLength: 128 }), {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    max_snapshot_age_ms: Type.Integer({ minimum: 1, maximum: 300000 }),
    service_observations: Type.Optional(
      Type.Object(
        {
          path: filename,
          max_bytes: Type.Integer({ minimum: 1, maximum: 16777216 }),
        },
        closed
      )
    ),
  },
  closed
);
export type VoiceStudioHostProcessBinding = Static<typeof VoiceStudioHostProcessBindingSchema>;
export const VoiceStudioHostObservationSourceSchema = Type.Union([
  Type.Object({ process_observer: VoiceStudioHostProcessBindingSchema }, closed),
  Type.Object({ process_snapshot_path: filename }, closed),
]);
export type VoiceStudioHostObservationSource = Static<
  typeof VoiceStudioHostObservationSourceSchema
>;

/** Builds the compiled native observer; a missing private instrumentation file remains not-ready.
 * Profile and isolation come from the separately validated transport/profile, not another JSON flag.
 * Construction verifies file pins, but neither probes GPUs nor starts service/model work. */
export function createVoiceStudioHostProcessObserver(input: {
  readonly binding: VoiceStudioHostProcessBinding;
  readonly profile_ref: Static<typeof ArtifactRefSchema>;
  readonly profile: Static<typeof VoiceStudioProfileV1Schema>;
  readonly isolation: "trusted_tls" | "isolated_loopback";
  readonly managed_workers?: NativeManagedWorkerRegistry;
}): VoiceStudioProcessObserver {
  const b = structuredClone(
    validateContract(
      VoiceStudioHostProcessBindingSchema,
      input.binding,
      "voice host process binding"
    )
  );
  const { service_observations, ...native } = b;
  return new VoiceStudioProcessObserver({
    ...native,
    profile_ref: input.profile_ref,
    profile: input.profile,
    isolation: input.isolation,
    ...(input.managed_workers ? { managed_workers: input.managed_workers } : {}),
    ...(service_observations === undefined
      ? {}
      : {
          service_observations: new VoiceStudioServiceObservationFile(
            service_observations.path,
            service_observations.max_bytes
          ),
        }),
  });
}
