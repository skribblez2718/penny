import { Type, type Static } from "typebox";

import { currentArtifactRef } from "../artifact-store.js";
import { canonicalJson } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  ConfidenceSchema,
  ContractValidationError,
  validateContract,
} from "../contracts.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  assertOpaqueId,
  assertText,
  assertUnique,
} from "../skill-contracts/common.js";
import {
  ScaEvidenceClaimClassSchema,
  ScaFamilyEvidenceQualificationV1Schema,
  ScaNegativeCoverageV1Schema,
  type ScaFamilyEvidenceQualificationV1,
  type ScaNegativeCoverageV1,
} from "../skill-contracts/sca.js";

const MAX_TEXT_BYTES = 32_768;
const MAX_TITLE_BYTES = 512;
const MAX_TYPE_BYTES = 128;
const MAX_REFERENCES = 512;
const MAX_CITATIONS = 256;
export const SCA_MAX_LEDGER_RECORDS = 128 as const;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const BoundedTextSchema = Type.String({ minLength: 1, maxLength: MAX_TEXT_BYTES });
const TitleSchema = Type.String({ minLength: 1, maxLength: MAX_TITLE_BYTES });
const ExtensibleTypeSchema = Type.String({
  minLength: 1,
  maxLength: MAX_TYPE_BYTES,
  pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
});
const PositiveVersionSchema = Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER });
const SequenceSchema = Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER });
const IdArraySchema = Type.Array(OpaqueIdSchema, { maxItems: MAX_REFERENCES });
const NonEmptyIdArraySchema = Type.Array(OpaqueIdSchema, {
  minItems: 1,
  maxItems: MAX_REFERENCES,
});
const NullableIdSchema = Type.Union([OpaqueIdSchema, Type.Null()]);

export const TaskStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("active"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("unsupported"),
  Type.Literal("unavailable"),
  Type.Literal("rejected"),
  Type.Literal("cancelled"),
]);
export type TaskStatus = Static<typeof TaskStatusSchema>;

export const ClaimStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("asserted"),
  Type.Literal("accepted"),
  Type.Literal("rejected"),
]);
export type ClaimStatus = Static<typeof ClaimStatusSchema>;

export const FindingStatusSchema = Type.Union([
  Type.Literal("candidate"),
  Type.Literal("investigating"),
  Type.Literal("confirmed"),
  Type.Literal("rejected_with_evidence"),
  Type.Literal("inconclusive"),
  Type.Literal("deferred"),
  Type.Literal("duplicate"),
  Type.Literal("out_of_scope"),
]);
export type FindingStatus = Static<typeof FindingStatusSchema>;

export const CitationClassSchema = Type.Union([
  Type.Literal("source"),
  Type.Literal("spatial"),
  Type.Literal("causal"),
]);
export type CitationClass = Static<typeof CitationClassSchema>;

export const SCA_POINTER_END_SEMANTICS = "exclusive" as const;

export const ByteCitationPointerV1Schema = Type.Object(
  {
    pointer_type: Type.Literal("byte_range"),
    start_byte: Type.Integer({ minimum: 0, maximum: MAX_SAFE_INTEGER }),
    end_byte_exclusive: Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false }
);
export type ByteCitationPointerV1 = Readonly<Static<typeof ByteCitationPointerV1Schema>>;

const LineColumnPositionV1Schema = Type.Object(
  {
    line: Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER }),
    column: Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false }
);

export const LineColumnCitationPointerV1Schema = Type.Object(
  {
    pointer_type: Type.Literal("line_column_range"),
    start: LineColumnPositionV1Schema,
    end_exclusive: LineColumnPositionV1Schema,
  },
  { additionalProperties: false }
);
export type LineColumnCitationPointerV1 = Readonly<
  Static<typeof LineColumnCitationPointerV1Schema>
>;

export const CitationPointerV1Schema = Type.Union([
  ByteCitationPointerV1Schema,
  LineColumnCitationPointerV1Schema,
]);
export type CitationPointerV1 = Static<typeof CitationPointerV1Schema>;

export const CitationV1Schema = Type.Object(
  {
    citation_id: OpaqueIdSchema,
    citation_class: CitationClassSchema,
    pointer: CitationPointerV1Schema,
  },
  { additionalProperties: false }
);
export type CitationV1 = Readonly<Static<typeof CitationV1Schema>>;

