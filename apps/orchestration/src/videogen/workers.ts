import { Type, type TSchema } from "typebox";
import { ConfidenceSchema, validateContract } from "../contracts.js";
import { OpaqueIdSchema as Id } from "../skill-contracts/common.js";
import {
  validateStoryStructure,
  StoryOutlineV1Schema,
  ScriptDraftV1Schema,
} from "./foundation-contracts.js";
import { RationalTimeSchema as Time } from "./rational-time.js";
const closed = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1, maxLength: 16384 });
const texts = Type.Array(text, { maxItems: 128 });
const ids = Type.Array(Id, { maxItems: 128, uniqueItems: true });
const contradiction = Type.Optional(
  Type.Array(Id, { minItems: 2, maxItems: 32, uniqueItems: true })
);
const common = {
  needs_clarification: Type.Optional(Type.Boolean()),
  clarifying_questions: Type.Optional(texts),
  confidence: Type.Optional(ConfidenceSchema),
};
const semantic = <N extends string>(name: N) => ({
  schema_id: Type.Literal(`penny.videogen-${name}.v1`),
  schema_version: Type.Literal(1),
});
const disposition = Type.Union([
  Type.Literal("pass"),
  Type.Literal("repair"),
  Type.Literal("blocked"),
]);
const product = <N extends string, P extends Record<string, TSchema>>(name: N, fields: P) =>
  Type.Object({ ...semantic(name), ...fields, ...common }, closed);
