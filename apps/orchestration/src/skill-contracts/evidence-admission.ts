import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import {
  OpaqueIdSchema,
  Sha256Schema,
  assertDerivedId,
  assertUnique,
  validateSkillSchema,
} from "./common.js";

export const EvidenceAdmissionV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evidence-admission.v1"),
    schema_version: Type.Literal(1),
    admission_id: Type.String({ pattern: "^eadm_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    domain: Type.Union([
      Type.Literal("decision"),
      Type.Literal("strategy"),
      Type.Literal("specification"),
    ]),
    origin_state: Type.Union([
      Type.Literal("analyzing_decision"),
      Type.Literal("orienting_strategy"),
      Type.Literal("framing_definition"),
    ]),
    source_artifact_ref: ArtifactRefSchema,
    routing_result_sha256: Sha256Schema,
    source_execution_receipt_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
    classification: Type.Union([
      Type.Literal("basis_sufficient"),
      Type.Literal("decision_sensitive_evidence_gap"),
      Type.Literal("strategy_blocking_evidence_gap"),
      Type.Literal("specification_blocking_evidence_gap"),
    ]),
    evidence_required: Type.Boolean(),
    minted_by: Type.Literal("host:evidence-gate"),
  },
  { additionalProperties: false }
);
export type EvidenceAdmissionV1 = Readonly<Static<typeof EvidenceAdmissionV1Schema>>;

export function evidenceAdmissionId(
  body: Omit<EvidenceAdmissionV1, "admission_id">
): `eadm_${string}` {
  return `eadm_${sha256(canonicalJson(body))}`;
}

export function validateEvidenceAdmission(value: unknown): EvidenceAdmissionV1 {
  const admission = validateSkillSchema(EvidenceAdmissionV1Schema, value, "EvidenceAdmissionV1");
  const expected =
    admission.domain === "decision"
      ? {
          origin: "analyzing_decision" as const,
          gap: "decision_sensitive_evidence_gap" as const,
        }
      : admission.domain === "strategy"
        ? {
            origin: "orienting_strategy" as const,
            gap: "strategy_blocking_evidence_gap" as const,
          }
        : {
            origin: "framing_definition" as const,
            gap: "specification_blocking_evidence_gap" as const,
          };
  if (
    admission.origin_state !== expected.origin ||
    admission.source_artifact_ref.phase !== expected.origin ||
    admission.source_artifact_ref.kind !== "agent-output" ||
    (admission.classification !== "basis_sufficient" &&
      admission.classification !== expected.gap) ||
    admission.evidence_required !== (admission.classification === expected.gap)
  ) {
    throw new Error("EvidenceAdmissionV1 domain, source, classification, or route disagrees");
  }
  assertUnique(admission.source_execution_receipt_ids, "EvidenceAdmissionV1 execution receipt IDs");
  const { admission_id: admissionId, ...body } = admission;
  assertDerivedId(admissionId, "eadm_", sha256(canonicalJson(body)), "EvidenceAdmissionV1");
  return admission;
}

