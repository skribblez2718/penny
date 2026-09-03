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
  assertDecisionLineage,
  canonicalizeDecisionRequest,
  decisionDraftPromptContract,
  decisionProductEnvelopeId,
  decisionProductIntegrityId,
  decisionRequestConstraints,
  decisionRequestSha256,
  parsePersistedDecisionDraft,
  sealDecisionDraft,
  validateCanonicalDecisionBytes,
  validateDecisionProductEnvelope,
  validateDecisionProductIntegrity,
  validateDecisionRequest,
  validateDecisionSealFeedback,
  DecisionDraftValidationError,
  type DecisionDraftV2,
  type DecisionProductEnvelopeV1,
  type DecisionProductIntegrityV1,
  type DecisionRequestV1,
  type DecisionSealFeedbackV2,
} from "../skill-contracts/decide.js";
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

export const DECIDE_PLAYBOOK_NAME = "decide";
export const DECIDE_UNSEALED_EVALUATION_NAME = "decide-unsealed";

export const DECIDE_AGENT_BY_STATE = {
  analyzing_decision: "annie",
  gathering_decision_evidence: "echo",
  deciding: "demetri",
  verifying_decision: "vera",
  critiquing_decision: "carren",
} as const;

type DecideWorkerState = keyof typeof DECIDE_AGENT_BY_STATE;
type ReviewState = "verifying_decision" | "critiquing_decision";
type ReviewKind = "validity" | "quality";
type RepairGapKind = "evidence_gap" | "analysis_gap" | "product_gap";
type RepairOwner = "echo" | "annie" | "demetri";

function isDecideWorkerState(value: string): value is DecideWorkerState {
  return Object.hasOwn(DECIDE_AGENT_BY_STATE, value);
}

export const DECIDE_FLOW = {
  states: [
    "intake",
    "analyzing_decision",
    "decision_evidence_gate",
    "gathering_decision_evidence",
    "deciding",
    "sealing_decision",
    "verifying_decision",
    "critiquing_decision",
    "admitting_decision",
    "complete",
    "incomplete",
    "cancelled",
  ],
  edges: [
    ["intake", "analyzing_decision"],
    ["analyzing_decision", "decision_evidence_gate"],
    ["decision_evidence_gate", "gathering_decision_evidence"],
    ["decision_evidence_gate", "deciding"],
    ["gathering_decision_evidence", "deciding"],
    ["deciding", "sealing_decision"],
    ["sealing_decision", "deciding"],
    ["sealing_decision", "verifying_decision"],
    ["verifying_decision", "analyzing_decision"],
    ["verifying_decision", "deciding"],
    ["verifying_decision", "critiquing_decision"],
    ["critiquing_decision", "analyzing_decision"],
    ["critiquing_decision", "deciding"],
    ["critiquing_decision", "admitting_decision"],
    ["admitting_decision", "complete"],
  ],
} as const;

export const DECIDE_LIVENESS_POLICY = {
  schema_version: 1,
  scope: "orchestrated-decide-candidate",
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

const AnalysisSummarySchema = Type.Union([
  Type.Object(
    {
      analysis_complete: Type.Literal(true),
      gap_kind: Type.Literal("none"),
      repair_owner: Type.Literal("none"),
      findings: FindingsSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      analysis_complete: Type.Literal(false),
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
const DecisionSummarySchema = Type.Object(
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
  verificationFailureSchema("analysis_gap", "annie"),
  verificationFailureSchema("product_gap", "demetri"),
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
  critiqueRevisionSchema("analysis_gap", "annie"),
  critiqueRevisionSchema("product_gap", "demetri"),
]);

function repairRoute(
  originState: "analyzing_decision" | ReviewState,
  feedbackKind: RepairGapKind,
  targetState: "decision_evidence_gate" | "analyzing_decision" | "deciding"
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

function decisionContract(input: {
  readonly name: string;
  readonly sealed: boolean;
  readonly releaseStatus: "production" | "candidate";
}): SkillContract {
  return {
    schema_version: 2,
    name: input.name,
    release_status: input.releaseStatus,
    objective:
      "Produce one evidence-grounded decision assessment through separate analysis, decision authorship, host sealing, objective verification, and quality critique without taskification or execution.",
    io: {
      request: {
        schema_version: 1,
        name: "decision_request",
        direction: "input",
        transport: "inline_request",
        schema_id: "penny.decision-request.v1",
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
      ],
      active_output_ports: [
        input.sealed
          ? {
              schema_version: 1,
              name: "decision",
              direction: "output",
              transport: "artifact",
              schema_id: "penny.decision.v2",
              schema_version_required: 2,
              artifact_kind: "semantic-core",
              source: "skill",
              min_items: 1,
              max_items: 1,
              semantic_product: true,
            }
          : {
              schema_version: 1,
              name: "decision_draft",
              direction: "output",
              transport: "artifact",
              schema_id: "penny.decision-draft.v2",
              schema_version_required: 2,
              artifact_kind: "decision-draft",
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
      skill_root: ".pi/skills/decide/assets/prompts",
      resolution: "per_agent_phase",
    },
    budget_policy: {
      schema_version: 1,
      policy_id: "penny.decide-budget.v1",
      resolver_id: "decideLivenessPolicy",
      admission_id: "LivenessController.admitInvocation",
      snapshot_id: "LivenessController.snapshot",
    },
    repair_routing: {
      schema_version: 1,
      routes: input.sealed
        ? [
            repairRoute("analyzing_decision", "evidence_gap", "decision_evidence_gate"),
            repairRoute("verifying_decision", "evidence_gap", "analyzing_decision"),
            repairRoute("verifying_decision", "analysis_gap", "analyzing_decision"),
            repairRoute("verifying_decision", "product_gap", "deciding"),
            repairRoute("critiquing_decision", "evidence_gap", "analyzing_decision"),
            repairRoute("critiquing_decision", "analysis_gap", "analyzing_decision"),
            repairRoute("critiquing_decision", "product_gap", "deciding"),
          ]
        : [],
    },
    completion_gate: input.sealed
      ? {
          schema_version: 2,
          allowed_terminal_origins: ["admitting_decision"],
          required_visited_states: [
            "analyzing_decision",
            "decision_evidence_gate",
            "deciding",
            "sealing_decision",
            "verifying_decision",
            "critiquing_decision",
            "admitting_decision",
          ],
          required_receipt_predicates: ["decide_latest_reviewed_decision_dod.v2"],
          latest_product: {
            selector: "terminal_artifact",
            schema_id: "penny.decision.v2",
            product_schema_version: 2,
            artifact_kind: "semantic-core",
            producing_state: "sealing_decision",
          },
          unresolved_policy: { mode: "max_count", max_count: 0 },
        }
      : {
          schema_version: 2,
          allowed_terminal_origins: ["sealing_decision"],
          required_visited_states: ["deciding", "sealing_decision"],
          required_receipt_predicates: [],
          latest_product: {
            selector: "terminal_artifact",
            schema_id: "penny.decision-draft.v2",
            product_schema_version: 2,
            artifact_kind: "decision-draft",
            producing_state: "deciding",
          },
          unresolved_policy: { mode: "max_count", max_count: 0 },
        },
  };
}

export const DECIDE_SKILL_CONTRACT = decisionContract({
  name: DECIDE_PLAYBOOK_NAME,
  sealed: true,
  releaseStatus: "candidate",
});
export const DECIDE_PROSPECTIVE_PRODUCTION_CONTRACT = decisionContract({
  name: DECIDE_PLAYBOOK_NAME,
  sealed: true,
  releaseStatus: "production",
});
export const DECIDE_UNSEALED_EVALUATION_CONTRACT = decisionContract({
  name: DECIDE_UNSEALED_EVALUATION_NAME,
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
      throw new Error("selected decision artifact metadata diverged");
    }
    return false;
  }
  context.selectedArtifacts.push(structuredClone(artifact));
  return true;
}

function exactPriorSynthesisRefs(context: RunContext): readonly ArtifactRef[] {
  return context.selectedArtifacts
    .filter(
      (artifact) =>
        artifact.kind === "semantic-core" &&
        artifact.content_schema?.schema_id === "penny.grounded-synthesis.v1" &&
        artifact.content_schema.schema_version === 1
    )
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function admittedDecisionRequestArtifact(context: RunContext): ArtifactRef {
  const request = selectedLatest(
    context,
    (artifact) => artifact.kind === "decision-request" && artifact.phase === "intake"
  );
  if (request === undefined) throw new Error("admitted DecisionRequestV1 artifact is absent");
  return request;
}

function latestAnalysisArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "agent-output" && artifact.phase === "analyzing_decision"
  );
}

function latestEvidenceAdmissionArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "evidence-admission" && artifact.phase === "decision_evidence_gate"
  );
}

function latestEvidenceArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "agent-output" && artifact.phase === "gathering_decision_evidence"
  );
}

function latestDecisionDraftArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "decision-draft" && artifact.phase === "deciding"
  );
}

function latestDecisionArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "semantic-core" &&
      artifact.phase === "sealing_decision" &&
      artifact.content_schema?.schema_id === "penny.decision.v2" &&
      artifact.content_schema.schema_version === 2
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

function selectedDecisionSealFeedbackArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "decision-seal-feedback" &&
      artifact.phase === "sealing_decision" &&
      artifact.content_schema?.schema_id === "penny.decision-seal-feedback.v2"
  );
}

function latestIntegrityArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "decision-product-integrity");
}

function latestEnvelopeArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "decision-product-envelope");
}

function uniqueRefs(refs: readonly (ArtifactRef | undefined)[]): ArtifactRef[] {
  return [
    ...new Map(
      refs.flatMap((ref) => (ref === undefined ? [] : [[ref.artifact_id, ref] as const]))
    ).values(),
  ];
}

function canonicalDecisionRequest(
  store: ArtifactHostStore,
  context: RunContext
): DecisionRequestV1 {
  const requestArtifact = admittedDecisionRequestArtifact(context);
  const bytes = store.readById(requestArtifact.artifact_id).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("admitted DecisionRequestV1 artifact is not JSON");
  }
  const request = validateDecisionRequest(parsed);
  if (canonicalJson(request) !== bytes) {
    throw new Error("admitted DecisionRequestV1 artifact is not canonical JSON");
  }
  return request;
}

function persistDecisionRequestArtifact(input: {
  readonly request: DecisionRequestV1;
  readonly runId: string;
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly store?: ArtifactHostStore;
}): ArtifactRef | undefined {
  if (input.store === undefined) return undefined;
  const operationId = `decision-request:${sha256(input.runId).slice(0, 32)}`;
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: "intake",
    branch_id: null,
    kind: "decision-request",
    operation_id: operationId,
    version: 1,
    producer: "host:request-admission",
    media_type: "application/json",
    content_schema: { schema_id: "penny.decision-request.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [...input.upstreamRefs].sort((left, right) =>
      left.artifact_id.localeCompare(right.artifact_id)
    ),
  };
  const content = canonicalJson(validateDecisionRequest(input.request));
  const existing = input.store.refFor(
    input.runId,
    "intake",
    null,
    "decision-request",
    operationId,
    1
  );
  const ref = existing ?? input.store.persist({ metadata, content });
  if (
    input.store.lastVersion(input.runId, "intake", null, "decision-request", operationId) !== 1 ||
    canonicalJson(input.store.metadata(ref)) !== canonicalJson(metadata) ||
    input.store.readById(ref.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("durable decision request artifact diverged");
  }
  const reread = input.store.refById(ref.artifact_id);
  if (reread === undefined || canonicalJson(reread) !== canonicalJson(ref)) {
    throw new Error("durable decision request artifact failed manifest re-read");
  }
  input.store.select(reread);
  return reread;
}

