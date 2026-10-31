import {
  definitionRequestSha256,
  sealSpecification,
  type SpecificationDraftV1,
} from "../../dist/skill-contracts/define.js";
import {
  DEFINE_DRAFT_ARTIFACT_ID,
  DEFINE_REQUEST_ARTIFACT_ID,
  genericSpecificationFixture,
  persistedSpecificationDraft,
} from "./define-fixtures.js";

/** Public synthetic specification: all seven indexed families, with admitted dense core counts. */
export function densePlanSpecificationFixture() {
  const base = genericSpecificationFixture();
  const requirements = [
    ...base.draft.requirements,
    ...Array.from({ length: 125 }, (_, index) => ({
      statement: `Synthetic readiness condition ${index + 4} must be preserved.`,
      category: "outcome",
      priority: "must" as const,
      objective_indexes: [0],
      source_item_indexes: [1],
    })),
  ];
  const draft: SpecificationDraftV1 = {
    ...base.draft,
    requirements,
    acceptance_criteria: requirements.map((_, index) => ({
      statement: `Readiness condition ${index + 1} is reviewable.`,
      observation: `Inspect condition ${index + 1} without execution.`,
      requirement_indexes: [index],
      source_item_indexes: [1],
    })),
    constraints: [
      ...base.draft.constraints,
      ...Array.from({ length: 63 }, (_, index) => ({
        statement: `Preserve synthetic constraint ${index + 2}.`,
        source_item_indexes: [4],
      })),
    ],
    non_goals: [
      ...base.draft.non_goals,
      ...Array.from({ length: 31 }, (_, index) => ({
        statement: `Do not expand into synthetic scope ${index + 2}.`,
        source_item_indexes: [5],
      })),
    ],
    assumptions: [{ statement: "Synthetic inputs are bounded.", source_item_indexes: [1] }],
    risks: [{
      statement: "The synthetic readiness assessment may become stale.",
      impact: "Reassessment may be needed.",
      mitigation: "Review before use.",
      source_item_indexes: [1],
    }],
    open_questions: [{
      question: "Will a later optional review improve this assessment?",
      owner: "caller",
      blocking: false,
      source_item_indexes: [1],
    }],
    standards_status: [{
      category: "synthetic-readiness",
      standard: "Synthetic readiness standard",
      status: "applicable",
      rationale: "The synthetic readiness boundary applies to the strategy.",
      evidence_artifact_slots: [],
      source_item_indexes: [1],
    }],
  };
  const draftBytes = persistedSpecificationDraft(draft);
  const specification = sealSpecification({
    request: base.request,
    frame: base.frame,
    draft,
    draftBytes,
    requestSha256: definitionRequestSha256(base.request),
    sourceRequestArtifactId: DEFINE_REQUEST_ARTIFACT_ID,
    sourceDraftArtifactId: DEFINE_DRAFT_ARTIFACT_ID,
    exactInputArtifactIds: [],
  });
  return { ...base, draft, draftBytes, specification };
}
