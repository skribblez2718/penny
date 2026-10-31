import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../checkpointer.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import {
  Rfc3339UtcSchema,
  SchemaIdSchema,
  Sha256Schema,
  assertDerivedId,
  assertRfc3339Utc,
  assertUnique,
  validateSkillSchema,
} from "./common.js";

const ReviewSubjectV1Schema = Type.Object(
  {
    product_ref: ArtifactRefSchema,
    product_schema_id: SchemaIdSchema,
    product_schema_version: Type.Integer({ minimum: 1 }),
    product_sha256: Sha256Schema,
    request_ref: ArtifactRefSchema,
    specification_assurance_ref: Type.Optional(ArtifactRefSchema),
    analysis_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    draft_ref: ArtifactRefSchema,
    evidence_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
    imported_input_refs: Type.Array(ArtifactRefSchema, { maxItems: 16 }),
    admitted_upstream_sha256: Sha256Schema,
  },
  { additionalProperties: false }
);
export type ReviewSubjectV1 = Readonly<Static<typeof ReviewSubjectV1Schema>>;

export const ReviewReceiptV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.review-receipt.v1"),
    schema_version: Type.Literal(1),
    receipt_id: Type.String({ pattern: "^rrpt_[a-f0-9]{64}$" }),
    review_kind: Type.Union([Type.Literal("validity"), Type.Literal("quality")]),
    reviewer: Type.Union([Type.Literal("vera"), Type.Literal("carren")]),
    verdict: Type.Union([Type.Literal("PASS"), Type.Literal("APPROVE")]),
    subject: ReviewSubjectV1Schema,
    review_report_ref: ArtifactRefSchema,
    prior_review_receipt_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    execution_receipt_id: Type.String({ minLength: 1, maxLength: 256 }),
    execution_result_sha256: Sha256Schema,
    created_at: Rfc3339UtcSchema,
    minted_by: Type.Literal("host:review-receipt-authority"),
  },
  { additionalProperties: false }
);
export type ReviewReceiptV1 = Readonly<Static<typeof ReviewReceiptV1Schema>>;

export function reviewSubjectUpstreamRefs(subject: ReviewSubjectV1): readonly ArtifactRef[] {
  return [
    subject.request_ref,
    ...(subject.specification_assurance_ref === undefined
      ? []
      : [subject.specification_assurance_ref]),
    subject.analysis_ref,
    subject.admission_ref,
    subject.draft_ref,
    subject.product_ref,
    ...subject.evidence_refs,
    ...subject.imported_input_refs,
  ];
}

export function reviewSubjectUpstreamSha256(input: {
  readonly request_ref: ArtifactRef;
  readonly specification_assurance_ref?: ArtifactRef;
  readonly analysis_ref: ArtifactRef;
  readonly admission_ref: ArtifactRef;
  readonly draft_ref: ArtifactRef;
  readonly product_ref: ArtifactRef;
  readonly evidence_refs: readonly ArtifactRef[];
  readonly imported_input_refs: readonly ArtifactRef[];
}): string {
  return sha256(
    canonicalJson([
      input.request_ref,
      ...(input.specification_assurance_ref === undefined
        ? []
        : [input.specification_assurance_ref]),
      input.analysis_ref,
      input.admission_ref,
      input.draft_ref,
      input.product_ref,
      ...input.evidence_refs,
      ...input.imported_input_refs,
    ])
  );
}

export function reviewReceiptId(body: Omit<ReviewReceiptV1, "receipt_id">): `rrpt_${string}` {
  return `rrpt_${sha256(canonicalJson(body))}`;
}

