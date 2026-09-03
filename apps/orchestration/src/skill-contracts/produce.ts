import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { ArtifactRefSchema, ConfidenceSchema, type ArtifactRef } from "../contracts.js";
import {
  ArtifactIdSchema,
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  Sha256Schema,
  TextSchema,
  SkillSchemaValidationError,
  assertOpaqueId,
  assertRfc3339Utc,
  assertText,
  assertUnique,
  validateSkillSchema,
} from "./common.js";

const MAX_REQUEST_ITEMS = 64;
const MAX_SOURCE_ITEMS = 128;
const MAX_APPROACHES = 4;
export const MAX_PRODUCED_CONTENT_BYTES = 131_072;
export const MAX_PERSISTED_PRODUCE_DRAFT_BYTES = 262_144;

export const PRODUCE_ARTIFACT_KINDS = [
  "text",
  "markdown",
  "json",
  "yaml",
  "typescript",
  "javascript",
  "python",
  "shell",
] as const;
export type ProduceArtifactKind = (typeof PRODUCE_ARTIFACT_KINDS)[number];

const ArtifactKindSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("markdown"),
  Type.Literal("json"),
  Type.Literal("yaml"),
  Type.Literal("typescript"),
  Type.Literal("javascript"),
  Type.Literal("python"),
  Type.Literal("shell"),
]);

const StatementV1Schema = Type.Object(
  { statement: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }) },
  { additionalProperties: false }
);
const SourceMaterialV1Schema = Type.Object(
  {
    statement: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
    source_label: Type.Optional(TextSchema({ minBytes: 1, maxBytes: 512 })),
  },
  { additionalProperties: false }
);

const ProduceRequestProperties = {
  schema_version: Type.Literal(1),
  purpose_statement: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
  output_name: TextSchema({ minBytes: 1, maxBytes: 255 }),
  artifact_kind: ArtifactKindSchema,
  specification: Type.Array(StatementV1Schema, { minItems: 1, maxItems: MAX_REQUEST_ITEMS }),
  source_material: Type.Array(SourceMaterialV1Schema, { maxItems: MAX_SOURCE_ITEMS }),
  acceptance_criteria: Type.Array(StatementV1Schema, {
    minItems: 1,
    maxItems: MAX_REQUEST_ITEMS,
  }),
  hard_constraints: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  non_goals: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
  known_uncertainties: Type.Array(StatementV1Schema, { maxItems: MAX_REQUEST_ITEMS }),
};

export const ProduceRequestV1Schema = Type.Object(ProduceRequestProperties, {
  additionalProperties: false,
});
export type ProduceRequestV1 = Readonly<Static<typeof ProduceRequestV1Schema>>;

export const ProduceRequestConstraintsV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    output_name: ProduceRequestV1Schema.properties.output_name,
    artifact_kind: ProduceRequestV1Schema.properties.artifact_kind,
    specification: ProduceRequestV1Schema.properties.specification,
    source_material: ProduceRequestV1Schema.properties.source_material,
    acceptance_criteria: ProduceRequestV1Schema.properties.acceptance_criteria,
    hard_constraints: ProduceRequestV1Schema.properties.hard_constraints,
    non_goals: ProduceRequestV1Schema.properties.non_goals,
    known_uncertainties: ProduceRequestV1Schema.properties.known_uncertainties,
  },
  { additionalProperties: false }
);
export type ProduceRequestConstraintsV1 = Readonly<
  Static<typeof ProduceRequestConstraintsV1Schema>
>;

const ApproachOptionV1Schema = Type.Object(
  {
    approach_id: OpaqueIdSchema,
    title: TextSchema({ minBytes: 1, maxBytes: 512 }),
    description: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    tradeoffs: Type.Array(TextSchema({ minBytes: 1, maxBytes: 4_096, multiline: true }), {
      minItems: 1,
      maxItems: 8,
    }),
  },
  { additionalProperties: false }
);

export const ArtifactApproachV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    approaches: Type.Array(ApproachOptionV1Schema, { minItems: 2, maxItems: MAX_APPROACHES }),
    recommended_approach_id: OpaqueIdSchema,
    recommendation_rationale: TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }),
    confidence: ConfidenceSchema,
  },
  { additionalProperties: false }
);
export type ArtifactApproachV1 = Readonly<Static<typeof ArtifactApproachV1Schema>>;

const RequestIndexSchema = Type.Integer({ minimum: 0, maximum: MAX_SOURCE_ITEMS - 1 });
const RequestIndexesSchema = Type.Array(RequestIndexSchema, {
  maxItems: MAX_SOURCE_ITEMS,
  uniqueItems: true,
});

const RequestCoverageV1Schema = Type.Object(
  {
    purpose_statement_covered: Type.Literal(true),
    specification_indexes: RequestIndexesSchema,
    source_material_indexes: RequestIndexesSchema,
    acceptance_criterion_indexes: RequestIndexesSchema,
    hard_constraint_indexes: RequestIndexesSchema,
    non_goal_indexes: RequestIndexesSchema,
    known_uncertainty_indexes: RequestIndexesSchema,
  },
  { additionalProperties: false }
);

const ProducedArtifactDraftProperties = {
  schema_version: Type.Literal(1),
  disposition: Type.Union([Type.Literal("produced"), Type.Literal("not_applicable")]),
  output_name: ProduceRequestV1Schema.properties.output_name,
  artifact_kind: ArtifactKindSchema,
  media_type: TextSchema({ minBytes: 1, maxBytes: 128 }),
  content: Type.String({ maxLength: MAX_PRODUCED_CONTENT_BYTES }),
  rationale: TextSchema({ minBytes: 1, maxBytes: 16_384, multiline: true }),
  assumptions: Type.Array(TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }), {
    maxItems: 32,
    uniqueItems: true,
  }),
  uncertainties: Type.Array(TextSchema({ minBytes: 1, maxBytes: 8_192, multiline: true }), {
    maxItems: 32,
    uniqueItems: true,
  }),
  request_coverage: RequestCoverageV1Schema,
  confidence: ConfidenceSchema,
  external_actions_performed: Type.Literal(false),
  filesystem_writes_performed: Type.Literal(false),
  tests_executed: Type.Literal(false),
};

