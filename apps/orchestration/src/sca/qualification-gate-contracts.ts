import { Type, type Static, type TSchema } from "typebox";

import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  assertRfc3339Utc,
  assertText,
} from "../skill-contracts/common.js";

const MAX_CRITERIA = 64;
const MAX_EVIDENCE_REFS = 64;
const MAX_INPUT_REFS = 1_024;
const MAX_GAPS = 256;
const MAX_GAP_BYTES = 4_096;

export const SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA = "penny.sca-phase-criterion-definition.v1";
export const SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA = "penny.sca-phase-reviewer-authority.v1";
export const SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA = "penny.sca-phase-review-receipt.v1";
export const SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA = "penny.sca-phase-qualification-record.v3";
export const SCA_PHASE_GATE_RECORD_V3_SCHEMA = "penny.sca-phase-gate-record.v3";

export const ScaImplementationAssuranceScopeSchema = Type.Union([
  Type.Literal("declaration_only"),
  Type.Literal("host_derived_binding"),
  Type.Literal("independent_attestation"),
]);
export type ScaImplementationAssuranceScope = Static<typeof ScaImplementationAssuranceScopeSchema>;

export const ScaQualificationEvidenceClassSchema = Type.Union([
  Type.Literal("live"),
  Type.Literal("synthetic"),
  Type.Literal("fixture"),
  Type.Literal("narrative"),
]);
export type ScaQualificationEvidenceClass = Static<typeof ScaQualificationEvidenceClassSchema>;

export const ScaQualificationCriterionStatusSchema = Type.Union([
  Type.Literal("PASS"),
  Type.Literal("FAIL"),
  Type.Literal("BLOCKED"),
]);
export type ScaQualificationCriterionStatus = Static<typeof ScaQualificationCriterionStatusSchema>;

const GapSchema = Type.String({ minLength: 1, maxLength: MAX_GAP_BYTES });

export const ScaPhaseCriterionDefinitionV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    implementation_revision: OpaqueIdSchema,
    required_assurance_scope: ScaImplementationAssuranceScopeSchema,
    criterion_id: OpaqueIdSchema,
    required_evidence_class: ScaQualificationEvidenceClassSchema,
    required_evidence_count: Type.Integer({ minimum: 1, maximum: MAX_EVIDENCE_REFS }),
    definition_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_PHASE_CRITERION_DEFINITION_V1_SCHEMA }
);
export type ScaPhaseCriterionDefinitionV1 = Readonly<
  Static<typeof ScaPhaseCriterionDefinitionV1Schema>
>;

const CriterionResultSchema = Type.Object(
  {
    criterion_id: OpaqueIdSchema,
    status: ScaQualificationCriterionStatusSchema,
  },
  { additionalProperties: false }
);

export const ScaPhaseReviewerAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    authority_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    implementation_revision: OpaqueIdSchema,
    implementation_assurance_scope: ScaImplementationAssuranceScopeSchema,
    reviewer_identity_id: OpaqueIdSchema,
    reviewer_lineage_id: OpaqueIdSchema,
    subject_sha256: Sha256Schema,
    evidence_refs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: MAX_CRITERIA * MAX_EVIDENCE_REFS,
    }),
    decision: Type.Union([Type.Literal("authorized"), Type.Literal("denied")]),
    issued_at: Rfc3339UtcSchema,
    authority_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA }
);
export type ScaPhaseReviewerAuthorityV1 = Readonly<
  Static<typeof ScaPhaseReviewerAuthorityV1Schema>
>;

export const ScaPhaseReviewReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    implementation_revision: OpaqueIdSchema,
    implementation_assurance_scope: ScaImplementationAssuranceScopeSchema,
    reviewer_authority_ref: ArtifactRefSchema,
    reviewer_identity_id: OpaqueIdSchema,
    reviewer_lineage_id: OpaqueIdSchema,
    subject_sha256: Sha256Schema,
    evidence_refs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: MAX_CRITERIA * MAX_EVIDENCE_REFS,
    }),
    criterion_results: Type.Array(CriterionResultSchema, {
      minItems: 1,
      maxItems: MAX_CRITERIA,
    }),
    decision: ScaQualificationCriterionStatusSchema,
    reviewed_at: Rfc3339UtcSchema,
    receipt_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA }
);
export type ScaPhaseReviewReceiptV1 = Readonly<Static<typeof ScaPhaseReviewReceiptV1Schema>>;

