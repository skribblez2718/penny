import { describe, expect, it } from "vitest";

import {
  AssessmentDraftValidationError,
  SEMANTIC_PRODUCT_VALIDATORS,
  assessmentDraftPromptContract,
  canonicalJson,
  canonicalizeAssessmentRequest,
  parsePersistedAssessmentDraft,
  sealAssessmentDraft,
  sha256,
  validateAssessmentDraft,
  validateAssessmentRequest,
  validateCanonicalAssessmentBytes,
  type ArtifactRef,
  type AssessmentDraftV1,
  type AssessmentRequestV1,
} from "../src/index.js";

const RUN_ID = "run-assess-contract";

function request(): AssessmentRequestV1 {
  return {
    schema_version: 1,
    assessment_purpose: "Assess whether the supplied release note satisfies the criteria.",
    target: [
      { statement: "Maintenance starts Tuesday at 09:00 UTC." },
      { statement: "Thanks for your patience." },
    ],
    criteria: [
      { statement: "States the maintenance time clearly.", importance: "required" },
      { statement: "Uses a courteous tone.", importance: "advisory" },
    ],
    supplied_evidence: [
      { statement: "The note names Tuesday at 09:00 UTC.", source_label: "caller observation" },
      { statement: "The note thanks its audience." },
    ],
    hard_constraints: [{ statement: "Do not externally verify the schedule." }],
    non_goals: [{ statement: "Do not rewrite or send the note." }],
    known_uncertainties: [{ statement: "The intended audience was not specified." }],
  };
}

function coverage() {
  return {
    assessment_purpose_covered: true as const,
    target_statement_indexes: [0, 1],
    criterion_indexes: [0, 1],
    supplied_evidence_indexes: [0, 1],
    hard_constraint_indexes: [0],
    non_goal_indexes: [0],
    known_uncertainty_indexes: [0],
  };
}

function outcome(
  criterionIndex: number,
  verdict: "met" | "partially_met" | "not_met" | "not_assessable",
  evidenceIndex?: number
) {
  return {
    criterion_index: criterionIndex,
    verdict,
    supporting_evidence_indexes:
      evidenceIndex === undefined || verdict === "not_met" || verdict === "not_assessable"
        ? []
        : [evidenceIndex],
    contradicting_evidence_indexes:
      verdict === "not_met" && evidenceIndex !== undefined ? [evidenceIndex] : [],
    rationale: `Criterion ${criterionIndex} is ${verdict} from the supplied material.`,
  };
}

function draft(disposition: AssessmentDraftV1["disposition"] = "meets"): AssessmentDraftV1 {
  const criterionOutcomes =
    disposition === "meets"
      ? [outcome(0, "met", 0), outcome(1, "met", 1)]
      : disposition === "partially_meets"
        ? [outcome(0, "partially_met", 0), outcome(1, "met", 1)]
        : disposition === "does_not_meet"
          ? [outcome(0, "not_met", 0), outcome(1, "met", 1)]
          : [outcome(0, "not_assessable"), outcome(1, "not_assessable")];
  return {
    schema_version: 1,
    disposition,
    criterion_outcomes: criterionOutcomes,
    summary: `The assessment disposition is ${disposition}.`,
    strengths:
      disposition === "not_applicable"
        ? []
        : [
            {
              statement: "The note uses a courteous close.",
              criterion_indexes: [1],
              evidence_indexes: [1],
            },
          ],
    gaps:
      disposition === "does_not_meet"
        ? [
            {
              statement: "The required timing statement is contradicted.",
              criterion_indexes: [0],
              evidence_indexes: [0],
              severity: "major",
            },
          ]
        : disposition === "partially_meets"
          ? [
              {
                statement: "The required timing statement is only partial.",
                criterion_indexes: [0],
                evidence_indexes: [0],
                severity: "minor",
              },
            ]
          : [],
    improvement_suggestions:
      disposition === "does_not_meet" || disposition === "partially_meets"
        ? [{ suggestion: "Clarify the required timing statement.", criterion_indexes: [0] }]
        : [],
    assumptions: [],
    uncertainties:
      disposition === "inconclusive" || disposition === "not_applicable"
        ? ["The supplied material does not establish criterion applicability."]
        : [],
    request_coverage: coverage(),
    confidence: disposition === "inconclusive" ? "UNCERTAIN" : "PROBABLE",
    external_actions_performed: false,
    filesystem_writes_performed: false,
    tests_executed: false,
    changes_started: false,
  };
}

