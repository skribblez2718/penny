import { Type, type Static } from "typebox";
import { ArtifactRefSchema } from "../contracts.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { Sha256Schema, OpaqueIdSchema, validateSkillSchema } from "../skill-contracts/common.js";
import { HostOperationLeaseIdentityV1Schema, type HostOperationCallRecordV1 } from "./contracts.js";
import { hostOperationCallImmutableJcs } from "./storage.js";
import {
  HostCapacityRecordV1Schema,
  capacityJson,
  validateCapacityRecord,
} from "./capacity-contracts.js";

const Clock = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 });
const Positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const HostCapacityParkingProofV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-capacity-parking-proof.v1"),
    schema_version: Type.Literal(1),
    operation_record_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    directive_sha256: Sha256Schema,
    operation_request_sha256: Sha256Schema,
    capacity_request_sha256: Sha256Schema,
    journal_binding_sha256: Sha256Schema,
    lease: HostOperationLeaseIdentityV1Schema,
    capacity_revision: Positive,
    parked_at_ms: Clock,
    queue_expires_ms: Clock,
    backend_queue_expires_ms: Clock,
  },
  { additionalProperties: false }
);
export type HostCapacityParkingProofV1 = Static<typeof HostCapacityParkingProofV1Schema>;

export const HostCapacityProductiveObservationV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-capacity-productive-observation.v1"),
    schema_version: Type.Literal(1),
    project_id: OpaqueIdSchema,
    operation_record_id: OpaqueIdSchema,
    directive_sha256: Sha256Schema,
    operation_request_sha256: Sha256Schema,
    capacity_request_sha256: Sha256Schema,
    lease: HostOperationLeaseIdentityV1Schema,
    remote_correlation_sha256: Sha256Schema,
    source_id: OpaqueIdSchema,
    productive_revision: Positive,
    completed_units: Positive,
    total_units: Positive,
    observed_at_ms: Clock,
    kind: Type.Literal("productive_output"),
  },
  { additionalProperties: false }
);
export type HostCapacityProductiveObservationV1 = Static<
  typeof HostCapacityProductiveObservationV1Schema
>;

/** V1 remains an exact closed legacy record. V2 wraps it; there is no implicit rewrite. */
export const HostCapacityRuntimeRecordV2Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.host-capacity-runtime-record.v2"),
    schema_version: Type.Literal(2),
    core: HostCapacityRecordV1Schema,
    parked: Type.Boolean(),
    parking: Type.Union([HostCapacityParkingProofV1Schema, Type.Null()]),
    productive_binding_sha256: Type.Union([Sha256Schema, Type.Null()]),
    productive_count: Type.Integer({ minimum: 0, maximum: 65_536 }),
    productive: Type.Union([
      Type.Object(
        {
          ref: ArtifactRefSchema,
          observation: HostCapacityProductiveObservationV1Schema,
        },
        { additionalProperties: false }
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false }
);
export type HostCapacityRuntimeRecordV2 = Static<typeof HostCapacityRuntimeRecordV2Schema>;
export type HostCapacityStoredRecord =
  | ReturnType<typeof validateCapacityRecord>
  | HostCapacityRuntimeRecordV2;

/** Only mutable fence/expiry/update fields may differ across parking recovery. All other
 * pre-submission journal evidence is exact. A terminal/accepted journal never matches. */
export function capacityParkingJournalBinding(journal: HostOperationCallRecordV1): string {
  if (
    journal.lifecycle !== "lease_acquired" ||
    journal.lease === null ||
    journal.remote_correlation_id !== null ||
    journal.remote_correlation_sha256 !== null ||
    journal.fetched !== null ||
    journal.persistence_plan !== null ||
    journal.operation_result_ref !== null ||
    journal.output_artifacts.length !== 0 ||
    journal.disposition !== null ||
    journal.lease_disposition_receipt_id !== null ||
    journal.platform_result_ref !== null ||
    journal.host_receipt_ref !== null
  )
    throw new Error("capacity parking requires exact non-submission journal");
  return sha256(
    canonicalJson({
      immutable: hostOperationCallImmutableJcs(journal),
      progress_event_count: journal.progress_event_count,
      operation_inactivity_expires_at_ms: journal.operation_inactivity_expires_at_ms,
    })
  );
}
export function validateCapacityProductiveObservation(
  value: unknown
): HostCapacityProductiveObservationV1 {
  capacityJson(value);
  const observation = validateSkillSchema(
    HostCapacityProductiveObservationV1Schema,
    value,
    "HostCapacityProductiveObservationV1"
  );
  if (
    observation.completed_units > observation.total_units ||
    !Number.isSafeInteger(observation.lease.lease_epoch)
  )
    throw new Error("capacity productive units/fence invalid");
  return observation;
}
export function validateCapacityStoredRecord(value: unknown): HostCapacityStoredRecord {
  capacityJson(value);
  if (
    value !== null &&
    typeof value === "object" &&
    "schema_version" in value &&
    value.schema_version === 2
  ) {
    const record = validateSkillSchema(
      HostCapacityRuntimeRecordV2Schema,
      value,
      "HostCapacityRuntimeRecordV2"
    );
    const core = validateCapacityRecord(record.core);
    if (record.parked && (record.parking === null || !["queued", "expired"].includes(core.state)))
      throw new Error("capacity parked representation invalid");
    if (record.parking !== null) {
      const proof = record.parking;
      if (
        proof.operation_record_id !== core.request.operation_record_id ||
        proof.project_id !== core.request.project_id ||
        proof.directive_sha256 !== core.directive_sha256 ||
        proof.operation_request_sha256 !== core.operation_request_sha256 ||
        proof.capacity_request_sha256 !== sha256(capacityJson(core.request)) ||
        proof.queue_expires_ms !== core.queue_expires_ms ||
        proof.lease.backend_key_sha256 !== core.backend_key_sha256 ||
        proof.parked_at_ms > core.last_checked_ms ||
        proof.capacity_revision >= core.revision ||
        (record.parked && canonicalJson(proof.lease) !== canonicalJson(core.lease))
      )
        throw new Error("capacity parking proof projection conflict");
    }
    if ((record.productive === null) !== (record.productive_count === 0))
      throw new Error("capacity productive selection/count conflict");
    if (record.productive !== null) {
      const observation = validateCapacityProductiveObservation(record.productive.observation);
      if (
        record.productive_binding_sha256 === null ||
        core.active_started_ms === null ||
        observation.project_id !== core.request.project_id ||
        observation.operation_record_id !== core.request.operation_record_id ||
        observation.directive_sha256 !== core.directive_sha256 ||
        observation.operation_request_sha256 !== core.operation_request_sha256 ||
        observation.capacity_request_sha256 !== sha256(capacityJson(core.request)) ||
        observation.lease.backend_key_sha256 !== core.backend_key_sha256 ||
        observation.observed_at_ms < core.active_started_ms ||
        observation.observed_at_ms > (core.last_milestone_ms ?? -1)
      )
        throw new Error("capacity productive projection conflict");
    }
    return record;
  }
  return validateCapacityRecord(value);
}
export function capacityCore(
  record: HostCapacityStoredRecord
): ReturnType<typeof validateCapacityRecord> {
  return record.schema_version === 2 ? record.core : record;
}
