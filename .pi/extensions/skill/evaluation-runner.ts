import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { Type, type Static } from "typebox";

import {
  ArtifactRefSchema,
  ArtifactStore,
  JsonValueSchema,
  OutputArtifactMetadataSchema,
  LivenessExhaustedError,
  OrchestrationService,
  RunContext,
  canonicalJson,
  resolveEvaluationCandidate,
  resolvePennyRuntimeState,
  sha256,
  skillContractSha256,
  validateContract,
  validateDirective,
  validateRegistrationContract,
  type AgentCompletion,
  type AgentInvocation,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type JsonValue,
  type LivenessPolicyV1,
  type LivenessSnapshotV1,
  type LivenessTerminalCapabilityV1,
  type ModelClient,
  type OutputArtifactMetadata,
  type PlaybookCoreV1,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
  type RunContext as OrchestrationRunContext,
  type SkillContract,
} from "@penny/orchestration/source";

import {
  EvaluationFunctionDescriptorV1Schema,
  EvaluationImplementationBindingV1Schema,
  EvaluationMutationMeasurementV1Schema,
  EvaluationReadinessPairFloorV1Schema,
  EvaluationPopulationV1Schema,
  FrozenPairedEvaluationV1Schema,
  PairedEvaluationPlanV1Schema,
  PairedEvaluationResultV1Schema,
  PairedEvaluationScheduleEntryV1Schema,
  EvaluationTrialTerminalStatusV1Schema,
  SemanticClauseResultV1Schema,
  assertFrozenEvaluationInputs,
  freezePairedEvaluationContracts,
  pairedEvaluationPlanSha256,
  pairedEvaluationResultId,
  validateEvaluationPopulation,
  validatePairedEvaluationPlan,
  validatePairedEvaluationResult,
  type DirectBaselineDefinitionV1,
  type EvaluationFunctionDescriptorV1,
  type EvaluationImplementationBindingV1,
  type EvaluationImplementationFileRoleV1,
  type EvaluationMutationMeasurementV1,
  type EvaluationRuntimeFunctionRoleV1,
  type EvaluationPopulationTaskV1,
  type EvaluationPopulationV1,
  type EvaluationTrialMeasurementV1,
  type InvalidEvaluationStageV1,
  type EvaluationTrialTerminalStatusV1,
  type FrozenPairedEvaluationV1,
  type PairedEvaluationPlanV1,
  type PairedEvaluationResultV1,
  type PairedEvaluationScheduleEntryV1,
  type PairedEvaluationTrialV1,
  type SemanticClauseResultV1,
} from "./evaluation-contracts.js";
import type { VerifiedSemanticReviewEvidenceV1 } from "./evaluation-semantic-review.js";

export const DIRECT_DEMETRI_BASELINE_NAME = "evaluation-direct-demetri";
export const SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME = "synthetic-known-delta-candidate";

export type InvalidEvaluationCodeV1 =
  | "EVALUATION_REGISTRATION_INCOMPATIBLE"
  | "LOCAL_LIVE_STATE_BINDING_INCOMPATIBLE"
  | "LOCAL_LIVE_ARTIFACT_READ_PREFLIGHT_FAILED"
  | "READINESS_PREFLIGHT_REQUIRED"
  | "READINESS_PREFLIGHT_FAILED"
  | "COMPARATIVE_UNVERIFIABLE"
  | "SEMANTIC_NORMALIZER_INCOMPATIBLE"
  | "SEMANTIC_REVIEW_AUTHORIZATION_FAILED"
  | "SEMANTIC_REVIEW_INCOMPATIBLE"
  | "GRADER_PARSER_INCOMPATIBLE";

export class InvalidEvaluationFault extends Error {
  constructor(
    readonly stage: InvalidEvaluationStageV1,
    readonly code: InvalidEvaluationCodeV1,
    readonly trialId: string | null,
    cause?: unknown
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "InvalidEvaluationFault";
  }
}

export const EVALUATION_LIVENESS_POLICY = {
  schema_version: 1,
  scope: "paired-evaluation",
  preset: "offline-paired-evaluation-v2",
  total_phase_repair_invocations: 4,
  model_turns_per_worker: 4,
  model_turns_per_run: 4,
  tool_calls_per_worker: 4,
  tool_calls_per_run: 4,
  external_calls_per_worker: 0,
  external_calls_per_run: 0,
  worker_wall_clock_ms: 180_000,
  run_wall_clock_ms: 360_000,
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
} as const satisfies LivenessPolicyV1;

export const EVALUATION_BUDGET_POLICY_SHA256 = sha256(canonicalJson(EVALUATION_LIVENESS_POLICY));

const DirectBaselineStartConstraintsV1Schema = Type.Object(
  {
    evaluation_plan_id: Type.String({ minLength: 1, maxLength: 256 }),
    schedule_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    task_id: Type.String({ minLength: 1, maxLength: 256 }),
    repetition: Type.Integer({ minimum: 1, maximum: 32 }),
    variant: Type.Literal("baseline"),
    task_constraints: Type.Record(Type.String(), JsonValueSchema),
    model_override: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false }
);

const DIRECT_BASELINE_ORACLE_FIELDS = new Set([
  "comparison_validity_policy",
  "deterministic_disposition_rule",
  "evaluation_thresholds",
  "expected_answer",
  "expected_outcome",
  "failure_rule",
  "grader_case_id",
  "grader_descriptor",
  "grader_registry_sha256",
  "grading_definition",
  "material_effect_threshold",
  "mutation_cohort",
  "mutation_gate",
  "mutation_oracle",
  "negative_transfer_ceiling",
  "protected_capability",
  "protected_capability_floor",
  "protected_capability_score",
  "protected_flag",
  "readiness_preflight",
  "trigger_expected",
  "trigger_precision_floor",
]);

function assertOracleFreeDirectBaselineTaskConstraints(
  value: JsonValue,
  location = "constraints"
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertOracleFreeDirectBaselineTaskConstraints(entry, `${location}[${index}]`)
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll("-", "_");
    if (DIRECT_BASELINE_ORACLE_FIELDS.has(normalizedKey)) {
      throw new Error(`direct baseline task ${location}.${key} contains host-only grading data`);
    }
    assertOracleFreeDirectBaselineTaskConstraints(entry, `${location}.${key}`);
  }
}

const GraderOutputV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    task_id: Type.String({ minLength: 1, maxLength: 256 }),
    answer: Type.String({ minLength: 1, maxLength: 1_024 }),
    trigger_predicted: Type.Boolean(),
  },
  { additionalProperties: false }
);

interface EvaluationTaskDispatchV1 {
  readonly schema_version: 1;
  readonly task_id: string;
  readonly goal: string;
  readonly constraints: Readonly<Record<string, JsonValue>>;
}

function terminalDirective(
  context: OrchestrationRunContext,
  action: "complete" | "incomplete" | "cancelled",
  unresolved: readonly string[] = [],
  liveness?: LivenessSnapshotV1
): Directive {
  const met = action === "complete";
  const outputRef = context.selectedArtifacts.at(-1);
  context.previousState = context.stateId;
  context.stateId = action;
  context.status = action;
  context.met = met;
  context.pendingBranches = [];
  const terminal = validateDirective({
    schema_version: 2,
    action,
    identity: context.identity,
    status: action,
    met,
    result: {
      complete: met,
      output_artifact_ref: outputRef ?? null,
      best_partial_artifact_refs: met || outputRef === undefined ? [] : [outputRef],
      ...(liveness === undefined ? {} : { liveness }),
    },
    artifacts: [...context.selectedArtifacts],
    unresolved: [...unresolved],
  });
  context.pendingDirective = terminal;
  context.terminalDirective = terminal;
  return terminal;
}

interface EvaluationRegistrationOutputV1 {
  readonly portName: string;
  readonly artifactKind: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly mediaType: string;
}

interface EvaluationRegistrationConfigurationV1 {
  readonly name: string;
  readonly releaseStatus: "production" | "candidate";
  readonly actualRequest: boolean;
  readonly agent: string;
  readonly phase: string;
  readonly guidance: SkillContract["guidance"];
  readonly output: EvaluationRegistrationOutputV1;
  readonly liveness: {
    readonly resolverId: string;
    readonly policy: LivenessPolicyV1;
    readonly thinkingPolicy: "agent_ssot" | "research_preset";
  };
  readonly allowedTools?: readonly string[];
}

class EvaluationOneStatePlaybook implements PlaybookCoreV1, LivenessTerminalCapabilityV1 {
  constructor(private readonly configuration: EvaluationRegistrationConfigurationV1) {}

  initialize(context: OrchestrationRunContext): Directive {
    context.transition(this.configuration.phase);
    return this.dispatch(context);
  }

  dispatch(context: OrchestrationRunContext): Directive {
    const directConstraints = this.configuration.actualRequest
      ? undefined
      : validateContract(
          DirectBaselineStartConstraintsV1Schema,
          context.constraints,
          "direct baseline start constraints"
        );
    if (directConstraints !== undefined) {
      assertOracleFreeDirectBaselineTaskConstraints(directConstraints.task_constraints);
    }
    const task = this.configuration.actualRequest
      ? {
          schema_version: 1,
          goal: context.goal,
          constraints: context.constraints,
        }
      : {
          schema_version: 1,
          task_id: directConstraints?.task_id ?? "",
          goal: context.goal,
          constraints: directConstraints?.task_constraints ?? {},
        };
    const upstream = [...context.selectedArtifacts];
    const modelOverride = String(
      directConstraints?.model_override ?? context.constraints.model_override ?? ""
    ).trim();
    const directive = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: this.configuration.phase,
      agent: this.configuration.agent,
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      ...(modelOverride.length === 0 ? {} : { model_override: modelOverride }),
      task: canonicalJson(task),
      input_artifacts: {
        schema_version: 2,
        artifacts: upstream.map((ref, index) => ({
          slot: `evaluation-input-${String(index + 1).padStart(4, "0")}`,
          ref,
        })),
      },
      output_artifact: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: this.configuration.phase,
        branch_id: null,
        kind: this.configuration.output.artifactKind,
        operation_id: `paired-evaluation-trial:${context.identity.run_id}`,
        version: 1,
        producer: `agent:${this.configuration.agent}`,
        media_type: this.configuration.output.mediaType,
        content_schema: {
          schema_id: this.configuration.output.schemaId,
          schema_version: this.configuration.output.schemaVersion,
        },
        parent_ref: null,
        upstream_refs: upstream,
      },
    });
    context.pendingDirective = directive;
    return directive;
  }

  resume(_context: OrchestrationRunContext, _response: JsonValue): Directive {
    throw new Error("paired evaluation trials have no user gate");
  }

  cancel(context: OrchestrationRunContext, reason: string): Directive {
    return terminalDirective(context, "cancelled", [reason]);
  }

  acceptSummary(
    context: OrchestrationRunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    if (details.complete !== true) {
      throw new Error("paired evaluation worker did not report complete=true");
    }
    return terminalDirective(context, "complete");
  }

  rebindPendingDirective(context: OrchestrationRunContext): Directive | null {
    if (this.configuration.actualRequest || context.pendingDirective === null) {
      return context.pendingDirective;
    }
    return this.dispatch(context);
  }

  terminalizeLiveness(
    context: OrchestrationRunContext,
    reason: Parameters<LivenessTerminalCapabilityV1["terminalizeLiveness"]>[1],
    snapshot: LivenessSnapshotV1
  ): Directive {
    return terminalDirective(context, "incomplete", [reason], snapshot);
  }
}

function evaluationContract(input: EvaluationRegistrationConfigurationV1): SkillContract {
  return {
    schema_version: 2,
    name: input.name,
    release_status: input.releaseStatus,
    objective:
      "Execute one frozen paired-evaluation task without admission or promotion authority.",
    io: {
      request: {
        schema_version: 1,
        name: "request",
        direction: "input",
        transport: "inline_request",
        schema_id: input.actualRequest
          ? "penny.synthetic-evaluation-request.v1"
          : "penny.evaluation-trial-request.v1",
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
          name: "exact_inputs",
          direction: "input",
          transport: "artifact",
          schema_id: "penny.evaluation-input.v1",
          schema_version_required: 1,
          artifact_kind: "evaluation-input",
          source: "caller",
          min_items: 0,
          max_items: 64,
          semantic_product: false,
        },
        {
          schema_version: 1,
          name: "prior_grounded_synthesis",
          direction: "input",
          transport: "artifact",
          schema_id: "penny.grounded-synthesis.v1",
          schema_version_required: 1,
          artifact_kind: "semantic-core",
          source: "either",
          min_items: 0,
          max_items: 1,
          semantic_product: true,
        },
      ],
      active_output_ports: [
        {
          schema_version: 1,
          name: input.output.portName,
          direction: "output",
          transport: "artifact",
          schema_id: input.output.schemaId,
          schema_version_required: input.output.schemaVersion,
          artifact_kind: input.output.artifactKind,
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
    guidance: input.guidance,
    budget_policy: {
      schema_version: 1,
      policy_id: "penny.paired-evaluation-budget.v1",
      resolver_id: input.liveness.resolverId,
      admission_id: "pairedEvaluationBudgetAdmission",
      snapshot_id: "pairedEvaluationBudgetSnapshot",
    },
    repair_routing: { schema_version: 1, routes: [] },
    completion_gate: {
      schema_version: 2,
      allowed_terminal_origins: [input.phase],
      required_visited_states: [input.phase],
      required_receipt_predicates: [],
      latest_product: {
        selector: "terminal_result",
        schema_id: "penny.evaluation-trial-terminal.v1",
        product_schema_version: 1,
      },
      unresolved_policy: { mode: "max_count", max_count: 0 },
    },
  };
}

function evaluationRegistration(
  configuration: EvaluationRegistrationConfigurationV1
): PlaybookRegistrationV1 {
  const contract = evaluationContract(configuration);
  return {
    name: configuration.name,
    contract,
    ingress: "skill",
    start_admission: {
      schema_id: contract.io.request.schema_id,
      schema_version: 1,
      prepare: (request, host) => {
        const admitted = configuration.actualRequest
          ? undefined
          : validateContract(
              DirectBaselineStartConstraintsV1Schema,
              request.constraints,
              "direct baseline trial start constraints"
            );
        if (admitted !== undefined) {
          assertOracleFreeDirectBaselineTaskConstraints(admitted.task_constraints);
        }
        const exactInputRefs =
          request.input_artifacts?.artifacts.map((binding) => binding.ref) ?? [];
        if (exactInputRefs.length > 0 && host.artifactReader === undefined) {
          throw new Error("paired evaluation exact inputs require the canonical artifact reader");
        }
        for (const ref of exactInputRefs) {
          const stored = host.artifactReader?.refById(ref.artifact_id);
          if (stored === undefined || canonicalJson(stored) !== canonicalJson(ref)) {
            throw new Error(`paired evaluation exact input '${ref.artifact_id}' is stale`);
          }
          host.artifactReader?.readById(ref.artifact_id);
        }
        return {
          schema_id: contract.io.request.schema_id,
          schema_version: 1,
          request,
          goal: request.goal,
          constraints:
            admitted === undefined
              ? request.constraints
              : {
                  evaluation_plan_id: admitted.evaluation_plan_id,
                  schedule_sha256: admitted.schedule_sha256,
                  task_id: admitted.task_id,
                  repetition: admitted.repetition,
                  variant: admitted.variant,
                  task_constraints: admitted.task_constraints,
                  model_override: admitted.model_override,
                },
          admission_data: exactInputRefs,
        };
      },
      materialize: (prepared) =>
        validateContract(
          Type.Array(ArtifactRefSchema, { maxItems: 64 }),
          prepared.admission_data ?? [],
          "paired evaluation admitted exact inputs"
        ),
    },
    liveness: {
      resolver_id: configuration.liveness.resolverId,
      resolve: () => configuration.liveness.policy,
      thinking_policy: configuration.liveness.thinkingPolicy,
    },
    worker: {
      kind: "catalog-agent",
      workflow_name: configuration.name,
      guidance: contract.guidance,
      guidance_required: true,
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
      phases: new Map([
        [
          configuration.phase,
          {
            agent: configuration.agent,
            result_schema_id: "penny.evaluation-trial-summary.v1",
            result_schema_version: 1,
            schema: Type.Object({ complete: Type.Literal(true) }, { additionalProperties: false }),
            ...(configuration.allowedTools === undefined
              ? {}
              : { allowed_tools: [...configuration.allowedTools] }),
          },
        ],
      ]),
    },
    completionReceiptPredicates: new Map(),
    construct: () => new EvaluationOneStatePlaybook(configuration),
  };
}

export interface DirectAgentBaselineRegistrationOptionsV1 {
  readonly registrationName: string;
  readonly agent: string;
  readonly phase: string;
  readonly guidance: SkillContract["guidance"];
  readonly output: {
    readonly portName?: string;
    readonly artifactKind: string;
    readonly schemaId: string;
    readonly schemaVersion: number;
    readonly mediaType?: string;
  };
  readonly liveness?: {
    readonly resolverId: string;
    readonly policy: LivenessPolicyV1;
    readonly thinkingPolicy?: "agent_ssot" | "research_preset";
  };
  /** Optional registration-bound strict subset of the agent YAML tool maximum. */
  readonly allowedTools?: readonly string[];
}

export function createDirectAgentBaselineRegistration(
  input: DirectAgentBaselineRegistrationOptionsV1
): PlaybookRegistrationV1 {
  return evaluationRegistration({
    name: input.registrationName,
    releaseStatus: "production",
    actualRequest: false,
    agent: input.agent,
    phase: input.phase,
    guidance: input.guidance,
    output: {
      portName: input.output.portName ?? "trial_output",
      artifactKind: input.output.artifactKind,
      schemaId: input.output.schemaId,
      schemaVersion: input.output.schemaVersion,
      mediaType: input.output.mediaType ?? "text/plain; charset=utf-8",
    },
    liveness: {
      resolverId: input.liveness?.resolverId ?? "pairedEvaluationLivenessPolicy",
      policy: input.liveness?.policy ?? EVALUATION_LIVENESS_POLICY,
      thinkingPolicy: input.liveness?.thinkingPolicy ?? "agent_ssot",
    },
    ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
  });
}

export const DIRECT_DEMETRI_BASELINE_REGISTRATION = createDirectAgentBaselineRegistration({
  registrationName: DIRECT_DEMETRI_BASELINE_NAME,
  agent: "demetri",
  phase: "evaluating",
  guidance: {
    skill_root: "evals/guidance/direct",
    resolution: "per_agent_phase",
  },
  output: {
    artifactKind: "agent-output",
    schemaId: "penny.evaluation-trial-output.v1",
    schemaVersion: 1,
  },
});

export const SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION = evaluationRegistration({
  name: SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
  releaseStatus: "candidate",
  actualRequest: true,
  agent: "demetri",
  phase: "evaluating",
  guidance: {
    skill_root: "evals/guidance/direct",
    resolution: "per_agent_phase",
  },
  output: {
    portName: "trial_output",
    artifactKind: "agent-output",
    schemaId: "penny.evaluation-trial-output.v1",
    schemaVersion: 1,
    mediaType: "text/plain; charset=utf-8",
  },
  liveness: {
    resolverId: "pairedEvaluationLivenessPolicy",
    policy: EVALUATION_LIVENESS_POLICY,
    thinkingPolicy: "agent_ssot",
  },
});

export const SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY: PlaybookRegistryV1 = new Map([
  [SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.name, SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION],
]);

function registrationPhase(registration: PlaybookRegistrationV1): {
  readonly phase: string;
  readonly agent: string;
} {
  if (registration.worker.kind !== "catalog-agent" || registration.worker.phases.size !== 1) {
    throw new Error("direct evaluation registration requires exactly one catalog-agent phase");
  }
  const phaseEntry = [...registration.worker.phases.entries()][0];
  if (phaseEntry === undefined) throw new Error("direct evaluation registration phase is absent");
  return { phase: phaseEntry[0], agent: phaseEntry[1].agent };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function frozenDirectAgentFileSha256(projectRoot: string, relativePath: string): string {
  const root = realpathSync(projectRoot);
  const candidate = realpathSync(path.resolve(root, relativePath));
  if (!isWithinRoot(root, candidate)) {
    throw new Error(`direct-agent file '${relativePath}' escapes the project root`);
  }
  const stats = lstatSync(candidate);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > 1_048_576) {
    throw new Error(`direct-agent file '${relativePath}' is not one bounded regular file`);
  }
  return sha256(readFileSync(candidate));
}

export function directBaselineDefinition(
  registration: PlaybookRegistrationV1,
  projectRoot: string
): DirectBaselineDefinitionV1 {
  validateRegistrationContract(registration, "production");
  if (registration.ingress !== "skill") {
    throw new Error("direct evaluation baseline must use generic skill ingress");
  }
  const phase = registrationPhase(registration);
  const outputPorts = registration.contract.io.active_output_ports.filter(
    (port) => port.transport === "artifact"
  );
  const outputPort = outputPorts[0];
  if (outputPorts.length !== 1 || outputPort === undefined || outputPort.artifact_kind === null) {
    throw new Error("direct evaluation baseline requires exactly one active artifact output port");
  }
  const probeContext = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: `evaltrial_${"0".repeat(64)}`,
      session_id: `evaltrial_${"0".repeat(64)}`,
      playbook: registration.name,
      engine_owner: "typescript",
    },
    goal: "Verify the direct evaluation baseline definition.",
    constraints: {
      evaluation_plan_id: "direct-baseline-definition-probe",
      schedule_sha256: "0".repeat(64),
      task_id: "direct-baseline-definition-probe",
      repetition: 1,
      variant: "baseline",
      task_constraints: {},
      model_override: "offline/direct-baseline-definition-probe",
    },
    projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
  const directive = registration.construct({}).initialize(probeContext);
  if (
    directive.action !== "invoke_agent" ||
    directive.state_id !== phase.phase ||
    directive.agent !== phase.agent ||
    directive.output_artifact.phase !== phase.phase ||
    directive.output_artifact.kind !== outputPort.artifact_kind ||
    directive.output_artifact.producer !== `agent:${phase.agent}` ||
    directive.output_artifact.content_schema?.schema_id !== outputPort.schema_id ||
    directive.output_artifact.content_schema.schema_version !== outputPort.schema_version_required
  ) {
    throw new Error(
      "direct evaluation baseline directive, worker phase, producer, and active output port disagree"
    );
  }
  const livenessPolicy = registration.liveness.resolve(probeContext);
  if (livenessPolicy === undefined) {
    throw new Error("direct evaluation baseline has no liveness policy");
  }
  const suffix =
    registration.worker.guidance.resolution === "per_agent_phase"
      ? `${phase.agent}-${phase.phase}.md`
      : `${phase.agent}.md`;
  const guidancePath = `${registration.worker.guidance.skill_root}/${suffix}`;
  const body = {
    kind: "direct_agent" as const,
    registration_name: registration.name,
    agent: phase.agent,
    phase: phase.phase,
    guidance: {
      skill_root: registration.worker.guidance.skill_root,
      resolution: registration.worker.guidance.resolution,
      path: guidancePath,
    },
    output: {
      artifact_kind: outputPort.artifact_kind,
      schema_id: outputPort.schema_id,
      schema_version: outputPort.schema_version_required,
      producer: directive.output_artifact.producer,
      media_type: directive.output_artifact.media_type,
    },
    liveness_policy_sha256: sha256(canonicalJson(livenessPolicy)),
  };
  return {
    ...body,
    definition_sha256: sha256(canonicalJson(body)),
    agent_definition_sha256: frozenDirectAgentFileSha256(
      projectRoot,
      `.pi/agents/${phase.agent}.md`
    ),
    guidance_sha256: frozenDirectAgentFileSha256(projectRoot, guidancePath),
  };
}

const EvaluationGradingIdV1Schema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const EvaluationSemanticWireV1Schema = Type.Object(
  {
    schema_id: EvaluationGradingIdV1Schema,
    schema_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false }
);
export type EvaluationSemanticWireV1 = Readonly<Static<typeof EvaluationSemanticWireV1Schema>>;

export const EvaluationSemanticNormalizerDescriptorV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    registration_name: EvaluationGradingIdV1Schema,
    normalizer_id: EvaluationGradingIdV1Schema,
    normalizer_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    source_output: Type.Object(
      {
        artifact_kind: EvaluationGradingIdV1Schema,
        schema_id: EvaluationGradingIdV1Schema,
        schema_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false }
    ),
    target_wire: EvaluationSemanticWireV1Schema,
  },
  { additionalProperties: false }
);
export type EvaluationSemanticNormalizerDescriptorV1 = Readonly<
  Static<typeof EvaluationSemanticNormalizerDescriptorV1Schema>
>;

export const DeterministicGraderDescriptorV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    grader_case_id: EvaluationGradingIdV1Schema,
    grader_id: EvaluationGradingIdV1Schema,
    grader_version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    protected_capability: Type.Boolean(),
    wire: EvaluationSemanticWireV1Schema,
    oracle: JsonValueSchema,
  },
  { additionalProperties: false }
);
export type DeterministicGraderDescriptorV1 = Readonly<
  Static<typeof DeterministicGraderDescriptorV1Schema>
>;

export const EvaluationGradingDescriptorV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    wire: EvaluationSemanticWireV1Schema,
    semantic_normalizers: Type.Array(EvaluationSemanticNormalizerDescriptorV1Schema, {
      minItems: 1,
      maxItems: 256,
    }),
    graders: Type.Array(DeterministicGraderDescriptorV1Schema, {
      minItems: 1,
      maxItems: 2_048,
    }),
  },
  { additionalProperties: false }
);
export type EvaluationGradingDescriptorV1 = Readonly<
  Static<typeof EvaluationGradingDescriptorV1Schema>
>;

export type EvaluationSemanticNormalizationV1 =
  | {
      readonly status: "normalized";
      readonly wire_bytes: string;
    }
  | {
      readonly status: "invalid_output";
      readonly failure_code: string;
    };

export interface EvaluationSemanticNormalizerImplementationV1 {
  readonly normalizer_id: string;
  readonly normalizer_version: number;
  /** Stable implementation-revision digest; callers should set it for frozen real evaluations. */
  readonly implementation_sha256?: string;
  normalize(input: {
    readonly descriptor: EvaluationSemanticNormalizerDescriptorV1;
    readonly wire: EvaluationSemanticWireV1;
    readonly output_ref: ArtifactRef;
    readonly output_metadata: OutputArtifactMetadata;
    readonly output_bytes: string;
    readonly task: EvaluationPopulationTaskV1;
  }): EvaluationSemanticNormalizationV1;
}