export function validateReviewReceipt(value: unknown): ReviewReceiptV1 {
  const receipt = validateSkillSchema(ReviewReceiptV1Schema, value, "ReviewReceiptV1");
  const subject = receipt.subject;
  const productIdentity =
    subject.product_schema_id === "penny.decision.v2" && subject.product_schema_version === 2
      ? {
          kind: "semantic-core",
          validityPhase: "verifying_decision",
          qualityPhase: "critiquing_decision",
        }
      : subject.product_schema_id === "penny.specification.v1" &&
          subject.product_schema_version === 1
        ? {
            kind: "specification",
            validityPhase: "verifying_specification",
            qualityPhase: "critiquing_specification",
          }
        : (subject.product_schema_id === "penny.strategy.v1" &&
              subject.product_schema_version === 1) ||
            (subject.product_schema_id === "penny.strategy.v2" &&
              subject.product_schema_version === 2)
          ? {
              kind: "strategy",
              validityPhase: "verifying_strategy",
              qualityPhase: "critiquing_strategy",
            }
          : undefined;
  if (
    productIdentity === undefined ||
    subject.product_ref.kind !== productIdentity.kind ||
    subject.product_ref.content_schema?.schema_id !== subject.product_schema_id ||
    subject.product_ref.content_schema.schema_version !== subject.product_schema_version ||
    subject.product_ref.content_digest !== subject.product_sha256
  ) {
    throw new Error("ReviewReceiptV1 product identity is stale or inconsistent");
  }
  const upstreamRefs = reviewSubjectUpstreamRefs(subject);
  if (
    subject.admission_ref.kind !== "evidence-admission" ||
    subject.admission_ref.content_schema?.schema_id !== "penny.evidence-admission.v1" ||
    subject.admission_ref.content_schema.schema_version !== 1
  ) {
    throw new Error("ReviewReceiptV1 evidence admission identity disagrees");
  }
  assertUnique(
    upstreamRefs.map((ref) => ref.artifact_id),
    "ReviewReceiptV1 admitted upstream artifact IDs"
  );
  if (subject.admitted_upstream_sha256 !== sha256(canonicalJson(upstreamRefs))) {
    throw new Error("ReviewReceiptV1 admitted upstream digest drifted");
  }
  const expected =
    receipt.review_kind === "validity"
      ? { reviewer: "vera", verdict: "PASS", phase: productIdentity.validityPhase }
      : { reviewer: "carren", verdict: "APPROVE", phase: productIdentity.qualityPhase };
  if (
    receipt.reviewer !== expected.reviewer ||
    receipt.verdict !== expected.verdict ||
    receipt.review_report_ref.phase !== expected.phase ||
    receipt.review_report_ref.producer !== `agent:${expected.reviewer}` ||
    receipt.review_report_ref.kind !== "agent-output"
  ) {
    throw new Error("ReviewReceiptV1 kind, reviewer, verdict, or report identity disagrees");
  }
  if (
    (receipt.review_kind === "validity" && receipt.prior_review_receipt_ref !== null) ||
    (receipt.review_kind === "quality" &&
      (receipt.prior_review_receipt_ref === null ||
        receipt.prior_review_receipt_ref.kind !== "review-receipt"))
  ) {
    throw new Error("ReviewReceiptV1 prior-receipt binding is invalid");
  }
  const expectedReportUpstreams = [
    ...upstreamRefs,
    ...(receipt.prior_review_receipt_ref === null ? [] : [receipt.prior_review_receipt_ref]),
  ];
  const actualReportUpstreamIds = new Set(
    receipt.review_report_ref.artifact_id.length === 0
      ? []
      : expectedReportUpstreams.map((ref) => ref.artifact_id)
  );
  if (actualReportUpstreamIds.size !== expectedReportUpstreams.length) {
    throw new Error("ReviewReceiptV1 report upstream bindings are ambiguous");
  }
  assertRfc3339Utc(receipt.created_at, "ReviewReceiptV1.created_at");
  const { receipt_id: receiptId, ...body } = receipt;
  assertDerivedId(receiptId, "rrpt_", sha256(canonicalJson(body)), "ReviewReceiptV1");
  return receipt;
}

/**
 * Bind a host-derived receipt to the exact upstream refs that the persisted reviewer report
 * actually consumed. Quality review additionally binds the exact prior validity receipt and
 * its report, preserving independent-review order without making either reviewer a router.
 */