const ProducedArtifactCoreProperties = {
  ...ProducedArtifactDraftProperties,
  content_sha256: Sha256Schema,
};

export const ProducedArtifactDraftV1Schema = Type.Object(ProducedArtifactDraftProperties, {
  additionalProperties: false,
});
export type ProducedArtifactDraftV1 = Readonly<Static<typeof ProducedArtifactDraftV1Schema>>;

const SourceMaterialLineageV1Schema = Type.Object(
  {
    source_index: RequestIndexSchema,
    statement_sha256: Sha256Schema,
    source_label: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  },
  { additionalProperties: false }
);

const ProducedArtifactSourceLineagePreimageV1Schema = Type.Object(
  {
    request_artifact_id: ArtifactIdSchema,
    request_artifact_sha256: Sha256Schema,
    approach_artifact_id: ArtifactIdSchema,
    approach_artifact_sha256: Sha256Schema,
    draft_artifact_id: ArtifactIdSchema,
    draft_artifact_sha256: Sha256Schema,
    draft_sha256: Sha256Schema,
    source_material: Type.Array(SourceMaterialLineageV1Schema, { maxItems: MAX_SOURCE_ITEMS }),
  },
  { additionalProperties: false }
);
export type ProducedArtifactSourceLineagePreimageV1 = Readonly<
  Static<typeof ProducedArtifactSourceLineagePreimageV1Schema>
>;

export const ProducedArtifactSourceLineageV1Schema = Type.Object(
  {
    ...ProducedArtifactSourceLineagePreimageV1Schema.properties,
    lineage_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ProducedArtifactSourceLineageV1 = Readonly<
  Static<typeof ProducedArtifactSourceLineageV1Schema>
>;

export const ProducedArtifactV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.produced-artifact.v1"),
    ...ProducedArtifactCoreProperties,
    request: ProduceRequestV1Schema,
    request_sha256: Sha256Schema,
    source_lineage: ProducedArtifactSourceLineageV1Schema,
  },
  { additionalProperties: false }
);
export type ProducedArtifactV1 = Readonly<Static<typeof ProducedArtifactV1Schema>>;

export type ProduceDraftFailureClassV1 =
  | "FRAMING_INVALID"
  | "JSON_INVALID"
  | "SCHEMA_INVALID"
  | "SEMANTIC_INVALID"
  | "LINEAGE_INVALID";

export class ProduceDraftValidationError extends Error {
  constructor(
    readonly failureClass: ProduceDraftFailureClassV1,
    readonly issues: readonly string[]
  ) {
    super(`${failureClass}: ${issues.join("; ")}`);
    this.name = "ProduceDraftValidationError";
  }
}

export const ProduceSealFeedbackV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.produce-seal-feedback.v1"),
    schema_version: Type.Literal(1),
    attempt: Type.Literal(1),
    rejected_draft_artifact_id: ArtifactIdSchema,
    failure_class: Type.Union([
      Type.Literal("FRAMING_INVALID"),
      Type.Literal("JSON_INVALID"),
      Type.Literal("SCHEMA_INVALID"),
      Type.Literal("SEMANTIC_INVALID"),
    ]),
    issues: Type.Array(TextSchema({ minBytes: 1, maxBytes: 512 }), {
      minItems: 1,
      maxItems: 1_024,
    }),
  },
  { additionalProperties: false }
);
export type ProduceSealFeedbackV1 = Readonly<Static<typeof ProduceSealFeedbackV1Schema>>;

const ProduceRoutingSummaryV1Schema = Type.Object(
  { confidence: ConfidenceSchema, complete: Type.Literal(true) },
  { additionalProperties: false }
);
export type ProduceRoutingSummaryV1 = Readonly<Static<typeof ProduceRoutingSummaryV1Schema>>;

export const ProduceQualityReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.produce-quality-receipt.v1"),
    schema_version: Type.Literal(1),
    receipt_id: Type.String({ pattern: "^pqrc_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    verdict: Type.Literal("APPROVE"),
    reviewer: Type.Literal("carren"),
    request_ref: ArtifactRefSchema,
    approach_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    product_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    execution_receipt_id: OpaqueIdSchema,
    execution_result_sha256: Sha256Schema,
    created_at: Rfc3339UtcSchema,
    external_actions_performed: Type.Literal(false),
    filesystem_writes_performed: Type.Literal(false),
    tests_executed: Type.Literal(false),
    minted_by: Type.Literal("host:produce-receipt-authority"),
  },
  { additionalProperties: false }
);
export type ProduceQualityReceiptV1 = Readonly<Static<typeof ProduceQualityReceiptV1Schema>>;

export const ProduceValidityReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.produce-validity-receipt.v1"),
    schema_version: Type.Literal(1),
    receipt_id: Type.String({ pattern: "^pvrc_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    verdict: Type.Literal("PASS"),
    reviewer: Type.Literal("vera"),
    request_ref: ArtifactRefSchema,
    approach_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    product_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    quality_receipt_ref: ArtifactRefSchema,
    execution_receipt_id: OpaqueIdSchema,
    execution_result_sha256: Sha256Schema,
    created_at: Rfc3339UtcSchema,
    external_actions_performed: Type.Literal(false),
    filesystem_writes_performed: Type.Literal(false),
    tests_executed: Type.Literal(false),
    minted_by: Type.Literal("host:produce-receipt-authority"),
  },
  { additionalProperties: false }
);
export type ProduceValidityReceiptV1 = Readonly<Static<typeof ProduceValidityReceiptV1Schema>>;