export interface DeterministicGraderResultV1 {
  readonly task_score: number;
  readonly trigger_predicted: boolean;
  readonly protected_capability_score: number | null;
  readonly clause_results?: SemanticClauseResultV1[];
}

export interface DeterministicGraderImplementationV1 {
  readonly grader_id: string;
  readonly grader_version: number;
  /** Stable implementation-revision digest; callers should set it for frozen real evaluations. */
  readonly implementation_sha256?: string;
  grade(
    wireBytes: string,
    task: EvaluationPopulationTaskV1,
    descriptor: DeterministicGraderDescriptorV1
  ): DeterministicGraderResultV1;
  qualifySemanticReview?(input: {
    readonly wireBytes: string;
    readonly task: EvaluationPopulationTaskV1;
    readonly descriptor: DeterministicGraderDescriptorV1;
    readonly semanticReview: VerifiedSemanticReviewEvidenceV1;
    readonly oracleReview: VerifiedSemanticReviewEvidenceV1;
  }): EvaluationSemanticTaskQualificationV1;
}

export interface EvaluationGradingDefinitionV1 {
  readonly descriptor: EvaluationGradingDescriptorV1;
  readonly implementations: {
    readonly semantic_normalizers: ReadonlyMap<
      string,
      EvaluationSemanticNormalizerImplementationV1
    >;
    readonly graders: ReadonlyMap<string, DeterministicGraderImplementationV1>;
  };
}

interface ValidatedEvaluationGradingDefinitionV1 {
  readonly descriptor: EvaluationGradingDescriptorV1;
  readonly semanticNormalizerDescriptors: ReadonlyMap<
    string,
    EvaluationSemanticNormalizerDescriptorV1
  >;
  readonly graderDescriptors: ReadonlyMap<string, DeterministicGraderDescriptorV1>;
  readonly semanticNormalizerImplementations: ReadonlyMap<
    string,
    EvaluationSemanticNormalizerImplementationV1
  >;
  readonly graderImplementations: ReadonlyMap<string, DeterministicGraderImplementationV1>;
  readonly sha256: string;
}

const EvaluationSemanticNormalizationV1Schema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("normalized"),
      wire_bytes: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      status: Type.Literal("invalid_output"),
      failure_code: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }),
    },
    { additionalProperties: false }
  ),
]);

const DeterministicGraderResultV1Schema = Type.Object(
  {
    task_score: Type.Number({ minimum: 0, maximum: 1 }),
    trigger_predicted: Type.Boolean(),
    protected_capability_score: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
    clause_results: Type.Optional(
      Type.Array(SemanticClauseResultV1Schema, { minItems: 1, maxItems: 64 })
    ),
  },
  { additionalProperties: false }
);

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function declaredImplementationSha256(input: {
  readonly implementationId: string;
  readonly implementationVersion: number;
  readonly implementationSha256?: string;
}): string {
  const declared = input.implementationSha256;
  if (declared !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(declared)) {
      throw new Error("evaluation implementation digest is malformed");
    }
    return declared;
  }
  return sha256(
    canonicalJson({
      implementation_id: input.implementationId,
      implementation_version: input.implementationVersion,
    })
  );
}

function gradingImplementationBindings(
  definition: EvaluationGradingDefinitionV1
): ReadonlyArray<Readonly<Record<string, JsonValue>>> {
  return [
    ...[...definition.implementations.semantic_normalizers.entries()].map(
      ([registrationName, implementation]) => ({
        kind: "semantic_normalizer",
        key: registrationName,
        implementation_id: implementation.normalizer_id,
        implementation_version: implementation.normalizer_version,
        implementation_sha256: declaredImplementationSha256({
          implementationId: implementation.normalizer_id,
          implementationVersion: implementation.normalizer_version,
          implementationSha256: implementation.implementation_sha256,
        }),
      })
    ),
    ...[...definition.implementations.graders.entries()].map(([graderCaseId, implementation]) => ({
      kind: "deterministic_grader",
      key: graderCaseId,
      implementation_id: implementation.grader_id,
      implementation_version: implementation.grader_version,
      implementation_sha256: declaredImplementationSha256({
        implementationId: implementation.grader_id,
        implementationVersion: implementation.grader_version,
        implementationSha256: implementation.implementation_sha256,
      }),
    })),
  ].sort((left, right) => compareKeys(String(left.key), String(right.key)));
}

function exactKeyParity(input: {
  readonly label: string;
  readonly descriptorKeys: readonly string[];
  readonly implementations: ReadonlyMap<string, unknown>;
}): void {
  const sortedDescriptorKeys = [...input.descriptorKeys].sort(compareKeys);
  if (canonicalJson(input.descriptorKeys) !== canonicalJson(sortedDescriptorKeys)) {
    throw new Error(`${input.label} descriptors must be strictly registration-key sorted`);
  }
  if (new Set(input.descriptorKeys).size !== input.descriptorKeys.length) {
    throw new Error(`${input.label} descriptor keys must be unique`);
  }
  const implementationKeys = [...input.implementations.keys()].sort(compareKeys);
  if (canonicalJson(implementationKeys) !== canonicalJson(sortedDescriptorKeys)) {
    throw new Error(`${input.label} descriptor and implementation keys must have exact parity`);
  }
}

function validatedEvaluationGradingDefinition(
  definition: EvaluationGradingDefinitionV1
): ValidatedEvaluationGradingDefinitionV1 {
  const descriptor = validateContract(
    EvaluationGradingDescriptorV1Schema,
    definition.descriptor,
    "evaluation grading descriptor"
  );
  const semanticNormalizerDescriptors = new Map(
    descriptor.semantic_normalizers.map((normalizer) => [normalizer.registration_name, normalizer])
  );
  const graderDescriptors = new Map(
    descriptor.graders.map((grader) => [grader.grader_case_id, grader])
  );
  exactKeyParity({
    label: "semantic normalizer",
    descriptorKeys: descriptor.semantic_normalizers.map(
      (normalizer) => normalizer.registration_name
    ),
    implementations: definition.implementations.semantic_normalizers,
  });
  exactKeyParity({
    label: "deterministic grader",
    descriptorKeys: descriptor.graders.map((grader) => grader.grader_case_id),
    implementations: definition.implementations.graders,
  });
  for (const normalizer of descriptor.semantic_normalizers) {
    if (canonicalJson(normalizer.target_wire) !== canonicalJson(descriptor.wire)) {
      throw new Error(
        `semantic normalizer '${normalizer.registration_name}' targets an incompatible grading wire`
      );
    }
    const implementation = definition.implementations.semantic_normalizers.get(
      normalizer.registration_name
    );
    if (
      implementation === undefined ||
      implementation.normalizer_id !== normalizer.normalizer_id ||
      implementation.normalizer_version !== normalizer.normalizer_version ||
      typeof implementation.normalize !== "function"
    ) {
      throw new Error(
        `semantic normalizer '${normalizer.registration_name}' descriptor and implementation disagree`
      );
    }
  }
  for (const grader of descriptor.graders) {
    if (canonicalJson(grader.wire) !== canonicalJson(descriptor.wire)) {
      throw new Error(
        `deterministic grader '${grader.grader_case_id}' consumes an incompatible wire`
      );
    }
    const implementation = definition.implementations.graders.get(grader.grader_case_id);
    if (
      implementation === undefined ||
      implementation.grader_id !== grader.grader_id ||
      implementation.grader_version !== grader.grader_version ||
      typeof implementation.grade !== "function"
    ) {
      throw new Error(
        `deterministic grader '${grader.grader_case_id}' descriptor and implementation disagree`
      );
    }
  }
  return {
    descriptor,
    semanticNormalizerDescriptors,
    graderDescriptors,
    semanticNormalizerImplementations: definition.implementations.semantic_normalizers,
    graderImplementations: definition.implementations.graders,
    sha256: sha256(
      canonicalJson({
        descriptor,
        implementation_bindings: gradingImplementationBindings(definition),
      })
    ),
  };
}

export function evaluationGradingDefinitionSha256(
  definition: EvaluationGradingDefinitionV1
): string {
  return validatedEvaluationGradingDefinition(definition).sha256;
}

interface SyntheticGraderCaseV1 {
  readonly grader_case_id: string;
  readonly expected_answer: string;
  readonly protected_capability: boolean;
}

const SYNTHETIC_GRADER_CASES: readonly SyntheticGraderCaseV1[] = [
  {
    grader_case_id: "synthetic-alpha",
    expected_answer: "alpha",
    protected_capability: false,
  },
  {
    grader_case_id: "synthetic-beta",
    expected_answer: "beta",
    protected_capability: false,
  },
  {
    grader_case_id: "synthetic-gamma-protected",
    expected_answer: "gamma",
    protected_capability: true,
  },
  {
    grader_case_id: "synthetic-delta-negative-trigger",
    expected_answer: "delta",
    protected_capability: false,
  },
];

function parseGraderOutput(wireBytes: string, taskId: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireBytes);
  } catch {
    throw new Error("evaluation grading wire is not JSON");
  }
  const output = validateContract(GraderOutputV1Schema, parsed, "evaluation grading wire");
  if (canonicalJson(output) !== wireBytes) {
    throw new Error("evaluation grading wire is not canonical JSON");
  }
  if (output.task_id !== taskId) {
    throw new Error("evaluation grading wire task binding is stale");
  }
  return output;
}

function normalizeSyntheticTrialOutput(input: {
  readonly output_bytes: string;
  readonly task: EvaluationPopulationTaskV1;
}): EvaluationSemanticNormalizationV1 {
  try {
    const firstLine = input.output_bytes.split("\n", 1)[0] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      return { status: "invalid_output", failure_code: "MALFORMED_TRIAL_OUTPUT" };
    }
    const output = validateContract(
      GraderOutputV1Schema,
      parsed,
      "synthetic evaluation trial output"
    );
    if (canonicalJson(output) !== firstLine || output.task_id !== input.task.task_id) {
      return { status: "invalid_output", failure_code: "MALFORMED_TRIAL_OUTPUT" };
    }
    return { status: "normalized", wire_bytes: canonicalJson(output) };
  } catch {
    return { status: "invalid_output", failure_code: "MALFORMED_TRIAL_OUTPUT" };
  }
}

const SYNTHETIC_GRADING_WIRE: EvaluationSemanticWireV1 = {
  schema_id: "penny.synthetic-evaluation-grading-wire.v1",
  schema_version: 1,
};

function syntheticNormalizerDescriptor(
  registrationName: string
): EvaluationSemanticNormalizerDescriptorV1 {
  return {
    schema_version: 1,
    registration_name: registrationName,
    normalizer_id: "penny.synthetic-trial-output-normalizer.v1",
    normalizer_version: 1,
    source_output: {
      artifact_kind: "agent-output",
      schema_id: "penny.evaluation-trial-output.v1",
      schema_version: 1,
    },
    target_wire: SYNTHETIC_GRADING_WIRE,
  };
}

function graderDescriptorForCase(input: SyntheticGraderCaseV1): DeterministicGraderDescriptorV1 {
  return {
    schema_version: 1,
    grader_case_id: input.grader_case_id,
    grader_id: "penny.synthetic-exact-answer-grader.v1",
    grader_version: 1,
    protected_capability: input.protected_capability,
    wire: SYNTHETIC_GRADING_WIRE,
    oracle: { expected_answer: input.expected_answer },
  };
}

const SyntheticGraderOracleV1Schema = Type.Object(
  { expected_answer: Type.String({ minLength: 1, maxLength: 1_024 }) },
  { additionalProperties: false }
);

function syntheticExactAnswerGrade(
  wireBytes: string,
  task: EvaluationPopulationTaskV1,
  descriptor: DeterministicGraderDescriptorV1
): DeterministicGraderResultV1 {
  const oracle = validateContract(
    SyntheticGraderOracleV1Schema,
    descriptor.oracle,
    "synthetic deterministic grader oracle"
  );
  const output = parseGraderOutput(wireBytes, task.task_id);
  const score = output.answer === oracle.expected_answer ? 1 : 0;
  return {
    task_score: score,
    trigger_predicted: output.trigger_predicted,
    protected_capability_score: descriptor.protected_capability ? score : null,
  };
}

const SYNTHETIC_NORMALIZER_IMPLEMENTATION: EvaluationSemanticNormalizerImplementationV1 = {
  normalizer_id: "penny.synthetic-trial-output-normalizer.v1",
  normalizer_version: 1,
  implementation_sha256: sha256("penny.synthetic-trial-output-normalizer.v1:implementation:1"),
  normalize: normalizeSyntheticTrialOutput,
};

const SYNTHETIC_GRADER_IMPLEMENTATION: DeterministicGraderImplementationV1 = {
  grader_id: "penny.synthetic-exact-answer-grader.v1",
  grader_version: 1,
  implementation_sha256: sha256("penny.synthetic-exact-answer-grader.v1:implementation:1"),
  grade: syntheticExactAnswerGrade,
};

const SYNTHETIC_NORMALIZER_DESCRIPTORS = [
  syntheticNormalizerDescriptor(DIRECT_DEMETRI_BASELINE_NAME),
  syntheticNormalizerDescriptor(SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME),
].sort((left, right) => compareKeys(left.registration_name, right.registration_name));

const SYNTHETIC_GRADER_DESCRIPTORS = SYNTHETIC_GRADER_CASES.map(graderDescriptorForCase).sort(
  (left, right) => compareKeys(left.grader_case_id, right.grader_case_id)
);

export const DETERMINISTIC_GRADING_DEFINITION: EvaluationGradingDefinitionV1 = {
  descriptor: {
    schema_version: 1,
    wire: SYNTHETIC_GRADING_WIRE,
    semantic_normalizers: SYNTHETIC_NORMALIZER_DESCRIPTORS,
    graders: SYNTHETIC_GRADER_DESCRIPTORS,
  },
  implementations: {
    semantic_normalizers: new Map([
      [DIRECT_DEMETRI_BASELINE_NAME, SYNTHETIC_NORMALIZER_IMPLEMENTATION],
      [SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME, SYNTHETIC_NORMALIZER_IMPLEMENTATION],
    ]),
    graders: new Map(
      SYNTHETIC_GRADER_CASES.map((graderCase) => [
        graderCase.grader_case_id,
        SYNTHETIC_GRADER_IMPLEMENTATION,
      ])
    ),
  },
};

export const DETERMINISTIC_GRADER_REGISTRY_SHA256 = evaluationGradingDefinitionSha256(
  DETERMINISTIC_GRADING_DEFINITION
);

export type EvaluationRuntimeBindingV1 = PairedEvaluationPlanV1["runtime_binding"];

export interface EvaluationRuntimeMeasurementV1 {
  readonly cost_microusd: number;
  readonly latency_ms: number;
  readonly loopback_provider_calls?: number;
}

export interface MeasuredEvaluationModelClientV1 extends ModelClient {
  readonly runtime_binding: EvaluationRuntimeBindingV1;
  measurement(runId: string): EvaluationRuntimeMeasurementV1;
}

export const EvaluationReadinessCalibrationTaskV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    split: Type.Literal("calibration"),
    task_id: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    }),
    goal: Type.String({ minLength: 1, maxLength: 32_768 }),
    constraints: Type.Record(Type.String(), JsonValueSchema),
    exact_input_artifact_ids: Type.Array(Type.String({ pattern: "^art_[a-f0-9]{64}$" }), {
      maxItems: 64,
      uniqueItems: true,
    }),
    host_only_oracle_markers: Type.Array(Type.String({ minLength: 8, maxLength: 256 }), {
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);
export type EvaluationReadinessCalibrationTaskV1 = Readonly<
  Static<typeof EvaluationReadinessCalibrationTaskV1Schema>
>;

export const EvaluationReadinessCalibrationCohortV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    split: Type.Literal("calibration"),
    cohort_id: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    }),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    scoring: Type.Literal("non_scoring"),
    tasks: Type.Array(EvaluationReadinessCalibrationTaskV1Schema, {
      minItems: 1,
      maxItems: 32,
    }),
  },
  { additionalProperties: false }
);
export type EvaluationReadinessCalibrationCohortV1 = Readonly<
  Static<typeof EvaluationReadinessCalibrationCohortV1Schema>
>;

export function validateEvaluationReadinessCalibrationCohort(
  value: unknown
): EvaluationReadinessCalibrationCohortV1 {
  const cohort = validateContract(
    EvaluationReadinessCalibrationCohortV1Schema,
    value,
    "evaluation readiness calibration cohort"
  );
  const taskIds = cohort.tasks.map((task) => task.task_id);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("evaluation readiness calibration task IDs must be unique");
  }
  const oracleMarkers = cohort.tasks.flatMap((task) => task.host_only_oracle_markers);
  if (new Set(oracleMarkers).size !== oracleMarkers.length) {
    throw new Error("evaluation readiness host-only oracle markers must be cohort-unique");
  }
  return cohort;
}

export function evaluationReadinessCalibrationCohortSha256(value: unknown): string {
  return sha256(canonicalJson(validateEvaluationReadinessCalibrationCohort(value)));
}

export interface EvaluationPreflightInputV1 {
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: EvaluationPopulationV1;
  readonly plan: PairedEvaluationPlanV1;
  readonly gradingDefinition: EvaluationGradingDefinitionV1;
}

export interface EvaluationReadinessPreflightV1 {
  preflight(input: EvaluationPreflightInputV1): Promise<void>;
}

export interface EvaluationCommonWireValidatorV1 {
  (input: {
    readonly descriptor: EvaluationSemanticWireV1;
    readonly wire_bytes: string;
    readonly calibration_task: EvaluationReadinessCalibrationTaskV1;
  }): void;
}

export interface EvaluationModelClientFactoryV1 {
  (input: {
    readonly entry: PairedEvaluationScheduleEntryV1;
    readonly plan: PairedEvaluationPlanV1;
  }): MeasuredEvaluationModelClientV1;
  readonly preflight?: (input: EvaluationPreflightInputV1) => Promise<void>;
}

export const EvaluationTrialFailureCodeV1Schema = Type.Union([
  Type.Literal("MODEL_OUTPUT_FRAMING_INVALID"),
  Type.Literal("MODEL_OUTPUT_JSON_INVALID"),
  Type.Literal("MODEL_OUTPUT_SCHEMA_INVALID"),
  Type.Literal("MODEL_OUTPUT_SEMANTIC_INVALID"),
  Type.Literal("WORKER_WALL_CLOCK_EXHAUSTED"),
  Type.Literal("RUN_WALL_CLOCK_EXHAUSTED"),
  Type.Literal("PROHIBITED_EXTERNAL_TOOL_ATTEMPT"),
  Type.Literal("ROUTING_METADATA_INVALID"),
  Type.Literal("MODEL_TURN_BUDGET_EXHAUSTED"),
  Type.Literal("TOOL_CALL_BUDGET_EXHAUSTED"),
  Type.Literal("MODEL_PROTOCOL_ERROR"),
  Type.Literal("MODEL_EXECUTION_ERROR"),
]);
export type EvaluationTrialFailureCodeV1 = Static<typeof EvaluationTrialFailureCodeV1Schema>;

export interface EvaluationTrialObservationV1 {
  readonly trial_id: string;
  readonly terminal_status: Exclude<EvaluationTrialTerminalStatusV1, "missing" | "malformed">;
  readonly output_ref?: ArtifactRef;
  readonly output_metadata?: OutputArtifactMetadata;
  readonly output_bytes?: string;
  readonly failure_code?: EvaluationTrialFailureCodeV1;
  readonly cost_microusd: number;
  readonly latency_ms: number;
  /** Ephemeral run accounting; immutable terminal journals intentionally omit it. */
  readonly started_new_trial?: boolean;
  readonly loopback_provider_calls?: number;
}

export const EvaluationReadinessFailureCodeV1Schema = Type.Union([
  Type.Literal("READINESS_OBSERVATION_MISSING"),
  Type.Literal("READINESS_TERMINAL_FAILURE"),
  Type.Literal("READINESS_OUTPUT_CONTRACT_INVALID"),
  Type.Literal("READINESS_OUTPUT_STORAGE_INVALID"),
  Type.Literal("READINESS_NORMALIZATION_INVALID"),
  Type.Literal("READINESS_COMMON_WIRE_INVALID"),
]);
export type EvaluationReadinessFailureCodeV1 = Static<
  typeof EvaluationReadinessFailureCodeV1Schema
>;

const EvaluationReadinessNormalizationStatusV1Schema = Type.Union([
  Type.Literal("normalized"),
  Type.Literal("invalid_output"),
  Type.Literal("not_attempted"),
]);

const EvaluationReadinessTrialV1Schema = Type.Object(
  {
    entry: PairedEvaluationScheduleEntryV1Schema,
    terminal_status: EvaluationTrialTerminalStatusV1Schema,
    output_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    terminal_failure_code: Type.Union([EvaluationTrialFailureCodeV1Schema, Type.Null()]),
    normalization_status: EvaluationReadinessNormalizationStatusV1Schema,
    normalization_failure_code: Type.Union([
      Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }),
      Type.Null(),
    ]),
    common_wire_validated: Type.Boolean(),
    oracle_isolation_validated: Type.Literal(true),
    state_root_validated: Type.Literal(true),
    readiness_failure_code: Type.Union([EvaluationReadinessFailureCodeV1Schema, Type.Null()]),
    cost_microusd: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    latency_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    started_new_trial: Type.Boolean(),
    resumed_existing_run: Type.Boolean(),
    adopted_existing_output: Type.Boolean(),
    loopback_provider_calls: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    common_wire_sha256: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
  },
  { additionalProperties: false }
);
export type EvaluationReadinessTrialV1 = Readonly<Static<typeof EvaluationReadinessTrialV1Schema>>;

const EvaluationReadinessArmV1Schema = Type.Object(
  {
    variant: Type.Union([
      Type.Literal("baseline"),
      Type.Literal("candidate"),
      Type.Literal("ablation"),
    ]),
    registration_name: Type.String({ minLength: 1, maxLength: 256 }),
    binding_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    scheduled_trials: Type.Integer({ minimum: 1, maximum: 4_096 }),
    normalized_completions: Type.Integer({ minimum: 0, maximum: 4_096 }),
    incomplete_or_failed_trials: Type.Integer({ minimum: 0, maximum: 4_096 }),
    normalized_completion_rate: Type.Number({ minimum: 0, maximum: 1 }),
    frozen_floor: Type.Number({ minimum: 0.9, maximum: 1 }),
    passed: Type.Boolean(),
  },
  { additionalProperties: false }
);

const EvaluationReadinessFailureV1Schema = Type.Object(
  {
    trial_id: Type.String({ pattern: "^evaltrial_[a-f0-9]{64}$" }),
    task_id: Type.String({ minLength: 1, maxLength: 256 }),
    registration_name: Type.String({ minLength: 1, maxLength: 256 }),
    code: EvaluationReadinessFailureCodeV1Schema,
    detail_code: Type.Union([Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const EvaluationReadinessResultV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    readiness_result_id: Type.String({ pattern: "^evalready_[a-f0-9]{64}$" }),
    plan_id: Type.String({ minLength: 1, maxLength: 256 }),
    plan_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    schedule_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    implementation_binding_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    calibration_cohort: Type.Object(
      {
        cohort_id: Type.String({ minLength: 1, maxLength: 256 }),
        revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        task_count: Type.Integer({ minimum: 1, maximum: 32 }),
        repetitions: Type.Integer({ minimum: 1, maximum: 4 }),
      },
      { additionalProperties: false }
    ),
    state_binding: Type.Object(
      {
        state_root: Type.String({ minLength: 1, maxLength: 4_096 }),
        project_id: Type.String({ minLength: 1, maxLength: 256 }),
        artifact_root: Type.String({ minLength: 1, maxLength: 4_096 }),
      },
      { additionalProperties: false }
    ),
    runtime_binding: PairedEvaluationPlanV1Schema.properties.runtime_binding,
    candidate_binding: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 256 }),
        contract_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      },
      { additionalProperties: false }
    ),
    baseline_binding: Type.Object(
      {
        registration_name: Type.String({ minLength: 1, maxLength: 256 }),
        definition_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      },
      { additionalProperties: false }
    ),
    ablation_bindings: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 256 }),
          contract_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        },
        { additionalProperties: false }
      ),
      { maxItems: 16 }
    ),
    trials: Type.Array(EvaluationReadinessTrialV1Schema, { minItems: 2, maxItems: 4_096 }),
    arms: Type.Array(EvaluationReadinessArmV1Schema, { minItems: 2, maxItems: 18 }),
    complete_all_arm_pairs: Type.Object(
      {
        scheduled_pairs: Type.Integer({ minimum: 1, maximum: 1_024 }),
        complete_pairs: Type.Integer({ minimum: 0, maximum: 1_024 }),
        incomplete_pairs: Type.Integer({ minimum: 0, maximum: 1_024 }),
        coverage: Type.Number({ minimum: 0, maximum: 1 }),
        frozen_floor: EvaluationReadinessPairFloorV1Schema,
        passed: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
    failures: Type.Array(EvaluationReadinessFailureV1Schema, { maxItems: 4_096 }),
    common_wire_validation: Type.Object(
      {
        required: Type.Literal(true),
        attempted_trials: Type.Integer({ minimum: 0, maximum: 4_096 }),
        passed_trials: Type.Integer({ minimum: 0, maximum: 4_096 }),
        failed_trials: Type.Integer({ minimum: 0, maximum: 4_096 }),
        all_passed: Type.Boolean(),
      },
      { additionalProperties: false }
    ),
    oracle_isolation: Type.Object(
      {
        required: Type.Literal(true),
        host_only_marker_count: Type.Integer({ minimum: 1, maximum: 1_024 }),
        model_visible_tasks_checked: Type.Integer({ minimum: 1, maximum: 32 }),
        input_artifacts_checked: Type.Integer({ minimum: 0, maximum: 2_048 }),
        passed: Type.Literal(true),
      },
      { additionalProperties: false }
    ),
    state_root_validation: Type.Object(
      {
        required: Type.Literal(true),
        checked_trials: Type.Integer({ minimum: 2, maximum: 4_096 }),
        passed: Type.Literal(true),
      },
      { additionalProperties: false }
    ),
    execution_accounting: Type.Object(
      {
        newly_started_trials: Type.Integer({ minimum: 0, maximum: 4_096 }),
        resumed_existing_runs: Type.Integer({ minimum: 0, maximum: 4_096 }),
        adopted_existing_outputs: Type.Integer({ minimum: 0, maximum: 4_096 }),
        loopback_provider_calls: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        total_cost_microusd: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        total_latency_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      },
      { additionalProperties: false }
    ),
    passed: Type.Boolean(),
  },
  { additionalProperties: false }
);
export type EvaluationReadinessResultV1 = Readonly<
  Static<typeof EvaluationReadinessResultV1Schema>