export const DECIDE_START_ADMISSION: StartAdmissionV1 = {
  schema_id: "penny.decision-request.v1",
  schema_version: 1,
  prepare: (request): PreparedStartV1 => {
    const decisionRequest = canonicalizeDecisionRequest({
      goal: request.goal,
      constraints: request.constraints,
    });
    return {
      schema_id: "penny.decision-request.v1",
      schema_version: 1,
      request,
      goal: decisionRequest.decision_question,
      constraints: decisionRequestConstraints(decisionRequest),
      ...(request.input_artifacts === undefined
        ? {}
        : { input_artifacts: request.input_artifacts }),
      admission_data: decisionRequest,
    };
  },
  materialize: (prepared, host) => {
    const request = validateDecisionRequest(prepared.admission_data);
    const upstreamRefs = prepared.input_artifacts?.artifacts.map((binding) => binding.ref) ?? [];
    const requestRef = persistDecisionRequestArtifact({
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
  state: DecideWorkerState,
  upstreamRefs: readonly ArtifactRef[],
  revisions?: ArtifactRevisionLookup
): OutputArtifactMetadata {
  const draft = state === "deciding";
  return buildOutputArtifactMetadata({
    context,
    phase: state,
    agent: DECIDE_AGENT_BY_STATE[state],
    branchId: null,
    upstreamRefs,
    ...(revisions === undefined ? {} : { revisions }),
    ...(draft
      ? {
          artifactKind: "decision-draft",
          mediaType: "text/plain; charset=utf-8",
          contentSchema: { schema_id: "penny.decision-draft.v2", schema_version: 2 },
        }
      : {}),
  });
}

function refsForState(context: RunContext, state: DecideWorkerState): readonly ArtifactRef[] {
  const request = admittedDecisionRequestArtifact(context);
  const inputs = exactPriorSynthesisRefs(context);
  const analysis = latestAnalysisArtifact(context);
  const admission = latestEvidenceAdmissionArtifact(context);
  const evidence = latestEvidenceArtifact(context);
  const draft = latestDecisionDraftArtifact(context);
  const product = latestDecisionArtifact(context);
  const veraReport = latestReviewReportArtifact(context, "verifying_decision");
  const carrenReport = latestReviewReportArtifact(context, "critiquing_decision");
  const validityReceipt = latestReviewReceiptArtifact(context, "validity");
  if (state === "analyzing_decision") {
    return uniqueRefs([request, ...inputs, evidence, analysis, veraReport, carrenReport]);
  }
  if (state === "gathering_decision_evidence") {
    if (analysis === undefined) throw new Error("Echo requires the exact Annie analysis");
    return uniqueRefs([request, ...inputs, analysis, admission, veraReport, carrenReport]);
  }
  if (state === "deciding") {
    if (analysis === undefined && context.identity.playbook !== DECIDE_UNSEALED_EVALUATION_NAME) {
      throw new Error("Demetri requires the exact Annie analysis");
    }
    return uniqueRefs([
      request,
      analysis,
      admission,
      evidence,
      ...inputs,
      draft,
      selectedDecisionSealFeedbackArtifact(context),
      veraReport,
      carrenReport,
    ]);
  }
  if (
    analysis === undefined ||
    admission === undefined ||
    draft === undefined ||
    product === undefined
  ) {
    throw new Error(
      `${state} requires exact analysis, evidence admission, draft, and latest sealed DecisionV2`
    );
  }
  if (state === "verifying_decision") {
    return uniqueRefs([request, analysis, admission, draft, product, evidence, ...inputs]);
  }
  if (veraReport === undefined || validityReceipt === undefined) {
    throw new Error("Carren requires Vera's exact report and host validity receipt");
  }
  return uniqueRefs([
    request,
    analysis,
    admission,
    draft,
    product,
    evidence,
    ...inputs,
    veraReport,
    validityReceipt,
  ]);
}

function slotForRef(ref: ArtifactRef): string {
  if (ref.kind === "decision-request") return "decision-request";
  if (ref.kind === "decision-draft") return "latest-decision-draft";
  if (ref.kind === "decision-seal-feedback") return "decision-seal-feedback";
  if (ref.kind === "review-receipt") return `prior-${ref.branch_id ?? "review"}-receipt`;
  if (ref.kind === "evidence-admission") return "decision-evidence-admission";
  if (ref.phase === "analyzing_decision") return "latest-decision-analysis";
  if (ref.phase === "gathering_decision_evidence") return "latest-decision-evidence";
  if (ref.phase === "verifying_decision") return "latest-vera-report";
  if (ref.phase === "critiquing_decision") return "latest-carren-report";
  if (ref.content_schema?.schema_id === "penny.grounded-synthesis.v1") {
    return "prior-grounded-synthesis";
  }
  if (ref.content_schema?.schema_id === "penny.decision.v2") return "latest-decision";
  return `input-${ref.artifact_id.slice(-12)}`;
}

function taskForState(context: RunContext, state: DecideWorkerState): string {
  const common =
    "artifact_read is mandatory for every needed exact workflow predecessor in input_artifacts; continue through next_range. No other tool or channel may substitute for a missing predecessor ref: never discover predecessor output through memory, /tmp, repository search, historical sessions, or name-only pointers. Other tools in the assigned catalog agent's YAML surface may be used only when materially relevant, permitted by the caller and task, and within this phase's consequence boundary; they must not bypass host-owned evidence admission. The owner captures and re-reads complete bytes; do not claim persistence.";
  switch (state) {
    case "analyzing_decision":
      return [
        common,
        "Analyze only. Map every supplied alternative to every hard constraint, objective, preference, evidence item, and material uncertainty. Do not select, rank, recommend, invent preferences, or execute.",
        "Emit one closed gap decision in SUMMARY. basis_sufficient is analysis_complete=true/gap_kind=none/repair_owner=none. Only a concrete decision-sensitive missing fact whose answer could change feasibility, selection, ranking, or sensitivity may use analysis_complete=false/gap_kind=evidence_gap/repair_owner=echo. Never emit a target state.",
      ].join("\n\n");
    case "gathering_decision_evidence":
      return [
        common,
        "Resolve only the exact host-admitted decision-sensitive gap. When compatible with caller constraints, use narrowly targeted read-only local inspection or web retrieval only for that gap; do not broaden into open-ended research, use memory as evidence acquisition, mutate anything, or execute application business logic. Record a precise source locator for every acquired item (a path plus line/range, or a URL plus relevant section and date), distinguish source-backed findings from inference, and report the gap honestly as unresolved when evidence is unavailable, conflicting, disallowed, or the bounded budget is exhausted. Do not recommend, rank, select, or execute.",
      ].join("\n\n");
    case "deciding":
      return [
        common,
        `MECHANICALLY_PROJECTED_DECISION_DRAFT_CONTRACT:${decisionDraftPromptContract()}`,
        "Read the request directly; analysis/evidence are supporting inputs, not authority. Produce one complete replacement DecisionDraftV2. Request, analysis, evidence-packet, draft, review, receipt, and seal-feedback artifact IDs are transport lineage and are forbidden from basis_ids_used and sensitivity[].basis_ids. Exact admitted GroundedSynthesis IDs may be semantic bases only when their content is actually used. Decide only; do not taskify or execute.",
      ].join("\n\n");
    case "verifying_decision":
      return [
        common,
        "Verify the exact latest sealed DecisionV2 against the exact request, Annie analysis, Demetri draft, optional admitted evidence, and GroundedSynthesis inputs. Check all constraints, feasibility, complete comparison, no invented preference, disposition consistency, evidence fidelity, sensitivity, lineage-relevant source use, and no execution. PASS only when valid.",
        "On FAIL emit exactly one gap_kind and repair_owner: evidence_gap/echo, analysis_gap/annie, or product_gap/demetri. On PASS use none/none. Never emit a target state.",
      ].join("\n\n");
    case "critiquing_decision":
      return [
        common,
        "Critique the exact Vera-passed latest DecisionV2 for balance, clarity, defensibility, uncertainty calibration, decision usefulness, and non-misleading framing. The prior host validity receipt is evidence, not authority to overlook defects.",
        "APPROVE only with no major or critical finding; minor nonblocking findings may remain. NEEDS_REVISION emits exactly one gap_kind and repair_owner: evidence_gap/echo, analysis_gap/annie, or product_gap/demetri. APPROVE uses none/none. Never emit a target state.",
      ].join("\n\n");
  }
}

function persistVersionedHostArtifact(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly phase:
    | "decision_evidence_gate"
    | "sealing_decision"
    | ReviewState
    | "critiquing_decision";
  readonly branchId: string | null;
  readonly kind: string;
  readonly operationLabel: string;
  readonly producer: string;
  readonly contentSchema: { readonly schema_id: string; readonly schema_version: number };
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly content: string | Uint8Array;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const operationId = `decide-${input.operationLabel}:${sha256(input.context.identity.run_id).slice(0, 32)}`;
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

function persistDecisionEvidenceAdmission(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: EvidenceAdmissionV1;
  readonly added: boolean;
} {
  const analysis = latestAnalysisArtifact(input.context);
  if (analysis === undefined) throw new Error("decision evidence gate requires Annie analysis");
  const execution = exactAcceptedExecutionGroup({
    context: input.context,
    checkpointer: input.checkpointer,
    artifact: analysis,
  });
  const gap = execution.routed.details.analysis_complete !== true;
  const body: Omit<EvidenceAdmissionV1, "admission_id"> = {
    schema_id: "penny.evidence-admission.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    domain: "decision",
    origin_state: "analyzing_decision",
    source_artifact_ref: analysis,
    routing_result_sha256: sha256(canonicalJson(execution.routed)),
    source_execution_receipt_ids: [...execution.receiptIds],
    classification: gap ? "decision_sensitive_evidence_gap" : "basis_sufficient",
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
    phase: "decision_evidence_gate",
    branchId: null,
    kind: "evidence-admission",
    operationLabel: "evidence-admission",
    producer: "host:evidence-gate",
    contentSchema: { schema_id: "penny.evidence-admission.v1", schema_version: 1 },
    upstreamRefs: [analysis],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function decisionSealFeedbackOperationId(context: RunContext): string {
  return `decision-seal-feedback:${sha256(context.identity.run_id).slice(0, 32)}`;
}

function readDecisionSealFeedback(
  store: ArtifactHostStore,
  artifact: ArtifactRef
): DecisionSealFeedbackV2 {
  const bytes = store.readById(artifact.artifact_id).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("DecisionSealFeedbackV2 artifact is not JSON");
  }
  const feedback = validateDecisionSealFeedback(parsed);
  if (canonicalJson(feedback) !== bytes) {
    throw new Error("DecisionSealFeedbackV2 artifact is not canonical JSON");
  }
  return feedback;
}

function persistDecisionSealFeedback(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly draftArtifact: ArtifactRef;
  readonly failure: DecisionDraftValidationError;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  if (input.failure.failureClass === "LINEAGE_INVALID") {
    throw new Error("DecisionDraftV2 lineage failures are not model-correctable");
  }
  const feedback = validateDecisionSealFeedback({
    schema_id: "penny.decision-seal-feedback.v2",
    schema_version: 2,
    attempt: 1,
    rejected_draft_artifact_id: input.draftArtifact.artifact_id,
    failure_class: input.failure.failureClass,
    issues: input.failure.issues,
  });
  const operationId = decisionSealFeedbackOperationId(input.context);
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: "sealing_decision",
    branch_id: null,
    kind: "decision-seal-feedback",
    operation_id: operationId,
    version: 1,
    producer: "host:decision-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.decision-seal-feedback.v2", schema_version: 2 },
    parent_ref: null,
    upstream_refs: [input.draftArtifact],
  };
  const existing = input.store.refFor(
    input.context.identity.run_id,
    "sealing_decision",
    null,
    "decision-seal-feedback",
    operationId,
    1
  );
  const content = canonicalJson(feedback);
  const artifact = existing ?? input.store.persist({ metadata, content });
  if (
    canonicalJson(input.store.metadata(artifact)) !== canonicalJson(metadata) ||
    input.store.readById(artifact.artifact_id).toString("utf8") !== content ||
    canonicalJson(readDecisionSealFeedback(input.store, artifact)) !== canonicalJson(feedback)
  ) {
    throw new Error("DecisionSealFeedbackV2 deterministic persistence diverged");
  }
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined) throw new Error("DecisionSealFeedbackV2 manifest re-read failed");
  input.store.select(reread);
  return { artifact: reread, added: addSelectedArtifact(input.context, reread) };
}

function persistSealedDecision(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly requestArtifact: ArtifactRef;
  readonly analysisArtifact: ArtifactRef;
  readonly admissionArtifact: ArtifactRef;
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly inputRefs: readonly ArtifactRef[];
  readonly draftArtifact: ArtifactRef;
  readonly draft: DecisionDraftV2;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const request = canonicalDecisionRequest(input.store, input.context);
  const decision = sealDecisionDraft({
    request,
    draft: input.draft,
    requestSha256: decisionRequestSha256(request),
    sourceRequestArtifactId: input.requestArtifact.artifact_id,
    sourceDraftArtifactId: input.draftArtifact.artifact_id,
    exactInputArtifactIds: input.inputRefs.map((artifact) => artifact.artifact_id),
  });
  const content = canonicalJson(decision);
  const operationId = `sealed-decision:${sha256(input.context.identity.run_id).slice(0, 32)}`;
  const parent = latestDecisionArtifact(input.context);
  const storedVersion = input.store.lastVersion(
    input.context.identity.run_id,
    "sealing_decision",
    null,
    "semantic-core",
    operationId
  );
  const upstreamRefs = [
    input.requestArtifact,
    input.analysisArtifact,
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
          "sealing_decision",
          null,
          "semantic-core",
          operationId,
          storedVersion
        );
  if (
    interrupted !== null &&
    input.store.readById(interrupted.artifact_id).toString("utf8") === content &&
    canonicalJson(input.store.metadata(interrupted).upstream_refs) === canonicalJson(upstreamRefs)
  ) {
    input.store.select(interrupted);
    validateCanonicalDecisionBytes(input.store.readById(interrupted.artifact_id), interrupted);
    return { artifact: interrupted, added: addSelectedArtifact(input.context, interrupted) };
  }
  const version = Math.max(parent?.version ?? 0, storedVersion) + 1;
  const parentRef =
    version === 1
      ? null
      : input.store.refFor(
          input.context.identity.run_id,
          "sealing_decision",
          null,
          "semantic-core",
          operationId,
          version - 1
        );
  if (version > 1 && parentRef === null) {
    throw new Error("DecisionV2 revision chain is missing its preceding product");
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: "sealing_decision",
    branch_id: null,
    kind: "semantic-core",
    operation_id: operationId,
    version,
    producer: "host:decision-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.decision.v2", schema_version: 2 },
    parent_ref: parentRef,
    upstream_refs: upstreamRefs,
  };
  const orphan = input.store.refFor(
    input.context.identity.run_id,
    "sealing_decision",
    null,
    "semantic-core",
    operationId,
    version
  );
  const artifact = orphan ?? input.store.persist({ metadata, content });
  if (
    canonicalJson(input.store.metadata(artifact)) !== canonicalJson(metadata) ||
    input.store.readById(artifact.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("DecisionV2 host artifact diverged from deterministic sealing");
  }
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined) throw new Error("DecisionV2 host artifact failed manifest re-read");
  input.store.select(reread);
  validateCanonicalDecisionBytes(input.store.readById(reread.artifact_id), reread);
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
      `decision artifact '${input.artifact.artifact_id}' requires exactly one accepted execution group`
    );
  }
  const match = matches[0];
  if (match === undefined) throw new Error("accepted decision execution group is absent");
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
  const request = admittedDecisionRequestArtifact(context);
  const analysis = latestAnalysisArtifact(context);
  const admission = latestEvidenceAdmissionArtifact(context);
  const draft = latestDecisionDraftArtifact(context);
  const product = latestDecisionArtifact(context);
  if (
    analysis === undefined ||
    admission === undefined ||
    draft === undefined ||
    product === undefined
  ) {
    throw new Error("latest decision review subject is incomplete");
  }
  const evidenceRefs = uniqueRefs([latestEvidenceArtifact(context)]);
  const importedInputRefs = [...exactPriorSynthesisRefs(context)];
  return {
    product_ref: product,
    product_schema_id: "penny.decision.v2",
    product_schema_version: 2,
    product_sha256: product.content_digest,
    request_ref: request,
    analysis_ref: analysis,
    admission_ref: admission,
    draft_ref: draft,
    evidence_refs: evidenceRefs,
    imported_input_refs: importedInputRefs,
    admitted_upstream_sha256: reviewSubjectUpstreamSha256({
      request_ref: request,
      analysis_ref: analysis,
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
  const state = input.kind === "validity" ? "verifying_decision" : "critiquing_decision";
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
    throw new Error("decision execution-evidence artifacts must be unique");
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
        `decision artifact '${artifact.artifact_id}' requires exactly one accepted execution-evidence group`
      );
    }
    return matches[0] ?? [];
  });
  const ids = groups.flat();
  if (new Set(ids).size !== ids.length) {
    throw new Error("decision execution receipt IDs must map one-to-one to exact artifacts");
  }
  return ids;
}

