import { Type, type Static, type TSchema } from "typebox";

import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import { ArtifactRefSchema, validateContract, type ArtifactRef } from "../contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  assertOpaqueId,
  assertRfc3339Utc,
  assertText,
} from "../skill-contracts/common.js";
import {
  SCA_P01_MODEL_ALIAS,
  SCA_P01_MODEL_ID,
  SCA_P01_MODEL_PROVIDER,
} from "./p01-policy-contracts.js";

const MAX_REFS = 1_024;
const MAX_TEXT_BYTES = 4_096;
const MAX_EMBEDDED_CONTENT_BYTES = 4 * 1_048_576;
const MAX_SCOPE_PATH_BYTES = 4_096;
export const SCA_P01_MAX_SCOPE_ITEMS = 10_000;
const MAX_SCOPE_ITEMS = SCA_P01_MAX_SCOPE_ITEMS;
const MAX_FRAMEWORKS = 128;
const MAX_OBLIGATIONS = 512;
const ZERO_SHA256 = "0".repeat(64);

export const SCA_P01_ADMISSION_REQUEST_V3_SCHEMA = "penny.sca-admission-request.v3";
export const SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA = "penny.sca-campaign-source-snapshot.v2";
export const SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA = "penny.sca-p01-source-file-manifest.v1";
export const SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA = "penny.sca-p01-source-custody-corpus.v1";
export const SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA =
  "penny.sca-p01-variant-capture-manifest.v1";
export const SCA_SOURCE_PROVENANCE_V1_SCHEMA = "penny.sca-source-provenance.v1";
export const SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA = "penny.sca-p01-qualification-profile.v1";
export const SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA = "penny.sca-implementation-identity.v1";
export const SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA =
  "penny.sca-p01-implementation-source-bundle.v1";
export const SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA =
  "penny.sca-p01-implementation-build-bundle.v1";
export const SCA_QUALIFICATION_FIXTURE_V1_SCHEMA = "penny.sca-qualification-fixture.v1";
export const SCA_P01_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA =
  "penny.sca-p01-qualification-fixture-content.v1";
export const SCA_QUALIFICATION_LOG_V1_SCHEMA = "penny.sca-qualification-log.v1";
export const SCA_P01_QUALIFICATION_LOG_CONTENT_V1_SCHEMA =
  "penny.sca-p01-qualification-log-content.v1";
export const SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA = "penny.sca-host-boundary-receipt.v1";
export const SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA = "penny.sca-qualification-evidence.v1";
export const SCA_REVIEWER_AUTHORITY_V1_SCHEMA = "penny.sca-reviewer-authority.v1";
export const SCA_REVIEW_RECEIPT_V1_SCHEMA = "penny.sca-review-receipt.v1";
export const SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA = "penny.sca-phase-qualification-record.v2";
export const SCA_OBLIGATION_REVISION_OPERATION_V1_SCHEMA =
  "penny.sca-obligation-revision-operation.v1";
export const SCA_OBLIGATION_LEDGER_V2_SCHEMA = "penny.sca-obligation-ledger.v2";
export const SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA = "penny.sca-campaign-manifest-core.v1";
export const SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA = "penny.sca-p01-admission-evidence.v1";
export const SCA_PHASE_GATE_RECORD_V2_SCHEMA = "penny.sca-phase-gate-record.v2";
export const SCA_CAMPAIGN_MANIFEST_V2_SCHEMA = "penny.sca-campaign-manifest.v2";

export const SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS = Object.freeze({
  source: "host:source-custody",
  qualification_profile: "host:sca-qualification-authority",
  implementation: "host:sca-qualification-authority",
  implementation_source: "host:sca-implementation-source-custody",
  implementation_build: "host:sca-implementation-build-custody",
  fixture: "host:sca-qualification-fixture-authority",
  fixture_content: "host:sca-qualification-fixture-custody",
  evidence: "host:sca-qualification-runner",
  log: "host:sca-qualification-runner",
  log_content: "host:sca-qualification-log-custody",
  boundary_receipt: "host:sca-qualification-runner",
  reviewer_authority: "host:sca-review-authority",
  review_receipt: "host:sca-review-authority",
  qualification: "host:sca-qualification-authority",
} as const);

export const SCA_PHASE_IDS = Object.freeze([
  "SCA-P01",
  "SCA-P02",
  "SCA-P03",
  "SCA-P04",
  "SCA-P05",
  "SCA-P06",
  "SCA-P07",
  "SCA-P08",
  "SCA-P09",
  "SCA-P10",
  "SCA-P11",
  "SCA-P12",
] as const);

export const SCA_P01_REQUIRED_CRITERION_IDS = Object.freeze([
  "AC-P01.request-and-semantic-policy-validation",
  "AC-P01.trusted-qualification-and-review",
  "AC-P01.obligation-and-manifest-binding",
  "AC-P01.cancellation-recovery-and-zero-dispatch",
] as const);

export const SCA_P01_QUALIFICATION_VARIANT_IDS = Object.freeze([
  "normal",
  "negative",
  "recovery",
  "cancellation",
  "interruption-replay",
  "fixed-safe",
  "no-alert",
  "unsupported",
  "failure",
  "denial",
  "truncation",
] as const);

const ScaPhaseIdSchema = Type.Union([
  Type.Literal("SCA-P01"),
  Type.Literal("SCA-P02"),
  Type.Literal("SCA-P03"),
  Type.Literal("SCA-P04"),
  Type.Literal("SCA-P05"),
  Type.Literal("SCA-P06"),
  Type.Literal("SCA-P07"),
  Type.Literal("SCA-P08"),
  Type.Literal("SCA-P09"),
  Type.Literal("SCA-P10"),
  Type.Literal("SCA-P11"),
  Type.Literal("SCA-P12"),
]);
const ScaLanguageSchema = Type.Union([
  Type.Literal("php"),
  Type.Literal("javascript"),
  Type.Literal("typescript"),
]);
const ScaQualificationStatusSchema = Type.Union([
  Type.Literal("PASS"),
  Type.Literal("FAIL"),
  Type.Literal("BLOCKED"),
  Type.Literal("NOT RUN"),
]);
const ScaQualificationVariantIdSchema = Type.Union(
  SCA_P01_QUALIFICATION_VARIANT_IDS.map((value) => Type.Literal(value))
);
const BoundedTextSchema = Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES });
const ObligationIdSchema = Type.String({ pattern: "^SCA-OBL-[A-Z0-9-]{2,96}$" });
const ScaSourceScopeV2Schema = Type.Object(
  {
    include_paths: Type.Array(Type.String({ minLength: 1, maxLength: MAX_SCOPE_PATH_BYTES }), {
      minItems: 1,
      maxItems: MAX_SCOPE_ITEMS,
    }),
    exclude_paths: Type.Array(Type.String({ minLength: 1, maxLength: MAX_SCOPE_PATH_BYTES }), {
      maxItems: MAX_SCOPE_ITEMS,
    }),
  },
  { additionalProperties: false }
);

type ScaSourceScopeV2 = Readonly<Static<typeof ScaSourceScopeV2Schema>>;

const ScaSourceFileIdentityV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_SCOPE_PATH_BYTES }),
    byte_count: Type.Integer({ minimum: 0, maximum: 1_099_511_627_776 }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaP01SourceFileManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    snapshot_id: OpaqueIdSchema,
    scope: ScaSourceScopeV2Schema,
    files: Type.Array(ScaSourceFileIdentityV1Schema, {
      minItems: 1,
      maxItems: MAX_SCOPE_ITEMS,
    }),
    file_count: Type.Integer({ minimum: 1, maximum: MAX_SCOPE_ITEMS }),
    byte_count: Type.Integer({ minimum: 0, maximum: 1_099_511_627_776 }),
    tree_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA }
);
export type ScaP01SourceFileManifestV1 = Readonly<Static<typeof ScaP01SourceFileManifestV1Schema>>;

const ScaSourceCustodyFileV1Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_SCOPE_PATH_BYTES }),
    encoding: Type.Literal("base64"),
    content_base64: Type.String({ maxLength: MAX_EMBEDDED_CONTENT_BYTES }),
    byte_count: Type.Integer({ minimum: 0, maximum: 1_099_511_627_776 }),
    content_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);

export const ScaP01SourceCustodyCorpusV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA),
    schema_version: Type.Literal(1),
    custody_id: OpaqueIdSchema,
    snapshot_id: OpaqueIdSchema,
    file_manifest_ref: ArtifactRefSchema,
    files: Type.Array(ScaSourceCustodyFileV1Schema, {
      minItems: 1,
      maxItems: MAX_SCOPE_ITEMS,
    }),
    file_count: Type.Integer({ minimum: 1, maximum: MAX_SCOPE_ITEMS }),
    byte_count: Type.Integer({ minimum: 0, maximum: 1_099_511_627_776 }),
    tree_sha256: Sha256Schema,
    sealed: Type.Literal(true),
  },
  { additionalProperties: false, $id: SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA }
);
export type ScaP01SourceCustodyCorpusV1 = Readonly<
  Static<typeof ScaP01SourceCustodyCorpusV1Schema>
>;

export const ScaCampaignSourceSnapshotV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA),
    schema_version: Type.Literal(2),
    snapshot_id: OpaqueIdSchema,
    tree_sha256: Sha256Schema,
    file_manifest_ref: ArtifactRefSchema,
    file_manifest_sha256: Sha256Schema,
    custody_ref: ArtifactRefSchema,
    custody_sha256: Sha256Schema,
    scope: ScaSourceScopeV2Schema,
    file_count: Type.Integer({ minimum: 1, maximum: MAX_SCOPE_ITEMS }),
    byte_count: Type.Integer({ minimum: 0, maximum: 1_099_511_627_776 }),
    status: Type.Literal("frozen"),
  },
  { additionalProperties: false, $id: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA }
);
export type ScaCampaignSourceSnapshotV2 = Readonly<
  Static<typeof ScaCampaignSourceSnapshotV2Schema>
>;

export const ScaSourceProvenanceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_SOURCE_PROVENANCE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    snapshot_ref: ArtifactRefSchema,
    file_manifest_ref: ArtifactRefSchema,
    custody_ref: ArtifactRefSchema,
    custody_sha256: Sha256Schema,
    capture_method: Type.Literal("host-frozen"),
    custody_status: Type.Literal("verified"),
  },
  { additionalProperties: false, $id: SCA_SOURCE_PROVENANCE_V1_SCHEMA }
);
export type ScaSourceProvenanceV1 = Readonly<Static<typeof ScaSourceProvenanceV1Schema>>;

/** Capture only: labels are caller supplied; this grants no execution or qualification. */
export const ScaP01VariantCaptureManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    implementation_revision: OpaqueIdSchema,
    baseline_snapshot_ref: ArtifactRefSchema,
    baseline_provenance_ref: ArtifactRefSchema,
    entries: Type.Array(
      Type.Object(
        {
          label: OpaqueIdSchema,
          snapshot_ref: ArtifactRefSchema,
          file_manifest_ref: ArtifactRefSchema,
          custody_ref: ArtifactRefSchema,
          provenance_ref: ArtifactRefSchema,
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 128 }
    ),
  },
  { additionalProperties: false, $id: SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA }
);
export type ScaP01VariantCaptureManifestV1 = Readonly<
  Static<typeof ScaP01VariantCaptureManifestV1Schema>
>;

const ScaRuntimeCognitionIdentitySchema = Type.Object(
  {
    alias: Type.Literal(SCA_P01_MODEL_ALIAS),
    provider: Type.Literal(SCA_P01_MODEL_PROVIDER),
    model: Type.Literal(SCA_P01_MODEL_ID),
  },
  { additionalProperties: false }
);
const ScaFrameworkProfileSchema = Type.Object(
  { framework_id: OpaqueIdSchema, language: ScaLanguageSchema },
  { additionalProperties: false }
);
const ScaAdmissionAuthoritiesSchema = Type.Object(
  {
    execution_authority_id: OpaqueIdSchema,
    release_authority_id: OpaqueIdSchema,
    promotion_authority_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);

export const ScaP01AdmissionRequestV3Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P01_ADMISSION_REQUEST_V3_SCHEMA),
    schema_version: Type.Literal(3),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    source: Type.Object(
      {
        snapshot_ref: ArtifactRefSchema,
        provenance_ref: ArtifactRefSchema,
        variant_capture_manifest_ref: Type.Optional(ArtifactRefSchema),
      },
      { additionalProperties: false }
    ),
    scope: ScaSourceScopeV2Schema,
    analysis_profile: Type.Object(
      {
        profile_id: OpaqueIdSchema,
        profile_ref: ArtifactRefSchema,
        languages: Type.Array(ScaLanguageSchema, { minItems: 1, maxItems: 3 }),
        frameworks: Type.Array(ScaFrameworkProfileSchema, { maxItems: MAX_FRAMEWORKS }),
      },
      { additionalProperties: false }
    ),
    rule_release_ref: ArtifactRefSchema,
    rule_profile_ref: ArtifactRefSchema,
    toolchain_ref: ArtifactRefSchema,
    network_policy_ref: ArtifactRefSchema,
    privacy_policy_ref: ArtifactRefSchema,
    model_data_policy_ref: ArtifactRefSchema,
    resource_policy_ref: ArtifactRefSchema,
    output_policy_ref: ArtifactRefSchema,
    authority_policy_ref: ArtifactRefSchema,
    p01_qualification_ref: ArtifactRefSchema,
    implementation_revision: OpaqueIdSchema,
    runtime_cognition: ScaRuntimeCognitionIdentitySchema,
    report_namespace: OpaqueIdSchema,
    requested_at: Rfc3339UtcSchema,
    authorities: ScaAdmissionAuthoritiesSchema,
  },
  { additionalProperties: false, $id: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA }
);
export type ScaP01AdmissionRequestV3 = Readonly<Static<typeof ScaP01AdmissionRequestV3Schema>>;

