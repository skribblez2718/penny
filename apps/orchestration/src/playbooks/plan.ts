import { Type } from "typebox";

import type {
  ArtifactHostStore,
  ArtifactReader,
  ArtifactRevisionLookup,
} from "../artifact-store.js";
import { canonicalJson, sha256 } from "../checkpointer.js";
import {
  validateDirective,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type EvaluationResultV2,
  type JsonValue,
  type LivenessPolicyV1,
  type LivenessSnapshotV1,
  type LivenessTerminalReason,
  type OutputArtifactMetadata,
  type PhaseResult,
  type SkillContract,
} from "../contracts.js";
import { RunContext } from "../context.js";
import {
  assertStrategyLineage,
  canonicalizePlanRequest,
  strategyDraftPromptContract,
  strategyProductEnvelopeId,
  strategyProductIntegrityId,
  planRequestConstraints,
  planRequestSha256,
  parseStrategyDraft,
  sealStrategy,
  validateCanonicalStrategyBytes,
  validateStrategyProductEnvelope,
  validateStrategyProductIntegrity,
  validatePlanRequest,
  validateStrategySealFeedback,
  StrategyDraftValidationError,
  type StrategyDraftV1,
  type StrategyProductEnvelopeV1,
  type StrategyProductIntegrityV1,
  type PlanRequestV1,
  type StrategySealFeedbackV1,
} from "../skill-contracts/plan.js";
import {
  evidenceAdmissionId,
  validateEvidenceAdmission,
  type EvidenceAdmissionV1,
} from "../skill-contracts/evidence-admission.js";
import {
  reviewReceiptId,
  reviewSubjectUpstreamRefs,
  reviewSubjectUpstreamSha256,
  validateReviewReceipt,
  validateReviewReceiptBinding,
  type ReviewReceiptV1,
  type ReviewSubjectV1,
} from "../skill-contracts/review.js";
import { buildOutputArtifactMetadata } from "./artifact-metadata.js";
import {
  hostContinuation,
  type CompletionReceiptPredicateV1,
  type HostContinuationCapabilityV1,
  type HostContinuationStepV1,
  type LivenessTerminalCapabilityV1,
  type PlaybookCoreV1,
  type PlaybookStepOutcomeV1,
  type RepairExhaustionCapabilityV1,
  type RoutingRepairCapabilityV1,
  type StateAwareRepairCapabilityV1,
} from "./playbook.js";
import type {
  PlaybookRegistrationV1,
  PlaybookRegistryV1,
  PreparedStartV1,
  StartAdmissionV1,
} from "./registry.js";

export const PLAN_PLAYBOOK_NAME = "plan";
export const PLAN_UNSEALED_EVALUATION_NAME = "plan-unsealed";
export const PLAN_LIFECYCLE_STATUS = "PREPARED_NOT_MEASURED" as const;

export const PLAN_AGENT_BY_STATE = {
  orienting_strategy: "piper",
  gathering_strategy_evidence: "echo",
  strategizing: "piper",
  verifying_strategy: "vera",
  critiquing_strategy: "carren",
} as const;

type PlanWorkerState = keyof typeof PLAN_AGENT_BY_STATE;
type ReviewState = "verifying_strategy" | "critiquing_strategy";
type ReviewKind = "validity" | "quality";
type RepairGapKind = "evidence_gap" | "analysis_gap" | "product_gap";
type RepairOwner = "echo" | "piper";

function isPlanWorkerState(value: string): value is PlanWorkerState {
  return Object.hasOwn(PLAN_AGENT_BY_STATE, value);
}

export const PLAN_FLOW = {
  states: [
    "intake",
    "orienting_strategy",
    "strategy_evidence_gate",
    "gathering_strategy_evidence",
    "strategizing",
    "sealing_strategy",
    "verifying_strategy",
    "critiquing_strategy",
    "admitting_strategy",
    "complete",
    "incomplete",
    "cancelled",
  ],
  edges: [
    ["intake", "orienting_strategy"],
    ["orienting_strategy", "strategy_evidence_gate"],
    ["strategy_evidence_gate", "gathering_strategy_evidence"],
    ["strategy_evidence_gate", "strategizing"],
    ["gathering_strategy_evidence", "strategizing"],
    ["strategizing", "sealing_strategy"],
    ["sealing_strategy", "strategizing"],
    ["sealing_strategy", "verifying_strategy"],
    ["verifying_strategy", "orienting_strategy"],
    ["verifying_strategy", "strategizing"],
    ["verifying_strategy", "critiquing_strategy"],
    ["critiquing_strategy", "orienting_strategy"],
    ["critiquing_strategy", "strategizing"],
    ["critiquing_strategy", "admitting_strategy"],
    ["admitting_strategy", "complete"],
  ],
} as const;

export const PLAN_LIVENESS_POLICY = {
  schema_version: 1,
  scope: "orchestrated-plan-candidate",
  preset: "bounded-external-orchestrated-v1",
  total_phase_repair_invocations: 24,
  model_turns_per_worker: 12,
  model_turns_per_run: 96,
  tool_calls_per_worker: 24,
  tool_calls_per_run: 160,
  external_calls_per_worker: 8,
  external_calls_per_run: 64,
  worker_wall_clock_ms: 180_000,
  run_wall_clock_ms: 900_000,
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

const FindingSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const StrategyDeltaSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const FindingsSchema = Type.Array(FindingSchema, { maxItems: 32 });
const EvidenceChecksSchema = Type.Array(FindingSchema, { minItems: 1, maxItems: 64 });
const CritiqueFindingSchema = Type.Object(
  {
    severity: Type.Union([Type.Literal("minor"), Type.Literal("major"), Type.Literal("critical")]),
    message: FindingSchema,
  },
  { additionalProperties: false }
);
const MinorCritiqueFindingSchema = Type.Object(
  { severity: Type.Literal("minor"), message: FindingSchema },
  { additionalProperties: false }
);

const OrientationSummarySchema = Type.Union([
  Type.Object(
    {
      orientation_complete: Type.Literal(true),
      gap_kind: Type.Literal("none"),
      repair_owner: Type.Literal("none"),
      findings: FindingsSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      orientation_complete: Type.Literal(false),
      gap_kind: Type.Literal("evidence_gap"),
      repair_owner: Type.Literal("echo"),
      findings: Type.Array(FindingSchema, { minItems: 1, maxItems: 32 }),
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  ),
]);
const EvidenceSummarySchema = Type.Union([
  Type.Object(
    {
      evidence_complete: Type.Literal(true),
      findings: FindingsSchema,
      unresolved: Type.Array(FindingSchema, { maxItems: 32 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      evidence_complete: Type.Literal(false),
      findings: FindingsSchema,
      unresolved: Type.Array(FindingSchema, { minItems: 1, maxItems: 32 }),
    },
    { additionalProperties: false }
  ),
]);
const StrategySummarySchema = Type.Object(
  { complete: Type.Literal(true) },
  { additionalProperties: false }
);

function verificationFailureSchema(gapKind: RepairGapKind, repairOwner: RepairOwner) {
  return Type.Object(
    {
      verdict: Type.Literal("FAIL"),
      gap_kind: Type.Literal(gapKind),
      repair_owner: Type.Literal(repairOwner),
      findings: Type.Array(FindingSchema, { minItems: 1, maxItems: 32 }),
      evidence: EvidenceChecksSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  );
}

const VerificationSummarySchema = Type.Union([
  Type.Object(
    {
      verdict: Type.Literal("PASS"),
      gap_kind: Type.Literal("none"),
      repair_owner: Type.Literal("none"),
      findings: FindingsSchema,
      evidence: EvidenceChecksSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  ),
  verificationFailureSchema("evidence_gap", "echo"),
  verificationFailureSchema("analysis_gap", "piper"),
  verificationFailureSchema("product_gap", "piper"),
]);

function critiqueRevisionSchema(gapKind: RepairGapKind, repairOwner: RepairOwner) {
  return Type.Object(
    {
      verdict: Type.Literal("NEEDS_REVISION"),
      gap_kind: Type.Literal(gapKind),
      repair_owner: Type.Literal(repairOwner),
      findings: Type.Array(CritiqueFindingSchema, { minItems: 1, maxItems: 32 }),
      evidence: EvidenceChecksSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  );
}

const CritiqueSummarySchema = Type.Union([
  Type.Object(
    {
      verdict: Type.Literal("APPROVE"),
      gap_kind: Type.Literal("none"),
      repair_owner: Type.Literal("none"),
      findings: Type.Array(MinorCritiqueFindingSchema, { maxItems: 32 }),
      evidence: EvidenceChecksSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  ),
  critiqueRevisionSchema("evidence_gap", "echo"),
  critiqueRevisionSchema("analysis_gap", "piper"),
  critiqueRevisionSchema("product_gap", "piper"),
]);

function repairRoute(
  originState: "orienting_strategy" | ReviewState,
  feedbackKind: RepairGapKind,
  targetState: "strategy_evidence_gate" | "orienting_strategy" | "strategizing"
) {
  return {
    schema_version: 1 as const,
    origin_state: originState,
    feedback_kind: feedbackKind,
    repair: { action: "transition" as const, target_state: targetState },
    budget: {
      counter: "iteration" as const,
      limit_source: "run.max_iterations" as const,
      reserved_attempts: 0 as const,
    },
    on_exhaustion: {
      action: "transition" as const,
      target_state: "incomplete",
      reset_counter: false,
    },
  };
}

function strategyContract(input: {
  readonly name: string;
  readonly sealed: boolean;
  readonly releaseStatus: "production" | "candidate";
}): SkillContract {
  return {
    schema_version: 2,
    name: input.name,
    release_status: input.releaseStatus,
    objective:
      "Produce one evidence-grounded strategy assessment through separate orientation, strategy authorship, host sealing, objective verification, and quality critique without taskification or execution.",
    io: {
      request: {
        schema_version: 1,
        name: "plan_request",
        direction: "input",
        transport: "inline_request",
        schema_id: "penny.plan-request.v1",
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
        {
          schema_version: 1,
          name: "prior_decision",
          direction: "input",
          transport: "artifact",
          schema_id: "penny.decision.v2",
          schema_version_required: 2,
          artifact_kind: "semantic-core",
          source: "either",
          min_items: 0,
          max_items: 1,
          semantic_product: true,
        },
      ],
      active_output_ports: [
        input.sealed
          ? {
              schema_version: 1,
              name: "strategy",
              direction: "output",
              transport: "artifact",
              schema_id: "penny.strategy.v1",
              schema_version_required: 1,
              artifact_kind: "strategy",
              source: "skill",
              min_items: 1,
              max_items: 1,
              semantic_product: true,
            }
          : {
              schema_version: 1,
              name: "strategy_draft",
              direction: "output",
              transport: "artifact",
              schema_id: "penny.strategy-draft.v1",
              schema_version_required: 1,
              artifact_kind: "strategy-draft",
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
      approval: { policy: "caller_skill_request", additional_approval_required: false },
      stopping: {
        budget_exhaustion: "incomplete",
        cancellation: "cancelled",
        blocking_ambiguity: "incomplete",
      },
      escalation: { out_of_scope_effect: "non_positive", sandbox_prevention_claim: false },
      violation_terminal: "incomplete",
    },
    guidance: {
      skill_root: ".pi/skills/plan/assets/prompts",
      resolution: "per_agent_phase",
    },
    budget_policy: {
      schema_version: 1,
      policy_id: "penny.plan-budget.v1",
      resolver_id: "planLivenessPolicy",
      admission_id: "LivenessController.admitInvocation",
      snapshot_id: "LivenessController.snapshot",
    },
    repair_routing: {
      schema_version: 1,
      routes: input.sealed
        ? [
            repairRoute("orienting_strategy", "evidence_gap", "strategy_evidence_gate"),
            repairRoute("verifying_strategy", "evidence_gap", "orienting_strategy"),
            repairRoute("verifying_strategy", "analysis_gap", "orienting_strategy"),
            repairRoute("verifying_strategy", "product_gap", "strategizing"),
            repairRoute("critiquing_strategy", "evidence_gap", "orienting_strategy"),
            repairRoute("critiquing_strategy", "analysis_gap", "orienting_strategy"),
            repairRoute("critiquing_strategy", "product_gap", "strategizing"),
          ]
        : [],
    },
    completion_gate: input.sealed
      ? {
          schema_version: 2,
          allowed_terminal_origins: ["admitting_strategy"],
          required_visited_states: [
            "orienting_strategy",
            "strategy_evidence_gate",
            "strategizing",
            "sealing_strategy",
            "verifying_strategy",
            "critiquing_strategy",
            "admitting_strategy",
          ],
          required_receipt_predicates: ["plan_latest_reviewed_strategy_dod.v2"],
          latest_product: {
            selector: "terminal_artifact",
            schema_id: "penny.strategy.v1",
            product_schema_version: 1,
            artifact_kind: "strategy",
            producing_state: "sealing_strategy",
          },
          unresolved_policy: { mode: "max_count", max_count: 0 },
        }
      : {
          schema_version: 2,
          allowed_terminal_origins: ["sealing_strategy"],
          required_visited_states: ["strategizing", "sealing_strategy"],
          required_receipt_predicates: [],
          latest_product: {
            selector: "terminal_artifact",
            schema_id: "penny.strategy-draft.v1",
            product_schema_version: 1,
            artifact_kind: "strategy-draft",
            producing_state: "strategizing",
          },
          unresolved_policy: { mode: "max_count", max_count: 0 },
        },
  };
}

export const PLAN_SKILL_CONTRACT = strategyContract({
  name: PLAN_PLAYBOOK_NAME,
  sealed: true,
  releaseStatus: "candidate",
});
export const PLAN_PROSPECTIVE_PRODUCTION_CONTRACT = strategyContract({
  name: PLAN_PLAYBOOK_NAME,
  sealed: true,
  releaseStatus: "production",
});
export const PLAN_UNSEALED_EVALUATION_CONTRACT = strategyContract({
  name: PLAN_UNSEALED_EVALUATION_NAME,
  sealed: false,
  releaseStatus: "candidate",
});

function selectedLatest(
  context: RunContext,
  predicate: (artifact: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts]
    .filter(predicate)
    .sort(
      (left, right) =>
        right.version - left.version || right.artifact_id.localeCompare(left.artifact_id)
    )[0];
}

function addSelectedArtifact(context: RunContext, artifact: ArtifactRef): boolean {
  const selected = context.selectedArtifacts.find(
    (candidate) => candidate.artifact_id === artifact.artifact_id
  );
  if (selected !== undefined) {
    if (canonicalJson(selected) !== canonicalJson(artifact)) {
      throw new Error("selected strategy artifact metadata diverged");
    }
    return false;
  }
  context.selectedArtifacts.push(structuredClone(artifact));
  return true;
}

function exactPlanInputRefs(context: RunContext): readonly ArtifactRef[] {
  return context.selectedArtifacts
    .filter(
      (artifact) =>
        (artifact.kind === "semantic-core" &&
          artifact.content_schema?.schema_id === "penny.grounded-synthesis.v1" &&
          artifact.content_schema.schema_version === 1) ||
        (artifact.kind === "semantic-core" &&
          artifact.content_schema?.schema_id === "penny.decision.v2" &&
          artifact.content_schema.schema_version === 2)
    )
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function admittedPlanRequestArtifact(context: RunContext): ArtifactRef {
  const request = selectedLatest(
    context,
    (artifact) => artifact.kind === "plan-request" && artifact.phase === "intake"
  );
  if (request === undefined) throw new Error("admitted PlanRequestV1 artifact is absent");
  return request;
}

function latestOrientationArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "agent-output" && artifact.phase === "orienting_strategy"
  );
}

function latestEvidenceAdmissionArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "evidence-admission" && artifact.phase === "strategy_evidence_gate"
  );
}

function latestEvidenceArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "agent-output" && artifact.phase === "gathering_strategy_evidence"
  );
}

function latestStrategyDraftArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "strategy-draft" && artifact.phase === "strategizing"
  );
}

function latestStrategyArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "strategy" &&
      artifact.phase === "sealing_strategy" &&
      artifact.content_schema?.schema_id === "penny.strategy.v1" &&
      artifact.content_schema.schema_version === 1
  );
}

function latestReviewReportArtifact(
  context: RunContext,
  state: ReviewState
): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "agent-output" && artifact.phase === state
  );
}

