import { Type, type Static } from "typebox";
import { ManagedWorkerPinSchema } from "../host-operations/native-capacity-contracts.js";
import { Sha256Schema } from "../skill-contracts/common.js";
const file = Type.String({ minLength: 1, maxLength: 4096 });
const executable = Type.Object(
  { path: file, sha256: Sha256Schema },
  { additionalProperties: false }
);
/** Installation data only. No modules, callbacks, graph or endpoint authority. */
export const ComfyManagedBindingSchema = Type.Object(
  {
    worker: ManagedWorkerPinSchema,
    backend_uid: Type.Integer({ minimum: 0, maximum: 4294967295 }),
    socket_path: file,
    python: executable,
    helper: Type.Object(
      { path: file, sha256: Sha256Schema, package_sha256: Sha256Schema },
      { additionalProperties: false }
    ),
    transfer_counter_file: file,
  },
  { additionalProperties: false }
);
export type ComfyManagedBinding = Static<typeof ComfyManagedBindingSchema>;