export const TaskRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-task-record.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    task_id: OpaqueIdSchema,
    obligation_id: OpaqueIdSchema,
    task_type: ExtensibleTypeSchema,
    task_type_version: PositiveVersionSchema,
    obligation_class: Type.Union([
      Type.Literal("required_result"),
      Type.Literal("attempt_and_report"),
      Type.Literal("optional"),
    ]),
    title: TitleSchema,
    status: TaskStatusSchema,
    decision_id: NullableIdSchema,
    version: PositiveVersionSchema,
    sequence: SequenceSchema,
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type TaskRecordV1 = Readonly<Static<typeof TaskRecordV1Schema>>;
export const TaskRecordSchema = TaskRecordV1Schema;
export type TaskRecord = TaskRecordV1;

const InferenceDisclosureV1Schema = Type.Object(
  {
    basis_claim_ids: NonEmptyIdArraySchema,
    rationale: BoundedTextSchema,
  },
  { additionalProperties: false }
);

export const ClaimRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-claim-record.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    claim_id: OpaqueIdSchema,
    task_id: OpaqueIdSchema,
    claim_class: Type.Union([
      Type.Literal("fact"),
      Type.Literal("inference"),
      Type.Literal("negative"),
    ]),
    subject_class: Type.Union([
      Type.Literal("general"),
      Type.Literal("source"),
      Type.Literal("spatial"),
      Type.Literal("causal"),
    ]),
    statement: BoundedTextSchema,
    confidence: ConfidenceSchema,
    evidence_ids: IdArraySchema,
    inference_disclosure: Type.Union([InferenceDisclosureV1Schema, Type.Null()]),
    status: ClaimStatusSchema,
    decision_id: NullableIdSchema,
    version: PositiveVersionSchema,
    sequence: SequenceSchema,
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ClaimRecordV1 = Readonly<Static<typeof ClaimRecordV1Schema>>;
export const ClaimRecordSchema = ClaimRecordV1Schema;
export type ClaimRecord = ClaimRecordV1;

export const EvidenceRefV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-evidence-ref.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    evidence_id: OpaqueIdSchema,
    task_id: OpaqueIdSchema,
    evidence_kind: Type.Union([
      Type.Literal("observation"),
      Type.Literal("coverage"),
      Type.Literal("counterevidence"),
      Type.Literal("execution"),
      Type.Literal("decision"),
    ]),
    artifact_ref: ArtifactRefSchema,
    claim_classes: Type.Array(ScaEvidenceClaimClassSchema, { minItems: 1, maxItems: 16 }),
    qualification: ScaFamilyEvidenceQualificationV1Schema,
    negative_coverage: Type.Union([ScaNegativeCoverageV1Schema, Type.Null()]),
    citations: Type.Array(CitationV1Schema, { minItems: 1, maxItems: MAX_CITATIONS }),
    summary: BoundedTextSchema,
    version: Type.Literal(1),
    sequence: SequenceSchema,
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type EvidenceRefV1 = Readonly<Static<typeof EvidenceRefV1Schema>>;
export const EvidenceRefSchema = EvidenceRefV1Schema;
export type EvidenceRef = EvidenceRefV1;

const FindingInvestigationV1Schema = Type.Object(
  {
    hypothesis: BoundedTextSchema,
    competing_explanations: Type.Array(BoundedTextSchema, { minItems: 1, maxItems: 16 }),
    expected_observations: Type.Array(BoundedTextSchema, { minItems: 1, maxItems: 16 }),
    stop_conditions: Type.Array(BoundedTextSchema, { minItems: 1, maxItems: 16 }),
    reopening_conditions: Type.Array(BoundedTextSchema, { minItems: 1, maxItems: 16 }),
  },
  { additionalProperties: false }
);

export const FindingRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-finding-record.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    finding_id: OpaqueIdSchema,
    task_id: OpaqueIdSchema,
    finding_type: ExtensibleTypeSchema,
    finding_type_version: PositiveVersionSchema,
    title: TitleSchema,
    severity: Type.Union([
      Type.Literal("critical"),
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
      Type.Literal("none"),
      Type.Literal("informational"),
      Type.Literal("unscored"),
      Type.Literal("not_applicable"),
    ]),
    confidence: ConfidenceSchema,
    claim_ids: NonEmptyIdArraySchema,
    evidence_ids: IdArraySchema,
    investigation: Type.Union([FindingInvestigationV1Schema, Type.Null()]),
    status: FindingStatusSchema,
    duplicate_of: NullableIdSchema,
    decision_id: NullableIdSchema,
    version: PositiveVersionSchema,
    sequence: SequenceSchema,
    created_at: Rfc3339UtcSchema,
    updated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type FindingRecordV1 = Readonly<Static<typeof FindingRecordV1Schema>>;