export function validateReviewReceiptBinding(input: {
  readonly receipt: unknown;
  readonly review_report_upstream_refs: readonly ArtifactRef[];
  readonly prior_review?: {
    readonly artifact_ref: ArtifactRef;
    readonly receipt: unknown;
  };
}): ReviewReceiptV1 {
  const receipt = validateReviewReceipt(input.receipt);
  const actualById = new Map<string, ArtifactRef>();
  for (const ref of input.review_report_upstream_refs) {
    const existing = actualById.get(ref.artifact_id);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(ref)) {
      throw new Error("ReviewReceiptV1 report contains divergent refs for one artifact ID");
    }
    actualById.set(ref.artifact_id, ref);
  }
  const requireExact = (ref: ArtifactRef, label: string): void => {
    const actual = actualById.get(ref.artifact_id);
    if (actual === undefined || canonicalJson(actual) !== canonicalJson(ref)) {
      throw new Error(`ReviewReceiptV1 report omitted or changed exact ${label}`);
    }
  };
  for (const ref of reviewSubjectUpstreamRefs(receipt.subject)) {
    requireExact(ref, "subject upstream ref");
  }
  if (receipt.review_kind === "validity") {
    if (input.prior_review !== undefined) {
      throw new Error("ReviewReceiptV1 validity binding cannot carry a prior review");
    }
    return receipt;
  }
  const prior = input.prior_review;
  if (prior === undefined || receipt.prior_review_receipt_ref === null) {
    throw new Error("ReviewReceiptV1 quality binding requires the exact prior validity review");
  }
  const priorReceipt = validateReviewReceipt(prior.receipt);
  if (
    priorReceipt.review_kind !== "validity" ||
    canonicalJson(receipt.prior_review_receipt_ref) !== canonicalJson(prior.artifact_ref) ||
    canonicalJson(priorReceipt.subject) !== canonicalJson(receipt.subject)
  ) {
    throw new Error("ReviewReceiptV1 quality binding disagrees with prior validity review");
  }
  requireExact(prior.artifact_ref, "prior validity receipt ref");
  requireExact(priorReceipt.review_report_ref, "prior Vera report ref");
  return receipt;
}

/** Trace-bearing Define review; V1 remains the explicit historical/Decide/Plan reader. */
export const ReviewSubjectV2Schema = Type.Object(
  {
    ...ReviewSubjectV1Schema.properties,
    trace_ref: ArtifactRefSchema,
    frame_ref: ArtifactRefSchema,
    support_refs: Type.Array(ArtifactRefSchema, { maxItems: 69 }),
  },
  { additionalProperties: false }
);
export type ReviewSubjectV2 = Readonly<Static<typeof ReviewSubjectV2Schema>>;
export const ReviewReceiptV2Schema = Type.Object(
  {
    ...ReviewReceiptV1Schema.properties,
    schema_id: Type.Literal("penny.review-receipt.v2"),
    schema_version: Type.Literal(2),
    subject: ReviewSubjectV2Schema,
  },
  { additionalProperties: false }
);
export type ReviewReceiptV2 = Readonly<Static<typeof ReviewReceiptV2Schema>>;