function latestReviewReceiptArtifact(
  context: RunContext,
  kind: ReviewKind
): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "review-receipt" && artifact.branch_id === kind
  );
}

function selectedStrategySealFeedbackArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "strategy-seal-feedback" &&
      artifact.phase === "sealing_strategy" &&
      artifact.content_schema?.schema_id === "penny.strategy-seal-feedback.v1"
  );
}

function latestIntegrityArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "strategy-product-integrity");
}

function latestEnvelopeArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "strategy-product-envelope");
}

function uniqueRefs(refs: readonly (ArtifactRef | undefined)[]): ArtifactRef[] {
  return [
    ...new Map(
      refs.flatMap((ref) => (ref === undefined ? [] : [[ref.artifact_id, ref] as const]))
    ).values(),
  ];
}

function canonicalPlanRequest(store: ArtifactHostStore, context: RunContext): PlanRequestV1 {
  const requestArtifact = admittedPlanRequestArtifact(context);
  const bytes = store.readById(requestArtifact.artifact_id).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("admitted PlanRequestV1 artifact is not JSON");
  }
  const request = validatePlanRequest(parsed);
  if (canonicalJson(request) !== bytes) {
    throw new Error("admitted PlanRequestV1 artifact is not canonical JSON");
  }
  return request;
}

function persistPlanRequestArtifact(input: {
  readonly request: PlanRequestV1;
  readonly runId: string;
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly store?: ArtifactHostStore;
}): ArtifactRef | undefined {
  if (input.store === undefined) return undefined;
  const operationId = `plan-request:${sha256(input.runId).slice(0, 32)}`;
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: "intake",
    branch_id: null,
    kind: "plan-request",
    operation_id: operationId,
    version: 1,
    producer: "host:request-admission",
    media_type: "application/json",
    content_schema: { schema_id: "penny.plan-request.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [...input.upstreamRefs].sort((left, right) =>
      left.artifact_id.localeCompare(right.artifact_id)
    ),
  };
  const content = canonicalJson(validatePlanRequest(input.request));
  const existing = input.store.refFor(input.runId, "intake", null, "plan-request", operationId, 1);
  const ref = existing ?? input.store.persist({ metadata, content });
  if (
    input.store.lastVersion(input.runId, "intake", null, "plan-request", operationId) !== 1 ||
    canonicalJson(input.store.metadata(ref)) !== canonicalJson(metadata) ||
    input.store.readById(ref.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("durable PlanRequestV1 artifact diverged");
  }
  const reread = input.store.refById(ref.artifact_id);
  if (reread === undefined || canonicalJson(reread) !== canonicalJson(ref)) {
    throw new Error("durable PlanRequestV1 artifact failed manifest re-read");
  }
  input.store.select(reread);
  return reread;
}

export const PLAN_START_ADMISSION: StartAdmissionV1 = {
  schema_id: "penny.plan-request.v1",
  schema_version: 1,
  prepare: (request): PreparedStartV1 => {
    const exactInputArtifactIds =
      request.input_artifacts?.artifacts.map((binding) => binding.ref.artifact_id) ?? [];
    const planRequest = canonicalizePlanRequest({
      goal: request.goal,
      constraints: request.constraints,
      exactInputArtifactIds,
    });
    return {
      schema_id: "penny.plan-request.v1",
      schema_version: 1,
      request,
      goal: planRequest.goal,
      constraints: planRequestConstraints(planRequest),
      ...(request.input_artifacts === undefined
        ? {}
        : { input_artifacts: request.input_artifacts }),
      admission_data: planRequest,
    };
  },
  materialize: (prepared, host) => {
    const request = validatePlanRequest(prepared.admission_data);
    const upstreamRefs = prepared.input_artifacts?.artifacts.map((binding) => binding.ref) ?? [];
    const requestRef = persistPlanRequestArtifact({
      request,
      runId: host.run_id,
      upstreamRefs,
      ...(host.artifactStore === undefined ? {} : { store: host.artifactStore }),
    });
    return requestRef === undefined ? [] : [requestRef];
  },
};

function outputMetadata(
  context: RunContext,
  state: PlanWorkerState,
  upstreamRefs: readonly ArtifactRef[],
  revisions?: ArtifactRevisionLookup
): OutputArtifactMetadata {
  const draft = state === "strategizing";
  return buildOutputArtifactMetadata({
    context,
    phase: state,
    agent: PLAN_AGENT_BY_STATE[state],
    branchId: null,
    upstreamRefs,
    ...(revisions === undefined ? {} : { revisions }),
    ...(draft
      ? {
          artifactKind: "strategy-draft",
          mediaType: "text/plain; charset=utf-8",
          contentSchema: { schema_id: "penny.strategy-draft.v1", schema_version: 1 },
        }
      : {}),
  });
}

