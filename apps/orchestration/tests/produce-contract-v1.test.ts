import { describe, expect, it } from "vitest";

import {
  ProduceDraftValidationError,
  SEMANTIC_PRODUCT_VALIDATORS,
  canonicalJson,
  canonicalizeProduceRequest,
  mediaTypeForArtifactKind,
  parsePersistedArtifactApproach,
  parsePersistedArtifactApproachDecision,
  parsePersistedProducedArtifactDraft,
  readProducedArtifactProduct,
  sealProducedArtifact,
  sha256,
  validateArtifactApproach,
  validateArtifactApproachDecision,
  validateCanonicalProducedArtifactBytes,
  validateProduceRequest,
  validateProducedArtifact,
  validateProducedArtifactDraft,
  type ArtifactApproachDecisionV1,
  type ArtifactApproachV1,
  type ArtifactRef,
  type ProduceArtifactKind,
  type ProduceRequestV1,
  type ProducedArtifactDraftV1,
} from "../dist/index.js";

const RUN_ID = "run-produce-contract";

function request(
  kind: ProduceArtifactKind = "text",
  outputName = "artifact.txt"
): ProduceRequestV1 {
  return {
    schema_version: 1,
    purpose_statement: "Create one concise artifact from the supplied facts.",
    output_name: outputName,
    artifact_kind: kind,
    specification: [{ statement: "State the supplied greeting exactly once." }],
    source_material: [{ statement: "Hello.", source_label: "caller statement" }],
    acceptance_criteria: [{ statement: "The artifact contains the exact greeting." }],
    hard_constraints: [{ statement: "Do not add unsupported facts." }],
    non_goals: [{ statement: "Do not write the artifact to a filesystem." }],
    known_uncertainties: [{ statement: "No preferred prose style was supplied." }],
  };
}

function coverage() {
  return {
    purpose_statement_covered: true as const,
    specification_indexes: [0],
    source_material_indexes: [0],
    acceptance_criterion_indexes: [0],
    hard_constraint_indexes: [0],
    non_goal_indexes: [0],
    known_uncertainty_indexes: [0],
  };
}

function draft(
  kind: ProduceArtifactKind = "text",
  outputName = "artifact.txt",
  content = "Hello."
): ProducedArtifactDraftV1 {
  return {
    schema_version: 1,
    disposition: "produced",
    output_name: outputName,
    artifact_kind: kind,
    media_type: mediaTypeForArtifactKind(kind),
    content,
    rationale: "The direct artifact satisfies the exact brief.",
    assumptions: [],
    uncertainties: ["No prose style preference was supplied."],
    request_coverage: coverage(),
    confidence: "PROBABLE",
    external_actions_performed: false,
    filesystem_writes_performed: false,
    tests_executed: false,
  };
}

function approach(): ArtifactApproachV1 {
  return {
    schema_version: 1,
    approaches: [
      {
        approach_id: "direct",
        title: "Direct",
        description: "Use the supplied statement directly.",
        tradeoffs: ["Concise but intentionally narrow."],
      },
      {
        approach_id: "sectioned",
        title: "Sectioned",
        description: "Place the statement under a heading.",
        tradeoffs: ["More structure but unnecessary length."],
      },
    ],
    confidence: "PROBABLE",
  };
}