export const FindingRecordSchema = FindingRecordV1Schema;
export type FindingRecord = FindingRecordV1;

export const DecisionRecordV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-decision-record.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    decision_id: OpaqueIdSchema,
    task_id: OpaqueIdSchema,
    decision_type: Type.Union([
      Type.Literal("task_disposition"),
      Type.Literal("claim_disposition"),
      Type.Literal("finding_disposition"),
      Type.Literal("gate_disposition"),
    ]),
    outcome: Type.Union([
      Type.Literal("approved"),
      Type.Literal("rejected"),
      Type.Literal("deferred"),
      Type.Literal("blocked"),
    ]),
    claim_ids: IdArraySchema,
    finding_ids: IdArraySchema,
    evidence_ids: NonEmptyIdArraySchema,
    rationale: BoundedTextSchema,
    confidence: ConfidenceSchema,
    version: Type.Literal(1),
    sequence: SequenceSchema,
    recorded_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type DecisionRecordV1 = Readonly<Static<typeof DecisionRecordV1Schema>>;
export const DecisionRecordSchema = DecisionRecordV1Schema;
export type DecisionRecord = DecisionRecordV1;

export const GateResultV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-gate-result.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    gate_id: OpaqueIdSchema,
    gate_type: ExtensibleTypeSchema,
    gate_type_version: PositiveVersionSchema,
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("blocked")]),
    task_ids: NonEmptyIdArraySchema,
    decision_ids: NonEmptyIdArraySchema,
    evidence_ids: NonEmptyIdArraySchema,
    summary: BoundedTextSchema,
    version: Type.Literal(1),
    sequence: SequenceSchema,
    evaluated_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type GateResultV1 = Readonly<Static<typeof GateResultV1Schema>>;
export const GateResultSchema = GateResultV1Schema;
export type GateResult = GateResultV1;

export const ManifestRecordTypeSchema = Type.Union([
  Type.Literal("task"),
  Type.Literal("claim"),
  Type.Literal("evidence"),
  Type.Literal("finding"),
  Type.Literal("decision"),
  Type.Literal("gate"),
]);
export type ManifestRecordType = Static<typeof ManifestRecordTypeSchema>;

export const ManifestRecordLocatorV1Schema = Type.Object(
  {
    record_type: ManifestRecordTypeSchema,
    record_id: OpaqueIdSchema,
    record_version: PositiveVersionSchema,
    sequence: SequenceSchema,
  },
  { additionalProperties: false }
);
export type ManifestRecordLocatorV1 = Readonly<Static<typeof ManifestRecordLocatorV1Schema>>;

export const ManifestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-manifest.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    manifest_id: OpaqueIdSchema,
    records: Type.Array(ManifestRecordLocatorV1Schema, {
      minItems: 1,
      maxItems: SCA_MAX_LEDGER_RECORDS,
    }),
    record_count: Type.Integer({ minimum: 1, maximum: SCA_MAX_LEDGER_RECORDS }),
    first_sequence: SequenceSchema,
    last_sequence: SequenceSchema,
    ledger_sha256: Sha256Schema,
    created_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ManifestV1 = Readonly<Static<typeof ManifestV1Schema>>;
export const ManifestSchema = ManifestV1Schema;
export type Manifest = ManifestV1;

export const ScaDomainRecordV1Schema = Type.Union([
  TaskRecordV1Schema,
  ClaimRecordV1Schema,
  EvidenceRefV1Schema,
  FindingRecordV1Schema,
  DecisionRecordV1Schema,
  GateResultV1Schema,
]);
export type ScaDomainRecordV1 = Static<typeof ScaDomainRecordV1Schema>;

export const ScaNdjsonRecordV1Schema = Type.Union([ScaDomainRecordV1Schema, ManifestV1Schema]);
export type ScaNdjsonRecordV1 = Static<typeof ScaNdjsonRecordV1Schema>;

export const ScaDomainBundleV1Schema = Type.Object(
  {
    manifest: ManifestV1Schema,
    tasks: Type.Array(TaskRecordV1Schema, { maxItems: SCA_MAX_LEDGER_RECORDS }),
    claims: Type.Array(ClaimRecordV1Schema, { maxItems: SCA_MAX_LEDGER_RECORDS }),
    evidence: Type.Array(EvidenceRefV1Schema, { maxItems: SCA_MAX_LEDGER_RECORDS }),
    findings: Type.Array(FindingRecordV1Schema, { maxItems: SCA_MAX_LEDGER_RECORDS }),
    decisions: Type.Array(DecisionRecordV1Schema, { maxItems: SCA_MAX_LEDGER_RECORDS }),
    gates: Type.Array(GateResultV1Schema, { maxItems: SCA_MAX_LEDGER_RECORDS }),
  },
  { additionalProperties: false }
);
export type ScaDomainBundleV1 = Readonly<Static<typeof ScaDomainBundleV1Schema>>;