export const ScaP01QualificationProfileV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    profile_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P01"),
    trust_status: Type.Literal("host-issued"),
    implementation_revision: OpaqueIdSchema,
    criterion_ids: Type.Array(Type.String({ minLength: 6, maxLength: 128 }), {
      minItems: 4,
      maxItems: 4,
    }),
    variant_ids: Type.Array(ScaQualificationVariantIdSchema, {
      minItems: 11,
      maxItems: 11,
    }),
  },
  { additionalProperties: false, $id: SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA }
);
export type ScaP01QualificationProfileV1 = Readonly<
  Static<typeof ScaP01QualificationProfileV1Schema>
>;

export const ScaImplementationIdentityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    implementation_revision: OpaqueIdSchema,
    source_ref: ArtifactRefSchema,
    source_sha256: Sha256Schema,
    build_ref: ArtifactRefSchema,
    build_sha256: Sha256Schema,
    build_identity: OpaqueIdSchema,
    status: Type.Literal("frozen"),
  },
  { additionalProperties: false, $id: SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA }
);
export type ScaImplementationIdentityV1 = Readonly<
  Static<typeof ScaImplementationIdentityV1Schema>
>;

export const ScaQualificationFixtureV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_QUALIFICATION_FIXTURE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    fixture_id: OpaqueIdSchema,
    criterion_id: Type.String({ minLength: 6, maxLength: 128 }),
    variant_id: ScaQualificationVariantIdSchema,
    fixture_content_ref: ArtifactRefSchema,
    fixture_sha256: Sha256Schema,
    status: Type.Literal("frozen"),
  },
  { additionalProperties: false, $id: SCA_QUALIFICATION_FIXTURE_V1_SCHEMA }
);
export type ScaQualificationFixtureV1 = Readonly<Static<typeof ScaQualificationFixtureV1Schema>>;

export const ScaQualificationLogV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_QUALIFICATION_LOG_V1_SCHEMA),
    schema_version: Type.Literal(1),
    log_id: OpaqueIdSchema,
    job_id: OpaqueIdSchema,
    criterion_id: Type.String({ minLength: 6, maxLength: 128 }),
    variant_id: ScaQualificationVariantIdSchema,
    log_content_ref: ArtifactRefSchema,
    log_sha256: Sha256Schema,
    truncated: Type.Boolean(),
  },
  { additionalProperties: false, $id: SCA_QUALIFICATION_LOG_V1_SCHEMA }
);
export type ScaQualificationLogV1 = Readonly<Static<typeof ScaQualificationLogV1Schema>>;

// Optional in the legacy V1 wire contract; formal V2 issuance requires all three.
export const ScaP01QualificationDispatchV1Schema = Type.Object(
  {
    baseline: Type.Object(
      {
        model: Type.Integer({ minimum: 0 }),
        scanner: Type.Integer({ minimum: 0 }),
        application: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false }
    ),
    final: Type.Object(
      {
        model: Type.Integer({ minimum: 0 }),
        scanner: Type.Integer({ minimum: 0 }),
        application: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false }
    ),
    delta: Type.Object(
      {
        model: Type.Integer({ minimum: 0 }),
        scanner: Type.Integer({ minimum: 0 }),
        application: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type ScaP01QualificationDispatchV1 = Readonly<
  Static<typeof ScaP01QualificationDispatchV1Schema>
>;

export function validateScaP01QualificationDispatchV1(
  value: unknown
): ScaP01QualificationDispatchV1 {
  const measurement = validateSchema(
    ScaP01QualificationDispatchV1Schema,
    value,
    "P01 dispatch measurement",
    "invalid_qualification"
  );
  for (const channel of ["model", "scanner", "application"] as const) {
    if (
      !Number.isSafeInteger(measurement.baseline[channel]) ||
      !Number.isSafeInteger(measurement.final[channel]) ||
      !Number.isSafeInteger(measurement.delta[channel]) ||
      measurement.final[channel] - measurement.baseline[channel] !== measurement.delta[channel]
    )
      fail("invalid_qualification", `invalid ${channel} dispatch measurement`);
  }
  return measurement;
}

export const ScaHostBoundaryReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    boundary: Type.Literal("orchestration-host-artifact-boundary"),
    operation_kind: Type.Literal("sca-p01-candidate-admission"),
    job_id: OpaqueIdSchema,
    attempt: Type.Integer({ minimum: 1, maximum: 1_000 }),
    implementation_revision: OpaqueIdSchema,
    configuration_sha256: Sha256Schema,
    command_sha256: Sha256Schema,
    execution_lineage_id: OpaqueIdSchema,
    implementation_ref: ArtifactRefSchema,
    implementation_source_ref: ArtifactRefSchema,
    implementation_build_ref: ArtifactRefSchema,
    fixture_ref: ArtifactRefSchema,
    fixture_content_ref: ArtifactRefSchema,
    log_ref: ArtifactRefSchema,
    log_content_ref: ArtifactRefSchema,
    expected_result_sha256: Sha256Schema,
    observed_result_sha256: Sha256Schema,
    terminal_status: ScaQualificationStatusSchema,
    dispatch_measurement: Type.Optional(ScaP01QualificationDispatchV1Schema),
  },
  { additionalProperties: false, $id: SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA }
);
export type ScaHostBoundaryReceiptV1 = Readonly<Static<typeof ScaHostBoundaryReceiptV1Schema>>;

export const ScaQualificationEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    evidence_id: OpaqueIdSchema,
    qualification_run_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P01"),
    criterion_id: Type.String({ minLength: 6, maxLength: 128 }),
    variant_id: ScaQualificationVariantIdSchema,
    implementation_revision: OpaqueIdSchema,
    implementation_ref: ArtifactRefSchema,
    qualification_profile_ref: ArtifactRefSchema,
    fixture_ref: ArtifactRefSchema,
    fixture_content_ref: ArtifactRefSchema,
    applicability: Type.Literal("applicable"),
    applicability_rationale: Type.Null(),
    command_id: OpaqueIdSchema,
    job_id: OpaqueIdSchema,
    execution_lineage_id: OpaqueIdSchema,
    configuration_sha256: Sha256Schema,
    expected_result: BoundedTextSchema,
    expected_result_sha256: Sha256Schema,
    observed_result: BoundedTextSchema,
    observed_result_sha256: Sha256Schema,
    result: ScaQualificationStatusSchema,
    log_ref: ArtifactRefSchema,
    log_content_ref: ArtifactRefSchema,
    boundary_receipt_ref: ArtifactRefSchema,
    dispatch_measurement: Type.Optional(ScaP01QualificationDispatchV1Schema),
  },
  { additionalProperties: false, $id: SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA }
);
export type ScaQualificationEvidenceV1 = Readonly<Static<typeof ScaQualificationEvidenceV1Schema>>;

export const ScaReviewerAuthorityV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_REVIEWER_AUTHORITY_V1_SCHEMA),
    schema_version: Type.Literal(1),
    authority_id: OpaqueIdSchema,
    reviewer_identity_id: OpaqueIdSchema,
    reviewer_lineage_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P01"),
    implementation_revision: OpaqueIdSchema,
    decision: Type.Union([Type.Literal("authorized"), Type.Literal("denied")]),
  },
  { additionalProperties: false, $id: SCA_REVIEWER_AUTHORITY_V1_SCHEMA }
);
export type ScaReviewerAuthorityV1 = Readonly<Static<typeof ScaReviewerAuthorityV1Schema>>;

export const ScaReviewReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_REVIEW_RECEIPT_V1_SCHEMA),
    schema_version: Type.Literal(1),
    receipt_id: OpaqueIdSchema,
    reviewer_authority_ref: ArtifactRefSchema,
    reviewer_identity_id: OpaqueIdSchema,
    reviewer_lineage_id: OpaqueIdSchema,
    qualification_profile_ref: ArtifactRefSchema,
    implementation_revision: OpaqueIdSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: MAX_REFS }),
    decision: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL"), Type.Literal("BLOCKED")]),
    reviewed_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false, $id: SCA_REVIEW_RECEIPT_V1_SCHEMA }
);
export type ScaReviewReceiptV1 = Readonly<Static<typeof ScaReviewReceiptV1Schema>>;

const ScaQualificationVariantResultV2Schema = Type.Object(
  {
    variant_id: ScaQualificationVariantIdSchema,
    fixture_ref: ArtifactRefSchema,
    evidence_ref: ArtifactRefSchema,
    applicability: Type.Literal("applicable"),
    status: ScaQualificationStatusSchema,
  },
  { additionalProperties: false }
);
const ScaQualificationCriterionV2Schema = Type.Object(
  {
    criterion_id: Type.String({ minLength: 6, maxLength: 128 }),
    status: ScaQualificationStatusSchema,
    variants: Type.Array(ScaQualificationVariantResultV2Schema, {
      minItems: 11,
      maxItems: 11,
    }),
  },
  { additionalProperties: false }
);

export const ScaPhaseQualificationRecordV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA),
    schema_version: Type.Literal(2),
    record_kind: Type.Literal("implementation_qualification"),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P01"),
    implementation_revision: OpaqueIdSchema,
    qualification_profile_ref: ArtifactRefSchema,
    source_snapshot_ref: ArtifactRefSchema,
    implementation_ref: ArtifactRefSchema,
    implementer_identity_id: OpaqueIdSchema,
    implementer_lineage_id: OpaqueIdSchema,
    reviewer_authority_ref: ArtifactRefSchema,
    reviewer_receipt_ref: ArtifactRefSchema,
    criteria: Type.Array(ScaQualificationCriterionV2Schema, { minItems: 4, maxItems: 4 }),
    remaining_gaps: Type.Array(BoundedTextSchema, { maxItems: 128 }),
    status: ScaQualificationStatusSchema,
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false, $id: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA }
);
export type ScaPhaseQualificationRecordV2 = Readonly<
  Static<typeof ScaPhaseQualificationRecordV2Schema>
>;
export type ScaQualificationCriterionV2 = ScaPhaseQualificationRecordV2["criteria"][number];
export type ScaQualificationVariantV2 = ScaQualificationCriterionV2["variants"][number];

const ScaObligationClassSchema = Type.Union([
  Type.Literal("required-result"),
  Type.Literal("attempt-and-report"),
  Type.Literal("optional"),
]);
const ScaObligationScopeSchema = Type.Union([
  Type.Literal("phase"),
  Type.Literal("phase-output"),
  Type.Literal("milestone"),
  Type.Literal("boundary"),
  Type.Literal("report-output"),
  Type.Literal("exploratory"),
]);
const ScaObligationDispositionSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("satisfied"),
  Type.Literal("blocked"),
  Type.Literal("no-rule"),
  Type.Literal("attempted"),
  Type.Literal("denied"),
  Type.Literal("unavailable"),
  Type.Literal("not-needed"),
  Type.Literal("omitted"),
  Type.Literal("promoted"),
]);
const ScaSourceMandateSchema = Type.Object(
  {
    mandate_kind: Type.Union([
      Type.Literal("specification"),
      Type.Literal("profile"),
      Type.Literal("policy"),
      Type.Literal("discovery"),
    ]),
    requirement_id: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false }
);

