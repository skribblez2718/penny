import { Type, type Static } from "typebox";

import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  ExecutionReceiptSchema,
  RunIdentitySchema,
  validateContract,
  type ArtifactRef,
  type ExecutionReceipt,
} from "../contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  assertOpaqueId,
  assertRfc3339Utc,
  assertText,
  assertUnique,
} from "./common.js";

const MAX_TEXT_BYTES = 32_768;
const MAX_PATH_BYTES = 4_096;
const MAX_ITEMS = 256;
const MAX_EVIDENCE_REFS = 512;
const MAX_SOURCE_BYTES = Number.MAX_SAFE_INTEGER;

const TextSchema = Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES });
const PathSchema = Type.String({ minLength: 1, maxLength: MAX_PATH_BYTES });
const ExtensibleIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$",
});

const FamilyBindingProperties = {
  tenant_id: OpaqueIdSchema,
  project_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  source_snapshot_ref: ArtifactRefSchema,
  config_ref: ArtifactRefSchema,
  provenance_ref: ArtifactRefSchema,
} as const;

export const ScaObligationClassSchema = Type.Union([
  Type.Literal("required_result"),
  Type.Literal("attempt_and_report"),
  Type.Literal("optional"),
]);
export type ScaObligationClass = Static<typeof ScaObligationClassSchema>;

export const ScaMandatoryObligationTypeSchema = Type.Union([
  Type.Literal("deterministic_preparation"),
  Type.Literal("deep_analysis"),
  Type.Literal("execution_disposition"),
  Type.Literal("rule_learning_disposition"),
  Type.Literal("report_validation"),
]);
export type ScaMandatoryObligationType = Static<typeof ScaMandatoryObligationTypeSchema>;

export const SCA_MANDATORY_OBLIGATION_TYPES: readonly ScaMandatoryObligationType[] = Object.freeze([
  "deterministic_preparation",
  "deep_analysis",
  "execution_disposition",
  "rule_learning_disposition",
  "report_validation",
]);

export const ScaObligationStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("active"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("unsupported"),
  Type.Literal("unavailable"),
  Type.Literal("cancelled"),
]);
export type ScaObligationStatus = Static<typeof ScaObligationStatusSchema>;

export const ScaEvidenceClaimClassSchema = Type.Union([
  Type.Literal("fact"),
  Type.Literal("inference"),
  Type.Literal("negative"),
  Type.Literal("finding_confirmation"),
  Type.Literal("finding_rejection"),
  Type.Literal("finding_uncertainty"),
  Type.Literal("obligation_disposition"),
  Type.Literal("gate_completion"),
]);
export type ScaEvidenceClaimClass = Static<typeof ScaEvidenceClaimClassSchema>;

export const ScaEvidenceQualificationStatusSchema = Type.Union([
  Type.Literal("qualified"),
  Type.Literal("unqualified"),
  Type.Literal("unsupported"),
  Type.Literal("unavailable"),
]);
export type ScaEvidenceQualificationStatus = Static<typeof ScaEvidenceQualificationStatusSchema>;

export const ScaEvidenceFailureStatusSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("failed"),
  Type.Literal("timeout"),
  Type.Literal("denied"),
  Type.Literal("unavailable"),
]);
export type ScaEvidenceFailureStatus = Static<typeof ScaEvidenceFailureStatusSchema>;

/** Backend-neutral qualification carried by every evidence product and ledger evidence ref. */
export const ScaFamilyEvidenceQualificationV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-family-evidence-qualification.v1"),
    schema_version: Type.Literal(1),
    family_id: ExtensibleIdSchema,
    family_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    backend_id: ExtensibleIdSchema,
    status: ScaEvidenceQualificationStatusSchema,
    supported_claim_classes: Type.Array(ScaEvidenceClaimClassSchema, {
      minItems: 1,
      maxItems: 16,
    }),
    source_snapshot_ref: ArtifactRefSchema,
    config_ref: ArtifactRefSchema,
    provenance_ref: ArtifactRefSchema,
    complete: Type.Boolean(),
    truncated: Type.Boolean(),
    failure_status: ScaEvidenceFailureStatusSchema,
    fidelity_note: TextSchema,
  },
  { additionalProperties: false }
);
export type ScaFamilyEvidenceQualificationV1 = Readonly<
  Static<typeof ScaFamilyEvidenceQualificationV1Schema>
>;

