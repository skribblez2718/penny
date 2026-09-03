import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { Type, type TSchema } from "typebox";

import type {
  ArtifactHostStore,
  ArtifactReader,
  ArtifactRevisionLookup,
} from "../artifact-store.js";
import type { ResearchContextOwnerV1 } from "../research-context.js";
import { canonicalJson, sha256, type Checkpointer } from "../checkpointer.js";
import type {
  FanAggregateCapabilityV1,
  StateAwareRepairCapabilityV1,
  RoutingRepairCapabilityV1,
  LivenessTerminalCapabilityV1,
  PlaybookCoreV1,
  CompletionReceiptPredicateV1,
  HostContinuationCapabilityV1,
  HostContinuationStepV1,
  PlaybookStepOutcomeV1,
} from "./playbook.js";
import { positiveIntegerConstraint, RunContext, type PendingBranch } from "../context.js";
import {
  RESEARCH_PORTS,
  productReceiptId,
  projectResearchSemanticDraft,
  researchSemanticDraftPromptContract,
  researchProductEnvelopeId,
  researchRequestSha256,
  validateCanonicalGroundedSynthesisBytes,
  validateDeterministicRenderRef,
  validateGroundedSynthesis,
  validateProductReceipt,
  validateResearchProductEnvelope,
  validateResearchProductGraph,
  validateResearchRequest,
  validateResearchSemanticDraft,
  validateSemanticCoreRef,
  type DeterministicRenderRefV1,
  type GroundedSynthesisV1,
  type ProductReceiptV1,
  type ResearchProductEnvelopeV1,
  type ResearchRequestV1,
  type SemanticCoreRefV1,
} from "../skill-contracts/research.js";
import { buildOutputArtifactMetadata } from "./artifact-metadata.js";
import {
  type ArtifactRef,
  type Confidence,
  type Directive,
  type InputArtifacts,
  type JsonValue,
  type EvaluationResultV2,
  type LivenessSnapshotV1,
  type LivenessTerminalReason,
  type OutputArtifactMetadata,
  type PhaseResult,
  type SkillContract,
  validateDirective,
} from "../contracts.js";

const MODES = new Set(["quick", "standard", "deep"]);
const DEFAULT_MODE = "standard";
const MAX_BRANCHES = 64;
const RENDERER_ID = "penny.research.compat-markdown.v1" as const;
const RENDER_NAMES = ["report", "sources", "readme"] as const;

export class ResearchHostInterruptionError extends Error {
  constructor(readonly faultPoint: string) {
    super(`simulated research host interruption at '${faultPoint}'`);
    this.name = "ResearchHostInterruptionError";
  }
}

const ClarificationFields = {
  needs_clarification: Type.Optional(Type.Boolean()),
  clarifying_questions: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 16,
    })
  ),
};

const PlanningSummarySchema = Type.Object(
  {
    plan_steps: Type.Array(Type.String({ maxLength: 32_768 }), {
      maxItems: MAX_BRANCHES,
    }),
    plan_complete: Type.Boolean(),
    mode: Type.Optional(Type.String({ pattern: "^(quick|standard|deep)$" })),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
const CritiqueSummarySchema = Type.Object(
  {
    verdict: Type.String({ pattern: "^(APPROVE|NEEDS_REVISION)$" }),
    issues: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 128 }),
    evidence: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 256 }),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
const ExploreSummarySchema = Type.Object(
  {
    explore_complete: Type.Boolean(),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
const SynthesisSummarySchema = Type.Object(
  {
    synthesis_complete: Type.Boolean(),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
const ValidationSummarySchema = Type.Object(
  {
    verdict: Type.String({ pattern: "^(PASS|FAIL)$" }),
    unsupported_claims: Type.Array(Type.String({ maxLength: 4_096 }), {
      maxItems: 128,
    }),
    evidence: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 256 }),
    evidence_needed: Type.Optional(
      Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 128 })
    ),
    ...ClarificationFields,
  },
  { additionalProperties: false }
);
export const AGENT_BY_STATE = {
  planning: "piper",
  critiquing_plan: "carren",
  researching: "echo",
  synthesizing: "synthia",
  critiquing_report: "carren",
  validating: "vera",
} as const;

type ResearchState = keyof typeof AGENT_BY_STATE;

/** Machine-readable documentation descriptor for the research flow diagram. */
export const RESEARCH_FLOW = {
  states: [
    "intake",
    ...Object.keys(AGENT_BY_STATE),
    "sealing_core",
    "rendering",
    "unknown",
    "awaiting_clarification",
    "complete",
    "incomplete",
    "cancelled",
    "error",
  ],
  edges: [
    ["intake", "planning"],
    ["intake", "researching"],
    ["planning", "critiquing_plan"],
    ["planning", "researching"],
    ["critiquing_plan", "planning"],
    ["critiquing_plan", "researching"],
    ["researching", "synthesizing"],
    ["synthesizing", "sealing_core"],
    ["sealing_core", "synthesizing"],
    ["sealing_core", "validating"],
    ["sealing_core", "incomplete"],
    ["validating", "researching"],
    ["validating", "synthesizing"],
    ["validating", "critiquing_report"],
    ["validating", "rendering"],
    ["validating", "incomplete"],
    ["critiquing_report", "synthesizing"],
    ["critiquing_report", "rendering"],
    ["critiquing_report", "incomplete"],
    ["rendering", "complete"],
    ["rendering", "incomplete"],
    ["researching", "unknown"],
    ["unknown", "awaiting_clarification"],
    ["awaiting_clarification", "planning"],
    ["awaiting_clarification", "researching"],
    ["awaiting_clarification", "synthesizing"],
  ],
} as const;

const SUMMARY_SCHEMA_BY_STATE: Record<ResearchState, TSchema> = {
  planning: PlanningSummarySchema,
  critiquing_plan: CritiqueSummarySchema,
  researching: ExploreSummarySchema,
  synthesizing: SynthesisSummarySchema,
  critiquing_report: CritiqueSummarySchema,
  validating: ValidationSummarySchema,
};

const INPUT_PHASES_BY_STATE: Record<ResearchState, readonly string[]> = {
  planning: ["planning", "critiquing_plan"],
  critiquing_plan: ["planning"],
  researching: ["planning", "critiquing_plan", "synthesizing", "validating"],
  synthesizing: ["researching", "synthesizing", "critiquing_report", "validating"],
  critiquing_report: ["researching", "synthesizing", "sealing_core", "validating"],
  validating: ["researching", "synthesizing", "sealing_core"],
};

function isResearchState(value: string): value is ResearchState {
  return Object.hasOwn(AGENT_BY_STATE, value);
}

function stringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanValue(value: JsonValue | undefined): boolean {
  return value === true;
}

function normalizedIssues(issues: readonly string[]): string[] {
  return [...new Set(issues.map((issue) => issue.trim()).filter(Boolean))].sort();
}

function sameIssues(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(normalizedIssues(left)) === JSON.stringify(normalizedIssues(right));
}

function modeBudget(mode: string): {
  critiquePasses: number;
  maxResearchRounds: number;
} {
  if (mode === "deep") {
    return { critiquePasses: 2, maxResearchRounds: 3 };
  }
  return { critiquePasses: 0, maxResearchRounds: 2 };
}

function boundedConstraint(
  context: RunContext,
  name: string,
  fallback: number,
  ceiling: number
): number {
  return Math.min(positiveIntegerConstraint(context.constraints[name], fallback), ceiling);
}

function reportDirectory(context: RunContext): string {
  const normalized = context.goal
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 71);
  const digest = sha256(context.goal.trim()).slice(0, 8);
  return path.join(
    context.projectRoot,
    "research",
    normalized.length > 0 ? `${normalized}-${digest}` : digest
  );
}

function semanticDraftInvocationContext(context: RunContext): string {
  const evidence = exactResearchEvidence(context);
  if (evidence.length === 0) {
    throw new Error("semantic drafting requires exact Echo evidence artifacts");
  }
  const slots = {
    schema_version: 1,
    evidence_artifacts: evidence.map((artifact, evidenceArtifactSlot) => ({
      evidence_artifact_slot: evidenceArtifactSlot,
      artifact_ref: artifact,
    })),
  };
  return [
    `MECHANICALLY_PROJECTED_RESEARCH_SEMANTIC_DRAFT_CONTRACT:${researchSemanticDraftPromptContract()}`,
    `OWNER_SELECTED_EVIDENCE_SLOTS:${canonicalJson(slots)}`,
  ].join("\n\n");
}

function taskForState(context: RunContext, state: ResearchState): string {
  const research = context.research;
  const clarification = context.clarificationText
    ? `\n\nUser clarification: ${context.clarificationText}`
    : "";
  const handoff =
    "\n\nRead every task-provided input_artifact through the artifact reader before working. " +
    "Treat those exact bytes as the sole prior-stage handoff. Return the complete stage output; " +
    "the execution owner captures it. Summary fields are routing data only.";
  let task: string;
  switch (state) {
    case "planning": {
      const modeLine = research.mode
        ? `Mode: ${research.mode}.`
        : "Mode is not fixed by the caller; declare quick, standard, or deep in the result.";
      task =
        `Research planning: decompose '${context.goal}' into focused sub-queries.\n${modeLine} ` +
        `Produce at most ${research.max_sub_queries} non-blank sub-queries.`;
      if (research.plan_revision > 0) {
        task += `\nRevision ${research.plan_revision}; address: ${research.plan_critique_issues.join("; ")}`;
      }
      break;
    }
    case "critiquing_plan":
      task = `Critique the exact research plan for '${context.goal}'. APPROVE or NEEDS_REVISION with evidence.`;
      break;
    case "researching":
      task = `Research '${context.goal}' thoroughly and return tiered, cited findings.`;
      break;
    case "synthesizing":
      task =
        `Synthesize the exact research artifacts for '${context.goal}' into one closed ResearchSemanticDraftV1 JSON value. ` +
        "Use only local zero-based indexes and owner-selected evidence slots; do not emit request/provenance fields, stable global IDs, artifact IDs, or hashes. " +
        'Return the draft JSON, one LF, then exactly SUMMARY:{"synthesis_complete":true,"confidence":"PROBABLE"}.\n\n' +
        semanticDraftInvocationContext(context);
      if (research.report_revision > 0) {
        task += `\n\nAddress critique issues: ${research.report_critique_issues.join("; ")}.`;
      }
      if (research.validation_revision > 0) {
        task += `\n\nRe-ground or remove unsupported claims: ${research.validation_issues.join("; ")}.`;
      }
      break;
    case "critiquing_report":
      task =
        `Critique the latest exact Vera-verified semantic core for '${context.goal}' for report quality, ` +
        "overclaiming, bias, fairness, and uncertainty. APPROVE only that exact core.";
      break;
    case "validating":
      task =
        `Verify every material claim in the latest exact sealed semantic core for '${context.goal}' is supported by a captured cited source. ` +
        "PASS only when all material claims and qualifications are grounded; otherwise FAIL and identify unsupported claims and researchable evidence gaps.";
      break;
  }
  return `${task}${handoff}${clarification}`;
}

function selectedInputRefs(
  context: RunContext,
  state: ResearchState,
  contextOwner?: ResearchContextOwnerV1
): ArtifactRef[] {
  const phases = new Set(INPUT_PHASES_BY_STATE[state]);
  // Entry states consume every cross-run exact input directly. Subsequent phases
  // inherit that information through accepted current-run outputs.
  if (state === "planning" || state === "researching") phases.add("chain_input");
  const entryState = state === "planning" || state === "researching";
  return context.selectedArtifacts
    .filter((artifact) =>
      artifact.kind === "context-source-ref"
        ? contextOwner?.acceptsState(artifact, state) === true
        : artifact.kind === "research-request"
          ? ["synthesizing", "validating", "critiquing_report"].includes(state)
          : phases.has(artifact.phase) ||
            (entryState && artifact.run_id !== context.identity.run_id)
    )
    .sort((left, right) =>
      `${left.phase}/${left.branch_id ?? ""}/${left.version}/${left.artifact_id}`.localeCompare(
        `${right.phase}/${right.branch_id ?? ""}/${right.version}/${right.artifact_id}`
      )
    );
}

function inputArtifacts(
  context: RunContext,
  _state: ResearchState,
  refs: readonly ArtifactRef[]
): InputArtifacts {
  return {
    schema_version: 2,
    artifacts: refs.map((ref, index) => ({
      slot: `upstream-${String(index).padStart(4, "0")}`,
      ref,
    })),
  };
}

function asResearchState(value: string): ResearchState {
  if (!isResearchState(value)) {
    throw new Error(`unknown research state '${value}' in pending directive`);
  }
  return value;
}