export const ScaObligationEntryV2Schema = Type.Object(
  {
    obligation_id: ObligationIdSchema,
    revision: Type.Integer({ minimum: 1, maximum: 1_000 }),
    revision_kind: Type.Union([Type.Literal("registered"), Type.Literal("promoted")]),
    obligation_class: ScaObligationClassSchema,
    effective_class: ScaObligationClassSchema,
    precedence: Type.Integer({ minimum: 1, maximum: 3 }),
    purpose: BoundedTextSchema,
    source_mandate: ScaSourceMandateSchema,
    assigning_authority_id: OpaqueIdSchema,
    policy_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 16 }),
    rationale: BoundedTextSchema,
    supporting_evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: MAX_REFS }),
    scope: ScaObligationScopeSchema,
    semantic_phase_id: Type.Union([ScaPhaseIdSchema, Type.Literal("M1"), Type.Null()]),
    predecessor_ids: Type.Array(ObligationIdSchema, { maxItems: 64 }),
    allowed_dispositions: Type.Array(ScaObligationDispositionSchema, {
      minItems: 1,
      maxItems: 16,
    }),
    completion_effect: Type.Union([
      Type.Literal("required-for-campaign"),
      Type.Literal("nonterminal"),
      Type.Literal("none"),
    ]),
    status: Type.Literal("pending"),
    prior_entry_sha256: Type.Union([Sha256Schema, Type.Null()]),
    entry_sha256: Sha256Schema,
    occurred_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ScaObligationEntryV2 = Readonly<Static<typeof ScaObligationEntryV2Schema>>;

const ScaObligationEventV2Schema = Type.Object(
  {
    event_id: Type.String({ pattern: "^scaoble_[a-f0-9]{64}$" }),
    sequence: Type.Integer({ minimum: 1, maximum: 10_000 }),
    operation_id: OpaqueIdSchema,
    operation_sha256: Sha256Schema,
    event_type: Type.Union([Type.Literal("registered"), Type.Literal("promoted")]),
    obligation_id: ObligationIdSchema,
    entry_revision: Type.Integer({ minimum: 1, maximum: 1_000 }),
    entry_sha256: Sha256Schema,
    prior_event_sha256: Sha256Schema,
    event_sha256: Sha256Schema,
    occurred_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);

export const ScaObligationLedgerV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_OBLIGATION_LEDGER_V2_SCHEMA),
    schema_version: Type.Literal(2),
    ledger_id: Type.String({ pattern: "^scaobl_[a-f0-9]{64}$" }),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    version: Type.Integer({ minimum: 1, maximum: 1_000 }),
    prior_ledger_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    prior_ledger_sha256: Type.Union([Sha256Schema, Type.Null()]),
    append_only: Type.Literal(true),
    campaign_completion_claimed: Type.Literal(false),
    entries: Type.Array(ScaObligationEntryV2Schema, { minItems: 1, maxItems: MAX_OBLIGATIONS }),
    events: Type.Array(ScaObligationEventV2Schema, { minItems: 1, maxItems: MAX_OBLIGATIONS }),
    created_at: Rfc3339UtcSchema,
    ledger_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_OBLIGATION_LEDGER_V2_SCHEMA }
);
export type ScaObligationLedgerV2 = Readonly<Static<typeof ScaObligationLedgerV2Schema>>;

const ScaObligationRevisionCommon = {
  schema_id: Type.Literal(SCA_OBLIGATION_REVISION_OPERATION_V1_SCHEMA),
  schema_version: Type.Literal(1),
  operation_id: OpaqueIdSchema,
  obligation_id: ObligationIdSchema,
  requested_class: ScaObligationClassSchema,
  discovery_evidence_ref: ArtifactRefSchema,
  assigning_authority_id: OpaqueIdSchema,
  policy_refs: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 16 }),
  rationale: BoundedTextSchema,
  scope_decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  authority_decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  resource_policy_decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  material: Type.Boolean(),
  action_started: Type.Literal(false),
  occurred_at: Rfc3339UtcSchema,
} as const;

export const ScaObligationRevisionOperationV1Schema = Type.Union(
  [
    Type.Object(
      {
        ...ScaObligationRevisionCommon,
        action: Type.Literal("register"),
        purpose: BoundedTextSchema,
        source_mandate: ScaSourceMandateSchema,
        supporting_evidence_refs: Type.Array(ArtifactRefSchema, {
          minItems: 1,
          maxItems: MAX_REFS,
        }),
        scope: ScaObligationScopeSchema,
        semantic_phase_id: Type.Union([ScaPhaseIdSchema, Type.Literal("M1"), Type.Null()]),
        predecessor_ids: Type.Array(ObligationIdSchema, { maxItems: 64 }),
        allowed_dispositions: Type.Array(ScaObligationDispositionSchema, {
          minItems: 1,
          maxItems: 16,
        }),
        completion_effect: Type.Union([
          Type.Literal("required-for-campaign"),
          Type.Literal("nonterminal"),
          Type.Literal("none"),
        ]),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        ...ScaObligationRevisionCommon,
        action: Type.Literal("promote"),
        supporting_evidence_refs: Type.Array(ArtifactRefSchema, {
          minItems: 1,
          maxItems: MAX_REFS,
        }),
      },
      { additionalProperties: false }
    ),
  ],
  { $id: SCA_OBLIGATION_REVISION_OPERATION_V1_SCHEMA }
);
export type ScaObligationRevisionOperationV1 = Readonly<
  Static<typeof ScaObligationRevisionOperationV1Schema>
>;

const ScaFrozenRefsV1Schema = Type.Object(
  {
    source_snapshot_ref: ArtifactRefSchema,
    source_file_manifest_ref: ArtifactRefSchema,
    source_custody_ref: ArtifactRefSchema,
    source_provenance_ref: ArtifactRefSchema,
    variant_capture_manifest_ref: Type.Optional(ArtifactRefSchema),
    analysis_profile_ref: ArtifactRefSchema,
    rule_release_ref: ArtifactRefSchema,
    rule_bundle_ref: ArtifactRefSchema,
    rule_profile_ref: ArtifactRefSchema,
    selected_rule_manifest_ref: ArtifactRefSchema,
    toolchain_ref: ArtifactRefSchema,
    tool_executable_refs: Type.Array(ArtifactRefSchema, { minItems: 2, maxItems: 128 }),
    tool_measurement_receipt_refs: Type.Array(ArtifactRefSchema, {
      minItems: 2,
      maxItems: 128,
    }),
    network_policy_ref: ArtifactRefSchema,
    privacy_policy_ref: ArtifactRefSchema,
    model_data_policy_ref: ArtifactRefSchema,
    resource_policy_ref: ArtifactRefSchema,
    output_policy_ref: ArtifactRefSchema,
    authority_policy_ref: ArtifactRefSchema,
    p01_qualification_ref: ArtifactRefSchema,
    qualification_source_file_manifest_ref: ArtifactRefSchema,
    qualification_source_custody_ref: ArtifactRefSchema,
    implementation_source_ref: ArtifactRefSchema,
    implementation_build_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);

export const ScaCampaignManifestCoreV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    request_ref: ArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    implementation_revision: OpaqueIdSchema,
    runtime_cognition: ScaRuntimeCognitionIdentitySchema,
    report_namespace: OpaqueIdSchema,
    authorities: ScaAdmissionAuthoritiesSchema,
    frozen_refs: ScaFrozenRefsV1Schema,
    status: Type.Literal("pending_gate"),
    sca_completion_claimed: Type.Literal(false),
    binding_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA }
);
export type ScaCampaignManifestCoreV1 = Readonly<Static<typeof ScaCampaignManifestCoreV1Schema>>;

const ScaAdmissionCheckV1Schema = Type.Object(
  {
    check_id: Type.Union([
      Type.Literal("artifact-bindings"),
      Type.Literal("semantic-policies"),
      Type.Literal("trusted-qualification"),
      Type.Literal("zero-dispatch"),
    ]),
    status: Type.Literal("PASS"),
  },
  { additionalProperties: false }
);

export const ScaP01AdmissionEvidenceV1Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    request_ref: ArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    manifest_core_ref: ArtifactRefSchema,
    qualification_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: MAX_REFS }),
    checks: Type.Array(ScaAdmissionCheckV1Schema, { minItems: 4, maxItems: 4 }),
    dispatch_delta: Type.Object(
      {
        model: Type.Literal(0),
        scanner: Type.Literal(0),
        application: Type.Literal(0),
      },
      { additionalProperties: false }
    ),
    status: Type.Literal("passed"),
    evaluated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false, $id: SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA }
);
export type ScaP01AdmissionEvidenceV1 = Readonly<Static<typeof ScaP01AdmissionEvidenceV1Schema>>;

export const ScaPhaseGateRecordV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_PHASE_GATE_RECORD_V2_SCHEMA),
    schema_version: Type.Literal(2),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: Type.Literal("SCA-P01"),
    implementation_revision: OpaqueIdSchema,
    request_ref: ArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    manifest_core_ref: ArtifactRefSchema,
    qualification_ref: ArtifactRefSchema,
    admission_evidence_ref: ArtifactRefSchema,
    criterion_results: Type.Array(
      Type.Object(
        {
          criterion_id: Type.String({ minLength: 6, maxLength: 128 }),
          status: Type.Literal("PASS"),
        },
        { additionalProperties: false }
      ),
      { minItems: 4, maxItems: 4 }
    ),
    status: Type.Literal("passed"),
    evaluated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false, $id: SCA_PHASE_GATE_RECORD_V2_SCHEMA }
);
export type ScaPhaseGateRecordV2 = Readonly<Static<typeof ScaPhaseGateRecordV2Schema>>;

export const ScaCampaignManifestV2Schema = Type.Object(
  {
    schema_id: Type.Literal(SCA_CAMPAIGN_MANIFEST_V2_SCHEMA),
    schema_version: Type.Literal(2),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    manifest_core_ref: ArtifactRefSchema,
    p01_gate_ref: ArtifactRefSchema,
    request_ref: ArtifactRefSchema,
    obligation_ledger_ref: ArtifactRefSchema,
    authority_policy_ref: ArtifactRefSchema,
    admitted_phase_id: Type.Literal("SCA-P01"),
    m1_status: Type.Literal("not_reached"),
    campaign_status: Type.Literal("admitted"),
    sca_completion_claimed: Type.Literal(false),
    admitted_at: Rfc3339UtcSchema,
    admission_binding_sha256: Sha256Schema,
  },
  { additionalProperties: false, $id: SCA_CAMPAIGN_MANIFEST_V2_SCHEMA }
);
export type ScaCampaignManifestV2 = Readonly<Static<typeof ScaCampaignManifestV2Schema>>;

export class ScaP01ContractError extends Error {
  constructor(
    readonly code:
      | "invalid_contract"
      | "invalid_identity"
      | "invalid_scope"
      | "wrong_model_identity"
      | "ambiguous_authority"
      | "invalid_qualification"
      | "invalid_reviewer"
      | "invalid_obligation_ledger"
      | "obligation_policy_denied"
      | "obligation_conflict"
      | "invalid_manifest_binding",
    message: string
  ) {
    super(message);
    this.name = "ScaP01ContractError";
  }
}

function fail(code: ScaP01ContractError["code"], message: string): never {
  throw new ScaP01ContractError(code, message);
}

