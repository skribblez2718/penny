import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { ArtifactRefSchema } from "../contracts.js";
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
    domain: Type.Union([Type.Literal("decision"), Type.Literal("strategy")]),
    origin_state: Type.Union([
      Type.Literal("analyzing_decision"),
      Type.Literal("orienting_strategy"),
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
  const decision = admission.domain === "decision";
  const expectedOrigin = decision ? "analyzing_decision" : "orienting_strategy";
  const gapClassification = decision
    ? "decision_sensitive_evidence_gap"
    : "strategy_blocking_evidence_gap";
  if (
    admission.origin_state !== expectedOrigin ||
    admission.source_artifact_ref.phase !== expectedOrigin ||
    admission.source_artifact_ref.kind !== "agent-output" ||
    admission.classification ===
      (decision ? "strategy_blocking_evidence_gap" : "decision_sensitive_evidence_gap") ||
    admission.evidence_required !== (admission.classification === gapClassification)
  ) {
    throw new Error("EvidenceAdmissionV1 domain, source, classification, or route disagrees");
  }
  assertUnique(admission.source_execution_receipt_ids, "EvidenceAdmissionV1 execution receipt IDs");
  const { admission_id: admissionId, ...body } = admission;
  assertDerivedId(admissionId, "eadm_", sha256(canonicalJson(body)), "EvidenceAdmissionV1");
  return admission;
}