const PRODUCE_INTEGRITY_CHECKS = [
  "canonical_product",
  "exact_request_coverage",
  "exact_source_lineage",
  "canonical_json_content_when_applicable",
  "latest_quality_receipt",
  "latest_validity_receipt",
  "signed_worker_evidence",
  "no_side_effects",
] as const;

export const ProduceProductIntegrityV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.produce-product-integrity.v1"),
    schema_version: Type.Literal(1),
    integrity_id: Type.String({ pattern: "^pair_[a-f0-9]{64}$" }),
    status: Type.Literal("PASS"),
    request_ref: ArtifactRefSchema,
    approach_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    product_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    quality_receipt_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    execution_receipt_ids: Type.Array(OpaqueIdSchema, {
      minItems: 4,
      maxItems: 16,
      uniqueItems: true,
    }),
    checks: Type.Array(
      Type.Union([
        Type.Literal("canonical_product"),
        Type.Literal("exact_request_coverage"),
        Type.Literal("exact_source_lineage"),
        Type.Literal("canonical_json_content_when_applicable"),
        Type.Literal("latest_quality_receipt"),
        Type.Literal("latest_validity_receipt"),
        Type.Literal("signed_worker_evidence"),
        Type.Literal("no_side_effects"),
      ]),
      { minItems: 8, maxItems: 8, uniqueItems: true }
    ),
    external_actions_performed: Type.Literal(false),
    filesystem_writes_performed: Type.Literal(false),
    tests_executed: Type.Literal(false),
  },
  { additionalProperties: false }
);
export type ProduceProductIntegrityV1 = Readonly<Static<typeof ProduceProductIntegrityV1Schema>>;

export const ProduceProductEnvelopeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.produce-product-envelope.v1"),
    schema_version: Type.Literal(1),
    envelope_id: Type.String({ pattern: "^paenv_[a-f0-9]{64}$" }),
    run_id: OpaqueIdSchema,
    status: Type.Literal("complete"),
    request_ref: ArtifactRefSchema,
    approach_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    product_ref: ArtifactRefSchema,
    carren_report_ref: ArtifactRefSchema,
    vera_report_ref: ArtifactRefSchema,
    quality_receipt_ref: ArtifactRefSchema,
    validity_receipt_ref: ArtifactRefSchema,
    integrity_ref: ArtifactRefSchema,
  },
  { additionalProperties: false }
);
export type ProduceProductEnvelopeV1 = Readonly<Static<typeof ProduceProductEnvelopeV1Schema>>;

function validateText(value: string, label: string, maxBytes: number, multiline = true): void {
  assertText(value, label, {
    minBytes: 1,
    maxBytes,
    multiline,
    trimmedNonEmpty: true,
  });
}

function validateOutputName(value: string): void {
  validateText(value, "ProduceRequestV1.output_name", 255, false);
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new SkillSchemaValidationError("ProduceRequestV1.output_name", [
      "output_name must be one non-path name",
    ]);
  }
}

function validateRequestContent(request: ProduceRequestV1): void {
  validateText(request.purpose_statement, "ProduceRequestV1.purpose_statement", 16_384);
  validateOutputName(request.output_name);
  for (const group of [
    request.specification,
    request.acceptance_criteria,
    request.hard_constraints,
    request.non_goals,
    request.known_uncertainties,
  ]) {
    for (const item of group) validateText(item.statement, "ProduceRequestV1 statement", 8_192);
  }
  for (const item of request.source_material) {
    validateText(item.statement, "ProduceRequestV1 source material", 16_384);
    if (item.source_label !== undefined) {
      validateText(item.source_label, "ProduceRequestV1 source label", 512, false);
    }
  }
}

export function validateProduceRequest(value: unknown): ProduceRequestV1 {
  const request = validateSkillSchema(ProduceRequestV1Schema, value, "ProduceRequestV1");
  validateRequestContent(request);
  return request;
}

export function canonicalizeProduceRequest(input: {
  readonly goal: string;
  readonly constraints: unknown;
}): ProduceRequestV1 {
  validateText(input.goal, "ProduceRequestV1 goal", 16_384);
  const constraints = validateSkillSchema(
    ProduceRequestConstraintsV1Schema,
    input.constraints,
    "ProduceRequestV1 start constraints"
  );
  return validateProduceRequest({
    schema_version: 1,
    purpose_statement: input.goal,
    output_name: constraints.output_name,
    artifact_kind: constraints.artifact_kind,
    specification: constraints.specification,
    source_material: constraints.source_material,
    acceptance_criteria: constraints.acceptance_criteria,
    hard_constraints: constraints.hard_constraints,
    non_goals: constraints.non_goals,
    known_uncertainties: constraints.known_uncertainties,
  });
}

export function produceRequestConstraints(requestValue: unknown): ProduceRequestConstraintsV1 {
  const request = validateProduceRequest(requestValue);
  return {
    schema_version: 1,
    output_name: request.output_name,
    artifact_kind: request.artifact_kind,
    specification: request.specification,
    source_material: request.source_material,
    acceptance_criteria: request.acceptance_criteria,
    hard_constraints: request.hard_constraints,
    non_goals: request.non_goals,
    known_uncertainties: request.known_uncertainties,
  };
}

export function produceRequestSha256(value: unknown): string {
  return sha256(canonicalJson(validateProduceRequest(value)));
}

export function mediaTypeForArtifactKind(kind: ProduceArtifactKind): string {
  switch (kind) {
    case "text":
      return "text/plain; charset=utf-8";
    case "markdown":
      return "text/markdown; charset=utf-8";
    case "json":
      return "application/json";
    case "yaml":
      return "application/yaml";
    case "typescript":
      return "text/typescript; charset=utf-8";
    case "javascript":
      return "text/javascript; charset=utf-8";
    case "python":
      return "text/x-python; charset=utf-8";
    case "shell":
      return "text/x-shellscript; charset=utf-8";
  }
}