function refsForState(context: RunContext, state: PlanWorkerState): readonly ArtifactRef[] {
  const request = admittedPlanRequestArtifact(context);
  const inputs = exactPlanInputRefs(context);
  const orientation = latestOrientationArtifact(context);
  const admission = latestEvidenceAdmissionArtifact(context);
  const evidence = latestEvidenceArtifact(context);
  const draft = latestStrategyDraftArtifact(context);
  const product = latestStrategyArtifact(context);
  const veraReport = latestReviewReportArtifact(context, "verifying_strategy");
  const carrenReport = latestReviewReportArtifact(context, "critiquing_strategy");
  const validityReceipt = latestReviewReceiptArtifact(context, "validity");
  if (state === "orienting_strategy") {
    return uniqueRefs([request, ...inputs, evidence, orientation, veraReport, carrenReport]);
  }
  if (state === "gathering_strategy_evidence") {
    if (orientation === undefined) throw new Error("Echo requires the exact Piper orientation");
    return uniqueRefs([request, ...inputs, orientation, admission, veraReport, carrenReport]);
  }
  if (state === "strategizing") {
    if (orientation === undefined && context.identity.playbook !== PLAN_UNSEALED_EVALUATION_NAME) {
      throw new Error("Piper strategy authorship requires the exact Piper orientation");
    }
    return uniqueRefs([
      request,
      orientation,
      admission,
      evidence,
      ...inputs,
      draft,
      selectedStrategySealFeedbackArtifact(context),
      veraReport,
      carrenReport,
    ]);
  }
  if (
    orientation === undefined ||
    admission === undefined ||
    draft === undefined ||
    product === undefined
  ) {
    throw new Error(
      `${state} requires exact orientation, evidence admission, draft, and latest sealed StrategyV1`
    );
  }
  if (state === "verifying_strategy") {
    return uniqueRefs([request, orientation, admission, draft, product, evidence, ...inputs]);
  }
  if (veraReport === undefined || validityReceipt === undefined) {
    throw new Error("Carren requires Vera's exact report and host validity receipt");
  }
  return uniqueRefs([
    request,
    orientation,
    admission,
    draft,
    product,
    evidence,
    ...inputs,
    veraReport,
    validityReceipt,
  ]);
}

function slotForRef(context: RunContext, ref: ArtifactRef): string {
  if (ref.kind === "plan-request") return "plan-request";
  if (ref.kind === "strategy-draft") return "latest-strategy-draft";
  if (ref.kind === "strategy-seal-feedback") return "strategy-seal-feedback";
  if (ref.kind === "review-receipt") return `prior-${ref.branch_id ?? "review"}-receipt`;
  if (ref.kind === "evidence-admission") return "strategy-evidence-admission";
  if (ref.phase === "orienting_strategy") return "latest-strategy-orientation";
  if (ref.phase === "gathering_strategy_evidence") return "latest-strategy-evidence";
  if (ref.phase === "verifying_strategy") return "latest-vera-report";
  if (ref.phase === "critiquing_strategy") return "latest-carren-report";
  if (ref.content_schema?.schema_id === "penny.grounded-synthesis.v1") {
    return "prior-grounded-synthesis";
  }
  if (ref.content_schema?.schema_id === "penny.decision.v2") return "prior-decision";
  if (ref.content_schema?.schema_id === "penny.strategy.v1") return "latest-strategy";
  return `input-${ref.artifact_id.slice(-12)}`;
}

function taskForState(context: RunContext, state: PlanWorkerState): string {
  const common =
    "artifact_read is mandatory for every needed exact workflow predecessor in input_artifacts; continue through next_range. No other tool or channel may substitute for a missing predecessor ref: never discover predecessor output through memory, /tmp, repository search, historical sessions, or name-only pointers. Other tools in the assigned catalog agent's YAML surface may be used only when materially relevant, permitted by the caller and task, and within this phase's consequence boundary; they must not bypass host-owned evidence admission. The owner captures and re-reads complete bytes; do not claim persistence.";
  switch (state) {
    case "orienting_strategy":
      return [
        common,
        "Orient only. Map the exact request's goal, current state, desired outcomes, hard constraints, non-goals, prior decisions, material uncertainties, and actual causal, temporal, resource, and informational dependencies. Produce a distinct orientation artifact. Do not emit executor tasks, approve, mutate, or execute.",
        "Emit one closed gap classification in SUMMARY. basis_sufficient is orientation_complete=true/gap_kind=none/repair_owner=none. Only one concrete strategy-blocking fact that could change readiness, dependencies, blockers, or contingencies may use orientation_complete=false/gap_kind=evidence_gap/repair_owner=echo. Never emit a target state.",
      ].join("\n\n");
    case "gathering_strategy_evidence":
      return [
        common,
        "Resolve only the exact host-admitted strategy-blocking gap. When compatible with caller constraints, use narrowly targeted read-only local inspection or web retrieval only for that gap; do not broaden into open-ended research, use memory as evidence acquisition, mutate anything, or execute application business logic. Record a precise source locator for every acquired item (a path plus line/range, or a URL plus relevant section and date), distinguish source-backed findings from inference, and report the gap honestly as unresolved when evidence is unavailable, conflicting, disallowed, or the bounded budget is exhausted. Do not design the strategy, taskify, approve, mutate, or execute.",
      ].join("\n\n");
    case "strategizing":
      return [
        common,
        `MECHANICALLY_PROJECTED_STRATEGY_DRAFT_CONTRACT:${strategyDraftPromptContract()}`,
        "Read the exact PlanRequestV1 directly; orientation, admitted evidence, and optional GroundedSynthesisV1 or DecisionV2 product are supporting evidence, not authority. Produce one complete replacement StrategyDraftV1 covering outcomes, meaningful dependencies, assumptions and risks, contingencies, trade-offs, decision points, and disposition while preserving implementation freedom. Plan only; do not taskify, approve, mutate, or execute.",
      ].join("\n\n");
    case "verifying_strategy":
      return [
        common,
        "Verify the exact latest sealed StrategyV1 against the exact PlanRequestV1, Piper orientation, Piper draft, optional admitted evidence, and every imported source ref. Check goal/outcome coverage, current-state and source fidelity, hard constraints, non-goals, prior decisions, dependencies, assumptions, blockers, disposition consistency, no manufactured executor decomposition, no taskification, and no execution. PASS only when valid.",
        "On FAIL emit exactly one gap_kind and repair_owner: evidence_gap/echo, analysis_gap/piper, or product_gap/piper. On PASS use none/none. Never emit a target state.",
      ].join("\n\n");
    case "critiquing_strategy":
      return [
        common,
        "Critique the exact Vera-passed latest StrategyV1 for strategic coherence, risk and contingency quality, useful granularity, implementation freedom, clarity, and non-misleading framing. The prior host validity receipt is evidence, not authority to overlook defects.",
        "APPROVE only with no major or critical finding; minor nonblocking findings may remain. NEEDS_REVISION emits exactly one gap_kind and repair_owner: evidence_gap/echo, analysis_gap/piper, or product_gap/piper. APPROVE uses none/none. Never emit a target state.",
      ].join("\n\n");
  }
}

function persistVersionedHostArtifact(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly phase:
    | "strategy_evidence_gate"
    | "sealing_strategy"
    | ReviewState
    | "critiquing_strategy";
  readonly branchId: string | null;
  readonly kind: string;
  readonly operationLabel: string;
  readonly producer: string;
  readonly contentSchema: { readonly schema_id: string; readonly schema_version: number };
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly content: string | Uint8Array;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const operationId = `plan-${input.operationLabel}:${sha256(input.context.identity.run_id).slice(0, 32)}`;
  const bytes =
    typeof input.content === "string"
      ? Buffer.from(input.content, "utf8")
      : Buffer.from(input.content);
  const parent = selectedLatest(
    input.context,
    (artifact) =>
      artifact.phase === input.phase &&
      artifact.branch_id === input.branchId &&
      artifact.kind === input.kind &&
      artifact.operation_id === operationId
  );
  if (parent !== undefined && parent.content_digest === sha256(bytes)) {
    if (!input.store.readById(parent.artifact_id).equals(bytes)) {
      throw new Error(`selected host artifact '${parent.artifact_id}' failed exact re-read`);
    }
    input.store.select(parent);
    return { artifact: parent, added: false };
  }
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
    media_type: "application/json",
    content_schema: input.contentSchema,
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
  if (storedVersion > version) throw new Error(`host artifact '${operationId}' ledger advanced`);
  const orphan = input.store.refFor(
    input.context.identity.run_id,
    input.phase,
    input.branchId,
    input.kind,
    operationId,
    version
  );
  const artifact = orphan ?? input.store.persist({ metadata, content: bytes });
  if (
    canonicalJson(input.store.metadata(artifact)) !== canonicalJson(metadata) ||
    !input.store.readById(artifact.artifact_id).equals(bytes)
  ) {
    throw new Error(`host artifact '${operationId}' diverged at version ${version}`);
  }
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined || canonicalJson(reread) !== canonicalJson(artifact)) {
    throw new Error(`host artifact '${artifact.artifact_id}' failed manifest re-read`);
  }
  input.store.select(reread);
  return { artifact: reread, added: addSelectedArtifact(input.context, reread) };
}

function persistStrategyEvidenceAdmission(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: EvidenceAdmissionV1;
  readonly added: boolean;
} {
  const orientation = latestOrientationArtifact(input.context);
  if (orientation === undefined)
    throw new Error("strategy evidence gate requires Piper orientation");
  const execution = exactAcceptedExecutionGroup({
    context: input.context,
    checkpointer: input.checkpointer,
    artifact: orientation,
  });
  const gap = execution.routed.details.orientation_complete !== true;
  const body: Omit<EvidenceAdmissionV1, "admission_id"> = {
    schema_id: "penny.evidence-admission.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    domain: "strategy",
    origin_state: "orienting_strategy",
    source_artifact_ref: orientation,
    routing_result_sha256: sha256(canonicalJson(execution.routed)),
    source_execution_receipt_ids: [...execution.receiptIds],
    classification: gap ? "strategy_blocking_evidence_gap" : "basis_sufficient",
    evidence_required: gap,
    minted_by: "host:evidence-gate",
  };
  const value = validateEvidenceAdmission({
    ...body,
    admission_id: evidenceAdmissionId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "strategy_evidence_gate",
    branchId: null,
    kind: "evidence-admission",
    operationLabel: "evidence-admission",
    producer: "host:evidence-gate",
    contentSchema: { schema_id: "penny.evidence-admission.v1", schema_version: 1 },
    upstreamRefs: [orientation],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function strategySealFeedbackOperationId(context: RunContext): string {
  return `strategy-seal-feedback:${sha256(context.identity.run_id).slice(0, 32)}`;
}

function readStrategySealFeedback(
  store: ArtifactHostStore,
  artifact: ArtifactRef
): StrategySealFeedbackV1 {
  const bytes = store.readById(artifact.artifact_id).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("StrategySealFeedbackV1 artifact is not JSON");
  }
  const feedback = validateStrategySealFeedback(parsed);
  if (canonicalJson(feedback) !== bytes) {
    throw new Error("StrategySealFeedbackV1 artifact is not canonical JSON");
  }
  return feedback;
}

function persistStrategySealFeedback(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly draftArtifact: ArtifactRef;
  readonly failure: StrategyDraftValidationError;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const feedback = validateStrategySealFeedback({
    schema_id: "penny.strategy-seal-feedback.v1",
    schema_version: 1,
    attempt: 1,
    rejected_draft_artifact_id: input.draftArtifact.artifact_id,
    failure_class: input.failure.failureClass,
    issues: input.failure.issues,
  });
  const operationId = strategySealFeedbackOperationId(input.context);
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: "sealing_strategy",
    branch_id: null,
    kind: "strategy-seal-feedback",
    operation_id: operationId,
    version: 1,
    producer: "host:strategy-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.strategy-seal-feedback.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [input.draftArtifact],
  };
  const existing = input.store.refFor(
    input.context.identity.run_id,
    "sealing_strategy",
    null,
    "strategy-seal-feedback",
    operationId,
    1
  );
  const content = canonicalJson(feedback);
  const artifact = existing ?? input.store.persist({ metadata, content });
  if (
    canonicalJson(input.store.metadata(artifact)) !== canonicalJson(metadata) ||
    input.store.readById(artifact.artifact_id).toString("utf8") !== content ||
    canonicalJson(readStrategySealFeedback(input.store, artifact)) !== canonicalJson(feedback)
  ) {
    throw new Error("StrategySealFeedbackV1 deterministic persistence diverged");
  }
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined) throw new Error("StrategySealFeedbackV1 manifest re-read failed");
  input.store.select(reread);
  return { artifact: reread, added: addSelectedArtifact(input.context, reread) };
}

