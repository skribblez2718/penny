import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  reviewReceiptId,
  reviewSubjectUpstreamRefs,
  reviewSubjectUpstreamSha256,
  sha256,
  validateReviewReceipt,
  validateReviewReceiptBinding,
  type ArtifactRef,
  type ReviewReceiptV1,
  type ReviewSubjectV1,
} from "../src/index.js";

let sequence = 0;

function ref(input: {
  kind: string;
  phase: string;
  producer: string;
  schemaId?: string;
  schemaVersion?: number;
  branchId?: string | null;
}): ArtifactRef {
  sequence += 1;
  const content = `${input.kind}:${sequence}`;
  const digest = sha256(content);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(`artifact:${sequence}`)}`,
    run_id: "run-review-contract",
    phase: input.phase,
    branch_id: input.branchId ?? null,
    kind: input.kind,
    operation_id: `${input.kind}:fixture`,
    version: 1,
    producer: input.producer,
    media_type: "application/json",
    ...(input.schemaId === undefined
      ? {}
      : {
          content_schema: {
            schema_id: input.schemaId,
            schema_version: input.schemaVersion ?? 1,
          },
        }),
    byte_length: Buffer.byteLength(content),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function subject(): ReviewSubjectV1 {
  const request = ref({ kind: "decision-request", phase: "intake", producer: "host:request" });
  const analysis = ref({
    kind: "agent-output",
    phase: "analyzing_decision",
    producer: "agent:annie",
  });
  const admission = ref({
    kind: "evidence-admission",
    phase: "decision_evidence_gate",
    producer: "host:evidence-gate",
    schemaId: "penny.evidence-admission.v1",
  });
  const draft = ref({ kind: "decision-draft", phase: "deciding", producer: "agent:demetri" });
  const product = ref({
    kind: "semantic-core",
    phase: "sealing_decision",
    producer: "host:decision-sealer",
    schemaId: "penny.decision.v2",
    schemaVersion: 2,
  });
  const evidence = ref({
    kind: "agent-output",
    phase: "researching_decision",
    producer: "agent:echo",
  });
  const imported = ref({
    kind: "semantic-core",
    phase: "complete",
    producer: "host:research",
    schemaId: "penny.grounded-synthesis.v1",
  });
  const basis = {
    request_ref: request,
    analysis_ref: analysis,
    admission_ref: admission,
    draft_ref: draft,
    product_ref: product,
    evidence_refs: [evidence],
    imported_input_refs: [imported],
  };
  return {
    ...basis,
    product_schema_id: "penny.decision.v2",
    product_schema_version: 2,
    product_sha256: product.content_digest,
    admitted_upstream_sha256: reviewSubjectUpstreamSha256(basis),
  };
}

function validityReceipt(reviewSubject: ReviewSubjectV1): ReviewReceiptV1 {
  const report = ref({
    kind: "agent-output",
    phase: "verifying_decision",
    producer: "agent:vera",
  });
  const body: Omit<ReviewReceiptV1, "receipt_id"> = {
    schema_id: "penny.review-receipt.v1",
    schema_version: 1,
    review_kind: "validity",
    reviewer: "vera",
    verdict: "PASS",
    subject: reviewSubject,
    review_report_ref: report,
    prior_review_receipt_ref: null,
    execution_receipt_id: "receipt-vera",
    execution_result_sha256: sha256("vera-result"),
    created_at: "2026-08-31T12:00:00.000Z",
    minted_by: "host:review-receipt-authority",
  };
  return validateReviewReceipt({ ...body, receipt_id: reviewReceiptId(body) });
}

function receiptArtifact(receipt: ReviewReceiptV1): ArtifactRef {
  const content = canonicalJson(receipt);
  const digest = sha256(content);
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(`receipt-artifact:${receipt.receipt_id}`)}`,
    run_id: receipt.subject.product_ref.run_id,
    phase: "verifying_decision",
    branch_id: "validity",
    kind: "review-receipt",
    operation_id: "review-receipt:validity",
    version: 1,
    producer: "host:review-receipt-authority",
    media_type: "application/json",
    content_schema: { schema_id: "penny.review-receipt.v1", schema_version: 1 },
    byte_length: Buffer.byteLength(content),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

