import { Type, type Static } from "typebox";
import type { ComfyEndpointV1 } from "./client.js";
import { OpaqueIdSchema, assertUnique, validateSkillSchema } from "../skill-contracts/common.js";
import { capacityJson, hostCapacityWorkerKey } from "../host-operations/capacity-contracts.js";

const WorkerBindingsSchema = Type.Array(
  Type.Object(
    {
      worker_id: OpaqueIdSchema,
      endpoints: Type.Array(
        Type.Object(
          {
            scheme: Type.Literal("http"),
            host: Type.Union([Type.Literal("127.0.0.1"), Type.Literal("::1")]),
            port: Type.Integer({ minimum: 1, maximum: 65_535 }),
          },
          { additionalProperties: false }
        ),
        { minItems: 1, maxItems: 64 }
      ),
    },
    { additionalProperties: false }
  ),
  { minItems: 1, maxItems: 256 }
);
type WorkerBindings = Static<typeof WorkerBindingsSchema>;

/** Explicit construction-time host topology, shared by image and video registries.
 * Endpoints already use the client's closed literal-address representation: aliases are
 * listed explicitly, never inferred. Identity uses the existing physical-worker primitive,
 * not a profile digest or endpoint hash. This neither qualifies physical topology/external
 * exclusion nor migrates a retained lease/journal; deployment opt-in must be coordinated.
 */
export class ComfyWorkerIdentityRegistry {
  private readonly keys = new Map<string, string>();

  constructor(value: unknown) {
    capacityJson(value);
    const bindings: WorkerBindings = validateSkillSchema(
      WorkerBindingsSchema,
      value,
      "ComfyWorkerIdentityBindingsV1"
    );
    assertUnique(
      bindings.map((binding) => binding.worker_id),
      "Comfy worker identities"
    );
    for (const binding of bindings) {
      const key = hostCapacityWorkerKey(binding.worker_id);
      for (const endpoint of binding.endpoints) {
        const address = capacityJson(endpoint);
        if (this.keys.has(address)) throw new Error("duplicate Comfy worker endpoint binding");
        this.keys.set(address, key);
      }
    }
  }

  keyFor(endpoint: ComfyEndpointV1): string {
    const key = this.keys.get(capacityJson(endpoint));
    if (key === undefined) throw new Error("Comfy actual worker binding absent or drifted");
    return key;
  }
}
