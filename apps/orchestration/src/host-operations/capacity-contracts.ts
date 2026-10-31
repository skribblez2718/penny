import { Type, type Static } from "typebox";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  OpaqueIdSchema as Id,
  Sha256Schema,
  assertUnique,
  validateSkillSchema,
} from "../skill-contracts/common.js";
import { HostOperationLeaseIdentityV1Schema } from "./contracts.js";

/** Representation ceilings, not deployment capacities. Deployment limits must be lower. */
export const CAPACITY_MAX_RECORDS = 10_000;
export const CAPACITY_MAX_RESOURCES = 64;
export const CAPACITY_MAX_SNAPSHOTS = 1_024;
export const CAPACITY_MAX_JSON_BYTES = 131_072;
export const CAPACITY_METERS = [
  "gpu_milliseconds",
  "cpu_milliseconds",
  "stored_bytes",
  "egress_bytes",
  "cost_microcredits",
  "attempts",
  "engine_steps",
] as const;
const Amount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Clock = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 });
const Interval = Type.Integer({ minimum: 1, maximum: 2_592_000_000 });
const RecordId = Type.String({ pattern: "^hop_[a-f0-9]{64}$", maxLength: 68 });
const ProjectId = Type.String({ pattern: "^prj_[a-f0-9]{32}$", maxLength: 36 });
export const HostCapacityMetersV1Schema = Type.Object(
  {
    gpu_milliseconds: Amount,
    cpu_milliseconds: Amount,
    stored_bytes: Amount,
    egress_bytes: Amount,
    cost_microcredits: Amount,
    attempts: Amount,
    engine_steps: Amount,
  },
  { additionalProperties: false }
);
export type HostCapacityMetersV1 = Static<typeof HostCapacityMetersV1Schema>;
export function zeroCapacityMeters(): HostCapacityMetersV1 {
  return {
    gpu_milliseconds: 0,
    cpu_milliseconds: 0,
    stored_bytes: 0,
    egress_bytes: 0,
    cost_microcredits: 0,
    attempts: 0,
    engine_steps: 0,
  };
}
export const HostCapacityDemandV1Schema = Type.Object(
  {
    resource_id: Id,
    slots: Positive,
    meters: HostCapacityMetersV1Schema,
  },
  { additionalProperties: false }
);
export type HostCapacityDemandV1 = Static<typeof HostCapacityDemandV1Schema>;
export const HostCapacityBindingV1Schema = Type.Object(
  {
    binding_id: Id,
    operation_kind: Id,
    adapter_id: Id,
    backend_binding_id: Id,
    worker_id: Id,
    resource_ids: Type.Array(Id, { minItems: 1, maxItems: CAPACITY_MAX_RESOURCES }),
    purpose: Type.Union([Type.Literal("work"), Type.Literal("finish")]),
  },
  { additionalProperties: false }
);
export type HostCapacityBindingV1 = Static<typeof HostCapacityBindingV1Schema>;
export const HostCapacityPolicyV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-capacity-policy.v1"),
    schema_version: Type.Literal(1),
    policy_id: Id,
    /** Host configuration commits the topology; this digest is not topology qualification. */
    topology_sha256: Sha256Schema,
    external_work_policy: Type.Union([
      Type.Literal("exclusive_host"),
      Type.Literal("penny_serialized_api"),
    ]),
    max_admissions: Type.Integer({ minimum: 1, maximum: CAPACITY_MAX_RECORDS }),
    max_admissions_per_project: Type.Integer({ minimum: 1, maximum: CAPACITY_MAX_RECORDS }),
    max_queued: Type.Integer({ minimum: 1, maximum: CAPACITY_MAX_RECORDS }),
    max_queued_per_project: Type.Integer({ minimum: 1, maximum: CAPACITY_MAX_RECORDS }),
    max_active: Type.Integer({ minimum: 1, maximum: CAPACITY_MAX_RECORDS }),
    max_active_per_project: Type.Integer({ minimum: 1, maximum: CAPACITY_MAX_RECORDS }),
    /** Total durable snapshots, including final proof; one slot is reserved for final. */
    max_snapshots_per_operation: Type.Integer({ minimum: 1, maximum: CAPACITY_MAX_SNAPSHOTS }),
    queue_wait_ms: Interval,
    active_inactivity_ms: Interval,
    cleanup_grace_ms: Interval,
    max_elapsed_ms: Type.Optional(Interval),
    resources: Type.Array(
      Type.Object(
        {
          resource_id: Id,
          max_slots: Positive,
          protected_finish_slots: Amount,
          limits: HostCapacityMetersV1Schema,
          protected_finish: HostCapacityMetersV1Schema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: CAPACITY_MAX_RESOURCES }
    ),
    bindings: Type.Array(HostCapacityBindingV1Schema, { minItems: 1, maxItems: 256 }),
  },
  { additionalProperties: false }
);
export type HostCapacityPolicyV1 = Static<typeof HostCapacityPolicyV1Schema>;
export const HostCapacityRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-capacity-request.v1"),
    schema_version: Type.Literal(1),
    operation_record_id: RecordId,
    project_id: ProjectId,
    binding_id: Id,
    demands: Type.Array(HostCapacityDemandV1Schema, {
      minItems: 1,
      maxItems: CAPACITY_MAX_RESOURCES,
    }),
  },
  { additionalProperties: false }
);
export type HostCapacityRequestV1 = Static<typeof HostCapacityRequestV1Schema>;
const Usage = Type.Object(
  { resource_id: Id, meters: HostCapacityMetersV1Schema },
  { additionalProperties: false }
);
/** Additive accounting evidence. Omission preserves exact legacy measurement semantics. */
export const AllocationAccountingSchema = Type.Object(
  {
    assurance: Type.Literal("trusted_local_api"),
    cpu: Type.Literal("wall_clock_allocated_slot_ms_not_cpu_usage"),
    gpu: Type.Literal("wall_clock_allocated_slot_ms_not_kernel_usage"),
    network: Type.Literal("bidirectional_socket_bytes_including_tls_not_internet_egress"),
    storage: Type.Literal(
      "owned_payload_bytes_excludes_meter_control_metadata_and_transient_scratch"
    ),
    external_work_exclusion: Type.Literal("unknown"),
    engine_steps: Type.Literal("unknown_not_charged"),
    cost: Type.Literal("configured_internal_tariff_units_not_currency"),
    started_ms: Clock,
    ended_ms: Clock,
    socket_bytes: Amount,
    tariffs: HostCapacityMetersV1Schema,
  },
  { additionalProperties: false }
);
export const HostCapacitySnapshotV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-capacity-snapshot.v1"),
    schema_version: Type.Literal(1),
    operation_record_id: RecordId,
    request_sha256: Sha256Schema,
    lease: HostOperationLeaseIdentityV1Schema,
    source_revision: Positive,
    evidence_sha256: Sha256Schema,
    accounting: Type.Optional(AllocationAccountingSchema),
    kind: Type.Union([Type.Literal("cumulative"), Type.Literal("final")]),
    readings: Type.Array(Usage, { minItems: 1, maxItems: CAPACITY_MAX_RESOURCES }),
  },
  { additionalProperties: false }
);
export type HostCapacitySnapshotV1 = Static<typeof HostCapacitySnapshotV1Schema>;
export const HostCapacityRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-capacity-record.v1"),
    schema_version: Type.Literal(1),
    request: HostCapacityRequestV1Schema,
    policy_sha256: Sha256Schema,
    directive_sha256: Sha256Schema,
    operation_request_sha256: Sha256Schema,
    backend_key_sha256: Sha256Schema,
    lease: HostOperationLeaseIdentityV1Schema,
    revision: Positive,
    state: Type.Union([
      Type.Literal("queued"),
      Type.Literal("held"),
      Type.Literal("expired"),
      Type.Literal("settled"),
      Type.Literal("quarantined"),
    ]),
    created_ms: Clock,
    last_checked_ms: Clock,
    queue_expires_ms: Clock,
    active_started_ms: Type.Union([Clock, Type.Null()]),
    last_milestone_ms: Type.Union([Clock, Type.Null()]),
    milestone: Type.Union([
      Type.Literal("none"),
      Type.Literal("fetched"),
      Type.Literal("persisted"),
      Type.Literal("verified"),
    ]),
    cleanup_started_ms: Type.Union([Clock, Type.Null()]),
    snapshot: Type.Union([HostCapacitySnapshotV1Schema, Type.Null()]),
    disposition_receipt_id: Type.Union([Id, Type.Null()]),
    effect_permission: Type.Literal("none"),
  },
  { additionalProperties: false }
);
export type HostCapacityRecordV1 = Static<typeof HostCapacityRecordV1Schema>;