const QualificationCriterionSchema = Type.Object(
  {
    criterion_id: OpaqueIdSchema,
    definition_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: MAX_EVIDENCE_REFS,
    }),
    evidence_class: ScaQualificationEvidenceClassSchema,
    status: ScaQualificationCriterionStatusSchema,
  },
  { additionalProperties: false }
);

export const ScaPhaseQualificationRecordV3Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA),
    schema_version: Type.Literal(3),
    record_kind: Type.Literal("implementation_qualification"),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    implementation_revision: OpaqueIdSchema,
    implementation_assurance_scope: ScaImplementationAssuranceScopeSchema,
    implementation_identity_ref: ArtifactRefSchema,
    qualified_input_refs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: MAX_INPUT_REFS,
    }),
    implementer_identity_id: OpaqueIdSchema,
    implementer_lineage_id: OpaqueIdSchema,
    reviewer_authority_ref: ArtifactRefSchema,
    reviewer_receipt_ref: ArtifactRefSchema,
    criteria: Type.Array(QualificationCriterionSchema, {
      minItems: 1,
      maxItems: MAX_CRITERIA,
    }),
    remaining_gaps: Type.Array(GapSchema, { maxItems: MAX_GAPS }),
    status: ScaQualificationCriterionStatusSchema,
    recorded_at: Rfc3339UtcSchema,
    qualification_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA }
);
export type ScaPhaseQualificationRecordV3 = Readonly<
  Static<typeof ScaPhaseQualificationRecordV3Schema>
>;
export type ScaPhaseQualificationCriterionV3 = ScaPhaseQualificationRecordV3["criteria"][number];

export const ScaPhaseGateRecordV3Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PHASE_GATE_RECORD_V3_SCHEMA),
    schema_version: Type.Literal(3),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    implementation_revision: OpaqueIdSchema,
    implementation_assurance_scope: ScaImplementationAssuranceScopeSchema,
    implementation_identity_ref: ArtifactRefSchema,
    qualified_input_refs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: MAX_INPUT_REFS,
    }),
    qualification_ref: ArtifactRefSchema,
    reviewer_authority_ref: ArtifactRefSchema,
    reviewer_receipt_ref: ArtifactRefSchema,
    criterion_results: Type.Array(CriterionResultSchema, {
      minItems: 1,
      maxItems: MAX_CRITERIA,
    }),
    remaining_gaps: Type.Array(GapSchema, { maxItems: MAX_GAPS }),
    status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    evaluated_at: Rfc3339UtcSchema,
    gate_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_PHASE_GATE_RECORD_V3_SCHEMA }
);
export type ScaPhaseGateRecordV3 = Readonly<Static<typeof ScaPhaseGateRecordV3Schema>>;

export class ScaQualificationGateContractError extends Error {
  constructor(
    readonly code:
      | "invalid_contract"
      | "invalid_self_digest"
      | "invalid_ref_set"
      | "invalid_status",
    message: string
  ) {
    super(message);
    this.name = "ScaQualificationGateContractError";
  }
}

function fail(code: ScaQualificationGateContractError["code"], message: string): never {
  throw new ScaQualificationGateContractError(code, message);
}