function outputArtifactMetadata(
  context: RunContext,
  state: ResearchState,
  agent: string,
  branchId: string | null,
  upstreamRefs: readonly ArtifactRef[],
  revisions?: ArtifactRevisionLookup
): OutputArtifactMetadata {
  // Shared with every other playbook: the revision-chain rule has one
  // implementation, not one per tenant.
  return buildOutputArtifactMetadata({
    context,
    phase: state,
    agent,
    branchId,
    upstreamRefs,
    ...(revisions ? { revisions } : {}),
  });
}

function directive<T>(value: T): Directive {
  return validateDirective(value);
}

function unresolvedIssues(context: RunContext): string[] {
  const research = context.research;
  return [
    ...(research.plan_critique_exhausted ? research.plan_critique_issues : []),
    ...(research.report_critique_exhausted ? research.report_critique_issues : []),
    ...(research.validation_exhausted ? research.validation_issues : []),
  ];
}

function latestPerOperationBranch(artifacts: readonly ArtifactRef[]): ArtifactRef[] {
  const latest = new Map<string, ArtifactRef>();
  for (const artifact of artifacts) {
    const key = `${artifact.operation_id}\u0000${artifact.branch_id ?? ""}`;
    const prior = latest.get(key);
    if (
      prior === undefined ||
      artifact.version > prior.version ||
      (artifact.version === prior.version &&
        artifact.artifact_id.localeCompare(prior.artifact_id) > 0)
    ) {
      latest.set(key, artifact);
    }
  }
  return [...latest.values()].sort((left, right) =>
    `${left.branch_id ?? ""}/${left.operation_id}/${left.artifact_id}`.localeCompare(
      `${right.branch_id ?? ""}/${right.operation_id}/${right.artifact_id}`
    )
  );
}

function bestResearchPartialRefs(context: RunContext): {
  semantic: ArtifactRef[];
  artifacts: ArtifactRef[];
  output: ArtifactRef | null;
} {
  const latestCore = [...context.selectedArtifacts]
    .filter((artifact) => artifact.kind === "semantic-core" && artifact.phase === "sealing_core")
    .sort((left, right) => right.version - left.version)[0];
  const precedence = ["synthesizing", "researching", "planning"] as const;
  const highest = precedence.find((phase) =>
    context.selectedArtifacts.some(
      (artifact) => artifact.kind === "agent-output" && artifact.phase === phase
    )
  );
  const semantic =
    latestCore !== undefined
      ? [latestCore]
      : highest === undefined
        ? []
        : latestPerOperationBranch(
            context.selectedArtifacts.filter(
              (artifact) => artifact.kind === "agent-output" && artifact.phase === highest
            )
          );
  const supportingPhases = new Set(["critiquing_plan", "critiquing_report", "validating"]);
  const supporting = latestPerOperationBranch(
    context.selectedArtifacts.filter(
      (artifact) => artifact.kind === "agent-output" && supportingPhases.has(artifact.phase)
    )
  );
  const semanticIds = new Set(semantic.map((artifact) => artifact.artifact_id));
  const artifacts = [
    ...semantic,
    ...supporting.filter((artifact) => !semanticIds.has(artifact.artifact_id)),
  ];
  return { semantic, artifacts, output: semantic.length === 1 ? (semantic[0] ?? null) : null };
}

export function researchSummarySchema(state: string): TSchema {
  if (!isResearchState(state)) {
    throw new Error(`unknown research state '${state}'`);
  }
  return SUMMARY_SCHEMA_BY_STATE[state];
}