function persisted(value: AssessmentDraftV1): string {
  return `ASSESSMENT_DRAFT:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
}

function ref(input: {
  readonly id: string;
  readonly phase: string;
  readonly kind: string;
  readonly producer: string;
  readonly content: string;
  readonly schema?: { readonly schema_id: string; readonly schema_version: number };
}): ArtifactRef {
  const digest = sha256(input.content);
  return {
    schema_version: 2,
    artifact_id: `art_${input.id.repeat(64)}`,
    run_id: RUN_ID,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: `${input.kind}:fixture`,
    version: 1,
    producer: input.producer,
    media_type: "application/json",
    ...(input.schema === undefined ? {} : { content_schema: input.schema }),
    byte_length: Buffer.byteLength(input.content),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

describe("closed AssessmentRequestV1", () => {
  it("canonicalizes exact inline constraints and rejects artifacts, action fields, and open criteria", () => {
    const value = request();
    const { assessment_purpose: goal, ...constraints } = value;
    expect(canonicalizeAssessmentRequest({ goal, constraints })).toEqual(value);
    expect(() => validateAssessmentRequest({ ...value, execute_improvements: true })).toThrow();
    expect(() =>
      canonicalizeAssessmentRequest({ goal, constraints: { ...constraints, score: 9 } })
    ).toThrow();
    expect(() => validateAssessmentRequest({ ...value, criteria: [] })).toThrow();
  });
});

describe("AssessmentDraftV1 categorical semantics and framing", () => {
  it("accepts all five honest categorical dispositions without a score", () => {
    for (const disposition of [
      "meets",
      "partially_meets",
      "does_not_meet",
      "inconclusive",
      "not_applicable",
    ] as const) {
      expect(validateAssessmentDraft(draft(disposition), { request: request() }).disposition).toBe(
        disposition
      );
    }
  });

  it("rejects disposition theater, invented indexes, numeric scoring, and consequence claims", () => {
    expect(() =>
      validateAssessmentDraft(
        { ...draft("meets"), criterion_outcomes: [outcome(0, "met", 0)] },
        { request: request() }
      )
    ).toThrow(AssessmentDraftValidationError);
    expect(() =>
      validateAssessmentDraft(
        { ...draft("meets"), disposition: "partially_meets" },
        { request: request() }
      )
    ).toThrow(/partially_meets/u);
    const numericScore: Record<string, unknown> = { ...draft("meets"), score: 100 };
    expect(() => validateAssessmentDraft(numericScore, { request: request() })).toThrow(
      AssessmentDraftValidationError
    );
    expect(() =>
      validateAssessmentDraft({ ...draft("meets"), tests_executed: true }, { request: request() })
    ).toThrow(AssessmentDraftValidationError);
    const bad = draft("meets");
    const first = bad.criterion_outcomes[0];
    if (first === undefined) throw new Error("fixture requires an outcome");
    expect(() =>
      validateAssessmentDraft(
        {
          ...bad,
          criterion_outcomes: [
            { ...first, supporting_evidence_indexes: [2] },
            ...bad.criterion_outcomes.slice(1),
          ],
        },
        { request: request() }
      )
    ).toThrow(/within 0\.\.1/u);
  });

  it("parses only the strict two-line transport with matching confidence", () => {
    const value = draft();
    expect(
      parsePersistedAssessmentDraft(Buffer.from(persisted(value)), { request: request() })
    ).toEqual({
      draft: value,
      summary: { confidence: "PROBABLE", complete: true },
    });
    expect(() =>
      parsePersistedAssessmentDraft(Buffer.from(`Prose\n${persisted(value)}`), {
        request: request(),
      })
    ).toThrow(/exactly one unwrapped/u);
    expect(() =>
      parsePersistedAssessmentDraft(
        Buffer.from(
          `ASSESSMENT_DRAFT:${canonicalJson(value)}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`
        ),
        { request: request() }
      )
    ).toThrow(/confidence/u);
    expect(assessmentDraftPromptContract()).toMatch(/numeric scores are forbidden/iu);
  });
});

describe("provider-free assessment conformance", () => {
  it("accepts meaning-preserving wording variation without exact-string grading", () => {
    const original = draft("meets");
    const varied: AssessmentDraftV1 = {
      ...original,
      summary: "Every supplied criterion is met by the supplied evidence.",
      criterion_outcomes: original.criterion_outcomes.map((item) => ({
        ...item,
        rationale: `Supplied material supports criterion ${item.criterion_index}.`,
      })),
      strengths: original.strengths.map((item) => ({
        ...item,
        statement: "The closing remains courteous.",
      })),
    };
    const validatedOriginal = validateAssessmentDraft(original, { request: request() });
    const validatedVaried = validateAssessmentDraft(varied, { request: request() });
    expect(canonicalJson(validatedVaried)).not.toBe(canonicalJson(validatedOriginal));
    expect({
      disposition: validatedVaried.disposition,
      outcomes: validatedVaried.criterion_outcomes.map((item) => [
        item.criterion_index,
        item.verdict,
      ]),
      coverage: validatedVaried.request_coverage,
    }).toEqual({
      disposition: validatedOriginal.disposition,
      outcomes: validatedOriginal.criterion_outcomes.map((item) => [
        item.criterion_index,
        item.verdict,
      ]),
      coverage: validatedOriginal.request_coverage,
    });
  });

  it("rejects a stale draft after a material request mutation and admits the matching draft", () => {
    const originalRequest = request();
    const mutatedRequest: AssessmentRequestV1 = {
      ...originalRequest,
      criteria: [
        ...originalRequest.criteria,
        { statement: "Names the affected service.", importance: "required" },
      ],
      supplied_evidence: [
        ...originalRequest.supplied_evidence,
        { statement: "The note names the affected service." },
      ],
    };
    expect(() => validateAssessmentDraft(draft("meets"), { request: mutatedRequest })).toThrow(
      AssessmentDraftValidationError
    );

    const matching: AssessmentDraftV1 = {
      ...draft("meets"),
      criterion_outcomes: [...draft("meets").criterion_outcomes, outcome(2, "met", 2)],
      request_coverage: {
        ...coverage(),
        criterion_indexes: [0, 1, 2],
        supplied_evidence_indexes: [0, 1, 2],
      },
    };
    expect(validateAssessmentDraft(matching, { request: mutatedRequest })).toEqual(matching);
  });
});

describe("canonical AssessmentV1 sealing", () => {
  it("binds exact request, Annie, and Carren lineage and validates canonical bytes", () => {
    const value = draft();
    const requestRef = ref({
      id: "1",
      phase: "intake",
      kind: "assessment-request",
      producer: "host:request-admission",
      content: canonicalJson(request()),
      schema: { schema_id: "penny.assessment-request.v1", schema_version: 1 },
    });
    const analysisRef = ref({
      id: "2",
      phase: "analyzing_assessment",
      kind: "agent-output",
      producer: "agent:annie",
      content: "analysis",
    });
    const draftRef = ref({
      id: "3",
      phase: "authoring_assessment",
      kind: "assessment-draft",
      producer: "agent:carren",
      content: persisted(value),
      schema: { schema_id: "penny.assessment-draft.v1", schema_version: 1 },
    });
    const assessment = sealAssessmentDraft({
      request: request(),
      draft: value,
      requestRef,
      analysisRef,
      draftRef,
    });
    const content = canonicalJson(assessment);
    const productRef = ref({
      id: "4",
      phase: "sealing_assessment",
      kind: "semantic-core",
      producer: "host:assessment-sealer",
      content,
      schema: { schema_id: "penny.assessment.v1", schema_version: 1 },
    });
    expect(validateCanonicalAssessmentBytes(Buffer.from(content), productRef)).toEqual(assessment);
    expect(SEMANTIC_PRODUCT_VALIDATORS.get("penny.assessment.v1")).toMatchObject({
      schema_version: 1,
      artifact_kind: "semantic-core",
    });
    expect(() =>
      validateCanonicalAssessmentBytes(Buffer.from(content), {
        ...productRef,
        producer: "agent:carren",
      })
    ).toThrow(/wrong semantic identity/u);
    expect(() => validateCanonicalAssessmentBytes(Buffer.from(`${content} `), productRef)).toThrow(
      /stale or has the wrong semantic identity/u
    );
    expect(() =>
      sealAssessmentDraft({
        request: request(),
        draft: value,
        requestRef,
        analysisRef: { ...analysisRef, run_id: "replayed-other-run" },
        draftRef,
      })
    ).toThrow(/invalid, stale, or cross-run roles/u);
    expect(() =>
      sealAssessmentDraft({
        request: request(),
        draft: value,
        requestRef,
        analysisRef: { ...analysisRef, producer: "agent:vera" },
        draftRef,
      })
    ).toThrow(/invalid, stale, or cross-run roles/u);
    expect(assessment).toMatchObject({
      source_lineage: {
        request_artifact_id: requestRef.artifact_id,
        request_artifact_sha256: requestRef.content_digest,
        analysis_artifact_id: analysisRef.artifact_id,
        analysis_artifact_sha256: analysisRef.content_digest,
        draft_artifact_id: draftRef.artifact_id,
        draft_artifact_sha256: draftRef.content_digest,
      },
      external_actions_performed: false,
      filesystem_writes_performed: false,
      tests_executed: false,
      changes_started: false,
    });
  });
});
