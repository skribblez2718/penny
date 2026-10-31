import type { ArtifactRef } from "../../dist/contracts.js";
import type { VideogenWorkerState } from "../../dist/videogen/workers.js";
const semantic = (name: string) => ({ schema_id: `penny.videogen-${name}.v1`, schema_version: 1 });
export function videogenStageWorkerFixtures(): Record<VideogenWorkerState, unknown> {
  const objective = {
    ...semantic("objective-review"),
    target_slot: "target",
    criteria: [
      {
        id: "criterion",
        expected: "one visible subject",
        observed: "one visible subject in supplied frame",
        evidence_slot: "evidence",
        verdict: "pass",
      },
    ],
    evidence_slots: ["evidence"],
    unassessed: ["motion", "sound", "speech", "sync"],
    disposition: "pass",
    violations: [],
  };
  const quality = {
    ...semantic("quality-review"),
    target_slot: "target",
    criteria: [
      {
        id: "criterion",
        observation: "fixture picture composition only; not playback",
        frame_slots: ["frame"],
        verdict: "pass",
      },
    ],
    limitations: ["Provider-free text fixture; no real picture or sound assessment"],
    unassessed: ["motion", "sound", "speech", "sync"],
    disposition: "pass",
    violations: [],
  };
  return {
    brief_analysis: {
      ...semantic("brief-analysis"),
      known: [{ topic: "audience", fact: "fixture audience" }],
      unknown: [],
      coverage_hypotheses: ["one fixture shot"],
      rights_questions: [],
    },
    research_fact: {
      ...semantic("fact-research"),
      question: "What does the supplied source establish?",
      claims: [
        { claim: "fixture claim", evidence_slot: "evidence", limitation: "not deployment proof" },
      ],
      unresolved: [],
    },
    story_options: {
      ...semantic("story-options"),
      treatments: [
        { id: "a", logline: "Fixture A", distinct_tradeoff: "short" },
        { id: "b", logline: "Fixture B", distinct_tradeoff: "long" },
      ],
      reason_needed: "Explicit fixture alternatives",
    },
    story_choice: {
      ...semantic("story-choice"),
      selected_id: "a",
      rationale: "Fixture preference",
      rejected: [{ id: "b", reason: "longer" }],
    },
    story_plan: {
      ...semantic("story-outline"),
      scenes: [{ scene_id: "scene1", order: 1, beat: "a fixture greeting" }],
      shots: [
        {
          shot_id: "shot1",
          scene_id: "scene1",
          order: 1,
          intent: "greeting",
          action: "wave",
          observable_end: "hand lowered",
          camera: "fixed",
          coverage: "single",
          continuity_depends_on: [],
          spoken_line_ids: ["line1"],
        },
      ],
      script_brief: {
        language: "en",
        scene_line_intents: [{ scene_id: "scene1", speaker_id: "speaker1", text_intent: "greet" }],
      },
      acceptance_criteria: ["one greeting"],
    },
    script_text: {
      ...semantic("script-draft"),
      scenes: [
        {
          scene_id: "scene1",
          ordered_lines: [
            { line_id: "line1", speaker_id: "speaker1", text: "Hello.", delivery_intent: "warm" },
          ],
        },
      ],
      narration_lines: [],
      language: "en",
      coverage_shot_ids: ["shot1"],
    },
    story_check: {
      ...semantic("coverage-review"),
      covered_shot_ids: ["shot1"],
      uncovered_line_ids: [],
      continuity_findings: [],
      disposition: "pass",
      violations: [],
    },
    look_check: {
      ...semantic("look-review"),
      selected_asset_ids: ["image1", "voice1"],
      identity_findings: [],
      voice_plan_findings: [],
      disposition: "pass",
      violations: [],
    },
    reference_verify: objective,
    reference_critique: quality,
    animatic_plan: {
      ...semantic("animatic-plan"),
      boards: [
        {
          shot_id: "shot1",
          start: { numerator: 0, denominator: 1 },
          duration: { numerator: 1, denominator: 1 },
          board_asset_id: "image1",
        },
      ],
      voice_status: "actual_approved",
      route_intents: [{ shot_id: "shot1", mode: "t2v" }],
      timing_rationale: ["one fixture second"],
    },
    route_choice: {
      ...semantic("route-choice"),
      shot_id: "shot1",
      candidates: [
        { mode: "t2v", profile_slot: "profile_a", tradeoff: "first fixture" },
        { mode: "i2v", profile_slot: "profile_b", tradeoff: "second fixture" },
      ],
      selected_mode: "t2v",
      reason: "fixture selection, not execution authority",
      unresolved: [],
    },
    draft_verify: objective,
    draft_critique: quality,
    rough_review: objective,
    rough_critique: quality,
    final_verify: objective,
    final_critique: quality,
    master_verify: objective,
    master_critique: quality,
    evidence_synthesis: {
      ...semantic("evidence-synthesis"),
      conflicts: [
        {
          claim_a_slot: "evidence_a",
          claim_b_slot: "evidence_b",
          resolution: "retain uncertainty",
          reason: "contradictory fixture statements",
        },
      ],
      unresolved: ["needs fresh verification"],
    },
  };
}
export function videogenStageRequest() {
  return {
    ...semantic("request"),
    brief: "Provider-free voice-only contract fixture",
    source_refs: [],
    destination_id: "fixture-local",
    format_intent: {
      container: "mp4",
      video_codec: "h264",
      audio_codec: "aac",
      width: 640,
      height: 360,
      fps: { numerator: 24, denominator: 1 },
      audio_rate: { numerator: 48000, denominator: 1 },
      channels: "mono",
      captions_required: false,
    },
    unresolved: [],
    constraints: {
      duration: { numerator: 1, denominator: 1 },
      max_scenes: 1,
      max_shots: 1,
      max_storage_bytes: 1000000,
      max_cost_units: 10,
      max_attempts: 2,
    },
    requested_routes: ["UC-02"],
    delegated_decisions: [],
    must_haves: ["captured speech"],
    dislikes: [],
  };
}
export function videogenStageEnvelope(ref: ArtifactRef) {
  return {
    ...semantic("envelope"),
    request_ref: ref,
    private_config_digest: "a".repeat(64),
    capability_snapshot_ref: ref,
    rights_scope_ref: ref,
    storage_reservation_ref: ref,
    max_scenes: 1,
    max_shots: 1,
    max_frames: 24,
    max_source_bytes: 1000000,
    max_output_bytes: 1000000,
    max_storage_bytes: 1000000,
    max_active_jobs: 1,
    max_attempts: 2,
    max_cost_units: 10,
    finish_reserve_bytes: 100,
    finish_reserve_cost_units: 1,
    finish_reserve_steps: 1,
    queue_policy_ref: ref,
    inactivity_policy_ref: ref,
    cleanup_policy_ref: ref,
  };
}
export function videogenStageAudio(ref: ArtifactRef) {
  return {
    ...semantic("audio-evidence"),
    audio_ref: ref,
    decode_receipt_ref: ref,
    codec: "canonical_pcm",
    channels: "mono",
    sample_rate: { numerator: 48000, denominator: 1 },
    sample_count: 48000,
    decoded_duration: { numerator: 1, denominator: 1 },
    peak_dbfs: -1.25,
    loudness_lufs: -16.5,
    speech_intervals: [
      { start: { numerator: 0, denominator: 1 }, end: { numerator: 1, denominator: 1 } },
    ],
    sync_offsets: [],
    unassessed: ["intelligibility", "identity", "word_alignment"],
  };
}
