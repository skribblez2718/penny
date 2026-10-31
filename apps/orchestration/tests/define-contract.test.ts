import { describe, expect, it } from "vitest";

import {
  SpecificationDraftValidationError,
  DefinitionProtectedContentUnrepresentableError,
  assertDefinitionProtectedContentRepresentable,
  validateProtectedDefinitionDraft,
  parseSpecificationDraftV2Shape,
  parseSpecificationDraftV3,
  persistedSpecificationDraftV3 as serializeSpecificationDraftV3,
  checkDefinitionSupportLocator,
  canonicalizeDefinitionFrameV2,
  validateDefinitionFrameV2,
  validateDefinitionClarificationChallenge,
  mapDefinitionGateResponse,
  stableDefinitionId,
  DEFINE_START_ADMISSION,
  SpecificationLineageV1Schema,
  assertSpecificationLineage,
  canonicalJson,
  canonicalizeDefinitionFrame,
  canonicalizeDefinitionRequest,
  definitionRequestConstraints,
  definitionRequestSha256,
  definitionRequestSourceItems,
  definitionSourceManifest,
  validateDefinitionSourceManifest,
  parseSpecificationDraft,
  sealSpecification,
  sha256,
  specificationDraftPromptContract,
  specificationLineagePromptContract,
  specificationProfile,
  validateCanonicalSpecificationBytes,
  validateDefinitionFrame,
  validateDefinitionRequest,
  validateSpecification,
  validateSpecificationDraft,
  type ArtifactRef,
  type SpecificationDraftV1,
} from "../dist/index.js";
import {
  DEFINE_DRAFT_ARTIFACT_ID,
  DEFINE_REQUEST_ARTIFACT_ID,
  genericDefinitionRequest,
  genericSpecificationCore,
  genericSpecificationFixture,
  fortySixSourceFixture,
  keyedSpecificationDraft,
  persistedSpecificationDraft,
} from "./fixtures/define-fixtures.js";

