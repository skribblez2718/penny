import { Type, type Static } from "typebox";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import { OpaqueIdSchema as Id, assertUnique } from "../skill-contracts/common.js";
import { sameRef, validateFoundation, type FoundationLimitsV1 } from "./bounds.js";
import {
  MeterSchema,
  validateBudgetReservation,
  type BudgetReservationV1,
} from "./foundation-contracts.js";
/** Trusted owner-journal projection, not a product attestation or atomic capacity API. */
export const BudgetMeasurementV1Schema = Type.Object(
  {
    operation_id: Id,
    reservation_ref: ArtifactRefSchema,
    journal_ref: ArtifactRefSchema,
    readings: Type.Array(
      Type.Object(
        {
          meter: MeterSchema,
          consumed: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 7 }
    ),
    submission: Type.Union([
      Type.Literal("never_submitted"),
      Type.Literal("submitted"),
      Type.Literal("unknown"),
    ]),
    disposition: Type.Union([
      Type.Literal("active"),
      Type.Literal("terminal_proven"),
      Type.Literal("queue_expired"),
      Type.Literal("pre_submit_cancel"),
      Type.Literal("scope_revoked"),
      Type.Literal("remote_unknown"),
    ]),
  },
  { additionalProperties: false }
);
export type BudgetMeasurementV1 = Static<typeof BudgetMeasurementV1Schema>;
/** Cumulative snapshots make replay idempotent: reservation is hold, consumed is spend. */
export function reconcileBudget(input: {
  reservation: unknown;
  reservation_ref: ArtifactRef;
  operation_id: string;
  measurement: unknown;
  limits: FoundationLimitsV1;
}): {
  readonly reservation: BudgetReservationV1;
  readonly unused_released: readonly {
    meter: BudgetReservationV1["meters"][number]["meter"];
    amount: number;
  }[];
} {
  const reservation = validateBudgetReservation(input.reservation, input.limits);
  const measurement = validateFoundation(
    BudgetMeasurementV1Schema,
    input.measurement,
    input.limits
  );
  if (
    !sameRef(measurement.reservation_ref, input.reservation_ref) ||
    measurement.operation_id !== input.operation_id
  )
    throw new Error("budget operation/reservation identity");
  assertUnique(
    measurement.readings.map((x) => x.meter),
    "measured meters"
  );
  if (measurement.readings.length !== reservation.meters.length)
    throw new Error("incomplete measured meters");
  const meters = reservation.meters.map((m) => {
    const read = measurement.readings.find((x) => x.meter === m.meter);
    if (read === undefined || read.consumed < m.consumed || read.consumed > m.reserved)
      throw new Error("meter rollback or cap exceeded");
    return { ...m, consumed: read.consumed };
  });
  if (measurement.submission === "never_submitted" && meters.some((m) => m.consumed !== 0))
    throw new Error("never-submitted consumption");
  const preRelease = ["queue_expired", "pre_submit_cancel", "scope_revoked"].includes(
    measurement.disposition
  );
  if (preRelease && measurement.submission !== "never_submitted")
    throw new Error("expiry/cancel cannot release submitted work");
  if (measurement.disposition === "terminal_proven" && measurement.submission === "unknown")
    throw new Error("unproven terminal");
  const state =
    measurement.disposition === "remote_unknown" || measurement.submission === "unknown"
      ? "quarantined"
      : measurement.disposition === "terminal_proven"
        ? "settled"
        : preRelease
          ? "released"
          : "held";
  const reason =
    state === "quarantined"
      ? "remote_unknown"
      : measurement.disposition === "active"
        ? "applied"
        : measurement.disposition;
  if (
    (reservation.state === "settled" || reservation.state === "released") &&
    (state !== reservation.state ||
      meters.some((m, i) => m.consumed !== reservation.meters[i]?.consumed))
  )
    throw new Error("settled budget cannot reopen or charge twice");
  if (
    reservation.state === "quarantined" &&
    state !== "quarantined" &&
    measurement.disposition !== "terminal_proven"
  )
    throw new Error("quarantine requires proven reconciliation");
  const next = validateBudgetReservation({ ...reservation, state, reason, meters }, input.limits);
  return {
    reservation: next,
    unused_released:
      (state === "settled" || state === "released") && reservation.state !== state
        ? meters.map((m) => ({ meter: m.meter, amount: m.reserved - m.consumed }))
        : [],
  };
}