export function reviewSubjectV2UpstreamRefs(
  subject: Omit<ReviewSubjectV2, "admitted_upstream_sha256">
): readonly ArtifactRef[] {
  const refs = [
    subject.request_ref,
    ...(subject.specification_assurance_ref === undefined
      ? []
      : [subject.specification_assurance_ref]),
    subject.analysis_ref,
    subject.frame_ref,
    subject.admission_ref,
    subject.draft_ref,
    subject.product_ref,
    subject.trace_ref,
    ...subject.evidence_refs,
    ...subject.imported_input_refs,
    ...subject.support_refs,
  ];
  const unique = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const existing = unique.get(ref.artifact_id);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(ref))
      throw new Error("ReviewSubjectV2 contains divergent metadata for a support artifact");
    unique.set(ref.artifact_id, ref);
  }
  return [...unique.values()];
}
export function reviewSubjectV2UpstreamSha256(
  subject: Omit<ReviewSubjectV2, "admitted_upstream_sha256">
): string {
  return sha256(canonicalJson(reviewSubjectV2UpstreamRefs(subject)));
}
export function reviewReceiptV2Id(body: Omit<ReviewReceiptV2, "receipt_id">): `rrpt_${string}` {
  return `rrpt_${sha256(canonicalJson(body))}`;
}
export function validateReviewReceiptV2(value: unknown): ReviewReceiptV2 {
  const receipt = validateSkillSchema(ReviewReceiptV2Schema, value, "ReviewReceiptV2");
  const subject = receipt.subject;
  if (
    subject.product_schema_id !== "penny.specification.v1" ||
    subject.product_schema_version !== 1 ||
    subject.product_ref.kind !== "specification" ||
    subject.product_ref.content_schema?.schema_id !== subject.product_schema_id ||
    subject.product_ref.content_digest !== subject.product_sha256 ||
    subject.frame_ref.kind !== "definition-frame" ||
    subject.frame_ref.content_schema?.schema_id !== "penny.definition-frame.v2" ||
    subject.frame_ref.run_id !== subject.product_ref.run_id ||
    subject.trace_ref.kind !== "definition-trace" ||
    subject.trace_ref.content_schema?.schema_id !== "penny.definition-trace.v1" ||
    subject.trace_ref.content_schema.schema_version !== 1 ||
    subject.trace_ref.run_id !== subject.product_ref.run_id ||
    subject.request_ref.run_id !== subject.product_ref.run_id ||
    subject.analysis_ref.run_id !== subject.product_ref.run_id ||
    subject.admission_ref.run_id !== subject.product_ref.run_id ||
    subject.draft_ref.run_id !== subject.product_ref.run_id ||
    (subject.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v2" &&
      subject.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v3") ||
    subject.analysis_ref.phase !== "framing_definition" ||
    subject.analysis_ref.kind !== "agent-output" ||
    subject.product_ref.phase !== "sealing_specification" ||
    subject.request_ref.kind !== "definition-request" ||
    subject.admission_ref.kind !== "evidence-admission" ||
    subject.draft_ref.kind !== "specification-draft" ||
    subject.admission_ref.content_schema?.schema_id !== "penny.evidence-admission.v2" ||
    subject.admission_ref.content_schema.schema_version !== 2 ||
    subject.admitted_upstream_sha256 !== sha256(canonicalJson(reviewSubjectV2UpstreamRefs(subject)))
  ) {
    throw new Error("ReviewReceiptV2 subject product/trace/admission binding is invalid");
  }
  assertUnique(
    subject.support_refs.map((ref) => ref.artifact_id),
    "ReviewSubjectV2 support refs"
  );
  assertUnique(
    reviewSubjectV2UpstreamRefs(subject).map((ref) => ref.artifact_id),
    "ReviewReceiptV2 subject refs"
  );
  const expected =
    receipt.review_kind === "validity"
      ? { reviewer: "vera", verdict: "PASS", phase: "verifying_specification" }
      : { reviewer: "carren", verdict: "APPROVE", phase: "critiquing_specification" };
  if (
    receipt.reviewer !== expected.reviewer ||
    receipt.verdict !== expected.verdict ||
    receipt.review_report_ref.phase !== expected.phase ||
    receipt.review_report_ref.producer !== `agent:${expected.reviewer}` ||
    receipt.review_report_ref.kind !== "agent-output" ||
    receipt.review_report_ref.run_id !== subject.product_ref.run_id ||
    (receipt.review_kind === "validity") !== (receipt.prior_review_receipt_ref === null) ||
    (receipt.prior_review_receipt_ref !== null &&
      receipt.prior_review_receipt_ref.content_schema?.schema_id !== "penny.review-receipt.v2")
  ) {
    throw new Error("ReviewReceiptV2 reviewer or prior receipt is invalid");
  }
  assertRfc3339Utc(receipt.created_at, "ReviewReceiptV2.created_at");
  const { receipt_id: id, ...body } = receipt;
  assertDerivedId(id, "rrpt_", sha256(canonicalJson(body)), "ReviewReceiptV2");
  return receipt;
}

export function validateReviewReceiptV2Binding(input: {
  readonly receipt: unknown;
  readonly review_report_upstream_refs: readonly ArtifactRef[];
  readonly prior_review?: { readonly artifact_ref: ArtifactRef; readonly receipt: unknown };
}): ReviewReceiptV2 {
  const receipt = validateReviewReceiptV2(input.receipt);
  const refs = input.review_report_upstream_refs;
  assertUnique(
    refs.map((ref) => ref.artifact_id),
    "ReviewReceiptV2 report refs"
  );
  for (const required of reviewSubjectV2UpstreamRefs(receipt.subject)) {
    if (!refs.some((ref) => canonicalJson(ref) === canonicalJson(required))) {
      throw new Error("ReviewReceiptV2 report lacks exact subject ref");
    }
  }
  if (receipt.review_kind === "validity") {
    if (input.prior_review !== undefined)
      throw new Error("ReviewReceiptV2 validity has a prior receipt");
  } else {
    if (input.prior_review === undefined || receipt.prior_review_receipt_ref === null) {
      throw new Error("ReviewReceiptV2 quality needs prior validity");
    }
    const priorReview = input.prior_review;
    const prior = validateReviewReceiptV2(priorReview.receipt);
    if (
      prior.review_kind !== "validity" ||
      canonicalJson(prior.subject) !== canonicalJson(receipt.subject) ||
      canonicalJson(receipt.prior_review_receipt_ref) !== canonicalJson(priorReview.artifact_ref) ||
      !refs.some((ref) => canonicalJson(ref) === canonicalJson(priorReview.artifact_ref)) ||
      !refs.some((ref) => canonicalJson(ref) === canonicalJson(prior.review_report_ref))
    ) {
      throw new Error("ReviewReceiptV2 quality prior review binding is invalid");
    }
  }
  return receipt;
}
