import { canonicalJson } from "../canonical-json.js";
import type { ArtifactRef } from "../contracts.js";
import {
  IMAGEGEN_MAX_REVISION_ROUNDS,
  ImageSlotLedgerV1Schema,
  imagegenEffectiveSeed,
  type ImageSlotLedgerV1,
  type ImageSlotRecordV1,
  type ImageSlotStateV1,
} from "../skill-contracts/imagegen.js";
import {
  SkillSchemaValidationError,
  assertOpaqueId,
  validateSkillSchema,
} from "../skill-contracts/common.js";

const TERMINAL_OPERATIONAL_STATES = new Set<ImageSlotStateV1>([
  "operational_failed",
  "remote_failed",
  "remote_unknown",
  "downloaded_invalid",
  "cancelled",
  "skipped_after_prior_failure",
]);

const GENERATION_TRANSITIONS: Readonly<Record<ImageSlotStateV1, readonly ImageSlotStateV1[]>> = {
  unattempted: ["prepared", "cancelled", "skipped_after_prior_failure"],
  prepared: ["submitting", "cancelled"],
  submitting: [
    "submitted",
    "operational_failed",
    "remote_failed",
    "remote_unknown",
    "downloaded_invalid",
    "cancelled",
  ],
  submitted: ["reviewable", "remote_failed", "remote_unknown", "downloaded_invalid", "cancelled"],
  reviewable: [],
  under_review: [],
  critic_failed: ["prepared"],
  accepted: [],
  operational_failed: [],
  remote_failed: [],
  remote_unknown: [],
  downloaded_invalid: [],
  cancelled: [],
  skipped_after_prior_failure: [],
};

function sameRef(left: ArtifactRef | null, right: ArtifactRef | null): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertSlotRecord(record: ImageSlotRecordV1, ledgerEpoch: number): void {
  const hasCurrentImage = record.image_ref !== null;
  const hasValidation = record.validation_receipt_ref !== null;
  const hasGraph = record.submitted_graph_ref !== null;
  if (
    ["submitting", "submitted", "reviewable", "under_review", "critic_failed", "accepted"].includes(
      record.state
    ) &&
    !hasGraph
  ) {
    throw new SkillSchemaValidationError("ImageSlotRecordV1", [
      `slot ${record.slot} state '${record.state}' lacks a submitted graph`,
    ]);
  }
  if (
    ["reviewable", "under_review", "critic_failed", "accepted"].includes(record.state) &&
    (!hasCurrentImage || !hasValidation || record.operation_receipt_ref === null)
  ) {
    throw new SkillSchemaValidationError("ImageSlotRecordV1", [
      `slot ${record.slot} state '${record.state}' lacks exact current image evidence`,
    ]);
  }
  if (record.state === "downloaded_invalid" && record.validation_receipt_ref === null) {
    throw new SkillSchemaValidationError("ImageSlotRecordV1", [
      `slot ${record.slot} downloaded_invalid lacks its failed validation receipt`,
    ]);
  }
  if (TERMINAL_OPERATIONAL_STATES.has(record.state)) {
    if (
      record.reason_code === null ||
      record.operation_receipt_ref === null ||
      record.disposition_receipt_ref === null ||
      record.lease_disposition === null
    ) {
      throw new SkillSchemaValidationError("ImageSlotRecordV1", [
        `slot ${record.slot} terminal operational state lacks reason-coded disposition evidence`,
      ]);
    }
    if (
      (record.state === "remote_unknown" && record.lease_disposition !== "quarantined") ||
      ([
        "operational_failed",
        "remote_failed",
        "downloaded_invalid",
        "skipped_after_prior_failure",
      ].includes(record.state) &&
        record.lease_disposition !== "released") ||
      (record.lease_disposition === "quarantined" && !record.remote_may_continue) ||
      (record.lease_disposition === "released" && record.remote_may_continue)
    ) {
      throw new SkillSchemaValidationError("ImageSlotRecordV1", [
        `slot ${record.slot} state and lease disposition disagree`,
      ]);
    }
  } else if (
    record.reason_code !== null ||
    record.disposition_receipt_ref !== null ||
    record.lease_disposition !== null ||
    record.remote_may_continue
  ) {
    throw new SkillSchemaValidationError("ImageSlotRecordV1", [
      `slot ${record.slot} nonterminal state carries terminal disposition fields`,
    ]);
  }
  if (["under_review", "critic_failed", "accepted"].includes(record.state)) {
    if (record.review_epoch !== ledgerEpoch || record.review_epoch === null) {
      throw new SkillSchemaValidationError("ImageSlotRecordV1", [
        `slot ${record.slot} review epoch is not current`,
      ]);
    }
  } else if (record.review_epoch !== null) {
    throw new SkillSchemaValidationError("ImageSlotRecordV1", [
      `slot ${record.slot} carries a review epoch outside review state`,
    ]);
  }
  const reviewed = record.state === "critic_failed" || record.state === "accepted";
  if (reviewed !== (record.vera_report_ref !== null && record.carren_report_ref !== null)) {
    throw new SkillSchemaValidationError("ImageSlotRecordV1", [
      `slot ${record.slot} review state and dual-report evidence disagree`,
    ]);
  }
}

