import { validateContract, CompletionGateSchema, type CompletionGate } from "../contracts.js";

export const VIDEOGEN_COMPLETION_PREDICATE_IDS = Object.freeze([
  "videogen.gates_current.v1",
  "videogen.shots_current.v1",
  "videogen.audio_playback.v1",
  "videogen.native_portable.v1",
  "videogen.rights_current.v1",
  "videogen.delivery_exact.v1",
  "videogen.effects_settled.v1",
] as const);
/** Required proof envelope for the registered executor. Qualification remains separate. */
export const VIDEOGEN_COMPLETION_GATE: CompletionGate = Object.freeze(
  validateContract(
    CompletionGateSchema,
    {
      schema_version: 2,
      allowed_terminal_origins: ["completion_check"],
      required_visited_states: [
        "admit",
        "story_plan",
        "script_text",
        "story_check",
        "g1",
        "asset_prepare",
        "look_check",
        "reference_verify",
        "reference_critique",
        "g2",
        "animatic_plan",
        "animatic_build",
        "g3",
        "shot_prepare",
        "draft_apply",
        "draft_verify",
        "draft_critique",
        "rough_build",
        "rough_review",
        "rough_critique",
        "g4",
        "final_prepare",
        "final_verify",
        "final_critique",
        "finish_prepare",
        "finish_apply",
        "master_verify",
        "master_critique",
        "g5",
        "delivery_prepare",
        "delivery_apply",
        "completion_check",
      ],
      latest_product: {
        selector: "terminal_artifact",
        schema_id: "penny.videogen-terminal.v1",
        product_schema_version: 1,
        artifact_kind: "videogen-terminal",
        producing_state: "completion_check",
      },
      unresolved_policy: { mode: "max_count", max_count: 0 },
      required_receipt_predicates: [...VIDEOGEN_COMPLETION_PREDICATE_IDS],
    },
    "proposed videogen completion descriptor"
  )
);