/** P2 reference contract: typed ports, consequences, and named budget projections. */
export const RESEARCH_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: "research",
  release_status: "production",
  objective:
    "Investigate a question against external evidence and produce one grounded synthesis semantic core.",
  io: {
    request: RESEARCH_PORTS.request,
    input_ports: [RESEARCH_PORTS.prior_grounded_synthesis, RESEARCH_PORTS.legacy_context],
    active_output_ports: [RESEARCH_PORTS.grounded_synthesis],
  },
  behavior: {
    side_effects: {
      external_reads: "permitted_within_liveness_and_yaml",
      external_mutations: "forbidden",
      filesystem_writes: "compatibility_report_only",
      allowed_relative_paths: ["report.md", "sources.md", "README.md"],
    },
    approval: {
      policy: "caller_research_request",
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
    skill_root: ".pi/skills/research/assets/prompts",
    resolution: "per_agent_phase",
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.research-budget-policy.v1",
    resolver_id: "researchLivenessPolicy",
    admission_id: "LivenessController.admitInvocation",
    snapshot_id: "LivenessController.snapshot+phaseAttemptProjection",
  },
  repair_routing: {
    schema_version: 1,
    routes: [
      {
        schema_version: 1,
        origin_state: "validating",
        feedback_kind: "evidence_gap",
        repair: { action: "transition", target_state: "researching" },
        budget: {
          counter: "iteration",
          limit_source: "run.max_iterations",
          reserved_attempts: 1,
        },
        on_exhaustion: {
          action: "transition",
          target_state: "rendering",
          reset_counter: true,
        },
      },
      {
        schema_version: 1,
        origin_state: "validating",
        feedback_kind: "synthesis_gap",
        repair: { action: "transition", target_state: "synthesizing" },
        budget: {
          counter: "iteration",
          limit_source: "run.max_iterations",
          reserved_attempts: 1,
        },
        on_exhaustion: {
          action: "transition",
          target_state: "rendering",
          reset_counter: true,
        },
      },
      {
        schema_version: 1,
        origin_state: "critiquing_report",
        feedback_kind: "validation_gap",
        repair: { action: "transition", target_state: "synthesizing" },
        budget: {
          counter: "iteration",
          limit_source: "run.max_iterations",
          reserved_attempts: 1,
        },
        on_exhaustion: {
          action: "transition",
          target_state: "rendering",
          reset_counter: true,
        },
      },
    ],
  },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: ["rendering"],
    required_visited_states: [
      "researching",
      "synthesizing",
      "sealing_core",
      "validating",
      "rendering",
    ],
    required_receipt_predicates: ["research_latest_core_dod.v1"],
    latest_product: {
      selector: "terminal_artifact",
      schema_id: "penny.grounded-synthesis.v1",
      product_schema_version: 1,
      artifact_kind: "semantic-core",
      producing_state: "sealing_core",
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

const researchLatestCoreDod: CompletionReceiptPredicateV1 = (input) =>
  evaluateResearchLatestCoreDod(input);

export const RESEARCH_COMPLETION_RECEIPT_PREDICATES: ReadonlyMap<
  string,
  CompletionReceiptPredicateV1
> = new Map([["research_latest_core_dod.v1", researchLatestCoreDod]]);

/**
 * The reference playbook. `implements` is load-bearing: it makes the compiler prove that
 * the W1 extraction is faithful, so the interfaces cannot drift away from the one
 * implementation they were extracted from.
 */
export class ResearchPlaybook
  implements
    PlaybookCoreV1,
    FanAggregateCapabilityV1,
    RoutingRepairCapabilityV1,
    LivenessTerminalCapabilityV1,
    StateAwareRepairCapabilityV1,
    HostContinuationCapabilityV1
{
  constructor(
    private readonly revisions?: ArtifactRevisionLookup,
    private readonly contextOwner?: ResearchContextOwnerV1,
    private readonly artifactStore?: ArtifactHostStore,
    private readonly checkpointer?: Checkpointer,
    private readonly researchHostFault?: (point: string) => void
  ) {}

  /**
   * Returns the recoverable directive with its output-artifact spec re-bound to
   * the current ledger top, so a directive saved across a crash window (or
   * before a revision-chain change) is never replayed with a stale version.
   * Returns null when the context has no recoverable directive.
   */
  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending === null) {
      return null;
    }
    if (pending.action !== "invoke_agent" && pending.action !== "invoke_agents_parallel") {
      return pending;
    }
    if (pending.action === "invoke_agent") {
      if (pending.execution_purpose === "routing_repair") return pending;
      return validateDirective({
        ...pending,
        output_artifact: outputArtifactMetadata(
          context,
          asResearchState(pending.state_id),
          pending.agent,
          null,
          pending.output_artifact.upstream_refs,
          this.revisions
        ),
      });
    }
    return validateDirective({
      ...pending,
      branches: pending.branches.map((branch) => ({
        ...branch,
        output_artifact: outputArtifactMetadata(
          context,
          asResearchState(branch.state_id),
          branch.agent,
          branch.branch_id,
          branch.output_artifact.upstream_refs,
          this.revisions
        ),
      })),
    });
  }

  modelForState(
    context: RunContext,
    state: string,
    env: NodeJS.ProcessEnv = process.env
  ): string | undefined {
    if (state === "validating") {
      const explicit = String(context.constraints.validate_model ?? "").trim();
      if (explicit.length > 0) {
        return explicit;
      }
      const verifier = env.RESEARCH_VERA?.trim() || env.PENNY_RESEARCH_VERA_MODEL?.trim();
      if (verifier) {
        return verifier;
      }
    }
    const stateKey = `PENNY_RESEARCH_${state.toUpperCase()}_MODEL`;
    const stateModel = env[stateKey]?.trim();
    return (
      stateModel ||
      env.RESEARCH_DEFAULT?.trim() ||
      env.PENNY_RESEARCH_DEFAULT_MODEL?.trim() ||
      undefined
    );
  }

  initialize(context: RunContext): Directive {
    if (context.identity.playbook !== "research") {
      throw new Error(`ResearchPlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    const callerMode = String(context.constraints.mode ?? "");
    context.research.mode = MODES.has(callerMode) ? callerMode : "";
    context.research.max_sub_queries = Math.min(
      boundedConstraint(context, "max_sub_queries", 4, MAX_BRANCHES),
      boundedConstraint(context, "max_fan_width", 8, MAX_BRANCHES)
    );
    context.research.report_format = String(context.constraints.report_format ?? "default");
    this.applyBudget(context, context.research.mode || DEFAULT_MODE);
    context.transition(context.research.mode === "quick" ? "researching" : "planning");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    if (!isResearchState(context.stateId)) {
      throw new Error(`cannot dispatch research state '${context.stateId}'`);
    }
    const state = context.stateId;
    const attempt = context.stepCount;
    const refs = selectedInputRefs(context, state, this.contextOwner);
    const artifacts = inputArtifacts(context, state, refs);
    const modelOverride = this.modelForState(context, state);
    const branchTasks = state === "researching" ? this.researchBranchTasks(context) : [];
    let next: Directive;
    if (branchTasks.length > 0) {
      const branches = branchTasks.map((branch) => ({
        branch_id: branch.branchId,
        state_id: state,
        agent: "echo",
        attempt,
        trust_profile: context.trustProfile,
        ...(modelOverride ? { model_override: modelOverride } : {}),
        task: branch.task,
        input_artifacts: artifacts,
        output_artifact: outputArtifactMetadata(
          context,
          state,
          "echo",
          branch.branchId,
          refs,
          this.revisions
        ),
      }));
      next = directive({
        schema_version: 2,
        action: "invoke_agents_parallel",
        identity: context.identity,
        state_id: state,
        branches,
      });
      context.pendingBranches = branches.map(
        (branch): PendingBranch => ({
          branch_id: branch.branch_id,
          agent: branch.agent,
          attempt: branch.attempt,
          completed: false,
          confidence: null,
          result: null,
          artifact: null,
        })
      );
    } else {
      next = directive({
        schema_version: 2,
        action: "invoke_agent",
        identity: context.identity,
        state_id: state,
        agent: AGENT_BY_STATE[state],
        attempt,
        trust_profile: context.trustProfile,
        ...(modelOverride ? { model_override: modelOverride } : {}),
        task: taskForState(context, state),
        input_artifacts: artifacts,
        output_artifact: outputArtifactMetadata(
          context,
          state,
          AGENT_BY_STATE[state],
          null,
          refs,
          this.revisions
        ),
      });
      context.pendingBranches = [];
    }
    context.pendingDirective = next;
    context.status = "running";
    return next;
  }

  /**
   * W5 — classify why a result was inadequate.
   *
   * This encodes research's existing evidence-versus-synthesis rule exactly: unsupported
   * claims plus a remaining research round means the evidence is short (`evidence_gap`);
   * otherwise the evidence is adequate and the synthesis over it is not
   * (`synthesis_gap`).
   */
  evaluateRepair(
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): EvaluationResultV2 | null {
    if (details.verdict === "PASS" || details.verdict === "APPROVE") return null;
    if (state === "critiquing_report") {
      const findings = stringArray(details.issues).slice(0, 32);
      return {
        schema_version: 2,
        kind: "validation_gap",
        detail: `quality critique reported ${findings.length} issue(s)`,
        findings,
        strategy_delta:
          "Revise the typed semantic draft, seal a new core, then repeat Vera before quality critique.",
      };
    }
    if (state !== "validating") return null;
    const needed = stringArray(details.evidence_needed);
    const evidenceShort =
      needed.length > 0 && context.research.research_round < context.research.max_research_rounds;
    const findings = stringArray(details.unsupported_claims).slice(0, 32);
    return {
      schema_version: 2,
      kind: evidenceShort ? "evidence_gap" : "synthesis_gap",
      detail: evidenceShort
        ? `validation reported ${needed.length} evidence gap(s)`
        : "validation failed with no further evidence rounds available",
      findings,
      strategy_delta: evidenceShort
        ? "Gather the named missing evidence before re-synthesis."
        : "Re-synthesize from the captured evidence and remove or qualify unsupported claims.",
    };
  }

  repairBudgetUsed(context: RunContext, state: string, _evaluation: EvaluationResultV2): number {
    const events = this.checkpointer?.events(context.identity.run_id) ?? [];
    return events.filter((event) => {
      const raw = event.payload.feedback_route_evidence_v1;
      return (
        raw !== null &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        raw.origin_state === state &&
        raw.disposition === "repair"
      );
    }).length;
  }

  applyRepairBookkeeping(
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>,
    evaluation: EvaluationResultV2,
    disposition: "repair" | "exhausted"
  ): void {
    const research = context.research;
    if (state === "critiquing_report") {
      const issues = stringArray(details.issues);
      research.report_critique_issues = issues;
      if (disposition === "repair") {
        research.report_revision = context.iteration;
        return;
      }
      research.report_critique_exhausted = true;
      research.warnings.push(
        `report critique budget exhausted with unresolved issues: ${issues.join("; ") || "none listed"}`
      );
      research.report_revisions = context.iteration;
      research.report_revision = 0;
      return;
    }
    if (state !== "validating") {
      throw new Error(`research repair bookkeeping does not support state '${state}'`);
    }
    const issues = stringArray(details.unsupported_claims);
    const needed = stringArray(details.evidence_needed);
    research.validation_verdict = String(details.verdict);
    research.validation_issues = issues;
    if (disposition === "repair") {
      if (evaluation.kind === "evidence_gap") {
        research.research_round += 1;
        research.evidence_needed = needed.slice(0, research.max_sub_queries);
        research.validation_revision = 0;
      } else {
        research.validation_revision = context.iteration;
      }
      return;
    }
    research.validation_exhausted = true;
    research.warnings.push(
      `validation budget exhausted with unverified claims: ${issues.join("; ") || "none listed"}`
    );
    research.validation_revisions = context.iteration;
    research.validation_revision = 0;
  }

  aggregateBranches(
    branchDetails: readonly Record<string, JsonValue>[]
  ): Record<string, JsonValue> {
    const questions = branchDetails.flatMap((details) => stringArray(details.clarifying_questions));
    return {
      explore_complete: branchDetails.every((details) => booleanValue(details.explore_complete)),
      ...(branchDetails.some((details) => booleanValue(details.needs_clarification))
        ? { needs_clarification: true }
        : {}),
      ...(questions.length > 0 ? { clarifying_questions: questions } : {}),
    };
  }

  routingRepair(context: RunContext, malformed: PhaseResult): Directive {
    const pending = context.pendingDirective;
    const assignment =
      pending?.action === "invoke_agent"
        ? pending
        : pending?.action === "invoke_agents_parallel"
          ? pending.branches.find((branch) => branch.branch_id === (malformed.branch_id ?? ""))
          : undefined;
    if (
      assignment === undefined ||
      assignment.state_id !== malformed.state_id ||
      assignment.agent !== malformed.agent ||
      assignment.attempt !== malformed.attempt
    ) {
      throw new Error("routing_repair_binding_invalid");
    }
    if (context.stepCount >= context.maxSteps) {
      throw new Error(`run exceeded max_steps=${context.maxSteps}`);
    }
    const branchId = malformed.branch_id ?? null;
    const binding = {
      schema_version: 1 as const,
      source_state_id: malformed.state_id,
      source_branch_id: branchId,
      source_agent: malformed.agent,
      source_attempt: malformed.attempt,
      source_artifact_ref: malformed.output_artifact,
      source_receipt_id: malformed.worker_receipt.receipt_id,
      source_result_sha256: sha256(canonicalJson(malformed)),
    };
    context.previousState = context.stateId;
    context.stepCount += 1;
    context.status = "running";
    const repairOperationId = `routing-repair:${sha256(canonicalJson(binding))}`;
    const next = directive({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: malformed.state_id,
      agent: malformed.agent,
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      ...(assignment.model_override ? { model_override: assignment.model_override } : {}),
      execution_purpose: "routing_repair",
      routing_repair_binding: binding,
      task: "Repair routing metadata only. Read the one exact malformed source artifact, then follow the mechanically projected registered phase-summary contract. Emit no semantic body or prose.",
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "malformed-source", ref: malformed.output_artifact }],
      },
      output_artifact: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: malformed.state_id,
        branch_id: branchId,
        kind: "routing-metadata",
        operation_id: repairOperationId,
        version: 1,
        producer: `agent:${malformed.agent}`,
        media_type: "text/plain; charset=utf-8",
        parent_ref: null,
        upstream_refs: [malformed.output_artifact],
      },
    });
    context.pendingDirective = next;
    return next;
  }

  terminalizeLiveness(
    context: RunContext,
    reason: LivenessTerminalReason,
    snapshot: LivenessSnapshotV1
  ): Directive {
    return this.terminal(context, "incomplete", false, [reason], { reason, snapshot });
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    confidence: Confidence
  ): PlaybookStepOutcomeV1 {
    if (!isResearchState(context.stateId)) {
      throw new Error(`unexpected result for state '${context.stateId}'`);
    }
    const state = context.stateId;
    const summary = details;
    const clarificationReason = this.progressProblem(context, state, summary, confidence);
    if (clarificationReason !== null) {
      return this.awaitUser(context, clarificationReason, summary);
    }
    this.route(context, state, summary);
    if (context.terminalDirective !== null) {
      return context.terminalDirective;
    }
    return this.needsHostContinuation(context)
      ? { kind: "host_continuation" }
      : this.dispatch(context);
  }

  resume(context: RunContext, response: JsonValue): Directive {
    if (context.status !== "awaiting_user" || context.stateId !== "awaiting_clarification") {
      throw new Error("run is not awaiting user clarification");
    }
    const previous = context.previousState ?? "planning";
    const target =
      previous === "researching"
        ? "researching"
        : ["synthesizing", "critiquing_report", "validating"].includes(previous)
          ? "synthesizing"
          : "planning";
    context.iteration = 0;
    context.iterationHistory = [];
    context.research.plan_revision = 0;
    context.research.report_revision = 0;
    context.research.validation_revision = 0;
    context.clarificationText = typeof response === "string" ? response : JSON.stringify(response);
    context.transition(target);
    return this.dispatch(context);
  }

  cancel(context: RunContext, reason: string): Directive {
    return this.terminal(context, "cancelled", false, [reason]);
  }

  needsHostContinuation(context: RunContext): boolean {
    if (context.terminalDirective !== null) return false;
    return (
      context.stateId === "sealing_core" ||
      context.stateId === "rendering" ||
      (context.stateId === "critiquing_report" && context.pendingDirective === null)
    );
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context)) {
      throw new Error(`research state '${context.stateId}' has no deterministic host work`);
    }
    if (this.artifactStore === undefined || this.checkpointer === undefined) {
      const next = this.terminal(context, "incomplete", false, [
        "deterministic research host artifact/checkpoint capability is unavailable",
      ]);
      return {
        event_type: "research_host_unavailable",
        payload: { run_id: context.identity.run_id, state_id: context.previousState ?? "unknown" },
        directive: next,
      };
    }
    if (context.stateId === "sealing_core") {
      return this.continueCoreSealing(context, this.artifactStore, this.checkpointer);
    }
    if (context.stateId === "critiquing_report") {
      const grounding = ensureAgentProductReceipt({
        context,
        store: this.artifactStore,
        checkpointer: this.checkpointer,
        receiptKind: "grounding_verification",
      });
      if (grounding.added) {
        this.fault("validating:grounding-receipt-persistence");
        return {
          event_type: "research_grounding_receipt_persisted",
          payload: {
            run_id: context.identity.run_id,
            core_artifact_id: grounding.receipt.attested_core.artifact_ref.artifact_id,
            receipt_id: grounding.receipt.receipt_id,
            artifact_id: grounding.artifact.artifact_id,
          },
        };
      }
      const next = this.dispatch(context);
      return {
        event_type: "research_quality_review_dispatched",
        payload: {
          run_id: context.identity.run_id,
          core_artifact_id: grounding.receipt.attested_core.artifact_ref.artifact_id,
          next_action: next.action,
        },
        directive: next,
      };
    }
    return this.continueRendering(context, this.artifactStore, this.checkpointer);
  }

  hostCheckpointCommitted(_context: RunContext, faultPoint: string): void {
    this.fault(faultPoint);
  }

  private continueCoreSealing(
    context: RunContext,
    store: ArtifactHostStore,
    checkpointer: Checkpointer
  ): HostContinuationStepV1 {
    try {
      const sealed = sealLatestSemanticCore(context, store);
      if (sealed.added) this.fault("sealing_core:artifact-persistence");
      context.research.validation_verdict = "";
      context.research.validation_issues = [];
      context.transition("validating");
      const next = this.dispatch(context);
      return {
        event_type: "research_semantic_core_sealed",
        payload: {
          run_id: context.identity.run_id,
          core_artifact_id: sealed.artifact.artifact_id,
          core_sha256: sealed.artifact.content_digest,
          core_version: sealed.artifact.version,
          next_action: next.action,
        },
        directive: next,
      };
    } catch (error) {
      if (error instanceof ResearchHostInterruptionError) throw error;
      const detail = error instanceof Error ? error.message : "unknown semantic-core defect";
      const errorSha = sha256(detail);
      const failures = checkpointer
        .events(context.identity.run_id)
        .filter((event) => event.eventType === "research_semantic_core_rejected");
      const repeated = failures.some((event) => event.payload.error_sha256 === errorSha);
      const repairBudget = Math.max(0, context.maxIterations - 1);
      context.research.validation_issues = [detail.slice(0, 4_096)];
      if (repeated || failures.length >= repairBudget) {
        context.research.validation_exhausted = true;
        context.research.warnings.push(
          `semantic-core sealing exhausted: ${detail.slice(0, 1_024)}`
        );
        const next = this.terminal(context, "incomplete", false, [
          repeated
            ? "semantic-core sealing repeated the same deterministic defect"
            : "semantic-core sealing repair budget exhausted",
        ]);
        return {
          event_type: "research_semantic_core_rejected",
          payload: {
            run_id: context.identity.run_id,
            error_sha256: errorSha,
            disposition: "exhausted",
          },
          directive: next,
        };
      }
      context.research.validation_revision = failures.length + 1;
      context.transition("synthesizing");
      const next = this.dispatch(context);
      return {
        event_type: "research_semantic_core_rejected",
        payload: {
          run_id: context.identity.run_id,
          error_sha256: errorSha,
          disposition: "repair",
          next_action: next.action,
        },
        directive: next,
      };
    }
  }

  private continueRendering(
    context: RunContext,
    store: ArtifactHostStore,
    checkpointer: Checkpointer
  ): HostContinuationStepV1 {
    try {
      const renderCoreArtifact = latestSemanticCore(context);
      const renderCore = validateCanonicalGroundedSynthesisBytes(
        store.readById(renderCoreArtifact.artifact_id),
        renderCoreArtifact
      );
      const semanticBlockers = [
        ...renderCore.claims
          .filter((claim) => claim.support_status === "unsupported")
          .map((claim) => `unsupported claim ${claim.claim_id}`),
        ...renderCore.unresolved_gaps
          .filter((gap) => gap.blocking)
          .map((gap) => `blocking gap ${gap.gap_id}`),
        ...renderCore.irreducible_uncertainties
          .filter((uncertainty) => uncertainty.disposition === "blocking")
          .map((uncertainty) => `blocking uncertainty ${uncertainty.uncertainty_id}`),
        ...renderCore.contradictions
          .filter((contradiction) => contradiction.status === "unresolved")
          .map((contradiction) => `unresolved contradiction ${contradiction.contradiction_id}`),
      ];
      if (semanticBlockers.length > 0) {
        const next = this.terminal(context, "incomplete", false, semanticBlockers);
        return {
          event_type: "research_product_not_rendered",
          payload: {
            run_id: context.identity.run_id,
            reason: "blocking_semantic_core",
            blocker_count: semanticBlockers.length,
          },
          directive: next,
        };
      }
      if (
        context.research.validation_verdict !== "PASS" ||
        context.research.plan_critique_exhausted ||
        context.research.report_critique_exhausted ||
        context.research.validation_exhausted
      ) {
        const next = this.terminal(context, "incomplete", false, unresolvedIssues(context));
        return {
          event_type: "research_product_not_rendered",
          payload: {
            run_id: context.identity.run_id,
            reason: "required_review_or_budget_not_satisfied",
          },
          directive: next,
        };
      }
      const grounding = ensureAgentProductReceipt({
        context,
        store,
        checkpointer,
        receiptKind: "grounding_verification",
      });
      if (grounding.added) {
        this.fault("validating:grounding-receipt-persistence");
        return {
          event_type: "research_grounding_receipt_persisted",
          payload: {
            run_id: context.identity.run_id,
            receipt_id: grounding.receipt.receipt_id,
            artifact_id: grounding.artifact.artifact_id,
          },
        };
      }
      if (context.research.critique_passes >= 1) {
        const quality = ensureAgentProductReceipt({
          context,
          store,
          checkpointer,
          receiptKind: "quality_critique",
        });
        if (quality.added) {
          this.fault("critiquing_report:quality-receipt-persistence");
          return {
            event_type: "research_quality_receipt_persisted",
            payload: {
              run_id: context.identity.run_id,
              receipt_id: quality.receipt.receipt_id,
              artifact_id: quality.artifact.artifact_id,
            },
          };
        }
      }
      const intent = ensureRenderIntent(context, store);
      if (intent.added) {
        this.fault("rendering:intent-persistence");
        return {
          event_type: "research_render_intent_persisted",
          payload: {
            run_id: context.identity.run_id,
            core_artifact_id: intent.intent.semantic_core.artifact_ref.artifact_id,
            intent_artifact_id: intent.artifact.artifact_id,
            intent_sha256: intent.artifact.content_digest,
          },
        };
      }
      const renders = new Map<RenderName, DeterministicRenderRefV1>();
      for (const name of RENDER_NAMES) {
        const render = ensureRenderArtifact(context, store, intent, name);
        renders.set(name, render.render);
        if (render.added) {
          this.fault(`rendering:render-artifact-persistence:${name}`);
          return {
            event_type: "research_render_artifact_persisted",
            payload: {
              run_id: context.identity.run_id,
              core_artifact_id: intent.intent.semantic_core.artifact_ref.artifact_id,
              render_name: name,
              artifact_id: render.render.artifact_ref.artifact_id,
              content_sha256: render.render.content_sha256,
            },
          };
        }
      }
      const materialized = materializedRenderNames(
        checkpointer,
        context.identity.run_id,
        intent.intent.semantic_core.artifact_ref.artifact_id
      );
      for (const name of RENDER_NAMES) {
        if (materialized.has(name)) continue;
        materializeRenderTarget(context, intent.intent, name, (point) => this.fault(point));
        const render = renders.get(name);
        if (render === undefined) throw new Error(`render '${name}' disappeared`);
        return {
          event_type: "research_render_materialized",
          payload: {
            run_id: context.identity.run_id,
            core_artifact_id: intent.intent.semantic_core.artifact_ref.artifact_id,
            render_name: name,
            content_sha256: render.content_sha256,
          },
        };
      }
      const orderedRenders = RENDER_NAMES.map((name) => {
        const render = renders.get(name);
        if (render === undefined) throw new Error(`render '${name}' disappeared`);
        return render;
      });
      verifyRenderedFiles(context, intent.intent, orderedRenders);
      const deterministic = ensureDeterministicValidationReceipt({
        context,
        store,
        intent,
        renders: orderedRenders,
      });
      if (deterministic.added) {
        this.fault("rendering:validation-receipt-persistence");
        return {
          event_type: "research_deterministic_validation_persisted",
          payload: {
            run_id: context.identity.run_id,
            receipt_id: deterministic.receipt.receipt_id,
            artifact_id: deterministic.artifact.artifact_id,
          },
        };
      }
      const envelope = ensureResearchProductEnvelope({
        context,
        store,
        intent,
        renders: orderedRenders,
      });
      if (envelope.added) {
        this.fault("rendering:envelope-persistence");
        return {
          event_type: "research_product_envelope_persisted",
          payload: {
            run_id: context.identity.run_id,
            envelope_id: envelope.envelope.envelope_id,
            artifact_id: envelope.artifact.artifact_id,
          },
        };
      }
      verifyResearchProductGraphFromStore({
        context,
        store,
        envelopeArtifact: envelope.artifact,
      });
      verifyRenderedFiles(context, intent.intent, orderedRenders);
      context.research.report_written = true;
      context.research.report_dir = reportDirectory(context);
      context.research.report_files = ["report.md", "sources.md", "README.md"].map((file) =>
        path.join(context.research.report_dir, file)
      );
      const next = this.terminal(context, "complete", true, []);
      return {
        event_type: "research_product_completion_candidate",
        payload: {
          run_id: context.identity.run_id,
          core_artifact_id: intent.intent.semantic_core.artifact_ref.artifact_id,
          envelope_id: envelope.envelope.envelope_id,
          next_action: next.action,
        },
        directive: next,
        after_checkpoint_fault: "rendering:final-checkpoint-admission",
      };
    } catch (error) {
      if (error instanceof ResearchHostInterruptionError) throw error;
      const detail =
        error instanceof Error ? error.message : "unknown deterministic rendering fault";
      context.research.warnings.push(`deterministic rendering failed: ${detail.slice(0, 1_024)}`);
      const next = this.terminal(context, "incomplete", false, [
        `deterministic rendering failed: ${detail.slice(0, 4_096)}`,
      ]);
      return {
        event_type: "research_rendering_failed",
        payload: {
          run_id: context.identity.run_id,
          error_sha256: sha256(detail),
        },
        directive: next,
      };
    }
  }

  private fault(point: string): void {
    this.researchHostFault?.(point);
  }

  private applyBudget(context: RunContext, mode: string): void {
    const preset = modeBudget(mode);
    context.research.critique_passes = positiveIntegerOrZeroConstraint(
      context.constraints.critique_passes,
      preset.critiquePasses
    );
    context.research.max_research_rounds = Math.max(
      1,
      positiveIntegerOrZeroConstraint(
        context.constraints.max_research_rounds,
        preset.maxResearchRounds
      )
    );
  }

  private researchBranchTasks(context: RunContext): Array<{ branchId: string; task: string }> {
    const evidence = context.research.evidence_needed;
    const queries = evidence.length > 0 ? evidence : context.research.sub_queries;
    if (queries.length === 0) {
      return [];
    }
    const isEvidence = evidence.length > 0;
    const start = isEvidence ? context.research.echo_branches_dispatched + 1 : 1;
    const branches = queries.slice(0, context.research.max_sub_queries).map((query, index) => {
      const branchNumber = start + index;
      const prefix = isEvidence
        ? `EVIDENCE-SEEKING research for '${context.goal}'. Find a source that directly supports or refutes this gap, or report honestly that none was found. Gap:`
        : `Research this sub-query for '${context.goal}'. Sub-query:`;
      return {
        branchId: `sq${branchNumber}`,
        task: `${prefix} ${query}`,
      };
    });
    context.research.echo_branches_dispatched = Math.max(
      context.research.echo_branches_dispatched,
      start - 1 + branches.length
    );
    return branches;
  }

  private progressProblem(
    context: RunContext,
    state: ResearchState,
    summary: Record<string, JsonValue>,
    confidence: Confidence
  ): string | null {
    if (confidence === "UNCERTAIN") {
      return `${state} returned UNCERTAIN confidence`;
    }
    if (booleanValue(summary.needs_clarification)) {
      const questions = stringArray(summary.clarifying_questions);
      return `${state} requested clarification${questions.length ? `: ${questions.join("; ")}` : ""}`;
    }
    if (state === "planning" && !booleanValue(summary.plan_complete)) {
      return "planning could not produce a complete research plan";
    }
    if (state === "researching" && !booleanValue(summary.explore_complete)) {
      return "researching could not complete the assigned scope";
    }
    if (state === "synthesizing" && !booleanValue(summary.synthesis_complete)) {
      return "synthesis could not produce a complete report";
    }
    if (state === "critiquing_plan" || state === "critiquing_report") {
      const issues = stringArray(summary.issues);
      const previous = context.iterationHistory.at(-1) ?? null;
      if (summary.verdict !== "APPROVE" && previous !== null && sameIssues(previous, issues)) {
        return "the same critique issues persisted without measurable progress";
      }
    }
    if (state === "validating") {
      const issues = stringArray(summary.unsupported_claims);
      const previous = context.iterationHistory.at(-1) ?? null;
      if (summary.verdict !== "PASS" && previous !== null && sameIssues(previous, issues)) {
        return "the same validation issues persisted without measurable progress";
      }
    }
    return null;
  }

  private recordIteration(context: RunContext, issues: string[]): void {
    context.iterationHistory.push(normalizedIssues(issues));
  }

  private endPlanLoop(context: RunContext): void {
    context.research.plan_revisions = context.iteration;
    context.research.plan_revision = 0;
    context.iteration = 0;
    context.iterationHistory = [];
  }

  private route(
    context: RunContext,
    state: ResearchState,
    summary: Record<string, JsonValue>
  ): void {
    const research = context.research;
    switch (state) {
      case "planning": {
        if (!research.mode) {
          const declared = String(summary.mode ?? "");
          research.mode = MODES.has(declared) ? declared : DEFAULT_MODE;
          this.applyBudget(context, research.mode);
        }
        const steps = stringArray(summary.plan_steps).slice(0, research.max_sub_queries);
        research.sub_queries = steps;
        context.transition(research.critique_passes >= 2 ? "critiquing_plan" : "researching");
        return;
      }
      case "critiquing_plan": {
        const issues = stringArray(summary.issues);
        research.plan_critique_issues = issues;
        if (summary.verdict === "APPROVE") {
          this.endPlanLoop(context);
          context.transition("researching");
        } else if (context.iteration + 1 < context.maxIterations) {
          this.recordIteration(context, issues);
          context.iteration += 1;
          research.plan_revision = context.iteration;
          context.transition("planning");
        } else {
          research.plan_critique_exhausted = true;
          research.warnings.push(
            `plan critique budget exhausted with unresolved issues: ${issues.join("; ") || "none listed"}`
          );
          this.endPlanLoop(context);
          context.transition("researching");
        }
        return;
      }
      case "researching":
        research.evidence_needed = [];
        context.transition("synthesizing");
        return;
      case "synthesizing":
        context.transition("sealing_core");
        return;
      case "critiquing_report": {
        const issues = stringArray(summary.issues);
        research.report_critique_issues = issues;
        if (summary.verdict !== "APPROVE") {
          throw new Error("quality gap reached playbook routing without engine-owned repair");
        }
        research.report_revisions = this.repairBudgetUsed(context, "critiquing_report", {
          schema_version: 2,
          kind: "validation_gap",
          detail: "approved",
          findings: [],
          strategy_delta: "approved",
        });
        research.report_revision = 0;
        context.iteration = 0;
        context.iterationHistory = [];
        context.transition("rendering");
        return;
      }
      case "validating": {
        const issues = stringArray(summary.unsupported_claims);
        research.validation_verdict = String(summary.verdict);
        research.validation_issues = issues;
        if (summary.verdict === "PASS") {
          research.validation_revisions = this.repairBudgetUsed(context, "validating", {
            schema_version: 2,
            kind: "synthesis_gap",
            detail: "passed",
            findings: [],
            strategy_delta: "passed",
          });
          research.validation_revision = 0;
          context.iteration = 0;
          context.iterationHistory = [];
          context.transition(research.critique_passes >= 1 ? "critiquing_report" : "rendering");
        } else {
          throw new Error("validation gap reached playbook routing without engine-owned repair");
        }
        return;
      }
    }
  }

  private awaitUser(
    context: RunContext,
    reason: string,
    summary: Record<string, JsonValue>
  ): Directive {
    const questions = stringArray(summary.clarifying_questions);
    const prompts =
      questions.length > 0 ? questions : [`${reason}. What clarification should the run use?`];
    const state = context.stateId;
    context.transition("awaiting_clarification");
    context.status = "awaiting_user";
    const gateId = randomUUID();
    const challenge = randomUUID();
    const payloadDigest = sha256(JSON.stringify({ reason, prompts, state }));
    const next = directive({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: "awaiting_clarification",
      gate_id: gateId,
      challenge,
      payload_digest: payloadDigest,
      questions: prompts.map((prompt, index) => ({
        id: `clarification-${index + 1}`,
        prompt,
      })),
    });
    context.pendingDirective = next;
    return next;
  }

  private terminal(
    context: RunContext,
    status: "complete" | "incomplete" | "cancelled",
    met: boolean,
    unresolved: string[],
    liveness?: { reason: LivenessTerminalReason; snapshot: LivenessSnapshotV1 }
  ): Directive {
    context.previousState = context.stateId;
    context.stateId = status === "cancelled" ? "cancelled" : "complete";
    context.status = status;
    context.met = met;
    context.pendingBranches = [];
    const research = context.research;
    const partials = bestResearchPartialRefs(context);
    const positiveProduct = met
      ? positiveProductArtifactRefs(context, this.artifactStore)
      : undefined;
    if (met && positiveProduct === undefined) {
      throw new Error("positive research terminal lacks the complete latest-core product graph");
    }
    const outputArtifact = positiveProduct?.core ?? partials.output;
    const terminalArtifacts = positiveProduct?.artifacts ?? partials.artifacts;
    const next = directive({
      schema_version: 2,
      action: status,
      identity: context.identity,
      status,
      met,
      result: {
        met,
        research_rounds: research.research_round,
        critique_passes: research.critique_passes,
        grounded: met && research.validation_verdict === "PASS",
        iterations:
          research.plan_revisions + research.report_revisions + research.validation_revisions,
        query_sha256: sha256(context.goal),
        query_bytes: Buffer.byteLength(context.goal, "utf8"),
        mode: research.mode,
        sub_queries: research.sub_queries,
        output_artifact_ref: outputArtifact,
        ...(!met ? { best_partial_artifact_refs: partials.semantic } : {}),
        ...(met
          ? {
              qualified: qualifiedResearchCore(positiveProduct?.coreValue),
              product_envelope_ref: positiveProduct?.envelope,
              report_dir: research.report_dir,
              report_files: research.report_files,
            }
          : {}),
        ...(liveness ? { liveness: liveness.snapshot, terminal_reason: liveness.reason } : {}),
        warnings: research.warnings,
        plan_critique_exhausted: research.plan_critique_exhausted,
        report_critique_exhausted: research.report_critique_exhausted,
        validation_exhausted: research.validation_exhausted,
        unresolved_issues: unresolved,
      },
      artifacts: terminalArtifacts,
      unresolved,
    });
    if ((next.action === "complete") !== met) {
      throw new Error("terminal truth invariant violated");
    }
    context.pendingDirective = next;
    context.terminalDirective = next;
    return next;
  }
}

type RenderName = (typeof RENDER_NAMES)[number];

interface RenderTargetIntentV1 {
  readonly render_name: RenderName;
  readonly target_relative_path: "report.md" | "sources.md" | "README.md";
  readonly content: string;
  readonly content_sha256: string;
  readonly byte_length: number;
}

interface ResearchRenderIntentV1 {
  readonly schema_version: 1;
  readonly renderer_id: typeof RENDERER_ID;
  readonly operation_identity: string;
  readonly receipt_time: string;
  readonly target_directory: string;
  readonly semantic_core: SemanticCoreRefV1;
  readonly targets: readonly RenderTargetIntentV1[];
}

interface PersistedHostArtifact {
  readonly artifact: ArtifactRef;
  readonly added: boolean;
}

interface PersistedReceipt extends PersistedHostArtifact {
  readonly receipt: ProductReceiptV1;
}

interface PersistedIntent extends PersistedHostArtifact {
  readonly intent: ResearchRenderIntentV1;
}

interface PersistedRender extends PersistedHostArtifact {
  readonly render: DeterministicRenderRefV1;
}

interface PersistedEnvelope extends PersistedHostArtifact {
  readonly envelope: ResearchProductEnvelopeV1;
}

function renderPath(name: RenderName): RenderTargetIntentV1["target_relative_path"] {
  if (name === "report") return "report.md";
  if (name === "sources") return "sources.md";
  return "README.md";
}

function finalMarkdown(lines: readonly string[]): string {
  return `${lines.join("\n").normalize("NFC").replace(/\n+$/u, "")}\n`;
}

function inlineIds(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}

function posture(core: GroundedSynthesisV1): "Complete" | "Qualified complete" {
  return core.claims.some((claim) => claim.support_status === "qualified") ||
    core.contradictions.some((item) => item.status === "qualified") ||
    core.unresolved_gaps.length > 0 ||
    core.irreducible_uncertainties.length > 0
    ? "Qualified complete"
    : "Complete";
}

export function renderResearchCompatibility(input: {
  readonly core: GroundedSynthesisV1;
  readonly semanticCore: SemanticCoreRefV1;
}): Readonly<Record<RenderName, string>> {
  const core = validateGroundedSynthesis(input.core);
  const semanticCore = validateSemanticCoreRef(input.semanticCore);
  if (semanticCore.sha256 !== sha256(canonicalJson(core))) {
    throw new Error("renderer semantic-core digest mismatch");
  }
  const report: string[] = [`# ${core.title}`, "", core.executive_summary, "", "## Narrative"];
  for (const section of core.narrative.sections) {
    report.push(
      "",
      `### ${section.heading} (\`${section.section_id}\`)`,
      "",
      section.body,
      "",
      `**Claims:** ${inlineIds(section.claim_ids)}`,
      "",
      `**Evidence:** ${inlineIds(section.evidence_ids)}`
    );
  }
  report.push("", "## Qualifications", "");
  const qualifications = core.claims.flatMap((claim) =>
    claim.qualifications.map((qualification) => `- \`${claim.claim_id}\`: ${qualification}`)
  );
  report.push(...(qualifications.length === 0 ? ["- None."] : qualifications));
  report.push("", "## Contradictions", "");
  report.push(
    ...(core.contradictions.length === 0
      ? ["- None."]
      : core.contradictions.map(
          (item) =>
            `- \`${item.contradiction_id}\` (\`${item.status}\`) — claims: ${inlineIds(item.claim_ids)}; evidence: ${inlineIds(item.evidence_ids)}.`
        ))
  );
  report.push("", "## Unresolved gaps", "");
  report.push(
    ...(core.unresolved_gaps.length === 0
      ? ["- None."]
      : core.unresolved_gaps.map(
          (gap) =>
            `- \`${gap.gap_id}\` (\`${gap.gap_kind}\`, ${gap.blocking ? "blocking" : "non-blocking"}) — ${gap.statement} Affected claims: ${inlineIds(gap.affected_claim_ids)}.`
        ))
  );
  report.push("", "## Irreducible uncertainty", "");
  report.push(
    ...(core.irreducible_uncertainties.length === 0
      ? ["- None."]
      : core.irreducible_uncertainties.map(
          (uncertainty) =>
            `- \`${uncertainty.uncertainty_id}\` (\`${uncertainty.disposition}\`) — ${uncertainty.statement} Affected claims: ${inlineIds(uncertainty.affected_claim_ids)}.`
        ))
  );

  const sources: string[] = ["# Sources"];
  for (const source of [...core.sources].sort((left, right) =>
    left.source_id.localeCompare(right.source_id)
  )) {
    sources.push(
      "",
      `## \`${source.source_id}\``,
      "",
      `- Kind: \`${source.source_kind}\``,
      `- Role: \`${source.role}\``,
      `- Tier: ${source.tier}`,
      `- Title: ${source.title}`,
      `- Locator: ${source.locator}`,
      ...(source.published_at === undefined ? [] : [`- Published at: \`${source.published_at}\``]),
      ...(source.observed_at === undefined ? [] : [`- Observed at: \`${source.observed_at}\``])
    );
  }
  sources.push("", "# Evidence");
  for (const evidence of [...core.evidence].sort((left, right) =>
    left.evidence_id.localeCompare(right.evidence_id)
  )) {
    sources.push(
      "",
      `## \`${evidence.evidence_id}\``,
      "",
      `- Relation: \`${evidence.relation}\``,
      `- Source: \`${evidence.source_id}\``,
      `- Locator: ${evidence.locator}`,
      `- Excerpt SHA-256: \`${evidence.excerpt_sha256}\``,
      `- Evidence artifact ID: \`${evidence.evidence_artifact_id}\``
    );
  }

  const include = core.request.scope.include.join("; ") || "None.";
  const exclude = core.request.scope.exclude.join("; ") || "None.";
  const readme = [
    `# ${core.title}`,
    "",
    core.executive_summary,
    "",
    "## Research question",
    "",
    core.request.normalized_question,
    "",
    "## Scope",
    "",
    `- Include: ${include}`,
    `- Exclude: ${exclude}`,
    "",
    "## Completion posture",
    "",
    posture(core),
    "",
    "## Semantic core",
    "",
    `- Schema: \`${semanticCore.schema_id}\` version ${semanticCore.product_schema_version}`,
    `- Artifact ID: \`${semanticCore.artifact_ref.artifact_id}\``,
    `- SHA-256: \`${semanticCore.sha256}\``,
    "",
    "## Files",
    "",
    "- `report.md` — grounded narrative and qualifications",
    "- `sources.md` — ordered source and evidence index",
    "- `README.md` — product summary and semantic-core binding",
  ];
  return {
    report: finalMarkdown(report),
    sources: finalMarkdown(sources),
    readme: finalMarkdown(readme),
  };
}

function hostOperationId(context: RunContext, label: string): string {
  return `research-${label}:${sha256(context.identity.run_id).slice(0, 32)}`;
}

function selectedLatest(
  context: RunContext,
  predicate: (artifact: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts]
    .filter(predicate)
    .sort((left, right) => right.version - left.version)[0];
}

function addSelectedArtifact(context: RunContext, artifact: ArtifactRef): boolean {
  const existing = context.selectedArtifacts.find(
    (candidate) => candidate.artifact_id === artifact.artifact_id
  );
  if (existing !== undefined) {
    if (canonicalJson(existing) !== canonicalJson(artifact)) {
      throw new Error(`artifact '${artifact.artifact_id}' has conflicting selected metadata`);
    }
    return false;
  }
  context.selectedArtifacts.push(structuredClone(artifact));
  return true;
}

function persistVersionedHostArtifact(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly phase: "sealing_core" | "validating" | "critiquing_report" | "rendering";
  readonly branchId: string | null;
  readonly kind: string;
  readonly operationLabel: string;
  readonly producer: string;
  readonly mediaType: string;
  readonly contentSchema?: { readonly schema_id: string; readonly schema_version: 1 };
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly content: string | Uint8Array;
}): PersistedHostArtifact {
  const operationId = hostOperationId(input.context, input.operationLabel);
  const bytes =
    typeof input.content === "string"
      ? Buffer.from(input.content, "utf8")
      : Buffer.from(input.content);
  const digest = sha256(bytes);
  const matching = selectedLatest(
    input.context,
    (artifact) =>
      artifact.phase === input.phase &&
      artifact.branch_id === input.branchId &&
      artifact.kind === input.kind &&
      artifact.operation_id === operationId &&
      artifact.content_digest === digest
  );
  if (matching !== undefined) {
    if (!input.store.readById(matching.artifact_id).equals(bytes)) {
      throw new Error(`selected host artifact '${matching.artifact_id}' failed exact re-read`);
    }
    input.store.select(matching);
    return { artifact: matching, added: false };
  }
  const parent = selectedLatest(
    input.context,
    (artifact) =>
      artifact.phase === input.phase &&
      artifact.branch_id === input.branchId &&
      artifact.kind === input.kind &&
      artifact.operation_id === operationId
  );
  const version = (parent?.version ?? 0) + 1;
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: input.phase,
    branch_id: input.branchId,
    kind: input.kind,
    operation_id: operationId,
    version,
    producer: input.producer,
    media_type: input.mediaType,
    ...(input.contentSchema === undefined ? {} : { content_schema: input.contentSchema }),
    parent_ref: parent ?? null,
    upstream_refs: [...input.upstreamRefs],
  };
  const storedVersion = input.store.lastVersion(
    input.context.identity.run_id,
    input.phase,
    input.branchId,
    input.kind,
    operationId
  );
  if (storedVersion > version) {
    throw new Error(`host artifact '${operationId}' ledger advanced concurrently`);
  }
  const orphan = input.store.refFor(
    input.context.identity.run_id,
    input.phase,
    input.branchId,
    input.kind,
    operationId,
    version
  );
  const artifact = orphan === null ? input.store.persist({ metadata, content: bytes }) : orphan;
  if (
    canonicalJson(input.store.metadata(artifact)) !== canonicalJson(metadata) ||
    !input.store.readById(artifact.artifact_id).equals(bytes)
  ) {
    throw new Error(`host artifact '${operationId}' diverged at version ${version}`);
  }
  input.store.select(artifact);
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined || canonicalJson(reread) !== canonicalJson(artifact)) {
    throw new Error(`host artifact '${artifact.artifact_id}' failed manifest re-read`);
  }
  return { artifact: reread, added: addSelectedArtifact(input.context, reread) };
}

