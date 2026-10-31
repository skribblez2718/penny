import { VIDEOGEN_REPAIR_ROUTING } from "../videogen/matrix.js";
import type { SkillContract } from "../contracts.js";
import { VIDEOGEN_COMPLETION_GATE } from "../videogen/completion-policy.js";
export const VIDEOGEN_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: "videogen",
  objective:
    "Produce a reviewed audiovisual master and a portable editable project through current G1–G5 authority and exact owner evidence.",
  io: {
    request: {
      schema_version: 1,
      name: "video_request",
      direction: "input",
      transport: "inline_request",
      schema_id: "penny.videogen-request.v1",
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [],
    active_output_ports: [
      {
        schema_version: 1,
        name: "video_terminal",
        direction: "output",
        transport: "artifact",
        schema_id: "penny.videogen-terminal.v1",
        schema_version_required: 1,
        artifact_kind: "videogen-terminal",
        source: "skill",
        min_items: 1,
        max_items: 1,
        semantic_product: true,
      },
    ],
  },
  behavior: {
    side_effects: {
      external_reads: "host_policy_only",
      external_mutations: "host_approved_only",
      filesystem_writes: "host_policy_only",
      allowed_relative_paths: [],
    },
    approval: { policy: "existing_host_gates", additional_approval_required: true },
    stopping: {
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "await_user",
    },
    escalation: { out_of_scope_effect: "non_positive", sandbox_prevention_claim: false },
    violation_terminal: "incomplete",
  },
  guidance: {
    skill_root: ".pi/skills/videogen/assets/prompts",
    resolution: "per_agent_phase",
    documentation: [],
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.videogen-budget.v1",
    resolver_id: "videogenLivenessPolicy",
    admission_id: "LivenessController.admitInvocation",
    snapshot_id: "LivenessController.snapshot",
  },
  repair_routing: VIDEOGEN_REPAIR_ROUTING,
  completion_gate: VIDEOGEN_COMPLETION_GATE,
};
