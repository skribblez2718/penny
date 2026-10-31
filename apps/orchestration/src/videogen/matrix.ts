import { VIDEOGEN_WORKERS } from "./workers.js";
export const VIDEOGEN_HOST_STATES = [
  "admit",
  "g1",
  "asset_prepare",
  "image_child",
  "voice_capture",
  "g2",
  "animatic_build",
  "g3",
  "shot_prepare",
  "draft_apply",
  "rough_build",
  "g4",
  "final_prepare",
  "final_apply",
  "finish_prepare",
  "finish_apply",
  "g5",
  "delivery_prepare",
  "delivery_apply",
  "completion_check",
  "clarify",
  "child_call",
] as const;
export const VIDEOGEN_TERMINALS = ["delivered", "incomplete", "cancelled", "error"] as const;
export const VIDEOGEN_REPAIRS = [
  ["brief_analysis", "analysis_gap", "brief_analysis"],
  ["research_fact", "evidence_gap", "research_fact"],
  ["story_options", "analysis_gap", "story_options"],
  ["story_choice", "analysis_gap", "story_options"],
  ["story_plan", "product_gap", "story_plan"],
  ["script_text", "product_gap", "script_text"],
  ["story_check", "validation_gap", "story_plan"],
  ["story_check", "product_gap", "script_text"],
  ["look_check", "analysis_gap", "asset_prepare"],
  ["reference_verify", "validation_gap", "asset_prepare"],
  ["reference_critique", "product_gap", "asset_prepare"],
  ["animatic_plan", "product_gap", "animatic_plan"],
  ["route_choice", "analysis_gap", "route_choice"],
  ["draft_verify", "validation_gap", "shot_prepare"],
  ["draft_critique", "product_gap", "shot_prepare"],
  ["rough_review", "validation_gap", "rough_build"],
  ["rough_critique", "product_gap", "rough_build"],
  ["final_verify", "validation_gap", "final_prepare"],
  ["final_critique", "product_gap", "final_prepare"],
  ["master_verify", "validation_gap", "finish_prepare"],
  ["master_verify", "product_gap", "final_prepare"],
  ["master_critique", "product_gap", "finish_prepare"],
  ["evidence_synthesis", "synthesis_gap", "evidence_synthesis"],
] as const;
export const VIDEOGEN_SUCCESSORS: Readonly<Record<string, readonly string[]>> = {
  admit: ["brief_analysis"],
  brief_analysis: ["research_fact", "story_options", "story_plan"],
  research_fact: ["story_options", "story_plan"],
  story_options: ["story_choice"],
  story_choice: ["story_plan"],
  story_plan: ["script_text"],
  script_text: ["story_check"],
  story_check: ["g1"],
  g1: ["asset_prepare", "story_plan", "script_text", "g1"],
  asset_prepare: ["image_child", "voice_capture", "look_check"],
  image_child: ["image_child", "voice_capture", "look_check"],
  voice_capture: ["voice_capture", "look_check"],
  look_check: ["reference_verify"],
  reference_verify: ["reference_critique"],
  reference_critique: ["g2"],
  g2: ["animatic_plan", "asset_prepare"],
  animatic_plan: ["animatic_build"],
  animatic_build: ["g3"],
  g3: ["route_choice", "shot_prepare", "animatic_plan"],
  route_choice: ["shot_prepare"],
  shot_prepare: ["draft_apply"],
  draft_apply: ["draft_verify"],
  draft_verify: ["draft_critique"],
  draft_critique: ["route_choice", "shot_prepare", "rough_build"],
  rough_build: ["rough_review"],
  rough_review: ["rough_critique"],
  rough_critique: ["g4"],
  g4: ["final_prepare", "rough_build", "shot_prepare", "story_plan", "script_text"],
  final_prepare: ["final_apply", "final_verify"],
  final_apply: ["final_verify"],
  final_verify: ["final_critique"],
  final_critique: ["final_prepare", "finish_prepare"],
  finish_prepare: ["finish_apply"],
  finish_apply: ["master_verify"],
  master_verify: ["master_critique"],
  master_critique: ["g5"],
  g5: ["delivery_prepare", "finish_prepare", "final_prepare", "story_plan", "script_text", "admit"],
  delivery_prepare: ["delivery_apply"],
  delivery_apply: ["completion_check"],
  completion_check: ["delivered", "incomplete"],
  clarify: [
    "admit",
    "brief_analysis",
    "research_fact",
    "story_options",
    "story_choice",
    "story_plan",
    "script_text",
    "asset_prepare",
    "animatic_plan",
    "route_choice",
    "shot_prepare",
    "rough_build",
    "final_prepare",
    "finish_prepare",
    "master_critique",
  ],
  child_call: [
    "brief_analysis",
    "story_plan",
    "story_check",
    "route_choice",
    "draft_verify",
    "master_verify",
  ],
  evidence_synthesis: [
    "story_check",
    "reference_verify",
    "draft_verify",
    "rough_review",
    "final_verify",
    "master_verify",
  ],
};
export const VIDEOGEN_OPTIONAL_CHILD_PARENTS = [
  "brief_analysis",
  "story_plan",
  "story_check",
  "route_choice",
  "draft_verify",
  "master_verify",
];
export const VIDEOGEN_SYNTHESIS_VERIFIERS = [
  "story_check",
  "reference_verify",
  "draft_verify",
  "rough_review",
  "final_verify",
  "master_verify",
];
const states = [...Object.keys(VIDEOGEN_WORKERS), ...VIDEOGEN_HOST_STATES, ...VIDEOGEN_TERMINALS];
const edges: [string, string][] = Object.entries(VIDEOGEN_SUCCESSORS).flatMap(([from, targets]) =>
  targets.map((to) => [from, to] satisfies [string, string])
);
for (const [from, , to] of VIDEOGEN_REPAIRS) edges.push([from, to], [from, "incomplete"]);
for (const from of VIDEOGEN_OPTIONAL_CHILD_PARENTS) edges.push([from, "child_call"]);
for (const from of VIDEOGEN_SYNTHESIS_VERIFIERS) edges.push([from, "evidence_synthesis"]);
for (const from of states.filter((s) => !VIDEOGEN_TERMINALS.some((t) => t === s)))
  if (from !== "clarify") edges.push([from, "clarify"]);