function latestSemanticCore(context: RunContext): ArtifactRef {
  const core = selectedLatest(
    context,
    (artifact) => artifact.kind === "semantic-core" && artifact.phase === "sealing_core"
  );
  if (core === undefined) throw new Error("latest semantic core is absent");
  return core;
}

function semanticCoreRef(artifact: ArtifactRef): SemanticCoreRefV1 {
  return validateSemanticCoreRef({
    schema_version: 1,
    schema_id: "penny.grounded-synthesis.v1",
    product_schema_version: 1,
    artifact_ref: artifact,
    sha256: artifact.content_digest,
  });
}

function exactResearchEvidence(context: RunContext): ArtifactRef[] {
  return latestPerOperationBranch(
    context.selectedArtifacts.filter(
      (artifact) => artifact.kind === "agent-output" && artifact.phase === "researching"
    )
  );
}

function exactContextTrace(context: RunContext): string {
  const refs = context.selectedArtifacts
    .filter((artifact) => artifact.kind === "context-source-ref")
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  return sha256(canonicalJson(refs));
}

function admittedResearchRequestArtifact(context: RunContext): ArtifactRef {
  const artifact = selectedLatest(
    context,
    (candidate) => candidate.kind === "research-request" && candidate.phase === "intake"
  );
  if (artifact === undefined) throw new Error("admitted ResearchRequestV1 artifact is absent");
  return artifact;
}