export const ScaNegativeCoverageV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-negative-coverage.v1"),
    schema_version: Type.Literal(1),
    source_snapshot_ref: ArtifactRefSchema,
    source_snapshot_sha256: Sha256Schema,
    coverage_scope_ref: ArtifactRefSchema,
    status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Literal("unsupported"),
      Type.Literal("unavailable"),
      Type.Literal("failed"),
    ]),
    truncated: Type.Boolean(),
    failure_status: ScaEvidenceFailureStatusSchema,
  },
  { additionalProperties: false }
);
export type ScaNegativeCoverageV1 = Readonly<Static<typeof ScaNegativeCoverageV1Schema>>;

export const ScaObligationV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-obligation.v1"),
    schema_version: Type.Literal(1),
    ...FamilyBindingProperties,
    obligation_id: OpaqueIdSchema,
    obligation_type: ExtensibleIdSchema,
    obligation_class: ScaObligationClassSchema,
    phase_id: OpaqueIdSchema,
    status: ScaObligationStatusSchema,
    required_evidence_classes: Type.Array(ScaEvidenceClaimClassSchema, {
      minItems: 1,
      maxItems: 16,
    }),
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ScaObligationV1 = Readonly<Static<typeof ScaObligationV1Schema>>;

const ScaPolicyRefsV1Schema = Type.Object(
  {
    execution_policy_ref: ArtifactRefSchema,
    test_network_policy_ref: ArtifactRefSchema,
    privacy_policy_ref: ArtifactRefSchema,
    resource_policy_ref: ArtifactRefSchema,
    promotion_policy_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);

export const ScaRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-request.v1"),
    schema_version: Type.Literal(1),
    ...FamilyBindingProperties,
    run_identity: RunIdentitySchema,
    source_snapshot_sha256: Sha256Schema,
    config_sha256: Sha256Schema,
    provenance_sha256: Sha256Schema,
    baseline_rule_bundle_ref: ArtifactRefSchema,
    profile_ref: ArtifactRefSchema,
    authority_ref: ArtifactRefSchema,
    threat_context_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    test_artifacts_dir: PathSchema,
    policy_refs: ScaPolicyRefsV1Schema,
    obligations: Type.Array(ScaObligationV1Schema, {
      minItems: SCA_MANDATORY_OBLIGATION_TYPES.length,
      maxItems: MAX_ITEMS,
    }),
    requested_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ScaRequestV1 = Readonly<Static<typeof ScaRequestV1Schema>>;

const ScaSourceLanguageV1Schema = Type.Object(
  {
    language_id: ExtensibleIdSchema,
    file_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    byte_count: Type.Integer({ minimum: 0, maximum: MAX_SOURCE_BYTES }),
    support_status: Type.Union([
      Type.Literal("supported"),
      Type.Literal("unsupported"),
      Type.Literal("unavailable"),
    ]),
  },
  { additionalProperties: false }
);

export const ScaSourceInventoryV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-source-inventory.v1"),
    schema_version: Type.Literal(1),
    ...FamilyBindingProperties,
    inventory_ref: ArtifactRefSchema,
    file_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    total_bytes: Type.Integer({ minimum: 0, maximum: MAX_SOURCE_BYTES }),
    languages: Type.Array(ScaSourceLanguageV1Schema, { maxItems: MAX_ITEMS }),
    status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("partial"),
      Type.Literal("unsupported"),
      Type.Literal("unavailable"),
      Type.Literal("failed"),
    ]),
    truncated: Type.Boolean(),
    failure_status: ScaEvidenceFailureStatusSchema,
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ScaSourceInventoryV1 = Readonly<Static<typeof ScaSourceInventoryV1Schema>>;

export const ScaEvidenceProductV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-evidence-product.v1"),
    schema_version: Type.Literal(1),
    ...FamilyBindingProperties,
    evidence_product_id: OpaqueIdSchema,
    obligation_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    status: ScaEvidenceQualificationStatusSchema,
    evidence_ref: ArtifactRefSchema,
    raw_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    qualification: ScaFamilyEvidenceQualificationV1Schema,
    negative_coverage: Type.Union([ScaNegativeCoverageV1Schema, Type.Null()]),
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ScaEvidenceProductV1 = Readonly<Static<typeof ScaEvidenceProductV1Schema>>;

export const ScaDispositionStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("not_needed"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("unsupported"),
  Type.Literal("unavailable"),
  Type.Literal("cancelled"),
]);
export type ScaDispositionStatus = Static<typeof ScaDispositionStatusSchema>;