export class ScaDomainValidationError extends Error {
  readonly issues: readonly string[];

  constructor(label: string, issues: readonly string[]) {
    super(`${label} failed validation: ${issues.join("; ")}`);
    this.name = "ScaDomainValidationError";
    this.issues = issues;
  }
}

function fail(label: string, issue: string): never {
  throw new ScaDomainValidationError(label, [issue]);
}

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(label, "value must be a positive safe integer");
  }
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(label, "value must be a non-negative safe integer");
  }
}

function assertIdentity(
  tenantId: string,
  projectId: string,
  runId: string,
  phaseId: string,
  recordId: string,
  label: string
): void {
  assertOpaqueId(tenantId, `${label}.tenant_id`);
  assertOpaqueId(projectId, `${label}.project_id`);
  assertOpaqueId(runId, `${label}.run_id`);
  assertOpaqueId(phaseId, `${label}.phase_id`);
  assertOpaqueId(recordId, `${label} identity`);
}

interface Rfc3339UtcParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly nanosecond: number;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function parseRfc3339Utc(value: string, label: string): Rfc3339UtcParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (match === null) fail(label, "timestamp must be exact RFC3339 UTC with Z");
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  const hourText = match[4];
  const minuteText = match[5];
  const secondText = match[6];
  const fractionText = match[7] ?? "";
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  ) {
    fail(label, "timestamp is malformed");
  }
  const parts: Rfc3339UtcParts = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText),
    nanosecond: Number(fractionText.padEnd(9, "0")),
  };
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > daysInMonth(parts.year, parts.month) ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    fail(label, "timestamp is not a real UTC instant");
  }
  return parts;
}

/** Compare exact RFC3339 UTC instants without losing any of the permitted nine fractional digits. */
export function compareRfc3339Utc(left: string, right: string): -1 | 0 | 1 {
  const leftParts = parseRfc3339Utc(left, "left timestamp");
  const rightParts = parseRfc3339Utc(right, "right timestamp");
  for (const key of ["year", "month", "day", "hour", "minute", "second", "nanosecond"] as const) {
    if (leftParts[key] < rightParts[key]) return -1;
    if (leftParts[key] > rightParts[key]) return 1;
  }
  return 0;
}

function assertTimestamp(value: string, label: string): void {
  parseRfc3339Utc(value, label);
}

function assertRecordClock(
  createdAt: string,
  updatedAt: string,
  version: number,
  label: string
): void {
  assertTimestamp(createdAt, `${label}.created_at`);
  assertTimestamp(updatedAt, `${label}.updated_at`);
  const comparison = compareRfc3339Utc(updatedAt, createdAt);
  if (comparison < 0 || (version === 1 && comparison !== 0)) {
    fail(label, "updated_at must equal created_at at version 1 and never precede it");
  }
}

function assertIdArray(values: readonly string[], label: string): void {
  assertUnique(values, label);
  for (const value of values) assertOpaqueId(value, label);
}

function assertDecisionBinding(terminal: boolean, decisionId: string | null, label: string): void {
  if (terminal !== (decisionId !== null)) {
    fail(label, "decision_id must be present exactly when status is terminal");
  }
}

function isTaskTerminal(status: TaskStatus): boolean {
  return status !== "pending" && status !== "active";
}

function isClaimTerminal(status: ClaimStatus): boolean {
  return status === "accepted" || status === "rejected";
}

function isFindingTerminal(status: FindingStatus): boolean {
  return status !== "candidate" && status !== "investigating";
}

export function validateTaskRecord(value: unknown): TaskRecordV1 {
  const record = validateContract(TaskRecordV1Schema, value, "SCA task record");
  assertIdentity(
    record.tenant_id,
    record.project_id,
    record.run_id,
    record.phase_id,
    record.task_id,
    "SCA task record"
  );
  assertOpaqueId(record.obligation_id, "SCA task record.obligation_id");
  assertOpaqueId(record.task_type, "SCA task record.task_type");
  assertText(record.title, "SCA task record.title", {
    minBytes: 1,
    maxBytes: MAX_TITLE_BYTES,
    trimmedNonEmpty: true,
  });
  assertSafePositiveInteger(record.task_type_version, "SCA task record.task_type_version");
  assertSafePositiveInteger(record.version, "SCA task record.version");
  assertSafePositiveInteger(record.sequence, "SCA task record.sequence");
  assertRecordClock(record.created_at, record.updated_at, record.version, "SCA task record");
  if (record.version === 1 && record.status !== "pending") {
    fail("SCA task record", "version 1 task status must be pending");
  }
  assertDecisionBinding(isTaskTerminal(record.status), record.decision_id, "SCA task record");
  return record;
}