/** Define-only admission. A slot authorizes a declared use, not the truth of a claim. */
const DefinitionAllowedUseV1Schema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("request_uncertainty"),
      source_item_index: Type.Integer({ minimum: 0, maximum: 127 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("discovered_question"), question_id: OpaqueIdSchema },
    { additionalProperties: false }
  ),
  Type.Object(
    { kind: Type.Literal("standard_category"), category: OpaqueIdSchema },
    { additionalProperties: false }
  ),
]);
export type DefinitionAllowedUseV1 = Readonly<Static<typeof DefinitionAllowedUseV1Schema>>;
const DefinitionSupportSlotV1Schema = Type.Object(
  {
    ref: ArtifactRefSchema,
    role: Type.Union([
      Type.Literal("caller_response"),
      Type.Literal("native_evidence"),
      Type.Literal("imported_evidence"),
    ]),
    allowed_uses: Type.Array(DefinitionAllowedUseV1Schema, { minItems: 1, maxItems: 128 }),
    challenge_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type DefinitionSupportSlotV1 = Readonly<Static<typeof DefinitionSupportSlotV1Schema>>;
export const EvidenceAdmissionV2Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.evidence-admission.v2"),
    schema_version: Type.Literal(2),
    admission_id: Type.String({ pattern: "^eadm_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    domain: Type.Literal("specification"),
    origin_state: Type.Literal("framing_definition"),
    source_artifact_ref: ArtifactRefSchema,
    frame_ref: ArtifactRefSchema,
    routing_result_sha256: Sha256Schema,
    source_execution_receipt_ids: Type.Array(OpaqueIdSchema, {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
    classification: Type.Union([
      Type.Literal("basis_sufficient"),
      Type.Literal("specification_blocking_evidence_gap"),
    ]),
    evidence_required: Type.Boolean(),
    support_slots: Type.Array(DefinitionSupportSlotV1Schema, { maxItems: 69 }),
    minted_by: Type.Literal("host:evidence-gate"),
  },
  { additionalProperties: false }
);
export type EvidenceAdmissionV2 = Readonly<Static<typeof EvidenceAdmissionV2Schema>>;

export function evidenceAdmissionV2Id(
  body: Omit<EvidenceAdmissionV2, "admission_id">
): `eadm_${string}` {
  return `eadm_${sha256(canonicalJson(body))}`;
}

export function validateEvidenceAdmissionV2(value: unknown): EvidenceAdmissionV2 {
  const admission = validateSkillSchema(EvidenceAdmissionV2Schema, value, "EvidenceAdmissionV2");
  if (
    admission.source_artifact_ref.phase !== "framing_definition" ||
    admission.source_artifact_ref.kind !== "agent-output" ||
    admission.source_artifact_ref.run_id !== admission.run_id ||
    admission.frame_ref.kind !== "definition-frame" ||
    admission.frame_ref.content_schema?.schema_id !== "penny.definition-frame.v2" ||
    admission.frame_ref.run_id !== admission.run_id ||
    admission.evidence_required !==
      (admission.classification === "specification_blocking_evidence_gap")
  ) {
    throw new Error("EvidenceAdmissionV2 frame, route, or source binding disagrees");
  }
  assertUnique(admission.source_execution_receipt_ids, "EvidenceAdmissionV2 execution receipts");
  assertUnique(
    admission.support_slots.map((slot) => slot.ref.artifact_id),
    "EvidenceAdmissionV2 slot refs"
  );
  for (const slot of admission.support_slots) {
    if (slot.ref.run_id !== admission.run_id && slot.role !== "imported_evidence") {
      throw new Error("EvidenceAdmissionV2 support ref has a foreign run");
    }
    if (
      (slot.role === "native_evidence" &&
        (slot.ref.kind !== "agent-output" ||
          slot.ref.phase !== "gathering_definition_evidence" ||
          !admission.evidence_required)) ||
      (slot.role === "imported_evidence" &&
        slot.ref.run_id === admission.run_id &&
        slot.ref.kind !== "semantic-core" &&
        slot.ref.kind !== "specification") ||
      (slot.role === "caller_response") !== (slot.challenge_ref !== null) ||
      (slot.role === "caller_response" &&
        (slot.ref.kind !== "definition-clarification-response" ||
          slot.challenge_ref?.kind !== "definition-clarification-challenge" ||
          slot.allowed_uses.some((use) => use.kind === "standard_category")))
    ) {
      throw new Error("EvidenceAdmissionV2 caller response role or use is invalid");
    }
    assertUnique(
      slot.allowed_uses.map((use) => canonicalJson(use)),
      "EvidenceAdmissionV2 allowed uses"
    );
  }
  const { admission_id: id, ...body } = admission;
  assertDerivedId(id, "eadm_", sha256(canonicalJson(body)), "EvidenceAdmissionV2");
  return admission;
}

/** A selector cannot widen a slot by repeating a compatible-looking but different target. */
export function assertDefinitionAllowedUse(
  slot: DefinitionSupportSlotV1,
  use: DefinitionAllowedUseV1
): ArtifactRef {
  if (!slot.allowed_uses.some((item) => canonicalJson(item) === canonicalJson(use))) {
    throw new Error("Define support selector is not admitted for this target");
  }
  return slot.ref;
}