function validateSchema<Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  label: string,
  code: ScaP01ContractError["code"]
): Static<Schema> {
  try {
    return validateContract(schema, value, label);
  } catch (error) {
    fail(code, error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalRef(value: ArtifactRef, label: string): ArtifactRef {
  try {
    return currentArtifactRef(value, label);
  } catch (error) {
    fail("invalid_contract", error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function safeId(value: string, label: string): void {
  try {
    assertOpaqueId(value, label);
  } catch (error) {
    fail("invalid_identity", error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function safeTime(value: string, label: string): void {
  try {
    assertRfc3339Utc(value, label);
  } catch (error) {
    fail("invalid_contract", error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function assertCanonicalUnique(
  values: readonly string[],
  label: string,
  code: ScaP01ContractError["code"]
): void {
  if (new Set(values).size !== values.length) fail(code, `${label} must be unique`);
  if (canonicalJson([...values].sort(compareUtf8)) !== canonicalJson(values)) {
    fail(code, `${label} must use canonical UTF-8 ordering`);
  }
}

function sortedRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const existing = byId.get(ref.artifact_id);
    if (existing !== undefined && !sameRef(existing, ref)) {
      fail("invalid_contract", `artifact '${ref.artifact_id}' has contradictory representations`);
    }
    byId.set(ref.artifact_id, ref);
  }
  return [...byId.values()].sort((left, right) => compareUtf8(left.artifact_id, right.artifact_id));
}

function assertRefArray(
  refs: readonly ArtifactRef[],
  label: string,
  expectedRunId: string | null
): void {
  for (const [index, ref] of refs.entries()) {
    canonicalRef(ref, `${label}[${index}]`);
    if (expectedRunId !== null && ref.run_id !== expectedRunId) {
      fail("invalid_contract", `${label}[${index}] belongs to another run`);
    }
  }
  assertCanonicalUnique(
    refs.map((ref) => ref.artifact_id),
    label,
    "invalid_contract"
  );
}

function canonicalScopePath(value: string, label: string): void {
  try {
    assertText(value, label, { minBytes: 1, maxBytes: MAX_SCOPE_PATH_BYTES });
  } catch (error) {
    fail("invalid_scope", error instanceof Error ? error.message : `${label} is invalid`);
  }
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("invalid_scope", `${label} must be a canonical repository-relative path`);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateSourceScope(scope: ScaSourceScopeV2, label: string): void {
  for (const [pathLabel, paths] of [
    [`${label}.include_paths`, scope.include_paths],
    [`${label}.exclude_paths`, scope.exclude_paths],
  ] as const) {
    for (const [index, valuePath] of paths.entries())
      canonicalScopePath(valuePath, `${pathLabel}[${index}]`);
    assertCanonicalUnique(paths, pathLabel, "invalid_scope");
    for (const [index, left] of paths.entries()) {
      for (const right of paths.slice(index + 1)) {
        if (pathsOverlap(left, right)) {
          fail("invalid_scope", `${pathLabel} contains overlapping paths`);
        }
      }
    }
  }
  for (const excluded of scope.exclude_paths) {
    if (!scope.include_paths.some((included) => excluded.startsWith(`${included}/`))) {
      fail("invalid_scope", `each ${label} exclusion must be a strict descendant of an include`);
    }
  }
}

export function scaP01AdmissionRequestRefs(
  request: ScaP01AdmissionRequestV3
): readonly ArtifactRef[] {
  return [
    request.source.snapshot_ref,
    request.source.provenance_ref,
    ...(request.source.variant_capture_manifest_ref === undefined
      ? []
      : [request.source.variant_capture_manifest_ref]),
    request.analysis_profile.profile_ref,
    request.rule_release_ref,
    request.rule_profile_ref,
    request.toolchain_ref,
    request.network_policy_ref,
    request.privacy_policy_ref,
    request.model_data_policy_ref,
    request.resource_policy_ref,
    request.output_policy_ref,
    request.authority_policy_ref,
    request.p01_qualification_ref,
  ];
}

export function validateScaP01AdmissionRequestV3(value: unknown): ScaP01AdmissionRequestV3 {
  const request = validateSchema(
    ScaP01AdmissionRequestV3Schema,
    value,
    "SCA P01 admission request",
    "invalid_contract"
  );
  for (const [label, id] of [
    ["tenant_id", request.tenant_id],
    ["project_id", request.project_id],
    ["run_id", request.run_id],
    ["analysis_profile.profile_id", request.analysis_profile.profile_id],
    ["implementation_revision", request.implementation_revision],
    ["report_namespace", request.report_namespace],
  ] as const)
    safeId(id, label);
  safeTime(request.requested_at, "request.requested_at");

  validateSourceScope(request.scope, "scope");

  if (
    request.runtime_cognition.alias !== SCA_P01_MODEL_ALIAS ||
    request.runtime_cognition.provider !== SCA_P01_MODEL_PROVIDER ||
    request.runtime_cognition.model !== SCA_P01_MODEL_ID
  ) {
    fail("wrong_model_identity", "runtime cognition does not match fixed SCA model identity");
  }
  const authorityIds = [
    request.authorities.execution_authority_id,
    request.authorities.promotion_authority_id,
    request.authorities.release_authority_id,
  ].map((id) => id.toLowerCase());
  if (new Set(authorityIds).size !== authorityIds.length) {
    fail("ambiguous_authority", "execution, promotion, and release authorities must be distinct");
  }
  if (
    request.source.snapshot_ref.run_id !== request.run_id ||
    request.source.provenance_ref.run_id !== request.run_id ||
    (request.source.variant_capture_manifest_ref !== undefined &&
      request.source.variant_capture_manifest_ref.run_id !== request.run_id)
  ) {
    fail("invalid_contract", "campaign source refs must belong to the campaign run");
  }
  const refs = scaP01AdmissionRequestRefs(request);
  for (const [index, ref] of refs.entries()) canonicalRef(ref, `request ref ${index}`);
  if (new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length) {
    fail("invalid_contract", "request artifact roles must use distinct refs");
  }
  return request;
}

export function scaP01VariantCaptureManifestRefs(
  manifest: ScaP01VariantCaptureManifestV1
): readonly ArtifactRef[] {
  return sortedRefs([
    manifest.baseline_snapshot_ref,
    manifest.baseline_provenance_ref,
    ...manifest.entries.flatMap((entry) => [
      entry.snapshot_ref,
      entry.file_manifest_ref,
      entry.custody_ref,
      entry.provenance_ref,
    ]),
  ]);
}

export function validateScaP01VariantCaptureManifestV1(
  value: unknown
): ScaP01VariantCaptureManifestV1 {
  const manifest = validateSchema(
    ScaP01VariantCaptureManifestV1Schema,
    value,
    "P01 variant capture manifest",
    "invalid_contract"
  );
  for (const id of [
    manifest.tenant_id,
    manifest.project_id,
    manifest.run_id,
    manifest.implementation_revision,
  ])
    safeId(id, "variant capture identity");
  assertCanonicalUnique(
    manifest.entries.map((entry) => entry.label),
    "variant labels",
    "invalid_contract"
  );
  for (const entry of manifest.entries) {
    safeId(entry.label, "variant label");
    const refs = [
      entry.snapshot_ref,
      entry.file_manifest_ref,
      entry.custody_ref,
      entry.provenance_ref,
    ];
    if (refs.some((ref) => ref.run_id !== entry.snapshot_ref.run_id))
      fail("invalid_contract", "variant quartet belongs to different runs");
  }
  const refs = scaP01VariantCaptureManifestRefs(manifest);
  // No role sharing, contradictory representation, or baseline substitution across entries.
  if (
    refs.length !== 2 + manifest.entries.length * 4 ||
    manifest.baseline_snapshot_ref.run_id !== manifest.run_id ||
    manifest.baseline_provenance_ref.run_id !== manifest.run_id
  ) {
    fail(
      "invalid_contract",
      "variant capture roles must be distinct and baseline must belong to campaign"
    );
  }
  for (const ref of refs) canonicalRef(ref, "variant capture ref");
  return manifest;
}

export function scaP01SourceTreeDigest(
  files: readonly {
    readonly path: string;
    readonly byte_count: number;
    readonly content_sha256: string;
  }[]
): string {
  return sha256(
    canonicalJson(
      files.map((file) => ({
        path: file.path,
        byte_count: file.byte_count,
        content_sha256: file.content_sha256,
      }))
    )
  );
}

function pathIsInScope(path: string, scope: ScaSourceScopeV2): boolean {
  const included = scope.include_paths.some(
    (candidate) => path === candidate || path.startsWith(`${candidate}/`)
  );
  const excluded = scope.exclude_paths.some(
    (candidate) => path === candidate || path.startsWith(`${candidate}/`)
  );
  return included && !excluded;
}

function validateSourceFileIdentities(
  files: readonly {
    readonly path: string;
    readonly byte_count: number;
    readonly content_sha256: string;
  }[],
  scope: ScaSourceScopeV2,
  label: string
): void {
  for (const [index, file] of files.entries()) {
    canonicalScopePath(file.path, `${label}[${index}].path`);
    if (!pathIsInScope(file.path, scope)) {
      fail("invalid_scope", `${label}[${index}].path is outside the exact source scope`);
    }
  }
  assertCanonicalUnique(
    files.map((file) => file.path),
    label,
    "invalid_contract"
  );
}

export function validateScaP01SourceFileManifestV1(value: unknown): ScaP01SourceFileManifestV1 {
  const manifest = validateSchema(
    ScaP01SourceFileManifestV1Schema,
    value,
    "SCA P01 source file manifest",
    "invalid_contract"
  );
  validateSourceScope(manifest.scope, "source file manifest.scope");
  validateSourceFileIdentities(manifest.files, manifest.scope, "source file manifest.files");
  const byteCount = manifest.files.reduce((total, file) => total + file.byte_count, 0);
  if (
    manifest.file_count !== manifest.files.length ||
    manifest.byte_count !== byteCount ||
    manifest.tree_sha256 !== scaP01SourceTreeDigest(manifest.files)
  ) {
    fail("invalid_contract", "source file manifest counts or computed tree digest are invalid");
  }
  return manifest;
}

export function validateScaP01SourceCustodyCorpusV1(value: unknown): ScaP01SourceCustodyCorpusV1 {
  const custody = validateSchema(
    ScaP01SourceCustodyCorpusV1Schema,
    value,
    "SCA P01 source custody corpus",
    "invalid_contract"
  );
  const identities: Array<{ path: string; byte_count: number; content_sha256: string }> = [];
  for (const file of custody.files) {
    canonicalScopePath(file.path, `source custody file '${file.path}'`);
    const bytes = Buffer.from(file.content_base64, "base64");
    if (
      bytes.toString("base64") !== file.content_base64 ||
      bytes.byteLength !== file.byte_count ||
      sha256(bytes) !== file.content_sha256
    ) {
      fail("invalid_contract", `source custody file '${file.path}' bytes are not exact`);
    }
    identities.push({
      path: file.path,
      byte_count: file.byte_count,
      content_sha256: file.content_sha256,
    });
  }
  assertCanonicalUnique(
    identities.map((file) => file.path),
    "source custody files",
    "invalid_contract"
  );
  const byteCount = identities.reduce((total, file) => total + file.byte_count, 0);
  if (
    custody.file_count !== identities.length ||
    custody.byte_count !== byteCount ||
    custody.tree_sha256 !== scaP01SourceTreeDigest(identities)
  ) {
    fail("invalid_contract", "source custody counts or computed tree digest are invalid");
  }
  return custody;
}

export function validateScaCampaignSourceSnapshotV2(value: unknown): ScaCampaignSourceSnapshotV2 {
  const snapshot = validateSchema(
    ScaCampaignSourceSnapshotV2Schema,
    value,
    "SCA campaign source snapshot",
    "invalid_contract"
  );
  validateSourceScope(snapshot.scope, "snapshot.scope");
  if (
    snapshot.file_manifest_sha256 !== snapshot.file_manifest_ref.content_digest ||
    snapshot.custody_sha256 !== snapshot.custody_ref.content_digest ||
    sameRef(snapshot.file_manifest_ref, snapshot.custody_ref)
  ) {
    fail("invalid_contract", "source snapshot material refs and digests are invalid");
  }
  return snapshot;
}

export function validateScaP01SourceMaterialV1(input: {
  readonly snapshot: ScaCampaignSourceSnapshotV2;
  readonly file_manifest_ref: ArtifactRef;
  readonly file_manifest: ScaP01SourceFileManifestV1;
  readonly custody_ref: ArtifactRef;
  readonly custody: ScaP01SourceCustodyCorpusV1;
}): void {
  const snapshot = validateScaCampaignSourceSnapshotV2(input.snapshot);
  const manifest = validateScaP01SourceFileManifestV1(input.file_manifest);
  const custody = validateScaP01SourceCustodyCorpusV1(input.custody);
  const manifestIdentities = manifest.files.map((file) => ({ ...file }));
  const custodyIdentities = custody.files.map((file) => ({
    path: file.path,
    byte_count: file.byte_count,
    content_sha256: file.content_sha256,
  }));
  if (
    !sameRef(snapshot.file_manifest_ref, input.file_manifest_ref) ||
    !sameRef(snapshot.custody_ref, input.custody_ref) ||
    snapshot.file_manifest_sha256 !== input.file_manifest_ref.content_digest ||
    snapshot.custody_sha256 !== input.custody_ref.content_digest ||
    manifest.snapshot_id !== snapshot.snapshot_id ||
    custody.snapshot_id !== snapshot.snapshot_id ||
    !sameRef(custody.file_manifest_ref, input.file_manifest_ref) ||
    canonicalJson(manifest.scope) !== canonicalJson(snapshot.scope) ||
    canonicalJson(manifestIdentities) !== canonicalJson(custodyIdentities) ||
    snapshot.file_count !== manifest.file_count ||
    snapshot.byte_count !== manifest.byte_count ||
    snapshot.tree_sha256 !== manifest.tree_sha256 ||
    custody.file_count !== manifest.file_count ||
    custody.byte_count !== manifest.byte_count ||
    custody.tree_sha256 !== manifest.tree_sha256
  ) {
    fail(
      "invalid_contract",
      "source snapshot, file manifest, and sealed custody corpus are not exactly bound"
    );
  }
}

export const validateScaSourceProvenanceV1 = (value: unknown): ScaSourceProvenanceV1 =>
  validateSchema(ScaSourceProvenanceV1Schema, value, "SCA source provenance", "invalid_contract");
export const validateScaP01QualificationProfileV1 = (
  value: unknown
): ScaP01QualificationProfileV1 =>
  validateSchema(
    ScaP01QualificationProfileV1Schema,
    value,
    "SCA P01 qualification profile",
    "invalid_qualification"
  );
export const validateScaImplementationIdentityV1 = (
  value: unknown
): ScaImplementationIdentityV1 => {
  const identity = validateSchema(
    ScaImplementationIdentityV1Schema,
    value,
    "SCA implementation identity",
    "invalid_qualification"
  );
  if (
    identity.source_sha256 !== identity.source_ref.content_digest ||
    identity.build_sha256 !== identity.build_ref.content_digest ||
    sameRef(identity.source_ref, identity.build_ref) ||
    identity.source_ref.run_id !== identity.build_ref.run_id
  ) {
    fail("invalid_qualification", "implementation source/build material is not exactly bound");
  }
  return identity;
};
export const validateScaQualificationFixtureV1 = (value: unknown): ScaQualificationFixtureV1 => {
  const fixture = validateSchema(
    ScaQualificationFixtureV1Schema,
    value,
    "SCA qualification fixture",
    "invalid_qualification"
  );
  if (fixture.fixture_sha256 !== fixture.fixture_content_ref.content_digest) {
    fail("invalid_qualification", "qualification fixture digest does not bind its exact content");
  }
  return fixture;
};
export const validateScaQualificationLogV1 = (value: unknown): ScaQualificationLogV1 => {
  const log = validateSchema(
    ScaQualificationLogV1Schema,
    value,
    "SCA qualification log",
    "invalid_qualification"
  );
  if (log.log_sha256 !== log.log_content_ref.content_digest) {
    fail("invalid_qualification", "qualification log digest does not bind its exact content");
  }
  return log;
};
export const validateScaHostBoundaryReceiptV1 = (value: unknown): ScaHostBoundaryReceiptV1 => {
  const receipt = validateSchema(
    ScaHostBoundaryReceiptV1Schema,
    value,
    "SCA host-boundary receipt",
    "invalid_qualification"
  );
  if (receipt.dispatch_measurement !== undefined)
    validateScaP01QualificationDispatchV1(receipt.dispatch_measurement);
  return receipt;
};
export const validateScaQualificationEvidenceV1 = (value: unknown): ScaQualificationEvidenceV1 => {
  const evidence = validateSchema(
    ScaQualificationEvidenceV1Schema,
    value,
    "SCA qualification evidence",
    "invalid_qualification"
  );
  if (evidence.dispatch_measurement !== undefined)
    validateScaP01QualificationDispatchV1(evidence.dispatch_measurement);
  if (
    evidence.applicability_rationale !== null ||
    evidence.result === "NOT RUN" ||
    evidence.expected_result_sha256 !== sha256(evidence.expected_result) ||
    evidence.observed_result_sha256 !== sha256(evidence.observed_result)
  ) {
    fail(
      "invalid_qualification",
      "every P01 qualification variant requires applicable execution and exact result hashes"
    );
  }
  return evidence;
};
export const validateScaReviewerAuthorityV1 = (value: unknown): ScaReviewerAuthorityV1 =>
  validateSchema(ScaReviewerAuthorityV1Schema, value, "SCA reviewer authority", "invalid_reviewer");
export const validateScaReviewReceiptV1 = (value: unknown): ScaReviewReceiptV1 =>
  validateSchema(ScaReviewReceiptV1Schema, value, "SCA review receipt", "invalid_reviewer");

function aggregateStatus(
  statuses: readonly ScaQualificationStatusSchemaType[]
): ScaQualificationStatusSchemaType {
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("NOT RUN")) return "NOT RUN";
  return "PASS";
}
type ScaQualificationStatusSchemaType = "PASS" | "FAIL" | "BLOCKED" | "NOT RUN";

export function scaPhaseQualificationEvidenceRefs(
  record: ScaPhaseQualificationRecordV2
): readonly ArtifactRef[] {
  return record.criteria.flatMap((criterion) =>
    criterion.variants.map((variant) => variant.evidence_ref)
  );
}

export function scaPhaseQualificationRefs(
  record: ScaPhaseQualificationRecordV2
): readonly ArtifactRef[] {
  return sortedRefs([
    record.qualification_profile_ref,
    record.source_snapshot_ref,
    record.implementation_ref,
    record.reviewer_authority_ref,
    record.reviewer_receipt_ref,
    ...record.criteria.flatMap((criterion) =>
      criterion.variants.flatMap((variant) => [variant.fixture_ref, variant.evidence_ref])
    ),
  ]);
}

export function validateScaPhaseQualificationRecordV2(
  value: unknown
): ScaPhaseQualificationRecordV2 {
  const record = validateSchema(
    ScaPhaseQualificationRecordV2Schema,
    value,
    "SCA phase qualification record",
    "invalid_qualification"
  );
  safeTime(record.recorded_at, "qualification.recorded_at");
  if (record.implementer_identity_id === record.implementer_lineage_id) {
    fail(
      "invalid_qualification",
      "implementer identity and execution lineage must be distinct identifiers"
    );
  }
  if (
    canonicalJson(record.criteria.map((criterion) => criterion.criterion_id)) !==
    canonicalJson(SCA_P01_REQUIRED_CRITERION_IDS)
  ) {
    fail("invalid_qualification", "qualification does not cover the exact P01 criterion set");
  }
  for (const ref of scaPhaseQualificationRefs(record)) {
    if (ref.run_id !== record.run_id) {
      fail("invalid_qualification", "qualification refs must belong to the host qualification run");
    }
  }
  const fixtureIds: string[] = [];
  const evidenceIds: string[] = [];
  for (const criterion of record.criteria) {
    if (
      canonicalJson(criterion.variants.map((variant) => variant.variant_id)) !==
      canonicalJson(SCA_P01_QUALIFICATION_VARIANT_IDS)
    ) {
      fail(
        "invalid_qualification",
        `criterion '${criterion.criterion_id}' has an incomplete variant matrix`
      );
    }
    for (const variant of criterion.variants) {
      canonicalRef(
        variant.fixture_ref,
        `${criterion.criterion_id}.${variant.variant_id}.fixture_ref`
      );
      canonicalRef(
        variant.evidence_ref,
        `${criterion.criterion_id}.${variant.variant_id}.evidence_ref`
      );
      fixtureIds.push(variant.fixture_ref.artifact_id);
      evidenceIds.push(variant.evidence_ref.artifact_id);
      if (variant.applicability !== "applicable" || variant.status === "NOT RUN") {
        fail(
          "invalid_qualification",
          `${criterion.criterion_id}.${variant.variant_id} is required, applicable, and must be executed`
        );
      }
    }
    if (criterion.status !== aggregateStatus(criterion.variants.map((variant) => variant.status))) {
      fail(
        "invalid_qualification",
        `criterion '${criterion.criterion_id}' status is not derived from variants`
      );
    }
  }
  if (
    new Set(fixtureIds).size !== fixtureIds.length ||
    new Set(evidenceIds).size !== evidenceIds.length
  ) {
    fail(
      "invalid_qualification",
      "every criterion/variant must use distinct fixture and evidence refs"
    );
  }
  const expectedStatus = aggregateStatus(record.criteria.map((criterion) => criterion.status));
  const finalExpected = record.remaining_gaps.length === 0 ? expectedStatus : "BLOCKED";
  if (record.status !== finalExpected) {
    fail("invalid_qualification", "qualification status does not match criterion results and gaps");
  }
  return record;
}

interface InitialObligationDefinition {
  readonly obligation_id: string;
  readonly obligation_class: "required-result" | "attempt-and-report" | "optional";
  readonly purpose: string;
  readonly source_mandate: {
    readonly mandate_kind: "specification" | "profile" | "policy";
    readonly requirement_id: string;
  };
  readonly rationale: string;
  readonly scope:
    | "phase"
    | "phase-output"
    | "milestone"
    | "boundary"
    | "report-output"
    | "exploratory";
  readonly semantic_phase_id: (typeof SCA_PHASE_IDS)[number] | "M1" | null;
  readonly predecessor_ids: readonly string[];
  readonly allowed_dispositions: readonly ScaObligationEntryV2["allowed_dispositions"][number][];
  readonly completion_effect: "required-for-campaign" | "nonterminal" | "none";
}

const P01 = "SCA-OBL-P01-ACCEPTANCE";
const P02 = "SCA-OBL-P02-ACCEPTANCE";
const M1 = "SCA-OBL-M1-NONTERMINAL";
const P03 = "SCA-OBL-P03-ACCEPTANCE";
const P04 = "SCA-OBL-P04-ACCEPTANCE";
const MODEL_IDENTITY = "SCA-OBL-BOUNDARY-MODEL-IDENTITY";
const MODEL_DISCLOSURE = "SCA-OBL-BOUNDARY-MODEL-DISCLOSURE";
const ARTIFACT_INTEGRITY = "SCA-OBL-BOUNDARY-ARTIFACT-INTEGRITY";
const EXECUTION_AUTHORITY = "SCA-OBL-BOUNDARY-EXECUTION-AUTHORITY";
const RELEASE_AUTHORITY = "SCA-OBL-BOUNDARY-RELEASE-AUTHORITY";
const PROMOTION_AUTHORITY = "SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY";
const REVIEW_AUTHORITY = "SCA-OBL-BOUNDARY-INDEPENDENT-REVIEW";
const P10_RULE_LEARNING = "SCA-OBL-OUTPUT-P10-RULE-LEARNING";
const P11_REPORT_OUTPUTS = [
  "SCA-OBL-REPORT-MARKDOWN",
  "SCA-OBL-REPORT-STRUCTURED-JSON",
  "SCA-OBL-REPORT-SARIF",
  "SCA-OBL-REPORT-RECONCILIATION",
  "SCA-OBL-REPORT-CVSS-V4",
  "SCA-OBL-REPORT-CHECKSUM-MANIFEST",
  "SCA-OBL-REPORT-EPS-OBLIGATION-LEDGER",
  "SCA-OBL-REPORT-VALIDATION-RECORDS",
] as const;
const P02_OUTPUTS = [
  "SCA-OBL-OUTPUT-SOURCE-CENSUS",
  "SCA-OBL-OUTPUT-SYNTAX-INDEX",
  "SCA-OBL-OUTPUT-SEMGREP",
  "SCA-OBL-OUTPUT-SECRET-SCAN",
  "SCA-OBL-OUTPUT-DEPENDENCY-INVENTORY",
  "SCA-OBL-OUTPUT-OSV-EVIDENCE",
  "SCA-OBL-OUTPUT-NORMALIZED-CANDIDATES",
] as const;
const P03_OUTPUTS = [
  "SCA-OBL-OUTPUT-SOURCE-BOUND-GRAPH",
  "SCA-OBL-OUTPUT-BASELINE-GRAPH-QUERIES",
  "SCA-OBL-OUTPUT-GRAPH-CANDIDATES",
] as const;
const P04_OUTPUTS = [
  "SCA-OBL-OUTPUT-P04-SPECIALIST-DOSSIERS",
  "SCA-OBL-OUTPUT-P04-SELECTION-DOSSIER",
  "SCA-OBL-OUTPUT-P04-OMISSION-DOSSIER",
  "SCA-OBL-OUTPUT-P04-COVERAGE-DOSSIER",
] as const;
const P05_OUTPUTS = [
  "SCA-OBL-OUTPUT-P05-FALSIFIABLE-HYPOTHESES",
  "SCA-OBL-OUTPUT-P05-HYPOTHESIS-TRACEABILITY",
] as const;
const P06_OUTPUTS = [
  "SCA-OBL-OUTPUT-P06-BOUNDED-INVESTIGATION-PLANS",
  "SCA-OBL-OUTPUT-P06-EVIDENCE-DECISION-PLANS",
] as const;
const P07_OUTPUTS = [
  "SCA-OBL-OUTPUT-P07-BOUNDED-QUERY-EVIDENCE",
  "SCA-OBL-OUTPUT-P07-APPLICATION-TEST-EVIDENCE",
  "SCA-OBL-OUTPUT-P07-REACHABILITY-RECORDS",
  "SCA-OBL-OUTPUT-P07-ORACLE-RECORDS",
  "SCA-OBL-OUTPUT-P07-CLEANUP-RECORDS",
] as const;
const P08_OUTPUTS = ["SCA-OBL-OUTPUT-P08-PER-ITEM-DISPOSITIONS"] as const;
const P09_OUTPUTS = [
  "SCA-OBL-OUTPUT-P09-OBLIGATION-RECONCILIATION",
  "SCA-OBL-OUTPUT-P09-COVERAGE-RECONCILIATION",
  "SCA-OBL-OUTPUT-P09-REMAINING-GAPS",
] as const;
const P10_OUTPUTS = [
  "SCA-OBL-OUTPUT-P10-RULE-CANDIDATE-REGISTRY",
  "SCA-OBL-OUTPUT-P10-RULE-TEST-FIXTURES",
  "SCA-OBL-OUTPUT-P10-RULE-VALIDATION-RESULTS",
  "SCA-OBL-OUTPUT-P10-RULE-QUARANTINE-RECORDS",
  "SCA-OBL-OUTPUT-P10-RULE-PROMOTION-DECISIONS",
  P10_RULE_LEARNING,
] as const;

function phaseDefinition(
  phase: (typeof SCA_PHASE_IDS)[number],
  predecessors: readonly string[]
): InitialObligationDefinition {
  return {
    obligation_id: `SCA-OBL-${phase.slice("SCA-".length)}-ACCEPTANCE`,
    obligation_class: "required-result",
    purpose: `Produce and accept the complete ${phase} phase gate and mandatory outputs.`,
    source_mandate: { mandate_kind: "specification", requirement_id: phase },
    rationale: "A mandatory phase gate is a campaign completion prerequisite.",
    scope: "phase",
    semantic_phase_id: phase,
    predecessor_ids: predecessors,
    allowed_dispositions: ["pending", "satisfied", "blocked"],
    completion_effect: "required-for-campaign",
  };
}

function outputDefinition(input: {
  readonly id: string;
  readonly phase: (typeof SCA_PHASE_IDS)[number];
  readonly predecessor: string;
}): InitialObligationDefinition {
  return {
    obligation_id: input.id,
    obligation_class: "required-result",
    purpose: `Produce the mandatory ${input.id} artifact with exact evidence and lineage.`,
    source_mandate: { mandate_kind: "specification", requirement_id: input.phase },
    rationale: "The phase specification names this output as mandatory.",
    scope: "phase-output",
    semantic_phase_id: input.phase,
    predecessor_ids: [input.predecessor],
    allowed_dispositions: ["pending", "satisfied", "blocked"],
    completion_effect: "required-for-campaign",
  };
}

const INITIAL_CATALOG: readonly InitialObligationDefinition[] = deepFreeze([
  {
    obligation_id: ARTIFACT_INTEGRITY,
    obligation_class: "required-result",
    purpose: "Preserve exact immutable artifact identity, bytes, lineage, and replay bindings.",
    source_mandate: { mandate_kind: "specification", requirement_id: "SCA-C06" },
    rationale: "Campaign truth depends on exact host-verifiable artifacts.",
    scope: "boundary",
    semantic_phase_id: null,
    predecessor_ids: [],
    allowed_dispositions: ["pending", "satisfied", "blocked"],
    completion_effect: "required-for-campaign",
  },
  {
    obligation_id: MODEL_IDENTITY,
    obligation_class: "required-result",
    purpose: "Bind every future cognitive call to the fixed DeepSeek identity.",
    source_mandate: { mandate_kind: "specification", requirement_id: "SCA-C07" },
    rationale: "Model drift or fallback invalidates SCA cognition.",
    scope: "boundary",
    semantic_phase_id: null,
    predecessor_ids: [],
    allowed_dispositions: ["pending", "satisfied", "blocked"],
    completion_effect: "required-for-campaign",
  },
  {
    obligation_id: MODEL_DISCLOSURE,
    obligation_class: "required-result",
    purpose: "Authorize and evidence exact cloud payload disclosure before transmission.",
    source_mandate: { mandate_kind: "specification", requirement_id: "SCA-C08" },
    rationale: "Unknown provider data treatment means zero provider calls.",
    scope: "boundary",
    semantic_phase_id: null,
    predecessor_ids: [],
    allowed_dispositions: ["pending", "satisfied", "blocked"],
    completion_effect: "required-for-campaign",
  },
  {
    obligation_id: EXECUTION_AUTHORITY,
    obligation_class: "required-result",
    purpose: "Retain distinct authority for consequential target execution.",
    source_mandate: { mandate_kind: "specification", requirement_id: "SCA-P07" },
    rationale: "Admission does not itself authorize target execution.",
    scope: "boundary",
    semantic_phase_id: null,
    predecessor_ids: [],
    allowed_dispositions: ["pending", "satisfied", "blocked", "denied"],
    completion_effect: "required-for-campaign",
  },
  {
    obligation_id: RELEASE_AUTHORITY,
    obligation_class: "required-result",
    purpose: "Retain distinct authority for exact campaign release.",
    source_mandate: { mandate_kind: "specification", requirement_id: "SCA-P12" },
    rationale: "Human approval cannot be inferred from admission.",
    scope: "boundary",
    semantic_phase_id: null,
    predecessor_ids: [],
    allowed_dispositions: ["pending", "satisfied", "blocked", "denied"],
    completion_effect: "required-for-campaign",
  },
  {
    obligation_id: PROMOTION_AUTHORITY,
    obligation_class: "attempt-and-report",
    purpose: "Attempt rule promotion only when an eligible candidate and separate authority exist.",
    source_mandate: { mandate_kind: "specification", requirement_id: "SCA-P10" },
    rationale: "No-rule and denied promotion are honest recorded outcomes.",
    scope: "boundary",
    semantic_phase_id: null,
    predecessor_ids: [],
    allowed_dispositions: ["pending", "attempted", "denied", "not-needed", "unavailable"],
    completion_effect: "required-for-campaign",
  },
  {
    obligation_id: REVIEW_AUTHORITY,
    obligation_class: "required-result",
    purpose: "Obtain exact independent reviewer authority and lineage evidence.",
    source_mandate: { mandate_kind: "specification", requirement_id: "SCA-Q01" },
    rationale: "Lexically different actor names do not prove reviewer separation.",
    scope: "boundary",
    semantic_phase_id: null,
    predecessor_ids: [],
    allowed_dispositions: ["pending", "satisfied", "blocked"],
    completion_effect: "required-for-campaign",
  },
  phaseDefinition("SCA-P01", [ARTIFACT_INTEGRITY]),
  ...P02_OUTPUTS.map((id) => outputDefinition({ id, phase: "SCA-P02", predecessor: P01 })),
  phaseDefinition("SCA-P02", [P01, ...P02_OUTPUTS]),
  {
    obligation_id: M1,
    obligation_class: "required-result",
    purpose: "Record the nonterminal deterministic preparation checkpoint after accepted P02.",
    source_mandate: { mandate_kind: "specification", requirement_id: "SCA-P02" },
    rationale:
      "M1 depends only on accepted P02 and deterministic outputs and cannot complete the campaign.",
    scope: "milestone",
    semantic_phase_id: "M1",
    predecessor_ids: [P02, ...P02_OUTPUTS],
    allowed_dispositions: ["pending", "satisfied", "blocked"],
    completion_effect: "nonterminal",
  },
  ...P03_OUTPUTS.map((id) => outputDefinition({ id, phase: "SCA-P03", predecessor: M1 })),
  phaseDefinition("SCA-P03", [M1, ...P03_OUTPUTS]),
  ...P04_OUTPUTS.map((id) => outputDefinition({ id, phase: "SCA-P04", predecessor: P03 })),
  phaseDefinition("SCA-P04", [P03, MODEL_IDENTITY, MODEL_DISCLOSURE, ...P04_OUTPUTS]),
  ...P05_OUTPUTS.map((id) => outputDefinition({ id, phase: "SCA-P05", predecessor: P04 })),
  phaseDefinition("SCA-P05", [P04, ...P05_OUTPUTS]),
  ...P06_OUTPUTS.map((id) =>
    outputDefinition({ id, phase: "SCA-P06", predecessor: "SCA-OBL-P05-ACCEPTANCE" })
  ),
  phaseDefinition("SCA-P06", ["SCA-OBL-P05-ACCEPTANCE", ...P06_OUTPUTS]),
  ...P07_OUTPUTS.map((id) =>
    outputDefinition({ id, phase: "SCA-P07", predecessor: "SCA-OBL-P06-ACCEPTANCE" })
  ),
  phaseDefinition("SCA-P07", ["SCA-OBL-P06-ACCEPTANCE", EXECUTION_AUTHORITY, ...P07_OUTPUTS]),
  ...P08_OUTPUTS.map((id) =>
    outputDefinition({ id, phase: "SCA-P08", predecessor: "SCA-OBL-P07-ACCEPTANCE" })
  ),
  phaseDefinition("SCA-P08", ["SCA-OBL-P07-ACCEPTANCE", ...P08_OUTPUTS]),
  ...P09_OUTPUTS.map((id) =>
    outputDefinition({ id, phase: "SCA-P09", predecessor: "SCA-OBL-P08-ACCEPTANCE" })
  ),
  phaseDefinition("SCA-P09", ["SCA-OBL-P08-ACCEPTANCE", ...P09_OUTPUTS]),
  ...P10_OUTPUTS.map((id) => ({
    ...outputDefinition({ id, phase: "SCA-P10", predecessor: "SCA-OBL-P09-ACCEPTANCE" }),
    ...(id === P10_RULE_LEARNING
      ? {
          purpose:
            "Reconcile the complete validated, quarantined, promoted, no-rule, or blocked rule-learning lifecycle.",
          allowed_dispositions: ["pending", "satisfied", "blocked", "no-rule"] as const,
        }
      : {}),
  })),
  phaseDefinition("SCA-P10", ["SCA-OBL-P09-ACCEPTANCE", ...P10_OUTPUTS, PROMOTION_AUTHORITY]),
  ...P11_REPORT_OUTPUTS.map((id) => ({
    ...outputDefinition({ id, phase: "SCA-P11", predecessor: "SCA-OBL-P10-ACCEPTANCE" }),
    scope: "report-output" as const,
    predecessor_ids: ["SCA-OBL-P10-ACCEPTANCE", P10_RULE_LEARNING],
  })),
  phaseDefinition("SCA-P11", ["SCA-OBL-P10-ACCEPTANCE", P10_RULE_LEARNING, ...P11_REPORT_OUTPUTS]),
  phaseDefinition("SCA-P12", ["SCA-OBL-P11-ACCEPTANCE", REVIEW_AUTHORITY, RELEASE_AUTHORITY]),
  {
    obligation_id: "SCA-OBL-OPTIONAL-NATIVE-GRAPH-ESCALATION",
    obligation_class: "optional",
    purpose: "Record omission or separate admission of a native graph-query escalation.",
    source_mandate: { mandate_kind: "policy", requirement_id: "SCA-P03-native-query" },
    rationale: "Native-query escalation has no execution duty unless later made material.",
    scope: "exploratory",
    semantic_phase_id: "SCA-P03",
    predecessor_ids: [P03],
    allowed_dispositions: ["pending", "omitted", "promoted"],
    completion_effect: "none",
  },
]);

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function classPrecedence(value: ScaObligationEntryV2["obligation_class"]): number {
  if (value === "required-result") return 3;
  if (value === "attempt-and-report") return 2;
  return 1;
}

function entryDigest(value: Omit<ScaObligationEntryV2, "entry_sha256">): string {
  return sha256(canonicalJson(value));
}

function ledgerId(input: {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
}): string {
  return `scaobl_${sha256(canonicalJson(input))}`;
}

function eventFor(input: {
  readonly sequence: number;
  readonly operation_id: string;
  readonly operation_sha256: string;
  readonly event_type: "registered" | "promoted";
  readonly obligation_id: string;
  readonly entry_revision: number;
  readonly entry_sha256: string;
  readonly prior_event_sha256: string;
  readonly occurred_at: string;
}): ScaObligationLedgerV2["events"][number] {
  const body = { ...input };
  const eventId = `scaoble_${sha256(canonicalJson(body))}`;
  const unsigned = { event_id: eventId, ...body };
  return { ...unsigned, event_sha256: sha256(canonicalJson(unsigned)) };
}

export function buildScaInitialObligationLedgerV2(input: {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly created_at: string;
  readonly assigning_authority_id: string;
  readonly policy_refs: readonly ArtifactRef[];
  readonly supporting_evidence_refs: readonly ArtifactRef[];
}): ScaObligationLedgerV2 {
  safeTime(input.created_at, "obligation ledger created_at");
  assertRefArray(input.policy_refs, "obligation policy refs", null);
  assertRefArray(input.supporting_evidence_refs, "obligation supporting evidence refs", null);
  const entries: ScaObligationEntryV2[] = [];
  const events: ScaObligationLedgerV2["events"][number][] = [];
  let priorEvent = ZERO_SHA256;
  for (const [index, definition] of INITIAL_CATALOG.entries()) {
    const body: Omit<ScaObligationEntryV2, "entry_sha256"> = {
      obligation_id: definition.obligation_id,
      revision: 1,
      revision_kind: "registered",
      obligation_class: definition.obligation_class,
      effective_class: definition.obligation_class,
      precedence: classPrecedence(definition.obligation_class),
      purpose: definition.purpose,
      source_mandate: { ...definition.source_mandate },
      assigning_authority_id: input.assigning_authority_id,
      policy_refs: [...input.policy_refs],
      rationale: definition.rationale,
      supporting_evidence_refs: [...input.supporting_evidence_refs],
      scope: definition.scope,
      semantic_phase_id: definition.semantic_phase_id,
      predecessor_ids: [...definition.predecessor_ids],
      allowed_dispositions: [...definition.allowed_dispositions],
      completion_effect: definition.completion_effect,
      status: "pending",
      prior_entry_sha256: null,
      occurred_at: input.created_at,
    };
    const entry = { ...body, entry_sha256: entryDigest(body) };
    entries.push(entry);
    const event = eventFor({
      sequence: index + 1,
      operation_id: `initial-${String(index + 1).padStart(3, "0")}-${definition.obligation_id.toLowerCase()}`,
      operation_sha256: sha256(
        canonicalJson({
          action: "register",
          definition,
          assigning_authority_id: input.assigning_authority_id,
          policy_refs: input.policy_refs,
          supporting_evidence_refs: input.supporting_evidence_refs,
        })
      ),
      event_type: "registered",
      obligation_id: definition.obligation_id,
      entry_revision: 1,
      entry_sha256: entry.entry_sha256,
      prior_event_sha256: priorEvent,
      occurred_at: input.created_at,
    });
    events.push(event);
    priorEvent = event.event_sha256;
  }
  const unsigned = {
    schema_id: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
    schema_version: 2 as const,
    ledger_id: ledgerId({
      tenant_id: input.tenant_id,
      project_id: input.project_id,
      run_id: input.run_id,
    }),
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: input.run_id,
    version: 1,
    prior_ledger_ref: null,
    prior_ledger_sha256: null,
    append_only: true as const,
    campaign_completion_claimed: false as const,
    entries,
    events,
    created_at: input.created_at,
  };
  return validateScaObligationLedgerV2({
    ...unsigned,
    ledger_sha256: sha256(canonicalJson(unsigned)),
  });
}

export function validateScaObligationRevisionOperationV1(
  value: unknown
): ScaObligationRevisionOperationV1 {
  const operation = validateSchema(
    ScaObligationRevisionOperationV1Schema,
    value,
    "SCA obligation revision operation",
    "obligation_conflict"
  );
  safeTime(operation.occurred_at, "obligation operation occurred_at");
  assertRefArray(operation.policy_refs, "obligation operation policy_refs", null);
  assertRefArray(operation.supporting_evidence_refs, "obligation operation supporting refs", null);
  canonicalRef(operation.discovery_evidence_ref, "obligation discovery evidence ref");
  if (
    !operation.supporting_evidence_refs.some((ref) =>
      sameRef(ref, operation.discovery_evidence_ref)
    )
  ) {
    fail(
      "obligation_conflict",
      "supporting evidence must include the exact discovery evidence ref"
    );
  }
  if (
    operation.scope_decision !== "allow" ||
    operation.authority_decision !== "allow" ||
    operation.resource_policy_decision !== "allow"
  ) {
    fail(
      "obligation_policy_denied",
      "scope, authority, and resource policy must all allow the revision"
    );
  }
  if (operation.material && operation.requested_class !== "required-result") {
    fail("obligation_conflict", "material work must be registered or promoted to required-result");
  }
  return operation;
}

export function appendScaObligationLedgerV2(input: {
  readonly prior_ledger: ScaObligationLedgerV2;
  readonly prior_ledger_ref: ArtifactRef;
  readonly operation: unknown;
  readonly authority_policy_ref: ArtifactRef;
  readonly resource_policy_ref: ArtifactRef;
}): ScaObligationLedgerV2 {
  const prior = validateScaObligationLedgerV2(input.prior_ledger);
  const operation = validateScaObligationRevisionOperationV1(input.operation);
  canonicalRef(input.prior_ledger_ref, "prior obligation ledger ref");
  if (
    input.prior_ledger_ref.content_digest !== sha256(canonicalJson(prior)) ||
    input.prior_ledger_ref.run_id !== prior.run_id ||
    input.prior_ledger_ref.content_schema?.schema_id !== SCA_OBLIGATION_LEDGER_V2_SCHEMA
  ) {
    fail("obligation_conflict", "prior ledger ref does not bind the exact prior ledger bytes");
  }
  if (operation.discovery_evidence_ref.run_id !== prior.run_id) {
    fail("obligation_conflict", "discovery evidence must belong to the exact campaign run");
  }
  for (const requiredPolicyRef of [input.authority_policy_ref, input.resource_policy_ref]) {
    if (!operation.policy_refs.some((ref) => sameRef(ref, requiredPolicyRef))) {
      fail(
        "obligation_policy_denied",
        "obligation revision did not recheck exact authority/resource policy refs"
      );
    }
  }
  if (prior.events.some((event) => event.operation_id === operation.operation_id)) {
    fail("obligation_conflict", "obligation operation ID already exists with prior history");
  }
  const revisions = prior.entries.filter(
    (entry) => entry.obligation_id === operation.obligation_id
  );
  let body: Omit<ScaObligationEntryV2, "entry_sha256">;
  if (operation.action === "register") {
    if (revisions.length !== 0)
      fail("obligation_conflict", "registration cannot replace an existing obligation");
    for (const predecessor of operation.predecessor_ids) {
      if (!prior.entries.some((entry) => entry.obligation_id === predecessor)) {
        fail("obligation_conflict", "new obligation has an unknown predecessor");
      }
    }
    body = {
      obligation_id: operation.obligation_id,
      revision: 1,
      revision_kind: "registered",
      obligation_class: operation.requested_class,
      effective_class: operation.requested_class,
      precedence: classPrecedence(operation.requested_class),
      purpose: operation.purpose,
      source_mandate: operation.source_mandate,
      assigning_authority_id: operation.assigning_authority_id,
      policy_refs: [...operation.policy_refs],
      rationale: operation.rationale,
      supporting_evidence_refs: [...operation.supporting_evidence_refs],
      scope: operation.scope,
      semantic_phase_id: operation.semantic_phase_id,
      predecessor_ids: [...operation.predecessor_ids],
      allowed_dispositions: [...operation.allowed_dispositions],
      completion_effect: operation.completion_effect,
      status: "pending",
      prior_entry_sha256: null,
      occurred_at: operation.occurred_at,
    };
  } else {
    const current = revisions.at(-1);
    if (current === undefined)
      fail("obligation_conflict", "promotion requires a prior registration");
    if (classPrecedence(operation.requested_class) <= classPrecedence(current.effective_class)) {
      fail("obligation_conflict", "promotion must move to a strictly stronger obligation class");
    }
    const { entry_sha256: currentEntryDigest, ...currentUnsigned } = current;
    body = {
      ...currentUnsigned,
      revision: current.revision + 1,
      revision_kind: "promoted",
      obligation_class: operation.requested_class,
      effective_class: operation.requested_class,
      precedence: classPrecedence(operation.requested_class),
      assigning_authority_id: operation.assigning_authority_id,
      policy_refs: [...operation.policy_refs],
      rationale: operation.rationale,
      supporting_evidence_refs: [...operation.supporting_evidence_refs],
      allowed_dispositions: ["pending", "satisfied", "blocked"],
      completion_effect: "required-for-campaign",
      prior_entry_sha256: currentEntryDigest,
      occurred_at: operation.occurred_at,
    };
  }
  const entry = { ...body, entry_sha256: entryDigest(body) };
  const priorEvent = prior.events.at(-1);
  if (priorEvent === undefined)
    fail("invalid_obligation_ledger", "prior obligation event log is empty");
  const event = eventFor({
    sequence: prior.events.length + 1,
    operation_id: operation.operation_id,
    operation_sha256: sha256(canonicalJson(operation)),
    event_type: entry.revision_kind,
    obligation_id: entry.obligation_id,
    entry_revision: entry.revision,
    entry_sha256: entry.entry_sha256,
    prior_event_sha256: priorEvent.event_sha256,
    occurred_at: operation.occurred_at,
  });
  const unsigned = {
    schema_id: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
    schema_version: 2 as const,
    ledger_id: prior.ledger_id,
    tenant_id: prior.tenant_id,
    project_id: prior.project_id,
    run_id: prior.run_id,
    version: prior.version + 1,
    prior_ledger_ref: input.prior_ledger_ref,
    prior_ledger_sha256: input.prior_ledger_ref.content_digest,
    append_only: true as const,
    campaign_completion_claimed: false as const,
    entries: [...prior.entries, entry],
    events: [...prior.events, event],
    created_at: prior.created_at,
  };
  return validateScaObligationLedgerV2({
    ...unsigned,
    ledger_sha256: sha256(canonicalJson(unsigned)),
  });
}

export function effectiveScaObligations(
  ledgerValue: unknown
): Readonly<Record<string, ScaObligationEntryV2>> {
  const ledger = validateScaObligationLedgerV2(ledgerValue);
  const effective: Record<string, ScaObligationEntryV2> = {};
  for (const entry of ledger.entries) effective[entry.obligation_id] = structuredClone(entry);
  return deepFreeze(effective);
}

export function validateScaObligationLedgerV2(value: unknown): ScaObligationLedgerV2 {
  const ledger = validateSchema(
    ScaObligationLedgerV2Schema,
    value,
    "SCA obligation ledger",
    "invalid_obligation_ledger"
  );
  safeTime(ledger.created_at, "obligation ledger created_at");
  if (
    ledger.ledger_id !==
    ledgerId({
      tenant_id: ledger.tenant_id,
      project_id: ledger.project_id,
      run_id: ledger.run_id,
    })
  ) {
    fail(
      "invalid_obligation_ledger",
      "obligation ledger identity does not match campaign identity"
    );
  }
  if (ledger.entries.length !== ledger.events.length) {
    fail(
      "invalid_obligation_ledger",
      "every obligation revision requires exactly one append event"
    );
  }
  const revisions = new Map<string, ScaObligationEntryV2>();
  const knownIds = new Set<string>();
  const operationIds = new Set<string>();
  let priorEvent = ZERO_SHA256;
  for (const [index, entry] of ledger.entries.entries()) {
    const { entry_sha256: observedEntryDigest, ...unsignedEntry } = entry;
    if (entryDigest(unsignedEntry) !== observedEntryDigest) {
      fail("invalid_obligation_ledger", "obligation entry digest is invalid");
    }
    if (entry.precedence !== classPrecedence(entry.effective_class)) {
      fail("invalid_obligation_ledger", "obligation precedence does not match effective class");
    }
    const prior = revisions.get(entry.obligation_id);
    if (prior === undefined) {
      if (
        entry.revision !== 1 ||
        entry.revision_kind !== "registered" ||
        entry.prior_entry_sha256 !== null
      ) {
        fail(
          "invalid_obligation_ledger",
          "first obligation revision must be an immutable registration"
        );
      }
      for (const predecessor of entry.predecessor_ids) {
        if (!knownIds.has(predecessor)) {
          fail(
            "invalid_obligation_ledger",
            `obligation '${entry.obligation_id}' has a non-preceding dependency`
          );
        }
      }
      knownIds.add(entry.obligation_id);
    } else {
      if (
        entry.revision !== prior.revision + 1 ||
        entry.revision_kind !== "promoted" ||
        entry.prior_entry_sha256 !== prior.entry_sha256 ||
        classPrecedence(entry.effective_class) <= classPrecedence(prior.effective_class)
      ) {
        fail("invalid_obligation_ledger", "obligation promotion chain is invalid or weaker");
      }
      const immutableBefore = {
        purpose: prior.purpose,
        source_mandate: prior.source_mandate,
        scope: prior.scope,
        semantic_phase_id: prior.semantic_phase_id,
        predecessor_ids: prior.predecessor_ids,
      };
      const immutableAfter = {
        purpose: entry.purpose,
        source_mandate: entry.source_mandate,
        scope: entry.scope,
        semantic_phase_id: entry.semantic_phase_id,
        predecessor_ids: entry.predecessor_ids,
      };
      if (canonicalJson(immutableBefore) !== canonicalJson(immutableAfter)) {
        fail("invalid_obligation_ledger", "promotion mutated immutable registration history");
      }
    }
    revisions.set(entry.obligation_id, entry);
    const event = ledger.events[index];
    if (event === undefined) fail("invalid_obligation_ledger", "obligation event log is sparse");
    if (operationIds.has(event.operation_id)) {
      fail("invalid_obligation_ledger", "obligation operation IDs must be unique");
    }
    operationIds.add(event.operation_id);
    const eventBody = {
      sequence: event.sequence,
      operation_id: event.operation_id,
      operation_sha256: event.operation_sha256,
      event_type: event.event_type,
      obligation_id: event.obligation_id,
      entry_revision: event.entry_revision,
      entry_sha256: event.entry_sha256,
      prior_event_sha256: event.prior_event_sha256,
      occurred_at: event.occurred_at,
    };
    const expectedEventId = `scaoble_${sha256(canonicalJson(eventBody))}`;
    const unsignedEvent = { event_id: event.event_id, ...eventBody };
    if (
      event.sequence !== index + 1 ||
      event.obligation_id !== entry.obligation_id ||
      event.entry_revision !== entry.revision ||
      event.event_type !== entry.revision_kind ||
      event.entry_sha256 !== entry.entry_sha256 ||
      event.prior_event_sha256 !== priorEvent ||
      event.occurred_at !== entry.occurred_at ||
      event.event_id !== expectedEventId ||
      event.event_sha256 !== sha256(canonicalJson(unsignedEvent))
    ) {
      fail("invalid_obligation_ledger", "append-only obligation event chain is invalid");
    }
    priorEvent = event.event_sha256;
  }
  if (ledger.version === 1) {
    if (
      ledger.prior_ledger_ref !== null ||
      ledger.prior_ledger_sha256 !== null ||
      ledger.entries.length !== INITIAL_CATALOG.length
    ) {
      fail("invalid_obligation_ledger", "initial ledger shape is invalid");
    }
    for (const [index, definition] of INITIAL_CATALOG.entries()) {
      const entry = ledger.entries[index];
      if (
        entry === undefined ||
        canonicalJson({
          obligation_id: entry.obligation_id,
          obligation_class: entry.obligation_class,
          purpose: entry.purpose,
          source_mandate: entry.source_mandate,
          rationale: entry.rationale,
          scope: entry.scope,
          semantic_phase_id: entry.semantic_phase_id,
          predecessor_ids: entry.predecessor_ids,
          allowed_dispositions: entry.allowed_dispositions,
          completion_effect: entry.completion_effect,
        }) !== canonicalJson(definition)
      ) {
        fail(
          "invalid_obligation_ledger",
          "initial obligation catalog is incomplete, reordered, or semantically changed"
        );
      }
    }
  } else if (
    ledger.prior_ledger_ref === null ||
    ledger.prior_ledger_sha256 === null ||
    ledger.prior_ledger_ref.content_digest !== ledger.prior_ledger_sha256 ||
    ledger.prior_ledger_ref.run_id !== ledger.run_id ||
    ledger.prior_ledger_ref.content_schema?.schema_id !== SCA_OBLIGATION_LEDGER_V2_SCHEMA ||
    ledger.prior_ledger_ref.version !== ledger.version - 1
  ) {
    fail(
      "invalid_obligation_ledger",
      "revised ledger does not bind its exact prior ledger revision"
    );
  }
  const { ledger_sha256: observedLedgerDigest, ...unsignedLedger } = ledger;
  if (sha256(canonicalJson(unsignedLedger)) !== observedLedgerDigest) {
    fail("invalid_obligation_ledger", "obligation ledger digest is invalid");
  }
  return ledger;
}

export function validateScaCampaignManifestCoreV1(value: unknown): ScaCampaignManifestCoreV1 {
  const core = validateSchema(
    ScaCampaignManifestCoreV1Schema,
    value,
    "SCA campaign manifest core",
    "invalid_manifest_binding"
  );
  const { binding_sha256: observed, ...unsigned } = core;
  if (sha256(canonicalJson(unsigned)) !== observed) {
    fail("invalid_manifest_binding", "manifest core binding digest is invalid");
  }
  assertRefArray(core.frozen_refs.tool_executable_refs, "frozen tool executable refs", null);
  assertRefArray(
    core.frozen_refs.tool_measurement_receipt_refs,
    "frozen tool measurement receipt refs",
    null
  );
  if (core.frozen_refs.variant_capture_manifest_ref !== undefined) {
    canonicalRef(core.frozen_refs.variant_capture_manifest_ref, "frozen variant capture");
    if (core.frozen_refs.variant_capture_manifest_ref.run_id !== core.run_id)
      fail("invalid_manifest_binding", "variant capture belongs to another campaign");
  }
  return core;
}

export function validateScaP01AdmissionEvidenceV1(value: unknown): ScaP01AdmissionEvidenceV1 {
  const evidence = validateSchema(
    ScaP01AdmissionEvidenceV1Schema,
    value,
    "SCA P01 admission evidence",
    "invalid_manifest_binding"
  );
  if (
    canonicalJson(evidence.checks.map((check) => check.check_id)) !==
    canonicalJson([
      "artifact-bindings",
      "semantic-policies",
      "trusted-qualification",
      "zero-dispatch",
    ])
  ) {
    fail(
      "invalid_manifest_binding",
      "admission evidence does not contain the exact current check set"
    );
  }
  assertRefArray(evidence.evidence_refs, "admission evidence refs", null);
  return evidence;
}

export const validateScaPhaseGateRecordV2 = (value: unknown): ScaPhaseGateRecordV2 =>
  validateSchema(
    ScaPhaseGateRecordV2Schema,
    value,
    "SCA P01 phase gate",
    "invalid_manifest_binding"
  );

export function validateScaCampaignManifestV2(value: unknown): ScaCampaignManifestV2 {
  const manifest = validateSchema(
    ScaCampaignManifestV2Schema,
    value,
    "SCA campaign manifest",
    "invalid_manifest_binding"
  );
  const { admission_binding_sha256: observed, ...unsigned } = manifest;
  if (sha256(canonicalJson(unsigned)) !== observed) {
    fail("invalid_manifest_binding", "final admission binding digest is invalid");
  }
  return manifest;
}

export function validateScaP01AdmissionContextV1(input: {
  readonly request: ScaP01AdmissionRequestV3;
  readonly request_ref: ArtifactRef;
  readonly ledger: ScaObligationLedgerV2;
  readonly ledger_ref: ArtifactRef;
  readonly core: ScaCampaignManifestCoreV1;
  readonly core_ref: ArtifactRef;
  readonly frozen_material_refs: ScaCampaignManifestCoreV1["frozen_refs"];
  readonly qualification: ScaPhaseQualificationRecordV2;
  readonly qualification_ref: ArtifactRef;
  readonly admission_evidence: ScaP01AdmissionEvidenceV1;
  readonly admission_evidence_ref: ArtifactRef;
  readonly gate: ScaPhaseGateRecordV2;
  readonly gate_ref: ArtifactRef;
  readonly manifest: ScaCampaignManifestV2;
}): void {
  const request = validateScaP01AdmissionRequestV3(input.request);
  const ledger = validateScaObligationLedgerV2(input.ledger);
  const core = validateScaCampaignManifestCoreV1(input.core);
  const qualification = validateScaPhaseQualificationRecordV2(input.qualification);
  const evidence = validateScaP01AdmissionEvidenceV1(input.admission_evidence);
  const gate = validateScaPhaseGateRecordV2(input.gate);
  const manifest = validateScaCampaignManifestV2(input.manifest);
  const identityValues = [request, core, evidence, gate, manifest];
  if (
    identityValues.some(
      (value) =>
        value.tenant_id !== request.tenant_id ||
        value.project_id !== request.project_id ||
        value.run_id !== request.run_id
    ) ||
    ledger.tenant_id !== request.tenant_id ||
    ledger.project_id !== request.project_id ||
    ledger.run_id !== request.run_id
  ) {
    fail(
      "invalid_manifest_binding",
      "P01 admission artifacts do not share exact campaign identity"
    );
  }
  if (
    !sameRef(core.request_ref, input.request_ref) ||
    !sameRef(core.obligation_ledger_ref, input.ledger_ref) ||
    !sameRef(core.frozen_refs.p01_qualification_ref, input.qualification_ref) ||
    canonicalJson(core.frozen_refs) !== canonicalJson(input.frozen_material_refs) ||
    !sameRef(core.frozen_refs.source_snapshot_ref, request.source.snapshot_ref) ||
    !sameRef(core.frozen_refs.source_provenance_ref, request.source.provenance_ref) ||
    canonicalJson(core.frozen_refs.variant_capture_manifest_ref ?? null) !==
      canonicalJson(request.source.variant_capture_manifest_ref ?? null) ||
    !sameRef(core.frozen_refs.analysis_profile_ref, request.analysis_profile.profile_ref) ||
    !sameRef(core.frozen_refs.rule_release_ref, request.rule_release_ref) ||
    !sameRef(core.frozen_refs.rule_profile_ref, request.rule_profile_ref) ||
    !sameRef(core.frozen_refs.toolchain_ref, request.toolchain_ref) ||
    !sameRef(core.frozen_refs.network_policy_ref, request.network_policy_ref) ||
    !sameRef(core.frozen_refs.privacy_policy_ref, request.privacy_policy_ref) ||
    !sameRef(core.frozen_refs.model_data_policy_ref, request.model_data_policy_ref) ||
    !sameRef(core.frozen_refs.resource_policy_ref, request.resource_policy_ref) ||
    !sameRef(core.frozen_refs.output_policy_ref, request.output_policy_ref) ||
    !sameRef(core.frozen_refs.authority_policy_ref, request.authority_policy_ref) ||
    !sameRef(core.frozen_refs.p01_qualification_ref, request.p01_qualification_ref)
  ) {
    fail(
      "invalid_manifest_binding",
      "manifest core does not freeze the exact request/ledger/policy bindings"
    );
  }
  if (
    qualification.status !== "PASS" ||
    qualification.remaining_gaps.length !== 0 ||
    qualification.tenant_id !== request.tenant_id ||
    qualification.project_id !== request.project_id ||
    qualification.run_id !== input.qualification_ref.run_id ||
    qualification.run_id === request.run_id ||
    qualification.implementation_revision !== request.implementation_revision ||
    !sameRef(request.p01_qualification_ref, input.qualification_ref)
  ) {
    fail(
      "invalid_manifest_binding",
      "campaign does not bind one exact gap-free passed implementation qualification"
    );
  }
  if (
    !sameRef(evidence.request_ref, input.request_ref) ||
    !sameRef(evidence.obligation_ledger_ref, input.ledger_ref) ||
    !sameRef(evidence.manifest_core_ref, input.core_ref) ||
    !sameRef(evidence.qualification_ref, input.qualification_ref)
  ) {
    fail("invalid_manifest_binding", "current admission evidence is stale or misbound");
  }
  const variantRef = request.source.variant_capture_manifest_ref;
  if (variantRef !== undefined && !evidence.evidence_refs.some((ref) => sameRef(ref, variantRef))) {
    fail("invalid_manifest_binding", "admission evidence omits frozen variant capture");
  }
  if (
    !sameRef(gate.request_ref, input.request_ref) ||
    !sameRef(gate.obligation_ledger_ref, input.ledger_ref) ||
    !sameRef(gate.manifest_core_ref, input.core_ref) ||
    !sameRef(gate.qualification_ref, input.qualification_ref) ||
    !sameRef(gate.admission_evidence_ref, input.admission_evidence_ref) ||
    canonicalJson(gate.criterion_results) !==
      canonicalJson(
        SCA_P01_REQUIRED_CRITERION_IDS.map((criterion_id) => ({ criterion_id, status: "PASS" }))
      )
  ) {
    fail(
      "invalid_manifest_binding",
      "P01 gate does not bind the exact core, request, ledger, qualification, and current evidence"
    );
  }
  if (
    !sameRef(manifest.manifest_core_ref, input.core_ref) ||
    !sameRef(manifest.p01_gate_ref, input.gate_ref) ||
    !sameRef(manifest.request_ref, input.request_ref) ||
    !sameRef(manifest.obligation_ledger_ref, input.ledger_ref) ||
    !sameRef(manifest.authority_policy_ref, request.authority_policy_ref)
  ) {
    fail(
      "invalid_manifest_binding",
      "final admitted manifest does not bind the exact pending core and passed gate"
    );
  }
}