for (const from of states.filter((s) => !VIDEOGEN_TERMINALS.some((t) => t === s)))
  for (const to of ["incomplete", "cancelled", "error"]) edges.push([from, to]);
export const VIDEOGEN_FLOW = Object.freeze({
  states,
  edges: [...new Map(edges.map((e) => [e.join("→"), e])).values()],
});
/** The seven host effects are ordered within these states; child dispatch is not an effect kind. */
export const VIDEOGEN_STATE_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  voice_capture: ["voice_job"],
  shot_prepare: ["reference_upload"],
  draft_apply: ["video_render", "media_decode_extract"],
  rough_build: ["timeline_master", "media_decode_extract"],
  final_prepare: ["reference_upload", "media_decode_extract"],
  final_apply: ["video_render", "media_decode_extract"],
  finish_apply: ["timeline_master", "media_decode_extract", "kdenlive_build_verify"],
  delivery_apply: ["local_delivery"],
};

/** Engine-native finite repair declarations. No worker can choose a target or exhaustion result. */
export const VIDEOGEN_REPAIR_ROUTING: import("../contracts.js").SkillContract["repair_routing"] = {
  schema_version: 1,
  routes: VIDEOGEN_REPAIRS.map(([origin, kind, target]) => ({
    schema_version: 1,
    origin_state: origin,
    feedback_kind: kind,
    repair: { action: "transition", target_state: target },
    budget: { counter: "iteration", limit_source: "run.max_iterations", reserved_attempts: 1 },
    on_exhaustion: { action: "transition", target_state: "incomplete", reset_counter: false },
  })),
};
export const VIDEOGEN_WORKER_PHASES = new Map(
  Object.entries(VIDEOGEN_WORKERS).map(([state, worker]) => [
    state,
    {
      agent: worker.agent,
      result_schema_id: worker.schema.properties.schema_id.const,
      result_schema_version: 1 as const,
      schema: worker.schema,
      ...(worker.agent === "vera" || worker.agent === "carren"
        ? { requires_image_input: true as const }
        : {}),
    },
  ])
);
