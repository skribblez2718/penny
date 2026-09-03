import { Type } from "typebox";

import {
  validateDirective,
  type Confidence,
  type Directive,
  type JsonValue,
  type SkillContract,
} from "../../src/contracts.js";
import type { RunContext } from "../../src/context.js";
import type { PlaybookCoreV1 } from "../../src/playbooks/playbook.js";
import {
  passthroughStartAdmission,
  type PlaybookRegistrationV1,
} from "../../src/playbooks/registry.js";

export const CORE_ONLY_PLAYBOOK_NAME = "core-only-fixture";
const CORE_ONLY_STATE = "planning";
const CORE_ONLY_AGENT = "piper";

export const CORE_ONLY_CONTRACT: SkillContract = {
  schema_version: 2,
  name: CORE_ONLY_PLAYBOOK_NAME,
  release_status: "production",
  objective: "Prove the mandatory playbook core without optional capabilities.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: "penny.test-core-request.v1",
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [
      {
        schema_version: 1,
        name: "grounded_synthesis_context",
        direction: "input",
        transport: "artifact",
        schema_id: "penny.grounded-synthesis.v1",
        schema_version_required: 1,
        artifact_kind: "semantic-core",
        source: "prior_skill",
        min_items: 0,
        max_items: 1,
        semantic_product: true,
      },
    ],
    active_output_ports: [
      {
        schema_version: 1,
        name: "result",
        direction: "output",
        transport: "artifact",
        schema_id: "penny.test-core-result.v1",
        schema_version_required: 1,
        artifact_kind: "agent-output",
        source: "skill",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
    ],
  },
  behavior: {
    side_effects: {
      external_reads: "permitted_within_liveness_and_yaml",
      external_mutations: "forbidden",
      filesystem_writes: "forbidden",
      allowed_relative_paths: [],
    },
    approval: {
      policy: "caller_skill_request",
      additional_approval_required: false,
    },
    stopping: {
      budget_exhaustion: "incomplete",
      cancellation: "cancelled",
      blocking_ambiguity: "await_user",
    },
    escalation: {
      out_of_scope_effect: "non_positive",
      sandbox_prevention_claim: false,
    },
    violation_terminal: "incomplete",
  },
  guidance: {
    skill_root: "apps/orchestration/tests/fixtures/skills/generic-ingress/prompts",
    resolution: "per_agent_phase",
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.test-core-budget.v1",
    resolver_id: "fixtureResolver",
    admission_id: "fixtureAdmission",
    snapshot_id: "fixtureSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [CORE_ONLY_STATE],
    required_visited_states: [CORE_ONLY_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: "penny.test.core-only-terminal-result",
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

function terminal(
  context: RunContext,
  action: "complete" | "cancelled",
  unresolved: string[] = []
): Directive {
  const met = action === "complete";
  context.previousState = context.stateId;
  context.stateId = action;
  context.status = action;
  context.met = met;
  context.pendingBranches = [];
  const next = validateDirective({
    schema_version: 2,
    action,
    identity: context.identity,
    status: action,
    met,
    result: { complete: met },
    artifacts: [...context.selectedArtifacts],
    unresolved,
  });
  context.pendingDirective = next;
  context.terminalDirective = next;
  return next;
}

/** Mandatory PlaybookCoreV1 only: no fan, repair, liveness, gate, or host capability. */
export class CoreOnlyPlaybook implements PlaybookCoreV1 {
  initialize(context: RunContext): Directive {
    context.transition(CORE_ONLY_STATE);
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    const upstream = [...context.selectedArtifacts];
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: CORE_ONLY_STATE,
      agent: CORE_ONLY_AGENT,
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      task: "Return the deterministic core-only completion summary.",
      input_artifacts: {
        schema_version: 2,
        artifacts: upstream.map((ref, index) => ({
          slot: `upstream-${String(index + 1).padStart(4, "0")}`,
          ref,
        })),
      },
      output_artifact: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: CORE_ONLY_STATE,
        branch_id: null,
        kind: "agent-output",
        operation_id: `core-only:${context.identity.run_id}`,
        version: 1,
        producer: `agent:${CORE_ONLY_AGENT}`,
        media_type: "text/plain; charset=utf-8",
        parent_ref: null,
        upstream_refs: upstream,
      },
    });
    context.pendingDirective = next;
    return next;
  }

  resume(_context: RunContext, _response: JsonValue): Directive {
    throw new Error("core-only fixture has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    return terminal(context, "cancelled", [reason]);
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    if (details.complete !== true) throw new Error("core-only completion was not reported");
    return terminal(context, "complete");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }
}

const CORE_ONLY_START_ADMISSION = passthroughStartAdmission({
  schema_id: "penny.test-core-request.v1",
  schema_version: 1,
});

export const CORE_ONLY_REGISTRATION: PlaybookRegistrationV1 = {
  name: CORE_ONLY_PLAYBOOK_NAME,
  contract: CORE_ONLY_CONTRACT,
  ingress: "skill",
  start_admission: {
    ...CORE_ONLY_START_ADMISSION,
    prepare: (request, host) => {
      if (Object.keys(request.constraints).length !== 0) {
        throw new Error("core-only fixture request constraints must be a closed empty object");
      }
      return CORE_ONLY_START_ADMISSION.prepare(request, host);
    },
  },
  liveness: {
    resolver_id: "fixtureResolver",
    resolve: () => ({
      schema_version: 1,
      scope: CORE_ONLY_PLAYBOOK_NAME,
      preset: "fixture",
      total_phase_repair_invocations: 4,
      model_turns_per_worker: 4,
      model_turns_per_run: 8,
      tool_calls_per_worker: 4,
      tool_calls_per_run: 8,
      external_calls_per_worker: 0,
      external_calls_per_run: 0,
      worker_wall_clock_ms: 120_000,
      run_wall_clock_ms: 240_000,
      malformed_results_per_state_branch: 2,
      identical_malformed_digest_limit: 2,
      protocol_errors_per_worker: 4,
      identical_protocol_digest_limit: 2,
      routing_repair: {
        max_invocations_per_state_branch: 1,
        model_turns_per_worker: 4,
        tool_calls_per_worker: 2,
        external_calls_per_worker: 0,
        worker_wall_clock_ms: 120_000,
      },
    }),
    thinking_policy: "agent_ssot",
  },
  worker: {
    kind: "catalog-agent",
    workflow_name: CORE_ONLY_PLAYBOOK_NAME,
    guidance: CORE_ONLY_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: new Map([
      [
        CORE_ONLY_STATE,
        {
          agent: CORE_ONLY_AGENT,
          result_schema_id: "penny.test.core-only-summary",
          result_schema_version: 1,
          schema: Type.Object(
            { complete: Type.Literal(true) },
            { additionalProperties: false }
          ),
        },
      ],
    ]),
  },
  completionReceiptPredicates: new Map(),
  construct: () => new CoreOnlyPlaybook(),
};