function qualityReceipt(reviewSubject: ReviewSubjectV1, validityRef: ArtifactRef): ReviewReceiptV1 {
  const report = ref({
    kind: "agent-output",
    phase: "critiquing_decision",
    producer: "agent:carren",
  });
  const body: Omit<ReviewReceiptV1, "receipt_id"> = {
    schema_id: "penny.review-receipt.v1",
    schema_version: 1,
    review_kind: "quality",
    reviewer: "carren",
    verdict: "APPROVE",
    subject: reviewSubject,
    review_report_ref: report,
    prior_review_receipt_ref: validityRef,
    execution_receipt_id: "receipt-carren",
    execution_result_sha256: sha256("carren-result"),
    created_at: "2026-08-31T12:01:00.000Z",
    minted_by: "host:review-receipt-authority",
  };
  return validateReviewReceipt({ ...body, receipt_id: reviewReceiptId(body) });
}

describe("minimal shared review receipt substrate", () => {
  it("derives deterministic IDs and rejects product, upstream, reviewer, or verdict drift", () => {
    const reviewSubject = subject();
    const receipt = validityReceipt(reviewSubject);
    expect(validateReviewReceipt(receipt)).toEqual(receipt);
    expect(() =>
      validateReviewReceipt({ ...receipt, created_at: "2026-08-31T12:02:00.000Z" })
    ).toThrow(/derived ID/u);
    expect(() =>
      validateReviewReceipt({
        ...receipt,
        subject: { ...receipt.subject, product_sha256: sha256("stale") },
      })
    ).toThrow(/product identity/u);
    expect(() =>
      validateReviewReceipt({
        ...receipt,
        subject: { ...receipt.subject, admitted_upstream_sha256: sha256("stale") },
      })
    ).toThrow(/upstream digest/u);
    expect(() => validateReviewReceipt({ ...receipt, reviewer: "carren" })).toThrow(/reviewer/u);
    expect(() => validateReviewReceipt({ ...receipt, verdict: "APPROVE" })).toThrow(/verdict/u);
  });

  it("requires every exact subject ref in the persisted reviewer report binding", () => {
    const reviewSubject = subject();
    const receipt = validityReceipt(reviewSubject);
    const upstreams = reviewSubjectUpstreamRefs(reviewSubject);
    expect(
      validateReviewReceiptBinding({ receipt, review_report_upstream_refs: upstreams })
    ).toEqual(receipt);
    expect(() =>
      validateReviewReceiptBinding({
        receipt,
        review_report_upstream_refs: upstreams.slice(1),
      })
    ).toThrow(/omitted or changed/u);
    const first = upstreams[0];
    if (first === undefined) throw new Error("review subject has no upstream refs");
    const changed: ArtifactRef = { ...first, version: first.version + 1 };
    expect(() =>
      validateReviewReceiptBinding({
        receipt,
        review_report_upstream_refs: [changed, ...upstreams.slice(1)],
      })
    ).toThrow(/omitted or changed/u);
  });

  it("binds quality to the exact prior validity receipt, subject, and Vera report", () => {
    const reviewSubject = subject();
    const validity = validityReceipt(reviewSubject);
    const validityRef = receiptArtifact(validity);
    const quality = qualityReceipt(reviewSubject, validityRef);
    const upstreams = [
      ...reviewSubjectUpstreamRefs(reviewSubject),
      validity.review_report_ref,
      validityRef,
    ];
    expect(
      validateReviewReceiptBinding({
        receipt: quality,
        review_report_upstream_refs: upstreams,
        prior_review: { artifact_ref: validityRef, receipt: validity },
      })
    ).toEqual(quality);
    expect(() =>
      validateReviewReceiptBinding({ receipt: quality, review_report_upstream_refs: upstreams })
    ).toThrow(/requires the exact prior/u);
    expect(() =>
      validateReviewReceiptBinding({
        receipt: quality,
        review_report_upstream_refs: upstreams.filter(
          (candidate) => candidate.artifact_id !== validity.review_report_ref.artifact_id
        ),
        prior_review: { artifact_ref: validityRef, receipt: validity },
      })
    ).toThrow(/prior Vera report/u);
    const otherSubject = subject();
    const otherValidity = validityReceipt(otherSubject);
    expect(() =>
      validateReviewReceiptBinding({
        receipt: quality,
        review_report_upstream_refs: upstreams,
        prior_review: { artifact_ref: validityRef, receipt: otherValidity },
      })
    ).toThrow(/disagrees/u);
  });
});
