import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  OpaqueIdSchema as Id,
  Sha256Schema,
  validateSkillSchema,
  assertUnique,
} from "../skill-contracts/common.js";
import { HostOperationLeaseIdentityV1Schema } from "./contracts.js";
import {
  HostCapacitySnapshotV1Schema,
  capacityJson,
  type HostCapacityPolicyV1,
} from "./capacity-contracts.js";
import { NativeProcessPinSchema } from "./native-process.js";
const closed = { additionalProperties: false } as const;
const amount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const filename = Type.String({ minLength: 1, maxLength: 4096 });
export const NativeCapacityTopologySchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    resources: Type.Array(
      Type.Object(
        {
          resource_id: Id,
          device: Type.Union([
            Type.Object(
              {
                kind: Type.Literal("gpu"),
                uuid: Type.String({ pattern: "^GPU-[a-f0-9-]+$", maxLength: 128 }),
              },
              closed
            ),
            Type.Object({ kind: Type.Literal("local"), identity: Id }, closed),
          ]),
        },
        closed
      ),
      { minItems: 1, maxItems: 64 }
    ),
    workers: Type.Array(
      Type.Object(
        {
          worker_id: Id,
          resource_ids: Type.Array(Id, { minItems: 1, maxItems: 64, uniqueItems: true }),
        },
        closed
      ),
      { minItems: 1, maxItems: 256 }
    ),
  },
  closed
);
export type NativeCapacityTopology = Static<typeof NativeCapacityTopologySchema>;
export function validateNativeTopology(
  value: unknown,
  policy: HostCapacityPolicyV1
): NativeCapacityTopology {
  capacityJson(value);
  const t = validateSkillSchema(NativeCapacityTopologySchema, value, "native capacity topology");
  assertUnique(
    t.resources.map((r) => r.resource_id),
    "native resources"
  );
  assertUnique(
    t.resources.map((r) => canonicalJson(r.device)),
    "physical resource aliases"
  );
  assertUnique(
    t.workers.map((w) => w.worker_id),
    "native workers"
  );
  if (
    sha256(capacityJson(t)) !== policy.topology_sha256 ||
    canonicalJson(t.resources.map((r) => r.resource_id).sort()) !==
      canonicalJson(policy.resources.map((r) => r.resource_id).sort())
  )
    throw new Error("native installed topology drift");
  for (const b of policy.bindings) {
    const worker = t.workers.find((w) => w.worker_id === b.worker_id);
    if (
      !worker ||
      canonicalJson([...worker.resource_ids].sort()) !== canonicalJson([...b.resource_ids].sort())
    )
      throw new Error("native worker resource mapping drift");
  }
  for (const w of t.workers)
    if (!policy.bindings.some((b) => b.worker_id === w.worker_id))
      throw new Error("native unbound worker");
  return structuredClone(t);
}
/** Service-side state, not a PASS. 'closed' means the actual all-entrypoint gate is closed
 * and drained. A service must keep that gate closed until a catalog-current grant is verified. */
