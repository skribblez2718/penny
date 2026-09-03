import { describe, expect, it } from "vitest";

import {
  DiagnosisDraftValidationError,
  SEMANTIC_PRODUCT_VALIDATORS,
  canonicalJson,
  canonicalizeDiagnosisRequest,
  diagnosisDraftPromptContract,
  parsePersistedDiagnosisDraft,
  sealDiagnosisDraft,
  sha256,
  validateCanonicalDiagnosisBytes,
  validateDiagnosisDraft,
  validateDiagnosisRequest,
  type ArtifactRef,
  type DiagnosisDraftV1,
  type DiagnosisRequestV1,
} from "../src/index.js";

const RUN_ID = "run-diagnose-contract";

function request(mode: "proposal_only" | "none" = "proposal_only"): DiagnosisRequestV1 {
  return {
    schema_version: 1,
    problem_statement: "Why does the service return stale values after a configuration update?",
    symptoms: [{ statement: "Updated values are not visible for several minutes." }],
    supplied_observations: [
      { statement: "A repeated read returns the pre-update value.", source_label: "operator note" },
      { statement: "Direct origin reads contain the new value." },
    ],
    environment_facts: [{ statement: "The read path includes an expiring cache." }],
    hard_constraints: [{ statement: "Analyze supplied evidence only; execute no tests." }],
    non_goals: [{ statement: "Do not propose remediation." }],
    known_uncertainties: [{ statement: "The cache invalidation event was not observed." }],
    permitted_test_boundary: { mode },
  };
}

function coverage() {
  return {
    problem_statement_covered: true as const,
    symptom_indexes: [0],
    observation_indexes: [0, 1],
    environment_fact_indexes: [0],
    hard_constraint_indexes: [0],
    non_goal_indexes: [0],
    known_uncertainty_indexes: [0],
    permitted_test_boundary_covered: true as const,
  };
}

function hypothesis(
  hypothesisId: string,
  rank: number,
  status: "supported" | "plausible" | "ruled_out"
) {
  return {
    hypothesis_id: hypothesisId,
    rank,
    statement: `${hypothesisId} explains the stale read.`,
    status,
    symptom_indexes: [0],
    supporting_observation_indexes: status === "supported" ? [0, 1] : [],
    contradicting_observation_indexes: status === "ruled_out" ? [1] : [],
    supporting_environment_fact_indexes: status === "supported" ? [0] : [],
    contradicting_environment_fact_indexes: [],
    hard_constraint_indexes: [0],
    reasoning: `The supplied indexes make ${hypothesisId} ${status}.`,
  };
}

function supportedDraft(): DiagnosisDraftV1 {
  return {
    schema_version: 1,
    disposition: "supported",
    applicability_reason: "The symptom asks for a causal explanation.",
    hypothesis_set_complete: true,
    hypotheses: [hypothesis("hyp_cache", 1, "supported"), hypothesis("hyp_origin", 2, "ruled_out")],
    primary_supported_hypothesis_id: "hyp_cache",
    reasoning: "The cache path explains stale reads while direct origin reads are current.",
    uncertainty: [],
    proposed_discriminating_checks: [],
    request_coverage: coverage(),
    confidence: "PROBABLE",
    remediation_started: false,
    tests_executed: false,
  };
}

function inconclusiveDraft(mode: "proposal_only" | "none"): DiagnosisDraftV1 {
  return {
    ...supportedDraft(),
    disposition: "inconclusive",
    hypotheses: [
      hypothesis("hyp_cache", 1, "plausible"),
      hypothesis("hyp_replica", 2, "plausible"),
    ],
    primary_supported_hypothesis_id: null,
    reasoning: "Supplied evidence does not discriminate cache staleness from replica lag.",
    uncertainty: ["The timing of invalidation versus replication is unknown."],
    proposed_discriminating_checks:
      mode === "proposal_only"
        ? [
            {
              check_id: "check_compare_paths",
              proposal: "Propose comparing timestamped cache and replica reads.",
              discriminates_hypothesis_ids: ["hyp_cache", "hyp_replica"],
              expected_observation: "Only one path remains stale during the same interval.",
              boundary_note: "Proposal only; this diagnosis did not execute the comparison.",
              executed: false,
            },
          ]
        : [],
    confidence: "UNCERTAIN",
  };
}

