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
  AssessmentDraftValidationError,
  assertAssessmentLineage,
  assessmentDraftPromptContract,
  assessmentProductEnvelopeId,
  assessmentProductIntegrityId,
  assessmentRequestConstraints,
  assessmentValidityReceiptId,
  canonicalizeAssessmentRequest,
  parsePersistedAssessmentDraft,
  sealAssessmentDraft,
  validateAssessmentProductEnvelope,
  validateAssessmentProductIntegrity,
  validateAssessmentRequest,
  validateAssessmentSealFeedback,
  validateAssessmentValidityReceipt,
  validateCanonicalAssessmentBytes,
  type AssessmentDraftV1,
  type AssessmentProductEnvelopeV1,
  type AssessmentProductIntegrityV1,
  type AssessmentRequestV1,
  type AssessmentValidityReceiptV1,
} from "../skill-contracts/assess.js";
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
import type { PlaybookRegistrationV1, PreparedStartV1, StartAdmissionV1 } from "./registry.js";

export const ASSESS_PLAYBOOK_NAME = "assess";

export const ASSESS_AGENT_BY_STATE = {
  analyzing_assessment: "annie",
  authoring_assessment: "carren",
  verifying_assessment: "vera",
} as const;

type AssessWorkerState = keyof typeof ASSESS_AGENT_BY_STATE;
type AssessRepairGapKind = "analysis_gap" | "evidence_gap" | "assessment_product_gap";
type AssessRepairOwner = "annie" | "carren";

function isAssessWorkerState(value: string): value is AssessWorkerState {
  return Object.hasOwn(ASSESS_AGENT_BY_STATE, value);
}

export const ASSESS_FLOW = {
  states: [
    "intake",
    "analyzing_assessment",
    "authoring_assessment",
    "sealing_assessment",
    "verifying_assessment",
    "admitting_assessment",
    "complete",
    "incomplete",
    "cancelled",
  ],
  edges: [
    ["intake", "analyzing_assessment"],
    ["analyzing_assessment", "authoring_assessment"],
    ["authoring_assessment", "sealing_assessment"],
    ["sealing_assessment", "authoring_assessment"],
    ["sealing_assessment", "verifying_assessment"],
    ["verifying_assessment", "analyzing_assessment"],
    ["verifying_assessment", "authoring_assessment"],
    ["verifying_assessment", "admitting_assessment"],
    ["admitting_assessment", "complete"],
  ],
} as const;

export const ASSESS_LIVENESS_POLICY = {
  schema_version: 1,
  scope: "orchestrated-assess-candidate",
  preset: "closed-assessment-no-actions-v1",
  total_phase_repair_invocations: 18,
  model_turns_per_worker: 12,
  model_turns_per_run: 72,
  tool_calls_per_worker: 24,
  tool_calls_per_run: 112,
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
const FindingsSchema = Type.Array(FindingSchema, { maxItems: 32 });
const EvidenceSchema = Type.Array(FindingSchema, { minItems: 1, maxItems: 64 });
const StrategyDeltaSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const StageCompleteSummarySchema = Type.Object(
  { complete: Type.Literal(true) },
  { additionalProperties: false }
);

function verificationFailureSchema(gapKind: AssessRepairGapKind, repairOwner: AssessRepairOwner) {
  return Type.Object(
    {
      verdict: Type.Literal("FAIL"),
      gap_kind: Type.Literal(gapKind),
      repair_owner: Type.Literal(repairOwner),
      findings: Type.Array(FindingSchema, { minItems: 1, maxItems: 32 }),
      evidence: EvidenceSchema,
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
      evidence: EvidenceSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  ),
  verificationFailureSchema("analysis_gap", "annie"),
  verificationFailureSchema("evidence_gap", "annie"),
  verificationFailureSchema("assessment_product_gap", "carren"),
]);

function repairRoute(
  feedbackKind: AssessRepairGapKind,
  targetState: "analyzing_assessment" | "authoring_assessment"
) {
  return {
    schema_version: 1 as const,
    origin_state: "verifying_assessment",
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

export const ASSESS_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: ASSESS_PLAYBOOK_NAME,
  release_status: "candidate",
  objective:
    "Produce one durable evidence-linked non-numeric assessment from a closed inline target, criteria, supplied evidence, constraints, non-goals, and uncertainty through independent analysis, subjective assessment authorship, host sealing, objective validity verification, and deterministic current-product admission without external verification or action execution.",
  io: {
    request: {
      schema_version: 1,
      name: "assessment_request",
      direction: "input",
      transport: "inline_request",
      schema_id: "penny.assessment-request.v1",
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
        name: "assessment",
        direction: "output",
        transport: "artifact",
        schema_id: "penny.assessment.v1",
        schema_version_required: 1,
        artifact_kind: "semantic-core",
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
    skill_root: ".pi/skills/assess/assets/prompts",
    resolution: "per_agent_phase",
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.assess-budget.v1",
    resolver_id: "assessLivenessPolicy",
    admission_id: "LivenessController.admitInvocation",
    snapshot_id: "LivenessController.snapshot",
  },
  repair_routing: {
    schema_version: 1,
    routes: [
      repairRoute("analysis_gap", "analyzing_assessment"),
      repairRoute("evidence_gap", "analyzing_assessment"),
      repairRoute("assessment_product_gap", "authoring_assessment"),
    ],
  },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: ["admitting_assessment"],
    required_visited_states: [
      "analyzing_assessment",
      "authoring_assessment",
      "sealing_assessment",
      "verifying_assessment",
      "admitting_assessment",
    ],
    required_receipt_predicates: ["assess_latest_verified_assessment_dod.v1"],
    latest_product: {
      selector: "terminal_artifact",
      schema_id: "penny.assessment.v1",
      product_schema_version: 1,
      artifact_kind: "semantic-core",
      producing_state: "sealing_assessment",
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

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
      throw new Error("selected assessment artifact metadata diverged");
    }
    return false;
  }
  context.selectedArtifacts.push(structuredClone(artifact));
  return true;
}

function uniqueRefs(refs: readonly (ArtifactRef | undefined)[]): ArtifactRef[] {
  return [
    ...new Map(
      refs.flatMap((ref) => (ref === undefined ? [] : [[ref.artifact_id, ref] as const]))
    ).values(),
  ];
}

function admittedAssessmentRequestArtifact(context: RunContext): ArtifactRef {
  const request = selectedLatest(
    context,
    (artifact) => artifact.kind === "assessment-request" && artifact.phase === "intake"
  );
  if (request === undefined) throw new Error("admitted AssessmentRequestV1 artifact is absent");
  return request;
}

function latestAnalysisArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "agent-output" && artifact.phase === "analyzing_assessment"
  );
}

function latestDraftArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "assessment-draft" && artifact.phase === "authoring_assessment"
  );
}

function latestAssessmentArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "semantic-core" &&
      artifact.phase === "sealing_assessment" &&
      artifact.content_schema?.schema_id === "penny.assessment.v1" &&
      artifact.content_schema.schema_version === 1
  );
}

function latestVeraReportArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "agent-output" && artifact.phase === "verifying_assessment"
  );
}

function latestSealFeedbackArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "assessment-seal-feedback" && artifact.phase === "sealing_assessment"
  );
}

function latestValidityReceiptArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "assessment-validity-receipt" &&
      artifact.phase === "admitting_assessment" &&
      artifact.branch_id === "validity"
  );
}

function latestIntegrityArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "assessment-product-integrity");
}

function latestEnvelopeArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "assessment-product-envelope");
}

function canonicalAssessmentRequest(
  store: Pick<ArtifactReader, "readById">,
  context: RunContext
): AssessmentRequestV1 {
  const artifact = admittedAssessmentRequestArtifact(context);
  const bytes = store.readById(artifact.artifact_id).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("admitted AssessmentRequestV1 artifact is not JSON");
  }
  const request = validateAssessmentRequest(value);
  if (canonicalJson(request) !== bytes) {
    throw new Error("admitted AssessmentRequestV1 artifact is not canonical JSON");
  }
  return request;
}

