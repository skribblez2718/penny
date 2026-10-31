import {
  canonicalJson,
  canonicalizeDefinitionFrame,
  canonicalizeDefinitionRequest,
  definitionRequestSha256,
  definitionRequestSourceItems,
  definitionQuestionId,
  persistedSpecificationDraftV3 as serializeSpecificationDraftV3,
  sealSpecification,
  type DefinitionFrameV1,
  type DefinitionRequestV1,
  type SpecificationCoreV1,
  type SpecificationDraftV1,
  type SpecificationDraftV2,
  type SpecificationDraftV3,
  type SpecificationV1,
} from "../../dist/index.js";

export const DEFINE_REQUEST_ARTIFACT_ID = `art_${"1".repeat(64)}`;
export const DEFINE_DRAFT_ARTIFACT_ID = `art_${"2".repeat(64)}`;

export function genericDefinitionRequest(): DefinitionRequestV1 {
  return canonicalizeDefinitionRequest({
    goal: "Define a safe service transition.",
    constraints: {
      schema_version: 1,
      mode: "create",
      requested_profile_id: "generic",
      desired_outcomes: ["A bounded transition specification is ready for planning."],
      audiences: ["Transition planners"],
      in_scope: ["Transition readiness"],
      out_of_scope: [],
      hard_constraints: ["Do not execute the transition."],
      non_goals: ["Do not redesign unrelated services."],
      known_assumptions: [],
      known_uncertainties: [],
      prior_decisions: [],
      standard_hints: [],
    },
    exactInputArtifactIds: [],
  });
}

export function genericDefinitionFrame(request = genericDefinitionRequest()): DefinitionFrameV1 {
  return canonicalizeDefinitionFrame({
    request,
    selectedProfileId: "generic",
    profileSelectionBasis: "The caller explicitly requested the generic cross-domain profile.",
    route: "author",
    routeReason: "The goal and mandatory boundaries are sufficiently explicit.",
  });
}

export function genericSpecificationCore(
  frame = genericDefinitionFrame()
): SpecificationCoreV1 {
  return {
    schema_version: 1,
    disposition: "ready",
    applicability_reason: "A planning-ready specification is required.",
    profile: frame.profile,
    title: "Safe service transition specification",
    summary: "Define readiness for a bounded transition without executing it.",
    audiences: ["Transition planners"],
    scope: {
      included: ["Transition readiness"],
      excluded: ["Unrelated service redesign"],
    },
    objectives: [
      {
        statement: "A bounded transition is ready for planning.",
        source_item_indexes: [0, 1, 2, 3],
      },
    ],
    requirements: [
      {
        statement: "The transition specification must define the target outcome.",
        category: "outcome",
        priority: "must",
        objective_indexes: [0],
        source_item_indexes: [1],
      },
      {
        statement: "The transition must not be executed during definition.",
        category: "constraint",
        priority: "must",
        objective_indexes: [0],
        source_item_indexes: [4],
      },
      {
        statement: "The specification must be objectively reviewable.",
        category: "quality",
        priority: "must",
        objective_indexes: [0],
        source_item_indexes: [0],
      },
    ],
    acceptance_criteria: [
      {
        statement: "The target outcome is stated and linked to its objective.",
        observation: "The sealed specification contains the outcome requirement and objective link.",
        requirement_indexes: [0],
        source_item_indexes: [1],
      },
      {
        statement: "No transition execution is authorized.",
        observation: "Planning, taskification, and execution flags are false.",
        requirement_indexes: [1],
        source_item_indexes: [4],
      },
      {
        statement: "Every requirement has an observable acceptance condition.",
        observation: "Each requirement ID appears in at least one acceptance criterion.",
        requirement_indexes: [2],
        source_item_indexes: [0],
      },
    ],
    constraints: [
      { statement: "Do not execute the transition.", source_item_indexes: [4] },
    ],
    non_goals: [
      { statement: "Do not redesign unrelated services.", source_item_indexes: [5] },
    ],
    assumptions: [],
    risks: [],
    open_questions: [],
    standards_status: [],
    source_coverage: [
      {
        source_item_index: 0,
        disposition: "incorporated",
        rationale: "The goal establishes the objective and reviewability boundary.",
      },
      {
        source_item_index: 1,
        disposition: "incorporated",
        rationale: "The desired outcome is represented directly.",
      },
      {
        source_item_index: 2,
        disposition: "incorporated",
        rationale: "The audience is preserved in the audience field and objective context.",
      },
      {
        source_item_index: 3,
        disposition: "incorporated",
        rationale: "The in-scope statement is preserved in the scope field and objective context.",
      },
      {
        source_item_index: 4,
        disposition: "incorporated",
        rationale: "The no-execution boundary is a mandatory requirement and constraint.",
      },
      {
        source_item_index: 5,
        disposition: "incorporated",
        rationale: "The explicit non-goal is preserved.",
      },
    ],
    supersession_intents: [],
    planning_readiness_reason: "Objectives, mandatory requirements, and acceptance conditions are complete.",
    confidence: "CERTAIN",
  };
}