function canonicalResearchRequest(
  store: ArtifactHostStore,
  context: RunContext
): ResearchRequestV1 {
  const artifact = admittedResearchRequestArtifact(context);
  const bytes = store.readById(artifact.artifact_id);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("admitted ResearchRequestV1 artifact is not JSON");
  }
  const request = validateResearchRequest(value);
  if (canonicalJson(request) !== bytes.toString("utf8")) {
    throw new Error("admitted ResearchRequestV1 bytes are not canonical");
  }
  return request;
}

function extractSemanticDraft(bytes: Buffer) {
  const text = bytes.toString("utf8");
  const marker = "\nSUMMARY:";
  const index = text.lastIndexOf(marker);
  if (index <= 0 || text.indexOf(marker) !== index) {
    throw new Error("Synthia output must contain one final SUMMARY after the semantic draft JSON");
  }
  const candidate = Buffer.from(text.slice(0, index), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(candidate.toString("utf8"));
  } catch {
    throw new Error("Synthia semantic draft is not JSON");
  }
  return validateResearchSemanticDraft(value, candidate.length);
}

function exactContextRefs(context: RunContext): ArtifactRef[] {
  return context.selectedArtifacts
    .filter((artifact) => artifact.kind === "context-source-ref")
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function sealLatestSemanticCore(
  context: RunContext,
  store: ArtifactHostStore
): { readonly core: GroundedSynthesisV1; readonly artifact: ArtifactRef; readonly added: boolean } {
  const synthesis = selectedLatest(
    context,
    (artifact) => artifact.kind === "agent-output" && artifact.phase === "synthesizing"
  );
  if (synthesis === undefined) {
    throw new Error("Synthia semantic draft artifact is absent");
  }
  const draft = extractSemanticDraft(store.readById(synthesis.artifact_id));
  const requestArtifact = admittedResearchRequestArtifact(context);
  const request = canonicalResearchRequest(store, context);
  const evidence = exactResearchEvidence(context);
  const contextRefs = exactContextRefs(context);
  const synthesisUpstreams = new Set(
    store.metadata(synthesis).upstream_refs.map((artifact) => artifact.artifact_id)
  );
  const requiredUpstreams = [requestArtifact, ...contextRefs, ...evidence];
  if (requiredUpstreams.some((artifact) => !synthesisUpstreams.has(artifact.artifact_id))) {
    throw new Error("Synthia semantic draft lineage omits admitted request, context, or evidence");
  }
  const core = projectResearchSemanticDraft({
    draft,
    request,
    contextTraceSha256: exactContextTrace(context),
    evidenceArtifacts: evidence,
    synthesisSourceArtifact: synthesis,
    readEvidenceArtifact: (artifact) => store.readById(artifact.artifact_id),
  });
  const persisted = persistVersionedHostArtifact({
    context,
    store,
    phase: "sealing_core",
    branchId: null,
    kind: "semantic-core",
    operationLabel: "semantic-core",
    producer: "host:core-sealer",
    mediaType: "application/json",
    contentSchema: { schema_id: "penny.grounded-synthesis.v1", schema_version: 1 },
    upstreamRefs: [requestArtifact, ...contextRefs, synthesis, ...evidence],
    content: canonicalJson(core),
  });
  validateCanonicalGroundedSynthesisBytes(
    store.readById(persisted.artifact.artifact_id),
    persisted.artifact
  );
  return { core, ...persisted };
}

function eventString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function latestReviewEvidence(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Checkpointer;
  readonly state: "validating" | "critiquing_report";
  readonly verdict: "PASS" | "APPROVE";
}): {
  readonly createdAt: string;
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly executionReceiptIds: readonly string[];
} {
  const core = latestSemanticCore(input.context);
  for (const event of [...input.checkpointer.events(input.context.identity.run_id)].reverse()) {
    const state = eventString(event.payload.state_id);
    if (state !== input.state) continue;
    if (event.eventType === "phase_result_accepted") {
      const receiptId = eventString(event.payload.receipt_id);
      const result =
        receiptId === undefined ? undefined : input.checkpointer.receiptResultById(receiptId);
      if (
        result === undefined ||
        result.details.verdict !== input.verdict ||
        !input.store
          .metadata(result.output_artifact)
          .upstream_refs.some((artifact) => artifact.artifact_id === core.artifact_id)
      ) {
        continue;
      }
      return {
        createdAt: result.worker_receipt.ended_at,
        evidenceRefs: [result.output_artifact],
        executionReceiptIds: [result.worker_receipt.receipt_id],
      };
    }
    if (event.eventType === "routing_repair_accepted") {
      const sourceId = eventString(event.payload.source_receipt_id);
      const repairId = eventString(event.payload.repair_receipt_id);
      const source =
        sourceId === undefined ? undefined : input.checkpointer.receiptResultById(sourceId);
      const repair =
        repairId === undefined ? undefined : input.checkpointer.receiptResultById(repairId);
      if (
        source === undefined ||
        repair === undefined ||
        repair.details.verdict !== input.verdict ||
        !input.store
          .metadata(source.output_artifact)
          .upstream_refs.some((artifact) => artifact.artifact_id === core.artifact_id)
      ) {
        continue;
      }
      return {
        createdAt: repair.worker_receipt.ended_at,
        evidenceRefs: [source.output_artifact, repair.output_artifact],
        executionReceiptIds: [source.worker_receipt.receipt_id, repair.worker_receipt.receipt_id],
      };
    }
  }
  throw new Error(`latest-core ${input.state} PASS receipt evidence is absent`);
}