export const ScaDispositionV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-disposition.v1"),
    schema_version: Type.Literal(1),
    ...FamilyBindingProperties,
    disposition_id: OpaqueIdSchema,
    obligation_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    status: ScaDispositionStatusSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, {
      minItems: 1,
      maxItems: MAX_EVIDENCE_REFS,
    }),
    execution_receipt: Type.Union([ExecutionReceiptSchema, Type.Null()]),
    rationale: TextSchema,
    disposed_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ScaDispositionV1 = Readonly<Static<typeof ScaDispositionV1Schema>>;

export const ScaReportStatusSchema = Type.Union([
  Type.Literal("validated"),
  Type.Literal("incomplete"),
  Type.Literal("failed"),
  Type.Literal("unsupported"),
  Type.Literal("unavailable"),
]);
export type ScaReportStatus = Static<typeof ScaReportStatusSchema>;

export const ScaReportV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-report.v1"),
    schema_version: Type.Literal(1),
    ...FamilyBindingProperties,
    report_id: OpaqueIdSchema,
    status: ScaReportStatusSchema,
    reconciliation_ref: ArtifactRefSchema,
    markdown_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    json_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    sarif_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    validation_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    validated_at: Type.Union([Rfc3339UtcSchema, Type.Null()]),
  },
  { additionalProperties: false }
);
export type ScaReportV1 = Readonly<Static<typeof ScaReportV1Schema>>;

export const ScaRunModelStatusSchema = Type.Union([
  Type.Literal("resolved"),
  Type.Literal("unsupported"),
  Type.Literal("unavailable"),
  Type.Literal("failed"),
]);
export type ScaRunModelStatus = Static<typeof ScaRunModelStatusSchema>;

export const ScaRunModelV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-run-model.v1"),
    schema_version: Type.Literal(1),
    ...FamilyBindingProperties,
    run_identity: RunIdentitySchema,
    status: ScaRunModelStatusSchema,
    model_alias: OpaqueIdSchema,
    provider: OpaqueIdSchema,
    resolved_model: OpaqueIdSchema,
    resolution_ref: ArtifactRefSchema,
    execution_receipts: Type.Array(ExecutionReceiptSchema, { maxItems: MAX_ITEMS }),
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ScaRunModelV1 = Readonly<Static<typeof ScaRunModelV1Schema>>;

export const ScaCompletionStatusSchema = Type.Union([
  Type.Literal("complete"),
  Type.Literal("incomplete"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("cancelled"),
]);
export type ScaCompletionStatus = Static<typeof ScaCompletionStatusSchema>;

export const ScaCompletionV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-completion.v1"),
    schema_version: Type.Literal(1),
    ...FamilyBindingProperties,
    completion_id: OpaqueIdSchema,
    status: ScaCompletionStatusSchema,
    request_ref: ArtifactRefSchema,
    obligations: Type.Array(ScaObligationV1Schema, {
      minItems: SCA_MANDATORY_OBLIGATION_TYPES.length,
      maxItems: MAX_ITEMS,
    }),
    dispositions: Type.Array(ScaDispositionV1Schema, { maxItems: MAX_ITEMS }),
    report: ScaReportV1Schema,
    run_model: ScaRunModelV1Schema,
    unresolved_obligation_ids: Type.Array(OpaqueIdSchema, { maxItems: MAX_ITEMS }),
    completed_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ScaCompletionV1 = Readonly<Static<typeof ScaCompletionV1Schema>>;

export const SCA_VERSION_FAMILY_TABLE = Object.freeze([
  Object.freeze({ family: "request", schema_id: "penny.sca-request.v1", schema_version: 1 }),
  Object.freeze({
    family: "source_inventory",
    schema_id: "penny.sca-source-inventory.v1",
    schema_version: 1,
  }),
  Object.freeze({
    family: "evidence_product",
    schema_id: "penny.sca-evidence-product.v1",
    schema_version: 1,
  }),
  Object.freeze({
    family: "obligation",
    schema_id: "penny.sca-obligation.v1",
    schema_version: 1,
  }),
  Object.freeze({
    family: "disposition",
    schema_id: "penny.sca-disposition.v1",
    schema_version: 1,
  }),
  Object.freeze({ family: "report", schema_id: "penny.sca-report.v1", schema_version: 1 }),
  Object.freeze({
    family: "completion",
    schema_id: "penny.sca-completion.v1",
    schema_version: 1,
  }),
  Object.freeze({
    family: "run_model",
    schema_id: "penny.sca-run-model.v1",
    schema_version: 1,
  }),
] as const);

export const SCA_PRODUCER_CONSUMER_TABLE = Object.freeze([
  Object.freeze({
    family: "request",
    producer: "sca_admission",
    consumers: Object.freeze(["source_admission", "controller", "completion"]),
  }),
  Object.freeze({
    family: "source_inventory",
    producer: "source_owner",
    consumers: Object.freeze(["static_analysis", "deep_analysis", "reporting"]),
  }),
  Object.freeze({
    family: "evidence_product",
    producer: "analysis_backends",
    consumers: Object.freeze(["ledger", "adjudication", "reporting"]),
  }),
  Object.freeze({
    family: "obligation",
    producer: "sca_admission_controller",
    consumers: Object.freeze(["phase_owners", "completion"]),
  }),
  Object.freeze({
    family: "disposition",
    producer: "host_adjudication",
    consumers: Object.freeze(["gate", "reporting", "completion", "rule_learning"]),
  }),
  Object.freeze({
    family: "report",
    producer: "report_owner",
    consumers: Object.freeze(["completion", "export"]),
  }),
  Object.freeze({
    family: "completion",
    producer: "completion_owner",
    consumers: Object.freeze(["status", "release"]),
  }),
  Object.freeze({
    family: "run_model",
    producer: "model_admission",
    consumers: Object.freeze(["phase_execution", "completion", "reporting"]),
  }),
] as const);

export class ScaContractValidationError extends Error {
  readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super(`${label} failed validation: ${issues.join("; ")}`);
    this.name = "ScaContractValidationError";
    this.issues = issues;
  }
}