export function validateImageSlotLedger(value: unknown): ImageSlotLedgerV1 {
  const ledger = validateSkillSchema(ImageSlotLedgerV1Schema, value, "ImageSlotLedgerV1");
  assertOpaqueId(ledger.run_id, "ImageSlotLedgerV1.run_id");
  if (ledger.slots.length !== ledger.count) {
    throw new SkillSchemaValidationError("ImageSlotLedgerV1", [
      "slot count does not equal requested count",
    ]);
  }
  const ordered = ledger.slots.map((slot) => slot.slot);
  if (ordered.some((slot, index) => slot !== index)) {
    throw new SkillSchemaValidationError("ImageSlotLedgerV1", [
      "slots must be complete and ordered from zero",
    ]);
  }
  for (const slot of ledger.slots) {
    if (slot.effective_seed !== imagegenEffectiveSeed(ledger.base_seed, slot.slot)) {
      throw new SkillSchemaValidationError("ImageSlotLedgerV1", [
        `slot ${slot.slot} effective seed diverges from the stable derivation`,
      ]);
    }
    assertSlotRecord(slot, ledger.review_epoch);
  }
  return ledger;
}

export function createImageSlotLedger(input: {
  readonly run_id: string;
  readonly count: number;
  readonly base_seed: number;
}): ImageSlotLedgerV1 {
  return validateImageSlotLedger({
    schema_id: "penny.image-slot-ledger.v1",
    schema_version: 1,
    run_id: input.run_id,
    count: input.count,
    base_seed: input.base_seed,
    review_epoch: 0,
    slots: Array.from({ length: input.count }, (_, slot) => ({
      slot,
      state: "unattempted",
      revision: 0,
      effective_seed: imagegenEffectiveSeed(input.base_seed, slot),
      submitted_graph_ref: null,
      image_ref: null,
      validation_receipt_ref: null,
      operation_receipt_ref: null,
      disposition_receipt_ref: null,
      vera_report_ref: null,
      carren_report_ref: null,
      review_epoch: null,
      reason_code: null,
      lease_disposition: null,
      remote_may_continue: false,
    })),
  });
}

function replaceSlot(
  ledger: ImageSlotLedgerV1,
  slotNumber: number,
  replacement: ImageSlotRecordV1
): ImageSlotLedgerV1 {
  return validateImageSlotLedger({
    ...ledger,
    slots: ledger.slots.map((slot) => (slot.slot === slotNumber ? replacement : slot)),
  });
}

export interface ImageSlotGenerationTransitionV1 {
  readonly slot: number;
  readonly to: Exclude<ImageSlotStateV1, "under_review" | "critic_failed" | "accepted">;
  readonly submitted_graph_ref?: ArtifactRef;
  readonly image_ref?: ArtifactRef;
  readonly validation_receipt_ref?: ArtifactRef;
  readonly operation_receipt_ref?: ArtifactRef;
  readonly disposition_receipt_ref?: ArtifactRef;
  readonly reason_code?: string;
  readonly lease_disposition?: "released" | "quarantined";
  readonly remote_may_continue?: boolean;
}