function sanitizeIssues(issues: readonly string[]): readonly string[] {
  return [
    ...new Set(
      issues.map((issue) =>
        issue.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\0", " ").trim().slice(0, 512)
      )
    ),
  ].filter((issue) => issue.length > 0);
}

function range(length: number): number[] {
  return Array.from({ length }, (_unused, index) => index);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function artifactContentIssues(content: string): readonly string[] {
  const bytes = Buffer.byteLength(content, "utf8");
  const invalidControl = [...content].some((character) => {
    const point = character.codePointAt(0);
    return (
      point !== undefined &&
      ((point >= 0 && point <= 0x08) ||
        point === 0x0b ||
        point === 0x0c ||
        (point >= 0x0e && point <= 0x1f) ||
        (point >= 0x7f && point <= 0x9f))
    );
  });
  return content !== content.normalize("NFC") ||
    content.includes("\r") ||
    invalidControl ||
    bytes > MAX_PRODUCED_CONTENT_BYTES
    ? [
        `content must be NFC, LF/tab-safe, control-free, and at most ${MAX_PRODUCED_CONTENT_BYTES} UTF-8 bytes`,
      ]
    : [];
}

function draftSemanticIssues(
  draft: ProducedArtifactDraftV1,
  request: ProduceRequestV1
): readonly string[] {
  const issues = [...artifactContentIssues(draft.content)];
  if (draft.output_name !== request.output_name)
    issues.push("output_name must equal the exact request");
  if (draft.artifact_kind !== request.artifact_kind) {
    issues.push("artifact_kind must equal the exact request");
  }
  if (draft.media_type !== mediaTypeForArtifactKind(request.artifact_kind)) {
    issues.push("media_type must be the deterministic media type for artifact_kind");
  }
  if (draft.disposition === "produced" && Buffer.byteLength(draft.content, "utf8") === 0) {
    issues.push("produced disposition requires nonempty content");
  }
  if (draft.disposition === "not_applicable" && draft.content.length !== 0) {
    issues.push("not_applicable disposition requires empty content");
  }
  if (draft.artifact_kind === "json" && draft.disposition === "produced") {
    let value: unknown;
    try {
      value = JSON.parse(draft.content);
    } catch {
      issues.push("produced JSON content must parse as JSON");
    }
    if (value !== undefined && canonicalJson(value) !== draft.content) {
      issues.push("produced JSON content must be canonical JSON");
    }
  }
  const coverage = draft.request_coverage;
  const expected = [
    [coverage.specification_indexes, request.specification.length, "specification_indexes"],
    [coverage.source_material_indexes, request.source_material.length, "source_material_indexes"],
    [
      coverage.acceptance_criterion_indexes,
      request.acceptance_criteria.length,
      "acceptance_criterion_indexes",
    ],
    [coverage.hard_constraint_indexes, request.hard_constraints.length, "hard_constraint_indexes"],
    [coverage.non_goal_indexes, request.non_goals.length, "non_goal_indexes"],
    [
      coverage.known_uncertainty_indexes,
      request.known_uncertainties.length,
      "known_uncertainty_indexes",
    ],
  ] as const;
  for (const [actual, length, label] of expected) {
    if (!sameNumbers(actual, range(length))) {
      issues.push(`request_coverage.${label} must equal the complete exact request index set`);
    }
  }
  return sanitizeIssues(issues);
}

export function validateArtifactApproach(value: unknown): ArtifactApproachV1 {
  const approach = validateSkillSchema(ArtifactApproachV1Schema, value, "ArtifactApproachV1");
  const ids = approach.approaches.map((item) => item.approach_id);
  for (const item of approach.approaches) {
    assertOpaqueId(item.approach_id, "ArtifactApproachV1 approach ID");
    validateText(item.title, "ArtifactApproachV1 title", 512, false);
    validateText(item.description, "ArtifactApproachV1 description", 8_192);
    for (const tradeoff of item.tradeoffs) {
      validateText(tradeoff, "ArtifactApproachV1 tradeoff", 4_096);
    }
  }
  assertUnique(ids, "ArtifactApproachV1 approach IDs");
  if (!ids.includes(approach.recommended_approach_id)) {
    throw new SkillSchemaValidationError("ArtifactApproachV1", [
      "recommended_approach_id must name one supplied approach",
    ]);
  }
  validateText(approach.recommendation_rationale, "ArtifactApproachV1 rationale", 8_192);
  return approach;
}

function validateDraftShape(value: unknown): ProducedArtifactDraftV1 {
  const draft = validateSkillSchema(
    ProducedArtifactDraftV1Schema,
    value,
    "ProducedArtifactDraftV1"
  );
  validateOutputName(draft.output_name);
  validateText(draft.media_type, "ProducedArtifactDraftV1.media_type", 128, false);
  validateText(draft.rationale, "ProducedArtifactDraftV1.rationale", 16_384);
  for (const item of [...draft.assumptions, ...draft.uncertainties]) {
    validateText(item, "ProducedArtifactDraftV1 assumption or uncertainty", 8_192);
  }
  return draft;
}

export function validateProducedArtifactDraft(
  value: unknown,
  input: { readonly request: unknown }
): ProducedArtifactDraftV1 {
  const request = validateProduceRequest(input.request);
  let draft: ProducedArtifactDraftV1;
  try {
    draft = validateDraftShape(value);
  } catch (error) {
    const issues =
      error instanceof SkillSchemaValidationError
        ? sanitizeIssues(error.issues)
        : sanitizeIssues([
            error instanceof Error ? error.message : "closed schema validation failed",
          ]);
    throw new ProduceDraftValidationError("SCHEMA_INVALID", issues);
  }
  const issues = draftSemanticIssues(draft, request);
  if (issues.length > 0) throw new ProduceDraftValidationError("SEMANTIC_INVALID", issues);
  return draft;
}

const APPROACH_PREFIX = "ARTIFACT_APPROACH:";
const DRAFT_PREFIX = "PRODUCED_ARTIFACT_DRAFT:";
const SUMMARY_PREFIX = "SUMMARY:";

function parseExactSummary(value: string): ProduceRoutingSummaryV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  try {
    const summary = validateSkillSchema(
      ProduceRoutingSummaryV1Schema,
      parsed,
      "Produce routing summary"
    );
    return `{"confidence":"${summary.confidence}","complete":true}` === value ? summary : undefined;
  } catch {
    return undefined;
  }
}

