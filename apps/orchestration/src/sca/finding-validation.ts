import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Sha256Schema } from "../skill-contracts/common.js";
import { ScaFindingSetV1Schema, validateScaFindingSetV1 } from "./findings.js";

const MAX_ITEMS = 100_000;
const MAX_TEXT = 8_192;

export const SCA_FINDING_VALIDATION_RESULT_SCHEMA = "penny.sca-finding-validation-result.v1";
export const SCA_M3_PROOF_INPUT_SCHEMA = "penny.sca-m3-proof-input.v1";
export const SCA_M3_MANIFEST_SCHEMA = "penny.sca-m3-manifest.v1";

export const ScaFindingValidationResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_FINDING_VALIDATION_RESULT_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    finding_set_sha256: Sha256Schema,
    finding_id: Type.String({ pattern: "^scafind_[a-f0-9]{64}$" }),
    finding_sha256: Sha256Schema,
    validator_profile_id: Type.Literal("critic"),
    model_admission_sha256: Sha256Schema,
    independent_context_sha256: Sha256Schema,
    verdict: Type.Union([
      Type.Literal("validated"),
      Type.Literal("rejected"),
      Type.Literal("inconclusive"),
    ]),
    checks: Type.Object(
      {
        evidence_sufficient: Type.Boolean(),
        reachability_supported: Type.Boolean(),
        severity_supported: Type.Boolean(),
        remediation_actionable: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
    rationale: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    gaps: Type.Array(Type.String({ minLength: 1, maxLength: MAX_TEXT }), {
      maxItems: MAX_ITEMS,
    }),
    result_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

const ScaGapDispositionV1Schema = Type.Object(
  {
    gap_id: Type.String({ pattern: "^scagap_[a-f0-9]{64}$" }),
    subject_id: Type.String({ minLength: 1, maxLength: 512 }),
    disposition: Type.Union([
      Type.Literal("requires_stronger_evidence"),
      Type.Literal("accepted_limitation"),
      Type.Literal("resolved"),
    ]),
    rationale: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
    evidence_sha256: Type.Union([Sha256Schema, Type.Null()]),
  },
  { additionalProperties: false }
);

export const ScaM3ProofInputV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M3_PROOF_INPUT_SCHEMA),
    schema_version: Type.Literal(1),
    finding_set: ScaFindingSetV1Schema,
    validations: Type.Array(ScaFindingValidationResultV1Schema, { maxItems: MAX_ITEMS }),
    gap_dispositions: Type.Array(ScaGapDispositionV1Schema, { maxItems: MAX_ITEMS }),
  },
  { additionalProperties: false }
);

const ScaM3BlockerV1Schema = Type.Object(
  {
    code: Type.Union([
      Type.Literal("finding_set_blocked"),
      Type.Literal("missing_validation"),
      Type.Literal("duplicate_validation"),
      Type.Literal("validation_binding_mismatch"),
      Type.Literal("finding_not_validated"),
      Type.Literal("missing_gap_disposition"),
      Type.Literal("duplicate_gap_disposition"),
      Type.Literal("invalid_gap_disposition"),
    ]),
    subject_id: Type.String({ minLength: 1, maxLength: 512 }),
    detail: Type.String({ minLength: 1, maxLength: MAX_TEXT }),
  },
  { additionalProperties: false }
);

export const ScaM3ManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_M3_MANIFEST_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source_snapshot_sha256: Sha256Schema,
    finding_set_sha256: Sha256Schema,
    milestone: Type.Literal("M3_FULL_ANALYSIS"),
    release_eligible: Type.Literal(false),
    stronger_execution_authorized: Type.Literal(false),
    status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")]),
    validated_finding_ids: Type.Array(Type.String({ pattern: "^scafind_[a-f0-9]{64}$" }), {
      maxItems: MAX_ITEMS,
    }),
    validation_result_sha256s: Type.Array(Sha256Schema, { maxItems: MAX_ITEMS }),
    gap_dispositions: Type.Array(ScaGapDispositionV1Schema, { maxItems: MAX_ITEMS }),
    accepted_limitation_count: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
    stronger_evidence_gap_count: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
    blockers: Type.Array(ScaM3BlockerV1Schema, { maxItems: MAX_ITEMS }),
    manifest_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export type ScaFindingValidationResultV1 = Static<typeof ScaFindingValidationResultV1Schema>;