// Synthetic ordinal structure matching the audited count, never its private brief.
// Prior decisions occupy 39–42; standard hints occupy 43–45.
export function fortySixSourceFixture(): {
  readonly request: DefinitionRequestV1;
  readonly frame: DefinitionFrameV1;
  readonly first: SpecificationDraftV1;
  readonly replacement: SpecificationDraftV1;
  readonly repaired: SpecificationDraftV1;
} {
  const request = canonicalizeDefinitionRequest({
    goal: "Define a synthetic inventory workflow.",
    constraints: {
      schema_version: 1, mode: "create", requested_profile_id: "generic",
      desired_outcomes: ["Each inventory entry has a recorded outcome."],
      audiences: ["Inventory reviewers"], in_scope: ["Inventory entries"],
      out_of_scope: ["Unrelated inventory migrations"],
      hard_constraints: Array.from({ length: 30 }, (_, i) => `Preserve inventory rule ${i + 1}.`),
      non_goals: ["Do not perform a migration."],
      known_assumptions: [{ statement: "The synthetic inventory is bounded.", material: false }],
      known_uncertainties: [
        { question: "Is inventory policy current?", owner: "evidence", material: false },
        { question: "Which review date applies?", owner: "caller", material: false },
      ],
      prior_decisions: Array.from({ length: 4 }, (_, i) => ({
        statement: `Prior inventory decision ${i + 1}.`, binding_effect: `Keep effect ${i + 1}.`,
      })),
      standard_hints: Array.from({ length: 3 }, (_, i) => ({
        category: `inventory-${i + 1}`, standard: `Synthetic standard ${i + 1}`,
        relevance: `Check inventory category ${i + 1}.`,
      })),
    },
    exactInputArtifactIds: [],
  });
  const frame = genericDefinitionFrame(request);
  const coverage = Array.from({ length: 46 }, (_, ordinal) => ({
    source_item_index: ordinal, disposition: "incorporated" as const,
    rationale: `Source ${ordinal} has an item-side link.`,
  }));
  const repaired: SpecificationDraftV1 = {
    specification_report: "A bounded synthetic inventory specification with complete source links.",
    ...genericSpecificationCore(frame),
    constraints: [
      ...Array.from({ length: 46 }, (_, ordinal) => ({
        statement: ordinal >= 5 && ordinal < 35
          ? (request.hard_constraints[ordinal - 5] ?? "missing rule")
          : `Represent synthetic source ${ordinal}.`,
        source_item_indexes: [ordinal],
      })),
    ],
    scope: { included: ["Inventory entries"], excluded: [...request.out_of_scope] },
    non_goals: [
      { statement: request.out_of_scope[0] ?? "absent exclusion", source_item_indexes: [4] },
      { statement: request.non_goals[0] ?? "absent non-goal", source_item_indexes: [35] },
    ],
    requirements: [
      ...genericSpecificationCore(frame).requirements,
      ...request.prior_decisions.map((decision, index) => ({
        statement: decision.binding_effect, category: "constraint", priority: "must" as const,
        objective_indexes: [0], source_item_indexes: [39 + index],
      })),
    ],
    acceptance_criteria: [
      ...genericSpecificationCore(frame).acceptance_criteria,
      ...request.prior_decisions.map((decision, index) => ({
        statement: `Check ${decision.binding_effect}`, observation: `Binding effect ${index + 1} is preserved.`,
        requirement_indexes: [3 + index], source_item_indexes: [39 + index],
      })),
    ],
    source_coverage: coverage,
  };
  return {
    request, frame, repaired,
    first: { ...repaired, source_coverage: coverage.slice(0, 1) },
    replacement: { ...repaired, source_coverage: coverage.slice(0, 42) },
  };
}