function readProductReceipt(
  store: Pick<ArtifactReader, "readById">,
  artifact: ArtifactRef
): ProductReceiptV1 {
  const bytes = store.readById(artifact.artifact_id);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`product receipt artifact '${artifact.artifact_id}' is not JSON`);
  }
  const receipt = validateProductReceipt(value);
  if (canonicalJson(receipt) !== bytes.toString("utf8")) {
    throw new Error(`product receipt artifact '${artifact.artifact_id}' is not canonical`);
  }
  return receipt;
}

function receiptBranch(
  kind: ProductReceiptV1["receipt_kind"]
): "grounding" | "quality" | "deterministic" {
  if (kind === "grounding_verification") return "grounding";
  if (kind === "quality_critique") return "quality";
  return "deterministic";
}

function latestReceiptForCore(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly kind: ProductReceiptV1["receipt_kind"];
  readonly core: ArtifactRef;
}): { readonly artifact: ArtifactRef; readonly receipt: ProductReceiptV1 } | undefined {
  const artifact = selectedLatest(
    input.context,
    (candidate) =>
      candidate.kind === "product-receipt" &&
      candidate.branch_id === receiptBranch(input.kind) &&
      candidate.phase ===
        (input.kind === "grounding_verification"
          ? "validating"
          : input.kind === "quality_critique"
            ? "critiquing_report"
            : "rendering")
  );
  if (artifact === undefined) return undefined;
  const receipt = readProductReceipt(input.store, artifact);
  return receipt.receipt_kind === input.kind &&
    receipt.attested_core.artifact_ref.artifact_id === input.core.artifact_id &&
    receipt.attested_core.sha256 === input.core.content_digest
    ? { artifact, receipt }
    : undefined;
}

function ensureAgentProductReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Checkpointer;
  readonly receiptKind: "grounding_verification" | "quality_critique";
}): PersistedReceipt {
  const core = latestSemanticCore(input.context);
  const existing = latestReceiptForCore({
    context: input.context,
    store: input.store,
    kind: input.receiptKind,
    core,
  });
  if (existing !== undefined) return { ...existing, added: false };
  const state = input.receiptKind === "grounding_verification" ? "validating" : "critiquing_report";
  const review = latestReviewEvidence({
    context: input.context,
    store: input.store,
    checkpointer: input.checkpointer,
    state,
    verdict: input.receiptKind === "grounding_verification" ? "PASS" : "APPROVE",
  });
  const body: Omit<ProductReceiptV1, "receipt_id"> = {
    schema_id: "penny.product-receipt.v1",
    schema_version: 1,
    receipt_kind: input.receiptKind,
    producer: input.receiptKind === "grounding_verification" ? "agent:vera" : "agent:carren",
    attested_core: semanticCoreRef(core),
    verdict: "PASS",
    findings: [
      input.receiptKind === "grounding_verification"
        ? "Latest semantic core passed grounding verification."
        : "Latest semantic core passed report-quality critique.",
    ],
    evidence_refs: [...review.evidenceRefs],
    created_at: review.createdAt,
  };
  const receipt = validateProductReceipt({ ...body, receipt_id: productReceiptId(body) });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: state,
    branchId: receiptBranch(input.receiptKind),
    kind: "product-receipt",
    operationLabel: `product-receipt-${receiptBranch(input.receiptKind)}`,
    producer: receipt.producer,
    mediaType: "application/json",
    contentSchema: { schema_id: "penny.product-receipt.v1", schema_version: 1 },
    upstreamRefs: [core, ...review.evidenceRefs],
    content: canonicalJson(receipt),
  });
  const reread = readProductReceipt(input.store, persisted.artifact);
  if (canonicalJson(reread) !== canonicalJson(receipt)) {
    throw new Error(`product receipt '${receipt.receipt_id}' failed manifest re-read`);
  }
  return { ...persisted, receipt: reread };
}

function relativeReportDirectory(context: RunContext): string {
  const relative = path.relative(context.projectRoot, reportDirectory(context));
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("research compatibility directory escapes the project root");
  }
  return relative;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function parseRenderIntent(bytes: Buffer): ResearchRenderIntentV1 {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("render intent is not JSON");
  }
  if (!isUnknownRecord(value)) throw new Error("render intent is not an object");
  const schemaVersion = value["schema_version"];
  const rendererId = value["renderer_id"];
  const operationIdentity = value["operation_identity"];
  const receiptTime = value["receipt_time"];
  const targetDirectory = value["target_directory"];
  const rawTargets = value["targets"];
  const semanticCore = validateSemanticCoreRef(value["semantic_core"]);
  if (
    schemaVersion !== 1 ||
    rendererId !== RENDERER_ID ||
    typeof operationIdentity !== "string" ||
    typeof receiptTime !== "string" ||
    !receiptTime.endsWith("Z") ||
    !Number.isFinite(Date.parse(receiptTime)) ||
    typeof targetDirectory !== "string" ||
    !isUnknownArray(rawTargets) ||
    rawTargets.length !== 3
  ) {
    throw new Error("render intent fields are invalid");
  }
  const targets: RenderTargetIntentV1[] = rawTargets.map((target) => {
    if (!isUnknownRecord(target)) throw new Error("render intent target is invalid");
    const renderName = target["render_name"];
    const targetPath = target["target_relative_path"];
    const content = target["content"];
    const contentSha = target["content_sha256"];
    const byteLength = target["byte_length"];
    if (
      (renderName !== "report" && renderName !== "sources" && renderName !== "readme") ||
      targetPath !== renderPath(renderName) ||
      typeof content !== "string" ||
      typeof contentSha !== "string" ||
      contentSha !== sha256(content) ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength !== Buffer.byteLength(content, "utf8")
    ) {
      throw new Error("render intent target binding is invalid");
    }
    return {
      render_name: renderName,
      target_relative_path: renderPath(renderName),
      content,
      content_sha256: contentSha,
      byte_length: byteLength,
    };
  });
  if (canonicalJson(targets.map((target) => target.render_name)) !== canonicalJson(RENDER_NAMES)) {
    throw new Error("render intent target order is invalid");
  }
  const intent: ResearchRenderIntentV1 = {
    schema_version: 1,
    renderer_id: RENDERER_ID,
    operation_identity: operationIdentity,
    receipt_time: receiptTime,
    target_directory: targetDirectory,
    semantic_core: semanticCore,
    targets,
  };
  if (canonicalJson(intent) !== bytes.toString("utf8")) {
    throw new Error("render intent bytes are not canonical");
  }
  return intent;
}