function persistSealedStrategy(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly requestArtifact: ArtifactRef;
  readonly orientationArtifact: ArtifactRef;
  readonly admissionArtifact: ArtifactRef;
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly inputRefs: readonly ArtifactRef[];
  readonly draftArtifact: ArtifactRef;
  readonly draft: StrategyDraftV1;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const request = canonicalPlanRequest(input.store, input.context);
  const draftBytes = input.store.readById(input.draftArtifact.artifact_id);
  const strategy = sealStrategy({
    request,
    draft: input.draft,
    draftBytes,
    requestSha256: planRequestSha256(request),
    sourceRequestArtifactId: input.requestArtifact.artifact_id,
    sourceDraftArtifactId: input.draftArtifact.artifact_id,
    exactInputArtifactIds: input.inputRefs.map((artifact) => artifact.artifact_id),
  });
  const content = canonicalJson(strategy);
  const operationId = `sealed-strategy:${sha256(input.context.identity.run_id).slice(0, 32)}`;
  const parent = latestStrategyArtifact(input.context);
  const storedVersion = input.store.lastVersion(
    input.context.identity.run_id,
    "sealing_strategy",
    null,
    "strategy",
    operationId
  );
  const upstreamRefs = [
    input.requestArtifact,
    input.orientationArtifact,
    input.admissionArtifact,
    ...input.evidenceRefs,
    ...input.inputRefs,
    input.draftArtifact,
  ];
  const interrupted =
    storedVersion === 0
      ? null
      : input.store.refFor(
          input.context.identity.run_id,
          "sealing_strategy",
          null,
          "strategy",
          operationId,
          storedVersion
        );
  if (
    interrupted !== null &&
    input.store.readById(interrupted.artifact_id).toString("utf8") === content &&
    canonicalJson(input.store.metadata(interrupted).upstream_refs) === canonicalJson(upstreamRefs)
  ) {
    input.store.select(interrupted);
    validateCanonicalStrategyBytes(input.store.readById(interrupted.artifact_id), interrupted);
    return { artifact: interrupted, added: addSelectedArtifact(input.context, interrupted) };
  }
  const version = Math.max(parent?.version ?? 0, storedVersion) + 1;
  const parentRef =
    version === 1
      ? null
      : input.store.refFor(
          input.context.identity.run_id,
          "sealing_strategy",
          null,
          "strategy",
          operationId,
          version - 1
        );
  if (version > 1 && parentRef === null) {
    throw new Error("StrategyV1 revision chain is missing its preceding product");
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: "sealing_strategy",
    branch_id: null,
    kind: "strategy",
    operation_id: operationId,
    version,
    producer: "host:strategy-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.strategy.v1", schema_version: 1 },
    parent_ref: parentRef,
    upstream_refs: upstreamRefs,
  };
  const orphan = input.store.refFor(
    input.context.identity.run_id,
    "sealing_strategy",
    null,
    "strategy",
    operationId,
    version
  );
  const artifact = orphan ?? input.store.persist({ metadata, content });
  if (
    canonicalJson(input.store.metadata(artifact)) !== canonicalJson(metadata) ||
    input.store.readById(artifact.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("StrategyV1 host artifact diverged from deterministic sealing");
  }
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined) throw new Error("StrategyV1 host artifact failed manifest re-read");
  input.store.select(reread);
  validateCanonicalStrategyBytes(input.store.readById(reread.artifact_id), reread);
  return { artifact: reread, added: addSelectedArtifact(input.context, reread) };
}

function eventString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function exactAcceptedExecutionGroup(input: {
  readonly context: RunContext;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly artifact: ArtifactRef;
}): { readonly routed: PhaseResult; readonly receiptIds: readonly string[] } {
  const matches: Array<{ routed: PhaseResult; receiptIds: readonly string[] }> = [];
  for (const event of input.checkpointer.events(input.context.identity.run_id)) {
    const acceptedId =
      event.eventType === "phase_result_accepted"
        ? eventString(event.payload.receipt_id)
        : undefined;
    if (acceptedId !== undefined) {
      const result = input.checkpointer.receiptResultById(acceptedId);
      if (
        result !== undefined &&
        result.worker_receipt.receipt_id === acceptedId &&
        canonicalJson(result.output_artifact) === canonicalJson(input.artifact)
      ) {
        matches.push({ routed: result, receiptIds: [acceptedId] });
      }
    }
    const sourceId =
      event.eventType === "routing_repair_accepted"
        ? eventString(event.payload.source_receipt_id)
        : undefined;
    const repairId =
      event.eventType === "routing_repair_accepted"
        ? eventString(event.payload.repair_receipt_id)
        : undefined;
    if (sourceId !== undefined && repairId !== undefined) {
      const source = input.checkpointer.receiptResultById(sourceId);
      const repair = input.checkpointer.receiptResultById(repairId);
      if (
        source !== undefined &&
        repair !== undefined &&
        source.worker_receipt.receipt_id === sourceId &&
        repair.worker_receipt.receipt_id === repairId &&
        canonicalJson(source.output_artifact) === canonicalJson(input.artifact) &&
        repair.output_artifact.kind === "routing-metadata"
      ) {
        matches.push({ routed: repair, receiptIds: [sourceId, repairId] });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `strategy artifact '${input.artifact.artifact_id}' requires exactly one accepted execution group`
    );
  }
  const match = matches[0];
  if (match === undefined) throw new Error("accepted strategy execution group is absent");
  return match;
}

function acceptedReviewEvidence(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly state: ReviewState;
  readonly verdict: "PASS" | "APPROVE";
  readonly product: ArtifactRef;
}):
  | {
      readonly reportRef: ArtifactRef;
      readonly result: PhaseResult;
      readonly executionReceiptIds: readonly string[];
    }
  | undefined {
  for (const event of [...input.checkpointer.events(input.context.identity.run_id)].reverse()) {
    if (eventString(event.payload.state_id) !== input.state) continue;
    const sourceId =
      event.eventType === "phase_result_accepted"
        ? eventString(event.payload.receipt_id)
        : event.eventType === "routing_repair_accepted"
          ? eventString(event.payload.source_receipt_id)
          : undefined;
    const repairId =
      event.eventType === "routing_repair_accepted"
        ? eventString(event.payload.repair_receipt_id)
        : undefined;
    const source =
      sourceId === undefined ? undefined : input.checkpointer.receiptResultById(sourceId);
    const routed = repairId === undefined ? source : input.checkpointer.receiptResultById(repairId);
    if (
      source === undefined ||
      routed === undefined ||
      routed.details.verdict !== input.verdict ||
      !input.store
        .metadata(source.output_artifact)
        .upstream_refs.some((ref) => ref.artifact_id === input.product.artifact_id)
    ) {
      continue;
    }
    return {
      reportRef: source.output_artifact,
      result: routed,
      executionReceiptIds:
        repairId === undefined
          ? [source.worker_receipt.receipt_id]
          : [source.worker_receipt.receipt_id, routed.worker_receipt.receipt_id],
    };
  }
  return undefined;
}

function currentReviewSubject(context: RunContext): ReviewSubjectV1 {
  const request = admittedPlanRequestArtifact(context);
  const orientation = latestOrientationArtifact(context);
  const admission = latestEvidenceAdmissionArtifact(context);
  const draft = latestStrategyDraftArtifact(context);
  const product = latestStrategyArtifact(context);
  if (
    orientation === undefined ||
    admission === undefined ||
    draft === undefined ||
    product === undefined
  ) {
    throw new Error("latest strategy review subject is incomplete");
  }
  const evidenceRefs = uniqueRefs([latestEvidenceArtifact(context)]);
  const importedInputRefs = [...exactPlanInputRefs(context)];
  return {
    product_ref: product,
    product_schema_id: "penny.strategy.v1",
    product_schema_version: 1,
    product_sha256: product.content_digest,
    request_ref: request,
    analysis_ref: orientation,
    admission_ref: admission,
    draft_ref: draft,
    evidence_refs: evidenceRefs,
    imported_input_refs: importedInputRefs,
    admitted_upstream_sha256: reviewSubjectUpstreamSha256({
      request_ref: request,
      analysis_ref: orientation,
      admission_ref: admission,
      draft_ref: draft,
      product_ref: product,
      evidence_refs: evidenceRefs,
      imported_input_refs: importedInputRefs,
    }),
  };
}

function readReviewReceipt(store: ArtifactHostStore, artifact: ArtifactRef): ReviewReceiptV1 {
  const bytes = store.readById(artifact.artifact_id).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error(`review receipt '${artifact.artifact_id}' is not JSON`);
  }
  const receipt = validateReviewReceipt(value);
  if (canonicalJson(receipt) !== bytes) {
    throw new Error(`review receipt '${artifact.artifact_id}' is not canonical`);
  }
  return receipt;
}

function matchingReviewReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly kind: ReviewKind;
  readonly subject: ReviewSubjectV1;
}): { readonly artifact: ArtifactRef; readonly receipt: ReviewReceiptV1 } | undefined {
  const artifact = latestReviewReceiptArtifact(input.context, input.kind);
  if (artifact === undefined) return undefined;
  const receipt = readReviewReceipt(input.store, artifact);
  return receipt.review_kind === input.kind &&
    receipt.subject.product_ref.artifact_id === input.subject.product_ref.artifact_id &&
    receipt.subject.product_sha256 === input.subject.product_sha256 &&
    receipt.subject.admitted_upstream_sha256 === input.subject.admitted_upstream_sha256
    ? { artifact, receipt }
    : undefined;
}

function ensureReviewReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly kind: ReviewKind;
}): {
  readonly artifact: ArtifactRef;
  readonly receipt: ReviewReceiptV1;
  readonly added: boolean;
} {
  const subject = currentReviewSubject(input.context);
  const existing = matchingReviewReceipt({ ...input, subject });
  if (existing !== undefined) return { ...existing, added: false };
  const state = input.kind === "validity" ? "verifying_strategy" : "critiquing_strategy";
  const evidence = acceptedReviewEvidence({
    context: input.context,
    store: input.store,
    checkpointer: input.checkpointer,
    state,
    verdict: input.kind === "validity" ? "PASS" : "APPROVE",
    product: subject.product_ref,
  });
  if (evidence === undefined) throw new Error(`latest-product ${input.kind} review is absent`);
  const prior =
    input.kind === "quality" ? latestReviewReceiptArtifact(input.context, "validity") : undefined;
  if (input.kind === "quality" && prior === undefined) {
    throw new Error("quality review requires the exact latest validity receipt");
  }
  const requiredUpstreamRefs = [
    ...reviewSubjectUpstreamRefs(subject),
    ...(prior === undefined ? [] : [prior]),
  ];
  const reportUpstreamRefs = input.store.metadata(evidence.reportRef).upstream_refs;
  const priorReceipt = prior === undefined ? undefined : readReviewReceipt(input.store, prior);
  const body: Omit<ReviewReceiptV1, "receipt_id"> = {
    schema_id: "penny.review-receipt.v1",
    schema_version: 1,
    review_kind: input.kind,
    reviewer: input.kind === "validity" ? "vera" : "carren",
    verdict: input.kind === "validity" ? "PASS" : "APPROVE",
    subject,
    review_report_ref: evidence.reportRef,
    prior_review_receipt_ref: prior ?? null,
    execution_receipt_id: evidence.result.worker_receipt.receipt_id,
    execution_result_sha256: sha256(canonicalJson(evidence.result)),
    created_at: evidence.result.worker_receipt.ended_at,
    minted_by: "host:review-receipt-authority",
  };
  const receipt = validateReviewReceiptBinding({
    receipt: { ...body, receipt_id: reviewReceiptId(body) },
    review_report_upstream_refs: reportUpstreamRefs,
    ...(prior === undefined || priorReceipt === undefined
      ? {}
      : { prior_review: { artifact_ref: prior, receipt: priorReceipt } }),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: state,
    branchId: input.kind,
    kind: "review-receipt",
    operationLabel: `review-receipt-${input.kind}`,
    producer: "host:review-receipt-authority",
    contentSchema: { schema_id: "penny.review-receipt.v1", schema_version: 1 },
    upstreamRefs: [...requiredUpstreamRefs, evidence.reportRef],
    content: canonicalJson(receipt),
  });
  const reread = readReviewReceipt(input.store, persisted.artifact);
  if (canonicalJson(reread) !== canonicalJson(receipt)) {
    throw new Error(`review receipt '${receipt.receipt_id}' failed exact re-read`);
  }
  return { ...persisted, receipt: reread };
}

function exactExecutionReceiptIds(input: {
  readonly context: RunContext;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly artifacts: readonly ArtifactRef[];
}): string[] {
  const artifactIds = input.artifacts.map((artifact) => artifact.artifact_id);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error("strategy execution-evidence artifacts must be unique");
  }
  const events = input.checkpointer.events(input.context.identity.run_id);
  const groups = input.artifacts.map((artifact) => {
    const matches: string[][] = [];
    for (const event of events) {
      const acceptedId = eventString(event.payload.receipt_id);
      if (acceptedId !== undefined) {
        const result = input.checkpointer.receiptResultById(acceptedId);
        if (
          result !== undefined &&
          result.worker_receipt.receipt_id === acceptedId &&
          canonicalJson(result.output_artifact) === canonicalJson(artifact)
        ) {
          matches.push([acceptedId]);
        }
      }
      const sourceId = eventString(event.payload.source_receipt_id);
      const repairId = eventString(event.payload.repair_receipt_id);
      if (sourceId !== undefined && repairId !== undefined) {
        const source = input.checkpointer.receiptResultById(sourceId);
        const repair = input.checkpointer.receiptResultById(repairId);
        if (
          source !== undefined &&
          repair !== undefined &&
          source.worker_receipt.receipt_id === sourceId &&
          repair.worker_receipt.receipt_id === repairId &&
          canonicalJson(source.output_artifact) === canonicalJson(artifact) &&
          repair.output_artifact.kind === "routing-metadata"
        ) {
          matches.push([sourceId, repairId]);
        }
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        `strategy artifact '${artifact.artifact_id}' requires exactly one accepted execution-evidence group`
      );
    }
    return matches[0] ?? [];
  });
  const ids = groups.flat();
  if (new Set(ids).size !== ids.length) {
    throw new Error("strategy execution receipt IDs must map one-to-one to exact artifacts");
  }
  return ids;
}

function assertEvidenceAdmissionExecutionBinding(input: {
  readonly context: RunContext;
  readonly reader: Pick<ArtifactReader, "readById">;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly admissionRef: ArtifactRef;
  readonly orientationRef: ArtifactRef;
}): EvidenceAdmissionV1 {
  const admission = readCanonicalJson(input.reader, input.admissionRef, validateEvidenceAdmission);
  const execution = exactAcceptedExecutionGroup({
    context: input.context,
    checkpointer: input.checkpointer,
    artifact: input.orientationRef,
  });
  if (
    canonicalJson(admission.source_artifact_ref) !== canonicalJson(input.orientationRef) ||
    admission.routing_result_sha256 !== sha256(canonicalJson(execution.routed)) ||
    canonicalJson(admission.source_execution_receipt_ids) !== canonicalJson(execution.receiptIds)
  ) {
    throw new Error(
      "strategy evidence admission does not bind the exact accepted orientation result"
    );
  }
  return admission;
}