export const ManagedWorkerStateSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.managed-worker-state.v1"),
    schema_version: Type.Literal(1),
    worker_id: Id,
    process_epoch: Sha256Schema,
    gate_build_sha256: Sha256Schema,
    sequence: positive,
    observed_at_ms: amount,
    state: Type.Union([
      Type.Object(
        { kind: Type.Literal("closed"), active_calls: Type.Literal(0), grant_sha256: Type.Null() },
        closed
      ),
      Type.Object(
        {
          kind: Type.Literal("executing"),
          active_calls: Type.Literal(1),
          grant_sha256: Sha256Schema,
        },
        closed
      ),
    ]),
  },
  closed
);
export type ManagedWorkerState = Static<typeof ManagedWorkerStateSchema>;
export const ManagedWorkerPinSchema = Type.Object(
  {
    worker_id: Id,
    process: NativeProcessPinSchema,
    gate_build: Type.Object({ path: filename, sha256: Sha256Schema }, closed),
    state_file: filename,
    grant_file: filename,
    max_age_ms: Type.Integer({ minimum: 1, maximum: 300000 }),
  },
  closed
);
export type ManagedWorkerPin = Static<typeof ManagedWorkerPinSchema>;
export const ManagedLeaseGrantSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.managed-lease-grant.v1"),
    schema_version: Type.Literal(1),
    operation_record_id: Type.String({ pattern: "^hop_[a-f0-9]{64}$" }),
    project_id: Type.String({ pattern: "^prj_[a-f0-9]{32}$" }),
    operation_request_sha256: Sha256Schema,
    capacity_request_sha256: Sha256Schema,
    directive_sha256: Sha256Schema,
    lease: HostOperationLeaseIdentityV1Schema,
    worker_id: Id,
    process_epoch: Sha256Schema,
    gate_sequence: positive,
    resource_ids: Type.Array(Id, { minItems: 1, maxItems: 64, uniqueItems: true }),
    issued_at_ms: amount,
    expires_at_ms: amount,
  },
  closed
);
export type ManagedLeaseGrant = Static<typeof ManagedLeaseGrantSchema>;
const counter = Type.Object(
  {
    boot_id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
    monotonic_ns: Type.String({ pattern: "^[0-9]+$", maxLength: 32 }),
    cpu_usage_usec: Type.String({ pattern: "^[0-9]+$", maxLength: 32 }),
    cgroup_identity: Type.String({ maxLength: 256 }),
    process_epoch: Sha256Schema,
  },
  closed
);
export const NativeMeterStartSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    binding_sha256: Sha256Schema,
    operation_request_sha256: Sha256Schema,
    capacity_request_sha256: Sha256Schema,
    lease: HostOperationLeaseIdentityV1Schema,
    counter,
    files: Type.Array(
      Type.Object(
        {
          path_sha256: Sha256Schema,
          bytes: amount,
          identity: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
        },
        closed
      ),
      { maxItems: 256 }
    ),
  },
  closed
);
export type NativeMeterStart = Static<typeof NativeMeterStartSchema>;
export const NativeMeterStopSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    binding_sha256: Sha256Schema,
    start_sha256: Sha256Schema,
    operation_request_sha256: Sha256Schema,
    counter,
    files: NativeMeterStartSchema.properties.files,
    transfer_bytes: amount,
  },
  closed
);
export type NativeMeterStop = Static<typeof NativeMeterStopSchema>;
export const NativeMeterFinalSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    binding_sha256: Sha256Schema,
    start_sha256: Sha256Schema,
    operation_request_sha256: Sha256Schema,
    counter,
    snapshot: HostCapacitySnapshotV1Schema,
  },
  closed
);
export type NativeMeterFinal = Static<typeof NativeMeterFinalSchema>;
export const NativeMeterBindingSchema = Type.Object(
  {
    binding_id: Id,
    process: NativeProcessPinSchema,
    // A dedicated leaf cgroup containing this worker and its descendants ONLY. Never created/moved here.
    cpu_cgroup: Type.Object(
      { directory: filename, proc_path: Type.String({ pattern: "^/", maxLength: 4096 }) },
      closed
    ),
    // Exact caller-owned files. Only the literal {operation_record_id} token may vary.
    private_files: Type.Array(filename, { maxItems: 256, uniqueItems: true }),
    resources: Type.Array(
      Type.Object(
        {
          resource_id: Id,
          sources: Type.Array(
            Type.Union([
              Type.Literal("worker_cpu"),
              Type.Literal("gpu_allocation_window"),
              Type.Literal("private_bytes"),
              Type.Literal("journal_bytes"),
              Type.Literal("journal_events"),
              Type.Literal("transfer_bytes"),
            ]),
            { minItems: 1, maxItems: 6, uniqueItems: true }
          ),
          // Each observed integer unit is multiplied by this exact rational configured tariff.
          tariff: Type.Object(
            {
              per: Type.Union([
                Type.Literal("gpu_milliseconds"),
                Type.Literal("cpu_milliseconds"),
                // Cost-only basis: observed monotonic allocation window × held CPU slots.
                Type.Literal("cpu_allocation_milliseconds"),
                Type.Literal("stored_bytes"),
                Type.Literal("egress_bytes"),
                Type.Literal("attempts"),
                Type.Literal("engine_steps"),
              ]),
              numerator: amount,
              denominator: positive,
            },
            closed
          ),
        },
        closed
      ),
      { minItems: 1, maxItems: 64 }
    ),
    // No zero substitute for a remote transfer meter; remote adapters require a separate source.
    network: Type.Union([Type.Literal("none"), Type.Object({ counter_file: filename }, closed)]),
  },
  closed
);
export type NativeMeterBinding = Static<typeof NativeMeterBindingSchema>;
export const NativeTransferCounterSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.native-transfer-counter.v1"),
    schema_version: Type.Literal(1),
    operation_record_id: Type.String({ pattern: "^hop_[a-f0-9]{64}$" }),
    operation_request_sha256: Sha256Schema,
    capacity_request_sha256: Sha256Schema,
    lease: HostOperationLeaseIdentityV1Schema,
    egress_bytes: amount,
  },
  closed
);
export const NativeCapacityRuntimeSchema = Type.Object(
  {
    topology: NativeCapacityTopologySchema,
    workers: Type.Array(ManagedWorkerPinSchema, { maxItems: 256 }),
    meters: Type.Array(NativeMeterBindingSchema, { minItems: 1, maxItems: 256 }),
    gpu_probe: Type.Optional(
      Type.Object(
        {
          executable: Type.Object({ path: filename, sha256: Sha256Schema }, closed),
          timeout_ms: Type.Integer({ minimum: 1, maximum: 30000 }),
          max_output_bytes: Type.Integer({ minimum: 1, maximum: 1048576 }),
        },
        closed
      )
    ),
  },
  closed
);
export type NativeCapacityRuntime = Static<typeof NativeCapacityRuntimeSchema>;
export const NativeCapacityEventSchemas = {
  native_meter_start_v1: NativeMeterStartSchema,
  native_meter_final_v1: NativeMeterFinalSchema,
  native_meter_stop_v1: NativeMeterStopSchema,
  managed_lease_grant_v1: ManagedLeaseGrantSchema,
} as const;
export type NativeCapacityEventKind = keyof typeof NativeCapacityEventSchemas;