export function persistedSpecificationDraft(draft: SpecificationDraftV1): Uint8Array {
  const { specification_report: report, ...core } = draft;
  return Buffer.from(
    `${report}\nSPECIFICATION_CORE:${canonicalJson(core)}\nSUMMARY:{"confidence":"${draft.confidence}","complete":true}`,
    "utf8"
  );
}

/** New starts transport a V2 wrapper; legacy draft bytes above remain for historical contract tests. */
export function persistedSpecificationDraftV2(
  draft: SpecificationDraftV1,
  request: DefinitionRequestV1 = genericDefinitionRequest(),
  additionalClaims: SpecificationDraftV2["support_claims"] = []
): Uint8Array {
  const { specification_report, ...core } = draft;
  const uncertainties = definitionRequestSourceItems(request).filter(item => item.kind === "uncertainty");
  const support_claims = [
    ...request.known_uncertainties.map((entry, index) => {
      const source = uncertainties[index];
      if (source === undefined) throw new Error("uncertainty source absent");
      return {
        target: { kind: "request_uncertainty" as const, source_item_index: source.ordinal },
        status: "pending" as const, claim: "No target-specific support has resolved this question.",
        rationale: "This uncertainty remains unverified.", support: [],
      };
    }),
    ...additionalClaims,
  ];
  const specification = {
    ...core,
    source_coverage: core.source_coverage.map(({ source_item_index, disposition, rationale }) => ({
      source_item_index, disposition, rationale,
    })),
  };
  return Buffer.from(
    `${specification_report}\nSPECIFICATION_CORE:${canonicalJson({ schema_version: 2, specification, support_claims })}\nSUMMARY:${canonicalJson({ confidence: core.confidence, complete: true })}`,
    "utf8"
  );
}