function parseTwoLineCore<T>(
  bytes: Uint8Array,
  input: {
    readonly prefix: string;
    readonly label: string;
    readonly maximumBytes: number;
    readonly validate: (value: unknown) => T;
    readonly confidence: (value: T) => string;
  }
): { readonly value: T; readonly summary: ProduceRoutingSummaryV1 } {
  const body = Buffer.from(bytes);
  if (body.length === 0 || body.length > input.maximumBytes) {
    throw new ProduceDraftValidationError("FRAMING_INVALID", [
      `${input.label} output must be 1..${input.maximumBytes} bytes`,
    ]);
  }
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    throw new ProduceDraftValidationError("FRAMING_INVALID", [`${input.label} forbids BOM`]);
  }
  if (body.includes(0)) {
    throw new ProduceDraftValidationError("FRAMING_INVALID", [`${input.label} forbids NUL`]);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new ProduceDraftValidationError("FRAMING_INVALID", [
      `${input.label} is not strict UTF-8`,
    ]);
  }
  if (text.includes("\ufeff") || text.includes("\r")) {
    throw new ProduceDraftValidationError("FRAMING_INVALID", [`${input.label} forbids BOM and CR`]);
  }
  const framed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = framed.split("\n");
  if (
    framed.endsWith("\n") ||
    lines.length !== 2 ||
    !lines[0]?.startsWith(input.prefix) ||
    !lines[1]?.startsWith(SUMMARY_PREFIX) ||
    lines.some((line) => line.trim() !== line || line.includes("`"))
  ) {
    throw new ProduceDraftValidationError("FRAMING_INVALID", [
      `${input.label} requires exactly one unwrapped core line and one compact SUMMARY line`,
    ]);
  }
  const coreText = lines[0].slice(input.prefix.length);
  const summary = parseExactSummary(lines[1].slice(SUMMARY_PREFIX.length));
  if (coreText.length === 0 || summary === undefined) {
    throw new ProduceDraftValidationError("FRAMING_INVALID", [
      `${input.label} core or SUMMARY framing is invalid`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(coreText);
  } catch {
    throw new ProduceDraftValidationError("JSON_INVALID", [`${input.label} core is not JSON`]);
  }
  let value: T;
  try {
    value = input.validate(parsed);
  } catch (error) {
    if (error instanceof ProduceDraftValidationError) throw error;
    const issues =
      error instanceof SkillSchemaValidationError
        ? error.issues
        : [error instanceof Error ? error.message : "validation failed"];
    throw new ProduceDraftValidationError("SCHEMA_INVALID", sanitizeIssues(issues));
  }
  if (canonicalJson(value) !== coreText) {
    throw new ProduceDraftValidationError("FRAMING_INVALID", [
      `${input.label} core must be canonical JSON`,
    ]);
  }
  if (input.confidence(value) !== summary.confidence) {
    throw new ProduceDraftValidationError("SEMANTIC_INVALID", [
      `${input.label} confidence must equal SUMMARY confidence`,
    ]);
  }
  return { value, summary };
}

export function parsePersistedArtifactApproach(bytes: Uint8Array): {
  readonly approach: ArtifactApproachV1;
  readonly summary: ProduceRoutingSummaryV1;
} {
  const parsed = parseTwoLineCore(bytes, {
    prefix: APPROACH_PREFIX,
    label: "ArtifactApproachV1",
    maximumBytes: 65_536,
    validate: validateArtifactApproach,
    confidence: (value) => value.confidence,
  });
  return { approach: parsed.value, summary: parsed.summary };
}

export function parsePersistedProducedArtifactDraft(
  bytes: Uint8Array,
  input: { readonly request: unknown }
): { readonly draft: ProducedArtifactDraftV1; readonly summary: ProduceRoutingSummaryV1 } {
  const parsed = parseTwoLineCore(bytes, {
    prefix: DRAFT_PREFIX,
    label: "ProducedArtifactDraftV1",
    maximumBytes: MAX_PERSISTED_PRODUCE_DRAFT_BYTES,
    validate: (value) => validateProducedArtifactDraft(value, input),
    confidence: (value) => value.confidence,
  });
  return { draft: parsed.value, summary: parsed.summary };
}

export function artifactApproachPromptContract(): string {
  return canonicalJson({
    schema: ArtifactApproachV1Schema,
    transport: {
      canonical_framing:
        "exactly ARTIFACT_APPROACH:<canonical-single-line-JSON> then SUMMARY:<compact-JSON>",
      approach_count: { minimum: 2, maximum: MAX_APPROACHES },
      final_artifact_authorship: "forbidden",
    },
  });
}

export function producedArtifactDraftPromptContract(): string {
  return canonicalJson({
    schema: ProducedArtifactDraftV1Schema,
    transport: {
      encoding: "strict UTF-8",
      maximum_output_bytes: MAX_PERSISTED_PRODUCE_DRAFT_BYTES,
      maximum_content_bytes: MAX_PRODUCED_CONTENT_BYTES,
      canonical_framing:
        "exactly PRODUCED_ARTIFACT_DRAFT:<canonical-single-line-JSON> then SUMMARY:<compact-JSON>",
    },
    output_identity: {
      output_name: "exact request output_name",
      artifact_kind: "exact request artifact_kind",
      media_type: "host-defined mediaTypeForArtifactKind value",
    },
    content: {
      produced: "nonempty exact content; the host derives content_sha256 while sealing",
      not_applicable: "empty content and a truthful rationale; the host derives its digest",
      json: "produced JSON must be parseable canonical JSON",
      other_kinds: "no compilation, execution, or syntax-check claim",
    },
    coverage:
      "every coverage array is the complete ascending zero-based index set for its exact request array",
    side_effect_flags: {
      external_actions_performed: false,
      filesystem_writes_performed: false,
      tests_executed: false,
    },
  });
}

export function producedArtifactSourceLineageSha256(value: unknown): string {
  return sha256(
    canonicalJson(
      validateSkillSchema(
        ProducedArtifactSourceLineagePreimageV1Schema,
        value,
        "ProducedArtifactV1 source lineage preimage"
      )
    )
  );
}

function sourceMaterialLineage(request: ProduceRequestV1) {
  return request.source_material.map((source, source_index) => ({
    source_index,
    statement_sha256: sha256(source.statement),
    source_label: source.source_label ?? null,
  }));
}

function assertProduceSourceRefs(input: {
  readonly requestRef: ArtifactRef;
  readonly approachRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
}): void {
  const refs = [input.requestRef, input.approachRef, input.draftRef];
  if (
    input.requestRef.kind !== "produce-request" ||
    input.requestRef.phase !== "intake" ||
    input.requestRef.branch_id !== null ||
    input.requestRef.producer !== "host:request-admission" ||
    input.approachRef.kind !== "artifact-approach" ||
    input.approachRef.phase !== "exploring_artifact_approaches" ||
    input.approachRef.branch_id !== null ||
    input.approachRef.producer !== "agent:ida" ||
    input.approachRef.content_schema?.schema_id !== "penny.artifact-approach.v1" ||
    input.approachRef.content_schema.schema_version !== 1 ||
    input.draftRef.kind !== "produced-artifact-draft" ||
    input.draftRef.phase !== "materializing_artifact" ||
    input.draftRef.branch_id !== null ||
    input.draftRef.producer !== "agent:skribble" ||
    input.draftRef.content_schema?.schema_id !== "penny.produced-artifact-draft.v1" ||
    input.draftRef.content_schema.schema_version !== 1 ||
    new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length ||
    new Set(refs.map((ref) => ref.run_id)).size !== 1
  ) {
    throw new Error("ProducedArtifactV1 sealing refs have invalid, stale, or cross-run roles");
  }
}

export function sealProducedArtifact(input: {
  readonly request: unknown;
  readonly draft: unknown;
  readonly requestRef: ArtifactRef;
  readonly approachRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
}): ProducedArtifactV1 {
  const request = validateProduceRequest(input.request);
  const draft = validateProducedArtifactDraft(input.draft, { request });
  assertProduceSourceRefs(input);
  const lineage: ProducedArtifactSourceLineagePreimageV1 = {
    request_artifact_id: input.requestRef.artifact_id,
    request_artifact_sha256: input.requestRef.content_digest,
    approach_artifact_id: input.approachRef.artifact_id,
    approach_artifact_sha256: input.approachRef.content_digest,
    draft_artifact_id: input.draftRef.artifact_id,
    draft_artifact_sha256: input.draftRef.content_digest,
    draft_sha256: sha256(canonicalJson(draft)),
    source_material: sourceMaterialLineage(request),
  };
  return validateProducedArtifact({
    schema_id: "penny.produced-artifact.v1",
    ...draft,
    content_sha256: sha256(draft.content),
    request,
    request_sha256: produceRequestSha256(request),
    source_lineage: {
      ...lineage,
      lineage_sha256: producedArtifactSourceLineageSha256(lineage),
    },
  });
}

function projectDraftUnchecked(product: ProducedArtifactV1): ProducedArtifactDraftV1 {
  return {
    schema_version: product.schema_version,
    disposition: product.disposition,
    output_name: product.output_name,
    artifact_kind: product.artifact_kind,
    media_type: product.media_type,
    content: product.content,
    rationale: product.rationale,
    assumptions: product.assumptions,
    uncertainties: product.uncertainties,
    request_coverage: product.request_coverage,
    confidence: product.confidence,
    external_actions_performed: product.external_actions_performed,
    filesystem_writes_performed: product.filesystem_writes_performed,
    tests_executed: product.tests_executed,
  };
}

export function validateProducedArtifact(value: unknown): ProducedArtifactV1 {
  const product = validateSkillSchema(ProducedArtifactV1Schema, value, "ProducedArtifactV1");
  const request = validateProduceRequest(product.request);
  if (product.request_sha256 !== produceRequestSha256(request)) {
    throw new Error("ProducedArtifactV1 request digest drifted");
  }
  if (product.content_sha256 !== sha256(product.content)) {
    throw new Error("ProducedArtifactV1 content digest drifted");
  }
  const draft = validateProducedArtifactDraft(projectDraftUnchecked(product), { request });
  const lineage: ProducedArtifactSourceLineagePreimageV1 = {
    request_artifact_id: product.source_lineage.request_artifact_id,
    request_artifact_sha256: product.source_lineage.request_artifact_sha256,
    approach_artifact_id: product.source_lineage.approach_artifact_id,
    approach_artifact_sha256: product.source_lineage.approach_artifact_sha256,
    draft_artifact_id: product.source_lineage.draft_artifact_id,
    draft_artifact_sha256: product.source_lineage.draft_artifact_sha256,
    draft_sha256: product.source_lineage.draft_sha256,
    source_material: product.source_lineage.source_material,
  };
  if (product.source_lineage.lineage_sha256 !== producedArtifactSourceLineageSha256(lineage)) {
    throw new Error("ProducedArtifactV1 source lineage digest drifted");
  }
  assertUnique(
    [lineage.request_artifact_id, lineage.approach_artifact_id, lineage.draft_artifact_id],
    "ProducedArtifactV1 source lineage artifact IDs"
  );
  if (
    canonicalJson(lineage.source_material) !== canonicalJson(sourceMaterialLineage(request)) ||
    lineage.draft_sha256 !== sha256(canonicalJson(draft))
  ) {
    throw new Error("ProducedArtifactV1 draft or inline-source lineage drifted");
  }
  return product;
}

export function assertProducedArtifactLineage(input: {
  readonly product: unknown;
  readonly request: unknown;
  readonly draft: unknown;
  readonly requestRef: ArtifactRef;
  readonly approachRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
}): ProducedArtifactV1 {
  const expected = sealProducedArtifact(input);
  const product = validateProducedArtifact(input.product);
  if (canonicalJson(product) !== canonicalJson(expected)) {
    throw new Error(
      "ProducedArtifactV1 exact request, draft, approach, or source lineage diverged"
    );
  }
  return product;
}

export function validateCanonicalProducedArtifactBytes(
  bytes: Uint8Array,
  ref: ArtifactRef
): ProducedArtifactV1 {
  const body = Buffer.from(bytes);
  if (
    ref.kind !== "semantic-core" ||
    ref.phase !== "sealing_artifact" ||
    ref.branch_id !== null ||
    ref.producer !== "host:artifact-sealer" ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== "penny.produced-artifact.v1" ||
    ref.content_schema.schema_version !== 1 ||
    ref.byte_length !== body.length ||
    ref.content_digest !== sha256(body) ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  ) {
    throw new Error("ProducedArtifactV1 ref is stale or has the wrong semantic identity");
  }
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("ProducedArtifactV1 artifact is not JSON");
  }
  const product = validateProducedArtifact(value);
  if (canonicalJson(product) !== body.toString("utf8")) {
    throw new Error("ProducedArtifactV1 artifact bytes are not canonical JSON");
  }
  return product;
}