export interface ScaReceiptVerifier {
  verify(value: unknown): ExecutionReceipt;
}

export interface ScaContractValidationContext {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly source_snapshot_ref: ArtifactRef;
  readonly config_ref: ArtifactRef;
  readonly provenance_ref: ArtifactRef;
  readonly receipt_verifier?: ScaReceiptVerifier;
}

export interface ScaCompletionValidationContext extends ScaContractValidationContext {
  readonly request: ScaRequestV1;
  readonly request_ref: ArtifactRef;
}

type FamilyBinding = Pick<
  ScaObligationV1,
  "tenant_id" | "project_id" | "run_id" | "source_snapshot_ref" | "config_ref" | "provenance_ref"
>;

function fail(label: string, issue: string): never {
  throw new ScaContractValidationError(label, [issue]);
}

function assertId(value: string, label: string): void {
  assertOpaqueId(value, label);
}

function assertTimestamp(value: string, label: string): void {
  assertRfc3339Utc(value, label);
}

function exactRfc3339UtcSortKey(value: string, label: string): string {
  assertTimestamp(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (match === null) fail(label, "timestamp must be exact RFC3339 UTC with Z");
  const year = match[1];
  const month = match[2];
  const day = match[3];
  const hour = match[4];
  const minute = match[5];
  const second = match[6];
  const fraction = match[7] ?? "";
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    fail(label, "timestamp is malformed");
  }
  return `${year}${month}${day}${hour}${minute}${second}${fraction.padEnd(9, "0")}`;
}

function mandatoryObligationType(value: string): ScaMandatoryObligationType | null {
  switch (value) {
    case "deterministic_preparation":
    case "deep_analysis":
    case "execution_disposition":
    case "rule_learning_disposition":
    case "report_validation":
      return value;
    default:
      return null;
  }
}

function normalizedRunRef(value: unknown, runId: string, label: string): ArtifactRef {
  let ref: ArtifactRef;
  try {
    ref = currentArtifactRef(value, label);
  } catch (error) {
    fail(label, error instanceof Error ? error.message : "artifact ref is invalid");
  }
  if (ref.run_id !== runId) fail(label, "artifact ref belongs to another run");
  return ref;
}

function assertExactRef(
  actual: unknown,
  expected: ArtifactRef,
  runId: string,
  label: string
): void {
  const normalizedActual = normalizedRunRef(actual, runId, label);
  const normalizedExpected = normalizedRunRef(expected, runId, `${label} expected`);
  if (canonicalJson(normalizedActual) !== canonicalJson(normalizedExpected)) {
    fail(label, "artifact ref does not match the frozen binding");
  }
}

function assertFamilyBinding(
  value: FamilyBinding,
  context: ScaContractValidationContext,
  label: string
): void {
  assertId(value.tenant_id, `${label}.tenant_id`);
  assertId(value.project_id, `${label}.project_id`);
  assertId(value.run_id, `${label}.run_id`);
  if (
    value.tenant_id !== context.tenant_id ||
    value.project_id !== context.project_id ||
    value.run_id !== context.run_id
  ) {
    fail(label, "tenant_id/project_id/run_id does not match the frozen run bundle");
  }
  assertExactRef(
    value.source_snapshot_ref,
    context.source_snapshot_ref,
    value.run_id,
    `${label}.source_snapshot_ref`
  );
  assertExactRef(value.config_ref, context.config_ref, value.run_id, `${label}.config_ref`);
  assertExactRef(
    value.provenance_ref,
    context.provenance_ref,
    value.run_id,
    `${label}.provenance_ref`
  );
}