>;

export interface EvaluationReadinessRunV1 {
  readonly result: EvaluationReadinessResultV1;
  readonly result_artifact_ref: ArtifactRef;
}

export interface EvaluationTrialExecutorV1 {
  preflight?(input: EvaluationPreflightInputV1): Promise<void>;
  execute(input: {
    readonly entry: PairedEvaluationScheduleEntryV1;
    readonly task: EvaluationPopulationTaskV1;
    readonly plan: PairedEvaluationPlanV1;
    readonly frozen: FrozenPairedEvaluationV1;
  }): Promise<EvaluationTrialObservationV1 | undefined>;
}

const EvaluationTrialJournalRecordV1Schema = Type.Object(
  {
    schema_version: Type.Literal(1),
    schedule_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    entry_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    trial_id: Type.String({ pattern: "^evaltrial_[a-f0-9]{64}$" }),
    terminal_status: Type.Union([
      Type.Literal("complete"),
      Type.Literal("missing"),
      Type.Literal("nonterminal"),
      Type.Literal("cancelled"),
      Type.Literal("error"),
    ]),
    output_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
    failure_code: Type.Union([EvaluationTrialFailureCodeV1Schema, Type.Null()]),
    cost_microusd: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    latency_ms: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false }
);
type EvaluationTrialJournalRecordV1 = Readonly<Static<typeof EvaluationTrialJournalRecordV1Schema>>;

type EvaluationBoundFunctionV1 = (...args: never[]) => unknown;

export interface EvaluationImplementationFileInputV1 {
  readonly role: EvaluationImplementationFileRoleV1;
  readonly owner: string;
  readonly path: string;
}

export interface EvaluationRuntimeFunctionBindingV1 {
  readonly role: EvaluationRuntimeFunctionRoleV1;
  readonly owner: string;
  readonly implementation: EvaluationBoundFunctionV1;
}

function evaluationFunctionDescriptor(
  implementation: EvaluationBoundFunctionV1
): EvaluationFunctionDescriptorV1 {
  const tag = Object.prototype.toString.call(implementation);
  const functionKind =
    tag === "[object AsyncFunction]"
      ? "async"
      : tag === "[object GeneratorFunction]"
        ? "generator"
        : tag === "[object AsyncGeneratorFunction]"
          ? "async_generator"
          : "sync";
  const identity = {
    name: implementation.name.length === 0 ? "<anonymous>" : implementation.name,
    arity: implementation.length,
    function_kind: functionKind,
  };
  const descriptorBytes = canonicalJson(identity);
  return validateContract(
    EvaluationFunctionDescriptorV1Schema,
    {
      schema_version: 1,
      ...identity,
      descriptor_byte_length: Buffer.byteLength(descriptorBytes, "utf8"),
      descriptor_sha256: sha256(descriptorBytes),
    },
    "evaluation function descriptor"
  );
}

function canonicalProjectRelativeFilePath(relativePath: string): string {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\u0000") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.endsWith("/") ||
    relativePath
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(
      `evaluation implementation path '${relativePath}' is not canonical project-relative`
    );
  }
  return relativePath;
}

function implementationFileDescriptor(input: {
  readonly projectRoot: string;
  readonly file: EvaluationImplementationFileInputV1;
}) {
  const relativePath = canonicalProjectRelativeFilePath(input.file.path);
  const root = realpathSync(input.projectRoot);
  let candidate = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    candidate = path.join(candidate, segment);
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) {
      throw new Error(`evaluation implementation path '${relativePath}' contains a symbolic link`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(
        `evaluation implementation path '${relativePath}' has a non-directory parent`
      );
    }
  }
  const resolved = realpathSync(candidate);
  if (!isWithinRoot(root, resolved)) {
    throw new Error(`evaluation implementation path '${relativePath}' escapes the project root`);
  }
  const before = lstatSync(candidate);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 16_777_216) {
    throw new Error(
      `evaluation implementation path '${relativePath}' is not one bounded regular file`
    );
  }
  const bytes = readFileSync(candidate);
  const after = lstatSync(candidate);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.size !== bytes.byteLength ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    realpathSync(candidate) !== resolved
  ) {
    throw new Error(`evaluation implementation path '${relativePath}' changed during digesting`);
  }
  return {
    schema_version: 1 as const,
    role: input.file.role,
    owner: input.file.owner,
    path: relativePath,
    byte_length: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function registrationGuidancePaths(registration: PlaybookRegistrationV1): readonly string[] {
  return exactSortedKeys(
    [...registration.worker.phases.entries()].map(([phase, descriptor]) => {
      const suffix =
        registration.worker.guidance.resolution === "per_agent_phase"
          ? `${descriptor.agent}-${phase}.md`
          : `${descriptor.agent}.md`;
      return `${registration.worker.guidance.skill_root}/${suffix}`;
    })
  );
}

function registrationAgentDefinitionPaths(registration: PlaybookRegistrationV1): readonly string[] {
  return exactSortedKeys(
    [...registration.worker.phases.values()].map(
      (descriptor) => `.pi/agents/${descriptor.agent}.md`
    )
  );
}

function schemaDigestDescriptor(role: string, schema: unknown) {
  const bytes = canonicalJson(schema);
  const byteLength = Buffer.byteLength(bytes, "utf8");
  if (byteLength < 1 || byteLength > 1_048_576) {
    throw new Error(`evaluation runtime schema '${role}' is outside its byte bound`);
  }
  return { role, canonical_byte_length: byteLength, sha256: sha256(bytes) };
}

function registrationProbeConstraints(input: {
  readonly role: "baseline" | "candidate" | "ablation";
  readonly task: EvaluationPopulationTaskV1;
}): Readonly<Record<string, JsonValue>> {
  return input.role === "baseline"
    ? {
        evaluation_plan_id: "evaluation-implementation-probe",
        schedule_sha256: "0".repeat(64),
        task_id: input.task.task_id,
        repetition: 1,
        variant: "baseline",
        task_constraints: input.task.constraints,
        model_override: "evaluation-implementation-probe/model",
      }
    : input.task.constraints;
}

function registrationProbeContext(input: {
  readonly role: "baseline" | "candidate" | "ablation";
  readonly registration: PlaybookRegistrationV1;
  readonly task: EvaluationPopulationTaskV1;
  readonly ordinal: number;
  readonly projectRoot: string;
}): RunContext {
  const identitySha256 = sha256(
    canonicalJson({
      registration_name: input.registration.name,
      role: input.role,
      task_id: input.task.task_id,
      ordinal: input.ordinal,
    })
  );
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: `evaltrial_${identitySha256}`,
      session_id: `evaltrial_${identitySha256}`,
      playbook: input.registration.name,
      engine_owner: "typescript",
    },
    goal: input.task.goal,
    constraints: registrationProbeConstraints({ role: input.role, task: input.task }),
    projectRoot: input.projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
}

function registrationConstructProbeSha256(input: {
  readonly role: "baseline" | "candidate" | "ablation";
  readonly registration: PlaybookRegistrationV1;
  readonly tasks: readonly EvaluationPopulationTaskV1[];
  readonly projectRoot: string;
}): string {
  const probes = input.tasks.map((task, index) => {
    const context = registrationProbeContext({
      role: input.role,
      registration: input.registration,
      task,
      ordinal: index,
      projectRoot: input.projectRoot,
    });
    const playbook = input.registration.construct({});
    const coreSurface = {
      initialize: evaluationFunctionDescriptor(playbook.initialize),
      dispatch: evaluationFunctionDescriptor(playbook.dispatch),
      resume: evaluationFunctionDescriptor(playbook.resume),
      cancel: evaluationFunctionDescriptor(playbook.cancel),
      accept_summary: evaluationFunctionDescriptor(playbook.acceptSummary),
      rebind_pending_directive: evaluationFunctionDescriptor(playbook.rebindPendingDirective),
    };
    try {
      return {
        status: "initialized" as const,
        core_surface: coreSurface,
        directive: playbook.initialize(context),
      };
    } catch {
      return { status: "construction_only" as const, core_surface: coreSurface };
    }
  });
  return sha256(canonicalJson(probes));
}

function registrationPrepareProbeSha256(input: {
  readonly role: "baseline" | "candidate" | "ablation";
  readonly registration: PlaybookRegistrationV1;
  readonly tasks: readonly EvaluationPopulationTaskV1[];
  readonly projectRoot: string;
}): string | null {
  const startAdmission = input.registration.start_admission;
  if (startAdmission === undefined) return null;
  const probes = input.tasks.map((task, index) => {
    const context = registrationProbeContext({
      role: input.role,
      registration: input.registration,
      task,
      ordinal: index,
      projectRoot: input.projectRoot,
    });
    return startAdmission.prepare(
      {
        schema_version: 2,
        action: "start",
        identity: context.identity,
        goal: task.goal,
        constraints: registrationProbeConstraints({ role: input.role, task }),
        project_root: input.projectRoot,
        trust_profile: "hardened-untrusted",
      },
      {}
    );
  });
  return sha256(canonicalJson(probes));
}

function registrationLivenessProbeSha256(input: {
  readonly role: "baseline" | "candidate" | "ablation";
  readonly registration: PlaybookRegistrationV1;
  readonly tasks: readonly EvaluationPopulationTaskV1[];
  readonly projectRoot: string;
}): string {
  const probes = input.tasks.map((task, index) =>
    input.registration.liveness.resolve(
      registrationProbeContext({
        role: input.role,
        registration: input.registration,
        task,
        ordinal: index,
        projectRoot: input.projectRoot,
      })
    )
  );
  return sha256(canonicalJson(probes));
}

function registrationImplementationDescriptor(input: {
  readonly role: "baseline" | "candidate" | "ablation";
  readonly registration: PlaybookRegistrationV1;
  readonly tasks: readonly EvaluationPopulationTaskV1[];
  readonly projectRoot: string;
}) {
  const registration = input.registration;
  const worker = registration.worker;
  const phases =
    worker.kind === "catalog-agent"
      ? [...worker.phases.entries()]
          .sort(([left], [right]) => compareKeys(left, right))
          .map(([phase, descriptor]) => ({
            phase,
            agent: descriptor.agent,
            result_schema_id: descriptor.result_schema_id,
            result_schema_version: descriptor.result_schema_version,
            schema_canonical_byte_length: Buffer.byteLength(
              canonicalJson(descriptor.schema),
              "utf8"
            ),
            schema_sha256: sha256(canonicalJson(descriptor.schema)),
          }))
      : [...worker.phases.entries()]
          .sort(([left], [right]) => compareKeys(left, right))
          .map(([phase, descriptor]) => ({
            phase,
            agent: descriptor.agent,
            validate: evaluationFunctionDescriptor(descriptor.validate),
          }));
  const startAdmission = registration.start_admission;
  return {
    schema_version: 1 as const,
    role: input.role,
    registration_name: registration.name,
    contract_sha256: skillContractSha256(registration.contract),
    ingress: registration.ingress,
    start_admission:
      startAdmission === undefined
        ? null
        : {
            schema_id: startAdmission.schema_id,
            schema_version: startAdmission.schema_version,
            prepare: evaluationFunctionDescriptor(startAdmission.prepare),
            materialize: evaluationFunctionDescriptor(startAdmission.materialize),
            prepare_probe_sha256: registrationPrepareProbeSha256(input),
          },
    liveness: {
      resolver_id: registration.liveness.resolver_id,
      resolve: evaluationFunctionDescriptor(registration.liveness.resolve),
      policy_probe_sha256: registrationLivenessProbeSha256(input),
      thinking_policy: registration.liveness.thinking_policy,
    },
    worker: {
      kind: registration.worker.kind,
      workflow_name: registration.worker.workflow_name,
      guidance: registration.worker.guidance,
      guidance_required: registration.worker.guidance_required,
      result_transport: registration.worker.result_transport,
      opening_policy: registration.worker.opening_policy,
      model_policy: registration.worker.model_policy,
      phases,
    },
    completion_predicates: [...registration.completionReceiptPredicates.entries()]
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([predicateId, implementation]) => ({
        predicate_id: predicateId,
        implementation: evaluationFunctionDescriptor(implementation),
      })),
    construct: evaluationFunctionDescriptor(registration.construct),
    construct_probe_sha256: registrationConstructProbeSha256(input),
  };
}

function resolvedEvaluationRegistrations(input: {
  readonly plan: PairedEvaluationPlanV1;
  readonly baselineRegistration: PlaybookRegistrationV1;
  readonly candidateRegistry: PlaybookRegistryV1;
  readonly ablationRegistry: PlaybookRegistryV1;
}): readonly {
  readonly role: "baseline" | "candidate" | "ablation";
  readonly registration: PlaybookRegistrationV1;
}[] {
  const candidate = resolveEvaluationCandidate({
    name: input.plan.candidate.name,
    contract_sha256: input.plan.candidate.contract_sha256,
    registry: input.candidateRegistry,
  });
  if (candidate === undefined) {
    throw new Error("evaluation implementation candidate registration is unavailable or stale");
  }
  const ablations = input.plan.ablations.map((ablation) => {
    const registration = resolveEvaluationCandidate({
      name: ablation.name,
      contract_sha256: ablation.contract_sha256,
      registry: input.ablationRegistry,
    });
    if (registration === undefined) {
      throw new Error(
        `evaluation implementation ablation '${ablation.name}' is unavailable or stale`
      );
    }
    return { role: "ablation" as const, registration };
  });
  const evaluationOnlyControl = input.plan.mutation_gate?.evaluation_only_control;
  if (evaluationOnlyControl !== undefined) {
    const registration = resolveEvaluationCandidate({
      name: evaluationOnlyControl.name,
      contract_sha256: evaluationOnlyControl.contract_sha256,
      registry: input.ablationRegistry,
    });
    if (registration === undefined) {
      throw new Error(
        `evaluation implementation mutation control '${evaluationOnlyControl.name}' is unavailable or stale`
      );
    }
    ablations.push({ role: "ablation", registration });
  }
  return [
    { role: "baseline" as const, registration: input.baselineRegistration },
    { role: "candidate" as const, registration: candidate },
    ...ablations,
  ].sort((left, right) => compareKeys(left.registration.name, right.registration.name));
}

function requireImplementationFileRole(input: {
  readonly files: readonly EvaluationImplementationFileInputV1[];
  readonly owner: string;
  readonly role: EvaluationImplementationFileRoleV1;
}): void {
  if (!input.files.some((file) => file.owner === input.owner && file.role === input.role)) {
    throw new Error(`evaluation implementation binding omits ${input.role} for '${input.owner}'`);
  }
}