export function validateProduceSealFeedback(value: unknown): ProduceSealFeedbackV1 {
  const feedback = validateSkillSchema(ProduceSealFeedbackV1Schema, value, "ProduceSealFeedbackV1");
  for (const issue of feedback.issues) validateText(issue, "Produce seal issue", 512, false);
  return feedback;
}

function assertDerived(value: string, prefix: string, body: unknown, label: string): void {
  if (value !== `${prefix}${sha256(canonicalJson(body))}`) {
    throw new SkillSchemaValidationError(label, ["derived ID does not match canonical body"]);
  }
}

function assertCommonSubjectRefs(input: {
  readonly runId: string;
  readonly requestRef: ArtifactRef;
  readonly approachRef: ArtifactRef;
  readonly draftRef: ArtifactRef;
  readonly productRef: ArtifactRef;
}): void {
  const refs = [input.requestRef, input.approachRef, input.draftRef, input.productRef];
  if (
    refs.some((ref) => ref.run_id !== input.runId) ||
    input.requestRef.kind !== "produce-request" ||
    input.requestRef.phase !== "intake" ||
    input.requestRef.producer !== "host:request-admission" ||
    input.approachRef.kind !== "artifact-approach" ||
    input.approachRef.phase !== "exploring_artifact_approaches" ||
    input.approachRef.producer !== "agent:ida" ||
    input.draftRef.kind !== "produced-artifact-draft" ||
    input.draftRef.phase !== "materializing_artifact" ||
    input.draftRef.producer !== "agent:skribble" ||
    input.productRef.kind !== "semantic-core" ||
    input.productRef.phase !== "sealing_artifact" ||
    input.productRef.producer !== "host:artifact-sealer" ||
    input.productRef.content_schema?.schema_id !== "penny.produced-artifact.v1" ||
    input.productRef.content_schema.schema_version !== 1 ||
    refs.some((ref) => ref.branch_id !== null) ||
    new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length
  ) {
    throw new Error("Produce current-product subject refs disagree");
  }
}

