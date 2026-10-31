import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256,
  canonicalizeDefinitionFrameV2,
  parseSpecificationDraftV2,
  validateEvidenceAdmissionV2,
  evidenceAdmissionV2Id,
  assertDefinitionAllowedUse,
  validateDefinitionTraceV1,
  MAX_DEFINITION_TRACE_BYTES,
  validateReviewReceiptV2Binding,
  reviewSubjectV2UpstreamRefs,
  reviewReceiptV2Id,
  type ArtifactRef,
  type EvidenceAdmissionV2,
} from "../dist/index.js";
import { genericDefinitionRequest, genericSpecificationCore } from "./fixtures/define-fixtures.js";

function ref(input: {
  run: string;
  phase: string;
  kind: string;
  schema?: string;
  content: string;
}): ArtifactRef {
  const digest = sha256(input.content);
  return {
    schema_version: 2,
    artifact_id: `art_${digest}`,
    run_id: input.run,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: `operation-${input.kind}`,
    version: 1,
    producer: input.kind === "agent-output" ? "agent:piper" : "host:definition-framer",
    media_type: "application/json",
    ...(input.schema === undefined
      ? {}
      : {
          content_schema: {
            schema_id: input.schema,
            schema_version: Number(input.schema.split(".v").at(-1)),
          },
        }),
    byte_length: Buffer.byteLength(input.content),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

describe("Define V2 contract boundaries", () => {
  const request = genericDefinitionRequest();
  const run = "run-v2-contract";
  const requestRef = ref({
    run,
    phase: "intake",
    kind: "definition-request",
    schema: "penny.definition-request.v1",
    content: canonicalJson(request),
  });
  const orientation = ref({
    run,
    phase: "framing_definition",
    kind: "agent-output",
    content: "orientation",
  });
  const frame = canonicalizeDefinitionFrameV2({
    request,
    requestRef,
    orientationRef: orientation,
    selectedProfileId: "generic",
    profileSelectionBasis: "Requested generic profile.",
    route: "author",
    routeReason: "No blocking question.",
    discoveredQuestions: [],
  });
  const frameRef = ref({
    run,
    phase: "definition_readiness_gate",
    kind: "definition-frame",
    schema: "penny.definition-frame.v2",
    content: canonicalJson(frame),
  });

  it("accepts a finite admission with exact declared uses; refuses duplicate or widened slots", () => {
    const body: Omit<EvidenceAdmissionV2, "admission_id"> = {
      schema_id: "penny.evidence-admission.v2",
      schema_version: 2,
      run_id: run,
      domain: "specification",
      origin_state: "framing_definition",
      source_artifact_ref: orientation,
      frame_ref: frameRef,
      routing_result_sha256: "a".repeat(64),
      source_execution_receipt_ids: ["receipt-1"],
      classification: "basis_sufficient",
      evidence_required: false,
      minted_by: "host:evidence-gate",
      support_slots: [],
    };
    expect(
      validateEvidenceAdmissionV2({ ...body, admission_id: evidenceAdmissionV2Id(body) })
        .support_slots
    ).toEqual([]);
    const slot = {
      ref: orientation,
      role: "native_evidence" as const,
      allowed_uses: [{ kind: "standard_category" as const, category: "privacy" }],
      challenge_ref: null,
    };
    expect(
      assertDefinitionAllowedUse(slot, { kind: "standard_category", category: "privacy" })
    ).toBe(orientation);
    expect(() =>
      assertDefinitionAllowedUse(slot, { kind: "standard_category", category: "safety" })
    ).toThrow(/not admitted/u);
    const duplicate = { ...body, support_slots: [slot, slot] };
    expect(() =>
      validateEvidenceAdmissionV2({ ...duplicate, admission_id: evidenceAdmissionV2Id(duplicate) })
    ).toThrow(/slot refs/u);
    const responseSlot = { ...slot, role: "caller_response" as const, challenge_ref: frameRef };
    const invalid = { ...body, support_slots: [responseSlot] };
    expect(() =>
      validateEvidenceAdmissionV2({ ...invalid, admission_id: evidenceAdmissionV2Id(invalid) })
    ).toThrow(/caller response role/u);
  });

  it("rejects trace tampering, non-V2 roles and excessive projection bytes", () => {
    const body = {
      schema_id: "penny.definition-trace.v1" as const,
      schema_version: 1 as const,
      registration_binding: {
        name: "define" as const,
        contract_sha256: "b".repeat(64),
        registration_sha256: "c".repeat(64),
      },
      request_ref: requestRef,
      manifest_ref: { ...requestRef, kind: "definition-source-manifest" },
      frame_ref: frameRef,
      admission_ref: {
        ...frameRef,
        kind: "evidence-admission",
        content_schema: { schema_id: "penny.evidence-admission.v2", schema_version: 2 },
      },
      draft_ref: {
        ...frameRef,
        kind: "specification-draft",
        content_schema: { schema_id: "penny.specification-draft.v2", schema_version: 2 },
      },
      product_ref: { ...frameRef, kind: "specification" },
      prior_product_ref: null,
      support_refs: [],
      coverage: [
        {
          source_item_id: "source-one",
          ordinal: 0,
          disposition: "incorporated" as const,
          product_item_ids: ["product-one"],
        },
      ],
      question_resolutions: [],
      standard_support: [],
      protected_mappings: [],
      readiness: {
        disposition: "ready" as const,
        blocking_question_ids: [],
        unresolved_source_ids: [],
      },
    };
    const trace = validateDefinitionTraceV1({
      ...body,
      projection_sha256: sha256(canonicalJson(body)),
    });
    expect(Buffer.byteLength(canonicalJson(trace))).toBeLessThan(MAX_DEFINITION_TRACE_BYTES);
    expect(() =>
      validateDefinitionTraceV1({
        ...trace,
        readiness: { ...trace.readiness, disposition: "blocked" },
      })
    ).toThrow(/identity/u);
    expect(() => validateDefinitionTraceV1({ ...trace, frame_ref: requestRef })).toThrow(/roles/u);
  });

  it("binds a Define review to both product and trace and rejects a report missing trace", () => {
    const product = ref({
      run,
      phase: "sealing_specification",
      kind: "specification",
      schema: "penny.specification.v1",
      content: "product",
    });
    const trace = ref({
      run,
      phase: "sealing_specification",
      kind: "definition-trace",
      schema: "penny.definition-trace.v1",
      content: "trace",
    });
    const admission = ref({
      run,
      phase: "definition_readiness_gate",
      kind: "evidence-admission",
      schema: "penny.evidence-admission.v2",
      content: "admission",
    });
    const draft = ref({
      run,
      phase: "authoring_specification",
      kind: "specification-draft",
      schema: "penny.specification-draft.v2",
      content: "draft",
    });
    const base = {
      product_ref: product,
      product_schema_id: "penny.specification.v1",
      product_schema_version: 1,
      product_sha256: product.content_digest,
      request_ref: requestRef,
      analysis_ref: orientation,
      frame_ref: frameRef,
      admission_ref: admission,
      draft_ref: draft,
      trace_ref: trace,
      support_refs: [],
      evidence_refs: [],
      imported_input_refs: [],
    };
    const subject = {
      ...base,
      admitted_upstream_sha256: sha256(
        canonicalJson([requestRef, orientation, frameRef, admission, draft, product, trace])
      ),
    };
    const report = ref({
      run,
      phase: "verifying_specification",
      kind: "agent-output",
      content: "report",
    });
    const body = {
      schema_id: "penny.review-receipt.v2" as const,
      schema_version: 2 as const,
      review_kind: "validity" as const,
      reviewer: "vera" as const,
      verdict: "PASS" as const,
      subject,
      review_report_ref: { ...report, producer: "agent:vera" },
      prior_review_receipt_ref: null,
      execution_receipt_id: "worker-1",
      execution_result_sha256: "e".repeat(64),
      created_at: "2026-01-01T00:00:00Z",
      minted_by: "host:review-receipt-authority" as const,
    };
    const receipt = { ...body, receipt_id: reviewReceiptV2Id(body) };
    expect(
      validateReviewReceiptV2Binding({
        receipt,
        review_report_upstream_refs: reviewSubjectV2UpstreamRefs(subject),
      }).subject.trace_ref
    ).toEqual(trace);
    expect(() =>
      validateReviewReceiptV2Binding({
        receipt,
        review_report_upstream_refs: reviewSubjectV2UpstreamRefs(subject).filter(
          (r) => r.artifact_id !== trace.artifact_id
        ),
      })
    ).toThrow(/lacks exact/u);
    expect(() =>
      validateReviewReceiptV2Binding({
        receipt: {
          ...receipt,
          subject: {
            ...subject,
            trace_ref: { ...trace, content_digest: "f".repeat(64) },
          },
        },
        review_report_upstream_refs: reviewSubjectV2UpstreamRefs(subject),
      })
    ).toThrow();
  });

  it("parses the actual V2 footer with protected draft semantics and refuses a V1 wrapper", () => {
    const specification = genericSpecificationCore();
    const wrapper = {
      schema_version: 2,
      specification: {
        ...specification,
        source_coverage: specification.source_coverage.map(
          ({ source_item_index, disposition, rationale }) => ({
            source_item_index,
            disposition,
            rationale,
          })
        ),
      },
      support_claims: [],
    };
    const bytes = Buffer.from(
      `Definition report.\nSPECIFICATION_CORE:${canonicalJson(wrapper)}\nSUMMARY:${canonicalJson({ confidence: specification.confidence, complete: true })}\n`
    );
    const parsed = parseSpecificationDraftV2(bytes, { request, frame });
    expect(parsed.legacyCore.constraints[0]?.statement).toBe(request.hard_constraints[0]);
    const bad = Buffer.from(
      `Definition report.\nSPECIFICATION_CORE:${canonicalJson(specification)}\nSUMMARY:${canonicalJson({ confidence: specification.confidence, complete: true })}\n`
    );
    expect(() => parseSpecificationDraftV2(bad, { request, frame })).toThrow(
      /SCHEMA_INVALID|schema/u
    );
    const erasure = { ...wrapper, specification: { ...wrapper.specification, constraints: [] } };
    expect(() =>
      parseSpecificationDraftV2(
        Buffer.from(
          `Definition report.\nSPECIFICATION_CORE:${canonicalJson(erasure)}\nSUMMARY:${canonicalJson({ confidence: specification.confidence, complete: true })}\n`
        ),
        { request, frame }
      )
    ).toThrow(/hard_constraints/u);
  });
});