function persistAssessmentRequestArtifact(input: {
  readonly request: AssessmentRequestV1;
  readonly runId: string;
  readonly store?: ArtifactHostStore;
}): ArtifactRef | undefined {
  const store = input.store;
  if (store === undefined) return undefined;
  const operationId = `assessment-request:${sha256(input.runId).slice(0, 32)}`;
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: "intake",
    branch_id: null,
    kind: "assessment-request",
    operation_id: operationId,
    version: 1,
    producer: "host:request-admission",
    media_type: "application/json",
    content_schema: { schema_id: "penny.assessment-request.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  const content = canonicalJson(validateAssessmentRequest(input.request));
  const existing = store.refFor(input.runId, "intake", null, "assessment-request", operationId, 1);
  const artifact = existing ?? store.persist({ metadata, content });
  if (
    store.lastVersion(input.runId, "intake", null, "assessment-request", operationId) !== 1 ||
    canonicalJson(store.metadata(artifact)) !== canonicalJson(metadata) ||
    store.readById(artifact.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("durable assessment request artifact diverged");
  }
  const reread = store.refById(artifact.artifact_id);
  if (reread === undefined || canonicalJson(reread) !== canonicalJson(artifact)) {
    throw new Error("durable assessment request artifact failed manifest re-read");
  }
  store.select(reread);
  return reread;
}

export const ASSESS_START_ADMISSION: StartAdmissionV1 = {
  schema_id: "penny.assessment-request.v1",
  schema_version: 1,
  prepare: (request): PreparedStartV1 => {
    if (request.input_artifacts !== undefined) {
      throw new Error("Assess V1 accepts a closed inline target and no caller artifact inputs");
    }
    const assessmentRequest = canonicalizeAssessmentRequest({
      goal: request.goal,
      constraints: request.constraints,
    });
    return {
      schema_id: "penny.assessment-request.v1",
      schema_version: 1,
      request,
      goal: assessmentRequest.assessment_purpose,
      constraints: assessmentRequestConstraints(assessmentRequest),
      admission_data: assessmentRequest,
    };
  },
  materialize: (prepared, host) => {
    const request = validateAssessmentRequest(prepared.admission_data);
    const requestRef = persistAssessmentRequestArtifact({
      request,
      runId: host.run_id,
      ...(host.artifactStore === undefined ? {} : { store: host.artifactStore }),
    });
    return requestRef === undefined ? [] : [requestRef];
  },
};

function outputMetadata(
  context: RunContext,
  state: AssessWorkerState,
  upstreamRefs: readonly ArtifactRef[],
  revisions?: ArtifactRevisionLookup
): OutputArtifactMetadata {
  const specialized =
    state === "authoring_assessment"
      ? {
          artifactKind: "assessment-draft",
          mediaType: "text/plain; charset=utf-8",
          contentSchema: { schema_id: "penny.assessment-draft.v1", schema_version: 1 },
        }
      : {};
  return buildOutputArtifactMetadata({
    context,
    phase: state,
    agent: ASSESS_AGENT_BY_STATE[state],
    branchId: null,
    upstreamRefs,
    ...(revisions === undefined ? {} : { revisions }),
    ...specialized,
  });
}

function refsForState(context: RunContext, state: AssessWorkerState): readonly ArtifactRef[] {
  const request = admittedAssessmentRequestArtifact(context);
  const analysis = latestAnalysisArtifact(context);
  const draft = latestDraftArtifact(context);
  const assessment = latestAssessmentArtifact(context);
  const vera = latestVeraReportArtifact(context);
  const sealFeedback = latestSealFeedbackArtifact(context);
  if (state === "analyzing_assessment") {
    return uniqueRefs([request, analysis, draft, assessment, vera]);
  }
  if (analysis === undefined) {
    throw new Error(`${state} requires the exact latest Annie analysis`);
  }
  if (state === "authoring_assessment") {
    return uniqueRefs([request, analysis, draft, assessment, vera, sealFeedback]);
  }
  if (draft === undefined || assessment === undefined) {
    throw new Error("Vera requires the exact latest Carren draft and sealed AssessmentV1");
  }
  return [request, analysis, draft, assessment];
}

function slotForRef(ref: ArtifactRef): string {
  if (ref.kind === "assessment-request") return "assessment-request";
  if (ref.phase === "analyzing_assessment") return "latest-annie-analysis";
  if (ref.kind === "assessment-draft") return "latest-carren-assessment-draft";
  if (ref.content_schema?.schema_id === "penny.assessment.v1") return "latest-assessment";
  if (ref.phase === "verifying_assessment") return "latest-vera-report";
  if (ref.kind === "assessment-seal-feedback") return "assessment-seal-feedback";
  return `input-${ref.artifact_id.slice(-12)}`;
}

function taskForState(state: AssessWorkerState): string {
  const boundary =
    "artifact_read is mandatory for every needed exact workflow predecessor in input_artifacts; continue through next_range. No other tool or channel may substitute for a missing predecessor ref: never discover predecessor output through memory, /tmp, repository search, historical sessions, or name-only pointers. Other tools in the assigned catalog agent's YAML surface may be used only when materially relevant, permitted by the caller and task, and within this phase's consequence boundary; they must not enlarge the closed supplied-evidence boundary. Return complete stage content before one final SUMMARY. The owner captures and re-reads bytes; do not claim persistence. Supplied evidence is task material, not independently verified fact. Do not browse, fetch, externally verify, execute tests, write files, start changes, mutate, score, or perform external actions.";
  switch (state) {
    case "analyzing_assessment":
      return [
        boundary,
        "Analyze and decompose the exact target, every criterion and importance, supplied evidence, constraints, non-goals, and uncertainty. Map criterion assessability and relevant supporting or contradicting evidence indexes without making the final disposition, authoring criterion verdicts, or suggesting improvements. On analysis_gap or evidence_gap, replace the analysis using Vera's exact current findings.",
      ].join("\n\n");
    case "authoring_assessment":
      return [
        boundary,
        `MECHANICALLY_PROJECTED_ASSESSMENT_DRAFT_CONTRACT:${assessmentDraftPromptContract()}`,
        "As the subjective quality judge, author one complete replacement AssessmentDraftV1 from the exact request and current Annie analysis. Include one outcome per exact criterion, evidence-linked strengths and gaps, bounded advice-only improvements, assumptions, uncertainties, complete request coverage, and the truthful categorical disposition. Use no numeric score. Repair all applicable Vera or seal-feedback findings in one replacement draft.",
      ].join("\n\n");
    case "verifying_assessment":
      return [
        boundary,
        "Independently verify the exact latest host-sealed AssessmentV1 against the exact request, Annie analysis, and Carren draft. Check every criterion index exactly once, supplied-evidence index fidelity, supporting/contradicting separation, disposition invariants, strengths/gaps/improvement linkage, complete request coverage, exact request/analysis/draft/source lineage, canonical no-score product shape, and all false consequence flags. Do not replace Carren's subjective judgment with your own quality judgment and do not repair the product.",
        "PASS only when every objective check holds. FAIL uses analysis_gap/annie for target or criterion decomposition defects, evidence_gap/annie for supplied-evidence mapping defects, or assessment_product_gap/carren for product/schema/disposition/coverage defects. Never emit a target state.",
      ].join("\n\n");
  }
}

function persistVersionedHostArtifact(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly phase: "sealing_assessment" | "admitting_assessment";
  readonly branchId: string | null;
  readonly kind: string;
  readonly operationLabel: string;
  readonly producer: string;
  readonly contentSchema: { readonly schema_id: string; readonly schema_version: number };
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly content: string | Uint8Array;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const operationId = `assess-${input.operationLabel}:${sha256(input.context.identity.run_id).slice(0, 32)}`;
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
  if (
    parent !== undefined &&
    parent.content_digest === sha256(bytes) &&
    canonicalJson(input.store.metadata(parent).upstream_refs) === canonicalJson(input.upstreamRefs)
  ) {
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

function persistSealFeedback(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly draft: ArtifactRef;
  readonly failure: AssessmentDraftValidationError;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  if (input.failure.failureClass === "LINEAGE_INVALID") {
    throw new Error("Assessment draft lineage failures are not model-correctable");
  }
  const feedback = validateAssessmentSealFeedback({
    schema_id: "penny.assessment-seal-feedback.v1",
    schema_version: 1,
    attempt: 1,
    rejected_draft_artifact_id: input.draft.artifact_id,
    failure_class: input.failure.failureClass,
    issues: input.failure.issues,
  });
  const operationId = `assessment-seal-feedback:${sha256(input.context.identity.run_id).slice(0, 32)}`;
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: "sealing_assessment",
    branch_id: null,
    kind: "assessment-seal-feedback",
    operation_id: operationId,
    version: 1,
    producer: "host:assessment-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.assessment-seal-feedback.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [input.draft],
  };
  const content = canonicalJson(feedback);
  const existing = input.store.refFor(
    input.context.identity.run_id,
    "sealing_assessment",
    null,
    "assessment-seal-feedback",
    operationId,
    1
  );
  const artifact = existing ?? input.store.persist({ metadata, content });
  if (
    canonicalJson(input.store.metadata(artifact)) !== canonicalJson(metadata) ||
    input.store.readById(artifact.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("AssessmentSealFeedbackV1 deterministic persistence diverged");
  }
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined) throw new Error("AssessmentSealFeedbackV1 manifest re-read failed");
  input.store.select(reread);
  return { artifact: reread, added: addSelectedArtifact(input.context, reread) };
}

function persistSealedAssessment(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly request: ArtifactRef;
  readonly analysis: ArtifactRef;
  readonly draft: ArtifactRef;
  readonly draftValue: AssessmentDraftV1;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const assessment = sealAssessmentDraft({
    request: canonicalAssessmentRequest(input.store, input.context),
    draft: input.draftValue,
    requestRef: input.request,
    analysisRef: input.analysis,
    draftRef: input.draft,
  });
  const content = canonicalJson(assessment);
  const upstreamRefs = [input.request, input.analysis, input.draft];
  const operationId = `sealed-assessment:${sha256(input.context.identity.run_id).slice(0, 32)}`;
  const parent = latestAssessmentArtifact(input.context);
  const storedVersion = input.store.lastVersion(
    input.context.identity.run_id,
    "sealing_assessment",
    null,
    "semantic-core",
    operationId
  );
  const interrupted =
    storedVersion === 0
      ? null
      : input.store.refFor(
          input.context.identity.run_id,
          "sealing_assessment",
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
    validateCanonicalAssessmentBytes(input.store.readById(interrupted.artifact_id), interrupted);
    return { artifact: interrupted, added: addSelectedArtifact(input.context, interrupted) };
  }
  const version = Math.max(parent?.version ?? 0, storedVersion) + 1;
  const parentRef =
    version === 1
      ? null
      : input.store.refFor(
          input.context.identity.run_id,
          "sealing_assessment",
          null,
          "semantic-core",
          operationId,
          version - 1
        );
  if (version > 1 && parentRef === null) {
    throw new Error("AssessmentV1 revision chain is missing its preceding product");
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: "sealing_assessment",
    branch_id: null,
    kind: "semantic-core",
    operation_id: operationId,
    version,
    producer: "host:assessment-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.assessment.v1", schema_version: 1 },
    parent_ref: parentRef,
    upstream_refs: upstreamRefs,
  };
  const orphan = input.store.refFor(
    input.context.identity.run_id,
    "sealing_assessment",
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
    throw new Error("AssessmentV1 diverged from deterministic host sealing");
  }
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined) throw new Error("AssessmentV1 failed manifest re-read");
  input.store.select(reread);
  validateCanonicalAssessmentBytes(input.store.readById(reread.artifact_id), reread);
  return { artifact: reread, added: addSelectedArtifact(input.context, reread) };
}

function eventString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One accepted artifact maps to one event-type-scoped execution group. */
function exactAcceptedExecutionGroup(input: {
  readonly context: RunContext;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly artifact: ArtifactRef;
}): { readonly routed: PhaseResult; readonly receiptIds: readonly string[] } {
  const expectedAgent = input.artifact.producer.startsWith("agent:")
    ? input.artifact.producer.slice("agent:".length)
    : undefined;
  if (expectedAgent === undefined || expectedAgent.length === 0) {
    throw new Error(`assessment artifact '${input.artifact.artifact_id}' has no agent producer`);
  }
  const matches: Array<{ routed: PhaseResult; receiptIds: readonly string[] }> = [];
  for (const event of input.checkpointer.events(input.context.identity.run_id)) {
    if (event.eventType === "phase_result_accepted") {
      const acceptedId = eventString(event.payload.receipt_id);
      const result =
        acceptedId === undefined ? undefined : input.checkpointer.receiptResultById(acceptedId);
      if (
        acceptedId !== undefined &&
        result !== undefined &&
        result.run_id === input.context.identity.run_id &&
        result.state_id === input.artifact.phase &&
        result.agent === expectedAgent &&
        (result.branch_id ?? null) === input.artifact.branch_id &&
        result.worker_receipt.receipt_id === acceptedId &&
        canonicalJson(result.output_artifact) === canonicalJson(input.artifact)
      ) {
        matches.push({ routed: result, receiptIds: [acceptedId] });
      }
    }
    if (event.eventType === "routing_repair_accepted") {
      const sourceId = eventString(event.payload.source_receipt_id);
      const repairId = eventString(event.payload.repair_receipt_id);
      const source =
        sourceId === undefined ? undefined : input.checkpointer.receiptResultById(sourceId);
      const repair =
        repairId === undefined ? undefined : input.checkpointer.receiptResultById(repairId);
      if (
        sourceId !== undefined &&
        repairId !== undefined &&
        source !== undefined &&
        repair !== undefined &&
        source.run_id === input.context.identity.run_id &&
        repair.run_id === input.context.identity.run_id &&
        source.state_id === input.artifact.phase &&
        repair.state_id === input.artifact.phase &&
        source.agent === expectedAgent &&
        repair.agent === expectedAgent &&
        (source.branch_id ?? null) === input.artifact.branch_id &&
        (repair.branch_id ?? null) === input.artifact.branch_id &&
        canonicalJson(source.output_artifact) === canonicalJson(input.artifact) &&
        repair.output_artifact.kind === "routing-metadata"
      ) {
        matches.push({ routed: repair, receiptIds: [sourceId, repairId] });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `assessment artifact '${input.artifact.artifact_id}' requires exactly one accepted execution group`
    );
  }
  const match = matches[0];
  if (match === undefined) throw new Error("accepted assessment execution group is absent");
  return match;
}

interface AssessmentSubjectV1 {
  readonly request: ArtifactRef;
  readonly analysis: ArtifactRef;
  readonly draft: ArtifactRef;
  readonly assessment: ArtifactRef;
}

function currentAssessmentSubject(context: RunContext): AssessmentSubjectV1 {
  const request = admittedAssessmentRequestArtifact(context);
  const analysis = latestAnalysisArtifact(context);
  const draft = latestDraftArtifact(context);
  const assessment = latestAssessmentArtifact(context);
  if (analysis === undefined || draft === undefined || assessment === undefined) {
    throw new Error("latest assessment subject is incomplete");
  }
  return { request, analysis, draft, assessment };
}

function subjectRefs(subject: AssessmentSubjectV1): readonly ArtifactRef[] {
  return [subject.request, subject.analysis, subject.draft, subject.assessment];
}

function acceptedVerificationEvidence(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly subject: AssessmentSubjectV1;
}):
  | {
      readonly report: ArtifactRef;
      readonly result: PhaseResult;
      readonly receiptIds: readonly string[];
    }
  | undefined {
  const expectedUpstreams = subjectRefs(input.subject);
  for (const event of [...input.checkpointer.events(input.context.identity.run_id)].reverse()) {
    if (eventString(event.payload.state_id) !== "verifying_assessment") continue;
    let sourceId: string | undefined;
    let repairId: string | undefined;
    if (event.eventType === "phase_result_accepted") {
      sourceId = eventString(event.payload.receipt_id);
    } else if (event.eventType === "routing_repair_accepted") {
      sourceId = eventString(event.payload.source_receipt_id);
      repairId = eventString(event.payload.repair_receipt_id);
    } else {
      continue;
    }
    const source =
      sourceId === undefined ? undefined : input.checkpointer.receiptResultById(sourceId);
    const routed = repairId === undefined ? source : input.checkpointer.receiptResultById(repairId);
    if (
      source === undefined ||
      routed === undefined ||
      source.run_id !== input.context.identity.run_id ||
      routed.run_id !== input.context.identity.run_id ||
      source.state_id !== "verifying_assessment" ||
      source.agent !== "vera" ||
      routed.details.verdict !== "PASS" ||
      canonicalJson(input.store.metadata(source.output_artifact).upstream_refs) !==
        canonicalJson(expectedUpstreams)
    ) {
      continue;
    }
    return {
      report: source.output_artifact,
      result: routed,
      receiptIds:
        repairId === undefined
          ? [source.worker_receipt.receipt_id]
          : [source.worker_receipt.receipt_id, routed.worker_receipt.receipt_id],
    };
  }
  return undefined;
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
  if (canonicalJson(parsed) !== bytes) {
    throw new Error(`artifact '${artifact.artifact_id}' is not canonical`);
  }
  return parsed;
}

function matchingValidityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly subject: AssessmentSubjectV1;
  readonly evidence: {
    readonly report: ArtifactRef;
    readonly result: PhaseResult;
  };
}): { readonly artifact: ArtifactRef; readonly value: AssessmentValidityReceiptV1 } | undefined {
  const artifact = latestValidityReceiptArtifact(input.context);
  if (artifact === undefined) return undefined;
  const value = readCanonicalJson(input.store, artifact, validateAssessmentValidityReceipt);
  return canonicalJson(value.request_ref) === canonicalJson(input.subject.request) &&
    canonicalJson(value.analysis_ref) === canonicalJson(input.subject.analysis) &&
    canonicalJson(value.draft_ref) === canonicalJson(input.subject.draft) &&
    canonicalJson(value.assessment_ref) === canonicalJson(input.subject.assessment) &&
    canonicalJson(value.vera_report_ref) === canonicalJson(input.evidence.report) &&
    value.execution_receipt_id === input.evidence.result.worker_receipt.receipt_id &&
    value.execution_result_sha256 === sha256(canonicalJson(input.evidence.result)) &&
    value.created_at === input.evidence.result.worker_receipt.ended_at
    ? { artifact, value }
    : undefined;
}

function ensureValidityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: AssessmentValidityReceiptV1;
  readonly added: boolean;
} {
  const subject = currentAssessmentSubject(input.context);
  const evidence = acceptedVerificationEvidence({ ...input, subject });
  if (evidence === undefined) throw new Error("latest-product Vera PASS is absent");
  const existing = matchingValidityReceipt({ ...input, subject, evidence });
  if (existing !== undefined) return { ...existing, added: false };
  const body: Omit<AssessmentValidityReceiptV1, "receipt_id"> = {
    schema_id: "penny.assessment-validity-receipt.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    verdict: "PASS",
    reviewer: "vera",
    request_ref: subject.request,
    analysis_ref: subject.analysis,
    draft_ref: subject.draft,
    assessment_ref: subject.assessment,
    vera_report_ref: evidence.report,
    execution_receipt_id: evidence.result.worker_receipt.receipt_id,
    execution_result_sha256: sha256(canonicalJson(evidence.result)),
    created_at: evidence.result.worker_receipt.ended_at,
    external_actions_performed: false,
    filesystem_writes_performed: false,
    tests_executed: false,
    changes_started: false,
    minted_by: "host:assessment-validity-authority",
  };
  const value = validateAssessmentValidityReceipt({
    ...body,
    receipt_id: assessmentValidityReceiptId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_assessment",
    branchId: "validity",
    kind: "assessment-validity-receipt",
    operationLabel: "validity-receipt",
    producer: "host:assessment-validity-authority",
    contentSchema: { schema_id: "penny.assessment-validity-receipt.v1", schema_version: 1 },
    upstreamRefs: [...subjectRefs(subject), evidence.report],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function exactExecutionReceiptIds(input: {
  readonly context: RunContext;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly artifacts: readonly ArtifactRef[];
}): string[] {
  const artifactIds = input.artifacts.map((artifact) => artifact.artifact_id);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error("assessment execution-evidence artifacts must be unique");
  }
  const ids = input.artifacts.flatMap(
    (artifact) => exactAcceptedExecutionGroup({ ...input, artifact }).receiptIds
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error("assessment execution receipt IDs must map one-to-one to exact artifacts");
  }
  return ids;
}

function ensureProductIntegrity(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly validity: {
    readonly artifact: ArtifactRef;
    readonly value: AssessmentValidityReceiptV1;
  };
}): {
  readonly artifact: ArtifactRef;
  readonly value: AssessmentProductIntegrityV1;
  readonly added: boolean;
} {
  const subject = currentAssessmentSubject(input.context);
  const request = canonicalAssessmentRequest(input.store, input.context);
  const draft = parsePersistedAssessmentDraft(input.store.readById(subject.draft.artifact_id), {
    request,
  }).draft;
  const assessment = validateCanonicalAssessmentBytes(
    input.store.readById(subject.assessment.artifact_id),
    subject.assessment
  );
  assertAssessmentLineage({
    assessment,
    request,
    draft,
    requestRef: subject.request,
    analysisRef: subject.analysis,
    draftRef: subject.draft,
  });
  const executionReceiptIds = exactExecutionReceiptIds({
    context: input.context,
    checkpointer: input.checkpointer,
    artifacts: [subject.analysis, subject.draft, input.validity.value.vera_report_ref],
  });
  const body: Omit<AssessmentProductIntegrityV1, "integrity_id"> = {
    schema_id: "penny.assessment-product-integrity.v1",
    schema_version: 1,
    status: "PASS",
    request_ref: subject.request,
    analysis_ref: subject.analysis,
    draft_ref: subject.draft,
    assessment_ref: subject.assessment,
    vera_report_ref: input.validity.value.vera_report_ref,
    validity_receipt_ref: input.validity.artifact,
    execution_receipt_ids: executionReceiptIds,
    checks: [
      "canonical_assessment",
      "exact_criterion_coverage",
      "exact_evidence_indexes",
      "disposition_invariants",
      "exact_source_lineage",
      "latest_vera_pass",
      "signed_worker_evidence",
      "current_product_receipt",
      "no_actions_writes_tests_or_changes",
    ],
    external_actions_performed: false,
    filesystem_writes_performed: false,
    tests_executed: false,
    changes_started: false,
  };
  const value = validateAssessmentProductIntegrity({
    ...body,
    integrity_id: assessmentProductIntegrityId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_assessment",
    branchId: "integrity",
    kind: "assessment-product-integrity",
    operationLabel: "product-integrity",
    producer: "host:assessment-product-validator",
    contentSchema: { schema_id: "penny.assessment-product-integrity.v1", schema_version: 1 },
    upstreamRefs: [
      ...subjectRefs(subject),
      input.validity.value.vera_report_ref,
      input.validity.artifact,
    ],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function ensureProductEnvelope(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly validity: {
    readonly artifact: ArtifactRef;
    readonly value: AssessmentValidityReceiptV1;
  };
  readonly integrity: ArtifactRef;
}): {
  readonly artifact: ArtifactRef;
  readonly value: AssessmentProductEnvelopeV1;
  readonly added: boolean;
} {
  const subject = currentAssessmentSubject(input.context);
  const body: Omit<AssessmentProductEnvelopeV1, "envelope_id"> = {
    schema_id: "penny.assessment-product-envelope.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    status: "complete",
    request_ref: subject.request,
    analysis_ref: subject.analysis,
    draft_ref: subject.draft,
    assessment_ref: subject.assessment,
    vera_report_ref: input.validity.value.vera_report_ref,
    validity_receipt_ref: input.validity.artifact,
    integrity_ref: input.integrity,
  };
  const value = validateAssessmentProductEnvelope({
    ...body,
    envelope_id: assessmentProductEnvelopeId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_assessment",
    branchId: null,
    kind: "assessment-product-envelope",
    operationLabel: "product-envelope",
    producer: "host:assessment-product-validator",
    contentSchema: { schema_id: "penny.assessment-product-envelope.v1", schema_version: 1 },
    upstreamRefs: [
      ...subjectRefs(subject),
      input.validity.value.vera_report_ref,
      input.validity.artifact,
      input.integrity,
    ],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function verificationEvaluation(details: Record<string, JsonValue>): EvaluationResultV2 | null {
  if (details.verdict === "PASS") {
    if (details.gap_kind !== "none" || details.repair_owner !== "none") {
      throw new Error("Vera PASS must use gap_kind=none and repair_owner=none");
    }
    return null;
  }
  const gap = details.gap_kind;
  const expectedOwner = gap === "assessment_product_gap" ? "carren" : "annie";
  if (
    (gap !== "analysis_gap" && gap !== "evidence_gap" && gap !== "assessment_product_gap") ||
    details.repair_owner !== expectedOwner
  ) {
    throw new Error("Vera FAIL requires one closed Assess gap with its matching repair owner");
  }
  const findings = Array.isArray(details.findings)
    ? details.findings.filter((finding): finding is string => typeof finding === "string")
    : [];
  return {
    schema_version: 2,
    kind: gap,
    detail: `verifying_assessment returned FAIL with ${findings.length} finding(s)`,
    findings: findings.slice(0, 32),
    strategy_delta:
      typeof details.strategy_delta === "string" && details.strategy_delta.trim().length > 0
        ? details.strategy_delta
        : `Replace the ${gap} without external verification or actions.`,
  };
}

function bestPartial(context: RunContext): ArtifactRef | undefined {
  return (
    latestAssessmentArtifact(context) ??
    latestDraftArtifact(context) ??
    latestAnalysisArtifact(context)
  );
}

export class AssessPlaybook
  implements
    PlaybookCoreV1,
    HostContinuationCapabilityV1,
    LivenessTerminalCapabilityV1,
    StateAwareRepairCapabilityV1,
    RepairExhaustionCapabilityV1,
    RoutingRepairCapabilityV1
{
  constructor(
    private readonly revisions?: ArtifactRevisionLookup,
    private readonly artifactStore?: ArtifactHostStore,
    private readonly checkpointer?: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"],
    private readonly hostFault?: (point: string) => void
  ) {}

  initialize(context: RunContext): Directive {
    if (context.identity.playbook !== ASSESS_PLAYBOOK_NAME) {
      throw new Error(`AssessPlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    context.transition("analyzing_assessment");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    if (!isAssessWorkerState(context.stateId)) {
      throw new Error(`cannot dispatch assess state '${context.stateId}'`);
    }
    const state = context.stateId;
    const refs = refsForState(context, state);
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: state,
      agent: ASSESS_AGENT_BY_STATE[state],
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      task: taskForState(state),
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
    return state === "verifying_assessment" ? verificationEvaluation(details) : null;
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
      case "analyzing_assessment":
        if (details.complete !== true) throw new Error("assessment analysis summary is incomplete");
        context.transition("authoring_assessment");
        return this.dispatch(context);
      case "authoring_assessment":
        if (details.complete !== true) throw new Error("assessment draft summary is incomplete");
        context.transition("sealing_assessment");
        return hostContinuation();
      case "verifying_assessment":
        if (details.verdict !== "PASS") {
          throw new Error("Vera assessment gap reached happy routing without engine repair");
        }
        context.transition("admitting_assessment");
        return hostContinuation();
      default:
        throw new Error(`unexpected assess summary in state '${context.stateId}'`);
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
      task: "Repair routing metadata only. Read the one exact malformed source artifact and emit only the mechanically projected registered phase SUMMARY. Do not alter assessment content, verify externally, execute tests, write files, start changes, score, or perform actions.",
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
    throw new Error("assess has no user-response state; rerun with a revised closed request");
  }

  cancel(context: RunContext, reason: string): Directive {
    return this.terminal(context, "cancelled", false, [reason]);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending?.action !== "invoke_agent") return pending;
    if (pending.execution_purpose === "routing_repair") return pending;
    if (!isAssessWorkerState(pending.state_id)) return pending;
    return validateDirective({
      ...pending,
      output_artifact: outputMetadata(
        context,
        pending.state_id,
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
      (context.stateId === "sealing_assessment" || context.stateId === "admitting_assessment")
    );
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context)) {
      throw new Error(`assess state '${context.stateId}' has no deterministic host continuation`);
    }
    const store = this.artifactStore;
    const checkpointer = this.checkpointer;
    if (store === undefined || checkpointer === undefined) {
      throw new Error("assess engine host continuation dependencies are unavailable");
    }
    if (context.stateId === "sealing_assessment") return this.continueSealing(context, store);
    const subject = currentAssessmentSubject(context);
    const validity = ensureValidityReceipt({ context, store, checkpointer });
    if (validity.added) {
      this.hostFault?.("admitting_assessment:validity-receipt-persistence");
      return {
        event_type: "assessment_validity_receipt_persisted",
        payload: {
          run_id: context.identity.run_id,
          assessment_artifact_id: subject.assessment.artifact_id,
          receipt_artifact_id: validity.artifact.artifact_id,
        },
      };
    }
    const integrity = ensureProductIntegrity({
      context,
      store,
      checkpointer,
      validity: { artifact: validity.artifact, value: validity.value },
    });
    if (integrity.added) {
      this.hostFault?.("admitting_assessment:integrity-persistence");
      return {
        event_type: "assessment_product_integrity_persisted",
        payload: {
          run_id: context.identity.run_id,
          assessment_artifact_id: subject.assessment.artifact_id,
          integrity_artifact_id: integrity.artifact.artifact_id,
        },
      };
    }
    const envelope = ensureProductEnvelope({
      context,
      store,
      validity: { artifact: validity.artifact, value: validity.value },
      integrity: integrity.artifact,
    });
    if (envelope.added) {
      this.hostFault?.("admitting_assessment:envelope-persistence");
      return {
        event_type: "assessment_product_envelope_persisted",
        payload: {
          run_id: context.identity.run_id,
          assessment_artifact_id: subject.assessment.artifact_id,
          envelope_artifact_id: envelope.artifact.artifact_id,
        },
      };
    }
    return {
      event_type: "assessment_product_completion_admitted",
      payload: {
        run_id: context.identity.run_id,
        assessment_artifact_id: subject.assessment.artifact_id,
        envelope_artifact_id: envelope.artifact.artifact_id,
      },
      directive: this.terminal(context, "complete", true, []),
      after_checkpoint_fault: "admitting_assessment:completion-admission",
    };
  }

  hostCheckpointCommitted(_context: RunContext, point: string): void {
    this.hostFault?.(point);
  }

  private continueSealing(context: RunContext, store: ArtifactHostStore): HostContinuationStepV1 {
    const request = admittedAssessmentRequestArtifact(context);
    const analysis = latestAnalysisArtifact(context);
    const draft = latestDraftArtifact(context);
    const missing = [
      ...(analysis === undefined ? ["assessment-analysis"] : []),
      ...(draft === undefined ? ["assessment-draft"] : []),
    ];
    if (analysis === undefined || draft === undefined) {
      return {
        event_type: "assessment_seal_input_absent",
        payload: { run_id: context.identity.run_id, missing_exact_inputs: missing },
        directive: this.terminal(
          context,
          "incomplete",
          false,
          missing.map((name) => `missing exact input: ${name}`),
          undefined,
          { incomplete_reason: "missing_exact_input", missing_exact_inputs: missing }
        ),
      };
    }
    let draftValue: AssessmentDraftV1;
    try {
      draftValue = parsePersistedAssessmentDraft(store.readById(draft.artifact_id), {
        request: canonicalAssessmentRequest(store, context),
      }).draft;
    } catch (error) {
      if (!(error instanceof AssessmentDraftValidationError)) throw error;
      if (latestSealFeedbackArtifact(context) !== undefined) {
        return {
          event_type: "assessment_seal_repair_exhausted",
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
      const feedback = persistSealFeedback({ context, store, draft, failure: error });
      if (feedback.added) this.hostFault?.("sealing_assessment:feedback-persistence");
      context.transition("authoring_assessment");
      const next = this.dispatch(context);
      return {
        event_type: "assessment_seal_repair_requested",
        payload: {
          run_id: context.identity.run_id,
          rejected_draft_artifact_id: draft.artifact_id,
          feedback_artifact_id: feedback.artifact.artifact_id,
        },
        directive: next,
      };
    }
    const sealed = persistSealedAssessment({
      context,
      store,
      request,
      analysis,
      draft,
      draftValue,
    });
    if (sealed.added) this.hostFault?.("sealing_assessment:artifact-persistence");
    context.transition("verifying_assessment");
    const next = this.dispatch(context);
    return {
      event_type: "assessment_sealed",
      payload: {
        run_id: context.identity.run_id,
        draft_artifact_id: draft.artifact_id,
        assessment_artifact_id: sealed.artifact.artifact_id,
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
    const output = met ? latestAssessmentArtifact(context) : bestPartial(context);
    if (met && output === undefined) throw new Error("positive assess terminal has no product");
    const graph = met
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
        external_actions_performed: false,
        filesystem_writes_performed: false,
        tests_executed: false,
        changes_started: false,
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
    const subject = currentAssessmentSubject(context);
    const vera = latestVeraReportArtifact(context);
    const validity = latestValidityReceiptArtifact(context);
    const integrity = latestIntegrityArtifact(context);
    const envelope = latestEnvelopeArtifact(context);
    if (
      vera === undefined ||
      validity === undefined ||
      integrity === undefined ||
      envelope === undefined
    ) {
      throw new Error("positive assessment terminal graph is incomplete");
    }
    return uniqueRefs([...subjectRefs(subject), vera, validity, integrity, envelope]);
  }
}

function expectedValidityExecution(
  input: Parameters<CompletionReceiptPredicateV1>[0],
  receipt: AssessmentValidityReceiptV1
): PhaseResult | undefined {
  const result = input.checkpointer.receiptResultById(receipt.execution_receipt_id);
  if (
    result === undefined ||
    result.run_id !== input.context.identity.run_id ||
    result.state_id !== "verifying_assessment" ||
    result.agent !== "vera" ||
    result.details.verdict !== "PASS" ||
    sha256(canonicalJson(result)) !== receipt.execution_result_sha256
  ) {
    return undefined;
  }
  let executionGroup: ReturnType<typeof exactAcceptedExecutionGroup>;
  try {
    executionGroup = exactAcceptedExecutionGroup({
      context: input.context,
      checkpointer: input.checkpointer,
      artifact: receipt.vera_report_ref,
    });
  } catch {
    return undefined;
  }
  return canonicalJson(executionGroup.routed) === canonicalJson(result) &&
    executionGroup.receiptIds.at(-1) === receipt.execution_receipt_id
    ? result
    : undefined;
}

export function evaluateAssessLatestVerifiedAssessmentDod(
  input: Parameters<CompletionReceiptPredicateV1>[0]
): ReturnType<CompletionReceiptPredicateV1> {
  try {
    const reader = input.artifactReader;
    if (reader === undefined || input.originState !== "admitting_assessment") {
      return { passed: false, evidence_refs: [] };
    }
    const subject = currentAssessmentSubject(input.context);
    if (
      subject.assessment.artifact_id !== input.latestProduct.product_id ||
      subject.assessment.content_digest !== input.latestProduct.sha256
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const request = canonicalAssessmentRequest(reader, input.context);
    const draft = parsePersistedAssessmentDraft(reader.readById(subject.draft.artifact_id), {
      request,
    }).draft;
    const assessment = validateCanonicalAssessmentBytes(
      reader.readById(subject.assessment.artifact_id),
      subject.assessment
    );
    assertAssessmentLineage({
      assessment,
      request,
      draft,
      requestRef: subject.request,
      analysisRef: subject.analysis,
      draftRef: subject.draft,
    });
    const veraReportRef = latestVeraReportArtifact(input.context);
    const validityRef = latestValidityReceiptArtifact(input.context);
    const integrityRef = latestIntegrityArtifact(input.context);
    const envelopeRef = latestEnvelopeArtifact(input.context);
    if (
      veraReportRef === undefined ||
      validityRef === undefined ||
      integrityRef === undefined ||
      envelopeRef === undefined
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const validity = readCanonicalJson(reader, validityRef, validateAssessmentValidityReceipt);
    const integrity = readCanonicalJson(reader, integrityRef, validateAssessmentProductIntegrity);
    const envelope = readCanonicalJson(reader, envelopeRef, validateAssessmentProductEnvelope);
    const expectedExecutionReceiptIds = exactExecutionReceiptIds({
      context: input.context,
      checkpointer: input.checkpointer,
      artifacts: [subject.analysis, subject.draft, validity.vera_report_ref],
    });
    const validityExecution = expectedValidityExecution(input, validity);
    if (
      canonicalJson(validity.request_ref) !== canonicalJson(subject.request) ||
      canonicalJson(validity.analysis_ref) !== canonicalJson(subject.analysis) ||
      canonicalJson(validity.draft_ref) !== canonicalJson(subject.draft) ||
      canonicalJson(validity.assessment_ref) !== canonicalJson(subject.assessment) ||
      canonicalJson(validity.vera_report_ref) !== canonicalJson(veraReportRef) ||
      canonicalJson(integrity.request_ref) !== canonicalJson(subject.request) ||
      canonicalJson(integrity.analysis_ref) !== canonicalJson(subject.analysis) ||
      canonicalJson(integrity.draft_ref) !== canonicalJson(subject.draft) ||
      canonicalJson(integrity.assessment_ref) !== canonicalJson(subject.assessment) ||
      canonicalJson(integrity.vera_report_ref) !== canonicalJson(validity.vera_report_ref) ||
      canonicalJson(integrity.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(integrity.execution_receipt_ids) !==
        canonicalJson(expectedExecutionReceiptIds) ||
      envelope.run_id !== input.context.identity.run_id ||
      canonicalJson(envelope.request_ref) !== canonicalJson(subject.request) ||
      canonicalJson(envelope.analysis_ref) !== canonicalJson(subject.analysis) ||
      canonicalJson(envelope.draft_ref) !== canonicalJson(subject.draft) ||
      canonicalJson(envelope.assessment_ref) !== canonicalJson(subject.assessment) ||
      canonicalJson(envelope.vera_report_ref) !== canonicalJson(validity.vera_report_ref) ||
      canonicalJson(envelope.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(envelope.integrity_ref) !== canonicalJson(integrityRef) ||
      validityExecution === undefined ||
      validityExecution.worker_receipt.ended_at !== validity.created_at ||
      assessment.external_actions_performed !== false ||
      assessment.filesystem_writes_performed !== false ||
      assessment.tests_executed !== false ||
      assessment.changes_started !== false ||
      input.terminal.result.external_actions_performed !== false ||
      input.terminal.result.filesystem_writes_performed !== false ||
      input.terminal.result.tests_executed !== false ||
      input.terminal.result.changes_started !== false ||
      canonicalJson(input.terminal.result.output_artifact_ref) !==
        canonicalJson(subject.assessment) ||
      input.terminal.unresolved.length !== 0
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const expectedRefs = [
      ...subjectRefs(subject),
      validity.vera_report_ref,
      validityRef,
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

export const ASSESS_COMPLETION_RECEIPT_PREDICATES: ReadonlyMap<
  string,
  CompletionReceiptPredicateV1
> = new Map([
  ["assess_latest_verified_assessment_dod.v1", evaluateAssessLatestVerifiedAssessmentDod],
]);

export const ASSESS_CANDIDATE_REGISTRATION: PlaybookRegistrationV1 = {
  name: ASSESS_PLAYBOOK_NAME,
  contract: ASSESS_SKILL_CONTRACT,
  ingress: "skill",
  start_admission: ASSESS_START_ADMISSION,
  liveness: {
    resolver_id: "assessLivenessPolicy",
    resolve: () => ASSESS_LIVENESS_POLICY,
    thinking_policy: "agent_ssot",
  },
  host_states: ["sealing_assessment", "admitting_assessment"],
  worker: {
    kind: "catalog-agent",
    workflow_name: ASSESS_PLAYBOOK_NAME,
    guidance: ASSESS_SKILL_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: new Map([
      [
        "analyzing_assessment",
        {
          agent: "annie",
          result_schema_id: "penny.assess.analysis-summary.v1",
          result_schema_version: 1,
          schema: StageCompleteSummarySchema,
        },
      ],
      [
        "authoring_assessment",
        {
          agent: "carren",
          result_schema_id: "penny.assess.authorship-summary.v1",
          result_schema_version: 1,
          schema: StageCompleteSummarySchema,
        },
      ],
      [
        "verifying_assessment",
        {
          agent: "vera",
          result_schema_id: "penny.assess.verification-summary.v1",
          result_schema_version: 1,
          schema: VerificationSummarySchema,
        },
      ],
    ]),
  },
  completionReceiptPredicates: ASSESS_COMPLETION_RECEIPT_PREDICATES,
  construct: (options) =>
    new AssessPlaybook(options.artifactRevisions, options.artifactStore, options.checkpointer),
};