export function produceQualityReceiptId(
  body: Omit<ProduceQualityReceiptV1, "receipt_id">
): `pqrc_${string}` {
  return `pqrc_${sha256(canonicalJson(body))}`;
}

export function validateProduceQualityReceipt(value: unknown): ProduceQualityReceiptV1 {
  const receipt = validateSkillSchema(
    ProduceQualityReceiptV1Schema,
    value,
    "ProduceQualityReceiptV1"
  );
  assertOpaqueId(receipt.run_id, "ProduceQualityReceiptV1.run_id");
  assertRfc3339Utc(receipt.created_at, "ProduceQualityReceiptV1.created_at");
  assertCommonSubjectRefs({
    runId: receipt.run_id,
    requestRef: receipt.request_ref,
    approachRef: receipt.approach_ref,
    draftRef: receipt.draft_ref,
    productRef: receipt.product_ref,
  });
  if (
    receipt.carren_report_ref.run_id !== receipt.run_id ||
    receipt.carren_report_ref.kind !== "agent-output" ||
    receipt.carren_report_ref.phase !== "critiquing_artifact" ||
    receipt.carren_report_ref.producer !== "agent:carren" ||
    receipt.carren_report_ref.branch_id !== null
  ) {
    throw new Error("ProduceQualityReceiptV1 Carren report role disagrees");
  }
  const { receipt_id: receiptId, ...body } = receipt;
  assertDerived(receiptId, "pqrc_", body, "ProduceQualityReceiptV1");
  return receipt;
}

export function produceValidityReceiptId(
  body: Omit<ProduceValidityReceiptV1, "receipt_id">
): `pvrc_${string}` {
  return `pvrc_${sha256(canonicalJson(body))}`;
}