function assertImplementationFileCoverage(input: {
  readonly files: readonly EvaluationImplementationFileInputV1[];
  readonly registrations: readonly {
    readonly role: "baseline" | "candidate" | "ablation";
    readonly registration: PlaybookRegistrationV1;
  }[];
  readonly grading: ValidatedEvaluationGradingDefinitionV1;
}): void {
  const keys = input.files.map((file) => `${file.role}\u0000${file.owner}\u0000${file.path}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("evaluation implementation file bindings must be unique");
  }
  for (const { role, registration } of input.registrations) {
    requireImplementationFileRole({
      files: input.files,
      owner: registration.name,
      role: "registration_source",
    });
    const actualGuidance = input.files
      .filter((file) => file.owner === registration.name && file.role === "registration_guidance")
      .map((file) => canonicalProjectRelativeFilePath(file.path))
      .sort(compareKeys);
    const actualAgents = input.files
      .filter((file) => file.owner === registration.name && file.role === "agent_definition")
      .map((file) => canonicalProjectRelativeFilePath(file.path))
      .sort(compareKeys);
    if (
      canonicalJson(actualGuidance) !== canonicalJson(registrationGuidancePaths(registration)) ||
      canonicalJson(actualAgents) !== canonicalJson(registrationAgentDefinitionPaths(registration))
    ) {
      throw new Error(
        `evaluation implementation guidance or agent-definition files drifted for '${registration.name}'`
      );
    }
    if (role !== "baseline") {
      for (const requiredRole of [
        "contract_source",
        "playbook_source",
        "validator_source",
        "composition_source",
      ] as const) {
        requireImplementationFileRole({
          files: input.files,
          owner: registration.name,
          role: requiredRole,
        });
      }
    }
  }
  for (const registrationName of input.grading.semanticNormalizerDescriptors.keys()) {
    requireImplementationFileRole({
      files: input.files,
      owner: registrationName,
      role: "normalizer_source",
    });
  }
  for (const graderCaseId of input.grading.graderDescriptors.keys()) {
    requireImplementationFileRole({
      files: input.files,
      owner: graderCaseId,
      role: "grader_source",
    });
  }
  for (const role of ["evaluator_source", "worker_source", "artifact_preflight_source"] as const) {
    requireImplementationFileRole({
      files: input.files,
      owner: "evaluation-runtime",
      role,
    });
  }
}

function runtimeSchemaDescriptors(includeReadinessResult: boolean) {
  return [
    schemaDigestDescriptor("deterministic_grader_result", DeterministicGraderResultV1Schema),
    schemaDigestDescriptor(
      "evaluation_implementation_binding",
      EvaluationImplementationBindingV1Schema
    ),
    schemaDigestDescriptor("evaluation_population", EvaluationPopulationV1Schema),
    schemaDigestDescriptor(
      "evaluation_readiness_calibration_cohort",
      EvaluationReadinessCalibrationCohortV1Schema
    ),
    schemaDigestDescriptor(
      "evaluation_readiness_calibration_task",
      EvaluationReadinessCalibrationTaskV1Schema
    ),
    ...(includeReadinessResult
      ? [schemaDigestDescriptor("evaluation_readiness_result", EvaluationReadinessResultV1Schema)]
      : []),
    schemaDigestDescriptor("evaluation_result", PairedEvaluationResultV1Schema),
    schemaDigestDescriptor(
      "evaluation_semantic_normalization",
      EvaluationSemanticNormalizationV1Schema
    ),
    schemaDigestDescriptor("evaluation_trial_journal", EvaluationTrialJournalRecordV1Schema),
    schemaDigestDescriptor("frozen_evaluation", FrozenPairedEvaluationV1Schema),
    schemaDigestDescriptor("paired_evaluation_plan", PairedEvaluationPlanV1Schema),
  ].sort((left, right) => compareKeys(left.role, right.role));
}

export function createEvaluationImplementationBinding(input: {
  readonly projectRoot: string;
  readonly population: unknown;
  readonly plan: unknown;
  readonly baselineRegistration: PlaybookRegistrationV1;
  readonly candidateRegistry: PlaybookRegistryV1;
  readonly ablationRegistry?: PlaybookRegistryV1;
  readonly gradingDefinition?: EvaluationGradingDefinitionV1;
  readonly files: readonly EvaluationImplementationFileInputV1[];
  readonly runtimeFunctions: readonly EvaluationRuntimeFunctionBindingV1[];
}): EvaluationImplementationBindingV1 {
  const population = validateEvaluationPopulation(input.population);
  const plan = validatePairedEvaluationPlan(input.plan);
  const grading = validatedEvaluationGradingDefinition(
    input.gradingDefinition ?? DETERMINISTIC_GRADING_DEFINITION
  );
  const registrations = resolvedEvaluationRegistrations({
    plan,
    baselineRegistration: input.baselineRegistration,
    candidateRegistry: input.candidateRegistry,
    ablationRegistry: input.ablationRegistry ?? new Map(),
  });
  assertImplementationFileCoverage({ files: input.files, registrations, grading });
  const requiredRuntimeRoles: readonly EvaluationRuntimeFunctionRoleV1[] = [
    "artifact_preflight",
    "model_client_factory",
    "model_preflight",
    ...(plan.comparison_validity_policy.readiness_preflight.required
      ? (["readiness_preflight", "readiness_common_wire_validator"] as const)
      : []),
    "trial_executor_execute",
    "trial_executor_preflight",
  ];
  const runtimeRoles = input.runtimeFunctions.map((entry) => entry.role);
  if (
    new Set(runtimeRoles).size !== runtimeRoles.length ||
    requiredRuntimeRoles.some((role) => !runtimeRoles.includes(role))
  ) {
    throw new Error(
      "evaluation implementation runtime functions omit or duplicate a material role"
    );
  }
  const binding = {
    schema_version: 1 as const,
    files: input.files
      .map((file) => implementationFileDescriptor({ projectRoot: input.projectRoot, file }))
      .sort((left, right) =>
        compareKeys(
          `${left.role}\u0000${left.owner}\u0000${left.path}`,
          `${right.role}\u0000${right.owner}\u0000${right.path}`
        )
      ),
    registrations: registrations.map((entry) =>
      registrationImplementationDescriptor({
        ...entry,
        tasks: population.tasks,
        projectRoot: input.projectRoot,
      })
    ),
    grading: {
      schema_version: 1 as const,
      descriptor_sha256: sha256(canonicalJson(grading.descriptor)),
      semantic_normalizers: [...grading.semanticNormalizerDescriptors.keys()]
        .sort(compareKeys)
        .map((registrationName) => {
          const implementation = grading.semanticNormalizerImplementations.get(registrationName);
          if (implementation === undefined) {
            throw new Error(`semantic normalizer '${registrationName}' implementation is absent`);
          }
          return {
            registration_name: registrationName,
            normalizer_id: implementation.normalizer_id,
            normalizer_version: implementation.normalizer_version,
            declared_implementation_sha256: declaredImplementationSha256({
              implementationId: implementation.normalizer_id,
              implementationVersion: implementation.normalizer_version,
              implementationSha256: implementation.implementation_sha256,
            }),
            normalize: evaluationFunctionDescriptor(implementation.normalize),
          };
        }),
      graders: [...grading.graderDescriptors.keys()].sort(compareKeys).map((graderCaseId) => {
        const implementation = grading.graderImplementations.get(graderCaseId);
        if (implementation === undefined) {
          throw new Error(`deterministic grader '${graderCaseId}' implementation is absent`);
        }
        return {
          grader_case_id: graderCaseId,
          grader_id: implementation.grader_id,
          grader_version: implementation.grader_version,
          declared_implementation_sha256: declaredImplementationSha256({
            implementationId: implementation.grader_id,
            implementationVersion: implementation.grader_version,
            implementationSha256: implementation.implementation_sha256,
          }),
          grade: evaluationFunctionDescriptor(implementation.grade),
          ...(implementation.qualifySemanticReview === undefined
            ? {}
            : {
                qualify_semantic_review: evaluationFunctionDescriptor(
                  implementation.qualifySemanticReview
                ),
              }),
        };
      }),
    },
    runtime_functions: [...input.runtimeFunctions]
      .sort((left, right) =>
        compareKeys(`${left.role}\u0000${left.owner}`, `${right.role}\u0000${right.owner}`)
      )
      .map((entry) => ({
        role: entry.role,
        owner: entry.owner,
        implementation: evaluationFunctionDescriptor(entry.implementation),
      })),
    runtime_schemas: runtimeSchemaDescriptors(
      plan.comparison_validity_policy.readiness_preflight.required
    ),
  };
  return validateContract(
    EvaluationImplementationBindingV1Schema,
    binding,
    "EvaluationImplementationBindingV1"
  );
}

export function evaluationImplementationBindingSha256(value: unknown): string {
  return sha256(
    canonicalJson(
      validateContract(
        EvaluationImplementationBindingV1Schema,
        value,
        "EvaluationImplementationBindingV1"
      )
    )
  );
}

function assertEvaluationImplementationBinding(input: {
  readonly binding: unknown;
  readonly runtimeFunctions: readonly EvaluationRuntimeFunctionBindingV1[];
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: ReturnType<typeof validateEvaluationPopulation>;
  readonly plan: PairedEvaluationPlanV1;
  readonly projectRoot: string;
  readonly baselineRegistration: PlaybookRegistrationV1;
  readonly candidateRegistry: PlaybookRegistryV1;
  readonly ablationRegistry: PlaybookRegistryV1;
  readonly gradingDefinition: EvaluationGradingDefinitionV1;
}): EvaluationImplementationBindingV1 {
  const binding = validateContract(
    EvaluationImplementationBindingV1Schema,
    input.binding,
    "EvaluationImplementationBindingV1"
  );
  const bindingSha256 = evaluationImplementationBindingSha256(binding);
  if (
    bindingSha256 !== input.plan.implementation_binding_sha256 ||
    bindingSha256 !== input.frozen.implementation_binding_sha256
  ) {
    throw new Error("complete evaluation implementation binding drifted from the frozen plan");
  }
  const actual = createEvaluationImplementationBinding({
    projectRoot: input.projectRoot,
    population: input.population,
    plan: input.plan,
    baselineRegistration: input.baselineRegistration,
    candidateRegistry: input.candidateRegistry,
    ablationRegistry: input.ablationRegistry,
    gradingDefinition: input.gradingDefinition,
    files: binding.files.map((file) => ({ role: file.role, owner: file.owner, path: file.path })),
    runtimeFunctions: input.runtimeFunctions,
  });
  if (canonicalJson(actual) !== canonicalJson(binding)) {
    throw new Error(
      "evaluation implementation files, functions, schemas, or registrations drifted"
    );
  }
  return binding;
}

export interface EvaluationTrialJournalLoadV1 {
  readonly recorded: boolean;
  readonly observation?: EvaluationTrialObservationV1;
}

export interface EvaluationTrialJournalV1 {
  load(entry: PairedEvaluationScheduleEntryV1): EvaluationTrialJournalLoadV1;
  record(
    entry: PairedEvaluationScheduleEntryV1,
    observation: EvaluationTrialObservationV1 | undefined
  ): EvaluationTrialJournalLoadV1;
}

function journalOperationId(scheduleSha256: string, trialId: string): string {
  return `paired-evaluation-observation:${scheduleSha256}:${trialId}`;
}

export class ArtifactEvaluationTrialJournal implements EvaluationTrialJournalV1, Disposable {
  private readonly artifacts: ArtifactStore;
  private closed = false;

  constructor(
    private readonly options: {
      readonly projectRoot: string;
      readonly env: NodeJS.ProcessEnv;
      readonly frozen: FrozenPairedEvaluationV1;
    }
  ) {
    const state = resolvePennyRuntimeState(options.projectRoot, { env: options.env });
    this.artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
  }

  load(entry: PairedEvaluationScheduleEntryV1): EvaluationTrialJournalLoadV1 {
    const ref = this.artifacts.refFor(
      entry.trial_id,
      "evaluation",
      null,
      "evaluation-trial-observation",
      journalOperationId(this.options.frozen.schedule_sha256, entry.trial_id),
      1
    );
    if (ref === null) return { recorded: false };
    const bytes = this.artifacts.read(ref).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new Error(`evaluation trial journal '${entry.trial_id}' is not JSON`);
    }
    const record = validateContract(
      EvaluationTrialJournalRecordV1Schema,
      parsed,
      "evaluation trial journal record"
    );
    if (
      canonicalJson(record) !== bytes ||
      record.schedule_sha256 !== this.options.frozen.schedule_sha256 ||
      record.entry_sha256 !== sha256(canonicalJson(entry)) ||
      record.trial_id !== entry.trial_id
    ) {
      throw new Error(`evaluation trial journal '${entry.trial_id}' is stale or non-canonical`);
    }
    if (record.terminal_status === "missing") return { recorded: true };
    if ((record.terminal_status === "complete") !== (record.failure_code === null)) {
      throw new Error(
        `evaluation trial journal '${entry.trial_id}' has inconsistent terminal diagnostics`
      );
    }
    const outputRef = record.output_ref;
    if (record.terminal_status === "complete" && outputRef === null) {
      throw new Error(`completed evaluation trial journal '${entry.trial_id}' has no output ref`);
    }
    let outputBytes: string | undefined;
    let outputMetadata: OutputArtifactMetadata | undefined;
    if (outputRef !== null) {
      const stored = this.artifacts.refById(outputRef.artifact_id);
      if (stored === undefined || canonicalJson(stored) !== canonicalJson(outputRef)) {
        throw new Error(`evaluation trial journal output '${outputRef.artifact_id}' is stale`);
      }
      outputMetadata = verifiedOutputMetadata(this.artifacts, stored);
      outputBytes = this.artifacts.read(stored).toString("utf8");
    }
    return {
      recorded: true,
      observation: {
        trial_id: entry.trial_id,
        terminal_status: record.terminal_status,
        ...(outputRef === null ? {} : { output_ref: outputRef }),
        ...(outputMetadata === undefined ? {} : { output_metadata: outputMetadata }),
        ...(record.terminal_status === "complete" && outputBytes !== undefined
          ? { output_bytes: outputBytes }
          : {}),
        ...(record.failure_code === null ? {} : { failure_code: record.failure_code }),
        cost_microusd: record.cost_microusd,
        latency_ms: record.latency_ms,
      },
    };
  }

  record(
    entry: PairedEvaluationScheduleEntryV1,
    observation: EvaluationTrialObservationV1 | undefined
  ): EvaluationTrialJournalLoadV1 {
    if (observation !== undefined && observation.trial_id !== entry.trial_id) {
      throw new Error("evaluation journal observation does not match its schedule entry");
    }
    if (
      observation?.terminal_status === "complete" &&
      (observation.output_ref === undefined ||
        observation.output_metadata === undefined ||
        observation.output_bytes === undefined ||
        observation.failure_code !== undefined)
    ) {
      throw new Error(
        "completed evaluation journal observation requires exact output bytes/ref and no failure code"
      );
    }
    if (
      observation !== undefined &&
      observation.terminal_status !== "complete" &&
      observation.failure_code === undefined
    ) {
      throw new Error("noncomplete evaluation journal observation requires a closed failure code");
    }
    if (observation?.output_ref !== undefined) {
      const stored = this.artifacts.refById(observation.output_ref.artifact_id);
      if (stored === undefined || canonicalJson(stored) !== canonicalJson(observation.output_ref)) {
        throw new Error(
          `evaluation journal output '${observation.output_ref.artifact_id}' is stale`
        );
      }
      const storedMetadata = verifiedOutputMetadata(this.artifacts, stored);
      if (
        observation.output_metadata !== undefined &&
        canonicalJson(storedMetadata) !== canonicalJson(observation.output_metadata)
      ) {
        throw new Error("evaluation journal output metadata diverged from immutable storage");
      }
      const storedBytes = this.artifacts.read(stored).toString("utf8");
      if (observation.terminal_status === "complete" && storedBytes !== observation.output_bytes) {
        throw new Error("evaluation journal complete output bytes diverged from immutable storage");
      }
    }
    const record: EvaluationTrialJournalRecordV1 = validateContract(
      EvaluationTrialJournalRecordV1Schema,
      {
        schema_version: 1,
        schedule_sha256: this.options.frozen.schedule_sha256,
        entry_sha256: sha256(canonicalJson(entry)),
        trial_id: entry.trial_id,
        terminal_status: observation?.terminal_status ?? "missing",
        output_ref: observation?.output_ref ?? null,
        failure_code: observation?.failure_code ?? null,
        cost_microusd: observation?.cost_microusd ?? 0,
        latency_ms: observation?.latency_ms ?? 0,
      },
      "evaluation trial journal record"
    );
    const content = canonicalJson(record);
    const ref = this.artifacts.persist({
      metadata: {
        schema_version: 2,
        run_id: entry.trial_id,
        phase: "evaluation",
        branch_id: null,
        kind: "evaluation-trial-observation",
        operation_id: journalOperationId(this.options.frozen.schedule_sha256, entry.trial_id),
        version: 1,
        producer: "host:evaluation-runner",
        media_type: "application/json",
        content_schema: {
          schema_id: "penny.evaluation-trial-observation.v1",
          schema_version: 1,
        },
        parent_ref: null,
        upstream_refs: observation?.output_ref === undefined ? [] : [observation.output_ref],
      },
      content,
    });
    if (this.artifacts.read(ref).toString("utf8") !== content) {
      throw new Error("evaluation trial journal failed immutable exact-byte re-read");
    }
    return this.load(entry);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.artifacts.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

function exactRuntimeBinding(
  actual: EvaluationRuntimeBindingV1,
  expected: PairedEvaluationPlanV1["runtime_binding"]
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("evaluation model client runtime binding does not match the frozen plan");
  }
}

function registrationForEntry(input: {
  readonly entry: PairedEvaluationScheduleEntryV1;
  readonly baselineRegistration: PlaybookRegistrationV1;
  readonly candidateRegistry: PlaybookRegistryV1;
  readonly ablationRegistry: PlaybookRegistryV1;
}): PlaybookRegistrationV1 {
  if (input.entry.variant === "baseline") return input.baselineRegistration;
  const registry =
    input.entry.variant === "candidate" ? input.candidateRegistry : input.ablationRegistry;
  const registration = resolveEvaluationCandidate({
    name: input.entry.variant_name,
    contract_sha256: input.entry.binding_sha256,
    registry,
  });
  if (registration === undefined) {
    throw new Error(
      `evaluation-only ${input.entry.variant} registration '${input.entry.variant_name}' is unavailable or stale`
    );
  }
  return registration;
}

function terminalResultRef(directive: Directive): ArtifactRef | undefined {
  if (
    directive.action !== "complete" &&
    directive.action !== "incomplete" &&
    directive.action !== "cancelled" &&
    directive.action !== "error"
  ) {
    return undefined;
  }
  const value = directive.result.output_artifact_ref;
  if (value === null || value === undefined) return undefined;
  try {
    return validateContract(ArtifactRefSchema, value, "evaluation terminal output artifact ref");
  } catch {
    return undefined;
  }
}

function terminalProductRef(
  directive: Directive,
  registration: PlaybookRegistrationV1
): ArtifactRef | undefined {
  const ref = terminalResultRef(directive);
  if (directive.action !== "complete" || ref === undefined) return undefined;
  if (!directive.artifacts.some((artifact) => canonicalJson(artifact) === canonicalJson(ref))) {
    return undefined;
  }
  const matchingPorts = registration.contract.io.active_output_ports.filter(
    (port) =>
      port.transport === "artifact" &&
      port.artifact_kind === ref.kind &&
      ref.content_schema?.schema_id === port.schema_id &&
      ref.content_schema.schema_version === port.schema_version_required
  );
  if (matchingPorts.length !== 1) return undefined;
  const latest = registration.contract.completion_gate.latest_product;
  if (
    latest.selector === "terminal_artifact" &&
    (latest.artifact_kind !== ref.kind ||
      latest.producing_state !== ref.phase ||
      latest.schema_id !== ref.content_schema?.schema_id ||
      latest.product_schema_version !== ref.content_schema.schema_version)
  ) {
    return undefined;
  }
  return ref;
}

function verifiedOutputMetadata(
  artifacts: ArtifactStore,
  outputRef: ArtifactRef
): OutputArtifactMetadata {
  const metadata = validateContract(
    OutputArtifactMetadataSchema,
    artifacts.metadata(outputRef),
    "evaluation output artifact metadata"
  );
  if (
    metadata.run_id !== outputRef.run_id ||
    metadata.phase !== outputRef.phase ||
    metadata.branch_id !== outputRef.branch_id ||
    metadata.kind !== outputRef.kind ||
    metadata.operation_id !== outputRef.operation_id ||
    metadata.version !== outputRef.version ||
    metadata.producer !== outputRef.producer ||
    metadata.media_type !== outputRef.media_type ||
    canonicalJson(metadata.content_schema ?? null) !==
      canonicalJson(outputRef.content_schema ?? null)
  ) {
    throw new Error("evaluation output metadata diverged from its immutable artifact ref");
  }
  const upstreamIds = metadata.upstream_refs.map((ref) => ref.artifact_id);
  if (new Set(upstreamIds).size !== upstreamIds.length) {
    throw new Error("evaluation output metadata contains duplicate upstream artifact refs");
  }
  for (const upstream of metadata.upstream_refs) {
    const persisted = artifacts.refById(upstream.artifact_id);
    if (persisted === undefined || canonicalJson(persisted) !== canonicalJson(upstream)) {
      throw new Error(
        `evaluation output upstream '${upstream.artifact_id}' is absent or manifest-stale`
      );
    }
    artifacts.readById(upstream.artifact_id);
  }
  return metadata;
}

function trialStartConstraints(input: {
  readonly entry: PairedEvaluationScheduleEntryV1;
  readonly task: EvaluationPopulationTaskV1;
  readonly plan: PairedEvaluationPlanV1;
  readonly scheduleSha256: string;
}): Readonly<Record<string, JsonValue>> {
  if (input.entry.variant !== "baseline") return input.task.constraints;
  assertOracleFreeDirectBaselineTaskConstraints(input.task.constraints);
  return {
    evaluation_plan_id: input.plan.plan_id,
    schedule_sha256: input.scheduleSha256,
    task_id: input.task.task_id,
    repetition: input.entry.repetition,
    variant: input.entry.variant,
    task_constraints: input.task.constraints,
    model_override: `${input.plan.runtime_binding.provider}/${input.plan.runtime_binding.model}`,
  };
}

class ExplicitEvaluationModelExecutionFault extends Error {
  constructor(cause: unknown) {
    super("explicit evaluation model execution failed", { cause });
    this.name = "ExplicitEvaluationModelExecutionFault";
  }
}

function evaluationModelBoundary(
  client: MeasuredEvaluationModelClientV1
): MeasuredEvaluationModelClientV1 {
  return {
    runtime_binding: client.runtime_binding,
    runAgent: async (invocation) => {
      try {
        return await client.runAgent(invocation);
      } catch (error) {
        if (error instanceof LivenessExhaustedError) throw error;
        throw new ExplicitEvaluationModelExecutionFault(error);
      }
    },
    measurement: (runId) => client.measurement(runId),
  };
}

function livenessFailureCode(
  reason: NonNullable<LivenessSnapshotV1["terminal_reason"]>
): EvaluationTrialFailureCodeV1 {
  switch (reason) {
    case "worker_wall_clock_exhausted":
      return "WORKER_WALL_CLOCK_EXHAUSTED";
    case "run_wall_clock_exhausted":
      return "RUN_WALL_CLOCK_EXHAUSTED";
    case "external_request_budget_exhausted":
      return "PROHIBITED_EXTERNAL_TOOL_ATTEMPT";
    case "model_turn_budget_exhausted":
      return "MODEL_TURN_BUDGET_EXHAUSTED";
    case "tool_call_budget_exhausted":
      return "TOOL_CALL_BUDGET_EXHAUSTED";
    case "malformed_result_budget_exhausted":
    case "routing_repair_binding_invalid":
      return "ROUTING_METADATA_INVALID";
    case "identical_error_stall":
    case "protocol_error_budget_exhausted":
      return "MODEL_PROTOCOL_ERROR";
  }
}

function explicitTerminalFailureCode(
  directive: Directive,
  snapshot: LivenessSnapshotV1
): EvaluationTrialFailureCodeV1 {
  if (snapshot.terminal_reason !== null) return livenessFailureCode(snapshot.terminal_reason);
  if (
    directive.action === "complete" ||
    directive.action === "invoke_agent" ||
    directive.action === "invoke_agents_parallel" ||
    directive.action === "await_user" ||
    directive.action === "paused" ||
    directive.action === "status"
  ) {
    return "ROUTING_METADATA_INVALID";
  }
  for (const unresolved of directive.unresolved) {
    try {
      return validateContract(
        EvaluationTrialFailureCodeV1Schema,
        unresolved,
        "evaluation terminal failure code"
      );
    } catch {
      // Unresolved prose is not a diagnostic contract. Continue to the closed fallback.
    }
  }
  return directive.action === "incomplete" ? "ROUTING_METADATA_INVALID" : "MODEL_EXECUTION_ERROR";
}

export class GenericEvaluationTrialExecutor implements EvaluationTrialExecutorV1 {
  constructor(
    private readonly options: {
      readonly projectRoot: string;
      readonly env: NodeJS.ProcessEnv;
      readonly baselineRegistration: PlaybookRegistrationV1;
      readonly candidateRegistry: PlaybookRegistryV1;
      readonly ablationRegistry?: PlaybookRegistryV1;
      readonly modelClientFactory: EvaluationModelClientFactoryV1;
    }
  ) {}

  async preflight(input: EvaluationPreflightInputV1): Promise<void> {
    await this.options.modelClientFactory.preflight?.(input);
  }

  async execute(input: {
    readonly entry: PairedEvaluationScheduleEntryV1;
    readonly task: EvaluationPopulationTaskV1;
    readonly plan: PairedEvaluationPlanV1;
    readonly frozen: FrozenPairedEvaluationV1;
  }): Promise<EvaluationTrialObservationV1> {
    const rawClient = this.options.modelClientFactory({ entry: input.entry, plan: input.plan });
    exactRuntimeBinding(rawClient.runtime_binding, input.plan.runtime_binding);
    const client = evaluationModelBoundary(rawClient);
    const registration = registrationForEntry({
      entry: input.entry,
      baselineRegistration: this.options.baselineRegistration,
      candidateRegistry: this.options.candidateRegistry,
      ablationRegistry: this.options.ablationRegistry ?? new Map(),
    });
    let service: OrchestrationService | undefined;
    let startedNewTrial = false;
    try {
      service = new OrchestrationService({
        projectRoot: this.options.projectRoot,
        env: this.options.env,
        modelClient: client,
        playbookName: registration.name,
        playbookRegistration: registration,
      });
      const identity = {
        schema_version: 2 as const,
        run_id: input.entry.trial_id,
        session_id: input.entry.trial_id,
        playbook: registration.name,
        engine_owner: "typescript" as const,
      };
      const retained = service.checkpointer.loadRunById(input.entry.trial_id);
      startedNewTrial = retained === undefined;
      const directive =
        retained === undefined
          ? await (() => {
              const inputBindings = input.task.exact_input_artifact_ids.map((artifactId, index) => {
                const ref = service?.artifacts.refById(artifactId);
                if (ref === undefined) {
                  throw new Error(`evaluation input artifact '${artifactId}' is unavailable`);
                }
                service?.artifacts.readById(artifactId);
                return {
                  slot: `evaluation-caller-input-${String(index + 1).padStart(4, "0")}`,
                  ref,
                };
              });
              return service?.execute({
                schema_version: 2,
                action: "start",
                identity,
                goal: input.task.goal,
                constraints: trialStartConstraints({
                  entry: input.entry,
                  task: input.task,
                  plan: input.plan,
                  scheduleSha256: input.frozen.schedule_sha256,
                }),
                project_root: this.options.projectRoot,
                trust_profile: "hardened-untrusted",
                ...(inputBindings.length === 0
                  ? {}
                  : { input_artifacts: { schema_version: 2, artifacts: inputBindings } }),
              });
            })()
          : await service.execute({ schema_version: 2, action: "recover", identity });
      if (directive === undefined) {
        throw new Error("evaluation trial service returned no directive");
      }
      const measurement = client.measurement(input.entry.trial_id);
      const executionAccounting = {
        started_new_trial: startedNewTrial,
        loopback_provider_calls: measurement.loopback_provider_calls ?? 0,
      };
      const boundPolicy = service.engine.liveness.policy(input.entry.trial_id);
      if (
        boundPolicy === undefined ||
        sha256(canonicalJson(boundPolicy)) !== input.plan.budget_policy_sha256
      ) {
        throw new Error("executed trial liveness policy drifted from the frozen plan");
      }
      const snapshot = service.engine.liveness.snapshot(input.entry.trial_id);
      if (snapshot.open_workers !== 0) {
        throw new Error("evaluation trial ended with an open worker lease");
      }
      if (directive.action === "complete") {
        const outputRef = terminalProductRef(directive, registration);
        if (outputRef === undefined) {
          return {
            trial_id: input.entry.trial_id,
            terminal_status: "error",
            failure_code: "ROUTING_METADATA_INVALID",
            cost_microusd: measurement.cost_microusd,
            latency_ms: measurement.latency_ms,
            ...executionAccounting,
          };
        }
        const outputMetadata = verifiedOutputMetadata(service.artifacts, outputRef);
        const outputBytes = service.artifacts.read(outputRef).toString("utf8");
        return {
          trial_id: input.entry.trial_id,
          terminal_status: "complete",
          output_ref: outputRef,
          output_metadata: outputMetadata,
          output_bytes: outputBytes,
          cost_microusd: measurement.cost_microusd,
          latency_ms: measurement.latency_ms,
          ...executionAccounting,
        };
      }
      if (directive.action === "cancelled") {
        return {
          trial_id: input.entry.trial_id,
          terminal_status: "cancelled",
          ...(terminalResultRef(directive) === undefined
            ? {}
            : { output_ref: terminalResultRef(directive) }),
          failure_code: explicitTerminalFailureCode(directive, snapshot),
          cost_microusd: measurement.cost_microusd,
          latency_ms: measurement.latency_ms,
          ...executionAccounting,
        };
      }
      const nonterminal =
        directive.action === "await_user" ||
        directive.action === "paused" ||
        directive.action === "invoke_agent" ||
        directive.action === "invoke_agents_parallel" ||
        directive.action === "status";
      return {
        trial_id: input.entry.trial_id,
        terminal_status: nonterminal ? "nonterminal" : "error",
        ...(terminalResultRef(directive) === undefined
          ? {}
          : { output_ref: terminalResultRef(directive) }),
        failure_code: explicitTerminalFailureCode(directive, snapshot),
        cost_microusd: measurement.cost_microusd,
        latency_ms: measurement.latency_ms,
        ...executionAccounting,
      };
    } catch (error) {
      if (!(error instanceof ExplicitEvaluationModelExecutionFault)) throw error;
      const measurement = client.measurement(input.entry.trial_id);
      return {
        trial_id: input.entry.trial_id,
        terminal_status: "error",
        failure_code: "MODEL_EXECUTION_ERROR",
        cost_microusd: measurement.cost_microusd,
        latency_ms: measurement.latency_ms,
        started_new_trial: startedNewTrial,
        loopback_provider_calls: measurement.loopback_provider_calls ?? 0,
      };
    } finally {
      service?.close();
    }
  }
}

function readinessCoverage(completed: number, scheduled: number): number {
  if (scheduled <= 0) return 0;
  return Math.round((completed / scheduled + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function evaluationReadinessResultId(
  body: Omit<EvaluationReadinessResultV1, "readiness_result_id">
): string {
  return `evalready_${sha256(canonicalJson(body))}`;
}

export function validateEvaluationReadinessResult(
  value: unknown,
  frozenPlan: PairedEvaluationPlanV1
): EvaluationReadinessResultV1 {
  const plan = validatePairedEvaluationPlan(frozenPlan);
  const readiness = plan.comparison_validity_policy.readiness_preflight;
  if (!readiness.required) {
    throw new Error("evaluation readiness result requires a frozen readiness plan");
  }
  const result = validateContract(
    EvaluationReadinessResultV1Schema,
    value,
    "EvaluationReadinessResultV1"
  );
  const { readiness_result_id: _resultId, ...body } = result;
  if (evaluationReadinessResultId(body) !== result.readiness_result_id) {
    throw new Error("evaluation readiness result ID does not match its body");
  }
  if (!path.isAbsolute(result.state_binding.state_root)) {
    throw new Error("evaluation readiness result state root must be absolute");
  }
  if (
    result.plan_id !== plan.plan_id ||
    result.plan_sha256 !== pairedEvaluationPlanSha256(plan) ||
    result.implementation_binding_sha256 !== plan.implementation_binding_sha256 ||
    result.calibration_cohort.sha256 !== readiness.calibration_cohort_sha256 ||
    result.calibration_cohort.repetitions !== readiness.repetitions ||
    canonicalJson(result.runtime_binding) !== canonicalJson(plan.runtime_binding) ||
    canonicalJson(result.candidate_binding) !== canonicalJson(plan.candidate) ||
    canonicalJson(result.baseline_binding) !==
      canonicalJson({
        registration_name: plan.baseline.registration_name,
        definition_sha256: plan.baseline.definition_sha256,
      }) ||
    canonicalJson(result.ablation_bindings) !== canonicalJson(plan.ablations)
  ) {
    throw new Error("evaluation readiness result does not match its frozen plan binding");
  }
  const expectedPairFloor =
    readiness.complete_all_arm_pair_floor ??
    plan.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor;
  if (result.complete_all_arm_pairs.frozen_floor !== expectedPairFloor) {
    throw new Error("evaluation readiness pair floor does not match its frozen plan");
  }
  const expectedArmFloors = new Map<string, number>([
    [plan.baseline.registration_name, readiness.baseline_normalized_completion_floor],
    [plan.candidate.name, readiness.candidate_normalized_completion_floor],
    ...readiness.required_comparator_normalized_completion_floors.map(
      (policy): [string, number] => [policy.comparator_name, policy.normalized_completion_floor]
    ),
  ]);
  if (
    result.arms.length !== expectedArmFloors.size ||
    result.arms.some((arm) => expectedArmFloors.get(arm.registration_name) !== arm.frozen_floor)
  ) {
    throw new Error("evaluation readiness arm floors do not match their frozen plan");
  }
  const trialIds = result.trials.map((trial) => trial.entry.trial_id);
  if (new Set(trialIds).size !== trialIds.length) {
    throw new Error("evaluation readiness result trial IDs must be unique");
  }
  if (result.trials.some((trial, index) => trial.entry.ordinal !== index)) {
    throw new Error("evaluation readiness result trial ordinals must be complete and ordered");
  }
  const armNames = result.arms.map((arm) => arm.registration_name);
  if (new Set(armNames).size !== armNames.length) {
    throw new Error("evaluation readiness result arm names must be unique");
  }
  const trialArmNames = new Set(result.trials.map((trial) => trial.entry.variant_name));
  if (
    trialArmNames.size !== armNames.length ||
    armNames.some((armName) => !trialArmNames.has(armName))
  ) {
    throw new Error("evaluation readiness result arms do not cover every trial identity");
  }
  for (const arm of result.arms) {
    const trials = result.trials.filter(
      (trial) => trial.entry.variant_name === arm.registration_name
    );
    const normalized = trials.filter(
      (trial) => trial.normalization_status === "normalized" && trial.common_wire_validated
    ).length;
    const expected = {
      scheduled_trials: trials.length,
      normalized_completions: normalized,
      incomplete_or_failed_trials: trials.length - normalized,
      normalized_completion_rate: readinessCoverage(normalized, trials.length),
    };
    if (
      arm.variant !== trials[0]?.entry.variant ||
      arm.binding_sha256 !== trials[0]?.entry.binding_sha256 ||
      arm.scheduled_trials !== expected.scheduled_trials ||
      arm.normalized_completions !== expected.normalized_completions ||
      arm.incomplete_or_failed_trials !== expected.incomplete_or_failed_trials ||
      arm.normalized_completion_rate !== expected.normalized_completion_rate ||
      arm.passed !== expected.normalized_completion_rate >= arm.frozen_floor
    ) {
      throw new Error(`evaluation readiness arm '${arm.registration_name}' is inconsistent`);
    }
  }
  const byPair = new Map<string, EvaluationReadinessTrialV1[]>();
  for (const trial of result.trials) {
    const pair = byPair.get(trial.entry.pair_id) ?? [];
    pair.push(trial);
    byPair.set(trial.entry.pair_id, pair);
  }
  const completePairs = [...byPair.values()].filter(
    (pair) =>
      pair.length === result.arms.length &&
      pair.every(
        (trial) => trial.normalization_status === "normalized" && trial.common_wire_validated
      )
  ).length;
  const expectedPairs = {
    scheduled_pairs: byPair.size,
    complete_pairs: completePairs,
    incomplete_pairs: byPair.size - completePairs,
    coverage: readinessCoverage(completePairs, byPair.size),
  };
  if (
    result.complete_all_arm_pairs.scheduled_pairs !== expectedPairs.scheduled_pairs ||
    result.complete_all_arm_pairs.complete_pairs !== expectedPairs.complete_pairs ||
    result.complete_all_arm_pairs.incomplete_pairs !== expectedPairs.incomplete_pairs ||
    result.complete_all_arm_pairs.coverage !== expectedPairs.coverage ||
    result.complete_all_arm_pairs.passed !==
      expectedPairs.coverage >= result.complete_all_arm_pairs.frozen_floor
  ) {
    throw new Error("evaluation readiness all-arm pair coverage is inconsistent");
  }
  const expectedFailures = result.trials.flatMap((trial) =>
    trial.readiness_failure_code === null
      ? []
      : [
          {
            trial_id: trial.entry.trial_id,
            task_id: trial.entry.task_id,
            registration_name: trial.entry.variant_name,
            code: trial.readiness_failure_code,
            detail_code: trial.normalization_failure_code ?? trial.terminal_failure_code ?? null,
          },
        ]
  );
  if (canonicalJson(result.failures) !== canonicalJson(expectedFailures)) {
    throw new Error("evaluation readiness explicit failure accounting is inconsistent");
  }
  const commonWireAttempted = result.trials.filter(
    (trial) => trial.normalization_status === "normalized"
  ).length;
  const commonWirePassed = result.trials.filter((trial) => trial.common_wire_validated).length;
  if (
    result.common_wire_validation.attempted_trials !== commonWireAttempted ||
    result.common_wire_validation.passed_trials !== commonWirePassed ||
    result.common_wire_validation.failed_trials !== commonWireAttempted - commonWirePassed ||
    result.common_wire_validation.all_passed !== (commonWirePassed === result.trials.length)
  ) {
    throw new Error("evaluation readiness common-wire accounting is inconsistent");
  }
  const newlyStarted = result.trials.filter((trial) => trial.started_new_trial).length;
  const resumed = result.trials.filter((trial) => trial.resumed_existing_run).length;
  const adopted = result.trials.filter((trial) => trial.adopted_existing_output).length;
  const providerCalls = result.trials.reduce(
    (sum, trial) => sum + trial.loopback_provider_calls,
    0
  );
  const cost = result.trials.reduce((sum, trial) => sum + trial.cost_microusd, 0);
  const latency = result.trials.reduce((sum, trial) => sum + trial.latency_ms, 0);
  if (
    result.trials.some(
      (trial) =>
        trial.started_new_trial === trial.resumed_existing_run ||
        (trial.adopted_existing_output &&
          (trial.started_new_trial ||
            trial.terminal_status !== "complete" ||
            trial.loopback_provider_calls !== 0))
    ) ||
    canonicalJson(result.execution_accounting) !==
      canonicalJson({
        newly_started_trials: newlyStarted,
        resumed_existing_runs: resumed,
        adopted_existing_outputs: adopted,
        loopback_provider_calls: providerCalls,
        total_cost_microusd: cost,
        total_latency_ms: latency,
      })
  ) {
    throw new Error("evaluation readiness execution accounting is inconsistent");
  }
  const expectedPassed =
    result.failures.length === 0 &&
    result.arms.every((arm) => arm.passed) &&
    result.complete_all_arm_pairs.passed &&
    result.common_wire_validation.all_passed &&
    result.oracle_isolation.passed &&
    result.state_root_validation.passed;
  if (result.passed !== expectedPassed) {
    throw new Error("evaluation readiness pass/fail projection is inconsistent");
  }
  return result;
}

export function persistEvaluationReadinessResult(input: {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly plan: PairedEvaluationPlanV1;
  readonly result: EvaluationReadinessResultV1;
}): ArtifactRef {
  const result = validateEvaluationReadinessResult(input.result, input.plan);
  const state = resolvePennyRuntimeState(input.projectRoot, { env: input.env });
  using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
    projectId: state.projectId,
  });
  const upstreamRefs = result.trials
    .flatMap((trial) => (trial.output_ref === null ? [] : [trial.output_ref]))
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  const content = canonicalJson(result);
  const ref = artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: `evaluation-readiness-${sha256(result.plan_id).slice(0, 32)}`,
      phase: "evaluation",
      branch_id: null,
      kind: "evaluation-readiness-result",
      operation_id: `evaluation-readiness-result:${result.readiness_result_id}`,
      version: 1,
      producer: "host:evaluation-runner",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.evaluation-readiness-result.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: upstreamRefs,
    },
    content,
  });
  const rereadRef = artifacts.refById(ref.artifact_id);
  if (rereadRef === undefined || canonicalJson(rereadRef) !== canonicalJson(ref)) {
    throw new Error("evaluation readiness result artifact failed immutable manifest re-read");
  }
  const rereadBytes = artifacts.readById(ref.artifact_id).toString("utf8");
  if (rereadBytes !== content) {
    throw new Error("evaluation readiness result artifact failed exact-byte re-read");
  }
  const rereadValue: unknown = JSON.parse(rereadBytes);
  if (canonicalJson(validateEvaluationReadinessResult(rereadValue, input.plan)) !== content) {
    throw new Error("evaluation readiness result artifact failed closed-contract re-read");
  }
  return rereadRef;
}

export class RealTopologyEvaluationReadinessPreflight implements EvaluationReadinessPreflightV1 {
  constructor(
    private readonly options: {
      readonly projectRoot: string;
      readonly env: NodeJS.ProcessEnv;
      readonly calibrationCohort: unknown;
      readonly executor: EvaluationTrialExecutorV1;
      readonly validateCommonWire: EvaluationCommonWireValidatorV1;
    }
  ) {}

  /**
   * Provider-free validation shared by the C6 calibration driver. Unlike `run`, this
   * boundary never accepts or synthesizes a held-out population and never executes a
   * trial. It proves that the exact caller schedule references only the bound
   * calibration cohort and that no host-only oracle marker is model-visible.
   */
  validateCalibrationExecutionSchedule(input: {
    readonly taskArmPairs: readonly {
      readonly task_id: string;
      readonly arm_id: string;
    }[];
    readonly armIds: readonly string[];
  }): EvaluationReadinessCalibrationCohortV1 {
    const cohort = validateEvaluationReadinessCalibrationCohort(this.options.calibrationCohort);
    const taskIds = new Set(cohort.tasks.map((task) => task.task_id));
    const armIds = new Set(input.armIds);
    if (
      armIds.size !== input.armIds.length ||
      input.taskArmPairs.length === 0 ||
      input.taskArmPairs.some((pair) => !taskIds.has(pair.task_id) || !armIds.has(pair.arm_id))
    ) {
      throw new Error("calibration execution schedule has a foreign task or arm binding");
    }
    const scheduledTaskIds = new Set(input.taskArmPairs.map((pair) => pair.task_id));
    if (
      scheduledTaskIds.size !== taskIds.size ||
      [...taskIds].some((id) => !scheduledTaskIds.has(id))
    ) {
      throw new Error("calibration execution schedule does not cover the exact cohort");
    }
    const oracleMarkers = cohort.tasks.flatMap((task) => task.host_only_oracle_markers);
    for (const task of cohort.tasks) {
      assertOracleFreeDirectBaselineTaskConstraints(task.constraints);
      const modelVisible = canonicalJson({
        schema_version: task.schema_version,
        split: task.split,
        task_id: task.task_id,
        goal: task.goal,
        constraints: task.constraints,
        exact_input_artifact_ids: task.exact_input_artifact_ids,
      });
      if (oracleMarkers.some((marker) => modelVisible.includes(marker))) {
        throw new Error("calibration execution model input contains a host-only oracle marker");
      }
    }
    return cohort;
  }

  async run(input: EvaluationPreflightInputV1): Promise<EvaluationReadinessRunV1> {
    try {
      const readiness = input.plan.comparison_validity_policy.readiness_preflight;
      if (!readiness.required) {
        throw new Error("real-topology readiness requires a frozen required readiness policy");
      }
      const cohort = validateEvaluationReadinessCalibrationCohort(this.options.calibrationCohort);
      const cohortSha256 = evaluationReadinessCalibrationCohortSha256(cohort);
      if (cohortSha256 !== readiness.calibration_cohort_sha256) {
        throw new Error("readiness calibration cohort drifted from the frozen plan hash");
      }
      const heldOutTaskIds = new Set(input.population.tasks.map((task) => task.task_id));
      const heldOutContentDigests = new Set(
        input.population.tasks.map((task) =>
          sha256(
            canonicalJson({
              goal: task.goal,
              constraints: task.constraints,
              exact_input_artifact_ids: task.exact_input_artifact_ids,
            })
          )
        )
      );
      const oracleMarkers = cohort.tasks.flatMap((task) => task.host_only_oracle_markers);
      const tasks = cohort.tasks.map((calibration) => {
        if (heldOutTaskIds.has(calibration.task_id)) {
          throw new Error("readiness calibration task ID overlaps the held-out population");
        }
        const contentDigest = sha256(
          canonicalJson({
            goal: calibration.goal,
            constraints: calibration.constraints,
            exact_input_artifact_ids: calibration.exact_input_artifact_ids,
          })
        );
        if (heldOutContentDigests.has(contentDigest)) {
          throw new Error("readiness calibration task content overlaps the held-out population");
        }
        assertOracleFreeDirectBaselineTaskConstraints(calibration.constraints);
        const modelVisibleCalibration = canonicalJson({
          schema_version: calibration.schema_version,
          split: calibration.split,
          task_id: calibration.task_id,
          goal: calibration.goal,
          constraints: calibration.constraints,
          exact_input_artifact_ids: calibration.exact_input_artifact_ids,
        });
        if (oracleMarkers.some((marker) => modelVisibleCalibration.includes(marker))) {
          throw new Error("readiness calibration model input contains a host-only oracle marker");
        }
        return {
          calibration,
          task: {
            task_id: calibration.task_id,
            domain: calibration.split,
            trigger_expected: false,
            goal: calibration.goal,
            constraints: calibration.constraints,
            exact_input_artifact_ids: calibration.exact_input_artifact_ids,
            grader_case_id: calibration.task_id,
          } satisfies EvaluationPopulationTaskV1,
        };
      });
      const grading = validatedEvaluationGradingDefinition(input.gradingDefinition);
      const sourceEntries = new Map(
        input.frozen.schedule.map((entry) => [entry.variant_name, entry] as const)
      );
      const armNames = [
        input.plan.baseline.registration_name,
        input.plan.candidate.name,
        ...[...input.plan.ablations]
          .sort((left, right) => compareKeys(left.name, right.name))
          .map((ablation) => ablation.name),
      ];
      if (new Set(armNames).size !== armNames.length) {
        throw new Error("readiness preflight arm identities are not unique");
      }
      const floorByArm = new Map<string, number>([
        [input.plan.baseline.registration_name, readiness.baseline_normalized_completion_floor],
        [input.plan.candidate.name, readiness.candidate_normalized_completion_floor],
        ...readiness.required_comparator_normalized_completion_floors.map(
          (policy) => [policy.comparator_name, policy.normalized_completion_floor] as const
        ),
      ]);
      if (
        floorByArm.size !== armNames.length ||
        armNames.some((armName) => !floorByArm.has(armName))
      ) {
        throw new Error("readiness normalization floors do not cover every arm exactly once");
      }
      const initialState = resolvePennyRuntimeState(this.options.projectRoot, {
        env: this.options.env,
      });
      let checkedInputArtifacts = 0;
      {
        using calibrationArtifacts = ArtifactStore.openExisting(initialState.paths.artifacts.root, {
          projectId: initialState.projectId,
        });
        for (const { calibration } of tasks) {
          for (const artifactId of calibration.exact_input_artifact_ids) {
            checkedInputArtifacts += 1;
            if (calibrationArtifacts.refById(artifactId) === undefined) {
              throw new Error(
                `readiness calibration input artifact '${artifactId}' is absent from the bound state root`
              );
            }
            const bytes = calibrationArtifacts.readById(artifactId).toString("utf8");
            if (oracleMarkers.some((marker) => bytes.includes(marker))) {
              throw new Error(
                `readiness calibration input artifact '${artifactId}' contains a host-only oracle marker`
              );
            }
          }
        }
      }
      const scheduled: Array<{
        readonly calibration: EvaluationReadinessCalibrationTaskV1;
        readonly task: EvaluationPopulationTaskV1;
        readonly entry: PairedEvaluationScheduleEntryV1;
      }> = [];
      let ordinal = 0;
      for (const { calibration, task } of tasks) {
        for (let repetition = 1; repetition <= readiness.repetitions; repetition += 1) {
          const readinessPairId = `evalpair_${sha256(
            canonicalJson({
              plan_sha256: input.frozen.plan_sha256,
              calibration_cohort_sha256: cohortSha256,
              calibration_task_id: calibration.task_id,
              repetition,
              split: calibration.split,
            })
          )}`;
          for (const armName of armNames) {
            const sourceEntry = sourceEntries.get(armName);
            const normalizer = grading.semanticNormalizerDescriptors.get(armName);
            const normalizerImplementation = grading.semanticNormalizerImplementations.get(armName);
            if (
              sourceEntry === undefined ||
              normalizer === undefined ||
              normalizerImplementation === undefined
            ) {
              throw new Error(`readiness preflight arm '${armName}' is not fully registered`);
            }
            const identity = {
              readiness_pair_id: readinessPairId,
              calibration_cohort_sha256: cohortSha256,
              calibration_task_id: calibration.task_id,
              repetition,
              variant: sourceEntry.variant,
              variant_name: armName,
              binding_sha256: sourceEntry.binding_sha256,
            };
            scheduled.push({
              calibration,
              task,
              entry: {
                trial_id: `evaltrial_${sha256(canonicalJson(identity))}`,
                pair_id: readinessPairId,
                ordinal,
                task_id: calibration.task_id,
                repetition,
                variant: sourceEntry.variant,
                variant_name: armName,
                binding_sha256: sourceEntry.binding_sha256,
              },
            });
            ordinal += 1;
          }
        }
      }
      const trialResults: EvaluationReadinessTrialV1[] = [];
      for (const scheduledTrial of scheduled) {
        const { calibration, task, entry } = scheduledTrial;
        const normalizer = grading.semanticNormalizerDescriptors.get(entry.variant_name);
        const normalizerImplementation = grading.semanticNormalizerImplementations.get(
          entry.variant_name
        );
        if (normalizer === undefined || normalizerImplementation === undefined) {
          throw new Error(`readiness preflight arm '${entry.variant_name}' lost its normalizer`);
        }
        const observation = await this.options.executor.execute({
          entry,
          task,
          plan: input.plan,
          frozen: input.frozen,
        });
        const currentState = resolvePennyRuntimeState(this.options.projectRoot, {
          env: this.options.env,
        });
        if (
          currentState.projectId !== initialState.projectId ||
          path.resolve(currentState.state.root) !== path.resolve(initialState.state.root) ||
          path.resolve(currentState.paths.artifacts.root) !==
            path.resolve(initialState.paths.artifacts.root)
        ) {
          throw new Error("readiness preflight state root drifted between trials");
        }
        const startedNewTrial = observation?.started_new_trial ?? true;
        const loopbackProviderCalls = observation?.loopback_provider_calls ?? 0;
        let readinessFailureCode: EvaluationReadinessFailureCodeV1 | null = null;
        let normalizationStatus: EvaluationReadinessTrialV1["normalization_status"] =
          "not_attempted";
        let normalizationFailureCode: string | null = null;
        let commonWireValidated = false;
        let commonWireSha256: string | null = null;
        if (observation === undefined) {
          readinessFailureCode = "READINESS_OBSERVATION_MISSING";
        } else if (
          observation.terminal_status !== "complete" ||
          observation.output_ref === undefined ||
          observation.output_metadata === undefined ||
          observation.output_bytes === undefined
        ) {
          readinessFailureCode = "READINESS_TERMINAL_FAILURE";
        } else if (!outputRefMatchesNormalizer(observation.output_ref, normalizer)) {
          readinessFailureCode = "READINESS_OUTPUT_CONTRACT_INVALID";
        } else {
          let persistedMetadata: OutputArtifactMetadata | undefined;
          let persistedBytes: string | undefined;
          try {
            using artifacts = ArtifactStore.openExisting(currentState.paths.artifacts.root, {
              projectId: currentState.projectId,
            });
            const persistedRef = artifacts.refById(observation.output_ref.artifact_id);
            persistedMetadata = verifiedOutputMetadata(artifacts, observation.output_ref);
            persistedBytes = artifacts
              .readById(observation.output_ref.artifact_id)
              .toString("utf8");
            if (
              persistedRef === undefined ||
              canonicalJson(persistedRef) !== canonicalJson(observation.output_ref) ||
              canonicalJson(persistedMetadata) !== canonicalJson(observation.output_metadata) ||
              persistedBytes !== observation.output_bytes
            ) {
              persistedMetadata = undefined;
              persistedBytes = undefined;
            }
          } catch {
            persistedMetadata = undefined;
            persistedBytes = undefined;
          }
          if (persistedMetadata === undefined || persistedBytes === undefined) {
            readinessFailureCode = "READINESS_OUTPUT_STORAGE_INVALID";
          } else {
            let normalized: EvaluationSemanticNormalizationV1;
            try {
              normalized = validateContract(
                EvaluationSemanticNormalizationV1Schema,
                normalizerImplementation.normalize({
                  descriptor: normalizer,
                  wire: grading.descriptor.wire,
                  output_ref: observation.output_ref,
                  output_metadata: persistedMetadata,
                  output_bytes: persistedBytes,
                  task,
                }),
                "evaluation readiness semantic normalization"
              );
            } catch {
              normalized = {
                status: "invalid_output",
                failure_code: "SEMANTIC_NORMALIZER_INCOMPATIBLE",
              };
            }
            if (normalized.status === "invalid_output") {
              normalizationStatus = "invalid_output";
              normalizationFailureCode = normalized.failure_code;
              readinessFailureCode = "READINESS_NORMALIZATION_INVALID";
            } else {
              normalizationStatus = "normalized";
              commonWireSha256 = sha256(normalized.wire_bytes);
              try {
                this.options.validateCommonWire({
                  descriptor: grading.descriptor.wire,
                  wire_bytes: normalized.wire_bytes,
                  calibration_task: calibration,
                });
                commonWireValidated = true;
              } catch {
                readinessFailureCode = "READINESS_COMMON_WIRE_INVALID";
              }
            }
          }
        }
        const resumedExistingRun = !startedNewTrial;
        trialResults.push({
          entry,
          terminal_status: observation?.terminal_status ?? "missing",
          output_ref: observation?.output_ref ?? null,
          terminal_failure_code: observation?.failure_code ?? null,
          normalization_status: normalizationStatus,
          normalization_failure_code: normalizationFailureCode,
          common_wire_validated: commonWireValidated,
          oracle_isolation_validated: true,
          state_root_validated: true,
          readiness_failure_code: readinessFailureCode,
          cost_microusd: observation?.cost_microusd ?? 0,
          latency_ms: observation?.latency_ms ?? 0,
          started_new_trial: startedNewTrial,
          resumed_existing_run: resumedExistingRun,
          adopted_existing_output:
            resumedExistingRun &&
            observation?.terminal_status === "complete" &&
            loopbackProviderCalls === 0,
          loopback_provider_calls: loopbackProviderCalls,
          common_wire_sha256: commonWireSha256,
        });
      }
      const arms = armNames.map((armName) => {
        const sourceEntry = sourceEntries.get(armName);
        const floor = floorByArm.get(armName);
        if (sourceEntry === undefined || floor === undefined) {
          throw new Error(`readiness arm '${armName}' lost its frozen binding`);
        }
        const armTrials = trialResults.filter((trial) => trial.entry.variant_name === armName);
        const normalized = armTrials.filter(
          (trial) => trial.normalization_status === "normalized" && trial.common_wire_validated
        ).length;
        const rate = readinessCoverage(normalized, armTrials.length);
        return {
          variant: sourceEntry.variant,
          registration_name: armName,
          binding_sha256: sourceEntry.binding_sha256,
          scheduled_trials: armTrials.length,
          normalized_completions: normalized,
          incomplete_or_failed_trials: armTrials.length - normalized,
          normalized_completion_rate: rate,
          frozen_floor: floor,
          passed: rate >= floor,
        };
      });
      const pairIds = [...new Set(trialResults.map((trial) => trial.entry.pair_id))];
      const completePairs = pairIds.filter((pairId) => {
        const pair = trialResults.filter((trial) => trial.entry.pair_id === pairId);
        return (
          pair.length === arms.length &&
          pair.every(
            (trial) => trial.normalization_status === "normalized" && trial.common_wire_validated
          )
        );
      }).length;
      const pairCoverage = readinessCoverage(completePairs, pairIds.length);
      const readinessPairFloor =
        readiness.complete_all_arm_pair_floor ??
        input.plan.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor;
      const failures = trialResults.flatMap((trial) =>
        trial.readiness_failure_code === null
          ? []
          : [
              {
                trial_id: trial.entry.trial_id,
                task_id: trial.entry.task_id,
                registration_name: trial.entry.variant_name,
                code: trial.readiness_failure_code,
                detail_code:
                  trial.normalization_failure_code ?? trial.terminal_failure_code ?? null,
              },
            ]
      );
      const commonWireAttempted = trialResults.filter(
        (trial) => trial.normalization_status === "normalized"
      ).length;
      const commonWirePassed = trialResults.filter((trial) => trial.common_wire_validated).length;
      const resultBody = {
        schema_version: 1 as const,
        plan_id: input.frozen.plan_id,
        plan_sha256: input.frozen.plan_sha256,
        schedule_sha256: input.frozen.schedule_sha256,
        implementation_binding_sha256: input.frozen.implementation_binding_sha256,
        calibration_cohort: {
          cohort_id: cohort.cohort_id,
          revision: cohort.revision,
          sha256: cohortSha256,
          task_count: cohort.tasks.length,
          repetitions: readiness.repetitions,
        },
        state_binding: {
          state_root: path.resolve(initialState.state.root),
          project_id: initialState.projectId,
          artifact_root: path.resolve(initialState.paths.artifacts.root),
        },
        runtime_binding: input.plan.runtime_binding,
        candidate_binding: input.plan.candidate,
        baseline_binding: {
          registration_name: input.plan.baseline.registration_name,
          definition_sha256: input.plan.baseline.definition_sha256,
        },
        ablation_bindings: input.plan.ablations,
        trials: trialResults,
        arms,
        complete_all_arm_pairs: {
          scheduled_pairs: pairIds.length,
          complete_pairs: completePairs,
          incomplete_pairs: pairIds.length - completePairs,
          coverage: pairCoverage,
          frozen_floor: readinessPairFloor,
          passed: pairCoverage >= readinessPairFloor,
        },
        failures,
        common_wire_validation: {
          required: true as const,
          attempted_trials: commonWireAttempted,
          passed_trials: commonWirePassed,
          failed_trials: commonWireAttempted - commonWirePassed,
          all_passed: commonWirePassed === trialResults.length,
        },
        oracle_isolation: {
          required: true as const,
          host_only_marker_count: oracleMarkers.length,
          model_visible_tasks_checked: tasks.length,
          input_artifacts_checked: checkedInputArtifacts,
          passed: true as const,
        },
        state_root_validation: {
          required: true as const,
          checked_trials: trialResults.length,
          passed: true as const,
        },
        execution_accounting: {
          newly_started_trials: trialResults.filter((trial) => trial.started_new_trial).length,
          resumed_existing_runs: trialResults.filter((trial) => trial.resumed_existing_run).length,
          adopted_existing_outputs: trialResults.filter((trial) => trial.adopted_existing_output)
            .length,
          loopback_provider_calls: trialResults.reduce(
            (sum, trial) => sum + trial.loopback_provider_calls,
            0
          ),
          total_cost_microusd: trialResults.reduce((sum, trial) => sum + trial.cost_microusd, 0),
          total_latency_ms: trialResults.reduce((sum, trial) => sum + trial.latency_ms, 0),
        },
        passed:
          failures.length === 0 &&
          arms.every((arm) => arm.passed) &&
          pairCoverage >=
            input.plan.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor &&
          commonWirePassed === trialResults.length,
      };
      const result = validateEvaluationReadinessResult(
        {
          ...resultBody,
          readiness_result_id: evaluationReadinessResultId(resultBody),
        },
        input.plan
      );
      const resultArtifactRef = persistEvaluationReadinessResult({
        projectRoot: this.options.projectRoot,
        env: this.options.env,
        plan: input.plan,
        result,
      });
      return { result, result_artifact_ref: resultArtifactRef };
    } catch (error) {
      if (error instanceof InvalidEvaluationFault && error.stage !== "readiness_preflight") {
        throw error;
      }
      throw new InvalidEvaluationFault(
        "readiness_preflight",
        "READINESS_PREFLIGHT_FAILED",
        null,
        error
      );
    }
  }

  async preflight(input: EvaluationPreflightInputV1): Promise<void> {
    const run = await this.run(input);
    if (!run.result.passed) {
      throw new InvalidEvaluationFault("readiness_preflight", "READINESS_PREFLIGHT_FAILED", null);
    }
  }
}
function expectedRegistrationPolicyDigest(input: {
  readonly registration: PlaybookRegistrationV1;
  readonly plan: PairedEvaluationPlanV1;
  readonly task: EvaluationPopulationTaskV1;
  readonly entry: PairedEvaluationScheduleEntryV1;
  readonly projectRoot: string;
}): string {
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: input.entry.trial_id,
      session_id: input.entry.trial_id,
      playbook: input.registration.name,
      engine_owner: "typescript",
    },
    goal: input.task.goal,
    constraints: trialStartConstraints({
      entry: input.entry,
      task: input.task,
      plan: input.plan,
      scheduleSha256: "0".repeat(64),
    }),
    projectRoot: input.projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
  const policy = input.registration.liveness.resolve(context);
  if (policy === undefined) throw new Error("evaluation registration has no liveness policy");
  return sha256(canonicalJson(policy));
}

function exactSortedKeys(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareKeys);
}

function assertExactBindingKeys(input: {
  readonly label: string;
  readonly expected: readonly string[];
  readonly actual: readonly string[];
}): void {
  if (
    canonicalJson(exactSortedKeys(input.actual)) !== canonicalJson(exactSortedKeys(input.expected))
  ) {
    throw new Error(`${input.label} keys do not exactly match the frozen evaluation bindings`);
  }
}

function assertEvaluationRegistrationBindings(input: {
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: ReturnType<typeof validateEvaluationPopulation>;
  readonly plan: PairedEvaluationPlanV1;
  readonly baselineRegistration: PlaybookRegistrationV1;
  readonly candidateRegistry: PlaybookRegistryV1;
  readonly ablationRegistry: PlaybookRegistryV1;
  readonly gradingDefinition: EvaluationGradingDefinitionV1;
  readonly implementationBinding: unknown;
  readonly runtimeFunctions: readonly EvaluationRuntimeFunctionBindingV1[];
  readonly projectRoot: string;
}): void {
  try {
    validateRegistrationContract(input.baselineRegistration, "production");
    const grading = validatedEvaluationGradingDefinition(input.gradingDefinition);
    assertEvaluationImplementationBinding({
      binding: input.implementationBinding,
      runtimeFunctions: input.runtimeFunctions,
      frozen: input.frozen,
      population: input.population,
      plan: input.plan,
      projectRoot: input.projectRoot,
      baselineRegistration: input.baselineRegistration,
      candidateRegistry: input.candidateRegistry,
      ablationRegistry: input.ablationRegistry,
      gradingDefinition: input.gradingDefinition,
    });
    if (grading.sha256 !== input.plan.grader_registry_sha256) {
      throw new Error("complete deterministic grading definition drifted from the frozen plan");
    }
    const baselineDefinition = directBaselineDefinition(
      input.baselineRegistration,
      input.projectRoot
    );
    if (canonicalJson(baselineDefinition) !== canonicalJson(input.plan.baseline)) {
      throw new Error("direct evaluation baseline definition drifted from the frozen plan");
    }
    if (baselineDefinition.liveness_policy_sha256 !== input.plan.budget_policy_sha256) {
      throw new Error("direct evaluation baseline liveness drifted from the frozen plan");
    }
    const candidate = resolveEvaluationCandidate({
      name: input.frozen.candidate_name,
      contract_sha256: input.frozen.candidate_contract_sha256,
      registry: input.candidateRegistry,
    });
    if (candidate === undefined || candidate.ingress !== "skill") {
      throw new Error(
        "evaluation-only candidate registration is unavailable, stale, or non-generic"
      );
    }
    const registrations = new Map<string, PlaybookRegistrationV1>([
      [input.baselineRegistration.name, input.baselineRegistration],
      [candidate.name, candidate],
    ]);
    for (const ablation of input.plan.ablations) {
      const registration = resolveEvaluationCandidate({
        name: ablation.name,
        contract_sha256: ablation.contract_sha256,
        registry: input.ablationRegistry,
      });
      if (registration === undefined || registration.ingress !== "skill") {
        throw new Error(`evaluation-only ablation '${ablation.name}' is unavailable or stale`);
      }
      registrations.set(registration.name, registration);
    }
    const evaluationOnlyControl = input.plan.mutation_gate?.evaluation_only_control;
    if (evaluationOnlyControl !== undefined) {
      const registration = resolveEvaluationCandidate({
        name: evaluationOnlyControl.name,
        contract_sha256: evaluationOnlyControl.contract_sha256,
        registry: input.ablationRegistry,
      });
      if (registration === undefined || registration.ingress !== "skill") {
        throw new Error(
          `evaluation-only mutation control '${evaluationOnlyControl.name}' is unavailable or stale`
        );
      }
    }
    assertExactBindingKeys({
      label: "semantic normalizer descriptor",
      expected: [...registrations.keys()],
      actual: [...grading.semanticNormalizerDescriptors.keys()],
    });
    for (const registration of registrations.values()) {
      const normalizer = grading.semanticNormalizerDescriptors.get(registration.name);
      if (normalizer === undefined) {
        throw new Error(`semantic normalizer '${registration.name}' is not registered`);
      }
      const matchingPorts = registration.contract.io.active_output_ports.filter(
        (port) =>
          port.transport === "artifact" &&
          port.artifact_kind === normalizer.source_output.artifact_kind &&
          port.schema_id === normalizer.source_output.schema_id &&
          port.schema_version_required === normalizer.source_output.schema_version
      );
      if (matchingPorts.length !== 1) {
        throw new Error(
          `semantic normalizer '${registration.name}' does not match exactly one active output port`
        );
      }
    }
    assertExactBindingKeys({
      label: "deterministic grader descriptor",
      expected: input.population.tasks.map((task) => task.grader_case_id),
      actual: [...grading.graderDescriptors.keys()],
    });
    const taskById = new Map(input.population.tasks.map((task) => [task.task_id, task]));
    for (const entry of input.frozen.schedule) {
      const registration = registrations.get(entry.variant_name);
      const task = taskById.get(entry.task_id);
      if (registration === undefined || task === undefined) {
        throw new Error("frozen evaluation schedule has an unresolved registration or task");
      }
      if (
        expectedRegistrationPolicyDigest({
          registration,
          plan: input.plan,
          task,
          entry,
          projectRoot: input.projectRoot,
        }) !== input.plan.budget_policy_sha256
      ) {
        throw new Error(
          `evaluation registration '${registration.name}' budget policy drifted from the frozen plan`
        );
      }
    }
  } catch (error) {
    if (error instanceof InvalidEvaluationFault) throw error;
    throw new InvalidEvaluationFault(
      "registration_preflight",
      "EVALUATION_REGISTRATION_INCOMPATIBLE",
      null,
      error
    );
  }
}

export function freezePairedEvaluation(input: {
  readonly population: unknown;
  readonly plan: unknown;
  readonly projectRoot: string;
  readonly baselineRegistration: PlaybookRegistrationV1;
  readonly candidateRegistry: PlaybookRegistryV1;
  readonly ablationRegistry?: PlaybookRegistryV1;
  readonly gradingDefinition?: EvaluationGradingDefinitionV1;
  readonly implementationBinding: unknown;
  readonly runtimeFunctions: readonly EvaluationRuntimeFunctionBindingV1[];
  readonly forbiddenContaminationGroups?: readonly string[];
}): FrozenPairedEvaluationV1 {
  const population = validateEvaluationPopulation(input.population, {
    ...(input.forbiddenContaminationGroups === undefined
      ? {}
      : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
  });
  const plan = validatePairedEvaluationPlan(input.plan);
  const frozen = freezePairedEvaluationContracts({
    population,
    plan,
    ...(input.forbiddenContaminationGroups === undefined
      ? {}
      : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
  });
  assertEvaluationRegistrationBindings({
    frozen,
    population,
    plan,
    baselineRegistration: input.baselineRegistration,
    candidateRegistry: input.candidateRegistry,
    ablationRegistry: input.ablationRegistry ?? new Map(),
    gradingDefinition: input.gradingDefinition ?? DETERMINISTIC_GRADING_DEFINITION,
    implementationBinding: input.implementationBinding,
    runtimeFunctions: input.runtimeFunctions,
    projectRoot: input.projectRoot,
  });
  return frozen;
}

function failureMeasurement(input: {
  readonly plan: PairedEvaluationPlanV1;
  readonly grader: DeterministicGraderDescriptorV1;
}): EvaluationTrialMeasurementV1 {
  return {
    task_score: input.plan.failure_rule.task_score,
    trigger_predicted: input.plan.failure_rule.trigger_predicted,
    protected_capability_score: input.grader.protected_capability
      ? input.plan.failure_rule.protected_capability_score
      : null,
    cost_microusd: input.plan.failure_rule.cost_microusd,
    latency_ms: input.plan.failure_rule.latency_ms,
  };
}

function malformedTrial(input: {
  readonly base: Omit<
    PairedEvaluationTrialV1,
    "terminal_status" | "output_refs" | "measurement" | "failure_rule_applied" | "failure_code"
  >;
  readonly outputRef: ArtifactRef;
  readonly plan: PairedEvaluationPlanV1;
  readonly grader: DeterministicGraderDescriptorV1;
  readonly failureCode: string;
}): PairedEvaluationTrialV1 {
  return {
    ...input.base,
    terminal_status: "malformed",
    output_refs: [input.outputRef],
    measurement: failureMeasurement({ plan: input.plan, grader: input.grader }),
    failure_rule_applied: true,
    failure_code: input.failureCode,
  };
}

function outputRefMatchesNormalizer(
  ref: ArtifactRef,
  normalizer: EvaluationSemanticNormalizerDescriptorV1
): boolean {
  return (
    ref.kind === normalizer.source_output.artifact_kind &&
    ref.content_schema?.schema_id === normalizer.source_output.schema_id &&
    ref.content_schema.schema_version === normalizer.source_output.schema_version
  );
}

function evaluatedTrial(input: {
  readonly entry: PairedEvaluationScheduleEntryV1;
  readonly task: EvaluationPopulationTaskV1;
  readonly plan: PairedEvaluationPlanV1;
  readonly observation: EvaluationTrialObservationV1 | undefined;
  readonly grading: ValidatedEvaluationGradingDefinitionV1;
}): PairedEvaluationTrialV1 {
  const grader = input.grading.graderDescriptors.get(input.task.grader_case_id);
  const gradeImplementation = input.grading.graderImplementations.get(input.task.grader_case_id);
  const normalizer = input.grading.semanticNormalizerDescriptors.get(input.entry.variant_name);
  const normalizeImplementation = input.grading.semanticNormalizerImplementations.get(
    input.entry.variant_name
  );
  if (
    grader === undefined ||
    gradeImplementation === undefined ||
    normalizer === undefined ||
    normalizeImplementation === undefined
  ) {
    throw new InvalidEvaluationFault(
      "registration_preflight",
      "EVALUATION_REGISTRATION_INCOMPATIBLE",
      input.entry.trial_id
    );
  }
  const base = {
    trial_id: input.entry.trial_id,
    pair_id: input.entry.pair_id,
    ordinal: input.entry.ordinal,
    task_id: input.entry.task_id,
    repetition: input.entry.repetition,
    variant: input.entry.variant,
    variant_name: input.entry.variant_name,
    binding_sha256: input.entry.binding_sha256,
  };
  const observation = input.observation;
  if (observation === undefined) {
    return {
      ...base,
      terminal_status: "missing",
      output_refs: [],
      measurement: failureMeasurement({ plan: input.plan, grader }),
      failure_rule_applied: true,
      failure_code: "MISSING_TRIAL",
    };
  }
  if (observation.trial_id !== input.entry.trial_id) {
    throw new Error("evaluation trial observation does not match its frozen schedule entry");
  }
  if (
    observation.terminal_status !== "complete" ||
    observation.output_ref === undefined ||
    observation.output_metadata === undefined ||
    observation.output_bytes === undefined
  ) {
    return {
      ...base,
      terminal_status: observation.terminal_status,
      output_refs: observation.output_ref === undefined ? [] : [observation.output_ref],
      measurement: failureMeasurement({ plan: input.plan, grader }),
      failure_rule_applied: true,
      failure_code: observation.failure_code ?? "MODEL_EXECUTION_ERROR",
    };
  }
  if (!outputRefMatchesNormalizer(observation.output_ref, normalizer)) {
    return malformedTrial({
      base,
      outputRef: observation.output_ref,
      plan: input.plan,
      grader,
      failureCode: "MALFORMED_TRIAL_OUTPUT",
    });
  }
  let normalized: EvaluationSemanticNormalizationV1;
  try {
    normalized = validateContract(
      EvaluationSemanticNormalizationV1Schema,
      normalizeImplementation.normalize({
        descriptor: normalizer,
        wire: input.grading.descriptor.wire,
        output_ref: observation.output_ref,
        output_metadata: observation.output_metadata,
        output_bytes: observation.output_bytes,
        task: input.task,
      }),
      "evaluation semantic normalization"
    );
  } catch (error) {
    throw new InvalidEvaluationFault(
      "semantic_normalization",
      "SEMANTIC_NORMALIZER_INCOMPATIBLE",
      input.entry.trial_id,
      error
    );
  }
  if (normalized.status === "invalid_output") {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(normalized.failure_code)) {
      throw new InvalidEvaluationFault(
        "semantic_normalization",
        "SEMANTIC_NORMALIZER_INCOMPATIBLE",
        input.entry.trial_id
      );
    }
    return malformedTrial({
      base,
      outputRef: observation.output_ref,
      plan: input.plan,
      grader,
      failureCode: normalized.failure_code,
    });
  }
  let grade: DeterministicGraderResultV1;
  try {
    grade = validateContract(
      DeterministicGraderResultV1Schema,
      gradeImplementation.grade(normalized.wire_bytes, input.task, grader),
      "deterministic evaluation grade"
    );
    if (
      grade.clause_results !== undefined &&
      new Set(grade.clause_results.map((clause) => clause.clause_id)).size !==
        grade.clause_results.length
    ) {
      throw new Error("deterministic evaluation grade clause IDs must be unique");
    }
  } catch (error) {
    throw new InvalidEvaluationFault(
      "grader_parser",
      "GRADER_PARSER_INCOMPATIBLE",
      input.entry.trial_id,
      error
    );
  }
  return {
    ...base,
    terminal_status: "complete",
    output_refs: [observation.output_ref],
    measurement: {
      ...grade,
      cost_microusd: observation.cost_microusd,
      latency_ms: observation.latency_ms,
    },
    failure_rule_applied: false,
    failure_code: null,
  };
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function normalizedCompletion(trial: PairedEvaluationTrialV1): boolean {
  return (
    trial.terminal_status === "complete" &&
    !trial.failure_rule_applied &&
    trial.failure_code === null
  );
}

function completionReliability(trials: readonly PairedEvaluationTrialV1[]) {
  const normalizedCompletions = trials.filter(normalizedCompletion).length;
  return {
    scheduled_trials: trials.length,
    normalized_completions: normalizedCompletions,
    incomplete_or_failed_trials: trials.length - normalizedCompletions,
    coverage: trials.length === 0 ? 0 : round(normalizedCompletions / trials.length),
  };
}

function failureTaxonomy(trials: readonly PairedEvaluationTrialV1[]) {
  const counts = new Map<string, number>();
  for (const trial of trials) {
    if (normalizedCompletion(trial)) continue;
    const failureCode = trial.failure_code;
    if (failureCode === null) {
      throw new Error("non-normalized candidate trial has no failure code");
    }
    counts.set(failureCode, (counts.get(failureCode) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([failure_code, count]) => ({ failure_code, count }));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((total, value) => total + value, 0) / values.length);
}

function ratio(candidate: number, baseline: number): number | null {
  if (baseline === 0) return candidate === 0 ? 1 : null;
  return round(candidate / baseline);
}

function resultBody(input: {
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: ReturnType<typeof validateEvaluationPopulation>;
  readonly plan: PairedEvaluationPlanV1;
  readonly trials: readonly PairedEvaluationTrialV1[];
  readonly mutationMeasurement?: EvaluationMutationMeasurementV1;
}): Omit<PairedEvaluationResultV1, "result_id"> {
  const baselineTrials = input.trials.filter((trial) => trial.variant === "baseline");
  const candidateTrials = input.trials.filter((trial) => trial.variant === "candidate");
  const baselineMean = mean(baselineTrials.map((trial) => trial.measurement.task_score));
  const candidateMean = mean(candidateTrials.map((trial) => trial.measurement.task_score));
  const ablationMetrics = input.plan.ablation_policies.map((policy) => {
    const ablationTrials = input.trials.filter(
      (trial) => trial.variant === "ablation" && trial.variant_name === policy.ablation_name
    );
    const ablationMean = mean(ablationTrials.map((trial) => trial.measurement.task_score));
    const delta = round(candidateMean - ablationMean);
    return {
      ablation_name: policy.ablation_name,
      ablation_primary_mean: ablationMean,
      candidate_minus_ablation_primary_delta: delta,
      frozen_floor: policy.candidate_minus_ablation_primary_floor,
      passed: delta >= policy.candidate_minus_ablation_primary_floor,
    };
  });
  const mutationPolicy = input.plan.mutation_gate;
  const mutationMeasurement = input.mutationMeasurement;
  if ((mutationPolicy === null) !== (mutationMeasurement === undefined)) {
    throw new Error(
      mutationPolicy === null
        ? "evaluation supplied an unfrozen deterministic mutation measurement"
        : "evaluation omitted the frozen deterministic mutation measurement"
    );
  }
  const mutationGate =
    mutationPolicy === null || mutationMeasurement === undefined
      ? null
      : (() => {
          if (
            mutationMeasurement.cohort_sha256 !== mutationPolicy.cohort_sha256 ||
            mutationMeasurement.mutation_count !== mutationPolicy.mutation_count ||
            mutationMeasurement.full_sealer_escaped_invalid_count >
              mutationMeasurement.mutation_count ||
            mutationMeasurement.ablation_escaped_invalid_count > mutationMeasurement.mutation_count
          ) {
            throw new Error("deterministic mutation measurement is stale or out of bounds");
          }
          const escapedRate = round(
            mutationMeasurement.full_sealer_escaped_invalid_count /
              mutationMeasurement.mutation_count
          );
          const passed =
            escapedRate <= mutationPolicy.full_sealer_escaped_invalid_rate_ceiling &&
            mutationMeasurement.ablation_escaped_invalid_count >=
              mutationPolicy.ablation_minimum_escaped_invalid_count;
          return {
            cohort_sha256: mutationMeasurement.cohort_sha256,
            mutation_count: mutationMeasurement.mutation_count,
            full_sealer_escaped_invalid_count:
              mutationMeasurement.full_sealer_escaped_invalid_count,
            full_sealer_escaped_invalid_rate: escapedRate,
            frozen_full_sealer_rate_ceiling:
              mutationPolicy.full_sealer_escaped_invalid_rate_ceiling,
            ...(mutationPolicy.ablation_name === undefined
              ? {}
              : { ablation_name: mutationPolicy.ablation_name }),
            ...(mutationPolicy.evaluation_only_control === undefined
              ? {}
              : {
                  evaluation_only_control_name: mutationPolicy.evaluation_only_control.name,
                }),
            ablation_escaped_invalid_count: mutationMeasurement.ablation_escaped_invalid_count,
            frozen_ablation_minimum_escaped_invalid_count:
              mutationPolicy.ablation_minimum_escaped_invalid_count,
            passed,
          };
        })();
  const protectedMean = mean(
    candidateTrials.flatMap((trial) =>
      trial.measurement.protected_capability_score === null
        ? []
        : [trial.measurement.protected_capability_score]
    )
  );
  const predictedTriggers = candidateTrials.filter((trial) => trial.measurement.trigger_predicted);
  const taskById = new Map(input.population.tasks.map((task) => [task.task_id, task]));
  const truePredictedTriggers = predictedTriggers.filter(
    (trial) => taskById.get(trial.task_id)?.trigger_expected === true
  );
  const triggerPrecision =
    predictedTriggers.length === 0
      ? input.population.tasks.some((task) => task.trigger_expected)
        ? 0
        : 1
      : round(truePredictedTriggers.length / predictedTriggers.length);
  const scheduledPositiveTrials = candidateTrials.filter(
    (trial) => taskById.get(trial.task_id)?.trigger_expected === true
  );
  const recalledPositiveTrials = scheduledPositiveTrials.filter(
    (trial) => trial.measurement.trigger_predicted
  );
  const triggerRecall =
    scheduledPositiveTrials.length === 0
      ? 1
      : round(recalledPositiveTrials.length / scheduledPositiveTrials.length);
  const byPair = new Map<
    string,
    { baseline?: PairedEvaluationTrialV1; candidate?: PairedEvaluationTrialV1 }
  >();
  for (const trial of [...baselineTrials, ...candidateTrials]) {
    const pair = byPair.get(trial.pair_id) ?? {};
    if (trial.variant === "baseline") pair.baseline = trial;
    if (trial.variant === "candidate") pair.candidate = trial;
    byPair.set(trial.pair_id, pair);
  }
  const pairValues = [...byPair.values()];
  const completePairs = pairValues.filter(
    (pair) =>
      pair.baseline !== undefined &&
      pair.candidate !== undefined &&
      normalizedCompletion(pair.baseline) &&
      normalizedCompletion(pair.candidate)
  );
  const negativeTransfers = pairValues.filter(
    (pair) =>
      pair.baseline !== undefined &&
      pair.candidate !== undefined &&
      pair.candidate.measurement.task_score < pair.baseline.measurement.task_score
  ).length;
  const negativeTransferRate =
    pairValues.length === 0 ? 1 : round(negativeTransfers / pairValues.length);
  const candidateMeanCost = mean(candidateTrials.map((trial) => trial.measurement.cost_microusd));
  const baselineMeanCost = mean(baselineTrials.map((trial) => trial.measurement.cost_microusd));
  const costRatio = ratio(candidateMeanCost, baselineMeanCost);
  const latencyRatio = ratio(
    mean(candidateTrials.map((trial) => trial.measurement.latency_ms)),
    mean(baselineTrials.map((trial) => trial.measurement.latency_ms))
  );
  const primaryDelta = round(candidateMean - baselineMean);
  const domainQualityPolicy = input.plan.domain_quality_policy;
  const domainMetrics =
    domainQualityPolicy === undefined
      ? undefined
      : [...new Set(input.population.tasks.map((task) => task.domain))]
          .sort(compareKeys)
          .map((domain) => {
            const domainTaskIds = new Set(
              input.population.tasks
                .filter((task) => task.domain === domain)
                .map((task) => task.task_id)
            );
            const candidateScheduledMean = mean(
              candidateTrials
                .filter((trial) => domainTaskIds.has(trial.task_id))
                .map((trial) => trial.measurement.task_score)
            );
            const domainCompletePairs = completePairs.filter(
              (pair) => pair.candidate !== undefined && domainTaskIds.has(pair.candidate.task_id)
            );
            const pairedDelta =
              domainCompletePairs.length === 0
                ? null
                : mean(
                    domainCompletePairs.map((pair) => {
                      if (pair.baseline === undefined || pair.candidate === undefined) {
                        throw new Error("complete evaluation pair lost one arm");
                      }
                      return (
                        pair.candidate.measurement.task_score - pair.baseline.measurement.task_score
                      );
                    })
                  );
            return {
              domain,
              candidate_scheduled_mean: candidateScheduledMean,
              candidate_scheduled_mean_floor: domainQualityPolicy.candidate_scheduled_mean_floor,
              candidate_scheduled_mean_passed:
                candidateScheduledMean >= domainQualityPolicy.candidate_scheduled_mean_floor,
              complete_pair_count: domainCompletePairs.length,
              candidate_minus_baseline_paired_mean_delta: pairedDelta,
              candidate_minus_baseline_paired_mean_floor:
                domainQualityPolicy.candidate_minus_baseline_paired_mean_floor,
              candidate_minus_baseline_paired_mean_passed:
                pairedDelta !== null &&
                pairedDelta >= domainQualityPolicy.candidate_minus_baseline_paired_mean_floor,
            };
          });
  const candidateReliability = completionReliability(candidateTrials);
  const baselineReliability = completionReliability(baselineTrials);
  const pairCoverage =
    pairValues.length === 0 ? 0 : round(completePairs.length / pairValues.length);
  const baselineValidity = {
    ...baselineReliability,
    frozen_floor: input.plan.comparison_validity_policy.baseline_normalized_completion_floor,
    passed:
      baselineReliability.coverage >=
      input.plan.comparison_validity_policy.baseline_normalized_completion_floor,
  };
  const completePairValidity = {
    scheduled_pairs: pairValues.length,
    complete_pairs: completePairs.length,
    incomplete_pairs: pairValues.length - completePairs.length,
    coverage: pairCoverage,
    frozen_floor:
      input.plan.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor,
    passed:
      pairCoverage >=
      input.plan.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor,
  };
  const requiredComparators = [
    ...input.plan.comparison_validity_policy.required_comparator_normalized_completion_floors,
  ]
    .sort((left, right) => compareKeys(left.comparator_name, right.comparator_name))
    .map((policy) => {
      const reliability = completionReliability(
        input.trials.filter(
          (trial) => trial.variant === "ablation" && trial.variant_name === policy.comparator_name
        )
      );
      return {
        comparator_name: policy.comparator_name,
        ...reliability,
        frozen_floor: policy.normalized_completion_floor,
        passed: reliability.coverage >= policy.normalized_completion_floor,
      };
    });
  const candidateFloor =
    input.plan.comparison_validity_policy.candidate_normalized_completion_floor;
  const candidateValidity =
    candidateFloor === undefined
      ? undefined
      : {
          ...candidateReliability,
          frozen_floor: candidateFloor,
          passed: candidateReliability.coverage >= candidateFloor,
        };
  const invalidReasons = !baselineValidity.passed
    ? (["BASELINE_NORMALIZED_COMPLETION_BELOW_FLOOR"] as const)
    : candidateReliability.normalized_completions === 0
      ? (["CANDIDATE_ZERO_NORMALIZED_COMPLETIONS"] as const)
      : [
          ...((candidateValidity?.passed ?? true)
            ? []
            : (["CANDIDATE_NORMALIZED_COMPLETION_BELOW_FLOOR"] as const)),
          ...(completePairValidity.passed ? [] : (["COMPLETE_PAIR_COVERAGE_BELOW_FLOOR"] as const)),
          ...(requiredComparators.every((comparator) => comparator.passed)
            ? []
            : (["REQUIRED_COMPARATOR_NORMALIZED_COMPLETION_BELOW_FLOOR"] as const)),
        ];
  const comparisonValid = invalidReasons.length === 0;
  const allTrialsComplete = input.trials.every((trial) => trial.terminal_status === "complete");
  const ratesAreZero = Object.values(input.plan.runtime_binding.rates).every((rate) => rate === 0);
  const exactZeroCostRequired =
    input.plan.cost_latency_policy.require_exact_zero_cost_when_unpriced === true && ratesAreZero;
  const exactZeroCostPassed =
    !exactZeroCostRequired || (candidateMeanCost === 0 && baselineMeanCost === 0);
  const requireAllTrialsComplete =
    input.plan.comparison_validity_policy.require_all_scheduled_trials_complete ?? true;
  const outcomes = {
    comparison_validity: comparisonValid,
    complete_pairing: requireAllTrialsComplete
      ? allTrialsComplete && completePairs.length === pairValues.length
      : completePairValidity.passed,
    material_effect: primaryDelta >= input.plan.material_effect_threshold,
    ...(input.plan.candidate_scheduled_mean_floor === undefined
      ? {}
      : {
          candidate_absolute_quality: candidateMean >= input.plan.candidate_scheduled_mean_floor,
        }),
    protected_capability: protectedMean >= input.plan.protected_capability_floor,
    trigger_precision: triggerPrecision >= input.plan.trigger_precision_floor,
    ...(input.plan.trigger_recall_floor === undefined
      ? {}
      : { trigger_recall: triggerRecall >= input.plan.trigger_recall_floor }),
    ...(domainMetrics === undefined
      ? {}
      : {
          domain_candidate_quality: domainMetrics.every(
            (metric) => metric.candidate_scheduled_mean_passed
          ),
          domain_paired_delta: domainMetrics.every(
            (metric) => metric.candidate_minus_baseline_paired_mean_passed
          ),
        }),
    negative_transfer:
      input.plan.negative_transfer_ceiling === null ||
      negativeTransferRate <= input.plan.negative_transfer_ceiling,
    cost:
      exactZeroCostPassed &&
      costRatio !== null &&
      costRatio <= input.plan.cost_latency_policy.max_candidate_to_baseline_cost_ratio,
    ...(input.plan.cost_latency_policy.require_exact_zero_cost_when_unpriced === true
      ? { zero_cost_exact: exactZeroCostPassed }
      : {}),
    latency:
      latencyRatio !== null &&
      latencyRatio <= input.plan.cost_latency_policy.max_candidate_to_baseline_latency_ratio,
    ablation_non_inferiority: ablationMetrics.every((metric) => metric.passed),
    deterministic_mutation: mutationGate?.passed ?? true,
  };
  const allPassed = Object.values(outcomes).every((passed) => passed);
  const disposition = !baselineValidity.passed
    ? "INVALID_EVALUATION"
    : candidateReliability.normalized_completions === 0
      ? "RETIRED"
      : !comparisonValid
        ? "INVALID_EVALUATION"
        : allPassed
          ? input.plan.deterministic_disposition_rule.on_pass
          : input.plan.deterministic_disposition_rule.on_fail;
  const dispositionReason =
    !baselineValidity.passed ||
    (candidateReliability.normalized_completions > 0 && !comparisonValid)
      ? "COMPARATIVE_UNVERIFIABLE"
      : candidateReliability.normalized_completions === 0
        ? "CANDIDATE_ZERO_NORMALIZED_COMPLETIONS"
        : allPassed
          ? "FROZEN_POLICY_PASS"
          : "FROZEN_POLICY_FAIL";
  const statuses = input.trials.map((trial) => trial.terminal_status);
  return {
    schema_version: 1,
    purpose: input.plan.purpose,
    plan_id: input.plan.plan_id,
    plan_sha256: input.frozen.plan_sha256,
    population_id: input.population.population_id,
    population_revision: input.population.revision,
    population_sha256: input.frozen.population_sha256,
    schedule_sha256: input.frozen.schedule_sha256,
    candidate_name: input.plan.candidate.name,
    candidate_contract_sha256: input.plan.candidate.contract_sha256,
    baseline_definition_sha256: input.plan.baseline.definition_sha256,
    budget_policy_sha256: input.plan.budget_policy_sha256,
    grader_registry_sha256: input.plan.grader_registry_sha256,
    implementation_binding_sha256: input.plan.implementation_binding_sha256,
    trials: [...input.trials],
    trial_accounting: {
      scheduled: input.trials.length,
      complete: statuses.filter((status) => status === "complete").length,
      missing: statuses.filter((status) => status === "missing").length,
      nonterminal: statuses.filter((status) => status === "nonterminal").length,
      cancelled: statuses.filter((status) => status === "cancelled").length,
      malformed: statuses.filter((status) => status === "malformed").length,
      error: statuses.filter((status) => status === "error").length,
    },
    complete_pair_coverage: {
      scheduled_pairs: pairValues.length,
      complete_pairs: completePairs.length,
      incomplete_pairs: pairValues.length - completePairs.length,
      coverage: pairCoverage,
    },
    candidate_completion_reliability: candidateReliability,
    candidate_failure_taxonomy: failureTaxonomy(candidateTrials),
    comparison_validity: {
      status: comparisonValid ? "VALID" : "COMPARATIVE_UNVERIFIABLE",
      baseline: baselineValidity,
      ...(candidateValidity === undefined ? {} : { candidate: candidateValidity }),
      complete_pairs: completePairValidity,
      required_comparators: requiredComparators,
      invalid_reasons: [...invalidReasons],
    },
    aggregate_deltas: {
      baseline_primary_mean: baselineMean,
      candidate_primary_mean: candidateMean,
      primary_delta: primaryDelta,
      candidate_protected_mean: protectedMean,
      candidate_trigger_precision: triggerPrecision,
      ...(input.plan.trigger_recall_floor === undefined
        ? {}
        : { candidate_trigger_recall: triggerRecall }),
      negative_transfer_rate: negativeTransferRate,
      candidate_to_baseline_cost_ratio: costRatio,
      candidate_to_baseline_latency_ratio: latencyRatio,
    },
    ...(domainMetrics === undefined ? {} : { domain_metrics: domainMetrics }),
    ablation_metrics: ablationMetrics,
    mutation_gate: mutationGate,
    policy_outcomes: { ...outcomes, all_passed: allPassed },
    ...(disposition === "INVALID_EVALUATION"
      ? {
          invalid_evaluation: {
            stage: "comparison_validity" as const,
            code: "COMPARATIVE_UNVERIFIABLE",
            trial_id: null,
          },
        }
      : {}),
    disposition,
    disposition_reason: dispositionReason,
  };
}

function invalidEvaluationResult(input: {
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: ReturnType<typeof validateEvaluationPopulation>;
  readonly plan: PairedEvaluationPlanV1;
  readonly observationByTrial: ReadonlyMap<string, EvaluationTrialObservationV1>;
  readonly fault: InvalidEvaluationFault;
}): PairedEvaluationResultV1 {
  const trials: PairedEvaluationTrialV1[] = input.frozen.schedule.map((entry) => {
    const observation = input.observationByTrial.get(entry.trial_id);
    return {
      trial_id: entry.trial_id,
      pair_id: entry.pair_id,
      ordinal: entry.ordinal,
      task_id: entry.task_id,
      repetition: entry.repetition,
      variant: entry.variant,
      variant_name: entry.variant_name,
      binding_sha256: entry.binding_sha256,
      terminal_status: observation?.terminal_status ?? "missing",
      output_refs: observation?.output_ref === undefined ? [] : [observation.output_ref],
      measurement: {
        task_score: 0,
        trigger_predicted: false,
        protected_capability_score: null,
        cost_microusd: observation?.cost_microusd ?? 0,
        latency_ms: observation?.latency_ms ?? 0,
      },
      failure_rule_applied: false,
      failure_code: "INVALID_EVALUATION_UNSCORED",
    };
  });
  const statuses = trials.map((trial) => trial.terminal_status);
  const scheduledPairs = new Set(trials.map((trial) => trial.pair_id)).size;
  const candidateTrials = trials.filter((trial) => trial.variant === "candidate");
  const baselineTrials = trials.filter((trial) => trial.variant === "baseline");
  const candidateReliability = completionReliability(candidateTrials);
  const baselineReliability = completionReliability(baselineTrials);
  const requiredComparators = [
    ...input.plan.comparison_validity_policy.required_comparator_normalized_completion_floors,
  ]
    .sort((left, right) => compareKeys(left.comparator_name, right.comparator_name))
    .map((policy) => {
      const reliability = completionReliability(
        trials.filter(
          (trial) => trial.variant === "ablation" && trial.variant_name === policy.comparator_name
        )
      );
      return {
        comparator_name: policy.comparator_name,
        ...reliability,
        frozen_floor: policy.normalized_completion_floor,
        passed: reliability.coverage >= policy.normalized_completion_floor,
      };
    });
  const body: Omit<PairedEvaluationResultV1, "result_id"> = {
    schema_version: 1,
    purpose: input.plan.purpose,
    plan_id: input.plan.plan_id,
    plan_sha256: input.frozen.plan_sha256,
    population_id: input.population.population_id,
    population_revision: input.population.revision,
    population_sha256: input.frozen.population_sha256,
    schedule_sha256: input.frozen.schedule_sha256,
    candidate_name: input.plan.candidate.name,
    candidate_contract_sha256: input.plan.candidate.contract_sha256,
    baseline_definition_sha256: input.plan.baseline.definition_sha256,
    budget_policy_sha256: input.plan.budget_policy_sha256,
    grader_registry_sha256: input.plan.grader_registry_sha256,
    implementation_binding_sha256: input.plan.implementation_binding_sha256,
    trials,
    trial_accounting: {
      scheduled: trials.length,
      complete: statuses.filter((status) => status === "complete").length,
      missing: statuses.filter((status) => status === "missing").length,
      nonterminal: statuses.filter((status) => status === "nonterminal").length,
      cancelled: statuses.filter((status) => status === "cancelled").length,
      malformed: statuses.filter((status) => status === "malformed").length,
      error: statuses.filter((status) => status === "error").length,
    },
    complete_pair_coverage: {
      scheduled_pairs: scheduledPairs,
      complete_pairs: 0,
      incomplete_pairs: scheduledPairs,
      coverage: 0,
    },
    candidate_completion_reliability: candidateReliability,
    candidate_failure_taxonomy: failureTaxonomy(candidateTrials),
    comparison_validity: {
      status: "COMPARATIVE_UNVERIFIABLE",
      baseline: {
        ...baselineReliability,
        frozen_floor: input.plan.comparison_validity_policy.baseline_normalized_completion_floor,
        passed:
          baselineReliability.coverage >=
          input.plan.comparison_validity_policy.baseline_normalized_completion_floor,
      },
      complete_pairs: {
        scheduled_pairs: scheduledPairs,
        complete_pairs: 0,
        incomplete_pairs: scheduledPairs,
        coverage: 0,
        frozen_floor:
          input.plan.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor,
        passed:
          0 >= input.plan.comparison_validity_policy.nonzero_candidate_complete_pair_coverage_floor,
      },
      required_comparators: requiredComparators,
      invalid_reasons: ["EVALUATION_INCOMPATIBILITY"],
    },
    aggregate_deltas: {
      baseline_primary_mean: 0,
      candidate_primary_mean: 0,
      primary_delta: 0,
      candidate_protected_mean: 0,
      candidate_trigger_precision: 0,
      negative_transfer_rate: 0,
      candidate_to_baseline_cost_ratio: null,
      candidate_to_baseline_latency_ratio: null,
    },
    ablation_metrics: [],
    mutation_gate: null,
    policy_outcomes: {
      comparison_validity: false,
      complete_pairing: false,
      material_effect: false,
      protected_capability: false,
      trigger_precision: false,
      negative_transfer: false,
      cost: false,
      latency: false,
      ablation_non_inferiority: false,
      deterministic_mutation: false,
      all_passed: false,
    },
    invalid_evaluation: {
      stage: input.fault.stage,
      code: input.fault.code,
      trial_id: input.fault.trialId,
    },
    disposition: "INVALID_EVALUATION",
    disposition_reason: "EVALUATION_INCOMPATIBILITY",
  };
  return validatePairedEvaluationResult({ ...body, result_id: pairedEvaluationResultId(body) });
}

function assertScheduledGradingBindings(input: {
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: ReturnType<typeof validateEvaluationPopulation>;
  readonly grading: ValidatedEvaluationGradingDefinitionV1;
}): void {
  try {
    assertExactBindingKeys({
      label: "scheduled semantic normalizer descriptor",
      expected: input.frozen.schedule.map((entry) => entry.variant_name),
      actual: [...input.grading.semanticNormalizerDescriptors.keys()],
    });
    assertExactBindingKeys({
      label: "scheduled deterministic grader descriptor",
      expected: input.population.tasks.map((task) => task.grader_case_id),
      actual: [...input.grading.graderDescriptors.keys()],
    });
  } catch (error) {
    throw new InvalidEvaluationFault(
      "registration_preflight",
      "EVALUATION_REGISTRATION_INCOMPATIBLE",
      null,
      error
    );
  }
}

export function evaluateTrialObservations(input: {
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: unknown;
  readonly plan: unknown;
  readonly observations: readonly EvaluationTrialObservationV1[];
  readonly gradingDefinition?: EvaluationGradingDefinitionV1;
  readonly mutationMeasurement?: EvaluationMutationMeasurementV1;
  readonly forbiddenContaminationGroups?: readonly string[];
}): PairedEvaluationResultV1 {
  assertFrozenEvaluationInputs({
    frozen: input.frozen,
    population: input.population,
    plan: input.plan,
    ...(input.forbiddenContaminationGroups === undefined
      ? {}
      : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
  });
  const population = validateEvaluationPopulation(input.population, {
    ...(input.forbiddenContaminationGroups === undefined
      ? {}
      : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
  });
  const plan = validatePairedEvaluationPlan(input.plan);
  const gradingDefinition = input.gradingDefinition ?? DETERMINISTIC_GRADING_DEFINITION;
  const mutationMeasurement =
    input.mutationMeasurement === undefined
      ? undefined
      : validateContract(
          EvaluationMutationMeasurementV1Schema,
          input.mutationMeasurement,
          "evaluation mutation measurement"
        );
  const observationByTrial = new Map<string, EvaluationTrialObservationV1>();
  for (const observation of input.observations) {
    if (observationByTrial.has(observation.trial_id)) {
      throw new Error(`duplicate evaluation trial observation '${observation.trial_id}'`);
    }
    observationByTrial.set(observation.trial_id, observation);
  }
  const unknownObservations = [...observationByTrial.keys()].filter(
    (trialId) => !input.frozen.schedule.some((entry) => entry.trial_id === trialId)
  );
  if (unknownObservations.length > 0) {
    throw new Error(`observation '${unknownObservations[0]}' is absent from the frozen schedule`);
  }
  try {
    let grading: ValidatedEvaluationGradingDefinitionV1;
    try {
      grading = validatedEvaluationGradingDefinition(gradingDefinition);
    } catch (error) {
      throw new InvalidEvaluationFault(
        "registration_preflight",
        "EVALUATION_REGISTRATION_INCOMPATIBLE",
        null,
        error
      );
    }
    if (grading.sha256 !== plan.grader_registry_sha256) {
      throw new InvalidEvaluationFault(
        "registration_preflight",
        "EVALUATION_REGISTRATION_INCOMPATIBLE",
        null
      );
    }
    assertScheduledGradingBindings({
      frozen: input.frozen,
      population,
      grading,
    });
    const taskById = new Map(population.tasks.map((task) => [task.task_id, task]));
    const trials = input.frozen.schedule.map((entry) => {
      const task = taskById.get(entry.task_id);
      if (task === undefined) throw new Error(`frozen task '${entry.task_id}' is unavailable`);
      return evaluatedTrial({
        entry,
        task,
        plan,
        observation: observationByTrial.get(entry.trial_id),
        grading,
      });
    });
    const body = resultBody({
      frozen: input.frozen,
      population,
      plan,
      trials,
      ...(mutationMeasurement === undefined ? {} : { mutationMeasurement }),
    });
    return validatePairedEvaluationResult({ ...body, result_id: pairedEvaluationResultId(body) });
  } catch (error) {
    if (!(error instanceof InvalidEvaluationFault)) throw error;
    return invalidEvaluationResult({
      frozen: input.frozen,
      population,
      plan,
      observationByTrial,
      fault: error,
    });
  }
}

function persistEvaluationResult(input: {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly result: PairedEvaluationResultV1;
}): ArtifactRef {
  const state = resolvePennyRuntimeState(input.projectRoot, { env: input.env });
  using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
    projectId: state.projectId,
  });
  const upstreamRefs = [
    ...new Map(
      [
        ...input.result.trials.flatMap((trial) => trial.output_refs),
        ...(input.result.semantic_qualification?.trial_qualifications.flatMap((qualification) => [
          qualification.trial_review_journal_ref,
          qualification.oracle_review_journal_ref,
        ]) ?? []),
      ].map((ref) => [ref.artifact_id, ref])
    ).values(),
  ].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  const content = canonicalJson(input.result);
  const ref = artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: `evaluation-${sha256(input.result.plan_id).slice(0, 32)}`,
      phase: "evaluation",
      branch_id: null,
      kind: "evaluation-result",
      operation_id: `paired-evaluation-result:${input.result.result_id}`,
      version: 1,
      producer: "host:evaluation-runner",
      media_type: "application/json",
      content_schema: {
        schema_id: "penny.paired-evaluation-result.v1",
        schema_version: 1,
      },
      parent_ref: null,
      upstream_refs: upstreamRefs,
    },
    content,
  });
  const rereadRef = artifacts.refById(ref.artifact_id);
  if (rereadRef === undefined || canonicalJson(rereadRef) !== canonicalJson(ref)) {
    throw new Error("evaluation-result artifact failed immutable manifest re-read");
  }
  const rereadBytes = artifacts.readById(ref.artifact_id).toString("utf8");
  if (rereadBytes !== content) {
    throw new Error("evaluation-result artifact failed exact-byte re-read");
  }
  const rereadValue: unknown = JSON.parse(rereadBytes);
  if (canonicalJson(validatePairedEvaluationResult(rereadValue)) !== content) {
    throw new Error("evaluation-result artifact failed contract re-read");
  }
  return rereadRef;
}

export interface EvaluationSemanticTaskQualificationV1 {
  readonly task_disposition: "PASS" | "FAIL" | "BLOCKED";
  readonly qualification_status: "QUALIFIED" | "NOT_QUALIFIED";
  readonly aggregate_success: boolean;
  readonly reason_code: string;
  readonly clause_results: readonly SemanticClauseResultV1[];
}

export interface EvaluationSemanticAuthorizationBindingV1 {
  readonly schedule_sha256: string;
  readonly arms: readonly { readonly arm_id: string; readonly binding_sha256: string }[];
  readonly execution_binding: {
    readonly provider: string;
    readonly model: string;
    readonly runtime: string;
    readonly thinking_level: EvaluationRuntimeBindingV1["thinking_level"];
  };
}

export interface EvaluationSemanticReviewCoordinatorV1 {
  /** Must verify the exact prepared manifest and separate owner approval; must not create a model. */
  preflight(input: {
    readonly frozen: FrozenPairedEvaluationV1;
    readonly population: EvaluationPopulationV1;
    readonly plan: PairedEvaluationPlanV1;
    readonly gradingDefinition: EvaluationGradingDefinitionV1;
  }): Promise<EvaluationSemanticAuthorizationBindingV1>;
  /** Receives semantic content only; host arm/schedule metadata is deliberately not included. */
  review(input: {
    readonly task: EvaluationPopulationTaskV1;
    readonly wire_bytes: string;
    readonly grader: DeterministicGraderDescriptorV1;
    readonly structural_grade: DeterministicGraderResultV1;
  }): Promise<{
    readonly trial_review: VerifiedSemanticReviewEvidenceV1;
    readonly oracle_review: VerifiedSemanticReviewEvidenceV1;
    readonly provider_calls: number;
  }>;
}

export function createEvaluationSemanticReviewCoordinator(input: {
  readonly executor: {
    preflight(): Promise<{
      readonly manifest: {
        readonly execution_binding: {
          readonly provider: string;
          readonly model: string;
          readonly runtime: string;
          readonly thinking_level: EvaluationRuntimeBindingV1["thinking_level"];
        };
        readonly calibration: {
          readonly schedule_sha256: string;
          readonly arms: readonly {
            readonly arm_id: string;
            readonly binding_sha256: string;
          }[];
        };
      };
    }>;
    review(review: {
      readonly packet: unknown;
      readonly reviewKind: "trial" | "oracle";
      readonly canonicalClauseIds: readonly string[];
    }): Promise<{
      readonly provider_calls: 0 | 1;
      readonly evidence: VerifiedSemanticReviewEvidenceV1;
    }>;
  };
  readonly trialClauseIds: readonly string[];
  readonly oracleClauseIds: readonly string[];
  readonly buildTrialPacket: (review: {
    readonly task: EvaluationPopulationTaskV1;
    readonly wire_bytes: string;
    readonly grader: DeterministicGraderDescriptorV1;
    readonly structural_grade: DeterministicGraderResultV1;
  }) => unknown;
  readonly buildOraclePacket: (review: {
    readonly task: EvaluationPopulationTaskV1;
    readonly grader: DeterministicGraderDescriptorV1;
  }) => unknown;
}): EvaluationSemanticReviewCoordinatorV1 {
  return {
    preflight: async () => {
      const authorization = await input.executor.preflight();
      return {
        schedule_sha256: authorization.manifest.calibration.schedule_sha256,
        arms: authorization.manifest.calibration.arms,
        execution_binding: authorization.manifest.execution_binding,
      };
    },
    review: async (review) => {
      const oracle = await input.executor.review({
        packet: input.buildOraclePacket({ task: review.task, grader: review.grader }),
        reviewKind: "oracle",
        canonicalClauseIds: input.oracleClauseIds,
      });
      const trial = await input.executor.review({
        packet: input.buildTrialPacket(review),
        reviewKind: "trial",
        canonicalClauseIds: input.trialClauseIds,
      });
      return {
        trial_review: trial.evidence,
        oracle_review: oracle.evidence,
        provider_calls: trial.provider_calls + oracle.provider_calls,
      };
    },
  };
}

export interface EvaluationSemanticTrialQualificationV1 extends EvaluationSemanticTaskQualificationV1 {
  readonly trial_id: string;
  readonly task_id: string;
  readonly repetition: number;
  readonly variant: "baseline" | "candidate" | "ablation";
  readonly variant_name: string;
  readonly trial_invocation_receipt_id: string;
  readonly oracle_invocation_receipt_id: string;
  readonly trial_packet_sha256: string;
  readonly oracle_packet_sha256: string;
  readonly trial_review_journal_ref: ArtifactRef;
  readonly oracle_review_journal_ref: ArtifactRef;
}

export interface EvaluationSemanticQualificationV1 {
  readonly status: "QUALIFIED" | "NOT_QUALIFIED" | "INVALID_EVALUATION";
  readonly reason_code:
    | "ALL_SCHEDULED_ARMS_QUALIFIED"
    | "SEMANTIC_REVIEW_NOT_CONFIGURED"
    | "SCHEDULED_ARM_NOT_QUALIFIED"
    | "EVALUATION_INVALID";
  readonly provider_calls: number;
  readonly trial_qualifications: readonly EvaluationSemanticTrialQualificationV1[];
}

export interface EvaluationExecutionAccountingV1 {
  readonly newly_started_trials: number;
  readonly newly_recorded_terminals: number;
  readonly retained_journal_observations: number;
  readonly outstanding_schedule_entries: number;
  readonly loopback_provider_calls: number;
}

export interface PairedEvaluationRunV1 {
  readonly frozen: FrozenPairedEvaluationV1;
  readonly result: PairedEvaluationResultV1;
  readonly result_artifact_ref: ArtifactRef;
  readonly execution_accounting: EvaluationExecutionAccountingV1;
  readonly semantic_qualification: EvaluationSemanticQualificationV1;
}

function unavailableSemanticQualification(
  status: "NOT_QUALIFIED" | "INVALID_EVALUATION"
): EvaluationSemanticQualificationV1 {
  return {
    status,
    reason_code:
      status === "INVALID_EVALUATION" ? "EVALUATION_INVALID" : "SEMANTIC_REVIEW_NOT_CONFIGURED",
    provider_calls: 0,
    trial_qualifications: [],
  };
}

function attachSemanticQualification(
  result: PairedEvaluationResultV1,
  qualification: EvaluationSemanticQualificationV1
): PairedEvaluationResultV1 {
  const {
    result_id: resultId,
    semantic_qualification: priorSemanticQualification,
    ...body
  } = result;
  void resultId;
  void priorSemanticQualification;
  const qualifiedBody: Omit<PairedEvaluationResultV1, "result_id"> = {
    ...body,
    semantic_qualification: {
      ...qualification,
      trial_qualifications: qualification.trial_qualifications.map((trial) => ({
        ...trial,
        clause_results: trial.clause_results.map((clause) => ({
          ...clause,
          oracle_refs: [...clause.oracle_refs],
          evidence_refs: [...clause.evidence_refs],
        })),
      })),
    },
  };
  return validatePairedEvaluationResult({
    ...qualifiedBody,
    result_id: pairedEvaluationResultId(qualifiedBody),
  });
}

function emptyExecutionAccounting(
  outstandingScheduleEntries: number
): EvaluationExecutionAccountingV1 {
  return {
    newly_started_trials: 0,
    newly_recorded_terminals: 0,
    retained_journal_observations: 0,
    outstanding_schedule_entries: outstandingScheduleEntries,
    loopback_provider_calls: 0,
  };
}

const EvaluationSemanticTaskQualificationV1Schema = Type.Object(
  {
    task_disposition: Type.Union([
      Type.Literal("PASS"),
      Type.Literal("FAIL"),
      Type.Literal("BLOCKED"),
    ]),
    qualification_status: Type.Union([Type.Literal("QUALIFIED"), Type.Literal("NOT_QUALIFIED")]),
    aggregate_success: Type.Boolean(),
    reason_code: Type.String({ minLength: 1, maxLength: 128 }),
    clause_results: Type.Array(SemanticClauseResultV1Schema, { minItems: 1, maxItems: 64 }),
  },
  { additionalProperties: false }
);

async function collectSemanticQualifications(input: {
  readonly coordinator: EvaluationSemanticReviewCoordinatorV1 | undefined;
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: EvaluationPopulationV1;
  readonly result: PairedEvaluationResultV1;
  readonly observations: readonly (EvaluationTrialObservationV1 | undefined)[];
  readonly gradingDefinition: EvaluationGradingDefinitionV1;
}): Promise<EvaluationSemanticQualificationV1> {
  if (input.result.disposition === "INVALID_EVALUATION") {
    return unavailableSemanticQualification("INVALID_EVALUATION");
  }
  if (input.coordinator === undefined) {
    return unavailableSemanticQualification("NOT_QUALIFIED");
  }
  const grading = validatedEvaluationGradingDefinition(input.gradingDefinition);
  const taskById = new Map(input.population.tasks.map((task) => [task.task_id, task]));
  const trialById = new Map(input.result.trials.map((trial) => [trial.trial_id, trial]));
  const qualifications: EvaluationSemanticTrialQualificationV1[] = [];
  let providerCalls = 0;
  for (const [index, entry] of input.frozen.schedule.entries()) {
    const trial = trialById.get(entry.trial_id);
    if (trial?.terminal_status !== "complete") continue;
    const task = taskById.get(entry.task_id);
    const observation = input.observations[index];
    const grader =
      task === undefined ? undefined : grading.graderDescriptors.get(task.grader_case_id);
    const gradeImplementation =
      task === undefined ? undefined : grading.graderImplementations.get(task.grader_case_id);
    const normalizer = grading.semanticNormalizerDescriptors.get(entry.variant_name);
    const normalizeImplementation = grading.semanticNormalizerImplementations.get(
      entry.variant_name
    );
    if (
      task === undefined ||
      observation?.output_ref === undefined ||
      observation.output_metadata === undefined ||
      observation.output_bytes === undefined ||
      grader === undefined ||
      gradeImplementation === undefined ||
      gradeImplementation.qualifySemanticReview === undefined ||
      normalizer === undefined ||
      normalizeImplementation === undefined
    ) {
      throw new InvalidEvaluationFault(
        "semantic_review",
        "SEMANTIC_REVIEW_INCOMPATIBLE",
        entry.trial_id
      );
    }
    let normalized: EvaluationSemanticNormalizationV1;
    let structuralGrade: DeterministicGraderResultV1;
    try {
      normalized = validateContract(
        EvaluationSemanticNormalizationV1Schema,
        normalizeImplementation.normalize({
          descriptor: normalizer,
          wire: grading.descriptor.wire,
          output_ref: observation.output_ref,
          output_metadata: observation.output_metadata,
          output_bytes: observation.output_bytes,
          task,
        }),
        "semantic-review normalization"
      );
      if (normalized.status !== "normalized") {
        throw new Error("completed evaluation trial did not reproduce a reviewable semantic wire");
      }
      structuralGrade = validateContract(
        DeterministicGraderResultV1Schema,
        gradeImplementation.grade(normalized.wire_bytes, task, grader),
        "semantic-review structural grade"
      );
    } catch (error) {
      throw new InvalidEvaluationFault(
        "semantic_review",
        "SEMANTIC_REVIEW_INCOMPATIBLE",
        entry.trial_id,
        error
      );
    }
    let reviewed: Awaited<ReturnType<EvaluationSemanticReviewCoordinatorV1["review"]>>;
    try {
      reviewed = await input.coordinator.review({
        task,
        wire_bytes: normalized.wire_bytes,
        grader,
        structural_grade: structuralGrade,
      });
    } catch (error) {
      throw new InvalidEvaluationFault(
        "semantic_review",
        "SEMANTIC_REVIEW_INCOMPATIBLE",
        entry.trial_id,
        error
      );
    }
    let qualification: EvaluationSemanticTaskQualificationV1;
    try {
      qualification = validateContract(
        EvaluationSemanticTaskQualificationV1Schema,
        gradeImplementation.qualifySemanticReview({
          wireBytes: normalized.wire_bytes,
          task,
          descriptor: grader,
          semanticReview: reviewed.trial_review,
          oracleReview: reviewed.oracle_review,
        }),
        "semantic task qualification"
      );
    } catch (error) {
      throw new InvalidEvaluationFault(
        "semantic_review",
        "SEMANTIC_REVIEW_INCOMPATIBLE",
        entry.trial_id,
        error
      );
    }
    if (
      !Number.isSafeInteger(reviewed.provider_calls) ||
      reviewed.provider_calls < 0 ||
      reviewed.provider_calls > 2 ||
      (qualification.qualification_status === "QUALIFIED") !== qualification.aggregate_success ||
      (qualification.task_disposition === "PASS") !== qualification.aggregate_success
    ) {
      throw new InvalidEvaluationFault(
        "semantic_review",
        "SEMANTIC_REVIEW_INCOMPATIBLE",
        entry.trial_id
      );
    }
    providerCalls += reviewed.provider_calls;
    qualifications.push({
      ...qualification,
      trial_id: entry.trial_id,
      task_id: entry.task_id,
      repetition: entry.repetition,
      variant: entry.variant,
      variant_name: entry.variant_name,
      trial_invocation_receipt_id: reviewed.trial_review.receipt.receipt_id,
      oracle_invocation_receipt_id: reviewed.oracle_review.receipt.receipt_id,
      trial_packet_sha256: sha256(canonicalJson(reviewed.trial_review.packet)),
      oracle_packet_sha256: sha256(canonicalJson(reviewed.oracle_review.packet)),
      trial_review_journal_ref: reviewed.trial_review.journal_ref,
      oracle_review_journal_ref: reviewed.oracle_review.journal_ref,
    });
  }
  const allQualified =
    qualifications.length === input.frozen.schedule.length &&
    qualifications.every((qualification) => qualification.qualification_status === "QUALIFIED");
  return {
    status: allQualified ? "QUALIFIED" : "NOT_QUALIFIED",
    reason_code: allQualified ? "ALL_SCHEDULED_ARMS_QUALIFIED" : "SCHEDULED_ARM_NOT_QUALIFIED",
    provider_calls: providerCalls,
    trial_qualifications: qualifications,
  };
}

export async function executeFrozenPairedEvaluation(input: {
  readonly frozen: FrozenPairedEvaluationV1;
  readonly population: unknown;
  readonly plan: unknown;
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly baselineRegistration: PlaybookRegistrationV1;
  readonly candidateRegistry: PlaybookRegistryV1;
  readonly ablationRegistry?: PlaybookRegistryV1;
  readonly executor: EvaluationTrialExecutorV1;
  readonly readinessPreflight?: EvaluationReadinessPreflightV1;
  readonly semanticReviewCoordinator?: EvaluationSemanticReviewCoordinatorV1;
  readonly gradingDefinition?: EvaluationGradingDefinitionV1;
  readonly implementationBinding: unknown;
  readonly runtimeFunctions: readonly EvaluationRuntimeFunctionBindingV1[];
  readonly mutationMeasurement?: EvaluationMutationMeasurementV1;
  readonly trialJournal?: EvaluationTrialJournalV1;
  readonly maxConcurrency?: number;
  readonly forbiddenContaminationGroups?: readonly string[];
}): Promise<PairedEvaluationRunV1> {
  assertFrozenEvaluationInputs({
    frozen: input.frozen,
    population: input.population,
    plan: input.plan,
    ...(input.forbiddenContaminationGroups === undefined
      ? {}
      : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
  });
  const population = validateEvaluationPopulation(input.population, {
    ...(input.forbiddenContaminationGroups === undefined
      ? {}
      : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
  });
  const plan = validatePairedEvaluationPlan(input.plan);
  const gradingDefinition = input.gradingDefinition ?? DETERMINISTIC_GRADING_DEFINITION;
  try {
    assertEvaluationRegistrationBindings({
      frozen: input.frozen,
      population,
      plan,
      baselineRegistration: input.baselineRegistration,
      candidateRegistry: input.candidateRegistry,
      ablationRegistry: input.ablationRegistry ?? new Map(),
      gradingDefinition,
      implementationBinding: input.implementationBinding,
      runtimeFunctions: input.runtimeFunctions,
      projectRoot: input.projectRoot,
    });
    if (input.semanticReviewCoordinator !== undefined) {
      try {
        const authorizationBinding = await input.semanticReviewCoordinator.preflight({
          frozen: input.frozen,
          population,
          plan,
          gradingDefinition,
        });
        const expectedArms = [
          ...new Map(
            input.frozen.schedule.map((entry) => [
              entry.variant_name,
              { arm_id: entry.variant_name, binding_sha256: entry.binding_sha256 },
            ])
          ).values(),
        ].sort((left, right) => left.arm_id.localeCompare(right.arm_id));
        if (
          authorizationBinding.schedule_sha256 !== input.frozen.schedule_sha256 ||
          canonicalJson(authorizationBinding.arms) !== canonicalJson(expectedArms) ||
          canonicalJson(authorizationBinding.execution_binding) !==
            canonicalJson({
              provider: plan.runtime_binding.provider,
              model: plan.runtime_binding.model,
              runtime: plan.runtime_binding.runtime,
              thinking_level: plan.runtime_binding.thinking_level,
            })
        ) {
          throw new Error("semantic review authorization does not bind the exact schedule arms");
        }
      } catch (error) {
        if (error instanceof InvalidEvaluationFault) throw error;
        throw new InvalidEvaluationFault(
          "semantic_review",
          "SEMANTIC_REVIEW_AUTHORIZATION_FAILED",
          null,
          error
        );
      }
    }
    try {
      await input.executor.preflight?.({
        frozen: input.frozen,
        population,
        plan,
        gradingDefinition,
      });
    } catch (error) {
      if (error instanceof InvalidEvaluationFault) throw error;
      throw new InvalidEvaluationFault(
        "artifact_read_preflight",
        "LOCAL_LIVE_ARTIFACT_READ_PREFLIGHT_FAILED",
        null,
        error
      );
    }
    const readinessRequired = plan.comparison_validity_policy.readiness_preflight.required;
    if (readinessRequired && input.readinessPreflight === undefined) {
      throw new InvalidEvaluationFault("readiness_preflight", "READINESS_PREFLIGHT_REQUIRED", null);
    }
    if (!readinessRequired && input.readinessPreflight !== undefined) {
      throw new InvalidEvaluationFault(
        "registration_preflight",
        "EVALUATION_REGISTRATION_INCOMPATIBLE",
        null
      );
    }
    if (input.readinessPreflight !== undefined) {
      try {
        await input.readinessPreflight.preflight({
          frozen: input.frozen,
          population,
          plan,
          gradingDefinition,
        });
      } catch (error) {
        if (error instanceof InvalidEvaluationFault) throw error;
        throw new InvalidEvaluationFault(
          "readiness_preflight",
          "READINESS_PREFLIGHT_FAILED",
          null,
          error
        );
      }
    }
  } catch (error) {
    if (!(error instanceof InvalidEvaluationFault)) throw error;
    const semanticQualification = unavailableSemanticQualification("INVALID_EVALUATION");
    const result = attachSemanticQualification(
      invalidEvaluationResult({
        frozen: input.frozen,
        population,
        plan,
        observationByTrial: new Map(),
        fault: error,
      }),
      semanticQualification
    );
    const resultArtifactRef = persistEvaluationResult({
      projectRoot: input.projectRoot,
      env: input.env,
      result,
    });
    return {
      frozen: input.frozen,
      result,
      result_artifact_ref: resultArtifactRef,
      execution_accounting: emptyExecutionAccounting(input.frozen.schedule.length),
      semantic_qualification: semanticQualification,
    };
  }
  const taskById = new Map(population.tasks.map((task) => [task.task_id, task]));
  const maxConcurrency = input.maxConcurrency ?? 1;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) {
    throw new Error("paired evaluation maxConcurrency must be an integer from 1 through 4");
  }
  const scheduledObservations = new Array<EvaluationTrialObservationV1 | undefined>(
    input.frozen.schedule.length
  );
  const recordedEntries = new Array<boolean>(input.frozen.schedule.length).fill(false);
  let newlyStartedTrials = 0;
  let newlyRecordedTerminals = 0;
  let retainedJournalObservations = 0;
  let loopbackProviderCalls = 0;
  let nextIndex = 0;
  let executionFault: InvalidEvaluationFault | undefined;
  const worker = async (): Promise<void> => {
    while (nextIndex < input.frozen.schedule.length && executionFault === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = input.frozen.schedule[index];
      if (entry === undefined) throw new Error(`frozen schedule entry ${index} is unavailable`);
      const task = taskById.get(entry.task_id);
      if (task === undefined) throw new Error(`frozen task '${entry.task_id}' is unavailable`);
      const retained = input.trialJournal?.load(entry);
      if (retained?.recorded === true) {
        retainedJournalObservations += 1;
        recordedEntries[index] = true;
        scheduledObservations[index] = retained.observation;
        continue;
      }
      let observation: EvaluationTrialObservationV1 | undefined;
      try {
        observation = await input.executor.execute({
          entry,
          task,
          plan,
          frozen: input.frozen,
        });
      } catch (error) {
        if (error instanceof InvalidEvaluationFault) {
          executionFault ??= error;
          return;
        }
        throw error;
      }
      if (observation?.started_new_trial ?? true) newlyStartedTrials += 1;
      loopbackProviderCalls += observation?.loopback_provider_calls ?? 0;
      const recorded = input.trialJournal?.record(entry, observation);
      if (recorded?.recorded === true) {
        newlyRecordedTerminals += 1;
        recordedEntries[index] = true;
      } else if (input.trialJournal === undefined && observation !== undefined) {
        recordedEntries[index] = true;
      }
      scheduledObservations[index] =
        recorded?.recorded === true ? recorded.observation : observation;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, input.frozen.schedule.length) }, () => worker())
  );
  if (executionFault !== undefined) {
    const observationByTrial = new Map(
      scheduledObservations.flatMap((observation) =>
        observation === undefined ? [] : [[observation.trial_id, observation] as const]
      )
    );
    const semanticQualification = unavailableSemanticQualification("INVALID_EVALUATION");
    const result = attachSemanticQualification(
      invalidEvaluationResult({
        frozen: input.frozen,
        population,
        plan,
        observationByTrial,
        fault: executionFault,
      }),
      semanticQualification
    );
    const resultArtifactRef = persistEvaluationResult({
      projectRoot: input.projectRoot,
      env: input.env,
      result,
    });
    return {
      frozen: input.frozen,
      result,
      result_artifact_ref: resultArtifactRef,
      execution_accounting: {
        newly_started_trials: newlyStartedTrials,
        newly_recorded_terminals: newlyRecordedTerminals,
        retained_journal_observations: retainedJournalObservations,
        outstanding_schedule_entries: recordedEntries.filter((recorded) => !recorded).length,
        loopback_provider_calls: loopbackProviderCalls,
      },
      semantic_qualification: semanticQualification,
    };
  }
  const observations = scheduledObservations.flatMap((observation) =>
    observation === undefined ? [] : [observation]
  );
  let result = evaluateTrialObservations({
    frozen: input.frozen,
    population,
    plan,
    observations,
    gradingDefinition,
    ...(input.mutationMeasurement === undefined
      ? {}
      : { mutationMeasurement: input.mutationMeasurement }),
    ...(input.forbiddenContaminationGroups === undefined
      ? {}
      : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
  });
  let semanticQualification: EvaluationSemanticQualificationV1;
  try {
    semanticQualification = await collectSemanticQualifications({
      coordinator: input.semanticReviewCoordinator,
      frozen: input.frozen,
      population,
      result,
      observations: scheduledObservations,
      gradingDefinition,
    });
  } catch (error) {
    if (!(error instanceof InvalidEvaluationFault)) throw error;
    result = invalidEvaluationResult({
      frozen: input.frozen,
      population,
      plan,
      observationByTrial: new Map(
        observations.map((observation) => [observation.trial_id, observation] as const)
      ),
      fault: error,
    });
    semanticQualification = unavailableSemanticQualification("INVALID_EVALUATION");
  }
  if (result.disposition !== "INVALID_EVALUATION") {
    const expectedDisposition =
      result.disposition_reason === "CANDIDATE_ZERO_NORMALIZED_COMPLETIONS"
        ? "RETIRED"
        : result.policy_outcomes.all_passed
          ? plan.deterministic_disposition_rule.on_pass
          : plan.deterministic_disposition_rule.on_fail;
    if (result.disposition !== expectedDisposition) {
      throw new Error("paired evaluation disposition is not the frozen deterministic rule");
    }
  }
  result = attachSemanticQualification(result, semanticQualification);
  const resultArtifactRef = persistEvaluationResult({
    projectRoot: input.projectRoot,
    env: input.env,
    result,
  });
  return {
    frozen: input.frozen,
    result,
    result_artifact_ref: resultArtifactRef,
    execution_accounting: {
      newly_started_trials: newlyStartedTrials,
      newly_recorded_terminals: newlyRecordedTerminals,
      retained_journal_observations: retainedJournalObservations,
      outstanding_schedule_entries: recordedEntries.filter((recorded) => !recorded).length,
      loopback_provider_calls: loopbackProviderCalls,
    },
    semantic_qualification: semanticQualification,
  };
}

export async function runPairedEvaluation(input: {
  readonly population: unknown;
  readonly plan: unknown;
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly baselineRegistration: PlaybookRegistrationV1;
  readonly candidateRegistry: PlaybookRegistryV1;
  readonly ablationRegistry?: PlaybookRegistryV1;
  readonly executor: EvaluationTrialExecutorV1;
  readonly readinessPreflight?: EvaluationReadinessPreflightV1;
  readonly semanticReviewCoordinator?: EvaluationSemanticReviewCoordinatorV1;
  readonly gradingDefinition?: EvaluationGradingDefinitionV1;
  readonly implementationBinding: unknown;
  readonly runtimeFunctions: readonly EvaluationRuntimeFunctionBindingV1[];
  readonly mutationMeasurement?: EvaluationMutationMeasurementV1;
  readonly trialJournal?: EvaluationTrialJournalV1;
  readonly maxConcurrency?: number;
  readonly forbiddenContaminationGroups?: readonly string[];
}): Promise<PairedEvaluationRunV1> {
  let frozen: FrozenPairedEvaluationV1;
  try {
    frozen = freezePairedEvaluation({
      population: input.population,
      plan: input.plan,
      projectRoot: input.projectRoot,
      baselineRegistration: input.baselineRegistration,
      candidateRegistry: input.candidateRegistry,
      ...(input.ablationRegistry === undefined ? {} : { ablationRegistry: input.ablationRegistry }),
      ...(input.gradingDefinition === undefined
        ? {}
        : { gradingDefinition: input.gradingDefinition }),
      implementationBinding: input.implementationBinding,
      runtimeFunctions: input.runtimeFunctions,
      ...(input.forbiddenContaminationGroups === undefined
        ? {}
        : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
    });
  } catch (error) {
    if (!(error instanceof InvalidEvaluationFault)) throw error;
    const population = validateEvaluationPopulation(input.population, {
      ...(input.forbiddenContaminationGroups === undefined
        ? {}
        : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
    });
    const plan = validatePairedEvaluationPlan(input.plan);
    frozen = freezePairedEvaluationContracts({
      population,
      plan,
      ...(input.forbiddenContaminationGroups === undefined
        ? {}
        : { forbiddenContaminationGroups: input.forbiddenContaminationGroups }),
    });
    const semanticQualification = unavailableSemanticQualification("INVALID_EVALUATION");
    const result = attachSemanticQualification(
      invalidEvaluationResult({
        frozen,
        population,
        plan,
        observationByTrial: new Map(),
        fault: error,
      }),
      semanticQualification
    );
    const resultArtifactRef = persistEvaluationResult({
      projectRoot: input.projectRoot,
      env: input.env,
      result,
    });
    return {
      frozen,
      result,
      result_artifact_ref: resultArtifactRef,
      execution_accounting: emptyExecutionAccounting(frozen.schedule.length),
      semantic_qualification: semanticQualification,
    };
  }
  return executeFrozenPairedEvaluation({ ...input, frozen });
}

const SYNTHETIC_EXPECTED_BY_TASK: ReadonlyMap<string, string> = new Map([
  ["synthetic-task-alpha", "alpha"],
  ["synthetic-task-beta", "beta"],
  ["synthetic-task-gamma-protected", "gamma"],
  ["synthetic-task-delta-negative-trigger", "delta"],
]);

function parseSyntheticTask(invocation: AgentInvocation): EvaluationTaskDispatchV1 {
  let value: unknown;
  try {
    value = JSON.parse(invocation.task);
  } catch {
    throw new Error("synthetic evaluation task is not JSON");
  }
  const TaskSchema = Type.Object(
    {
      schema_version: Type.Literal(1),
      task_id: Type.String({ minLength: 1 }),
      goal: Type.String({ minLength: 1 }),
      constraints: Type.Record(Type.String(), JsonValueSchema),
    },
    { additionalProperties: false }
  );
  return validateContract(TaskSchema, value, "synthetic evaluation task");
}

export class SyntheticKnownDeltaModelClient implements MeasuredEvaluationModelClientV1 {
  readonly runtime_binding: EvaluationRuntimeBindingV1;
  private readonly measurements = new Map<string, EvaluationRuntimeMeasurementV1>();

  constructor(
    runtimeBinding: EvaluationRuntimeBindingV1,
    private readonly entry: PairedEvaluationScheduleEntryV1,
    private readonly options: { readonly reverseDelta?: boolean } = {}
  ) {
    this.runtime_binding = runtimeBinding;
  }

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const candidate =
      invocation.registration.workflow_name === SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME;
    const taskId = candidate ? this.entry.task_id : parseSyntheticTask(invocation).task_id;
    const expected = SYNTHETIC_EXPECTED_BY_TASK.get(taskId);
    if (expected === undefined) throw new Error(`synthetic task '${taskId}' is unknown`);
    const advantaged = this.options.reverseDelta === true ? !candidate : candidate;
    const deltaTask = taskId === "synthetic-task-alpha" || taskId === "synthetic-task-beta";
    const answer = deltaTask && !advantaged ? `wrong-${expected}` : expected;
    const runId = invocation.workflowSession?.run_id;
    if (runId === undefined) throw new Error("synthetic evaluation invocation has no run binding");
    this.measurements.set(runId, {
      cost_microusd: candidate ? 110 : 100,
      latency_ms: candidate ? 11 : 10,
    });
    const output = canonicalJson({
      schema_version: 1,
      task_id: taskId,
      answer,
      trigger_predicted: taskId !== "synthetic-task-delta-negative-trigger",
    });
    return {
      text: `${output}\nSUMMARY:{"confidence":"CERTAIN","complete":true}`,
    };
  }

  measurement(runId: string): EvaluationRuntimeMeasurementV1 {
    return this.measurements.get(runId) ?? { cost_microusd: 0, latency_ms: 0 };
  }
}

export function syntheticKnownDeltaModelClientFactory(
  input: {
    readonly reverseDelta?: boolean;
  } = {}
): EvaluationModelClientFactoryV1 {
  return ({ plan, entry }) =>
    new SyntheticKnownDeltaModelClient(plan.runtime_binding, entry, {
      ...(input.reverseDelta === undefined ? {} : { reverseDelta: input.reverseDelta }),
    });
}

export function syntheticEvaluationRuntimeFunctions(): readonly EvaluationRuntimeFunctionBindingV1[] {
  const modelClientFactory = syntheticKnownDeltaModelClientFactory();
  return [
    {
      role: "artifact_preflight",
      owner: "offline-synthetic",
      implementation: GenericEvaluationTrialExecutor.prototype.preflight,
    },
    {
      role: "model_client_factory",
      owner: "offline-synthetic",
      implementation: modelClientFactory,
    },
    {
      role: "model_preflight",
      owner: "offline-synthetic",
      implementation: GenericEvaluationTrialExecutor.prototype.preflight,
    },
    {
      role: "trial_executor_execute",
      owner: "offline-synthetic",
      implementation: GenericEvaluationTrialExecutor.prototype.execute,
    },
    {
      role: "trial_executor_preflight",
      owner: "offline-synthetic",
      implementation: GenericEvaluationTrialExecutor.prototype.preflight,
    },
  ];
}

export function syntheticEvaluationImplementationBinding(input: {
  readonly projectRoot: string;
  readonly population: unknown;
  readonly plan: unknown;
  readonly gradingDefinition?: EvaluationGradingDefinitionV1;
  readonly runtimeFunctions?: readonly EvaluationRuntimeFunctionBindingV1[];
}): EvaluationImplementationBindingV1 {
  const registrationSource = ".pi/extensions/skill/evaluation-runner.ts";
  const guidance = "evals/guidance/direct/demetri-evaluating.md";
  const agentDefinition = ".pi/agents/demetri.md";
  const compositionSource = "apps/orchestration/src/composition.ts";
  const gradingDefinition = input.gradingDefinition ?? DETERMINISTIC_GRADING_DEFINITION;
  const files: EvaluationImplementationFileInputV1[] = [
    {
      role: "registration_guidance",
      owner: DIRECT_DEMETRI_BASELINE_NAME,
      path: guidance,
    },
    {
      role: "agent_definition",
      owner: DIRECT_DEMETRI_BASELINE_NAME,
      path: agentDefinition,
    },
    {
      role: "registration_source",
      owner: DIRECT_DEMETRI_BASELINE_NAME,
      path: registrationSource,
    },
    {
      role: "registration_guidance",
      owner: SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      path: guidance,
    },
    {
      role: "agent_definition",
      owner: SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      path: agentDefinition,
    },
    {
      role: "registration_source",
      owner: SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      path: registrationSource,
    },
    {
      role: "contract_source",
      owner: SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      path: registrationSource,
    },
    {
      role: "playbook_source",
      owner: SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      path: registrationSource,
    },
    {
      role: "validator_source",
      owner: SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      path: ".pi/extensions/skill/evaluation-contracts.ts",
    },
    {
      role: "composition_source",
      owner: SYNTHETIC_KNOWN_DELTA_CANDIDATE_NAME,
      path: compositionSource,
    },
    ...gradingDefinition.descriptor.semantic_normalizers.map((normalizer) => ({
      role: "normalizer_source" as const,
      owner: normalizer.registration_name,
      path: registrationSource,
    })),
    ...gradingDefinition.descriptor.graders.map((grader) => ({
      role: "grader_source" as const,
      owner: grader.grader_case_id,
      path: registrationSource,
    })),
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-contracts.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: registrationSource,
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-semantic-projections.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-semantic-review.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-cli.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/service.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/engine.ts",
    },
    {
      role: "evaluator_source",
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/artifact-store.ts",
    },
    {
      role: "worker_source",
      owner: "evaluation-runtime",
      path: "apps/orchestration/src/worker.ts",
    },
    {
      role: "artifact_preflight_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/skill/evaluation-local-live.ts",
    },
    {
      role: "artifact_preflight_source",
      owner: "evaluation-runtime",
      path: ".pi/extensions/artifacts/artifact-runtime.ts",
    },
  ];
  return createEvaluationImplementationBinding({
    projectRoot: input.projectRoot,
    population: input.population,
    plan: input.plan,
    baselineRegistration: DIRECT_DEMETRI_BASELINE_REGISTRATION,
    candidateRegistry: SYNTHETIC_EVALUATION_CANDIDATE_REGISTRY,
    gradingDefinition,
    files,
    runtimeFunctions: input.runtimeFunctions ?? syntheticEvaluationRuntimeFunctions(),
  });
}

export function knownDeltaCandidateContractSha256(): string {
  return skillContractSha256(SYNTHETIC_KNOWN_DELTA_CANDIDATE_REGISTRATION.contract);
}