function persisted(draft: DiagnosisDraftV1): string {
  return `DIAGNOSIS_CORE:${canonicalJson(draft)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`;
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

describe("closed DiagnosisRequestV1", () => {
  it("canonicalizes exact start constraints and rejects unknown or action fields", () => {
    const value = request();
    const { problem_statement: goal, ...constraints } = value;
    expect(canonicalizeDiagnosisRequest({ goal, constraints })).toEqual(value);
    expect(() => validateDiagnosisRequest({ ...value, execute_tests: true })).toThrow();
    expect(() =>
      canonicalizeDiagnosisRequest({ goal, constraints: { ...constraints, remediation: [] } })
    ).toThrow();
    expect(() => validateDiagnosisRequest({ ...value, symptoms: [] })).toThrow();
  });
});

describe("DiagnosisDraftV1 semantics and framing", () => {
  it("accepts supported and both proposal boundaries for honest inconclusive products", () => {
    expect(validateDiagnosisDraft(supportedDraft(), { request: request() }).disposition).toBe(
      "supported"
    );
    expect(
      validateDiagnosisDraft(inconclusiveDraft("proposal_only"), {
        request: request("proposal_only"),
      }).disposition
    ).toBe("inconclusive");
    expect(
      validateDiagnosisDraft(inconclusiveDraft("none"), { request: request("none") }).disposition
    ).toBe("inconclusive");
  });

  it("rejects invented indexes, weak inconclusive sets, forbidden checks, and action claims", () => {
    const invalidIndex = supportedDraft();
    const firstSupportedHypothesis = invalidIndex.hypotheses[0];
    if (!firstSupportedHypothesis) throw new Error("supported fixture requires one hypothesis");
    firstSupportedHypothesis.supporting_observation_indexes = [2];
    expect(() => validateDiagnosisDraft(invalidIndex, { request: request() })).toThrow(
      DiagnosisDraftValidationError
    );

    const inconclusive = inconclusiveDraft("proposal_only");
    const firstPlausibleHypothesis = inconclusive.hypotheses[0];
    if (!firstPlausibleHypothesis) throw new Error("inconclusive fixture requires one hypothesis");
    const onePlausible = { ...inconclusive, hypotheses: [firstPlausibleHypothesis] };
    expect(() => validateDiagnosisDraft(onePlausible, { request: request() })).toThrow(
      /at least two plausible/u
    );

    expect(() =>
      validateDiagnosisDraft(inconclusiveDraft("proposal_only"), { request: request("none") })
    ).toThrow(/forbids proposed/u);
    expect(() =>
      validateDiagnosisDraft({ ...supportedDraft(), tests_executed: true }, { request: request() })
    ).toThrow(DiagnosisDraftValidationError);
  });

  it("parses only the strict two-line transport with matching confidence", () => {
    const draft = supportedDraft();
    expect(
      parsePersistedDiagnosisDraft(Buffer.from(persisted(draft)), { request: request() })
    ).toEqual({ draft, summary: { confidence: "PROBABLE", complete: true } });
    expect(() =>
      parsePersistedDiagnosisDraft(Buffer.from(`Prose\n${persisted(draft)}`), {
        request: request(),
      })
    ).toThrow(/exactly one unwrapped/u);
    expect(() =>
      parsePersistedDiagnosisDraft(
        Buffer.from(
          `DIAGNOSIS_CORE:${canonicalJson(draft)}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`
        ),
        { request: request() }
      )
    ).toThrow(/confidence/u);
    expect(diagnosisDraftPromptContract()).toContain("tests_executed");
  });
});

describe("provider-free diagnosis conformance", () => {
  it("accepts meaning-preserving wording variation without exact-string grading", () => {
    const original = supportedDraft();
    const varied: DiagnosisDraftV1 = {
      ...original,
      applicability_reason: "The supplied symptoms call for causal analysis.",
      reasoning: "Current origin reads and stale cached reads support cache staleness.",
      hypotheses: original.hypotheses.map((item) => ({
        ...item,
        statement: `${item.hypothesis_id} accounts for the observed stale value.`,
        reasoning: `The supplied observations leave ${item.hypothesis_id} ${item.status}.`,
      })),
    };
    const validatedOriginal = validateDiagnosisDraft(original, { request: request() });
    const validatedVaried = validateDiagnosisDraft(varied, { request: request() });
    expect(canonicalJson(validatedVaried)).not.toBe(canonicalJson(validatedOriginal));
    expect({
      disposition: validatedVaried.disposition,
      primary: validatedVaried.primary_supported_hypothesis_id,
      hypotheses: validatedVaried.hypotheses.map((item) => [
        item.hypothesis_id,
        item.rank,
        item.status,
      ]),
      coverage: validatedVaried.request_coverage,
    }).toEqual({
      disposition: validatedOriginal.disposition,
      primary: validatedOriginal.primary_supported_hypothesis_id,
      hypotheses: validatedOriginal.hypotheses.map((item) => [
        item.hypothesis_id,
        item.rank,
        item.status,
      ]),
      coverage: validatedOriginal.request_coverage,
    });
  });

  it("rejects a stale draft after a material request mutation and admits the matching draft", () => {
    const stale = inconclusiveDraft("proposal_only");
    expect(() => validateDiagnosisDraft(stale, { request: request("none") })).toThrow(
      /forbids proposed/u
    );
    const matching = inconclusiveDraft("none");
    expect(validateDiagnosisDraft(matching, { request: request("none") })).toEqual(matching);
  });
});

describe("canonical DiagnosisV1 sealing", () => {
  it("binds exact request, Annie, Ida, and Demetri lineage and validates canonical bytes", () => {
    const draft = supportedDraft();
    const requestRef = ref({
      id: "1",
      phase: "intake",
      kind: "diagnosis-request",
      producer: "host:request-admission",
      content: canonicalJson(request()),
      schema: { schema_id: "penny.diagnosis-request.v1", schema_version: 1 },
    });
    const decompositionRef = ref({
      id: "2",
      phase: "decomposing_causes",
      kind: "agent-output",
      producer: "agent:annie",
      content: "decomposition",
    });
    const hypothesesRef = ref({
      id: "3",
      phase: "generating_hypotheses",
      kind: "agent-output",
      producer: "agent:ida",
      content: "hypotheses",
    });
    const draftRef = ref({
      id: "4",
      phase: "adjudicating_diagnosis",
      kind: "diagnosis-draft",
      producer: "agent:demetri",
      content: persisted(draft),
      schema: { schema_id: "penny.diagnosis-draft.v1", schema_version: 1 },
    });
    const diagnosis = sealDiagnosisDraft({
      request: request(),
      draft,
      requestRef,
      causalDecompositionRef: decompositionRef,
      competingHypothesesRef: hypothesesRef,
      draftRef,
    });
    const content = canonicalJson(diagnosis);
    const productRef = ref({
      id: "5",
      phase: "sealing_diagnosis",
      kind: "semantic-core",
      producer: "host:diagnosis-sealer",
      content,
      schema: { schema_id: "penny.diagnosis.v1", schema_version: 1 },
    });
    expect(validateCanonicalDiagnosisBytes(Buffer.from(content), productRef)).toEqual(diagnosis);
    expect(SEMANTIC_PRODUCT_VALIDATORS.get("penny.diagnosis.v1")).toMatchObject({
      schema_version: 1,
      artifact_kind: "semantic-core",
    });
    expect(() =>
      validateCanonicalDiagnosisBytes(Buffer.from(content), {
        ...productRef,
        producer: "agent:demetri",
      })
    ).toThrow(/wrong semantic identity/u);
    expect(() =>
      sealDiagnosisDraft({
        request: request(),
        draft,
        requestRef,
        causalDecompositionRef: decompositionRef,
        competingHypothesesRef: { ...hypothesesRef, producer: "agent:annie" },
        draftRef,
      })
    ).toThrow(/invalid or ambiguous roles/u);
    expect(diagnosis).toMatchObject({
      source_lineage: {
        request_artifact_id: requestRef.artifact_id,
        request_artifact_sha256: requestRef.content_digest,
        causal_decomposition_artifact_id: decompositionRef.artifact_id,
        causal_decomposition_sha256: decompositionRef.content_digest,
        competing_hypotheses_artifact_id: hypothesesRef.artifact_id,
        competing_hypotheses_sha256: hypothesesRef.content_digest,
        draft_artifact_id: draftRef.artifact_id,
        draft_artifact_sha256: draftRef.content_digest,
      },
      tests_executed: false,
      remediation_started: false,
    });
  });
});