export function validateClaimRecord(value: unknown): ClaimRecordV1 {
  const record = validateContract(ClaimRecordV1Schema, value, "SCA claim record");
  assertIdentity(
    record.tenant_id,
    record.project_id,
    record.run_id,
    record.phase_id,
    record.claim_id,
    "SCA claim record"
  );
  assertOpaqueId(record.task_id, "SCA claim record.task_id");
  assertText(record.statement, "SCA claim record.statement", {
    minBytes: 1,
    maxBytes: MAX_TEXT_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  assertIdArray(record.evidence_ids, "SCA claim record.evidence_ids");
  if (record.claim_class === "inference") {
    if (record.inference_disclosure === null) {
      fail("SCA claim record", "inference claims require inference_disclosure");
    }
    assertIdArray(
      record.inference_disclosure.basis_claim_ids,
      "SCA claim record.inference_disclosure.basis_claim_ids"
    );
    assertText(record.inference_disclosure.rationale, "SCA claim inference rationale", {
      minBytes: 1,
      maxBytes: MAX_TEXT_BYTES,
      multiline: true,
      trimmedNonEmpty: true,
    });
    if (record.inference_disclosure.basis_claim_ids.includes(record.claim_id)) {
      fail("SCA claim record", "an inference cannot cite itself as a basis claim");
    }
  } else if (record.inference_disclosure !== null) {
    fail("SCA claim record", "only inference claims may carry inference_disclosure");
  }
  assertSafePositiveInteger(record.version, "SCA claim record.version");
  assertSafePositiveInteger(record.sequence, "SCA claim record.sequence");
  assertRecordClock(record.created_at, record.updated_at, record.version, "SCA claim record");
  if (record.version === 1 && record.status !== "draft") {
    fail("SCA claim record", "version 1 claim status must be draft");
  }
  assertDecisionBinding(isClaimTerminal(record.status), record.decision_id, "SCA claim record");
  return record;
}

function assertCitationPointer(pointer: CitationPointerV1, label: string): void {
  if (pointer.pointer_type === "byte_range") {
    assertSafeNonNegativeInteger(pointer.start_byte, `${label}.start_byte`);
    assertSafePositiveInteger(pointer.end_byte_exclusive, `${label}.end_byte_exclusive`);
    if (pointer.start_byte >= pointer.end_byte_exclusive) {
      fail(label, "byte range must be non-empty and increasing");
    }
    return;
  }
  assertSafePositiveInteger(pointer.start.line, `${label}.start.line`);
  assertSafePositiveInteger(pointer.start.column, `${label}.start.column`);
  assertSafePositiveInteger(pointer.end_exclusive.line, `${label}.end_exclusive.line`);
  assertSafePositiveInteger(pointer.end_exclusive.column, `${label}.end_exclusive.column`);
  if (
    pointer.start.line > pointer.end_exclusive.line ||
    (pointer.start.line === pointer.end_exclusive.line &&
      pointer.start.column >= pointer.end_exclusive.column)
  ) {
    fail(label, "line/column range must be non-empty and increasing");
  }
}

function qualificationRef(
  value: unknown,
  runId: string,
  label: string
): ReturnType<typeof currentArtifactRef> {
  let ref: ReturnType<typeof currentArtifactRef>;
  try {
    ref = currentArtifactRef(value, label);
  } catch (error) {
    fail(label, error instanceof Error ? error.message : "artifact ref is invalid");
  }
  if (ref.run_id !== runId) fail(label, "artifact ref belongs to another run");
  return ref;
}

function validateEvidenceQualification(
  qualification: ScaFamilyEvidenceQualificationV1,
  runId: string,
  label: string
): void {
  assertOpaqueId(qualification.family_id, `${label}.family_id`);
  assertOpaqueId(qualification.backend_id, `${label}.backend_id`);
  assertUnique(qualification.supported_claim_classes, `${label}.supported_claim_classes`);
  qualificationRef(qualification.source_snapshot_ref, runId, `${label}.source_snapshot_ref`);
  qualificationRef(qualification.config_ref, runId, `${label}.config_ref`);
  qualificationRef(qualification.provenance_ref, runId, `${label}.provenance_ref`);
  assertText(qualification.fidelity_note, `${label}.fidelity_note`, {
    minBytes: 1,
    maxBytes: MAX_TEXT_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  if (
    qualification.status === "qualified" &&
    (!qualification.complete || qualification.truncated || qualification.failure_status !== "none")
  ) {
    fail(label, "qualified evidence must be complete, nontruncated, and failure-free");
  }
}

function validateNegativeCoverage(
  coverage: ScaNegativeCoverageV1 | null,
  qualification: ScaFamilyEvidenceQualificationV1,
  runId: string
): void {
  if (coverage === null) return;
  const snapshotRef = qualificationRef(
    coverage.source_snapshot_ref,
    runId,
    "SCA negative coverage.source_snapshot_ref"
  );
  qualificationRef(coverage.coverage_scope_ref, runId, "SCA negative coverage.coverage_scope_ref");
  if (
    canonicalJson(snapshotRef) !== canonicalJson(qualification.source_snapshot_ref) ||
    coverage.source_snapshot_sha256 !== snapshotRef.content_digest
  ) {
    fail("SCA negative coverage", "coverage is not bound to the qualified source snapshot");
  }
}

export function validateEvidenceRef(value: unknown): EvidenceRefV1 {
  const record = validateContract(EvidenceRefV1Schema, value, "SCA evidence ref");
  assertIdentity(
    record.tenant_id,
    record.project_id,
    record.run_id,
    record.phase_id,
    record.evidence_id,
    "SCA evidence ref"
  );
  assertOpaqueId(record.task_id, "SCA evidence ref.task_id");
  let artifactRef: ReturnType<typeof currentArtifactRef>;
  try {
    artifactRef = currentArtifactRef(record.artifact_ref, "SCA evidence artifact_ref");
  } catch (error) {
    const issue = error instanceof Error ? error.message : "artifact_ref is invalid";
    throw new ScaDomainValidationError("SCA evidence ref", [issue]);
  }
  if (artifactRef.run_id !== record.run_id || artifactRef.phase !== record.phase_id) {
    fail("SCA evidence ref", "artifact_ref must match the evidence run and phase");
  }
  assertUnique(record.claim_classes, "SCA evidence claim classes");
  validateEvidenceQualification(record.qualification, record.run_id, "SCA evidence qualification");
  validateNegativeCoverage(record.negative_coverage, record.qualification, record.run_id);
  assertSafeNonNegativeInteger(artifactRef.byte_length, "SCA evidence artifact byte_length");
  assertUnique(
    record.citations.map((citation) => citation.citation_id),
    "SCA evidence citation IDs"
  );
  for (const citation of record.citations) {
    assertOpaqueId(citation.citation_id, "SCA evidence citation_id");
    assertCitationPointer(citation.pointer, `SCA citation ${citation.citation_id}`);
    if (
      citation.pointer.pointer_type === "byte_range" &&
      citation.pointer.end_byte_exclusive > artifactRef.byte_length
    ) {
      fail("SCA evidence ref", "byte citation exceeds the declared artifact byte_length");
    }
  }
  assertText(record.summary, "SCA evidence ref.summary", {
    minBytes: 1,
    maxBytes: MAX_TEXT_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  assertSafePositiveInteger(record.sequence, "SCA evidence ref.sequence");
  assertTimestamp(record.recorded_at, "SCA evidence ref.recorded_at");
  return { ...record, artifact_ref: artifactRef };
}

export function validateFindingRecord(value: unknown): FindingRecordV1 {
  const record = validateContract(FindingRecordV1Schema, value, "SCA finding record");
  assertIdentity(
    record.tenant_id,
    record.project_id,
    record.run_id,
    record.phase_id,
    record.finding_id,
    "SCA finding record"
  );
  assertOpaqueId(record.task_id, "SCA finding record.task_id");
  assertOpaqueId(record.finding_type, "SCA finding record.finding_type");
  assertSafePositiveInteger(record.finding_type_version, "SCA finding record.finding_type_version");
  assertText(record.title, "SCA finding record.title", {
    minBytes: 1,
    maxBytes: MAX_TITLE_BYTES,
    trimmedNonEmpty: true,
  });
  assertIdArray(record.claim_ids, "SCA finding record.claim_ids");
  assertIdArray(record.evidence_ids, "SCA finding record.evidence_ids");
  if ((record.status === "candidate") !== (record.investigation === null)) {
    fail(
      "SCA finding record",
      "investigation must be null only for candidate status and present thereafter"
    );
  }
  if (record.investigation !== null) {
    const investigationTexts = [
      record.investigation.hypothesis,
      ...record.investigation.competing_explanations,
      ...record.investigation.expected_observations,
      ...record.investigation.stop_conditions,
      ...record.investigation.reopening_conditions,
    ];
    for (const text of investigationTexts) {
      assertText(text, "SCA finding investigation text", {
        minBytes: 1,
        maxBytes: MAX_TEXT_BYTES,
        multiline: true,
        trimmedNonEmpty: true,
      });
    }
  }
  if ((record.status === "duplicate") !== (record.duplicate_of !== null)) {
    fail("SCA finding record", "duplicate_of must be present exactly for duplicate status");
  }
  if (record.duplicate_of === record.finding_id) {
    fail("SCA finding record", "a finding cannot duplicate itself");
  }
  assertSafePositiveInteger(record.version, "SCA finding record.version");
  assertSafePositiveInteger(record.sequence, "SCA finding record.sequence");
  assertRecordClock(record.created_at, record.updated_at, record.version, "SCA finding record");
  if (record.version === 1 && record.status !== "candidate") {
    fail("SCA finding record", "version 1 finding status must be candidate");
  }
  assertDecisionBinding(isFindingTerminal(record.status), record.decision_id, "SCA finding record");
  return record;
}

export function validateDecisionRecord(value: unknown): DecisionRecordV1 {
  const record = validateContract(DecisionRecordV1Schema, value, "SCA decision record");
  assertIdentity(
    record.tenant_id,
    record.project_id,
    record.run_id,
    record.phase_id,
    record.decision_id,
    "SCA decision record"
  );
  assertOpaqueId(record.task_id, "SCA decision record.task_id");
  assertIdArray(record.claim_ids, "SCA decision record.claim_ids");
  assertIdArray(record.finding_ids, "SCA decision record.finding_ids");
  assertIdArray(record.evidence_ids, "SCA decision record.evidence_ids");
  if (record.claim_ids.length === 0 && record.finding_ids.length === 0) {
    if (
      record.decision_type !== "task_disposition" &&
      record.decision_type !== "gate_disposition"
    ) {
      fail("SCA decision record", "claim/finding decisions require at least one target");
    }
  }
  if (record.decision_type === "claim_disposition" && record.claim_ids.length === 0) {
    fail("SCA decision record", "claim_disposition requires claim_ids");
  }
  if (record.decision_type === "finding_disposition" && record.finding_ids.length === 0) {
    fail("SCA decision record", "finding_disposition requires finding_ids");
  }
  assertText(record.rationale, "SCA decision record.rationale", {
    minBytes: 1,
    maxBytes: MAX_TEXT_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  assertSafePositiveInteger(record.sequence, "SCA decision record.sequence");
  assertTimestamp(record.recorded_at, "SCA decision record.recorded_at");
  return record;
}

export function validateGateResult(value: unknown): GateResultV1 {
  const record = validateContract(GateResultV1Schema, value, "SCA gate result");
  assertIdentity(
    record.tenant_id,
    record.project_id,
    record.run_id,
    record.phase_id,
    record.gate_id,
    "SCA gate result"
  );
  assertOpaqueId(record.gate_type, "SCA gate result.gate_type");
  assertSafePositiveInteger(record.gate_type_version, "SCA gate result.gate_type_version");
  assertIdArray(record.task_ids, "SCA gate result.task_ids");
  assertIdArray(record.decision_ids, "SCA gate result.decision_ids");
  assertIdArray(record.evidence_ids, "SCA gate result.evidence_ids");
  assertText(record.summary, "SCA gate result.summary", {
    minBytes: 1,
    maxBytes: MAX_TEXT_BYTES,
    multiline: true,
    trimmedNonEmpty: true,
  });
  assertSafePositiveInteger(record.sequence, "SCA gate result.sequence");
  assertTimestamp(record.evaluated_at, "SCA gate result.evaluated_at");
  return record;
}

export function validateManifest(value: unknown): ManifestV1 {
  const manifest = validateContract(ManifestV1Schema, value, "SCA manifest");
  assertOpaqueId(manifest.tenant_id, "SCA manifest.tenant_id");
  assertOpaqueId(manifest.project_id, "SCA manifest.project_id");
  assertOpaqueId(manifest.run_id, "SCA manifest.run_id");
  assertOpaqueId(manifest.manifest_id, "SCA manifest.manifest_id");
  assertSafePositiveInteger(manifest.record_count, "SCA manifest.record_count");
  assertSafePositiveInteger(manifest.first_sequence, "SCA manifest.first_sequence");
  assertSafePositiveInteger(manifest.last_sequence, "SCA manifest.last_sequence");
  assertTimestamp(manifest.created_at, "SCA manifest.created_at");
  if (manifest.record_count !== manifest.records.length) {
    fail("SCA manifest", "record_count must equal records.length");
  }
  if (manifest.first_sequence > manifest.last_sequence) {
    fail("SCA manifest", "first_sequence must not exceed last_sequence");
  }
  const locatorKeys: string[] = [];
  let previousSequence = 0;
  for (const locator of manifest.records) {
    assertOpaqueId(locator.record_id, "SCA manifest record_id");
    assertSafePositiveInteger(locator.record_version, "SCA manifest record_version");
    assertSafePositiveInteger(locator.sequence, "SCA manifest sequence");
    if (locator.sequence <= previousSequence) {
      fail("SCA manifest", "record locators must be in strictly increasing sequence order");
    }
    previousSequence = locator.sequence;
    locatorKeys.push(`${locator.record_type}:${locator.record_id}:${locator.record_version}`);
  }
  assertUnique(locatorKeys, "SCA manifest record locators");
  const first = manifest.records[0];
  const last = manifest.records[manifest.records.length - 1];
  if (
    first === undefined ||
    last === undefined ||
    first.sequence !== manifest.first_sequence ||
    last.sequence !== manifest.last_sequence
  ) {
    fail("SCA manifest", "first_sequence/last_sequence must bind the ordered record locators");
  }
  return manifest;
}

function recordSchemaId(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Reflect.get(value, "schema_id");
}

export function validateScaDomainRecord(value: unknown): ScaDomainRecordV1 {
  switch (recordSchemaId(value)) {
    case "penny.sca-task-record.v1":
      return validateTaskRecord(value);
    case "penny.sca-claim-record.v1":
      return validateClaimRecord(value);
    case "penny.sca-evidence-ref.v1":
      return validateEvidenceRef(value);
    case "penny.sca-finding-record.v1":
      return validateFindingRecord(value);
    case "penny.sca-decision-record.v1":
      return validateDecisionRecord(value);
    case "penny.sca-gate-result.v1":
      return validateGateResult(value);
    default:
      throw new ContractValidationError("SCA domain record", ["/: unsupported schema_id"]);
  }
}

export function validateScaNdjsonRecord(value: unknown): ScaNdjsonRecordV1 {
  if (recordSchemaId(value) === "penny.sca-manifest.v1") return validateManifest(value);
  return validateScaDomainRecord(value);
}

export function validateScaDomainBundleShape(value: unknown): ScaDomainBundleV1 {
  return validateContract(ScaDomainBundleV1Schema, value, "SCA domain bundle");
}

export function domainRecordIdentity(record: ScaDomainRecordV1): {
  readonly record_type: ManifestRecordType;
  readonly record_id: string;
  readonly record_version: number;
  readonly sequence: number;
} {
  switch (record.schema_id) {
    case "penny.sca-task-record.v1":
      return {
        record_type: "task",
        record_id: record.task_id,
        record_version: record.version,
        sequence: record.sequence,
      };
    case "penny.sca-claim-record.v1":
      return {
        record_type: "claim",
        record_id: record.claim_id,
        record_version: record.version,
        sequence: record.sequence,
      };
    case "penny.sca-evidence-ref.v1":
      return {
        record_type: "evidence",
        record_id: record.evidence_id,
        record_version: record.version,
        sequence: record.sequence,
      };
    case "penny.sca-finding-record.v1":
      return {
        record_type: "finding",
        record_id: record.finding_id,
        record_version: record.version,
        sequence: record.sequence,
      };
    case "penny.sca-decision-record.v1":
      return {
        record_type: "decision",
        record_id: record.decision_id,
        record_version: record.version,
        sequence: record.sequence,
      };
    case "penny.sca-gate-result.v1":
      return {
        record_type: "gate",
        record_id: record.gate_id,
        record_version: record.version,
        sequence: record.sequence,
      };
  }
}

export function domainRecordTimestamp(record: ScaDomainRecordV1): string {
  switch (record.schema_id) {
    case "penny.sca-task-record.v1":
    case "penny.sca-claim-record.v1":
    case "penny.sca-finding-record.v1":
      return record.updated_at;
    case "penny.sca-evidence-ref.v1":
    case "penny.sca-decision-record.v1":
      return record.recorded_at;
    case "penny.sca-gate-result.v1":
      return record.evaluated_at;
  }
}