export type ScaM3ProofInputV1 = Static<typeof ScaM3ProofInputV1Schema>;
export type ScaM3ManifestV1 = Static<typeof ScaM3ManifestV1Schema>;
type UnsignedValidation = Omit<ScaFindingValidationResultV1, "result_sha256">;
type UnsignedM3 = Omit<ScaM3ManifestV1, "manifest_sha256">;
type M3Blocker = ScaM3ManifestV1["blockers"][number];

export class ScaFindingValidationError extends Error {
  constructor(
    readonly code:
      | "invalid_validation"
      | "validation_digest_mismatch"
      | "invalid_m3_input"
      | "m3_manifest_digest_mismatch",
    message: string
  ) {
    super(message);
    this.name = "ScaFindingValidationError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validationDigest(value: UnsignedValidation): string {
  return sha256(canonicalJson(value));
}

function m3Digest(value: UnsignedM3): string {
  return sha256(canonicalJson(value));
}

export function scaCandidateGapId(candidateId: string): string {
  return `scagap_${sha256(canonicalJson({ kind: "candidate", candidate_id: candidateId }))}`;
}

export function scaFindingGapId(findingId: string, gap: string): string {
  return `scagap_${sha256(canonicalJson({ kind: "finding", finding_id: findingId, gap }))}`;
}

export function sealScaFindingValidationResultV1(
  value: Omit<ScaFindingValidationResultV1, "result_sha256">
): ScaFindingValidationResultV1 {
  let input: UnsignedValidation;
  try {
    input = validateContract(
      Type.Omit(ScaFindingValidationResultV1Schema, ["result_sha256"]),
      value,
      "SCA finding validation result input"
    );
  } catch (error) {
    throw new ScaFindingValidationError(
      "invalid_validation",
      error instanceof Error ? error.message : "SCA finding validation result is invalid"
    );
  }
  const allChecksPass = Object.values(input.checks).every((check) => check);
  if (
    (input.verdict === "validated" && (!allChecksPass || input.gaps.length !== 0)) ||
    (input.verdict !== "validated" && input.gaps.length === 0)
  ) {
    throw new ScaFindingValidationError(
      "invalid_validation",
      "SCA finding validation verdict, checks, and gaps are inconsistent"
    );
  }
  return validateContract(
    ScaFindingValidationResultV1Schema,
    { ...input, result_sha256: validationDigest(input) },
    "SCA finding validation result"
  );
}

export function validateScaFindingValidationResultV1(value: unknown): ScaFindingValidationResultV1 {
  const result = validateContract(
    ScaFindingValidationResultV1Schema,
    value,
    "SCA finding validation result"
  );
  const { result_sha256: observedDigest, ...unsigned } = result;
  if (validationDigest(unsigned) !== observedDigest) {
    throw new ScaFindingValidationError(
      "validation_digest_mismatch",
      "SCA finding validation result digest mismatch"
    );
  }
  return result;
}

function addBlocker(
  blockers: M3Blocker[],
  code: M3Blocker["code"],
  subjectId: string,
  detail: string
): void {
  blockers.push({ code, subject_id: subjectId, detail });
}

export function buildScaM3ManifestV1(value: unknown): ScaM3ManifestV1 {
  let input: ScaM3ProofInputV1;
  try {
    input = validateContract(ScaM3ProofInputV1Schema, value, "SCA M3 proof input");
  } catch (error) {
    throw new ScaFindingValidationError(
      "invalid_m3_input",
      error instanceof Error ? error.message : "SCA M3 proof input is invalid"
    );
  }
  const findingSet = validateScaFindingSetV1(input.finding_set);
  const validations = input.validations.map((validation) =>
    validateScaFindingValidationResultV1(validation)
  );
  const blockers: M3Blocker[] = [];
  if (findingSet.status !== "derived") {
    addBlocker(
      blockers,
      "finding_set_blocked",
      findingSet.finding_set_sha256,
      "Finding set is blocked"
    );
  }
  const validationByFinding = new Map<string, ScaFindingValidationResultV1>();
  for (const validation of validations) {
    if (validationByFinding.has(validation.finding_id)) {
      addBlocker(
        blockers,
        "duplicate_validation",
        validation.finding_id,
        "Finding has more than one validation result"
      );
      continue;
    }
    validationByFinding.set(validation.finding_id, validation);
  }
  const validatedFindingIds: string[] = [];
  for (const finding of findingSet.findings) {
    const validation = validationByFinding.get(finding.finding_id);
    if (validation === undefined) {
      addBlocker(blockers, "missing_validation", finding.finding_id, "Finding lacks validation");
      continue;
    }
    if (
      validation.tenant_id !== findingSet.tenant_id ||
      validation.project_id !== findingSet.project_id ||
      validation.run_id !== findingSet.run_id ||
      validation.source_snapshot_sha256 !== findingSet.source_snapshot_sha256 ||
      validation.finding_set_sha256 !== findingSet.finding_set_sha256 ||
      validation.finding_sha256 !== finding.finding_sha256
    ) {
      addBlocker(
        blockers,
        "validation_binding_mismatch",
        finding.finding_id,
        "Finding validation binding differs"
      );
      continue;
    }
    if (validation.verdict !== "validated") {
      addBlocker(
        blockers,
        "finding_not_validated",
        finding.finding_id,
        `Finding validation verdict is ${validation.verdict}`
      );
      continue;
    }
    validatedFindingIds.push(finding.finding_id);
  }

  const expectedGaps = new Map<string, string>();
  for (const candidateId of findingSet.unresolved_candidate_ids) {
    expectedGaps.set(scaCandidateGapId(candidateId), candidateId);
  }
  for (const finding of findingSet.findings) {
    for (const gap of finding.analysis_gaps) {
      expectedGaps.set(scaFindingGapId(finding.finding_id, gap), finding.finding_id);
    }
  }
  const gapById = new Map<string, ScaM3ProofInputV1["gap_dispositions"][number]>();
  for (const disposition of input.gap_dispositions) {
    if (gapById.has(disposition.gap_id)) {
      addBlocker(
        blockers,
        "duplicate_gap_disposition",
        disposition.gap_id,
        "Gap has more than one disposition"
      );
      continue;
    }
    gapById.set(disposition.gap_id, disposition);
    const expectedSubject = expectedGaps.get(disposition.gap_id);
    if (
      expectedSubject === undefined ||
      expectedSubject !== disposition.subject_id ||
      (disposition.disposition === "resolved") !== (disposition.evidence_sha256 !== null)
    ) {
      addBlocker(
        blockers,
        "invalid_gap_disposition",
        disposition.gap_id,
        "Gap disposition does not match an expected gap or its evidence rule"
      );
    }
  }
  for (const [gapId, subjectId] of expectedGaps) {
    if (!gapById.has(gapId)) {
      addBlocker(
        blockers,
        "missing_gap_disposition",
        subjectId,
        `Missing disposition for ${gapId}`
      );
    }
  }

  const orderedGaps = [...input.gap_dispositions].sort((left, right) =>
    compareUtf8(left.gap_id, right.gap_id)
  );
  const unsigned: UnsignedM3 = {
    schema_id: SCA_M3_MANIFEST_SCHEMA,
    schema_version: 1,
    tenant_id: findingSet.tenant_id,
    project_id: findingSet.project_id,
    run_id: findingSet.run_id,
    source_snapshot_sha256: findingSet.source_snapshot_sha256,
    finding_set_sha256: findingSet.finding_set_sha256,
    milestone: "M3_FULL_ANALYSIS",
    release_eligible: false,
    stronger_execution_authorized: false,
    status: blockers.length === 0 ? "passed" : "blocked",
    validated_finding_ids: validatedFindingIds.sort(compareUtf8),
    validation_result_sha256s: validations
      .map((validation) => validation.result_sha256)
      .sort(compareUtf8),
    gap_dispositions: orderedGaps,
    accepted_limitation_count: orderedGaps.filter(
      (gap) => gap.disposition === "accepted_limitation"
    ).length,
    stronger_evidence_gap_count: orderedGaps.filter(
      (gap) => gap.disposition === "requires_stronger_evidence"
    ).length,
    blockers,
  };
  return validateContract(
    ScaM3ManifestV1Schema,
    { ...unsigned, manifest_sha256: m3Digest(unsigned) },
    "SCA M3 manifest"
  );
}

export function validateScaM3ManifestV1(value: unknown): ScaM3ManifestV1 {
  const manifest = validateContract(ScaM3ManifestV1Schema, value, "SCA M3 manifest");
  const { manifest_sha256: observedDigest, ...unsigned } = manifest;
  if (m3Digest(unsigned) !== observedDigest) {
    throw new ScaFindingValidationError(
      "m3_manifest_digest_mismatch",
      "SCA M3 manifest digest mismatch"
    );
  }
  return manifest;
}