function assertIntentMatchesCurrent(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly intent: ResearchRenderIntentV1;
}): void {
  const coreArtifact = latestSemanticCore(input.context);
  const core = validateCanonicalGroundedSynthesisBytes(
    input.store.readById(coreArtifact.artifact_id),
    coreArtifact
  );
  const coreRef = semanticCoreRef(coreArtifact);
  const rendered = renderResearchCompatibility({ core, semanticCore: coreRef });
  if (
    canonicalJson(input.intent.semantic_core) !== canonicalJson(coreRef) ||
    input.intent.target_directory !== relativeReportDirectory(input.context) ||
    input.intent.operation_identity !==
      `research-render:${sha256(input.context.identity.run_id).slice(0, 32)}:${coreArtifact.artifact_id}` ||
    input.intent.targets.some((target) => target.content !== rendered[target.render_name])
  ) {
    throw new Error("render intent does not match the latest semantic core");
  }
}

function ensureRenderIntent(context: RunContext, store: ArtifactHostStore): PersistedIntent {
  const operationId = hostOperationId(context, "render-intent");
  const currentCore = latestSemanticCore(context);
  const selected = selectedLatest(
    context,
    (artifact) =>
      artifact.phase === "rendering" &&
      artifact.kind === "render-intent" &&
      artifact.operation_id === operationId
  );
  if (selected !== undefined) {
    const intent = parseRenderIntent(store.readById(selected.artifact_id));
    if (intent.semantic_core.artifact_ref.artifact_id === currentCore.artifact_id) {
      assertIntentMatchesCurrent({ context, store, intent });
      store.select(selected);
      return { artifact: selected, intent, added: false };
    }
  }
  const version = (selected?.version ?? 0) + 1;
  const orphan = store.refFor(
    context.identity.run_id,
    "rendering",
    null,
    "render-intent",
    operationId,
    version
  );
  if (orphan !== null) {
    const intent = parseRenderIntent(store.readById(orphan.artifact_id));
    assertIntentMatchesCurrent({ context, store, intent });
    store.select(orphan);
    return { artifact: orphan, intent, added: addSelectedArtifact(context, orphan) };
  }
  const core = validateCanonicalGroundedSynthesisBytes(
    store.readById(currentCore.artifact_id),
    currentCore
  );
  const coreRef = semanticCoreRef(currentCore);
  const rendered = renderResearchCompatibility({ core, semanticCore: coreRef });
  const intent: ResearchRenderIntentV1 = {
    schema_version: 1,
    renderer_id: RENDERER_ID,
    operation_identity: `research-render:${sha256(context.identity.run_id).slice(0, 32)}:${currentCore.artifact_id}`,
    receipt_time: new Date().toISOString(),
    target_directory: relativeReportDirectory(context),
    semantic_core: coreRef,
    targets: RENDER_NAMES.map((name) => ({
      render_name: name,
      target_relative_path: renderPath(name),
      content: rendered[name],
      content_sha256: sha256(rendered[name]),
      byte_length: Buffer.byteLength(rendered[name], "utf8"),
    })),
  };
  const persisted = persistVersionedHostArtifact({
    context,
    store,
    phase: "rendering",
    branchId: null,
    kind: "render-intent",
    operationLabel: "render-intent",
    producer: "host:compat-renderer",
    mediaType: "application/json",
    upstreamRefs: [currentCore],
    content: canonicalJson(intent),
  });
  return {
    ...persisted,
    intent: parseRenderIntent(store.readById(persisted.artifact.artifact_id)),
  };
}

function ensureRenderArtifact(
  context: RunContext,
  store: ArtifactHostStore,
  intent: PersistedIntent,
  name: RenderName
): PersistedRender {
  const target = intent.intent.targets.find((candidate) => candidate.render_name === name);
  if (target === undefined) throw new Error(`render intent lacks '${name}'`);
  const persisted = persistVersionedHostArtifact({
    context,
    store,
    phase: "rendering",
    branchId: name,
    kind: "deterministic-render",
    operationLabel: `deterministic-render-${name}`,
    producer: "host:compat-renderer",
    mediaType: "text/markdown; charset=utf-8",
    upstreamRefs: [intent.intent.semantic_core.artifact_ref, intent.artifact],
    content: target.content,
  });
  const render = validateDeterministicRenderRef({
    schema_id: "penny.deterministic-render-ref.v1",
    schema_version: 1,
    render_name: name,
    renderer_id: RENDERER_ID,
    target_relative_path: target.target_relative_path,
    semantic_core: intent.intent.semantic_core,
    artifact_ref: persisted.artifact,
    content_sha256: target.content_sha256,
    byte_length: target.byte_length,
  });
  return { ...persisted, render };
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function assertRegularNoFollow(candidate: string): void {
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`research render target '${candidate}' is not a regular no-follow file`);
  }
}

function readRegularNoFollow(candidate: string): Buffer | undefined {
  let handle: number;
  try {
    handle = openSync(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    if (!fstatSync(handle).isFile()) {
      throw new Error(`research render target '${candidate}' is not a regular file`);
    }
    return readFileSync(handle);
  } finally {
    closeSync(handle);
  }
}

function ensureRenderDirectory(projectRoot: string, relativeDirectory: string): string {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relativeDirectory);
  const relative = path.relative(root, target);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("research render directory escapes the project root");
  }
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("research project root is not a regular no-follow directory");
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`research render directory '${current}' is unsafe`);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`research render directory '${current}' was not created safely`);
      }
    }
  }
  return target;
}

function fsyncDirectory(directory: string): void {
  const handle = openSync(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
  );
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function removeSafeTemporary(temporary: string): void {
  try {
    assertRegularNoFollow(temporary);
    rmSync(temporary);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function materializedRenderNames(
  checkpointer: Checkpointer,
  runId: string,
  coreArtifactId: string
): Set<RenderName> {
  const names = new Set<RenderName>();
  for (const event of checkpointer.events(runId)) {
    if (
      event.eventType !== "research_render_materialized" ||
      event.payload.core_artifact_id !== coreArtifactId
    ) {
      continue;
    }
    const name = event.payload.render_name;
    if (name === "report" || name === "sources" || name === "readme") names.add(name);
  }
  return names;
}

function materializeRenderTarget(
  context: RunContext,
  intent: ResearchRenderIntentV1,
  name: RenderName,
  fault: (point: string) => void
): void {
  const target = intent.targets.find((candidate) => candidate.render_name === name);
  if (target === undefined) throw new Error(`render intent lacks '${name}'`);
  const directory = ensureRenderDirectory(context.projectRoot, intent.target_directory);
  const finalPath = path.join(directory, target.target_relative_path);
  const temporary = path.join(
    directory,
    `.research-render-${name}-${sha256(intent.operation_identity).slice(0, 16)}.tmp`
  );
  fault(`rendering:prewrite:${name}`);
  const finalBytes = readRegularNoFollow(finalPath);
  const expected = Buffer.from(target.content, "utf8");
  if (finalBytes?.equals(expected) === true) {
    removeSafeTemporary(temporary);
    fsyncDirectory(directory);
    fault(`rendering:directory-fsync:${name}`);
    if (!readRegularNoFollow(finalPath)?.equals(expected)) {
      throw new Error(`research render '${name}' drifted after adoption`);
    }
    return;
  }
  if (finalBytes !== undefined) assertRegularNoFollow(finalPath);
  const temporaryBytes = readRegularNoFollow(temporary);
  if (temporaryBytes === undefined || !temporaryBytes.equals(expected)) {
    if (temporaryBytes !== undefined) removeSafeTemporary(temporary);
    const handle = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    try {
      const split = Math.max(1, Math.floor(expected.length / 2));
      writeSync(handle, expected.subarray(0, split));
      fault(`rendering:partial-temporary-write:${name}`);
      if (split < expected.length) writeSync(handle, expected.subarray(split));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    fault(`rendering:file-fsync:${name}`);
  } else {
    const handle = openSync(temporary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    fault(`rendering:file-fsync:${name}`);
  }
  renameSync(temporary, finalPath);
  fault(`rendering:rename:${name}`);
  fsyncDirectory(directory);
  fault(`rendering:directory-fsync:${name}`);
  if (!readRegularNoFollow(finalPath)?.equals(expected)) {
    throw new Error(`research render '${name}' drifted after atomic replacement`);
  }
}

function verifyRenderedFiles(
  context: RunContext,
  intent: ResearchRenderIntentV1,
  renders: readonly DeterministicRenderRefV1[]
): void {
  const directory = ensureRenderDirectory(context.projectRoot, intent.target_directory);
  if (renders.length !== 3) throw new Error("exactly three deterministic renders are required");
  for (const render of renders) {
    const target = intent.targets.find((candidate) => candidate.render_name === render.render_name);
    if (
      target === undefined ||
      canonicalJson(render.semantic_core) !== canonicalJson(intent.semantic_core)
    ) {
      throw new Error(`render '${render.render_name}' is stale or substituted`);
    }
    const bytes = readRegularNoFollow(path.join(directory, target.target_relative_path));
    if (
      bytes === undefined ||
      bytes.length !== render.byte_length ||
      sha256(bytes) !== render.content_sha256 ||
      !bytes.equals(Buffer.from(target.content, "utf8"))
    ) {
      throw new Error(`rendered file '${target.target_relative_path}' failed exact verification`);
    }
  }
}

function ensureDeterministicValidationReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly intent: PersistedIntent;
  readonly renders: readonly DeterministicRenderRefV1[];
}): PersistedReceipt {
  const core = input.intent.intent.semantic_core.artifact_ref;
  const existing = latestReceiptForCore({
    context: input.context,
    store: input.store,
    kind: "deterministic_product_validation",
    core,
  });
  if (existing !== undefined) return { ...existing, added: false };
  const body: Omit<ProductReceiptV1, "receipt_id"> = {
    schema_id: "penny.product-receipt.v1",
    schema_version: 1,
    receipt_kind: "deterministic_product_validation",
    producer: "host:product-validator",
    attested_core: input.intent.intent.semantic_core,
    verdict: "PASS",
    findings: ["All three render artifacts and compatibility files match the latest core."],
    evidence_refs: input.renders.map((render) => render.artifact_ref),
    created_at: input.intent.intent.receipt_time,
  };
  const receipt = validateProductReceipt({ ...body, receipt_id: productReceiptId(body) });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "rendering",
    branchId: "deterministic",
    kind: "product-receipt",
    operationLabel: "product-receipt-deterministic",
    producer: "host:product-validator",
    mediaType: "application/json",
    contentSchema: { schema_id: "penny.product-receipt.v1", schema_version: 1 },
    upstreamRefs: [core, ...input.renders.map((render) => render.artifact_ref)],
    content: canonicalJson(receipt),
  });
  return {
    ...persisted,
    receipt: readProductReceipt(input.store, persisted.artifact),
  };
}

function currentReceiptSet(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly core: ArtifactRef;
}): Array<{ readonly artifact: ArtifactRef; readonly receipt: ProductReceiptV1 }> {
  const required: ProductReceiptV1["receipt_kind"][] = [
    "grounding_verification",
    ...(input.context.research.critique_passes >= 1 ? ["quality_critique" as const] : []),
    "deterministic_product_validation",
  ];
  return required.map((kind) => {
    const receipt = latestReceiptForCore({ ...input, kind });
    if (receipt === undefined || receipt.receipt.verdict !== "PASS") {
      throw new Error(`latest-core ${kind} PASS receipt is absent`);
    }
    return receipt;
  });
}

function ensureResearchProductEnvelope(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly intent: PersistedIntent;
  readonly renders: readonly DeterministicRenderRefV1[];
}): PersistedEnvelope {
  const core = input.intent.intent.semantic_core.artifact_ref;
  const receipts = currentReceiptSet({ context: input.context, store: input.store, core });
  const body: Omit<ResearchProductEnvelopeV1, "envelope_id"> = {
    schema_id: "penny.research-product-envelope.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    status: "complete",
    semantic_core: input.intent.intent.semantic_core,
    receipts: receipts.map(({ artifact, receipt }) => ({
      receipt_kind: receipt.receipt_kind,
      receipt_id: receipt.receipt_id,
      artifact_ref: artifact,
    })),
    renders: [...input.renders],
  };
  const envelope = validateResearchProductEnvelope({
    ...body,
    envelope_id: researchProductEnvelopeId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "rendering",
    branchId: null,
    kind: "product-envelope",
    operationLabel: "product-envelope",
    producer: "host:product-validator",
    mediaType: "application/json",
    contentSchema: { schema_id: "penny.research-product-envelope.v1", schema_version: 1 },
    upstreamRefs: [
      core,
      ...receipts.map(({ artifact }) => artifact),
      ...input.renders.map((render) => render.artifact_ref),
    ],
    content: canonicalJson(envelope),
  });
  const reread = readResearchEnvelope(input.store, persisted.artifact);
  if (canonicalJson(reread) !== canonicalJson(envelope)) {
    throw new Error(`product envelope '${envelope.envelope_id}' failed manifest re-read`);
  }
  return { ...persisted, envelope: reread };
}