function assertRefs(refs: readonly ArtifactRef[], runId: string, label: string): void {
  const ids: string[] = [];
  for (const ref of refs) ids.push(normalizedRunRef(ref, runId, label).artifact_id);
  assertUnique(ids, label);
}

function assertQualification(
  value: ScaFamilyEvidenceQualificationV1,
  context: ScaContractValidationContext,
  label: string
): void {
  assertId(value.family_id, `${label}.family_id`);
  assertId(value.backend_id, `${label}.backend_id`);
  assertUnique(value.supported_claim_classes, `${label}.supported_claim_classes`);
  assertExactRef(
    value.source_snapshot_ref,
    context.source_snapshot_ref,
    context.run_id,
    `${label}.source_snapshot_ref`
  );
  assertExactRef(value.config_ref, context.config_ref, context.run_id, `${label}.config_ref`);
  assertExactRef(
    value.provenance_ref,
    context.provenance_ref,
    context.run_id,
    `${label}.provenance_ref`
  );
  assertText(value.fidelity_note, `${label}.fidelity_note`, {
    minBytes: 1,
    maxBytes: MAX_TEXT_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  if (
    value.status === "qualified" &&
    (!value.complete || value.truncated || value.failure_status !== "none")
  ) {
    fail(label, "qualified evidence must be complete, nontruncated, and failure-free");
  }
  if (
    value.status !== "qualified" &&
    value.complete &&
    !value.truncated &&
    value.failure_status === "none"
  ) {
    fail(label, "nonqualified evidence cannot present a clean complete qualification");
  }
}

function validateReceipt(
  receiptValue: ExecutionReceipt,
  context: ScaContractValidationContext,
  label: string
): ExecutionReceipt {
  const verifier = context.receipt_verifier;
  if (verifier === undefined) fail(label, "a host receipt verifier is required");
  let receipt: ExecutionReceipt;
  try {
    receipt = verifier.verify(receiptValue);
  } catch (error) {
    fail(label, error instanceof Error ? error.message : "execution receipt verification failed");
  }
  const checked = validateContract(ExecutionReceiptSchema, receipt, label);
  if (checked.run_id !== context.run_id) fail(label, "execution receipt belongs to another run");
  if (
    exactRfc3339UtcSortKey(checked.ended_at, `${label}.ended_at`) <
    exactRfc3339UtcSortKey(checked.started_at, `${label}.started_at`)
  ) {
    fail(label, "execution receipt ended_at precedes started_at");
  }
  const outputRef = normalizedRunRef(
    checked.output_artifact_ref,
    context.run_id,
    `${label}.output_artifact_ref`
  );
  if (checked.output_digest !== outputRef.content_digest) {
    fail(label, "execution receipt output_digest does not match output_artifact_ref");
  }
  return checked;
}

export function validateScaObligation(
  value: unknown,
  context: ScaContractValidationContext
): ScaObligationV1 {
  const obligation = validateContract(ScaObligationV1Schema, value, "SCA obligation");
  assertFamilyBinding(obligation, context, "SCA obligation");
  assertId(obligation.obligation_id, "SCA obligation.obligation_id");
  assertId(obligation.obligation_type, "SCA obligation.obligation_type");
  assertId(obligation.phase_id, "SCA obligation.phase_id");
  assertUnique(obligation.required_evidence_classes, "SCA obligation.required_evidence_classes");
  assertTimestamp(obligation.created_at, "SCA obligation.created_at");
  return obligation;
}

export function validateScaRequest(
  value: unknown,
  context: ScaContractValidationContext
): ScaRequestV1 {
  const request = validateContract(ScaRequestV1Schema, value, "SCA request");
  assertFamilyBinding(request, context, "SCA request");
  if (request.run_identity.run_id !== request.run_id || request.run_identity.playbook !== "sca") {
    fail("SCA request", "run_identity must identify this SCA run");
  }
  if (
    request.source_snapshot_sha256 !== request.source_snapshot_ref.content_digest ||
    request.config_sha256 !== request.config_ref.content_digest ||
    request.provenance_sha256 !== request.provenance_ref.content_digest
  ) {
    fail("SCA request", "snapshot/config/provenance digests must match their exact refs");
  }
  assertText(request.test_artifacts_dir, "SCA request.test_artifacts_dir", {
    minBytes: 1,
    maxBytes: MAX_PATH_BYTES,
    trimmedNonEmpty: true,
  });
  const additionalRefs = [
    request.baseline_rule_bundle_ref,
    request.profile_ref,
    request.authority_ref,
    request.policy_refs.execution_policy_ref,
    request.policy_refs.test_network_policy_ref,
    request.policy_refs.privacy_policy_ref,
    request.policy_refs.resource_policy_ref,
    request.policy_refs.promotion_policy_ref,
    ...(request.threat_context_ref === null ? [] : [request.threat_context_ref]),
  ];
  assertRefs(additionalRefs, request.run_id, "SCA request refs");
  const obligationIds: string[] = [];
  const mandatoryCounts = new Map<ScaMandatoryObligationType, number>(
    SCA_MANDATORY_OBLIGATION_TYPES.map((type) => [type, 0])
  );
  for (const obligationValue of request.obligations) {
    const obligation = validateScaObligation(obligationValue, context);
    obligationIds.push(obligation.obligation_id);
    if (obligation.status !== "pending") {
      fail("SCA request", "request obligations must begin pending");
    }
    const mandatoryType = mandatoryObligationType(obligation.obligation_type);
    if (mandatoryType !== null) {
      mandatoryCounts.set(mandatoryType, (mandatoryCounts.get(mandatoryType) ?? 0) + 1);
      if (obligation.obligation_class !== "required_result") {
        fail("SCA request", `mandatory obligation '${mandatoryType}' must be required_result`);
      }
    }
  }
  assertUnique(obligationIds, "SCA request obligation IDs");
  for (const type of SCA_MANDATORY_OBLIGATION_TYPES) {
    if (mandatoryCounts.get(type) !== 1) {
      fail("SCA request", `mandatory obligation '${type}' must appear exactly once`);
    }
  }
  assertTimestamp(request.requested_at, "SCA request.requested_at");
  return request;
}

export function validateScaSourceInventory(
  value: unknown,
  context: ScaContractValidationContext
): ScaSourceInventoryV1 {
  const inventory = validateContract(ScaSourceInventoryV1Schema, value, "SCA source inventory");
  assertFamilyBinding(inventory, context, "SCA source inventory");
  normalizedRunRef(inventory.inventory_ref, inventory.run_id, "SCA source inventory.inventory_ref");
  assertUnique(
    inventory.languages.map((language) => language.language_id),
    "SCA source inventory languages"
  );
  if (
    inventory.status === "complete" &&
    (inventory.truncated || inventory.failure_status !== "none")
  ) {
    fail("SCA source inventory", "complete inventory must be nontruncated and failure-free");
  }
  assertTimestamp(inventory.recorded_at, "SCA source inventory.recorded_at");
  return inventory;
}

export function validateScaEvidenceProduct(
  value: unknown,
  context: ScaContractValidationContext
): ScaEvidenceProductV1 {
  const product = validateContract(ScaEvidenceProductV1Schema, value, "SCA evidence product");
  assertFamilyBinding(product, context, "SCA evidence product");
  assertId(product.evidence_product_id, "SCA evidence product.evidence_product_id");
  assertId(product.obligation_id, "SCA evidence product.obligation_id");
  assertId(product.phase_id, "SCA evidence product.phase_id");
  normalizedRunRef(product.evidence_ref, product.run_id, "SCA evidence product.evidence_ref");
  if (product.raw_ref !== null) {
    normalizedRunRef(product.raw_ref, product.run_id, "SCA evidence product.raw_ref");
  }
  assertQualification(product.qualification, context, "SCA evidence product.qualification");
  if (product.status !== product.qualification.status) {
    fail("SCA evidence product", "product status must equal qualification status");
  }
  if (product.negative_coverage !== null) {
    assertExactRef(
      product.negative_coverage.source_snapshot_ref,
      context.source_snapshot_ref,
      context.run_id,
      "SCA evidence product.negative_coverage.source_snapshot_ref"
    );
    if (
      product.negative_coverage.source_snapshot_sha256 !==
      product.negative_coverage.source_snapshot_ref.content_digest
    ) {
      fail("SCA evidence product", "negative coverage snapshot digest does not match its ref");
    }
    normalizedRunRef(
      product.negative_coverage.coverage_scope_ref,
      product.run_id,
      "SCA evidence product.negative_coverage.coverage_scope_ref"
    );
  }
  assertTimestamp(product.recorded_at, "SCA evidence product.recorded_at");
  return product;
}

export function validateScaDisposition(
  value: unknown,
  context: ScaContractValidationContext
): ScaDispositionV1 {
  const disposition = validateContract(ScaDispositionV1Schema, value, "SCA disposition");
  assertFamilyBinding(disposition, context, "SCA disposition");
  assertId(disposition.disposition_id, "SCA disposition.disposition_id");
  assertId(disposition.obligation_id, "SCA disposition.obligation_id");
  assertId(disposition.phase_id, "SCA disposition.phase_id");
  assertRefs(disposition.evidence_refs, disposition.run_id, "SCA disposition.evidence_refs");
  assertText(disposition.rationale, "SCA disposition.rationale", {
    minBytes: 1,
    maxBytes: MAX_TEXT_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  if (disposition.execution_receipt !== null) {
    const receipt = validateReceipt(
      disposition.execution_receipt,
      context,
      "SCA disposition.execution_receipt"
    );
    if (
      !disposition.evidence_refs.some(
        (reference) => canonicalJson(reference) === canonicalJson(receipt.output_artifact_ref)
      )
    ) {
      fail(
        "SCA disposition",
        "execution receipt output must be one of the disposition evidence refs"
      );
    }
  }
  assertTimestamp(disposition.disposed_at, "SCA disposition.disposed_at");
  return disposition;
}

export function validateScaReport(
  value: unknown,
  context: ScaContractValidationContext
): ScaReportV1 {
  const report = validateContract(ScaReportV1Schema, value, "SCA report");
  assertFamilyBinding(report, context, "SCA report");
  assertId(report.report_id, "SCA report.report_id");
  normalizedRunRef(report.reconciliation_ref, report.run_id, "SCA report.reconciliation_ref");
  const outputRefs = [
    report.markdown_ref,
    report.json_ref,
    report.sarif_ref,
    report.validation_ref,
  ];
  for (const [index, ref] of outputRefs.entries()) {
    if (ref !== null) normalizedRunRef(ref, report.run_id, `SCA report output ref ${index + 1}`);
  }
  if (
    report.status === "validated" &&
    (outputRefs.some((ref) => ref === null) || report.validated_at === null)
  ) {
    fail("SCA report", "validated report requires Markdown, JSON, SARIF, validation refs and time");
  }
  if (report.status !== "validated" && report.validated_at !== null) {
    fail("SCA report", "only a validated report may carry validated_at");
  }
  if (report.validated_at !== null) assertTimestamp(report.validated_at, "SCA report.validated_at");
  return report;
}

export function validateScaRunModel(
  value: unknown,
  context: ScaContractValidationContext
): ScaRunModelV1 {
  const runModel = validateContract(ScaRunModelV1Schema, value, "SCA run model");
  assertFamilyBinding(runModel, context, "SCA run model");
  if (
    runModel.run_identity.run_id !== runModel.run_id ||
    runModel.run_identity.playbook !== "sca"
  ) {
    fail("SCA run model", "run_identity must identify this SCA run");
  }
  normalizedRunRef(runModel.resolution_ref, runModel.run_id, "SCA run model.resolution_ref");
  const receiptIds: string[] = [];
  for (const receiptValue of runModel.execution_receipts) {
    const receipt = validateReceipt(receiptValue, context, "SCA run model execution receipt");
    receiptIds.push(receipt.receipt_id);
  }
  assertUnique(receiptIds, "SCA run model receipt IDs");
  assertTimestamp(runModel.recorded_at, "SCA run model.recorded_at");
  return runModel;
}

function sameObligationDeclaration(left: ScaObligationV1, right: ScaObligationV1): boolean {
  return (
    left.obligation_id === right.obligation_id &&
    left.obligation_type === right.obligation_type &&
    left.obligation_class === right.obligation_class &&
    left.phase_id === right.phase_id &&
    canonicalJson(left.required_evidence_classes) ===
      canonicalJson(right.required_evidence_classes) &&
    left.created_at === right.created_at &&
    canonicalJson(left.source_snapshot_ref) === canonicalJson(right.source_snapshot_ref) &&
    canonicalJson(left.config_ref) === canonicalJson(right.config_ref) &&
    canonicalJson(left.provenance_ref) === canonicalJson(right.provenance_ref)
  );
}

function isTerminalObligation(status: ScaObligationStatus): boolean {
  return status !== "pending" && status !== "active";
}

function dispositionMatchesObligation(
  obligation: ScaObligationV1,
  disposition: ScaDispositionV1
): boolean {
  if (disposition.status === obligation.status) return true;
  return (
    obligation.status === "completed" &&
    disposition.status === "not_needed" &&
    (obligation.obligation_class === "optional" ||
      obligation.obligation_type === "execution_disposition")
  );
}

export function validateScaCompletion(
  value: unknown,
  context: ScaCompletionValidationContext
): ScaCompletionV1 {
  const completion = validateContract(ScaCompletionV1Schema, value, "SCA completion");
  assertFamilyBinding(completion, context, "SCA completion");
  const request = validateScaRequest(context.request, context);
  assertExactRef(
    completion.request_ref,
    context.request_ref,
    completion.run_id,
    "SCA completion.request_ref"
  );
  const obligations = new Map<string, ScaObligationV1>();
  for (const obligationValue of completion.obligations) {
    const obligation = validateScaObligation(obligationValue, context);
    if (obligations.has(obligation.obligation_id))
      fail("SCA completion", "duplicate obligation ID");
    obligations.set(obligation.obligation_id, obligation);
  }
  if (obligations.size !== request.obligations.length) {
    fail("SCA completion", "completion must include every request obligation exactly once");
  }
  for (const declared of request.obligations) {
    const completed = obligations.get(declared.obligation_id);
    if (completed === undefined || !sameObligationDeclaration(declared, completed)) {
      fail("SCA completion", `obligation '${declared.obligation_id}' does not match the request`);
    }
  }
  const dispositions = new Map<string, ScaDispositionV1>();
  for (const dispositionValue of completion.dispositions) {
    const disposition = validateScaDisposition(dispositionValue, context);
    if (dispositions.has(disposition.obligation_id)) {
      fail("SCA completion", "an obligation has more than one disposition");
    }
    const obligation = obligations.get(disposition.obligation_id);
    if (obligation === undefined) {
      fail("SCA completion", "disposition targets an undeclared obligation");
    }
    if (disposition.phase_id !== obligation.phase_id) {
      fail("SCA completion", "disposition phase does not match its obligation");
    }
    dispositions.set(disposition.obligation_id, disposition);
  }
  const report = validateScaReport(completion.report, context);
  const runModel = validateScaRunModel(completion.run_model, context);
  assertUnique(completion.unresolved_obligation_ids, "SCA completion unresolved obligation IDs");
  for (const unresolvedId of completion.unresolved_obligation_ids) {
    if (!obligations.has(unresolvedId)) {
      fail("SCA completion", `unresolved obligation '${unresolvedId}' is undeclared`);
    }
  }
  const expectedUnresolvedIds: string[] = [];
  for (const obligation of obligations.values()) {
    const disposition = dispositions.get(obligation.obligation_id);
    if (!isTerminalObligation(obligation.status)) {
      expectedUnresolvedIds.push(obligation.obligation_id);
      if (disposition !== undefined) {
        fail("SCA completion", `open obligation '${obligation.obligation_id}' has a disposition`);
      }
      continue;
    }
    if (disposition === undefined) {
      fail("SCA completion", `terminal obligation '${obligation.obligation_id}' lacks disposition`);
    }
    if (!dispositionMatchesObligation(obligation, disposition)) {
      fail(
        "SCA completion",
        `obligation '${obligation.obligation_id}' has a contradictory disposition`
      );
    }
  }
  if (
    canonicalJson([...completion.unresolved_obligation_ids].sort()) !==
    canonicalJson(expectedUnresolvedIds.sort())
  ) {
    fail("SCA completion", "unresolved_obligation_ids must exactly list every open obligation");
  }

  if (completion.status === "complete") {
    if (completion.unresolved_obligation_ids.length !== 0) {
      fail("SCA completion", "complete result cannot retain unresolved obligations");
    }
    for (const obligation of obligations.values()) {
      const disposition = dispositions.get(obligation.obligation_id);
      if (disposition === undefined) {
        fail("SCA completion", `obligation '${obligation.obligation_id}' is omitted`);
      }
      if (obligation.obligation_class === "required_result") {
        const acceptableDisposition =
          disposition.status === "completed" ||
          (obligation.obligation_type === "execution_disposition" &&
            disposition.status === "not_needed");
        if (obligation.status !== "completed" || !acceptableDisposition) {
          fail(
            "SCA completion",
            `required_result obligation '${obligation.obligation_id}' is not completed`
          );
        }
      } else if (!isTerminalObligation(obligation.status)) {
        fail("SCA completion", `obligation '${obligation.obligation_id}' is not terminal`);
      }
    }
    if (report.status !== "validated") {
      fail("SCA completion", "complete result requires a validated report");
    }
    if (runModel.status !== "resolved") {
      fail("SCA completion", "complete result requires a resolved run model");
    }
  }
  assertTimestamp(completion.completed_at, "SCA completion.completed_at");
  return { ...completion, report, run_model: runModel };
}