function boundedCapacityInput(value: unknown): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  let stringBytes = 0;
  while (pending.length !== 0) {
    const item = pending.pop();
    if (item === undefined) throw new Error("capacity representation traversal failed");
    nodes += 1;
    if (nodes > 20_000 || item.depth > 12)
      throw new Error("capacity representation complexity limit");
    if (typeof item.value === "string") stringBytes += Buffer.byteLength(item.value, "utf8");
    if (stringBytes > CAPACITY_MAX_JSON_BYTES)
      throw new Error("capacity representation byte limit");
    if (item.value !== null && typeof item.value === "object") {
      if (!Array.isArray(item.value) && Object.getPrototypeOf(item.value) !== Object.prototype)
        throw new Error("capacity input must be plain data");
      const keys = Reflect.ownKeys(item.value);
      if (keys.length > 4_096) throw new Error("capacity representation collection limit");
      for (const key of keys) {
        if (Array.isArray(item.value) && key === "length") continue;
        if (typeof key !== "string") throw new Error("capacity input must be plain JSON data");
        const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
          throw new Error("capacity input accessors/non-JSON fields forbidden");
        const child: unknown = descriptor.value;
        stringBytes += Buffer.byteLength(key, "utf8");
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else if (
      typeof item.value !== "string" &&
      typeof item.value !== "number" &&
      typeof item.value !== "boolean" &&
      item.value !== null
    )
      throw new Error("capacity input must be JSON");
  }
}
export function capacityJson(value: unknown): string {
  boundedCapacityInput(value);
  const text = canonicalJson(value);
  if (Buffer.byteLength(text, "utf8") > CAPACITY_MAX_JSON_BYTES)
    throw new Error("capacity representation limit");
  return text;
}
export function validateCapacityPolicy(value: unknown): HostCapacityPolicyV1 {
  boundedCapacityInput(value);
  const policy = validateSkillSchema(HostCapacityPolicyV1Schema, value, "HostCapacityPolicyV1");
  capacityJson(policy);
  assertUnique(
    policy.resources.map((x) => x.resource_id),
    "capacity resource identities"
  );
  assertUnique(
    policy.bindings.map((x) => x.binding_id),
    "capacity bindings"
  );
  for (const resource of policy.resources) {
    if (resource.protected_finish_slots > resource.max_slots)
      throw new Error("finish slots exceed total");
    for (const meter of CAPACITY_METERS) {
      if (resource.protected_finish[meter] > resource.limits[meter])
        throw new Error("finish allowance exceeds total");
    }
  }
  for (const binding of policy.bindings) {
    assertUnique(binding.resource_ids, "binding resources");
    if (
      policy.bindings.some(
        (other) =>
          other.worker_id === binding.worker_id &&
          canonicalJson([...other.resource_ids].sort()) !==
            canonicalJson([...binding.resource_ids].sort())
      )
    )
      throw new Error("same worker topology conflicts across bindings");
    if (binding.resource_ids.some((id) => !policy.resources.some((x) => x.resource_id === id)))
      throw new Error("binding resource absent");
  }
  // Purpose belongs to one host-owned, immutable journal authority tuple, not a request alias.
  assertUnique(
    policy.bindings.map((binding) =>
      canonicalJson([
        binding.operation_kind,
        binding.adapter_id,
        binding.backend_binding_id,
        binding.worker_id,
      ])
    ),
    "capacity journal authority bindings"
  );
  for (const [perProject, global] of [
    [policy.max_admissions_per_project, policy.max_admissions],
    [policy.max_queued_per_project, policy.max_queued],
    [policy.max_active_per_project, policy.max_active],
  ]) {
    if (perProject !== undefined && global !== undefined && perProject > global)
      throw new Error("project limit exceeds global limit");
  }
  return structuredClone(policy);
}
export function validateCapacityRequest(value: unknown): HostCapacityRequestV1 {
  boundedCapacityInput(value);
  const request = validateSkillSchema(HostCapacityRequestV1Schema, value, "HostCapacityRequestV1");
  capacityJson(request);
  assertUnique(
    request.demands.map((x) => x.resource_id),
    "capacity demands"
  );
  if (
    request.demands.some(
      (x, index) => index > 0 && x.resource_id <= (request.demands[index - 1]?.resource_id ?? "")
    )
  )
    throw new Error("capacity resources must be canonically ordered");
  return request;
}
export function validateCapacitySnapshot(value: unknown): HostCapacitySnapshotV1 {
  boundedCapacityInput(value);
  const snapshot = validateSkillSchema(
    HostCapacitySnapshotV1Schema,
    value,
    "HostCapacitySnapshotV1"
  );
  capacityJson(snapshot);
  assertUnique(
    snapshot.readings.map((x) => x.resource_id),
    "capacity readings"
  );
  if (!Number.isSafeInteger(snapshot.lease.lease_epoch))
    throw new Error("capacity snapshot lease epoch overflow");
  if (
    snapshot.readings.some(
      (x, index) => index > 0 && x.resource_id <= (snapshot.readings[index - 1]?.resource_id ?? "")
    )
  )
    throw new Error("capacity readings must be canonically ordered");
  return snapshot;
}
export function validateCapacityRecord(value: unknown): HostCapacityRecordV1 {
  boundedCapacityInput(value);
  const record = validateSkillSchema(HostCapacityRecordV1Schema, value, "HostCapacityRecordV1");
  validateCapacityRequest(record.request);
  capacityJson(record);
  if (
    record.created_ms > record.last_checked_ms ||
    record.queue_expires_ms < record.created_ms ||
    (record.active_started_ms === null) !== (record.last_milestone_ms === null)
  )
    throw new Error("capacity clocks diverge");
  if (
    (record.state === "queued" || record.state === "expired") &&
    record.active_started_ms !== null
  )
    throw new Error("unadmitted capacity has active clock");
  if (
    ["held", "settled", "quarantined"].includes(record.state) &&
    record.active_started_ms === null
  )
    throw new Error("admitted capacity lacks clock");
  if (
    !Number.isSafeInteger(record.lease.lease_epoch) ||
    record.backend_key_sha256 !== record.lease.backend_key_sha256
  )
    throw new Error("capacity lease projection diverges");
  if (
    record.active_started_ms !== null &&
    (record.active_started_ms < record.created_ms ||
      record.last_milestone_ms === null ||
      record.last_milestone_ms < record.active_started_ms ||
      record.last_milestone_ms > record.last_checked_ms)
  )
    throw new Error("capacity active clocks diverge");
  if (
    record.cleanup_started_ms !== null &&
    (record.cleanup_started_ms < record.created_ms ||
      record.cleanup_started_ms > record.last_checked_ms)
  )
    throw new Error("capacity cleanup clock diverges");
  if (
    (record.state === "queued" || record.state === "expired") &&
    (record.snapshot !== null ||
      record.milestone !== "none" ||
      record.disposition_receipt_id !== null)
  )
    throw new Error("unadmitted capacity carries spend/proof/activity");
  if (
    (record.state === "settled" || record.state === "quarantined") &&
    record.disposition_receipt_id === null
  )
    throw new Error("capacity disposed state lacks proof identity");
  if (record.state === "settled" && record.snapshot?.kind !== "final")
    throw new Error("capacity settled state lacks final measurement");
  if (record.snapshot !== null) {
    const snapshot = validateCapacitySnapshot(record.snapshot);
    if (
      snapshot.operation_record_id !== record.request.operation_record_id ||
      snapshot.request_sha256 !== sha256(capacityJson(record.request)) ||
      snapshot.lease.backend_key_sha256 !== record.backend_key_sha256 ||
      snapshot.lease.lease_epoch > record.lease.lease_epoch ||
      (snapshot.kind === "final" &&
        canonicalJson(snapshot.lease) !== canonicalJson(record.lease)) ||
      (snapshot.lease.lease_epoch === record.lease.lease_epoch &&
        canonicalJson(snapshot.lease) !== canonicalJson(record.lease)) ||
      canonicalJson(snapshot.readings.map((x) => x.resource_id)) !==
        canonicalJson(record.request.demands.map((x) => x.resource_id))
    )
      throw new Error("capacity measured snapshot projection diverges");
    for (const [index, demand] of record.request.demands.entries()) {
      const reading = snapshot.readings[index];
      if (reading === undefined) throw new Error("capacity measured reading missing");
      for (const meter of CAPACITY_METERS)
        if (reading.meters[meter] > demand.meters[meter])
          throw new Error("capacity recorded measurement exceeds hold");
    }
  }
  return record;
}
/** New opt-in identity only. Never rederive a retained legacy backend key. */
export function hostCapacityWorkerKey(workerId: string): string {
  validateSkillSchema(Id, workerId, "capacity worker identity");
  return sha256(canonicalJson({ schema_id: "penny.host-capacity-worker.v1", worker_id: workerId }));
}