function readResearchEnvelope(
  store: Pick<ArtifactReader, "readById">,
  artifact: ArtifactRef
): ResearchProductEnvelopeV1 {
  const bytes = store.readById(artifact.artifact_id);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`product envelope artifact '${artifact.artifact_id}' is not JSON`);
  }
  const envelope = validateResearchProductEnvelope(value);
  if (canonicalJson(envelope) !== bytes.toString("utf8")) {
    throw new Error(`product envelope artifact '${artifact.artifact_id}' is not canonical`);
  }
  return envelope;
}

function verifyResearchProductGraphFromStore(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly envelopeArtifact: ArtifactRef;
}): ResearchProductEnvelopeV1 {
  const envelope = readResearchEnvelope(input.store, input.envelopeArtifact);
  const coreBytes = input.store.readById(envelope.semantic_core.artifact_ref.artifact_id);
  const core = validateCanonicalGroundedSynthesisBytes(
    coreBytes,
    envelope.semantic_core.artifact_ref
  );
  const receipts = envelope.receipts.map((binding) => {
    const receipt = readProductReceipt(input.store, binding.artifact_ref);
    if (
      receipt.receipt_id !== binding.receipt_id ||
      receipt.receipt_kind !== binding.receipt_kind ||
      receipt.attested_core.artifact_ref.artifact_id !==
        envelope.semantic_core.artifact_ref.artifact_id ||
      receipt.attested_core.sha256 !== envelope.semantic_core.sha256
    ) {
      throw new Error(`receipt '${binding.receipt_id}' is stale or substituted`);
    }
    return receipt;
  });
  for (const render of envelope.renders) {
    const bytes = input.store.readById(render.artifact_ref.artifact_id);
    if (
      bytes.length !== render.byte_length ||
      sha256(bytes) !== render.content_sha256 ||
      render.semantic_core.artifact_ref.artifact_id !==
        envelope.semantic_core.artifact_ref.artifact_id
    ) {
      throw new Error(`render '${render.render_name}' is stale or substituted`);
    }
  }
  validateResearchProductGraph({
    core,
    envelope,
    receipts,
    renders: envelope.renders,
  });
  return envelope;
}

function qualifiedResearchCore(core: GroundedSynthesisV1 | undefined): boolean {
  return core === undefined ? false : posture(core) === "Qualified complete";
}

function positiveProductArtifactRefs(
  context: RunContext,
  store: ArtifactHostStore | undefined
):
  | {
      readonly core: ArtifactRef;
      readonly coreValue: GroundedSynthesisV1;
      readonly envelope: ArtifactRef;
      readonly artifacts: ArtifactRef[];
    }
  | undefined {
  if (store === undefined) return undefined;
  const core = latestSemanticCore(context);
  const envelopeArtifact = selectedLatest(
    context,
    (artifact) => artifact.kind === "product-envelope" && artifact.phase === "rendering"
  );
  if (envelopeArtifact === undefined) return undefined;
  const envelope = verifyResearchProductGraphFromStore({
    context,
    store,
    envelopeArtifact,
  });
  if (envelope.semantic_core.artifact_ref.artifact_id !== core.artifact_id) return undefined;
  const coreValue = validateCanonicalGroundedSynthesisBytes(store.readById(core.artifact_id), core);
  const artifacts = [
    core,
    ...envelope.receipts.map((receipt) => receipt.artifact_ref),
    ...envelope.renders.map((render) => render.artifact_ref),
    envelopeArtifact,
  ];
  if (new Set(artifacts.map((artifact) => artifact.artifact_id)).size !== artifacts.length) {
    throw new Error("latest research product graph contains duplicate artifact refs");
  }
  return { core, coreValue, envelope: envelopeArtifact, artifacts };
}

function parseCanonicalResearchRequest(
  reader: ArtifactReader,
  artifact: ArtifactRef
): ResearchRequestV1 {
  const bytes = reader.readById(artifact.artifact_id);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("research request artifact is not JSON");
  }
  const request = validateResearchRequest(value);
  if (canonicalJson(request) !== bytes.toString("utf8")) {
    throw new Error("research request artifact is not canonical");
  }
  return request;
}

function exactReviewCompletionEvidence(input: {
  readonly checkpointer: Checkpointer;
  readonly runId: string;
  readonly state: "validating" | "critiquing_report";
  readonly evidenceArtifactIds: ReadonlySet<string>;
}): Array<{ kind: "execution_receipt"; reference_id: string; sha256: string }> {
  const refs: Array<{ kind: "execution_receipt"; reference_id: string; sha256: string }> = [];
  for (const event of [...input.checkpointer.events(input.runId)].reverse()) {
    if (eventString(event.payload.state_id) !== input.state) continue;
    const ids =
      event.eventType === "phase_result_accepted"
        ? [eventString(event.payload.receipt_id)]
        : event.eventType === "routing_repair_accepted"
          ? [
              eventString(event.payload.source_receipt_id),
              eventString(event.payload.repair_receipt_id),
            ]
          : [];
    const results = ids.flatMap((id) => {
      const result = id === undefined ? undefined : input.checkpointer.receiptResultById(id);
      return result === undefined ? [] : [result];
    });
    if (
      results.length > 0 &&
      results.some((result) => input.evidenceArtifactIds.has(result.output_artifact.artifact_id))
    ) {
      for (const result of results) {
        refs.push({
          kind: "execution_receipt",
          reference_id: result.worker_receipt.receipt_id,
          sha256: sha256(canonicalJson(result)),
        });
      }
      return refs;
    }
  }
  return [];
}

function verifyTerminalRenderedFiles(input: {
  readonly context: RunContext;
  readonly core: GroundedSynthesisV1;
  readonly coreRef: SemanticCoreRefV1;
  readonly envelope: ResearchProductEnvelopeV1;
  readonly reader: ArtifactReader;
}): void {
  const rendered = renderResearchCompatibility({
    core: input.core,
    semanticCore: input.coreRef,
  });
  const directory = ensureRenderDirectory(
    input.context.projectRoot,
    relativeReportDirectory(input.context)
  );
  for (const render of input.envelope.renders) {
    const expected = Buffer.from(rendered[render.render_name], "utf8");
    const artifactBytes = input.reader.readById(render.artifact_ref.artifact_id);
    const fileBytes = readRegularNoFollow(path.join(directory, render.target_relative_path));
    if (
      !artifactBytes.equals(expected) ||
      fileBytes === undefined ||
      !fileBytes.equals(expected) ||
      render.content_sha256 !== sha256(expected) ||
      render.byte_length !== expected.length
    ) {
      throw new Error(`terminal render '${render.render_name}' does not match the latest core`);
    }
  }
}

export function evaluateResearchLatestCoreDod(
  input: Parameters<CompletionReceiptPredicateV1>[0]
): ReturnType<CompletionReceiptPredicateV1> {
  try {
    const reader = input.artifactReader;
    if (reader === undefined || input.originState !== "rendering") {
      return { passed: false, evidence_refs: [] };
    }
    const coreArtifact = input.context.selectedArtifacts.find(
      (artifact) => artifact.artifact_id === input.latestProduct.product_id
    );
    if (
      coreArtifact === undefined ||
      coreArtifact.kind !== "semantic-core" ||
      coreArtifact.phase !== "sealing_core" ||
      coreArtifact.content_digest !== input.latestProduct.sha256
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const core = validateCanonicalGroundedSynthesisBytes(
      reader.readById(coreArtifact.artifact_id),
      coreArtifact
    );
    const requestArtifact = selectedLatest(
      input.context,
      (artifact) => artifact.kind === "research-request" && artifact.phase === "intake"
    );
    if (requestArtifact === undefined) return { passed: false, evidence_refs: [] };
    const request = parseCanonicalResearchRequest(reader, requestArtifact);
    if (
      core.request.request_sha256 !== researchRequestSha256(request) ||
      core.request.normalized_question !== request.question ||
      canonicalJson(core.request.scope) !== canonicalJson(request.scope) ||
      core.provenance.context_trace_sha256 !== exactContextTrace(input.context) ||
      core.claims.some((claim) => claim.support_status === "unsupported") ||
      core.unresolved_gaps.some((gap) => gap.blocking) ||
      core.irreducible_uncertainties.some(
        (uncertainty) => uncertainty.disposition === "blocking"
      ) ||
      core.contradictions.some((contradiction) => contradiction.status === "unresolved") ||
      input.context.research.plan_critique_exhausted ||
      input.context.research.report_critique_exhausted ||
      input.context.research.validation_exhausted
    ) {
      return { passed: false, evidence_refs: [] };
    }
    for (const evidenceArtifact of core.provenance.evidence_artifacts) {
      const stored = reader.refById(evidenceArtifact.artifact_id);
      if (stored === undefined || canonicalJson(stored) !== canonicalJson(evidenceArtifact)) {
        return { passed: false, evidence_refs: [] };
      }
      reader.readById(evidenceArtifact.artifact_id);
    }
    const envelopeArtifacts = input.terminal.artifacts.filter(
      (artifact) => artifact.kind === "product-envelope"
    );
    if (envelopeArtifacts.length !== 1) return { passed: false, evidence_refs: [] };
    const envelopeArtifact = envelopeArtifacts[0];
    if (envelopeArtifact === undefined) return { passed: false, evidence_refs: [] };
    const envelope = readResearchEnvelope(reader, envelopeArtifact);
    if (
      envelope.semantic_core.artifact_ref.artifact_id !== coreArtifact.artifact_id ||
      envelope.semantic_core.sha256 !== coreArtifact.content_digest
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const expectedTerminalArtifactIds = [
      coreArtifact.artifact_id,
      ...envelope.receipts.map((binding) => binding.artifact_ref.artifact_id),
      ...envelope.renders.map((render) => render.artifact_ref.artifact_id),
      envelopeArtifact.artifact_id,
    ].sort();
    if (
      canonicalJson(input.terminal.artifacts.map((artifact) => artifact.artifact_id).sort()) !==
      canonicalJson(expectedTerminalArtifactIds)
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const receipts = envelope.receipts.map((binding) => {
      const receipt = readProductReceipt(reader, binding.artifact_ref);
      if (
        receipt.receipt_id !== binding.receipt_id ||
        receipt.receipt_kind !== binding.receipt_kind ||
        receipt.verdict !== "PASS" ||
        receipt.attested_core.artifact_ref.artifact_id !== coreArtifact.artifact_id ||
        receipt.attested_core.sha256 !== coreArtifact.content_digest
      ) {
        throw new Error(`latest-core receipt '${binding.receipt_id}' is invalid`);
      }
      return receipt;
    });
    const requiredKinds = [
      "grounding_verification",
      ...(input.context.research.critique_passes >= 1 ? ["quality_critique" as const] : []),
      "deterministic_product_validation",
    ];
    if (
      canonicalJson(receipts.map((receipt) => receipt.receipt_kind)) !==
      canonicalJson(requiredKinds)
    ) {
      return { passed: false, evidence_refs: [] };
    }
    validateResearchProductGraph({
      core,
      envelope,
      receipts,
      renders: envelope.renders,
    });
    verifyTerminalRenderedFiles({
      context: input.context,
      core,
      coreRef: semanticCoreRef(coreArtifact),
      envelope,
      reader,
    });
    const resultOutput = input.terminal.result.output_artifact_ref;
    if (
      canonicalJson(resultOutput) !== canonicalJson(coreArtifact) ||
      input.terminal.unresolved.length !== 0
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const evidenceRefs = receipts
      .filter(
        (receipt) =>
          receipt.receipt_kind === "grounding_verification" ||
          receipt.receipt_kind === "quality_critique"
      )
      .flatMap((receipt) =>
        exactReviewCompletionEvidence({
          checkpointer: input.checkpointer,
          runId: input.context.identity.run_id,
          state:
            receipt.receipt_kind === "grounding_verification" ? "validating" : "critiquing_report",
          evidenceArtifactIds: new Set(
            receipt.evidence_refs.map((artifact) => artifact.artifact_id)
          ),
        })
      );
    if (evidenceRefs.length === 0) return { passed: false, evidence_refs: [] };
    return { passed: true, evidence_refs: evidenceRefs };
  } catch {
    return { passed: false, evidence_refs: [] };
  }
}

function positiveIntegerOrZeroConstraint(value: JsonValue | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}