export function keyedSpecificationDraft(
  draft: SpecificationDraftV1,
  request: DefinitionRequestV1 = genericDefinitionRequest(),
  additionalClaims: SpecificationDraftV3["support_claims"] = []
): SpecificationDraftV3 {
  const key = (kind: string, index: number) => `${kind}-${index + 1}`;
  const productKey = (kind: string, index: number): string => {
    switch (kind) {
      case "objective":
        return key("obj", index);
      case "requirement":
        return key("req", index);
      case "acceptance_criterion":
        return key("ac", index);
      case "constraint":
        return key("constraint", index);
      case "non_goal":
        return key("non-goal", index);
      case "assumption":
        return key("assumption", index);
      case "risk":
        return key("risk", index);
      case "open_question":
        return key("question", index);
      case "standard":
        return key("standard", index);
      default:
        throw new Error(`unknown draft item kind '${kind}'`);
    }
  };
  const uncertainties = definitionRequestSourceItems(request).filter(
    (item) => item.kind === "uncertainty"
  );
  const { specification_report: ignoredReport, ...core } = draft;
  void ignoredReport;
  const support_claims: SpecificationDraftV3["support_claims"] = [
    ...request.known_uncertainties.map((_, index) => {
      const source = uncertainties[index];
      if (source === undefined) throw new Error("uncertainty source absent");
      return {
        target: { kind: "request_uncertainty" as const, source_item_index: source.ordinal },
        status: "pending" as const,
        claim: "No target-specific support has resolved this question.",
        rationale: "This uncertainty remains unverified.",
        support: [],
      };
    }),
    ...additionalClaims,
  ];
  return {
    schema_version: 3,
    specification_report: draft.specification_report,
    specification: {
      ...core,
      objectives: draft.objectives.map((entry, index) => ({
        ...entry,
        draft_key: key("obj", index),
      })),
      requirements: draft.requirements.map(({ objective_indexes, ...entry }, index) => ({
        ...entry,
        draft_key: key("req", index),
        objective_keys: objective_indexes.map((objectiveIndex) => key("obj", objectiveIndex)),
      })),
      acceptance_criteria: draft.acceptance_criteria.map(
        ({ requirement_indexes, ...entry }, index) => ({
          ...entry,
          draft_key: key("ac", index),
          requirement_keys: requirement_indexes.map((requirementIndex) =>
            key("req", requirementIndex)
          ),
        })
      ),
      constraints: draft.constraints.map((entry, index) => ({
        ...entry,
        draft_key: key("constraint", index),
      })),
      non_goals: draft.non_goals.map((entry, index) => ({
        ...entry,
        draft_key: key("non-goal", index),
      })),
      assumptions: draft.assumptions.map((entry, index) => ({
        ...entry,
        draft_key: key("assumption", index),
      })),
      risks: draft.risks.map((entry, index) => ({
        ...entry,
        draft_key: key("risk", index),
      })),
      open_questions: draft.open_questions.map((entry, index) => ({
        ...entry,
        draft_key: key("question", index),
      })),
      standards_status: draft.standards_status.map((entry, index) => ({
        ...entry,
        draft_key: key("standard", index),
      })),
      source_coverage: draft.source_coverage.map(
        ({ source_item_index, disposition, rationale }) => ({
          source_item_index,
          disposition,
          rationale,
        })
      ),
      supersession_intents: draft.supersession_intents.map((entry) => ({
        ...entry,
        replacement:
          entry.replacement === null
            ? null
            : {
                kind: entry.replacement.kind,
                draft_key: productKey(entry.replacement.kind, entry.replacement.index),
              },
      })),
    },
    support_claims,
  };
}

export function persistedSpecificationDraftV3(
  draft: SpecificationDraftV1,
  request: DefinitionRequestV1 = genericDefinitionRequest(),
  additionalClaims: SpecificationDraftV3["support_claims"] = []
): Uint8Array {
  return serializeSpecificationDraftV3(keyedSpecificationDraft(draft, request, additionalClaims));
}

export function answeredDefinitionClaim(request: DefinitionRequestV1, question: string) {
  return {
    target: { kind: "discovered_question" as const, question_id: definitionQuestionId({
      requestId: request.request_id, owner: "caller", sourceItemIndex: null,
      question, material: true,
    }) },
    status: "resolved" as const, claim: "The caller answered this question.",
    rationale: "The exact response slot contains the answer.",
    support: [{ support_slot: 0, locator: { kind: "json_pointer" as const, pointer: "/answers/0/answer_text" } }],
  };
}

export function genericSpecificationFixture(): {
  readonly request: DefinitionRequestV1;
  readonly frame: DefinitionFrameV1;
  readonly draft: SpecificationDraftV1;
  readonly draftBytes: Uint8Array;
  readonly specification: SpecificationV1;
} {
  const request = genericDefinitionRequest();
  const frame = genericDefinitionFrame(request);
  const draft: SpecificationDraftV1 = {
    specification_report:
      "This specification defines a bounded, reviewable transition target and preserves the caller's execution boundary.",
    ...genericSpecificationCore(frame),
  };
  const draftBytes = persistedSpecificationDraft(draft);
  const specification = sealSpecification({
    request,
    frame,
    draft,
    draftBytes,
    requestSha256: definitionRequestSha256(request),
    sourceRequestArtifactId: DEFINE_REQUEST_ARTIFACT_ID,
    sourceDraftArtifactId: DEFINE_DRAFT_ARTIFACT_ID,
    exactInputArtifactIds: [],
  });
  return { request, frame, draft, draftBytes, specification };
}