export const BriefAnalysisSchema = product("brief-analysis", {
  known: Type.Array(Type.Object({ topic: Id, fact: text }, closed)),
  unknown: Type.Array(Type.Object({ topic: Id, consequence: text, question: text }, closed)),
  coverage_hypotheses: texts,
  rights_questions: texts,
});
export const FactResearchSchema = product("fact-research", {
  question: text,
  claims: Type.Array(Type.Object({ claim: text, evidence_slot: Id, limitation: text }, closed)),
  unresolved: texts,
});
export const StoryOptionsSchema = product("story-options", {
  treatments: Type.Array(Type.Object({ id: Id, logline: text, distinct_tradeoff: text }, closed), {
    minItems: 2,
    maxItems: 4,
  }),
  reason_needed: text,
});
export const StoryChoiceSchema = product("story-choice", {
  selected_id: Id,
  rationale: text,
  rejected: Type.Array(Type.Object({ id: Id, reason: text }, closed)),
});
export const CoverageReviewSchema = product("coverage-review", {
  contradiction_slots: contradiction,
  covered_shot_ids: ids,
  uncovered_line_ids: ids,
  continuity_findings: texts,
  disposition,
  violations: texts,
});
export const LookReviewSchema = product("look-review", {
  selected_asset_ids: ids,
  identity_findings: texts,
  voice_plan_findings: texts,
  disposition,
  violations: texts,
});
export const ObjectiveReviewSchema = product("objective-review", {
  contradiction_slots: contradiction,
  target_slot: Id,
  criteria: Type.Array(
    Type.Object(
      {
        id: Id,
        expected: text,
        observed: text,
        evidence_slot: Id,
        verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unknown")]),
      },
      closed
    ),
    { maxItems: 128 }
  ),
  evidence_slots: ids,
  unassessed: texts,
  disposition,
  violations: texts,
});
export const QualityReviewSchema = product("quality-review", {
  target_slot: Id,
  criteria: Type.Array(
    Type.Object(
      {
        id: Id,
        observation: text,
        frame_slots: ids,
        verdict: Type.Union([
          Type.Literal("pass"),
          Type.Literal("repair"),
          Type.Literal("unknown"),
        ]),
      },
      closed
    ),
    { maxItems: 128 }
  ),
  limitations: texts,
  unassessed: Type.Array(
    Type.Union([
      Type.Literal("motion"),
      Type.Literal("sound"),
      Type.Literal("speech"),
      Type.Literal("sync"),
    ]),
    { uniqueItems: true }
  ),
  disposition,
  violations: texts,
});
export const AnimaticPlanSchema = product("animatic-plan", {
  boards: Type.Array(
    Type.Object({ shot_id: Id, start: Time, duration: Time, board_asset_id: Id }, closed),
    { minItems: 1 }
  ),
  voice_status: Type.Union([
    Type.Literal("actual_approved"),
    Type.Literal("provisional"),
    Type.Literal("none"),
  ]),
  route_intents: Type.Array(Type.Object({ shot_id: Id, mode: Id }, closed), { minItems: 1 }),
  timing_rationale: texts,
});
export const RouteChoiceSchema = product("route-choice", {
  shot_id: Id,
  candidates: Type.Array(Type.Object({ mode: Id, profile_slot: Id, tradeoff: text }, closed), {
    minItems: 2,
  }),
  selected_mode: Id,
  reason: text,
  unresolved: texts,
});
export const EvidenceSynthesisSchema = product("evidence-synthesis", {
  conflicts: Type.Array(
    Type.Object({ claim_a_slot: Id, claim_b_slot: Id, resolution: text, reason: text }, closed),
    { minItems: 1 }
  ),
  unresolved: texts,
});
export const VIDEOGEN_WORKERS = {
  brief_analysis: { agent: "annie", schema: BriefAnalysisSchema },
  research_fact: { agent: "echo", schema: FactResearchSchema },
  story_options: { agent: "ida", schema: StoryOptionsSchema },
  story_choice: { agent: "demetri", schema: StoryChoiceSchema },
  story_plan: { agent: "piper", schema: StoryOutlineV1Schema },
  script_text: { agent: "skribble", schema: ScriptDraftV1Schema },
  story_check: { agent: "annie", schema: CoverageReviewSchema },
  look_check: { agent: "annie", schema: LookReviewSchema },
  reference_verify: { agent: "vera", schema: ObjectiveReviewSchema },
  reference_critique: { agent: "carren", schema: QualityReviewSchema },
  animatic_plan: { agent: "piper", schema: AnimaticPlanSchema },
  route_choice: { agent: "demetri", schema: RouteChoiceSchema },
  draft_verify: { agent: "vera", schema: ObjectiveReviewSchema },
  draft_critique: { agent: "carren", schema: QualityReviewSchema },
  rough_review: { agent: "vera", schema: ObjectiveReviewSchema },
  rough_critique: { agent: "carren", schema: QualityReviewSchema },
  final_verify: { agent: "vera", schema: ObjectiveReviewSchema },
  final_critique: { agent: "carren", schema: QualityReviewSchema },
  master_verify: { agent: "vera", schema: ObjectiveReviewSchema },
  master_critique: { agent: "carren", schema: QualityReviewSchema },
  evidence_synthesis: { agent: "synthia", schema: EvidenceSynthesisSchema },
} as const;
export type VideogenWorkerState = keyof typeof VIDEOGEN_WORKERS;
export function workerState(state: string): state is VideogenWorkerState {
  return Object.hasOwn(VIDEOGEN_WORKERS, state);
}
export function validateVideogenWorker(
  state: VideogenWorkerState,
  value: unknown,
  availableSlots?: ReadonlySet<string>
) {
  const result = validateContract(VIDEOGEN_WORKERS[state].schema, value, `videogen ${state}`);
  if (
    "contradiction_slots" in result &&
    result.contradiction_slots !== undefined &&
    ![
      "story_check",
      "reference_verify",
      "draft_verify",
      "rough_review",
      "final_verify",
      "master_verify",
    ].includes(state)
  )
    throw new Error("contradiction trigger requires a registered verifier");
  if (
    "needs_clarification" in result &&
    result.needs_clarification === true &&
    (!result.clarifying_questions || result.clarifying_questions.length === 0)
  )
    throw new Error("clarification requires questions");
  if (
    "criteria" in result &&
    result.disposition === "pass" &&
    (result.criteria.length === 0 ||
      result.violations.length > 0 ||
      result.criteria.some((c) => c.verdict !== "pass"))
  )
    throw new Error("PASS cannot contain failed or unknown criteria");
  if ("disposition" in result && result.disposition === "pass" && result.violations.length > 0)
    throw new Error("PASS with violations");
  if (state === "story_plan") {
    const outline = validateContract(StoryOutlineV1Schema, value, "videogen outline");
    validateStoryStructure(outline);
  }
  if (
    "treatments" in result &&
    new Set(result.treatments.map((x) => x.id)).size !== result.treatments.length
  )
    throw new Error("duplicate story treatment IDs");
  if ("selected_id" in result && result.rejected.some((x) => x.id === result.selected_id))
    throw new Error("selected story also rejected");
  if (
    "criteria" in result &&
    new Set(result.criteria.map((x) => x.id)).size !== result.criteria.length
  )
    throw new Error("duplicate review criterion IDs");
  if (result.schema_id === "penny.videogen-quality-review.v1") {
    const review = validateContract(QualityReviewSchema, value, "videogen quality review");
    if (["motion", "sound", "speech", "sync"].some((x) => !review.unassessed.some((y) => y === x)))
      throw new Error("still-frame quality reviewer must leave full AV dimensions unassessed");
  }
  if (availableSlots !== undefined) {
    const required: string[] = [
      ...("contradiction_slots" in result ? (result.contradiction_slots ?? []) : []),
    ];
    if ("target_slot" in result) required.push(result.target_slot);
    if ("evidence_slots" in result)
      required.push(...result.evidence_slots, ...result.criteria.map((x) => x.evidence_slot));
    if ("criteria" in result)
      for (const criterion of result.criteria)
        if ("frame_slots" in criterion) required.push(...criterion.frame_slots);
    if ("claims" in result) required.push(...result.claims.map((x) => x.evidence_slot));
    if ("conflicts" in result)
      required.push(...result.conflicts.flatMap((x) => [x.claim_a_slot, x.claim_b_slot]));
    if ("candidates" in result) required.push(...result.candidates.map((x) => x.profile_slot));
    if (required.some((slot) => !availableSlots.has(slot)))
      throw new Error("worker invented an unavailable evidence slot");
  }
  return result;
}