describe("DefinitionRequestV1, DefinitionFrameV1, and SpecificationV1", () => {
  it("refuses impossible protected text before a Define start can materialize artifacts", () => {
    const base = genericDefinitionRequest();
    const make = (out: string[], non: string[] = []) =>
      canonicalizeDefinitionRequest({
        goal: base.goal,
        constraints: { ...definitionRequestConstraints(base), out_of_scope: out, non_goals: non },
        exactInputArtifactIds: [],
      });
    expect(() =>
      assertDefinitionProtectedContentRepresentable(make(["é".repeat(1024)]))
    ).not.toThrow();
    for (const bytes of [2049, 4096]) {
      expect(() =>
        assertDefinitionProtectedContentRepresentable(make(["x".repeat(bytes)]))
      ).toThrow("DEFINITION_PROTECTED_CONTENT_UNREPRESENTABLE");
    }
    const tooLong = make(["é".repeat(1025)]);
    try {
      assertDefinitionProtectedContentRepresentable(tooLong);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(DefinitionProtectedContentUnrepresentableError);
      expect(error).toMatchObject({
        code: "DEFINITION_PROTECTED_CONTENT_UNREPRESENTABLE",
        request_sha256: definitionRequestSha256(tooLong),
        findings: [{ field_path: "out_of_scope[0]", measured: 2050, limit: 2048, unit: "bytes" }],
      });
    }
    const excluded = Array.from({ length: 32 }, (_, n) => `Excluded ${n}`);
    const firstExcluded = excluded[0];
    if (firstExcluded === undefined) throw new Error("excluded source missing");
    expect(() =>
      assertDefinitionProtectedContentRepresentable(make(excluded, [firstExcluded]))
    ).not.toThrow();
    const overflow = make(excluded, ["Distinct non-goal"]);
    const fullUnion = make(
      excluded,
      Array.from({ length: 32 }, (_, n) => `Non-goal ${n}`)
    );
    expect(() => assertDefinitionProtectedContentRepresentable(fullUnion)).toThrow(
      "DEFINITION_PROTECTED_CONTENT_UNREPRESENTABLE"
    );
    expect(() => assertDefinitionProtectedContentRepresentable(overflow)).toThrow(
      "DEFINITION_PROTECTED_CONTENT_UNREPRESENTABLE"
    );
    expect(() =>
      DEFINE_START_ADMISSION.prepare(
        {
          schema_version: 2,
          action: "start",
          identity: {
            schema_version: 2,
            run_id: "run-protected-fit",
            session_id: "run-protected-fit",
            playbook: "define",
            engine_owner: "typescript",
          },
          goal: overflow.goal,
          constraints: definitionRequestConstraints(overflow),
          project_root: process.cwd(),
          trust_profile: "hardened-untrusted",
        },
        {}
      )
    ).toThrow("DEFINITION_PROTECTED_CONTENT_UNREPRESENTABLE");
  });
  it("requires exact linked normative content, not merely a source-coverage assertion", () => {
    const fixture = genericSpecificationFixture();
    expect(() =>
      validateProtectedDefinitionDraft({ request: fixture.request, draft: fixture.draft })
    ).not.toThrow();
    const missingConstraint = { ...fixture.draft, constraints: [] };
    expect(() =>
      validateProtectedDefinitionDraft({ request: fixture.request, draft: missingConstraint })
    ).toThrow(/hard_constraints\[0\]/u);
    const rewordedNonGoal = {
      ...fixture.draft,
      non_goals: fixture.draft.non_goals.map((item) => ({
        ...item,
        statement: "A weakened paraphrase.",
      })),
    };
    expect(() =>
      validateProtectedDefinitionDraft({ request: fixture.request, draft: rewordedNonGoal })
    ).toThrow(/non_goals\[0\]/u);
    const sourceOnly = {
      ...fixture.draft,
      constraints: fixture.draft.constraints.map((item) => ({ ...item, source_item_indexes: [0] })),
    };
    expect(() =>
      validateProtectedDefinitionDraft({ request: fixture.request, draft: sourceOnly })
    ).toThrow(/hard_constraints\[0\]/u);
  });

  it("derives stable request and discovered question IDs without downgrading materiality", () => {
    const original = genericDefinitionRequest();
    const request = canonicalizeDefinitionRequest({
      goal: original.goal,
      constraints: {
        ...definitionRequestConstraints(original),
        known_uncertainties: [
          { question: "Who approves the transition?", owner: "caller", material: true },
          { question: "When should it happen?", owner: "caller", material: false },
        ],
      },
      exactInputArtifactIds: [],
    });
    const requestBytes = Buffer.from(canonicalJson(request));
    const requestDigest = sha256(requestBytes);
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${requestDigest}`,
      run_id: "run-questions",
      phase: "intake",
      branch_id: null,
      kind: "definition-request",
      operation_id: "definition-request",
      version: 1,
      producer: "host:request-admission",
      media_type: "application/json",
      content_schema: { schema_id: "penny.definition-request.v1", schema_version: 1 },
      byte_length: requestBytes.length,
      content_digest: requestDigest,
      store_ref: `artifact://sha256/${requestDigest}`,
    };
    const { content_schema: ignoredContentSchema, ...requestRefWithoutSchema } = ref;
    void ignoredContentSchema;
    const orientation: ArtifactRef = {
      ...requestRefWithoutSchema,
      artifact_id: `art_${"a".repeat(64)}`,
      phase: "framing_definition",
      kind: "agent-output",
      producer: "agent:piper",
      operation_id: "orientation",
      content_digest: "a".repeat(64),
      store_ref: `artifact://sha256/${"a".repeat(64)}`,
    };
    const input = {
      request,
      requestRef: ref,
      orientationRef: orientation,
      selectedProfileId: "generic" as const,
      profileSelectionBasis: "Selected by the caller.",
      route: "clarify" as const,
      routeReason: "Caller choice is unresolved.",
      discoveredQuestions: [
        { question: "Which records exist?", owner: "evidence" as const, material: true },
      ],
    };
    const frame = canonicalizeDefinitionFrameV2(input);
    const firstQuestion = frame.questions[0];
    const secondQuestion = frame.questions[1];
    const discoveredQuestion = input.discoveredQuestions[0];
    if (
      firstQuestion === undefined ||
      secondQuestion === undefined ||
      discoveredQuestion === undefined
    )
      throw new Error("question fixture missing");
    expect(frame.questions.map((q) => q.origin_ref)).toEqual([ref, ref, orientation]);
    expect(frame.questions[0]).toMatchObject({
      material: true,
      owner: "caller",
      source_item_index: definitionRequestSourceItems(request).find(
        (source) => source.kind === "uncertainty"
      )?.ordinal,
    });
    expect(canonicalizeDefinitionFrameV2(input).questions.map((q) => q.question_id)).toEqual(
      frame.questions.map((q) => q.question_id)
    );
    const changed = canonicalizeDefinitionFrameV2({
      ...input,
      discoveredQuestions: [
        { ...discoveredQuestion, question: "Which records have been approved?" },
      ],
    });
    expect(changed.questions[2]?.question_id).not.toBe(frame.questions[2]?.question_id);
    expect(() =>
      validateDefinitionFrameV2(
        { ...frame, questions: [{ ...frame.questions[0], material: false }, frame.questions[1]] },
        request,
        ref,
        orientation
      )
    ).toThrow(/ID or request binding|question identity/u);
    const frameBytes = Buffer.from(canonicalJson(frame));
    const frameDigest = sha256(frameBytes);
    const frameRef: ArtifactRef = {
      ...requestRefWithoutSchema,
      artifact_id: `art_${frameDigest}`,
      phase: "definition_readiness_gate",
      kind: "definition-frame",
      operation_id: "frame",
      producer: "host:definition-framer",
      content_schema: { schema_id: "penny.definition-frame.v2", schema_version: 2 },
      byte_length: frameBytes.length,
      content_digest: frameDigest,
      store_ref: `artifact://sha256/${frameDigest}`,
    };
    const manifestRef: ArtifactRef = { ...frameRef, kind: "definition-source-manifest" };
    const body = {
      schema_id: "penny.definition-clarification-challenge.v1" as const,
      schema_version: 1 as const,
      request_ref: ref,
      manifest_ref: manifestRef,
      frame_ref: frameRef,
      gate_id: "gate-1",
      gate_visit: 1,
      question_ids: [firstQuestion.question_id],
    };
    const challenge = validateDefinitionClarificationChallenge(
      { ...body, challenge_id: stableDefinitionId("definition-challenge", body) },
      frame
    );
    const challengeRef: ArtifactRef = { ...frameRef, kind: "definition-clarification-challenge" };
    expect(
      mapDefinitionGateResponse({
        challenge,
        challengeRef,
        ownerResponseId: "response-1",
        freeText: "A named transition owner.",
      }).answers
    ).toMatchObject([{ disposition: "answered", answer_text: "A named transition owner." }]);
    const partialBody = {
      ...body,
      question_ids: [firstQuestion.question_id, secondQuestion.question_id],
    };
    const partial = validateDefinitionClarificationChallenge(
      { ...partialBody, challenge_id: stableDefinitionId("definition-challenge", partialBody) },
      frame
    );
    expect(
      mapDefinitionGateResponse({
        challenge: partial,
        challengeRef,
        ownerResponseId: "response-2",
        freeText: "A group answer.",
      }).answers
    ).toMatchObject([
      { disposition: "not_answered", answer_text: null },
      { disposition: "not_answered", answer_text: null },
    ]);
    expect(
      mapDefinitionGateResponse({
        challenge,
        challengeRef,
        ownerResponseId: "response-3",
        mappedAnswers: { [firstQuestion.question_id]: null },
      }).answers
    ).toMatchObject([{ disposition: "declined", answer_text: null }]);
  });

  it("checks locator existence and UTF-8 boundaries against exact captured bytes", () => {
    const json = Buffer.from('{"a/b":["é"]}', "utf8");
    expect(() =>
      checkDefinitionSupportLocator({ kind: "json_pointer", pointer: "/a~1b/0" }, json)
    ).not.toThrow();
    expect(() =>
      checkDefinitionSupportLocator({ kind: "json_pointer", pointer: "/a~1b/1" }, json)
    ).toThrow(/does not exist/u);
    expect(() =>
      checkDefinitionSupportLocator({ kind: "json_pointer", pointer: "/a~2b" }, json)
    ).toThrow(/malformed/u);
    const utf8 = Buffer.from("é", "utf8");
    expect(() =>
      checkDefinitionSupportLocator({ kind: "utf8_byte_range", start: 0, end_exclusive: 2 }, utf8)
    ).not.toThrow();
    expect(() =>
      checkDefinitionSupportLocator({ kind: "utf8_byte_range", start: 0, end_exclusive: 1 }, utf8)
    ).toThrow();
    expect(() =>
      checkDefinitionSupportLocator({ kind: "utf8_byte_range", start: 0, end_exclusive: 3 }, utf8)
    ).toThrow(/outside/u);
  });

  it("parses V2 support targets without silently inheriting V1 reverse links", () => {
    const { draft } = genericSpecificationFixture();
    const { specification_report, ...core } = draft;
    const value = {
      schema_version: 2,
      specification_report,
      specification: core,
      support_claims: [
        {
          target: { kind: "request_uncertainty", source_item_index: 2 },
          status: "pending",
          claim: "The answer is still missing.",
          rationale: "Requires the caller's decision.",
          support: [],
        },
      ],
    };
    expect(parseSpecificationDraftV2Shape(value)).toMatchObject(value);
    expect(() =>
      parseSpecificationDraftV2Shape({
        ...value,
        support_claims: [...value.support_claims, ...value.support_claims],
      })
    ).toThrow(/duplicate support claim/u);
    expect(() =>
      parseSpecificationDraftV2Shape({
        ...value,
        specification: {
          ...core,
          source_coverage: core.source_coverage.map((row) => ({
            ...row,
            product_item_refs: [{ kind: "constraint", index: 0 }],
          })),
        },
      })
    ).toThrow(/additional properties/u);
    expect(() =>
      parseSpecificationDraftV2Shape({
        ...value,
        support_claims: [
          {
            ...value.support_claims[0],
            support: [
              {
                support_slot: 0,
                locator: {
                  kind: "utf8_byte_range",
                  start: 0,
                  end_exclusive: 16_385,
                },
              },
            ],
          },
        ],
      })
    ).toThrow(/excerpt bound/u);
  });

  it("projects every exact profile category and host-derived source traceability rule", () => {
    const contract = specificationDraftPromptContract();
    expect(contract).toContain(canonicalJson(specificationProfile("software")));
    expect(contract).toContain("every required category must appear");
    expect(contract).toContain("without removing another required category");
    expect(contract).toContain("sole model-authored source-to-product relation");
    expect(contract).toContain("host derives canonical source_coverage.product_item_ids");
    expect(contract).toContain("supplied values are ignored");
  });

  it("projects the real closed lineage schema without inventing a product frame field", () => {
    const text = specificationLineagePromptContract();
    const contract: unknown = JSON.parse(text);
    expect(contract).toMatchObject({ source_lineage_schema: SpecificationLineageV1Schema });
    expect(text).toContain("artifact metadata upstream_refs");
    expect(text).toContain("after both reviews");
    const fixture = genericSpecificationFixture();
    expect(Object.keys(fixture.specification.source_lineage).sort()).toEqual(
      Object.keys(SpecificationLineageV1Schema.properties).sort()
    );
    expect(() =>
      validateSpecification({
        ...fixture.specification,
        source_lineage: {
          ...fixture.specification.source_lineage,
          frame_id: fixture.frame.frame_id,
        },
      })
    ).toThrow(/must not have additional properties/u);
    expect(() =>
      validateSpecificationDraft(
        { ...fixture.draft, source_lineage: fixture.specification.source_lineage },
        { request: fixture.request, frame: fixture.frame }
      )
    ).toThrow(SpecificationDraftValidationError);
  });

  it("keeps real frame and draft lineage mismatches fatal despite the separate frame carrier", () => {
    const fixture = genericSpecificationFixture();
    const input = {
      specification: fixture.specification,
      request: fixture.request,
      frame: fixture.frame,
      requestArtifactId: DEFINE_REQUEST_ARTIFACT_ID,
      draftArtifactId: DEFINE_DRAFT_ARTIFACT_ID,
      draft: fixture.draft,
      draftBytes: fixture.draftBytes,
      exactInputArtifactIds: [],
    };
    expect(assertSpecificationLineage(input)).toEqual(fixture.specification);
    expect(() =>
      assertSpecificationLineage({ ...input, draftArtifactId: `art_${"f".repeat(64)}` })
    ).toThrow(/host-sealed lineage diverged/u);
    const otherRequest = canonicalizeDefinitionRequest({
      goal: "Define a different transition.",
      constraints: definitionRequestConstraints(fixture.request),
      exactInputArtifactIds: [],
    });
    const staleFrame = canonicalizeDefinitionFrame({
      request: otherRequest,
      selectedProfileId: "generic",
      profileSelectionBasis: "A different valid frame for another request.",
      route: "author",
      routeReason: "The other request is ready.",
    });
    expect(() => assertSpecificationLineage({ ...input, frame: staleFrame })).toThrow(
      /request binding is stale/u
    );
  });

  it("seals one planning-ready cross-domain specification with exact source coverage", () => {
    const value = genericSpecificationFixture();
    expect(validateDefinitionRequest(value.request)).toEqual(value.request);
    expect(validateDefinitionFrame(value.frame)).toEqual(value.frame);
    expect(definitionRequestSourceItems(value.request)).toHaveLength(6);
    expect(
      parseSpecificationDraft(value.draftBytes, {
        request: value.request,
        frame: value.frame,
      }).draft
    ).toEqual(value.draft);
    const specification = validateSpecification(value.specification);
    expect(specification.profile.profile_id).toBe("generic");
    expect(specification.planning_handoff.planning_ready).toBe(true);
    expect(specification.planning_started).toBe(false);
    expect(specification.taskification_started).toBe(false);
    expect(specification.execution_started).toBe(false);
    expect(specification.source_coverage).toHaveLength(specification.source_items.length);
    expect(specification.requirements.every((entry) => entry.item_id.length > 0)).toBe(true);
    expect(specification.acceptance_criteria.every((entry) => entry.item_id.length > 0)).toBe(true);
  });

  it("derives reciprocal source coverage from the authoritative item-side links", () => {
    const value = genericSpecificationFixture();
    const compatibilityDraft: SpecificationDraftV1 = {
      ...value.draft,
      source_coverage: value.draft.source_coverage.map((entry) => ({
        ...entry,
        // Earlier drafts emitted this redundant reverse table. Its values are accepted only
        // for recovery compatibility and cannot override the item-side source links.
        product_item_refs: [{ kind: "non_goal", index: 0 }],
      })),
    };
    expect(
      validateSpecificationDraft(compatibilityDraft, {
        request: value.request,
        frame: value.frame,
      })
    ).toEqual(compatibilityDraft);
    const draftBytes = persistedSpecificationDraft(compatibilityDraft);
    const specification = sealSpecification({
      request: value.request,
      frame: value.frame,
      draft: compatibilityDraft,
      draftBytes,
      requestSha256: definitionRequestSha256(value.request),
      sourceRequestArtifactId: DEFINE_REQUEST_ARTIFACT_ID,
      sourceDraftArtifactId: DEFINE_DRAFT_ARTIFACT_ID,
      exactInputArtifactIds: [],
    });
    const goalSource = definitionRequestSourceItems(value.request)[0];
    if (goalSource === undefined) throw new Error("goal source fixture is absent");
    const goalCoverage = specification.source_coverage.find(
      (entry) => entry.source_item_id === goalSource.source_item_id
    );
    expect(goalCoverage?.product_item_ids).toEqual(
      [
        specification.objectives.find((entry) =>
          entry.source_item_ids.includes(goalSource.source_item_id)
        )?.item_id,
        specification.requirements.find((entry) =>
          entry.source_item_ids.includes(goalSource.source_item_id)
        )?.item_id,
        specification.acceptance_criteria.find((entry) =>
          entry.source_item_ids.includes(goalSource.source_item_id)
        )?.item_id,
      ].sort()
    );
    expect(goalCoverage?.product_item_ids).not.toContain(specification.non_goals[0]?.item_id);
    const unrelatedItemId = specification.non_goals[0]?.item_id;
    if (unrelatedItemId === undefined) throw new Error("unrelated item fixture is absent");
    const nonReciprocalSpecification = {
      ...specification,
      source_coverage: specification.source_coverage.map((entry) =>
        entry.source_item_id === goalSource.source_item_id
          ? { ...entry, product_item_ids: [unrelatedItemId] }
          : entry
      ),
    };
    expect(() => validateSpecification(nonReciprocalSpecification)).toThrow(
      /is not reciprocal with semantic item source IDs/u
    );
    expect(() =>
      validateCanonicalSpecificationBytes(
        Buffer.from(canonicalJson(nonReciprocalSpecification), "utf8")
      )
    ).toThrow(/is not reciprocal with semantic item source IDs/u);

    const excludedLinkedSource: SpecificationDraftV1 = {
      ...value.draft,
      source_coverage: value.draft.source_coverage.map((entry) =>
        entry.source_item_index === 0 ? { ...entry, disposition: "excluded" as const } : entry
      ),
    };
    expect(() =>
      validateSpecificationDraft(excludedLinkedSource, {
        request: value.request,
        frame: value.frame,
      })
    ).toThrow(/excluded source coverage\[0\] cannot be linked from product items/u);

    const incorporatedWithoutItemLink: SpecificationDraftV1 = {
      ...value.draft,
      non_goals: [],
    };
    expect(() =>
      validateSpecificationDraft(incorporatedWithoutItemLink, {
        request: value.request,
        frame: value.frame,
      })
    ).toThrow(/incorporated source coverage\[5\] requires at least one item-side source linkage/u);
  });

  it("rejects requests that cannot fit the bounded source index space before projection", () => {
    const baseRequest = genericDefinitionRequest();
    const baseConstraints = definitionRequestConstraints(baseRequest);
    const boundaryConstraints = {
      ...baseConstraints,
      desired_outcomes: Array.from(
        { length: 24 },
        (_, index) => `Boundary desired outcome ${index + 1}.`
      ),
      audiences: Array.from({ length: 16 }, (_, index) => `Boundary audience ${index + 1}.`),
      in_scope: Array.from({ length: 32 }, (_, index) => `Boundary in-scope item ${index + 1}.`),
      out_of_scope: Array.from(
        { length: 32 },
        (_, index) => `Boundary out-of-scope item ${index + 1}.`
      ),
      hard_constraints: Array.from(
        { length: 23 },
        (_, index) => `Boundary hard constraint ${index + 1}.`
      ),
      non_goals: [],
      known_assumptions: [],
      known_uncertainties: [],
      prior_decisions: [],
      standard_hints: [],
    };
    const boundary = canonicalizeDefinitionRequest({
      goal: baseRequest.goal,
      constraints: boundaryConstraints,
      exactInputArtifactIds: [],
    });
    expect(definitionRequestSourceItems(boundary)).toHaveLength(128);
    expect(() =>
      canonicalizeDefinitionRequest({
        goal: baseRequest.goal,
        constraints: {
          ...boundaryConstraints,
          hard_constraints: Array.from(
            { length: 24 },
            (_, index) => `Overflow hard constraint ${index + 1}.`
          ),
        },
        exactInputArtifactIds: [],
      })
    ).toThrow(/may derive at most 128 source items/u);
  });

  it("validates a large source map and valid revision without a model-authored reciprocal table", () => {
    const baseRequest = genericDefinitionRequest();
    const request = canonicalizeDefinitionRequest({
      goal: baseRequest.goal,
      constraints: {
        ...definitionRequestConstraints(baseRequest),
        hard_constraints: Array.from(
          { length: 39 },
          (_, index) => `Preserve large source constraint ${index + 1}.`
        ),
      },
      exactInputArtifactIds: [],
    });
    const frame = canonicalizeDefinitionFrame({
      request,
      selectedProfileId: "generic",
      profileSelectionBasis: "The large fixture remains cross-domain.",
      route: "author",
      routeReason: "The fixture has complete caller-owned intent.",
    });
    const sources = definitionRequestSourceItems(request);
    expect(sources).toHaveLength(44);
    const base = genericSpecificationCore(frame);
    const draft: SpecificationDraftV1 = {
      ...base,
      specification_report:
        "This large specification fixture exercises host-projected reciprocal traceability.",
      constraints: sources.map((source) => ({
        statement: `Preserve source ordinal ${source.ordinal}.`,
        source_item_indexes: [source.ordinal],
      })),
      non_goals: [
        {
          statement: "Do not redesign unrelated services.",
          source_item_indexes: [43],
        },
      ],
      source_coverage: sources.map((source) => ({
        source_item_index: source.ordinal,
        disposition: "incorporated" as const,
        // Reproduces the old repair failure: complete rows but no maintained reverse edges.
        product_item_refs: [],
        rationale: `Source ordinal ${source.ordinal} is represented by an item-side source link.`,
      })),
    };
    expect(validateSpecificationDraft(draft, { request, frame })).toEqual(draft);
    const bytes = persistedSpecificationDraft(draft);
    const sealed = sealSpecification({
      request,
      frame,
      draft,
      draftBytes: bytes,
      requestSha256: definitionRequestSha256(request),
      sourceRequestArtifactId: DEFINE_REQUEST_ARTIFACT_ID,
      sourceDraftArtifactId: DEFINE_DRAFT_ARTIFACT_ID,
      exactInputArtifactIds: [],
    });
    expect(sealed.source_coverage).toHaveLength(44);
    expect(sealed.source_coverage.every((entry) => entry.product_item_ids.length > 0)).toBe(true);

    const priorArtifactId = `art_${"a".repeat(64)}`;
    const revisionRequest = canonicalizeDefinitionRequest({
      goal: request.goal,
      constraints: {
        ...definitionRequestConstraints(request),
        mode: "revise",
      },
      exactInputArtifactIds: [priorArtifactId],
    });
    const revisionFrame = canonicalizeDefinitionFrame({
      request: revisionRequest,
      selectedProfileId: "generic",
      profileSelectionBasis: "The revision retains the large generic profile.",
      route: "author",
      routeReason: "The exact prior product and revision intent are supplied.",
    });
    const revisionSources = definitionRequestSourceItems(revisionRequest);
    expect(revisionSources).toHaveLength(45);
    const revisionDraft: SpecificationDraftV1 = {
      ...draft,
      specification_report:
        "This standalone revision preserves every prior semantic item and traces the exact prior input.",
      objectives: draft.objectives.map((entry, index) =>
        index === 0 ? { ...entry, source_item_indexes: [...entry.source_item_indexes, 44] } : entry
      ),
      source_coverage: [
        ...draft.source_coverage,
        {
          source_item_index: 44,
          disposition: "incorporated" as const,
          product_item_refs: [],
          rationale: "The exact prior product anchors the standalone replacement.",
        },
      ],
      supersession_intents: [],
    };
    expect(
      validateSpecificationDraft(revisionDraft, {
        request: revisionRequest,
        frame: revisionFrame,
        priorSpecification: sealed,
      })
    ).toEqual(revisionDraft);
    const revisionBytes = persistedSpecificationDraft(revisionDraft);
    const revised = sealSpecification({
      request: revisionRequest,
      frame: revisionFrame,
      draft: revisionDraft,
      draftBytes: revisionBytes,
      requestSha256: definitionRequestSha256(revisionRequest),
      sourceRequestArtifactId: `art_${"b".repeat(64)}`,
      sourceDraftArtifactId: `art_${"c".repeat(64)}`,
      exactInputArtifactIds: [priorArtifactId],
      priorSpecification: sealed,
      priorSpecificationArtifactId: priorArtifactId,
    });
    expect(
      validateSpecification(revised, { priorSpecification: sealed }).source_coverage
    ).toHaveLength(45);
    expect(revised.supersession).toEqual([]);
    expect(revised.source_coverage.every((entry) => entry.product_item_ids.length > 0)).toBe(true);
  });

  it("accepts meaning-preserving JSON key-order variation in the typed specification footer", () => {
    const value = genericSpecificationFixture();
    const { specification_report: report, ...core } = value.draft;
    const reorderedCore = Object.fromEntries(Object.entries(core).reverse());
    const bytes = Buffer.from(
      [
        report,
        `SPECIFICATION_CORE:${JSON.stringify(reorderedCore)}`,
        `SUMMARY:{"confidence":"${value.draft.confidence}","complete":true}`,
      ].join("\n"),
      "utf8"
    );
    expect(
      parseSpecificationDraft(bytes, {
        request: value.request,
        frame: value.frame,
      }).draft
    ).toEqual(value.draft);
  });

  it("rejects a stale frame after a material definition-request mutation", () => {
    const value = genericSpecificationFixture();
    const mutatedRequest = canonicalizeDefinitionRequest({
      goal: `${value.request.goal} with a materially different acceptance boundary.`,
      constraints: definitionRequestConstraints(value.request),
      exactInputArtifactIds: value.request.input_artifact_ids,
    });
    expect(() =>
      validateSpecificationDraft(value.draft, {
        request: mutatedRequest,
        frame: value.frame,
      })
    ).toThrow(/DefinitionFrameV1 request binding is stale/u);
  });

  it("makes ambiguous caller intent a durable clarification route instead of evidence acquisition", () => {
    const value = genericSpecificationFixture();
    const frame = canonicalizeDefinitionFrame({
      request: value.request,
      selectedProfileId: "generic",
      profileSelectionBasis: "The domain remains cross-domain.",
      route: "clarify",
      routeReason: "The caller must choose the intended audience boundary.",
      clarificationQuestions: ["Which audience is authoritative for acceptance?"],
    });
    expect(frame.route).toBe("clarify");
    expect(frame.clarification_questions).toEqual([
      "Which audience is authoritative for acceptance?",
    ]);
    expect(frame.evidence_questions).toEqual([]);
    expect(() =>
      canonicalizeDefinitionFrame({
        request: value.request,
        selectedProfileId: "generic",
        profileSelectionBasis: "Evidence cannot choose caller intent.",
        route: "evidence",
        routeReason: "Invalid attempt to outsource caller intent.",
        evidenceQuestions: [],
      })
    ).toThrow(/requires at least one evidence question/u);
  });

  it("rejects missing profile categories, incomplete source coverage, and fabricated schema fields", () => {
    const value = genericSpecificationFixture();
    const missingCategory = {
      ...value.draft,
      requirements: value.draft.requirements.filter((entry) => entry.category !== "quality"),
      acceptance_criteria: value.draft.acceptance_criteria.slice(0, 2),
    };
    expect(() =>
      validateSpecificationDraft(missingCategory, {
        request: value.request,
        frame: value.frame,
      })
    ).toThrow(SpecificationDraftValidationError);

    const missingCoverage = {
      ...value.draft,
      source_coverage: value.draft.source_coverage.slice(1),
    };
    expect(() =>
      validateSpecificationDraft(missingCoverage, {
        request: value.request,
        frame: value.frame,
      })
    ).toThrow(/source coverage must contain every source item exactly once/u);

    expect(() => validateSpecification({ ...value.specification, task_graph: [] })).toThrow(
      /must not have additional properties/u
    );
  });

  it("seals revision as a standalone replacement with exact prior and item supersession", () => {
    const prior = genericSpecificationFixture();
    const priorArtifactId = `art_${"7".repeat(64)}`;
    const request = canonicalizeDefinitionRequest({
      goal: prior.request.goal,
      constraints: {
        schema_version: 1,
        mode: "revise",
        requested_profile_id: "generic",
        desired_outcomes: prior.request.desired_outcomes,
        audiences: prior.request.audiences,
        in_scope: prior.request.in_scope,
        out_of_scope: prior.request.out_of_scope,
        hard_constraints: prior.request.hard_constraints,
        non_goals: prior.request.non_goals,
        known_assumptions: prior.request.known_assumptions,
        known_uncertainties: prior.request.known_uncertainties,
        prior_decisions: prior.request.prior_decisions,
        standard_hints: prior.request.standard_hints,
      },
      exactInputArtifactIds: [priorArtifactId],
    });
    const frame = canonicalizeDefinitionFrame({
      request,
      selectedProfileId: "generic",
      profileSelectionBasis: "The revision retains the exact prior generic profile.",
      route: "author",
      routeReason: "The requested revision is explicit.",
    });
    const priorRequirement = prior.specification.requirements.find(
      (entry) => entry.category === "outcome"
    );
    const priorCriterion = prior.specification.acceptance_criteria.find((entry) =>
      priorRequirement === undefined
        ? false
        : entry.requirement_ids.includes(priorRequirement.item_id)
    );
    if (priorRequirement === undefined || priorCriterion === undefined) {
      throw new Error("prior revision fixtures are incomplete");
    }
    const base = genericSpecificationCore(frame);
    const draft: SpecificationDraftV1 = {
      specification_report:
        "This complete replacement tightens the outcome requirement while preserving every other prior item.",
      ...base,
      objectives: base.objectives.map((entry, index) =>
        index === 0 ? { ...entry, source_item_indexes: [...entry.source_item_indexes, 6] } : entry
      ),
      requirements: base.requirements.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              statement: "The transition specification must define a reviewable target outcome.",
            }
          : entry
      ),
      source_coverage: [
        ...base.source_coverage,
        {
          source_item_index: 6,
          disposition: "incorporated" as const,
          product_item_refs: [{ kind: "objective" as const, index: 0 }],
          rationale: "The exact prior specification anchors this complete replacement.",
        },
      ],
      supersession_intents: [
        {
          prior_item_id: priorRequirement.item_id,
          replacement: { kind: "requirement", index: 0 },
          reason: "The outcome requirement is tightened for objective reviewability.",
        },
        {
          prior_item_id: priorCriterion.item_id,
          replacement: { kind: "acceptance_criterion", index: 0 },
          reason: "The criterion is rebound to the tightened requirement.",
        },
      ],
    };
    expect(() =>
      validateSpecificationDraft(
        { ...draft, supersession_intents: [] },
        { request, frame, priorSpecification: prior.specification }
      )
    ).toThrow(/revision silently drops prior item/u);
    const bytes = persistedSpecificationDraft(draft);
    const revised = sealSpecification({
      request,
      frame,
      draft,
      draftBytes: bytes,
      requestSha256: definitionRequestSha256(request),
      sourceRequestArtifactId: `art_${"8".repeat(64)}`,
      sourceDraftArtifactId: `art_${"9".repeat(64)}`,
      exactInputArtifactIds: [priorArtifactId],
      priorSpecification: prior.specification,
      priorSpecificationArtifactId: priorArtifactId,
    });
    expect(validateSpecification(revised, { priorSpecification: prior.specification })).toEqual(
      revised
    );
    expect(revised.supersedes_specification_ids).toEqual([prior.specification.specification_id]);
    expect(revised.supersession.map((entry) => entry.prior_item_id)).toEqual(
      expect.arrayContaining([priorRequirement.item_id, priorCriterion.item_id])
    );
    expect(revised.source_lineage.prior_specification_artifact_id).toBe(priorArtifactId);
    expect(revised.request.mode).toBe("revise");

    // A removal and two replacements may be authored in a different order from
    // canonical prior IDs. Resolve each replacement before sorting, not by index after it.
    const priorNonGoal = prior.specification.non_goals[0];
    if (priorNonGoal === undefined) throw new Error("prior non-goal fixture is absent");
    const removal = {
      prior_item_id: priorNonGoal.item_id,
      replacement: null,
      reason: "The earlier non-goal is explicitly retired in this synthetic revision.",
    };
    const intents = [...draft.supersession_intents, removal];
    const canonicalPosition = [...intents]
      .sort((left, right) => left.prior_item_id.localeCompare(right.prior_item_id))
      .findIndex((intent) => intent.prior_item_id === removal.prior_item_id);
    const authoredIntents =
      canonicalPosition === 0 ? intents : [removal, ...draft.supersession_intents];
    const mixedDraft: SpecificationDraftV1 = {
      ...draft,
      non_goals: [],
      source_coverage: draft.source_coverage.map((row) =>
        row.source_item_index === 5 ? { ...row, disposition: "excluded" as const } : row
      ),
      supersession_intents: authoredIntents,
    };
    expect(
      validateSpecificationDraft(mixedDraft, {
        request,
        frame,
        priorSpecification: prior.specification,
      })
    ).toEqual(mixedDraft);
    const mixed = sealSpecification({
      request,
      frame,
      draft: mixedDraft,
      draftBytes: persistedSpecificationDraft(mixedDraft),
      requestSha256: definitionRequestSha256(request),
      sourceRequestArtifactId: `art_${"8".repeat(64)}`,
      sourceDraftArtifactId: `art_${"9".repeat(64)}`,
      exactInputArtifactIds: [priorArtifactId],
      priorSpecification: prior.specification,
      priorSpecificationArtifactId: priorArtifactId,
    });
    expect(
      mixed.supersession.find((entry) => entry.prior_item_id === removal.prior_item_id)
    ).toMatchObject({ replacement_item_id: null });
  });

  it("diagnoses keyed V3 relational defects at stable semantic paths", () => {
    const fixture = genericSpecificationFixture();
    const requestBytes = Buffer.from(canonicalJson(fixture.request));
    const requestDigest = sha256(requestBytes);
    const requestRef: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${requestDigest}`,
      run_id: "run-define-v3-diagnostic",
      phase: "intake",
      branch_id: null,
      kind: "definition-request",
      operation_id: "definition-request",
      version: 1,
      producer: "host:request-admission",
      media_type: "application/json",
      content_schema: { schema_id: "penny.definition-request.v1", schema_version: 1 },
      byte_length: requestBytes.length,
      content_digest: requestDigest,
      store_ref: `artifact://sha256/${requestDigest}`,
    };
    const { content_schema: ignoredRequestSchema, ...requestRefWithoutSchema } = requestRef;
    void ignoredRequestSchema;
    const orientationRef: ArtifactRef = {
      ...requestRefWithoutSchema,
      artifact_id: `art_${"a".repeat(64)}`,
      phase: "framing_definition",
      kind: "agent-output",
      operation_id: "orientation",
      producer: "agent:piper",
      byte_length: 1,
      content_digest: "a".repeat(64),
      store_ref: `artifact://sha256/${"a".repeat(64)}`,
    };
    const frame = canonicalizeDefinitionFrameV2({
      request: fixture.request,
      requestRef,
      orientationRef,
      selectedProfileId: "generic",
      profileSelectionBasis: "The caller selected generic.",
      route: "author",
      routeReason: "The brief is bounded.",
      discoveredQuestions: [],
    });
    const keyed = keyedSpecificationDraft(fixture.draft, fixture.request);
    const duplicateKey = keyed.specification.requirements[0]?.draft_key;
    if (duplicateKey === undefined) throw new Error("V3 requirement fixture is absent");
    const broken = {
      ...keyed,
      specification: {
        ...keyed.specification,
        requirements: keyed.specification.requirements.map((entry, index) =>
          index === 1 ? { ...entry, draft_key: duplicateKey } : entry
        ),
      },
    };
    try {
      parseSpecificationDraftV3(serializeSpecificationDraftV3(broken), {
        request: fixture.request,
        frame,
      });
      throw new Error("broken keyed draft was accepted");
    } catch (error) {
      if (!(error instanceof SpecificationDraftValidationError)) throw error;
      expect(error.failureClass).toBe("SEMANTIC_INVALID");
      expect(error.sealIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "DUPLICATE_DRAFT_KEY",
            path: `/specification/requirements/by-key/${duplicateKey}`,
          }),
          expect.objectContaining({
            code: "UNKNOWN_REQUIREMENT_KEY",
            path: "/specification/acceptance_criteria/by-key/ac-2/requirement_keys",
          }),
        ])
      );
    }
  });

  it("pins a host-derived 46-source namespace and diagnoses exact missing kinds without padding", () => {
    const fixture = fortySixSourceFixture();
    const sources = definitionRequestSourceItems(fixture.request);
    expect(sources).toHaveLength(46);
    expect(sources.slice(39, 43).map((s) => s.kind)).toEqual(Array(4).fill("prior_decision"));
    expect(sources.slice(43).map((s) => s.kind)).toEqual(Array(3).fill("standard_hint"));
    const bytes = Buffer.from(canonicalJson(fixture.request));
    const digest = sha256(bytes);
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${digest}`,
      run_id: "run-define-46",
      phase: "intake",
      branch_id: null,
      kind: "definition-request",
      operation_id: "definition-request",
      version: 1,
      producer: "host:request-admission",
      media_type: "application/json",
      content_schema: { schema_id: "penny.definition-request.v1", schema_version: 1 },
      byte_length: bytes.byteLength,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    };
    const manifest = definitionSourceManifest(fixture.request, ref);
    expect(manifest).toMatchObject({ request_ref: ref, request_sha256: digest, source_count: 46 });
    expect(manifest.sources).toEqual(sources);
    expect(validateDefinitionSourceManifest(manifest, fixture.request, ref)).toEqual(manifest);
    expect(() =>
      definitionSourceManifest(fixture.request, {
        ...ref,
        content_digest: "f".repeat(64),
      })
    ).toThrow(/exact admitted request ref/u);
    expect(() =>
      validateDefinitionSourceManifest({ ...manifest, source_count: 45 }, fixture.request, ref)
    ).toThrow(/ordered source inventory diverged/u);
    expect(() =>
      validateDefinitionSourceManifest(
        { ...manifest, sources: [...sources].reverse() },
        fixture.request,
        ref
      )
    ).toThrow(/ordered source inventory diverged/u);
    for (const [draft, missing] of [
      [fixture.first, 45],
      [fixture.replacement, 4],
    ] as const) {
      try {
        validateSpecificationDraft(draft, { request: fixture.request, frame: fixture.frame });
        throw new Error("incomplete fixture was accepted");
      } catch (error) {
        if (!(error instanceof SpecificationDraftValidationError)) throw error;
        expect(error.failureClass).toBe("SEMANTIC_INVALID");
        expect(
          error.issues.filter((issue) => issue.includes("source coverage missing ordinal"))
        ).toHaveLength(missing);
        if (missing === 4) {
          expect(error.coverageIssues).toEqual([
            {
              code: "MISSING_SOURCE_ORDINAL",
              path: "source_coverage[42]",
              ordinal: 42,
              kind: "prior_decision",
            },
            ...[43, 44, 45].map((ordinal) => ({
              code: "MISSING_SOURCE_ORDINAL",
              path: `source_coverage[${ordinal}]`,
              ordinal,
              kind: "standard_hint",
            })),
          ]);
          expect(error.issues).toEqual(
            expect.arrayContaining([
              "source coverage missing ordinal 42 (prior_decision)",
              "source coverage missing ordinal 43 (standard_hint)",
              "source coverage missing ordinal 44 (standard_hint)",
              "source coverage missing ordinal 45 (standard_hint)",
            ])
          );
        }
      }
    }
    const repaired = fixture.repaired;
    expect(
      validateSpecificationDraft(repaired, { request: fixture.request, frame: fixture.frame })
    ).toEqual(repaired);
    const draftBytes = persistedSpecificationDraft(repaired);
    const specification = sealSpecification({
      request: fixture.request,
      frame: fixture.frame,
      draft: repaired,
      draftBytes,
      requestSha256: definitionRequestSha256(fixture.request),
      sourceRequestArtifactId: DEFINE_REQUEST_ARTIFACT_ID,
      sourceDraftArtifactId: DEFINE_DRAFT_ARTIFACT_ID,
      exactInputArtifactIds: [],
    });
    expect(validateSpecification(specification).source_coverage).toHaveLength(46);
    try {
      validateSpecificationDraft(
        {
          ...repaired,
          source_coverage: repaired.source_coverage.map((row, i) =>
            i === 45 ? { ...row, source_item_index: 0 } : row
          ),
        },
        { request: fixture.request, frame: fixture.frame }
      );
      throw new Error("duplicate ordinal was accepted");
    } catch (error) {
      if (!(error instanceof SpecificationDraftValidationError)) throw error;
      expect(error.coverageIssues).toContainEqual({
        code: "DUPLICATE_SOURCE_ORDINAL",
        path: "source_coverage[45].source_item_index",
        ordinal: 0,
        kind: "goal",
      });
    }
    expect(() =>
      validateSpecificationDraft(
        {
          ...repaired,
          source_coverage: repaired.source_coverage.map((row, i) =>
            i === 45 ? { ...row, source_item_index: 46 } : row
          ),
        },
        { request: fixture.request, frame: fixture.frame }
      )
    ).toThrow(/out-of-range ordinal 46/u);
  });

  it.each([
    "objective",
    "requirement",
    "acceptance_criterion",
    "constraint",
    "non_goal",
    "assumption",
    "risk",
    "open_question",
    "standard",
  ] as const)("rejects %s projected seed collisions before sealing", (kind) => {
    const fixture = genericSpecificationFixture();
    const base = fixture.draft;
    const objective = base.objectives[0];
    const requirement = base.requirements[0];
    const criterion = base.acceptance_criteria[0];
    const constraint = base.constraints[0];
    const nonGoal = base.non_goals[0];
    if (
      objective === undefined ||
      requirement === undefined ||
      criterion === undefined ||
      constraint === undefined ||
      nonGoal === undefined
    )
      throw new Error("collision fixtures are incomplete");
    // Both rows have the same ID seed but distinct source links: no whole-object duplicate.
    const linked = { source_item_indexes: [1] };
    const draft: SpecificationDraftV1 =
      kind === "objective"
        ? {
            ...base,
            objectives: [...base.objectives, { ...objective, ...linked }],
          }
        : kind === "requirement"
          ? {
              ...base,
              requirements: [...base.requirements, { ...requirement, source_item_indexes: [0] }],
              acceptance_criteria: [
                ...base.acceptance_criteria,
                {
                  statement: "Check duplicate requirement",
                  observation: "Both references project equally.",
                  requirement_indexes: [3],
                  source_item_indexes: [0],
                },
              ],
            }
          : kind === "acceptance_criterion"
            ? {
                ...base,
                acceptance_criteria: [
                  ...base.acceptance_criteria,
                  { ...criterion, source_item_indexes: [0] },
                ],
              }
            : kind === "constraint"
              ? {
                  ...base,
                  constraints: [...base.constraints, { ...constraint, ...linked }],
                }
              : kind === "non_goal"
                ? {
                    ...base,
                    non_goals: [...base.non_goals, { ...nonGoal, ...linked }],
                  }
                : kind === "assumption"
                  ? {
                      ...base,
                      assumptions: [
                        { statement: "Synthetic assumption", source_item_indexes: [0] },
                        { statement: "Synthetic assumption", ...linked },
                      ],
                    }
                  : kind === "risk"
                    ? {
                        ...base,
                        risks: [
                          {
                            statement: "Synthetic risk",
                            impact: "bounded",
                            mitigation: "inspect",
                            source_item_indexes: [0],
                          },
                          {
                            statement: "Synthetic risk",
                            impact: "bounded",
                            mitigation: "inspect",
                            ...linked,
                          },
                        ],
                      }
                    : kind === "open_question"
                      ? {
                          ...base,
                          open_questions: [
                            {
                              question: "Synthetic question?",
                              owner: "caller",
                              blocking: false,
                              source_item_indexes: [0],
                            },
                            {
                              question: "Synthetic question?",
                              owner: "caller",
                              blocking: false,
                              ...linked,
                            },
                          ],
                        }
                      : {
                          ...base,
                          standards_status: [
                            {
                              category: "synthetic",
                              standard: "Synthetic standard",
                              status: "identified",
                              rationale: "Admitted hint",
                              evidence_artifact_slots: [],
                              source_item_indexes: [0],
                            },
                            {
                              category: "synthetic",
                              standard: "Synthetic standard",
                              status: "identified",
                              rationale: "Admitted hint",
                              evidence_artifact_slots: [],
                              ...linked,
                            },
                          ],
                        };
    const input = { request: fixture.request, frame: fixture.frame };
    expect(() => validateSpecificationDraft(draft, input)).toThrow(
      new RegExp(`${kind} projected stable ID collision`, "u")
    );
    expect(() =>
      sealSpecification({
        ...input,
        draft,
        draftBytes: persistedSpecificationDraft(draft),
        requestSha256: definitionRequestSha256(fixture.request),
        sourceRequestArtifactId: DEFINE_REQUEST_ARTIFACT_ID,
        sourceDraftArtifactId: DEFINE_DRAFT_ARTIFACT_ID,
        exactInputArtifactIds: [],
      })
    ).toThrow(SpecificationDraftValidationError);
  });

  it("admits 128 sources and refuses 129 before authoring", () => {
    const fixture = fortySixSourceFixture();
    const base = definitionRequestConstraints(fixture.request);
    const constraints = {
      ...base,
      hard_constraints: Array.from({ length: 64 }, (_, i) => `Bounded condition ${i}.`),
      desired_outcomes: Array.from({ length: 24 }, (_, i) => `Outcome ${i}.`),
      audiences: Array.from({ length: 16 }, (_, i) => `Audience ${i}.`),
      in_scope: Array.from({ length: 11 }, (_, i) => `Scope ${i}.`),
    };
    const request = canonicalizeDefinitionRequest({
      goal: fixture.request.goal,
      constraints,
      exactInputArtifactIds: [],
    });
    expect(definitionRequestSourceItems(request).map((source) => source.ordinal)).toEqual(
      Array.from({ length: 128 }, (_, i) => i)
    );
    expect(() =>
      canonicalizeDefinitionRequest({
        goal: fixture.request.goal,
        constraints: {
          ...constraints,
          in_scope: [...constraints.in_scope, "One source too many."],
        },
        exactInputArtifactIds: [],
      })
    ).toThrow(/may derive at most 128 source items/u);
  });

  it("keeps malformed trusted operands out of the author-correctable draft path", () => {
    const fixture = genericSpecificationFixture();
    const other = canonicalizeDefinitionRequest({
      goal: "An unrelated request",
      constraints: definitionRequestConstraints(fixture.request),
      exactInputArtifactIds: [],
    });
    expect(() =>
      validateSpecificationDraft(fixture.draft, { request: other, frame: fixture.frame })
    ).toThrow(/DefinitionFrameV1 request binding is stale/u);
  });

  it("requires canonical exact bytes and rejects stable-ID or no-execution tampering", () => {
    const value = genericSpecificationFixture();
    const bytes = Buffer.from(canonicalJson(value.specification), "utf8");
    const digest = sha256(bytes);
    const ref: ArtifactRef = {
      schema_version: 2,
      artifact_id: `art_${digest}`,
      run_id: "run-define-contract",
      phase: "sealing_specification",
      branch_id: null,
      kind: "specification",
      operation_id: "sealed-specification",
      version: 1,
      producer: "host:specification-sealer",
      media_type: "application/json",
      content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
      byte_length: bytes.byteLength,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    };
    expect(validateCanonicalSpecificationBytes(bytes, ref)).toEqual(value.specification);
    expect(() =>
      validateCanonicalSpecificationBytes(Buffer.from(`${canonicalJson(value.specification)}\n`))
    ).toThrow(/not canonical JSON/u);
    expect(() =>
      validateSpecification({ ...value.specification, specification_id: "specification-tampered" })
    ).toThrow(/specification_id is invalid/u);
    expect(() =>
      validateSpecification({ ...value.specification, execution_started: true })
    ).toThrow();
  });
});