export function validateProduceValidityReceipt(value: unknown): ProduceValidityReceiptV1 {
  const receipt = validateSkillSchema(
    ProduceValidityReceiptV1Schema,
    value,
    "ProduceValidityReceiptV1"
  );
  assertOpaqueId(receipt.run_id, "ProduceValidityReceiptV1.run_id");
  assertRfc3339Utc(receipt.created_at, "ProduceValidityReceiptV1.created_at");
  assertCommonSubjectRefs({
    runId: receipt.run_id,
    requestRef: receipt.request_ref,
    approachRef: receipt.approach_ref,
    draftRef: receipt.draft_ref,
    productRef: receipt.product_ref,
  });
  if (
    receipt.carren_report_ref.run_id !== receipt.run_id ||
    receipt.carren_report_ref.kind !== "agent-output" ||
    receipt.carren_report_ref.phase !== "critiquing_artifact" ||
    receipt.carren_report_ref.producer !== "agent:carren" ||
    receipt.vera_report_ref.run_id !== receipt.run_id ||
    receipt.vera_report_ref.kind !== "agent-output" ||
    receipt.vera_report_ref.phase !== "verifying_artifact" ||
    receipt.vera_report_ref.producer !== "agent:vera" ||
    receipt.quality_receipt_ref.run_id !== receipt.run_id ||
    receipt.quality_receipt_ref.kind !== "produce-quality-receipt" ||
    receipt.quality_receipt_ref.phase !== "admitting_artifact" ||
    receipt.quality_receipt_ref.branch_id !== "quality" ||
    receipt.quality_receipt_ref.producer !== "host:produce-receipt-authority"
  ) {
    throw new Error("ProduceValidityReceiptV1 review or quality-receipt roles disagree");
  }
  const { receipt_id: receiptId, ...body } = receipt;
  assertDerived(receiptId, "pvrc_", body, "ProduceValidityReceiptV1");
  return receipt;
}

export function produceProductIntegrityId(
  body: Omit<ProduceProductIntegrityV1, "integrity_id">
): `pair_${string}` {
  return `pair_${sha256(canonicalJson(body))}`;
}

export function validateProduceProductIntegrity(value: unknown): ProduceProductIntegrityV1 {
  const integrity = validateSkillSchema(
    ProduceProductIntegrityV1Schema,
    value,
    "ProduceProductIntegrityV1"
  );
  if (canonicalJson(integrity.checks) !== canonicalJson(PRODUCE_INTEGRITY_CHECKS)) {
    throw new Error("ProduceProductIntegrityV1 checks are incomplete or reordered");
  }
  const runId = integrity.product_ref.run_id;
  assertCommonSubjectRefs({
    runId,
    requestRef: integrity.request_ref,
    approachRef: integrity.approach_ref,
    draftRef: integrity.draft_ref,
    productRef: integrity.product_ref,
  });
  const refs = [
    integrity.request_ref,
    integrity.approach_ref,
    integrity.draft_ref,
    integrity.product_ref,
    integrity.carren_report_ref,
    integrity.vera_report_ref,
    integrity.quality_receipt_ref,
    integrity.validity_receipt_ref,
  ];
  if (
    refs.some((ref) => ref.run_id !== runId) ||
    new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length ||
    integrity.carren_report_ref.phase !== "critiquing_artifact" ||
    integrity.carren_report_ref.producer !== "agent:carren" ||
    integrity.vera_report_ref.phase !== "verifying_artifact" ||
    integrity.vera_report_ref.producer !== "agent:vera" ||
    integrity.quality_receipt_ref.kind !== "produce-quality-receipt" ||
    integrity.quality_receipt_ref.branch_id !== "quality" ||
    integrity.validity_receipt_ref.kind !== "produce-validity-receipt" ||
    integrity.validity_receipt_ref.branch_id !== "validity"
  ) {
    throw new Error("ProduceProductIntegrityV1 exact artifact roles disagree");
  }
  const { integrity_id: integrityId, ...body } = integrity;
  assertDerived(integrityId, "pair_", body, "ProduceProductIntegrityV1");
  return integrity;
}

export function produceProductEnvelopeId(
  body: Omit<ProduceProductEnvelopeV1, "envelope_id">
): `paenv_${string}` {
  return `paenv_${sha256(canonicalJson(body))}`;
}

export function validateProduceProductEnvelope(value: unknown): ProduceProductEnvelopeV1 {
  const envelope = validateSkillSchema(
    ProduceProductEnvelopeV1Schema,
    value,
    "ProduceProductEnvelopeV1"
  );
  assertOpaqueId(envelope.run_id, "ProduceProductEnvelopeV1.run_id");
  assertCommonSubjectRefs({
    runId: envelope.run_id,
    requestRef: envelope.request_ref,
    approachRef: envelope.approach_ref,
    draftRef: envelope.draft_ref,
    productRef: envelope.product_ref,
  });
  const refs = [
    envelope.request_ref,
    envelope.approach_ref,
    envelope.draft_ref,
    envelope.product_ref,
    envelope.carren_report_ref,
    envelope.vera_report_ref,
    envelope.quality_receipt_ref,
    envelope.validity_receipt_ref,
    envelope.integrity_ref,
  ];
  if (
    refs.some((ref) => ref.run_id !== envelope.run_id) ||
    new Set(refs.map((ref) => ref.artifact_id)).size !== refs.length ||
    envelope.carren_report_ref.phase !== "critiquing_artifact" ||
    envelope.vera_report_ref.phase !== "verifying_artifact" ||
    envelope.quality_receipt_ref.kind !== "produce-quality-receipt" ||
    envelope.validity_receipt_ref.kind !== "produce-validity-receipt" ||
    envelope.integrity_ref.kind !== "produce-product-integrity" ||
    envelope.integrity_ref.phase !== "admitting_artifact" ||
    envelope.integrity_ref.branch_id !== "integrity" ||
    envelope.integrity_ref.producer !== "host:produce-product-validator"
  ) {
    throw new Error("ProduceProductEnvelopeV1 exact artifact roles disagree");
  }
  const { envelope_id: envelopeId, ...body } = envelope;
  assertDerived(envelopeId, "paenv_", body, "ProduceProductEnvelopeV1");
  return envelope;
}