export function transitionImageSlotGeneration(
  ledgerValue: ImageSlotLedgerV1,
  transition: ImageSlotGenerationTransitionV1
): ImageSlotLedgerV1 {
  const ledger = validateImageSlotLedger(ledgerValue);
  const current = ledger.slots[transition.slot];
  if (current === undefined) throw new Error("imagegen slot transition is outside the ledger");
  if (!GENERATION_TRANSITIONS[current.state].includes(transition.to)) {
    throw new Error(`illegal imagegen slot transition '${current.state}' -> '${transition.to}'`);
  }
  const repairing = current.state === "critic_failed" && transition.to === "prepared";
  const nextRevision = repairing ? current.revision + 1 : current.revision;
  if (nextRevision > IMAGEGEN_MAX_REVISION_ROUNDS) {
    throw new Error("imagegen slot semantic revision budget is exhausted");
  }
  const terminal = TERMINAL_OPERATIONAL_STATES.has(transition.to);
  const replacement: ImageSlotRecordV1 = {
    ...current,
    state: transition.to,
    revision: nextRevision,
    ...(transition.submitted_graph_ref === undefined
      ? {}
      : { submitted_graph_ref: transition.submitted_graph_ref }),
    ...(transition.image_ref === undefined ? {} : { image_ref: transition.image_ref }),
    ...(transition.validation_receipt_ref === undefined
      ? {}
      : { validation_receipt_ref: transition.validation_receipt_ref }),
    ...(transition.operation_receipt_ref === undefined
      ? {}
      : { operation_receipt_ref: transition.operation_receipt_ref }),
    disposition_receipt_ref: transition.disposition_receipt_ref ?? null,
    reason_code: transition.reason_code ?? null,
    lease_disposition: transition.lease_disposition ?? null,
    remote_may_continue: transition.remote_may_continue ?? false,
    vera_report_ref: null,
    carren_report_ref: null,
    review_epoch: null,
    ...(repairing
      ? {
          submitted_graph_ref: transition.submitted_graph_ref ?? null,
          image_ref: null,
          validation_receipt_ref: null,
          operation_receipt_ref: null,
        }
      : {}),
  };
  if (!terminal && transition.to !== "prepared" && transition.reason_code !== undefined) {
    throw new Error("nonterminal imagegen generation transition cannot carry a reason code");
  }
  return replaceSlot(ledger, transition.slot, replacement);
}

export function beginImageReviewEpoch(input: {
  readonly ledger: ImageSlotLedgerV1;
  readonly current_images: readonly ArtifactRef[];
}): ImageSlotLedgerV1 {
  const ledger = validateImageSlotLedger(input.ledger);
  if (!ledger.slots.every((slot) => slot.state === "reviewable" || slot.state === "accepted")) {
    throw new Error("imagegen review requires a complete current reviewable set");
  }
  const supplied = new Map(input.current_images.map((ref) => [ref.artifact_id, ref]));
  if (supplied.size !== input.current_images.length || supplied.size !== ledger.count) {
    throw new Error("imagegen review image set is incomplete or duplicated");
  }
  for (const slot of ledger.slots) {
    if (
      slot.image_ref === null ||
      !sameRef(supplied.get(slot.image_ref.artifact_id) ?? null, slot.image_ref)
    ) {
      throw new Error(
        `imagegen review image set does not contain slot ${slot.slot}'s exact current image`
      );
    }
  }
  const epoch = ledger.review_epoch + 1;
  return validateImageSlotLedger({
    ...ledger,
    review_epoch: epoch,
    slots: ledger.slots.map((slot) => ({
      ...slot,
      state: "under_review",
      review_epoch: epoch,
      vera_report_ref: null,
      carren_report_ref: null,
    })),
  });
}

export function completeImageReviewEpoch(input: {
  readonly ledger: ImageSlotLedgerV1;
  readonly vera_report_ref: ArtifactRef;
  readonly carren_report_ref: ArtifactRef;
  readonly failed_slots: readonly number[];
}): ImageSlotLedgerV1 {
  const ledger = validateImageSlotLedger(input.ledger);
  if (ledger.review_epoch < 1 || !ledger.slots.every((slot) => slot.state === "under_review")) {
    throw new Error("imagegen review completion requires every current slot under review");
  }
  const failed = new Set(input.failed_slots);
  if (
    failed.size !== input.failed_slots.length ||
    input.failed_slots.some((slot) => slot < 0 || slot >= ledger.count)
  ) {
    throw new Error("imagegen review failed-slot set is invalid");
  }
  return validateImageSlotLedger({
    ...ledger,
    slots: ledger.slots.map((slot) => ({
      ...slot,
      state: failed.has(slot.slot) ? "critic_failed" : "accepted",
      vera_report_ref: input.vera_report_ref,
      carren_report_ref: input.carren_report_ref,
    })),
  });
}

export function imageSlotLedgerPositivelyComplete(ledgerValue: ImageSlotLedgerV1): boolean {
  const ledger = validateImageSlotLedger(ledgerValue);
  return (
    ledger.review_epoch >= 1 &&
    ledger.slots.every(
      (slot) => slot.state === "accepted" && slot.review_epoch === ledger.review_epoch
    )
  );
}