function assertEvidenceAdmissionExecutionBinding(input: {
  readonly context: RunContext;
  readonly reader: Pick<ArtifactReader, "readById">;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly admissionRef: ArtifactRef;
  readonly analysisRef: ArtifactRef;
}): EvidenceAdmissionV1 {
  const admission = readCanonicalJson(input.reader, input.admissionRef, validateEvidenceAdmission);
  const execution = exactAcceptedExecutionGroup({
    context: input.context,
    checkpointer: input.checkpointer,
    artifact: input.analysisRef,
  });
  if (
    canonicalJson(admission.source_artifact_ref) !== canonicalJson(input.analysisRef) ||
    admission.routing_result_sha256 !== sha256(canonicalJson(execution.routed)) ||
    canonicalJson(admission.source_execution_receipt_ids) !== canonicalJson(execution.receiptIds)
  ) {
    throw new Error("decision evidence admission does not bind the exact accepted analysis result");
  }
  return admission;
}

function ensureProductIntegrity(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: DecisionProductIntegrityV1;
  readonly added: boolean;
} {
  const subject = currentReviewSubject(input.context);
  assertEvidenceAdmissionExecutionBinding({
    context: input.context,
    reader: input.store,
    checkpointer: input.checkpointer,
    admissionRef: subject.admission_ref,
    analysisRef: subject.analysis_ref,
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
    throw new Error("decision product integrity requires current validity and quality receipts");
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
    throw new Error("decision product integrity lacks exact signed worker execution evidence");
  }
  validateCanonicalDecisionBytes(
    input.store.readById(subject.product_ref.artifact_id),
    subject.product_ref
  );
  const body: Omit<DecisionProductIntegrityV1, "integrity_id"> = {
    schema_id: "penny.decision-product-integrity.v1",
    schema_version: 1,
    status: "PASS",
    request_ref: subject.request_ref,
    analysis_ref: subject.analysis_ref,
    admission_ref: subject.admission_ref,
    evidence_refs: subject.evidence_refs,
    imported_input_refs: subject.imported_input_refs,
    draft_ref: subject.draft_ref,
    decision_ref: subject.product_ref,
    vera_report_ref: validity.receipt.review_report_ref,
    carren_report_ref: quality.receipt.review_report_ref,
    validity_receipt_ref: validity.artifact,
    quality_receipt_ref: quality.artifact,
    execution_receipt_ids: executionReceiptIds,
    checks: [
      "canonical_decision",
      "exact_lineage",
      "signed_worker_evidence",
      "latest_validity_receipt",
      "latest_quality_receipt",
      "no_execution",
    ],
    execution_started: false,
    execution_authorized: false,
  };
  const value = validateDecisionProductIntegrity({
    ...body,
    integrity_id: decisionProductIntegrityId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "critiquing_decision",
    branchId: "integrity",
    kind: "decision-product-integrity",
    operationLabel: "product-integrity",
    producer: "host:product-validator",
    contentSchema: { schema_id: "penny.decision-product-integrity.v1", schema_version: 1 },
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
  readonly value: DecisionProductEnvelopeV1;
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
    throw new Error("decision product envelope requires current review receipts");
  }
  const body: Omit<DecisionProductEnvelopeV1, "envelope_id"> = {
    schema_id: "penny.decision-product-envelope.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    status: "complete",
    decision_ref: subject.product_ref,
    request_ref: subject.request_ref,
    analysis_ref: subject.analysis_ref,
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
  const value = validateDecisionProductEnvelope({
    ...body,
    envelope_id: decisionProductEnvelopeId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "critiquing_decision",
    branchId: null,
    kind: "decision-product-envelope",
    operationLabel: "product-envelope",
    producer: "host:product-validator",
    contentSchema: { schema_id: "penny.decision-product-envelope.v1", schema_version: 1 },
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
  if (kind === "analysis_gap") return "annie";
  return "demetri";
}

function reviewEvaluation(
  state: ReviewState,
  details: Record<string, JsonValue>
): EvaluationResultV2 | null {
  const verdict = details.verdict;
  const rawKind = details.gap_kind;
  const rawOwner = details.repair_owner;
  const findings =
    state === "critiquing_decision" && Array.isArray(details.findings)
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
    state === "critiquing_decision" &&
    verdict === "APPROVE" &&
    Array.isArray(details.findings) &&
    details.findings.some(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        !Array.isArray(finding) &&
        (finding.severity === "major" || finding.severity === "critical")
    );
  const accepted = state === "verifying_decision" ? verdict === "PASS" : verdict === "APPROVE";
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
  const owner = majorOnApprove ? "demetri" : rawOwner;
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
    latestDecisionArtifact(context) ??
    latestDecisionDraftArtifact(context) ??
    latestAnalysisArtifact(context)
  );
}

export class DecidePlaybook
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
      context.identity.playbook !== DECIDE_PLAYBOOK_NAME &&
      context.identity.playbook !== DECIDE_UNSEALED_EVALUATION_NAME
    ) {
      throw new Error(`DecidePlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    context.transition(this.sealed ? "analyzing_decision" : "deciding");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    if (!Object.hasOwn(DECIDE_AGENT_BY_STATE, context.stateId)) {
      throw new Error(`cannot dispatch decide state '${context.stateId}'`);
    }
    const state: DecideWorkerState =
      context.stateId === "analyzing_decision" ||
      context.stateId === "gathering_decision_evidence" ||
      context.stateId === "deciding" ||
      context.stateId === "verifying_decision" ||
      context.stateId === "critiquing_decision"
        ? context.stateId
        : (() => {
            throw new Error(`unknown decide state '${context.stateId}'`);
          })();
    const refs = refsForState(context, state);
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: state,
      agent: DECIDE_AGENT_BY_STATE[state],
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      task: taskForState(context, state),
      input_artifacts: {
        schema_version: 2,
        artifacts: refs.map((ref) => ({ slot: slotForRef(ref), ref })),
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
    if (state === "analyzing_decision") {
      if (details.analysis_complete === true) {
        if (details.gap_kind !== "none" || details.repair_owner !== "none") {
          throw new Error(
            "complete decision analysis must use gap_kind=none and repair_owner=none"
          );
        }
        return null;
      }
      if (details.gap_kind !== "evidence_gap" || details.repair_owner !== "echo") {
        throw new Error("incomplete decision analysis requires evidence_gap owned by echo");
      }
      return {
        schema_version: 2,
        kind: "evidence_gap",
        detail: "Annie identified one closed decision-sensitive evidence gap",
        findings: Array.isArray(details.findings)
          ? details.findings.filter((finding): finding is string => typeof finding === "string")
          : [],
        strategy_delta:
          typeof details.strategy_delta === "string"
            ? details.strategy_delta
            : "Inspect admitted evidence.",
      };
    }
    if (state === "verifying_decision" || state === "critiquing_decision") {
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
      case "analyzing_decision":
        if (details.analysis_complete !== true) {
          throw new Error("analysis gap reached happy routing without engine-owned repair");
        }
        context.transition("decision_evidence_gate");
        return hostContinuation();
      case "gathering_decision_evidence":
        context.transition("deciding");
        return this.dispatch(context);
      case "deciding":
        if (details.complete !== true) throw new Error("decision draft summary is incomplete");
        context.transition("sealing_decision");
        return hostContinuation();
      case "verifying_decision":
        if (details.verdict !== "PASS") {
          throw new Error("Vera gap reached happy routing without engine-owned repair");
        }
        context.transition("critiquing_decision");
        return hostContinuation();
      case "critiquing_decision":
        if (details.verdict !== "APPROVE") {
          throw new Error("Carren revision reached happy routing without engine-owned repair");
        }
        context.pendingDirective = null;
        return hostContinuation();
      default:
        throw new Error(`unexpected decide summary in state '${context.stateId}'`);
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
    throw new Error("decide has no user-response state; rerun with updated facts instead");
  }

  cancel(context: RunContext, reason: string): Directive {
    return this.terminal(context, "cancelled", false, [reason]);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending?.action !== "invoke_agent") return pending;
    if (pending.execution_purpose === "routing_repair") return pending;
    if (!isDecideWorkerState(pending.state_id)) return pending;
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
      (context.stateId === "decision_evidence_gate" ||
        context.stateId === "sealing_decision" ||
        context.stateId === "admitting_decision" ||
        (context.stateId === "critiquing_decision" && context.pendingDirective === null))
    );
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context)) {
      throw new Error(`decide state '${context.stateId}' has no deterministic host continuation`);
    }
    const store = this.artifactStore;
    const checkpointer = this.checkpointer;
    if (store === undefined || checkpointer === undefined) {
      throw new Error("decide engine host continuation dependencies are unavailable");
    }
    if (context.stateId === "decision_evidence_gate") {
      return this.continueEvidenceGate(context, store, checkpointer);
    }
    if (context.stateId === "sealing_decision") {
      return this.continueSealing(context, store);
    }
    if (context.stateId === "admitting_decision") {
      return {
        event_type: "decide_product_completion_admitted",
        payload: { run_id: context.identity.run_id },
        directive: this.terminal(context, "complete", true, []),
        after_checkpoint_fault: "admitting_decision:completion-admission",
      };
    }
    const subject = currentReviewSubject(context);
    const carren = acceptedReviewEvidence({
      context,
      store,
      checkpointer,
      state: "critiquing_decision",
      verdict: "APPROVE",
      product: subject.product_ref,
    });
    if (carren === undefined) {
      const validity = ensureReviewReceipt({ context, store, checkpointer, kind: "validity" });
      if (validity.added) {
        this.hostFault?.("verifying_decision:receipt-persistence");
        return {
          event_type: "decide_validity_receipt_persisted",
          payload: {
            run_id: context.identity.run_id,
            product_artifact_id: subject.product_ref.artifact_id,
            receipt_artifact_id: validity.artifact.artifact_id,
          },
        };
      }
      const next = this.dispatch(context);
      return {
        event_type: "decide_quality_review_dispatched",
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
      this.hostFault?.("critiquing_decision:receipt-persistence");
      return {
        event_type: "decide_quality_receipt_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          receipt_artifact_id: quality.artifact.artifact_id,
        },
      };
    }
    const integrity = ensureProductIntegrity({ context, store, checkpointer });
    if (integrity.added) {
      this.hostFault?.("critiquing_decision:integrity-persistence");
      return {
        event_type: "decide_product_integrity_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          integrity_artifact_id: integrity.artifact.artifact_id,
        },
      };
    }
    const envelope = ensureProductEnvelope({ context, store, integrity: integrity.artifact });
    if (envelope.added) {
      this.hostFault?.("critiquing_decision:envelope-persistence");
      return {
        event_type: "decide_product_envelope_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          envelope_artifact_id: envelope.artifact.artifact_id,
        },
      };
    }
    context.transition("admitting_decision");
    return {
      event_type: "decide_product_completion_candidate",
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
    const admission = persistDecisionEvidenceAdmission({ context, store, checkpointer });
    if (admission.added) {
      this.hostFault?.("decision_evidence_gate:admission-persistence");
      return {
        event_type: "decide_evidence_admission_persisted",
        payload: {
          run_id: context.identity.run_id,
          admission_artifact_id: admission.artifact.artifact_id,
          evidence_required: admission.value.evidence_required,
        },
      };
    }
    const nextState = admission.value.evidence_required
      ? "gathering_decision_evidence"
      : "deciding";
    context.transition(nextState);
    const next = this.dispatch(context);
    return {
      event_type: "decide_evidence_gate_routed",
      payload: {
        run_id: context.identity.run_id,
        admission_artifact_id: admission.artifact.artifact_id,
        next_state: nextState,
      },
      directive: next,
    };
  }

  private continueSealing(context: RunContext, store: ArtifactHostStore): HostContinuationStepV1 {
    const requestArtifact = admittedDecisionRequestArtifact(context);
    const analysisArtifact = latestAnalysisArtifact(context);
    const draftArtifact = latestDecisionDraftArtifact(context);
    if (draftArtifact === undefined || (this.sealed && analysisArtifact === undefined)) {
      const missingExactInputs = [
        ...(draftArtifact === undefined ? ["decision-draft"] : []),
        ...(this.sealed && analysisArtifact === undefined ? ["decision-analysis"] : []),
      ];
      return {
        event_type: "decide_seal_input_absent",
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
    const inputRefs = exactPriorSynthesisRefs(context);
    const evidenceRefs = uniqueRefs([latestEvidenceArtifact(context)]);
    const request = canonicalDecisionRequest(store, context);
    let draft: DecisionDraftV2;
    try {
      draft = parsePersistedDecisionDraft(store.readById(draftArtifact.artifact_id), {
        request,
        exactInputArtifactIds: inputRefs.map((artifact) => artifact.artifact_id),
      }).draft;
    } catch (error) {
      if (!(error instanceof DecisionDraftValidationError)) throw error;
      if (error.failureClass === "LINEAGE_INVALID") {
        return {
          event_type: "decide_seal_nonrepairable_lineage",
          payload: {
            run_id: context.identity.run_id,
            failure_sha256: sha256(canonicalJson(error.issues)),
          },
          directive: this.terminal(
            context,
            "incomplete",
            false,
            ["non-repairable decision lineage defect"],
            undefined,
            {
              incomplete_reason: "non_repairable_lineage_defect",
              failure_class: error.failureClass,
            }
          ),
        };
      }
      if (selectedDecisionSealFeedbackArtifact(context) !== undefined) {
        return {
          event_type: "decide_seal_repair_exhausted",
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
      const feedback = persistDecisionSealFeedback({
        context,
        store,
        draftArtifact,
        failure: error,
      });
      if (feedback.added) this.hostFault?.("sealing_decision:feedback-persistence");
      context.transition("deciding");
      const next = this.dispatch(context);
      return {
        event_type: "decide_seal_repair_requested",
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
        event_type: "decide_unsealed_draft_validated",
        payload: { run_id: context.identity.run_id, draft_artifact_id: draftArtifact.artifact_id },
        directive: this.terminal(context, "complete", true, []),
      };
    }
    const admissionArtifact = latestEvidenceAdmissionArtifact(context);
    if (analysisArtifact === undefined || admissionArtifact === undefined) {
      throw new Error("sealed DecisionV2 requires exact Annie analysis and evidence admission");
    }
    const sealed = persistSealedDecision({
      context,
      store,
      requestArtifact,
      analysisArtifact,
      admissionArtifact,
      evidenceRefs,
      inputRefs,
      draftArtifact,
      draft,
    });
    if (sealed.added) this.hostFault?.("sealing_decision:artifact-persistence");
    context.transition("verifying_decision");
    const next = this.dispatch(context);
    return {
      event_type: "decide_decision_sealed",
      payload: {
        run_id: context.identity.run_id,
        draft_artifact_id: draftArtifact.artifact_id,
        decision_artifact_id: sealed.artifact.artifact_id,
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
        ? latestDecisionArtifact(context)
        : latestDecisionDraftArtifact(context)
      : bestPartial(context);
    if (met && output === undefined) throw new Error("positive decide terminal has no product");
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
    const vera = latestReviewReportArtifact(context, "verifying_decision");
    const carren = latestReviewReportArtifact(context, "critiquing_decision");
    if (
      validity === undefined ||
      quality === undefined ||
      integrity === undefined ||
      envelope === undefined ||
      vera === undefined ||
      carren === undefined
    ) {
      throw new Error("positive decision terminal graph is incomplete");
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

export function evaluateDecideLatestReviewedDecisionDod(
  input: Parameters<CompletionReceiptPredicateV1>[0]
): ReturnType<CompletionReceiptPredicateV1> {
  try {
    const reader = input.artifactReader;
    if (reader === undefined || input.originState !== "admitting_decision") {
      return { passed: false, evidence_refs: [] };
    }
    const product = input.context.selectedArtifacts.find(
      (artifact) => artifact.artifact_id === input.latestProduct.product_id
    );
    const analysis = latestAnalysisArtifact(input.context);
    const admission = latestEvidenceAdmissionArtifact(input.context);
    const draft = latestDecisionDraftArtifact(input.context);
    const requestRef = admittedDecisionRequestArtifact(input.context);
    if (
      product === undefined ||
      analysis === undefined ||
      admission === undefined ||
      draft === undefined ||
      product.kind !== "semantic-core" ||
      product.content_digest !== input.latestProduct.sha256
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const storedRefs = [
      requestRef,
      analysis,
      admission,
      ...uniqueRefs([latestEvidenceArtifact(input.context)]),
      ...exactPriorSynthesisRefs(input.context),
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
    const request = validateDecisionRequest(JSON.parse(requestBytes));
    if (canonicalJson(request) !== requestBytes) return { passed: false, evidence_refs: [] };
    const imported = exactPriorSynthesisRefs(input.context);
    const parsedDraft = parsePersistedDecisionDraft(reader.readById(draft.artifact_id), {
      request,
      exactInputArtifactIds: imported.map((ref) => ref.artifact_id),
    });
    const decision = validateCanonicalDecisionBytes(reader.readById(product.artifact_id), product);
    assertDecisionLineage({
      decision,
      request,
      requestArtifactId: requestRef.artifact_id,
      draftArtifactId: draft.artifact_id,
      draft: parsedDraft.draft,
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
    const integrity = readCanonicalJson(reader, integrityRef, validateDecisionProductIntegrity);
    const envelope = readCanonicalJson(reader, envelopeRef, validateDecisionProductEnvelope);
    const subject = currentReviewSubject(input.context);
    const admissionValue = assertEvidenceAdmissionExecutionBinding({
      context: input.context,
      reader,
      checkpointer: input.checkpointer,
      admissionRef: subject.admission_ref,
      analysisRef: subject.analysis_ref,
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
      canonicalJson(integrity.analysis_ref) !== canonicalJson(subject.analysis_ref) ||
      canonicalJson(integrity.admission_ref) !== canonicalJson(subject.admission_ref) ||
      canonicalJson(integrity.evidence_refs) !== canonicalJson(subject.evidence_refs) ||
      canonicalJson(integrity.imported_input_refs) !== canonicalJson(subject.imported_input_refs) ||
      canonicalJson(integrity.draft_ref) !== canonicalJson(subject.draft_ref) ||
      canonicalJson(integrity.decision_ref) !== canonicalJson(subject.product_ref) ||
      canonicalJson(integrity.vera_report_ref) !== canonicalJson(validity.review_report_ref) ||
      canonicalJson(integrity.carren_report_ref) !== canonicalJson(quality.review_report_ref) ||
      canonicalJson(integrity.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(integrity.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(integrity.execution_receipt_ids) !==
        canonicalJson(expectedExecutionReceiptIds) ||
      envelope.run_id !== input.context.identity.run_id ||
      canonicalJson(envelope.request_ref) !== canonicalJson(subject.request_ref) ||
      canonicalJson(envelope.analysis_ref) !== canonicalJson(subject.analysis_ref) ||
      canonicalJson(envelope.admission_ref) !== canonicalJson(subject.admission_ref) ||
      canonicalJson(envelope.evidence_refs) !== canonicalJson(subject.evidence_refs) ||
      canonicalJson(envelope.imported_input_refs) !== canonicalJson(subject.imported_input_refs) ||
      canonicalJson(envelope.draft_ref) !== canonicalJson(subject.draft_ref) ||
      canonicalJson(envelope.decision_ref) !== canonicalJson(subject.product_ref) ||
      canonicalJson(envelope.vera_report_ref) !== canonicalJson(validity.review_report_ref) ||
      canonicalJson(envelope.carren_report_ref) !== canonicalJson(quality.review_report_ref) ||
      canonicalJson(envelope.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(envelope.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(envelope.integrity_ref) !== canonicalJson(integrityRef) ||
      expectedReceiptResult(input, validity) === undefined ||
      expectedReceiptResult(input, quality) === undefined ||
      decision.execution_started !== false ||
      input.terminal.result.execution_started !== false ||
      input.terminal.result.execution_authorized !== false ||
      canonicalJson(input.terminal.result.output_artifact_ref) !== canonicalJson(product) ||
      input.terminal.unresolved.length !== 0
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const expectedRefs = [
      requestRef,
      analysis,
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

export const DECIDE_COMPLETION_RECEIPT_PREDICATES: ReadonlyMap<
  string,
  CompletionReceiptPredicateV1
> = new Map([["decide_latest_reviewed_decision_dod.v2", evaluateDecideLatestReviewedDecisionDod]]);

function decideRegistration(input: {
  readonly name: string;
  readonly contract: SkillContract;
  readonly sealed: boolean;
}): PlaybookRegistrationV1 {
  const phases = input.sealed
    ? new Map([
        [
          "analyzing_decision",
          {
            agent: "annie",
            result_schema_id: "penny.decide.analysis-summary.v1",
            result_schema_version: 1 as const,
            schema: AnalysisSummarySchema,
          },
        ],
        [
          "gathering_decision_evidence",
          {
            agent: "echo",
            result_schema_id: "penny.decide.evidence-summary.v1",
            result_schema_version: 1 as const,
            schema: EvidenceSummarySchema,
          },
        ],
        [
          "deciding",
          {
            agent: "demetri",
            result_schema_id: "penny.decide.decision-summary.v2",
            result_schema_version: 1 as const,
            schema: DecisionSummarySchema,
          },
        ],
        [
          "verifying_decision",
          {
            agent: "vera",
            result_schema_id: "penny.decide.verification-summary.v1",
            result_schema_version: 1 as const,
            schema: VerificationSummarySchema,
          },
        ],
        [
          "critiquing_decision",
          {
            agent: "carren",
            result_schema_id: "penny.decide.critique-summary.v1",
            result_schema_version: 1 as const,
            schema: CritiqueSummarySchema,
          },
        ],
      ])
    : new Map([
        [
          "deciding",
          {
            agent: "demetri",
            result_schema_id: "penny.decide.decision-summary.v2",
            result_schema_version: 1 as const,
            schema: DecisionSummarySchema,
            // Evaluation-only ablation: ordinary candidate phases omit allowed_tools.
            allowed_tools: ["artifact_read"],
          },
        ],
      ]);
  return {
    name: input.name,
    contract: input.contract,
    ingress: "skill",
    start_admission: DECIDE_START_ADMISSION,
    liveness: {
      resolver_id: "decideLivenessPolicy",
      resolve: () => DECIDE_LIVENESS_POLICY,
      thinking_policy: "agent_ssot",
    },
    host_states: input.sealed
      ? ["decision_evidence_gate", "sealing_decision", "admitting_decision"]
      : ["sealing_decision"],
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
    completionReceiptPredicates: input.sealed ? DECIDE_COMPLETION_RECEIPT_PREDICATES : new Map(),
    construct: (options) =>
      new DecidePlaybook(
        input.sealed,
        options.artifactRevisions,
        options.artifactStore,
        options.checkpointer
      ),
  };
}

export const DECIDE_CANDIDATE_REGISTRATION = decideRegistration({
  name: DECIDE_PLAYBOOK_NAME,
  contract: DECIDE_SKILL_CONTRACT,
  sealed: true,
});

/** Frozen promotion target only; deliberately absent from PLAYBOOK_REGISTRY. */
export const DECIDE_PROSPECTIVE_PRODUCTION_REGISTRATION = decideRegistration({
  name: DECIDE_PLAYBOOK_NAME,
  contract: DECIDE_PROSPECTIVE_PRODUCTION_CONTRACT,
  sealed: true,
});

export const DECIDE_UNSEALED_EVALUATION_REGISTRATION = decideRegistration({
  name: DECIDE_UNSEALED_EVALUATION_NAME,
  contract: DECIDE_UNSEALED_EVALUATION_CONTRACT,
  sealed: false,
});

export const DECIDE_EVALUATION_ABLATION_REGISTRY: PlaybookRegistryV1 = new Map([
  [DECIDE_UNSEALED_EVALUATION_NAME, DECIDE_UNSEALED_EVALUATION_REGISTRATION],
]);