function validateSchema<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string
): Static<Schema> {
  try {
    return validateContract(schema, value, label);
  } catch (error) {
    fail("invalid_contract", error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertCanonicalStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail("invalid_ref_set", `${label} must not contain duplicates`);
  }
  if (canonicalJson(values) !== canonicalJson([...values].sort(compareUtf8))) {
    fail("invalid_ref_set", `${label} must use canonical UTF-8 ordering`);
  }
}

function assertCanonicalRefs(refs: readonly ArtifactRef[], label: string): void {
  for (const [index, ref] of refs.entries()) {
    try {
      currentArtifactRef(ref, `${label}[${index}]`);
    } catch (error) {
      fail(
        "invalid_ref_set",
        error instanceof Error ? error.message : `${label}[${index}] is invalid`
      );
    }
  }
  assertCanonicalStrings(
    refs.map((ref) => ref.artifact_id),
    label
  );
}

function assertCriterionResults(
  results: readonly {
    readonly criterion_id: string;
    readonly status: ScaQualificationCriterionStatus;
  }[],
  label: string
): void {
  assertCanonicalStrings(
    results.map((result) => result.criterion_id),
    label
  );
}

function assertTimestamp(value: string, label: string): void {
  try {
    assertRfc3339Utc(value, label);
  } catch (error) {
    fail("invalid_contract", error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function assertGaps(values: readonly string[], label: string): void {
  for (const [index, value] of values.entries()) {
    try {
      assertText(value, `${label}[${index}]`, {
        minBytes: 1,
        maxBytes: MAX_GAP_BYTES,
        trimmedNonEmpty: true,
      });
    } catch (error) {
      fail(
        "invalid_contract",
        error instanceof Error ? error.message : `${label}[${index}] is invalid`
      );
    }
  }
  assertCanonicalStrings(values, label);
}

function assertSelfDigest(observed: string, unsigned: unknown, label: string): void {
  if (observed !== sha256(canonicalJson(unsigned))) {
    fail("invalid_self_digest", `${label} self-digest is stale`);
  }
}

export function deriveScaQualificationStatus(
  criterionResults: readonly {
    readonly status: ScaQualificationCriterionStatus;
  }[],
  remainingGaps: readonly string[]
): ScaQualificationCriterionStatus {
  if (remainingGaps.length > 0) return "BLOCKED";
  if (criterionResults.some((result) => result.status === "FAIL")) return "FAIL";
  if (criterionResults.some((result) => result.status === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

export function validateScaPhaseCriterionDefinitionV1(
  value: unknown
): ScaPhaseCriterionDefinitionV1 {
  const definition = validateSchema(
    ScaPhaseCriterionDefinitionV1Schema,
    value,
    "SCA phase criterion definition"
  );
  const { definition_sha256: observed, ...unsigned } = definition;
  assertSelfDigest(observed, unsigned, "criterion definition");
  return definition;
}

export function validateScaPhaseReviewerAuthorityV1(value: unknown): ScaPhaseReviewerAuthorityV1 {
  const authority = validateSchema(
    ScaPhaseReviewerAuthorityV1Schema,
    value,
    "SCA phase reviewer authority"
  );
  assertTimestamp(authority.issued_at, "reviewer authority issued_at");
  assertCanonicalRefs(authority.evidence_refs, "reviewer authority evidence_refs");
  const { authority_sha256: observed, ...unsigned } = authority;
  assertSelfDigest(observed, unsigned, "reviewer authority");
  return authority;
}

export function validateScaPhaseReviewReceiptV1(value: unknown): ScaPhaseReviewReceiptV1 {
  const receipt = validateSchema(ScaPhaseReviewReceiptV1Schema, value, "SCA phase review receipt");
  assertTimestamp(receipt.reviewed_at, "review receipt reviewed_at");
  assertCanonicalRefs(receipt.evidence_refs, "review receipt evidence_refs");
  assertCriterionResults(receipt.criterion_results, "review receipt criterion_results");
  const { receipt_sha256: observed, ...unsigned } = receipt;
  assertSelfDigest(observed, unsigned, "review receipt");
  return receipt;
}

/** Validate wire shape, canonical ordering, derived inline status, and self-digest only. */
export function validateScaPhaseQualificationRecordV3(
  value: unknown
): ScaPhaseQualificationRecordV3 {
  const record = validateSchema(
    ScaPhaseQualificationRecordV3Schema,
    value,
    "SCA phase qualification record v3"
  );
  assertTimestamp(record.recorded_at, "qualification recorded_at");
  assertCanonicalRefs(record.qualified_input_refs, "qualification qualified_input_refs");
  assertCanonicalStrings(
    record.criteria.map((criterion) => criterion.criterion_id),
    "qualification criteria"
  );
  const evidenceIds: string[] = [];
  for (const criterion of record.criteria) {
    try {
      currentArtifactRef(criterion.definition_ref, `${criterion.criterion_id}.definition_ref`);
    } catch (error) {
      fail(
        "invalid_ref_set",
        error instanceof Error
          ? error.message
          : `${criterion.criterion_id}.definition_ref is invalid`
      );
    }
    assertCanonicalRefs(criterion.evidence_refs, `${criterion.criterion_id}.evidence_refs`);
    evidenceIds.push(...criterion.evidence_refs.map((ref) => ref.artifact_id));
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    fail("invalid_ref_set", "qualification evidence refs must be distinct across criteria");
  }
  assertGaps(record.remaining_gaps, "qualification remaining_gaps");
  if (record.implementer_identity_id === record.implementer_lineage_id) {
    fail("invalid_contract", "implementer identity and lineage must be distinct");
  }
  if (record.status !== deriveScaQualificationStatus(record.criteria, record.remaining_gaps)) {
    fail("invalid_status", "qualification status is not derived from criteria and gaps");
  }
  const { qualification_sha256: observed, ...unsigned } = record;
  assertSelfDigest(observed, unsigned, "qualification");
  return record;
}

/** Validate wire shape and self-consistency only; use verifyScaPhaseGateV3 before trusting PASS. */
export function validateScaPhaseGateRecordV3(value: unknown): ScaPhaseGateRecordV3 {
  const gate = validateSchema(ScaPhaseGateRecordV3Schema, value, "SCA phase gate record v3");
  assertTimestamp(gate.evaluated_at, "gate evaluated_at");
  assertCanonicalRefs(gate.qualified_input_refs, "gate qualified_input_refs");
  assertCriterionResults(gate.criterion_results, "gate criterion_results");
  assertGaps(gate.remaining_gaps, "gate remaining_gaps");
  const expectedStatus =
    deriveScaQualificationStatus(gate.criterion_results, gate.remaining_gaps) === "PASS"
      ? "passed"
      : "blocked";
  if (gate.status !== expectedStatus) {
    fail("invalid_status", "gate status is not derived from criteria and gaps");
  }
  const { gate_sha256: observed, ...unsigned } = gate;
  assertSelfDigest(observed, unsigned, "gate");
  return gate;
}

export function sealScaPhaseCriterionDefinitionV1(
  unsigned: Omit<ScaPhaseCriterionDefinitionV1, "definition_sha256">
): ScaPhaseCriterionDefinitionV1 {
  return validateScaPhaseCriterionDefinitionV1({
    ...unsigned,
    definition_sha256: sha256(canonicalJson(unsigned)),
  });
}

export function sealScaPhaseReviewerAuthorityV1(
  unsigned: Omit<ScaPhaseReviewerAuthorityV1, "authority_sha256">
): ScaPhaseReviewerAuthorityV1 {
  return validateScaPhaseReviewerAuthorityV1({
    ...unsigned,
    authority_sha256: sha256(canonicalJson(unsigned)),
  });
}

export function sealScaPhaseReviewReceiptV1(
  unsigned: Omit<ScaPhaseReviewReceiptV1, "receipt_sha256">
): ScaPhaseReviewReceiptV1 {
  return validateScaPhaseReviewReceiptV1({
    ...unsigned,
    receipt_sha256: sha256(canonicalJson(unsigned)),
  });
}

export function sealScaPhaseQualificationRecordV3(
  unsigned: Omit<ScaPhaseQualificationRecordV3, "qualification_sha256">
): ScaPhaseQualificationRecordV3 {
  return validateScaPhaseQualificationRecordV3({
    ...unsigned,
    qualification_sha256: sha256(canonicalJson(unsigned)),
  });
}

export function sealScaPhaseGateRecordV3(
  unsigned: Omit<ScaPhaseGateRecordV3, "gate_sha256">
): ScaPhaseGateRecordV3 {
  return validateScaPhaseGateRecordV3({
    ...unsigned,
    gate_sha256: sha256(canonicalJson(unsigned)),
  });
}