function ensureProductIntegrity(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: StrategyProductIntegrityV1;
  readonly added: boolean;
} {
  const subject = currentReviewSubject(input.context);
  assertEvidenceAdmissionExecutionBinding({
    context: input.context,
    reader: input.store,
    checkpointer: input.checkpointer,
    admissionRef: subject.admission_ref,
    orientationRef: subject.analysis_ref,
  });
  const validity = matchingReviewReceipt({
    context: input.context,
    store: input.store,
    kind: "validity",
    subject,
  });
  const quality = matchingReviewReceipt({
    context: input.context,
    store: input.store,
    kind: "quality",
    subject,
  });
  if (validity === undefined || quality === undefined) {
    throw new Error("strategy product integrity requires current validity and quality receipts");
  }
  const reviewArtifacts = [validity.receipt.review_report_ref, quality.receipt.review_report_ref];
  const executionReceiptIds = exactExecutionReceiptIds({
    context: input.context,
    checkpointer: input.checkpointer,
    artifacts: [
      subject.analysis_ref,
      ...subject.evidence_refs,
      subject.draft_ref,
      ...reviewArtifacts,
    ],
  });
  if (executionReceiptIds.length < 4 + subject.evidence_refs.length) {
    throw new Error("strategy product integrity lacks exact signed worker execution evidence");
  }
  validateCanonicalStrategyBytes(
    input.store.readById(subject.product_ref.artifact_id),
    subject.product_ref
  );
  const body: Omit<StrategyProductIntegrityV1, "integrity_id"> = {
    schema_id: "penny.strategy-product-integrity.v1",
    schema_version: 1,
    status: "PASS",
    request_ref: subject.request_ref,
    orientation_ref: subject.analysis_ref,
    admission_ref: subject.admission_ref,
    evidence_refs: subject.evidence_refs,
    imported_input_refs: subject.imported_input_refs,
    draft_ref: subject.draft_ref,
    strategy_ref: subject.product_ref,
    vera_report_ref: validity.receipt.review_report_ref,
    carren_report_ref: quality.receipt.review_report_ref,
    validity_receipt_ref: validity.artifact,
    quality_receipt_ref: quality.artifact,
    execution_receipt_ids: executionReceiptIds,
    checks: [
      "canonical_strategy",
      "exact_lineage",
      "signed_worker_evidence",
      "latest_validity_receipt",
      "latest_quality_receipt",
      "no_execution",
    ],
    execution_started: false,
    execution_authorized: false,
  };
  const value = validateStrategyProductIntegrity({
    ...body,
    integrity_id: strategyProductIntegrityId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "critiquing_strategy",
    branchId: "integrity",
    kind: "strategy-product-integrity",
    operationLabel: "product-integrity",
    producer: "host:product-validator",
    contentSchema: { schema_id: "penny.strategy-product-integrity.v1", schema_version: 1 },
    upstreamRefs: [
      ...reviewSubjectUpstreamRefs(subject),
      validity.receipt.review_report_ref,
      quality.receipt.review_report_ref,
      validity.artifact,
      quality.artifact,
    ],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function ensureProductEnvelope(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly integrity: ArtifactRef;
}): {
  readonly artifact: ArtifactRef;
  readonly value: StrategyProductEnvelopeV1;
  readonly added: boolean;
} {
  const subject = currentReviewSubject(input.context);
  const validity = matchingReviewReceipt({
    context: input.context,
    store: input.store,
    kind: "validity",
    subject,
  });
  const quality = matchingReviewReceipt({
    context: input.context,
    store: input.store,
    kind: "quality",
    subject,
  });
  if (validity === undefined || quality === undefined) {
    throw new Error("strategy product envelope requires current review receipts");
  }
  const body: Omit<StrategyProductEnvelopeV1, "envelope_id"> = {
    schema_id: "penny.strategy-product-envelope.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    status: "complete",
    strategy_ref: subject.product_ref,
    request_ref: subject.request_ref,
    orientation_ref: subject.analysis_ref,
    admission_ref: subject.admission_ref,
    evidence_refs: subject.evidence_refs,
    imported_input_refs: subject.imported_input_refs,
    draft_ref: subject.draft_ref,
    vera_report_ref: validity.receipt.review_report_ref,
    carren_report_ref: quality.receipt.review_report_ref,
    validity_receipt_ref: validity.artifact,
    quality_receipt_ref: quality.artifact,
    integrity_ref: input.integrity,
  };
  const value = validateStrategyProductEnvelope({
    ...body,
    envelope_id: strategyProductEnvelopeId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "critiquing_strategy",
    branchId: null,
    kind: "strategy-product-envelope",
    operationLabel: "product-envelope",
    producer: "host:product-validator",
    contentSchema: { schema_id: "penny.strategy-product-envelope.v1", schema_version: 1 },
    upstreamRefs: [
      ...reviewSubjectUpstreamRefs(subject),
      validity.artifact,
      quality.artifact,
      input.integrity,
    ],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function readCanonicalJson<T>(
  store: Pick<ArtifactReader, "readById">,
  artifact: ArtifactRef,
  validate: (value: unknown) => T
): T {
  const bytes = store.readById(artifact.artifact_id).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error(`artifact '${artifact.artifact_id}' is not JSON`);
  }
  const parsed = validate(value);
  if (canonicalJson(parsed) !== bytes)
    throw new Error(`artifact '${artifact.artifact_id}' is not canonical`);
  return parsed;
}

function gapOwner(kind: RepairGapKind): RepairOwner {
  if (kind === "evidence_gap") return "echo";
  if (kind === "analysis_gap") return "piper";
  return "piper";
}

function reviewEvaluation(
  state: ReviewState,
  details: Record<string, JsonValue>
): EvaluationResultV2 | null {
  const verdict = details.verdict;
  const rawKind = details.gap_kind;
  const rawOwner = details.repair_owner;
  const findings =
    state === "critiquing_strategy" && Array.isArray(details.findings)
      ? details.findings.flatMap((finding) =>
          finding !== null &&
          typeof finding === "object" &&
          !Array.isArray(finding) &&
          typeof finding.message === "string"
            ? [finding.message]
            : []
        )
      : Array.isArray(details.findings)
        ? details.findings.filter((finding): finding is string => typeof finding === "string")
        : [];
  const majorOnApprove =
    state === "critiquing_strategy" &&
    verdict === "APPROVE" &&
    Array.isArray(details.findings) &&
    details.findings.some(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        !Array.isArray(finding) &&
        (finding.severity === "major" || finding.severity === "critical")
    );
  const accepted = state === "verifying_strategy" ? verdict === "PASS" : verdict === "APPROVE";
  if (accepted && !majorOnApprove) {
    if (rawKind !== "none" || rawOwner !== "none") {
      throw new Error(`${state} accepted verdict must use gap_kind=none and repair_owner=none`);
    }
    return null;
  }
  const kind: RepairGapKind = majorOnApprove
    ? "product_gap"
    : rawKind === "evidence_gap" || rawKind === "analysis_gap" || rawKind === "product_gap"
      ? rawKind
      : (() => {
          throw new Error(`${state} non-acceptance requires one closed repair gap kind`);
        })();
  const owner = majorOnApprove ? "piper" : rawOwner;
  if (owner !== gapOwner(kind)) {
    throw new Error(`${state} gap kind and repair owner disagree`);
  }
  return {
    schema_version: 2,
    kind,
    detail: `${state} returned ${String(verdict)} with ${findings.length} finding(s)`,
    findings: findings.slice(0, 32),
    strategy_delta:
      typeof details.strategy_delta === "string" && details.strategy_delta.trim().length > 0
        ? details.strategy_delta
        : `Repair the ${kind} without changing role boundaries.`,
  };
}

function bestPartial(context: RunContext): ArtifactRef | undefined {
  return (
    latestStrategyArtifact(context) ??
    latestStrategyDraftArtifact(context) ??
    latestOrientationArtifact(context)
  );
}

export class PlanPlaybook
  implements
    PlaybookCoreV1,
    HostContinuationCapabilityV1,
    LivenessTerminalCapabilityV1,
    StateAwareRepairCapabilityV1,
    RepairExhaustionCapabilityV1,
    RoutingRepairCapabilityV1
{
  constructor(
    private readonly sealed: boolean,
    private readonly revisions?: ArtifactRevisionLookup,
    private readonly artifactStore?: ArtifactHostStore,
    private readonly checkpointer?: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"],
    private readonly hostFault?: (point: string) => void
  ) {}

  initialize(context: RunContext): Directive {
    if (
      context.identity.playbook !== PLAN_PLAYBOOK_NAME &&
      context.identity.playbook !== PLAN_UNSEALED_EVALUATION_NAME
    ) {
      throw new Error(`PlanPlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    context.transition(this.sealed ? "orienting_strategy" : "strategizing");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    if (!Object.hasOwn(PLAN_AGENT_BY_STATE, context.stateId)) {
      throw new Error(`cannot dispatch plan state '${context.stateId}'`);
    }
    const state: PlanWorkerState =
      context.stateId === "orienting_strategy" ||
      context.stateId === "gathering_strategy_evidence" ||
      context.stateId === "strategizing" ||
      context.stateId === "verifying_strategy" ||
      context.stateId === "critiquing_strategy"
        ? context.stateId
        : (() => {
            throw new Error(`unknown plan state '${context.stateId}'`);
          })();
    const refs = refsForState(context, state);
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: state,
      agent: PLAN_AGENT_BY_STATE[state],
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      task: taskForState(context, state),
      input_artifacts: {
        schema_version: 2,
        artifacts: refs.map((ref) => ({ slot: slotForRef(context, ref), ref })),
      },
      output_artifact: outputMetadata(context, state, refs, this.revisions),
    });
    context.pendingDirective = next;
    context.status = "running";
    return next;
  }

  evaluateRepair(
    _context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): EvaluationResultV2 | null {
    if (state === "orienting_strategy") {
      if (details.orientation_complete === true) {
        if (details.gap_kind !== "none" || details.repair_owner !== "none") {
          throw new Error(
            "complete strategy orientation must use gap_kind=none and repair_owner=none"
          );
        }
        return null;
      }
      if (details.gap_kind !== "evidence_gap" || details.repair_owner !== "echo") {
        throw new Error("incomplete strategy orientation requires evidence_gap owned by echo");
      }
      return {
        schema_version: 2,
        kind: "evidence_gap",
        detail: "Piper identified one closed strategy-sensitive evidence gap",
        findings: Array.isArray(details.findings)
          ? details.findings.filter((finding): finding is string => typeof finding === "string")
          : [],
        strategy_delta:
          typeof details.strategy_delta === "string"
            ? details.strategy_delta
            : "Inspect admitted evidence.",
      };
    }
    if (state === "verifying_strategy" || state === "critiquing_strategy") {
      return reviewEvaluation(state, details);
    }
    return null;
  }

  terminalizeRepairExhaustion(
    context: RunContext,
    state: string,
    evaluation: EvaluationResultV2
  ): Directive {
    return this.terminal(
      context,
      "incomplete",
      false,
      [`repair budget exhausted at ${state}:${evaluation.kind}`],
      undefined,
      {
        incomplete_reason: "repair_budget_exhausted",
        exhausted: true,
        exhaustion_reason: `${state}:${evaluation.kind}`,
      }
    );
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): PlaybookStepOutcomeV1 {
    switch (context.stateId) {
      case "orienting_strategy":
        if (details.orientation_complete !== true) {
          throw new Error("orientation gap reached happy routing without engine-owned repair");
        }
        context.transition("strategy_evidence_gate");
        return hostContinuation();
      case "gathering_strategy_evidence":
        context.transition("strategizing");
        return this.dispatch(context);
      case "strategizing":
        if (details.complete !== true) throw new Error("strategy draft summary is incomplete");
        context.transition("sealing_strategy");
        return hostContinuation();
      case "verifying_strategy":
        if (details.verdict !== "PASS") {
          throw new Error("Vera gap reached happy routing without engine-owned repair");
        }
        context.transition("critiquing_strategy");
        return hostContinuation();
      case "critiquing_strategy":
        if (details.verdict !== "APPROVE") {
          throw new Error("Carren revision reached happy routing without engine-owned repair");
        }
        context.pendingDirective = null;
        return hostContinuation();
      default:
        throw new Error(`unexpected plan summary in state '${context.stateId}'`);
    }
  }

  routingRepair(context: RunContext, malformed: PhaseResult): Directive {
    const assignment = context.pendingDirective;
    if (
      assignment?.action !== "invoke_agent" ||
      assignment.state_id !== malformed.state_id ||
      assignment.agent !== malformed.agent ||
      assignment.attempt !== malformed.attempt ||
      (malformed.branch_id ?? null) !== null
    ) {
      throw new Error("routing_repair_binding_invalid");
    }
    if (context.stepCount >= context.maxSteps) {
      throw new Error(`run exceeded max_steps=${context.maxSteps}`);
    }
    const binding = {
      schema_version: 1 as const,
      source_state_id: malformed.state_id,
      source_branch_id: null,
      source_agent: malformed.agent,
      source_attempt: malformed.attempt,
      source_artifact_ref: malformed.output_artifact,
      source_receipt_id: malformed.worker_receipt.receipt_id,
      source_result_sha256: sha256(canonicalJson(malformed)),
    };
    context.previousState = context.stateId;
    context.stepCount += 1;
    context.status = "running";
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: malformed.state_id,
      agent: malformed.agent,
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      ...(assignment.model_override === undefined
        ? {}
        : { model_override: assignment.model_override }),
      execution_purpose: "routing_repair",
      routing_repair_binding: binding,
      task: "Repair routing metadata only. Read the one exact malformed source artifact and emit only the mechanically projected registered phase SUMMARY. Do not alter or replace semantic report content.",
      input_artifacts: {
        schema_version: 2,
        artifacts: [{ slot: "malformed-source", ref: malformed.output_artifact }],
      },
      output_artifact: {
        schema_version: 2,
        run_id: context.identity.run_id,
        phase: malformed.state_id,
        branch_id: null,
        kind: "routing-metadata",
        operation_id: `routing-repair:${sha256(canonicalJson(binding))}`,
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

  resume(_context: RunContext, _response: JsonValue): Directive {
    throw new Error("plan has no user-response state; rerun with updated facts instead");
  }

  cancel(context: RunContext, reason: string): Directive {
    return this.terminal(context, "cancelled", false, [reason]);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending?.action !== "invoke_agent") return pending;
    if (pending.execution_purpose === "routing_repair") return pending;
    if (!isPlanWorkerState(pending.state_id)) return pending;
    const state = pending.state_id;
    return validateDirective({
      ...pending,
      output_artifact: outputMetadata(
        context,
        state,
        pending.output_artifact.upstream_refs,
        this.revisions
      ),
    });
  }

  terminalizeLiveness(
    context: RunContext,
    reason: LivenessTerminalReason,
    snapshot: LivenessSnapshotV1
  ): Directive {
    const reasonEvidence: Readonly<Record<string, JsonValue>> =
      reason === "identical_error_stall"
        ? { incomplete_reason: reason, stalled: true, stall_reason: reason }
        : reason === "routing_repair_binding_invalid"
          ? { incomplete_reason: reason }
          : {
              incomplete_reason: reason,
              exhausted: true,
              exhaustion_reason: reason,
            };
    return this.terminal(context, "incomplete", false, [reason], snapshot, reasonEvidence);
  }

  needsHostContinuation(context: RunContext): boolean {
    return (
      context.terminalDirective === null &&
      (context.stateId === "strategy_evidence_gate" ||
        context.stateId === "sealing_strategy" ||
        context.stateId === "admitting_strategy" ||
        (context.stateId === "critiquing_strategy" && context.pendingDirective === null))
    );
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context)) {
      throw new Error(`plan state '${context.stateId}' has no deterministic host continuation`);
    }
    const store = this.artifactStore;
    const checkpointer = this.checkpointer;
    if (store === undefined || checkpointer === undefined) {
      throw new Error("plan engine host continuation dependencies are unavailable");
    }
    if (context.stateId === "strategy_evidence_gate") {
      return this.continueEvidenceGate(context, store, checkpointer);
    }
    if (context.stateId === "sealing_strategy") {
      return this.continueSealing(context, store);
    }
    if (context.stateId === "admitting_strategy") {
      return {
        event_type: "plan_product_completion_admitted",
        payload: { run_id: context.identity.run_id },
        directive: this.terminal(context, "complete", true, []),
        after_checkpoint_fault: "admitting_strategy:completion-admission",
      };
    }
    const subject = currentReviewSubject(context);
    const carren = acceptedReviewEvidence({
      context,
      store,
      checkpointer,
      state: "critiquing_strategy",
      verdict: "APPROVE",
      product: subject.product_ref,
    });
    if (carren === undefined) {
      const validity = ensureReviewReceipt({ context, store, checkpointer, kind: "validity" });
      if (validity.added) {
        this.hostFault?.("verifying_strategy:receipt-persistence");
        return {
          event_type: "plan_validity_receipt_persisted",
          payload: {
            run_id: context.identity.run_id,
            product_artifact_id: subject.product_ref.artifact_id,
            receipt_artifact_id: validity.artifact.artifact_id,
          },
        };
      }
      const next = this.dispatch(context);
      return {
        event_type: "plan_quality_review_dispatched",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          next_action: next.action,
        },
        directive: next,
      };
    }
    const quality = ensureReviewReceipt({ context, store, checkpointer, kind: "quality" });
    if (quality.added) {
      this.hostFault?.("critiquing_strategy:receipt-persistence");
      return {
        event_type: "plan_quality_receipt_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          receipt_artifact_id: quality.artifact.artifact_id,
        },
      };
    }
    const integrity = ensureProductIntegrity({ context, store, checkpointer });
    if (integrity.added) {
      this.hostFault?.("critiquing_strategy:integrity-persistence");
      return {
        event_type: "plan_product_integrity_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          integrity_artifact_id: integrity.artifact.artifact_id,
        },
      };
    }
    const envelope = ensureProductEnvelope({ context, store, integrity: integrity.artifact });
    if (envelope.added) {
      this.hostFault?.("critiquing_strategy:envelope-persistence");
      return {
        event_type: "plan_product_envelope_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          envelope_artifact_id: envelope.artifact.artifact_id,
        },
      };
    }
    context.transition("admitting_strategy");
    return {
      event_type: "plan_product_completion_candidate",
      payload: {
        run_id: context.identity.run_id,
        product_artifact_id: subject.product_ref.artifact_id,
        envelope_artifact_id: envelope.artifact.artifact_id,
      },
    };
  }

  hostCheckpointCommitted(_context: RunContext, point: string): void {
    this.hostFault?.(point);
  }

  private continueEvidenceGate(
    context: RunContext,
    store: ArtifactHostStore,
    checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"]
  ): HostContinuationStepV1 {
    const admission = persistStrategyEvidenceAdmission({ context, store, checkpointer });
    if (admission.added) {
      this.hostFault?.("strategy_evidence_gate:admission-persistence");
      return {
        event_type: "plan_evidence_admission_persisted",
        payload: {
          run_id: context.identity.run_id,
          admission_artifact_id: admission.artifact.artifact_id,
          evidence_required: admission.value.evidence_required,
        },
      };
    }
    const nextState = admission.value.evidence_required
      ? "gathering_strategy_evidence"
      : "strategizing";
    context.transition(nextState);
    const next = this.dispatch(context);
    return {
      event_type: "plan_evidence_gate_routed",
      payload: {
        run_id: context.identity.run_id,
        admission_artifact_id: admission.artifact.artifact_id,
        next_state: nextState,
      },
      directive: next,
    };
  }

  private continueSealing(context: RunContext, store: ArtifactHostStore): HostContinuationStepV1 {
    const requestArtifact = admittedPlanRequestArtifact(context);
    const orientationArtifact = latestOrientationArtifact(context);
    const draftArtifact = latestStrategyDraftArtifact(context);
    if (draftArtifact === undefined || (this.sealed && orientationArtifact === undefined)) {
      const missingExactInputs = [
        ...(draftArtifact === undefined ? ["strategy-draft"] : []),
        ...(this.sealed && orientationArtifact === undefined ? ["strategy-orientation"] : []),
      ];
      return {
        event_type: "plan_seal_input_absent",
        payload: { run_id: context.identity.run_id, missing_exact_inputs: missingExactInputs },
        directive: this.terminal(
          context,
          "incomplete",
          false,
          missingExactInputs.map((name) => `missing exact input: ${name}`),
          undefined,
          {
            incomplete_reason: "missing_exact_input",
            missing_exact_inputs: missingExactInputs,
          }
        ),
      };
    }
    const inputRefs = exactPlanInputRefs(context);
    const evidenceRefs = uniqueRefs([latestEvidenceArtifact(context)]);
    const request = canonicalPlanRequest(store, context);
    let draft: StrategyDraftV1;
    try {
      draft = parseStrategyDraft(store.readById(draftArtifact.artifact_id), { request }).draft;
    } catch (error) {
      if (!(error instanceof StrategyDraftValidationError)) throw error;
      if (selectedStrategySealFeedbackArtifact(context) !== undefined) {
        return {
          event_type: "plan_seal_repair_exhausted",
          payload: {
            run_id: context.identity.run_id,
            failure_sha256: sha256(canonicalJson(error.issues)),
          },
          directive: this.terminal(
            context,
            "incomplete",
            false,
            [`seal repair exhausted: ${error.failureClass}`],
            undefined,
            {
              incomplete_reason: "seal_repair_exhausted",
              exhausted: true,
              exhaustion_reason: "seal_defect",
            }
          ),
        };
      }
      const feedback = persistStrategySealFeedback({
        context,
        store,
        draftArtifact,
        failure: error,
      });
      if (feedback.added) this.hostFault?.("sealing_strategy:feedback-persistence");
      context.transition("strategizing");
      const next = this.dispatch(context);
      return {
        event_type: "plan_seal_repair_requested",
        payload: {
          run_id: context.identity.run_id,
          rejected_draft_artifact_id: draftArtifact.artifact_id,
          feedback_artifact_id: feedback.artifact.artifact_id,
        },
        directive: next,
      };
    }
    if (!this.sealed) {
      return {
        event_type: "plan_unsealed_draft_validated",
        payload: { run_id: context.identity.run_id, draft_artifact_id: draftArtifact.artifact_id },
        directive: this.terminal(context, "complete", true, []),
      };
    }
    const admissionArtifact = latestEvidenceAdmissionArtifact(context);
    if (orientationArtifact === undefined || admissionArtifact === undefined) {
      throw new Error("sealed StrategyV1 requires exact Piper orientation and evidence admission");
    }
    const sealed = persistSealedStrategy({
      context,
      store,
      requestArtifact,
      orientationArtifact,
      admissionArtifact,
      evidenceRefs,
      inputRefs,
      draftArtifact,
      draft,
    });
    if (sealed.added) this.hostFault?.("sealing_strategy:artifact-persistence");
    context.transition("verifying_strategy");
    const next = this.dispatch(context);
    return {
      event_type: "plan_strategy_sealed",
      payload: {
        run_id: context.identity.run_id,
        draft_artifact_id: draftArtifact.artifact_id,
        strategy_artifact_id: sealed.artifact.artifact_id,
      },
      directive: next,
    };
  }

  private terminal(
    context: RunContext,
    action: "complete" | "incomplete" | "cancelled",
    met: boolean,
    unresolved: readonly string[],
    liveness?: LivenessSnapshotV1,
    extraResult: Readonly<Record<string, JsonValue>> = {}
  ): Directive {
    const origin = context.stateId;
    const output = met
      ? this.sealed
        ? latestStrategyArtifact(context)
        : latestStrategyDraftArtifact(context)
      : bestPartial(context);
    if (met && output === undefined) throw new Error("positive plan terminal has no product");
    const graph =
      met && this.sealed
        ? this.positiveTerminalArtifacts(context)
        : output === undefined
          ? []
          : [output];
    context.previousState = origin;
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
      result: {
        met,
        output_artifact_ref: output ?? null,
        best_partial_artifact_refs: met || output === undefined ? [] : [output],
        execution_started: false,
        execution_authorized: false,
        ...extraResult,
        ...(liveness === undefined ? {} : { liveness }),
      },
      artifacts: graph,
      unresolved: [...unresolved],
    });
    context.pendingDirective = next;
    context.terminalDirective = next;
    return next;
  }

  private positiveTerminalArtifacts(context: RunContext): ArtifactRef[] {
    const subject = currentReviewSubject(context);
    const validity = latestReviewReceiptArtifact(context, "validity");
    const quality = latestReviewReceiptArtifact(context, "quality");
    const integrity = latestIntegrityArtifact(context);
    const envelope = latestEnvelopeArtifact(context);
    const vera = latestReviewReportArtifact(context, "verifying_strategy");
    const carren = latestReviewReportArtifact(context, "critiquing_strategy");
    if (
      validity === undefined ||
      quality === undefined ||
      integrity === undefined ||
      envelope === undefined ||
      vera === undefined ||
      carren === undefined
    ) {
      throw new Error("positive strategy terminal graph is incomplete");
    }
    return uniqueRefs([
      subject.request_ref,
      subject.analysis_ref,
      subject.admission_ref,
      ...subject.evidence_refs,
      ...subject.imported_input_refs,
      subject.draft_ref,
      subject.product_ref,
      vera,
      carren,
      validity,
      quality,
      integrity,
      envelope,
    ]);
  }
}

function expectedReceiptResult(
  input: Parameters<CompletionReceiptPredicateV1>[0],
  receipt: ReviewReceiptV1
): PhaseResult | undefined {
  const result = input.checkpointer.receiptResultById(receipt.execution_receipt_id);
  return result !== undefined && sha256(canonicalJson(result)) === receipt.execution_result_sha256
    ? result
    : undefined;
}

export function evaluatePlanLatestReviewedStrategyDod(
  input: Parameters<CompletionReceiptPredicateV1>[0]
): ReturnType<CompletionReceiptPredicateV1> {
  try {
    const reader = input.artifactReader;
    if (reader === undefined || input.originState !== "admitting_strategy") {
      return { passed: false, evidence_refs: [] };
    }
    const product = input.context.selectedArtifacts.find(
      (artifact) => artifact.artifact_id === input.latestProduct.product_id
    );
    const orientation = latestOrientationArtifact(input.context);
    const admission = latestEvidenceAdmissionArtifact(input.context);
    const draft = latestStrategyDraftArtifact(input.context);
    const requestRef = admittedPlanRequestArtifact(input.context);
    if (
      product === undefined ||
      orientation === undefined ||
      admission === undefined ||
      draft === undefined ||
      product.kind !== "strategy" ||
      product.content_digest !== input.latestProduct.sha256
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const storedRefs = [
      requestRef,
      orientation,
      admission,
      ...uniqueRefs([latestEvidenceArtifact(input.context)]),
      ...exactPlanInputRefs(input.context),
      draft,
      product,
    ];
    if (
      storedRefs.some((ref) => {
        const stored = reader.refById(ref.artifact_id);
        return stored === undefined || canonicalJson(stored) !== canonicalJson(ref);
      })
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const requestBytes = reader.readById(requestRef.artifact_id).toString("utf8");
    const request = validatePlanRequest(JSON.parse(requestBytes));
    if (canonicalJson(request) !== requestBytes) return { passed: false, evidence_refs: [] };
    const imported = exactPlanInputRefs(input.context);
    const draftBytes = reader.readById(draft.artifact_id);
    const parsedDraft = parseStrategyDraft(draftBytes, { request });
    const strategy = validateCanonicalStrategyBytes(reader.readById(product.artifact_id), product);
    assertStrategyLineage({
      strategy,
      request,
      requestArtifactId: requestRef.artifact_id,
      draftArtifactId: draft.artifact_id,
      draft: parsedDraft.draft,
      draftBytes,
      exactInputArtifactIds: imported.map((ref) => ref.artifact_id),
    });
    const validityRef = latestReviewReceiptArtifact(input.context, "validity");
    const qualityRef = latestReviewReceiptArtifact(input.context, "quality");
    const integrityRef = latestIntegrityArtifact(input.context);
    const envelopeRef = latestEnvelopeArtifact(input.context);
    if (
      validityRef === undefined ||
      qualityRef === undefined ||
      integrityRef === undefined ||
      envelopeRef === undefined
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const validity = readCanonicalJson(reader, validityRef, validateReviewReceipt);
    const quality = readCanonicalJson(reader, qualityRef, validateReviewReceipt);
    const integrity = readCanonicalJson(reader, integrityRef, validateStrategyProductIntegrity);
    const envelope = readCanonicalJson(reader, envelopeRef, validateStrategyProductEnvelope);
    const subject = currentReviewSubject(input.context);
    const admissionValue = assertEvidenceAdmissionExecutionBinding({
      context: input.context,
      reader,
      checkpointer: input.checkpointer,
      admissionRef: subject.admission_ref,
      orientationRef: subject.analysis_ref,
    });
    if (admissionValue.evidence_required && subject.evidence_refs.length !== 1) {
      return { passed: false, evidence_refs: [] };
    }
    const expectedExecutionReceiptIds = exactExecutionReceiptIds({
      context: input.context,
      checkpointer: input.checkpointer,
      artifacts: [
        subject.analysis_ref,
        ...subject.evidence_refs,
        subject.draft_ref,
        validity.review_report_ref,
        quality.review_report_ref,
      ],
    });
    if (
      canonicalJson(validity.subject) !== canonicalJson(subject) ||
      canonicalJson(quality.subject) !== canonicalJson(subject) ||
      canonicalJson(quality.prior_review_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(integrity.request_ref) !== canonicalJson(subject.request_ref) ||
      canonicalJson(integrity.orientation_ref) !== canonicalJson(subject.analysis_ref) ||
      canonicalJson(integrity.admission_ref) !== canonicalJson(subject.admission_ref) ||
      canonicalJson(integrity.evidence_refs) !== canonicalJson(subject.evidence_refs) ||
      canonicalJson(integrity.imported_input_refs) !== canonicalJson(subject.imported_input_refs) ||
      canonicalJson(integrity.draft_ref) !== canonicalJson(subject.draft_ref) ||
      canonicalJson(integrity.strategy_ref) !== canonicalJson(subject.product_ref) ||
      canonicalJson(integrity.vera_report_ref) !== canonicalJson(validity.review_report_ref) ||
      canonicalJson(integrity.carren_report_ref) !== canonicalJson(quality.review_report_ref) ||
      canonicalJson(integrity.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(integrity.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(integrity.execution_receipt_ids) !==
        canonicalJson(expectedExecutionReceiptIds) ||
      envelope.run_id !== input.context.identity.run_id ||
      canonicalJson(envelope.request_ref) !== canonicalJson(subject.request_ref) ||
      canonicalJson(envelope.orientation_ref) !== canonicalJson(subject.analysis_ref) ||
      canonicalJson(envelope.admission_ref) !== canonicalJson(subject.admission_ref) ||
      canonicalJson(envelope.evidence_refs) !== canonicalJson(subject.evidence_refs) ||
      canonicalJson(envelope.imported_input_refs) !== canonicalJson(subject.imported_input_refs) ||
      canonicalJson(envelope.draft_ref) !== canonicalJson(subject.draft_ref) ||
      canonicalJson(envelope.strategy_ref) !== canonicalJson(subject.product_ref) ||
      canonicalJson(envelope.vera_report_ref) !== canonicalJson(validity.review_report_ref) ||
      canonicalJson(envelope.carren_report_ref) !== canonicalJson(quality.review_report_ref) ||
      canonicalJson(envelope.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(envelope.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(envelope.integrity_ref) !== canonicalJson(integrityRef) ||
      expectedReceiptResult(input, validity) === undefined ||
      expectedReceiptResult(input, quality) === undefined ||
      strategy.execution_started !== false ||
      input.terminal.result.execution_started !== false ||
      input.terminal.result.execution_authorized !== false ||
      canonicalJson(input.terminal.result.output_artifact_ref) !== canonicalJson(product) ||
      input.terminal.unresolved.length !== 0
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const expectedRefs = [
      requestRef,
      orientation,
      admission,
      ...subject.evidence_refs,
      ...subject.imported_input_refs,
      draft,
      product,
      validity.review_report_ref,
      quality.review_report_ref,
      validityRef,
      qualityRef,
      integrityRef,
      envelopeRef,
    ];
    const byArtifactId = (left: ArtifactRef, right: ArtifactRef): number =>
      left.artifact_id.localeCompare(right.artifact_id);
    if (
      expectedRefs.some((ref) => {
        const stored = reader.refById(ref.artifact_id);
        return stored === undefined || canonicalJson(stored) !== canonicalJson(ref);
      }) ||
      canonicalJson([...input.terminal.artifacts].sort(byArtifactId)) !==
        canonicalJson([...expectedRefs].sort(byArtifactId))
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const evidence_refs = integrity.execution_receipt_ids.map((receiptId) => {
      const result = input.checkpointer.receiptResultById(receiptId);
      if (result === undefined) throw new Error(`execution receipt '${receiptId}' is absent`);
      return {
        kind: "execution_receipt",
        reference_id: receiptId,
        sha256: sha256(canonicalJson(result)),
      };
    });
    return { passed: true, evidence_refs };
  } catch {
    return { passed: false, evidence_refs: [] };
  }
}

export const PLAN_COMPLETION_RECEIPT_PREDICATES: ReadonlyMap<string, CompletionReceiptPredicateV1> =
  new Map([["plan_latest_reviewed_strategy_dod.v2", evaluatePlanLatestReviewedStrategyDod]]);

function planRegistration(input: {
  readonly name: string;
  readonly contract: SkillContract;
  readonly sealed: boolean;
}): PlaybookRegistrationV1 {
  const phases = input.sealed
    ? new Map([
        [
          "orienting_strategy",
          {
            agent: "piper",
            result_schema_id: "penny.plan.orientation-summary.v1",
            result_schema_version: 1 as const,
            schema: OrientationSummarySchema,
          },
        ],
        [
          "gathering_strategy_evidence",
          {
            agent: "echo",
            result_schema_id: "penny.plan.evidence-summary.v1",
            result_schema_version: 1 as const,
            schema: EvidenceSummarySchema,
          },
        ],
        [
          "strategizing",
          {
            agent: "piper",
            result_schema_id: "penny.plan.strategy-summary.v1",
            result_schema_version: 1 as const,
            schema: StrategySummarySchema,
          },
        ],
        [
          "verifying_strategy",
          {
            agent: "vera",
            result_schema_id: "penny.plan.verification-summary.v1",
            result_schema_version: 1 as const,
            schema: VerificationSummarySchema,
          },
        ],
        [
          "critiquing_strategy",
          {
            agent: "carren",
            result_schema_id: "penny.plan.critique-summary.v1",
            result_schema_version: 1 as const,
            schema: CritiqueSummarySchema,
          },
        ],
      ])
    : new Map([
        [
          "strategizing",
          {
            agent: "piper",
            result_schema_id: "penny.plan.strategy-summary.v1",
            result_schema_version: 1 as const,
            schema: StrategySummarySchema,
            // Evaluation-only ablation: ordinary candidate phases omit allowed_tools.
            allowed_tools: ["artifact_read"],
          },
        ],
      ]);
  return {
    name: input.name,
    contract: input.contract,
    ingress: "skill",
    start_admission: PLAN_START_ADMISSION,
    liveness: {
      resolver_id: "planLivenessPolicy",
      resolve: () => PLAN_LIVENESS_POLICY,
      thinking_policy: "agent_ssot",
    },
    host_states: input.sealed
      ? ["strategy_evidence_gate", "sealing_strategy", "admitting_strategy"]
      : ["sealing_strategy"],
    worker: {
      kind: "catalog-agent",
      workflow_name: input.name,
      guidance: input.contract.guidance,
      guidance_required: true,
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
      phases,
    },
    completionReceiptPredicates: input.sealed ? PLAN_COMPLETION_RECEIPT_PREDICATES : new Map(),
    construct: (options) =>
      new PlanPlaybook(
        input.sealed,
        options.artifactRevisions,
        options.artifactStore,
        options.checkpointer
      ),
  };
}

export const PLAN_CANDIDATE_REGISTRATION = planRegistration({
  name: PLAN_PLAYBOOK_NAME,
  contract: PLAN_SKILL_CONTRACT,
  sealed: true,
});

/** Frozen promotion target only; deliberately absent from PLAYBOOK_REGISTRY. */
export const PLAN_PROSPECTIVE_PRODUCTION_REGISTRATION = planRegistration({
  name: PLAN_PLAYBOOK_NAME,
  contract: PLAN_PROSPECTIVE_PRODUCTION_CONTRACT,
  sealed: true,
});

export const PLAN_UNSEALED_EVALUATION_REGISTRATION = planRegistration({
  name: PLAN_UNSEALED_EVALUATION_NAME,
  contract: PLAN_UNSEALED_EVALUATION_CONTRACT,
  sealed: false,
});

export const PLAN_EVALUATION_ABLATION_REGISTRY: PlaybookRegistryV1 = new Map([
  [PLAN_UNSEALED_EVALUATION_NAME, PLAN_UNSEALED_EVALUATION_REGISTRATION],
]);