function persistedApproach(value = approach()): string {
  return `ARTIFACT_APPROACH:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
}

function decision(): ArtifactApproachDecisionV1 {
  return {
    schema_version: 1,
    disposition: "selected",
    approach_assessments: [
      {
        approach_id: "direct",
        feasibility: "feasible",
        comparison: "Satisfies the concise brief directly.",
      },
      {
        approach_id: "sectioned",
        feasibility: "feasible",
        comparison: "Adds structure that the brief does not require.",
      },
    ],
    selected_approach_id: "direct",
    rationale: "The direct approach matches the supplied brevity requirement.",
    sensitivity: ["A sectioning requirement would favor sectioned."],
    blocking_questions: [],
    confidence: "PROBABLE",
  };
}

function persistedDecision(value = decision()): string {
  return `ARTIFACT_APPROACH_DECISION:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true,"disposition":"${value.disposition}"}`;
}

function persistedDraft(value: ProducedArtifactDraftV1): string {
  return `PRODUCED_ARTIFACT_DRAFT:${canonicalJson(value)}\nSUMMARY:{"confidence":"${value.confidence}","complete":true}`;
}

function ref(input: {
  readonly hex: string;
  readonly runId?: string;
  readonly phase: string;
  readonly kind: string;
  readonly producer: string;
  readonly content: string;
  readonly schema: { readonly schema_id: string; readonly schema_version: number };
}): ArtifactRef {
  const digest = sha256(input.content);
  return {
    schema_version: 2,
    artifact_id: `art_${input.hex.repeat(64)}`,
    run_id: input.runId ?? RUN_ID,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: `${input.kind}:fixture`,
    version: 1,
    producer: input.producer,
    media_type: input.kind === "semantic-core" ? "application/json" : "text/plain; charset=utf-8",
    content_schema: input.schema,
    byte_length: Buffer.byteLength(input.content),
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
  };
}

describe("closed ProduceRequestV1", () => {
  it("canonicalizes the exact brief and rejects unknown, missing, path, and caller-action fields", () => {
    const value = request();
    const { purpose_statement: goal, ...constraints } = value;
    expect(canonicalizeProduceRequest({ goal, constraints })).toEqual(value);
    expect(() => validateProduceRequest({ ...value, execute: true })).toThrow();
    expect(() => validateProduceRequest({ ...value, specification: [] })).toThrow();
    expect(() => validateProduceRequest({ ...value, acceptance_criteria: [] })).toThrow();
    expect(() => validateProduceRequest({ ...value, output_name: "../artifact.txt" })).toThrow(
      /non-path/u
    );
    expect(() =>
      canonicalizeProduceRequest({ goal, constraints: { ...constraints, artifact_kind: "html" } })
    ).toThrow();
  });
});

describe("ArtifactApproachV1, ArtifactApproachDecisionV1, and ProducedArtifactDraftV1", () => {
  it("accepts one to four bounded unranked options and requires a separate exact Demetri decision", () => {
    expect(validateArtifactApproach(approach()).approaches).toHaveLength(2);
    expect(parsePersistedArtifactApproach(Buffer.from(persistedApproach()))).toEqual({
      approach: approach(),
      summary: { confidence: "PROBABLE", complete: true },
    });
    expect(
      validateArtifactApproach({ ...approach(), approaches: [approach().approaches[0]] }).approaches
    ).toHaveLength(1);
    expect(() =>
      validateArtifactApproach({ ...approach(), recommended_approach_id: "direct" })
    ).toThrow(/additional properties/u);
    expect(validateArtifactApproachDecision(decision(), { approach: approach() })).toEqual(
      decision()
    );
    expect(
      parsePersistedArtifactApproachDecision(Buffer.from(persistedDecision()), {
        approach: approach(),
      })
    ).toEqual({
      decision: decision(),
      summary: { confidence: "PROBABLE", complete: true, disposition: "selected" },
    });
    expect(() =>
      validateArtifactApproachDecision(
        { ...decision(), selected_approach_id: "missing" },
        { approach: approach() }
      )
    ).toThrow(/feasible in-set/u);
    expect(() =>
      parsePersistedArtifactApproach(Buffer.from(`Prose\n${persistedApproach()}`))
    ).toThrow(/exactly one unwrapped/u);
  });

  it("permits an honest unresolved Demetri disposition and forbids a hidden selection", () => {
    const unresolved: ArtifactApproachDecisionV1 = {
      ...decision(),
      disposition: "unresolved",
      selected_approach_id: null,
      blocking_questions: ["Should brevity or explicit sectioning take priority?"],
      confidence: "UNCERTAIN",
    };
    expect(validateArtifactApproachDecision(unresolved, { approach: approach() })).toEqual(
      unresolved
    );
    expect(() =>
      validateArtifactApproachDecision(
        { ...unresolved, selected_approach_id: "direct" },
        { approach: approach() }
      )
    ).toThrow(/unresolved disposition/u);
  });

  it("accepts complete text and Markdown content without claiming syntax or execution checks", () => {
    for (const [kind, outputName, content] of [
      ["text", "artifact.txt", "Hello."],
      ["markdown", "artifact.md", "# Greeting\n\nHello."],
    ] as const) {
      const value = draft(kind, outputName, content);
      const parsed = parsePersistedProducedArtifactDraft(Buffer.from(persistedDraft(value)), {
        request: request(kind, outputName),
      });
      expect(parsed.draft).toEqual(value);
      expect(parsed.summary).toEqual({ confidence: "PROBABLE", complete: true });
      expect(parsed.draft).toMatchObject({
        external_actions_performed: false,
        filesystem_writes_performed: false,
        tests_executed: false,
      });
    }
  });

  it("requires produced JSON content to be parseable canonical JSON without delegating digest calculation", () => {
    const json = canonicalJson({ items: ["one"], title: "Example" });
    const value = draft("json", "artifact.json", json);
    expect(
      validateProducedArtifactDraft(value, { request: request("json", "artifact.json") })
    ).toEqual(value);
    expect(() =>
      validateProducedArtifactDraft(
        {
          ...value,
          content: '{"title":"Example","items":["one"]}',
        },
        { request: request("json", "artifact.json") }
      )
    ).toThrow(/canonical JSON/u);
    expect(() =>
      validateProducedArtifactDraft(
        { ...value, content: "{broken" },
        { request: request("json", "artifact.json") }
      )
    ).toThrow(/parse as JSON/u);
    expect(() =>
      validateProducedArtifactDraft(
        { ...value, content_sha256: "0".repeat(64) },
        { request: request("json", "artifact.json") }
      )
    ).toThrow(/SCHEMA_INVALID|additional properties/u);
  });

  it("accepts truthful empty not_applicable and rejects partial coverage or content", () => {
    const value: ProducedArtifactDraftV1 = {
      ...draft(),
      disposition: "not_applicable",
      content: "",
      rationale: "Required source material is absent, so no truthful artifact can be produced.",
      uncertainties: ["The required source material was not supplied."],
    };
    expect(validateProducedArtifactDraft(value, { request: request() })).toEqual(value);
    expect(() =>
      validateProducedArtifactDraft(
        { ...value, content: "partial" },
        {
          request: request(),
        }
      )
    ).toThrow(/requires empty content/u);
    expect(() =>
      validateProducedArtifactDraft(
        {
          ...draft(),
          request_coverage: { ...coverage(), acceptance_criterion_indexes: [] },
        },
        { request: request() }
      )
    ).toThrow(ProduceDraftValidationError);
  });
});

describe("provider-free production conformance", () => {
  it("accepts meaning-preserving rationale variation without exact-string grading", () => {
    const original = draft();
    const varied: ProducedArtifactDraftV1 = {
      ...original,
      rationale: "The artifact directly reproduces the one supplied fact.",
      uncertainties: ["The caller supplied no additional style direction."],
    };
    const validatedOriginal = validateProducedArtifactDraft(original, { request: request() });
    const validatedVaried = validateProducedArtifactDraft(varied, { request: request() });
    expect(canonicalJson(validatedVaried)).not.toBe(canonicalJson(validatedOriginal));
    expect({
      disposition: validatedVaried.disposition,
      outputName: validatedVaried.output_name,
      artifactKind: validatedVaried.artifact_kind,
      mediaType: validatedVaried.media_type,
      content: validatedVaried.content,
      coverage: validatedVaried.request_coverage,
    }).toEqual({
      disposition: validatedOriginal.disposition,
      outputName: validatedOriginal.output_name,
      artifactKind: validatedOriginal.artifact_kind,
      mediaType: validatedOriginal.media_type,
      content: validatedOriginal.content,
      coverage: validatedOriginal.request_coverage,
    });
  });

  it("rejects a stale draft after a material request mutation and admits the matching draft", () => {
    expect(() =>
      validateProducedArtifactDraft(draft(), { request: request("markdown", "artifact.md") })
    ).toThrow(ProduceDraftValidationError);
    const matching = draft("markdown", "artifact.md", "# Greeting\n\nHello.");
    expect(
      validateProducedArtifactDraft(matching, { request: request("markdown", "artifact.md") })
    ).toEqual(matching);
  });
});

describe("canonical ProducedArtifactV1 sealing", () => {
  it("binds exact request, Ida, Demetri, Skribble, and inline-source lineage", () => {
    const requestValue = request();
    const draftValue = draft();
    const requestContent = canonicalJson(requestValue);
    const approachContent = persistedApproach();
    const decisionContent = persistedDecision();
    const draftContent = persistedDraft(draftValue);
    const requestRef = ref({
      hex: "1",
      phase: "intake",
      kind: "produce-request",
      producer: "host:request-admission",
      content: requestContent,
      schema: { schema_id: "penny.produce-request.v1", schema_version: 1 },
    });
    const approachRef = ref({
      hex: "2",
      phase: "exploring_artifact_approaches",
      kind: "artifact-approach",
      producer: "agent:ida",
      content: approachContent,
      schema: { schema_id: "penny.artifact-approach.v1", schema_version: 1 },
    });
    const decisionRef = ref({
      hex: "3",
      phase: "selecting_artifact_approach",
      kind: "artifact-approach-decision",
      producer: "agent:demetri",
      content: decisionContent,
      schema: { schema_id: "penny.artifact-approach-decision.v1", schema_version: 1 },
    });
    const draftRef = ref({
      hex: "4",
      phase: "materializing_artifact",
      kind: "produced-artifact-draft",
      producer: "agent:skribble",
      content: draftContent,
      schema: { schema_id: "penny.produced-artifact-draft.v1", schema_version: 1 },
    });
    const product = sealProducedArtifact({
      request: requestValue,
      draft: draftValue,
      requestRef,
      approachRef,
      decisionRef,
      draftRef,
    });
    const content = canonicalJson(product);
    const productRef = ref({
      hex: "5",
      phase: "sealing_artifact",
      kind: "semantic-core",
      producer: "host:artifact-sealer",
      content,
      schema: { schema_id: "penny.produced-artifact.v1", schema_version: 1 },
    });
    expect(validateCanonicalProducedArtifactBytes(Buffer.from(content), productRef)).toEqual(
      product
    );
    expect(
      readProducedArtifactProduct(product, {
        runId: RUN_ID,
        phases: [
          "exploring_artifact_approaches",
          "selecting_artifact_approach",
          "materializing_artifact",
          "critiquing_artifact",
          "verifying_artifact",
        ],
      })
    ).toMatchObject({
      contract_version: 1,
      interpretation: "legacy_unverified_assertion",
      effect_evidence: { assurance: "unknown" },
    });
    expect(product).toMatchObject({
      schema_id: "penny.produced-artifact.v1",
      content_sha256: sha256(draftValue.content),
      source_lineage: {
        request_artifact_id: requestRef.artifact_id,
        approach_artifact_id: approachRef.artifact_id,
        decision_artifact_id: decisionRef.artifact_id,
        draft_artifact_id: draftRef.artifact_id,
        source_material: [
          {
            source_index: 0,
            statement_sha256: sha256("Hello."),
            source_label: "caller statement",
          },
        ],
      },
      external_actions_performed: false,
      filesystem_writes_performed: false,
      tests_executed: false,
    });
    expect(() => validateProducedArtifact({ ...product, content_sha256: "0".repeat(64) })).toThrow(
      /content digest drifted/u
    );
    expect(SEMANTIC_PRODUCT_VALIDATORS.get("penny.produced-artifact.v1")).toMatchObject({
      schema_version: 1,
      artifact_kind: "semantic-core",
    });
    expect(() =>
      sealProducedArtifact({
        request: requestValue,
        draft: draftValue,
        requestRef,
        approachRef: { ...approachRef, run_id: "wrong-run" },
        decisionRef,
        draftRef,
      })
    ).toThrow(/cross-run/u);
    expect(() =>
      validateCanonicalProducedArtifactBytes(Buffer.from(content), {
        ...productRef,
        producer: "agent:skribble",
      })
    ).toThrow(/wrong semantic identity/u);
  });
});
