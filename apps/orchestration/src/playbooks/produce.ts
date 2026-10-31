import { Type } from "typebox";
import type { PhaseResultProjectorV1 } from "../phase-result-projection.js";

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
  type EvaluationResult,
  type JsonValue,
  type LivenessPolicy,
  type LivenessSnapshotV1,
  type LivenessTerminalReason,
  type OutputArtifactMetadata,
  type PhaseResult,
  type SkillContract,
} from "../contracts.js";
import { RunContext } from "../context.js";
import { trustedInvocationDigest, type ExecutionReceiptVerifier } from "../receipts.js";
import { ordinaryLivenessPolicy } from "../liveness.js";
import {
  validateProduceReviewAssignment,
  type ProduceReviewAssignmentV1,
  ProduceQualityReviewSummaryV1Schema,
  ProduceValidityReviewSummaryV1Schema,
  PRODUCE_MECHANICAL_CHECK_NAMES,
  MAX_PERSISTED_PRODUCE_DRAFT_BYTES,
  parsePersistedProduceReview,
  produceReviewPromptContract,
  validateProduceMechanicalChecks,
  artifactApproachDecisionPromptContract,
  artifactApproachPromptContract,
  ProduceRequestConstraintsV1Schema,
  assertProducedArtifactLineageV2,
  canonicalizeProduceRequest,
  parsePersistedArtifactApproach,
  parsePersistedArtifactApproachDecision,
  parsePersistedProducedArtifactDraftV2,
  produceProductEnvelopeIdV2,
  produceProductIntegrityIdV2,
  produceQualityReceiptIdV2,
  produceRequestConstraints,
  produceValidityReceiptIdV2,
  producedArtifactDraftPromptContractV2,
  sealProducedArtifactV2,
  validateCanonicalProducedArtifactV2Bytes,
  validateProduceProductEnvelopeV2,
  validateProduceProductIntegrityV2,
  validateProduceQualityReceiptV2,
  validateProduceRequest,
  validateProduceValidityReceiptV2,
  ProduceDraftValidationError,
  type ArtifactApproachDecisionV1,
  type ArtifactApproachV1,
  type ProduceProductEnvelopeV2,
  type ProduceProductIntegrityV2,
  type ProduceQualityReceiptV2,
  type ProduceRequestV1,
  type ProduceValidityReceiptV2,
  type ProducedArtifactDraftV2,
} from "../skill-contracts/produce.js";
import {
  BOUNDED_EFFECT_NOTICE,
  EFFECT_POLICY_VIOLATION_LIMITATION,
  PRODUCE_EFFECT_PHASES,
  UNKNOWN_EFFECT_LIMITATION,
  collectEffectEvidence,
  effectEvidenceSha256,
  unknownEffectEvidenceGraph,
  type EffectEvidenceGraphV1,
  type EffectEvidenceProviderV1,
} from "../skill-contracts/effects.js";
import { sealAttempt } from "./seal-attempt.js";
import {
  sealDiagnosticsProjection,
  sealPolicySha256,
  runSealPolicy,
  validateSealDiagnostic,
  type SealPolicyV1,
} from "../skill-contracts/sealing.js";
import { buildOutputArtifactMetadata } from "./artifact-metadata.js";
import {
  hostContinuation,
  type CompletionReceiptPredicateV1,
  type HostContinuationCapabilityV1,
  type HostContinuationStepV1,
  type LivenessTerminalCapabilityV1,
  type PlaybookCore,
  type PlaybookStepOutcome,
  type RepairExhaustionCapabilityV1,
  type RepairProgressCapabilityV1,
  type RoutingRepairCapabilityV1,
  type StateAwareRepairCapabilityV1,
} from "./playbook.js";
import type { PlaybookRegistration, PreparedStartV1, StartAdmissionV1 } from "./registry.js";

export const PRODUCE_PLAYBOOK_NAME = "produce";

export const PRODUCE_SEAL_POLICY: SealPolicyV1 = {
  schema_id: "penny.seal-policy.v1",
  schema_version: 1,
  skill: "produce",
  draft_phase: "materializing_artifact",
  seal_phase: "sealing_artifact",
  draft_schema: "penny.produced-artifact-draft.v2",
  draft_schema_version: 2,
  draft_kind: "produced-artifact-draft",
  product_kind: "semantic-core",
  correction_limit: null,
  diagnostic_schema: "penny.seal-diagnostic.v1",
};

export const PRODUCE_AGENT_BY_STATE = {
  exploring_artifact_approaches: "ida",
  selecting_artifact_approach: "demetri",
  materializing_artifact: "skribble",
  critiquing_artifact: "carren",
  verifying_artifact: "vera",
} as const;

type ProduceWorkerState = keyof typeof PRODUCE_AGENT_BY_STATE;
type ReviewState = "critiquing_artifact" | "verifying_artifact";
type ProduceReportGapKind = "quality_gap" | "brief_gap" | "artifact_product_gap";
type FrameworkRepairKind = "analysis_gap" | "product_gap";

function isProduceWorkerState(value: string): value is ProduceWorkerState {
  return Object.hasOwn(PRODUCE_AGENT_BY_STATE, value);
}

export const PRODUCE_FLOW = {
  states: [
    "intake",
    "exploring_artifact_approaches",
    "selecting_artifact_approach",
    "materializing_artifact",
    "sealing_artifact",
    "critiquing_artifact",
    "verifying_artifact",
    "admitting_artifact",
    "complete",
    "incomplete",
    "cancelled",
  ],
  edges: [
    ["intake", "exploring_artifact_approaches"],
    ["exploring_artifact_approaches", "selecting_artifact_approach"],
    ["selecting_artifact_approach", "materializing_artifact"],
    ["materializing_artifact", "sealing_artifact"],
    ["sealing_artifact", "materializing_artifact"],
    ["sealing_artifact", "critiquing_artifact"],
    ["critiquing_artifact", "materializing_artifact"],
    ["critiquing_artifact", "verifying_artifact"],
    ["verifying_artifact", "exploring_artifact_approaches"],
    ["verifying_artifact", "materializing_artifact"],
    ["verifying_artifact", "admitting_artifact"],
    ["verifying_artifact", "incomplete"],
    ["admitting_artifact", "complete"],
  ],
} as const;

export const PRODUCE_LIVENESS_POLICY = ordinaryLivenessPolicy({
  scope: "orchestrated-produce-workflow",
  preset: "ordinary-progress-lease-v3",
}) satisfies LivenessPolicy;

const StageCompleteSummarySchema = Type.Object(
  { complete: Type.Literal(true) },
  { additionalProperties: false }
);
const ApproachDecisionSummarySchema = Type.Union([
  Type.Object(
    { complete: Type.Literal(true), disposition: Type.Literal("selected") },
    { additionalProperties: false }
  ),
  Type.Object(
    { complete: Type.Literal(true), disposition: Type.Literal("unresolved") },
    { additionalProperties: false }
  ),
]);
export const PRODUCE_REPAIR_ROUTES = [
  {
    origin_state: "critiquing_artifact",
    report_gap_kind: "quality_gap",
    framework_kind: "product_gap",
    target_state: "materializing_artifact",
  },
  {
    origin_state: "verifying_artifact",
    report_gap_kind: "brief_gap",
    framework_kind: "analysis_gap",
    target_state: "exploring_artifact_approaches",
  },
  {
    origin_state: "verifying_artifact",
    report_gap_kind: "artifact_product_gap",
    framework_kind: "product_gap",
    target_state: "materializing_artifact",
  },
] as const satisfies readonly {
  readonly origin_state: ReviewState;
  readonly report_gap_kind: ProduceReportGapKind;
  readonly framework_kind: FrameworkRepairKind;
  readonly target_state: "exploring_artifact_approaches" | "materializing_artifact";
}[];

function repairRoute(
  originState: ReviewState,
  feedbackKind: FrameworkRepairKind,
  targetState: "exploring_artifact_approaches" | "materializing_artifact"
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

export const PRODUCE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: PRODUCE_PLAYBOOK_NAME,
  objective:
    "Materialize one complete non-mutating artifact content product from a closed inline brief through bounded approach exploration, exact draft authorship, host sealing, subjective quality review, independent objective verification, and deterministic current-product admission.",
  io: {
    request: {
      schema_version: 1,
      name: "produce_request",
      direction: "input",
      transport: "inline_request",
      schema_id: "penny.produce-request.v1",
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
        name: "produced_artifact",
        direction: "output",
        transport: "artifact",
        schema_id: "penny.produced-artifact.v2",
        schema_version_required: 2,
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
    skill_root: ".pi/skills/produce/assets/prompts",
    resolution: "per_agent_phase",
    documentation: ["docs/agents/writing/standard.md", "docs/agents/writing/review.md"],
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.produce-budget.v1",
    resolver_id: "produceLivenessPolicy",
    admission_id: "LivenessController.admitInvocation",
    snapshot_id: "LivenessController.snapshot",
  },
  repair_routing: {
    schema_version: 1,
    routes: PRODUCE_REPAIR_ROUTES.map((route) =>
      repairRoute(route.origin_state, route.framework_kind, route.target_state)
    ),
  },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: ["admitting_artifact"],
    required_visited_states: [
      "exploring_artifact_approaches",
      "selecting_artifact_approach",
      "materializing_artifact",
      "sealing_artifact",
      "critiquing_artifact",
      "verifying_artifact",
      "admitting_artifact",
    ],
    required_receipt_predicates: ["produce_latest_reviewed_artifact_dod.v1"],
    latest_product: {
      selector: "terminal_artifact",
      schema_id: "penny.produced-artifact.v2",
      product_schema_version: 2,
      artifact_kind: "semantic-core",
      producing_state: "sealing_artifact",
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

function selectedLatest(
  context: RunContext,
  predicate: (artifact: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts]
    .reverse()
    .find((artifact) => artifact.run_id === context.identity.run_id && predicate(artifact));
}
function selectedBefore(
  context: RunContext,
  ref: ArtifactRef,
  predicate: (artifact: ArtifactRef) => boolean
): ArtifactRef | undefined {
  const position = context.selectedArtifacts.findIndex(
    (item) => item.artifact_id === ref.artifact_id
  );
  if (position < 0) return undefined;
  return [...context.selectedArtifacts.slice(0, position)].reverse().find(predicate);
}

function addSelectedArtifact(context: RunContext, artifact: ArtifactRef): boolean {
  const selected = context.selectedArtifacts.find(
    (candidate) => candidate.artifact_id === artifact.artifact_id
  );
  if (selected !== undefined) {
    if (canonicalJson(selected) !== canonicalJson(artifact)) {
      throw new Error("selected produce artifact metadata diverged");
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

function admittedProduceRequestArtifact(context: RunContext): ArtifactRef {
  const request = selectedLatest(
    context,
    (artifact) => artifact.kind === "produce-request" && artifact.phase === "intake"
  );
  if (request === undefined) throw new Error("admitted ProduceRequestV1 artifact is absent");
  return request;
}

function latestApproachArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "artifact-approach" && artifact.phase === "exploring_artifact_approaches"
  );
}

function latestApproachDecisionArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "artifact-approach-decision" &&
      artifact.phase === "selecting_artifact_approach"
  );
}

function latestDraftArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "produced-artifact-draft" && artifact.phase === "materializing_artifact"
  );
}

function latestProductArtifact(context: RunContext): ArtifactRef | undefined {
  return [...context.selectedArtifacts]
    .reverse()
    .find(
      (artifact) =>
        artifact.run_id === context.identity.run_id &&
        artifact.kind === "semantic-core" &&
        artifact.phase === "sealing_artifact" &&
        artifact.content_schema?.schema_id === "penny.produced-artifact.v2" &&
        artifact.content_schema.schema_version === 2
    );
}

function latestReviewReport(context: RunContext, state: ReviewState): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "agent-output" && artifact.phase === state
  );
}

function latestSealFeedbackArtifact(context: RunContext): ArtifactRef | undefined {
  const anchor = latestProductArtifact(context);
  const anchorIndex =
    anchor === undefined
      ? -1
      : context.selectedArtifacts.map((ref) => ref.artifact_id).lastIndexOf(anchor.artifact_id);
  // Checkpoint selection order, never global artifact version or imported products.
  return [...context.selectedArtifacts.slice(anchorIndex + 1)]
    .reverse()
    .find(
      (ref) =>
        ref.run_id === context.identity.run_id &&
        ref.phase === "sealing_artifact" &&
        ref.kind === "seal-diagnostic" &&
        ref.content_schema?.schema_id === "penny.seal-diagnostic.v1"
    );
}

function currentSealDiagnostic(context: RunContext, store: ArtifactHostStore) {
  const ref = latestSealFeedbackArtifact(context);
  if (ref === undefined) return undefined;
  const bytes = store.readById(ref.artifact_id);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  const diagnostic = validateSealDiagnostic(value, runSealPolicy(context, PRODUCE_SEAL_POLICY));
  if (
    canonicalJson(diagnostic) !== bytes.toString("utf8") ||
    ref.content_digest !== sha256(bytes) ||
    diagnostic.rejected_draft_ref.run_id !== context.identity.run_id ||
    canonicalJson(diagnostic.epoch_anchor_ref) !==
      canonicalJson(latestProductArtifact(context) ?? null) ||
    canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref)
  )
    throw new Error("current seal diagnostic has invalid custody or epoch");
  return { ref, diagnostic };
}

function latestQualityReceipt(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "produce-quality-receipt" &&
      artifact.phase === "admitting_artifact" &&
      artifact.branch_id === "quality"
  );
}

function latestValidityReceipt(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "produce-validity-receipt" &&
      artifact.phase === "admitting_artifact" &&
      artifact.branch_id === "validity"
  );
}

function latestIntegrityArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "produce-product-integrity");
}

function latestEnvelopeArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "produce-product-envelope");
}

const LEGACY_PRODUCE_EFFECT_SCHEMAS = new Set([
  "penny.produced-artifact-draft.v1",
  "penny.produced-artifact.v1",
  "penny.produce-quality-receipt.v1",
  "penny.produce-validity-receipt.v1",
  "penny.produce-product-integrity.v1",
  "penny.produce-product-envelope.v1",
]);

function legacyProduceEffectArtifact(context: RunContext): ArtifactRef | undefined {
  return context.selectedArtifacts.find((artifact) =>
    LEGACY_PRODUCE_EFFECT_SCHEMAS.has(artifact.content_schema?.schema_id ?? "")
  );
}

function canonicalProduceRequest(
  store: Pick<ArtifactReader, "readById">,
  context: RunContext
): ProduceRequestV1 {
  const artifact = admittedProduceRequestArtifact(context);
  const bytes = store.readById(artifact.artifact_id).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("admitted ProduceRequestV1 artifact is not JSON");
  }
  const request = validateProduceRequest(value);
  if (canonicalJson(request) !== bytes) {
    throw new Error("admitted ProduceRequestV1 artifact is not canonical JSON");
  }
  return request;
}

function persistProduceRequestArtifact(input: {
  readonly request: ProduceRequestV1;
  readonly runId: string;
  readonly store?: ArtifactHostStore;
}): ArtifactRef | undefined {
  const store = input.store;
  if (store === undefined) return undefined;
  const operationId = `produce-request:${sha256(input.runId).slice(0, 32)}`;
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: "intake",
    branch_id: null,
    kind: "produce-request",
    operation_id: operationId,
    version: 1,
    producer: "host:request-admission",
    media_type: "application/json",
    content_schema: { schema_id: "penny.produce-request.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [],
  };
  const content = canonicalJson(validateProduceRequest(input.request));
  const existing = store.refFor(input.runId, "intake", null, "produce-request", operationId, 1);
  const artifact = existing ?? store.persist({ metadata, content });
  if (
    store.lastVersion(input.runId, "intake", null, "produce-request", operationId) !== 1 ||
    canonicalJson(store.metadata(artifact)) !== canonicalJson(metadata) ||
    store.readById(artifact.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("durable produce request artifact diverged");
  }
  const reread = store.refById(artifact.artifact_id);
  if (reread === undefined || canonicalJson(reread) !== canonicalJson(artifact)) {
    throw new Error("durable produce request artifact failed manifest re-read");
  }
  store.select(reread);
  return reread;
}

export const PRODUCE_START_ADMISSION: StartAdmissionV1 = {
  schema_id: "penny.produce-request.v1",
  schema_version: 1,
  prepare: (request): PreparedStartV1 => {
    if (request.input_artifacts !== undefined) {
      throw new Error("Produce V1 accepts inline source material and no caller artifact inputs");
    }
    const produceRequest = canonicalizeProduceRequest({
      goal: request.goal,
      constraints: request.constraints,
    });
    return {
      schema_id: "penny.produce-request.v1",
      schema_version: 1,
      request,
      goal: produceRequest.purpose_statement,
      constraints: produceRequestConstraints(produceRequest),
      admission_data: produceRequest,
    };
  },
  materialize: (prepared, host) => {
    const request = validateProduceRequest(prepared.admission_data);
    const requestRef = persistProduceRequestArtifact({
      request,
      runId: host.run_id,
      ...(host.artifactStore === undefined ? {} : { store: host.artifactStore }),
    });
    return requestRef === undefined ? [] : [requestRef];
  },
};

function outputMetadata(
  context: RunContext,
  state: ProduceWorkerState,
  upstreamRefs: readonly ArtifactRef[],
  revisions?: ArtifactRevisionLookup
): OutputArtifactMetadata {
  const specialized =
    state === "exploring_artifact_approaches"
      ? {
          artifactKind: "artifact-approach",
          mediaType: "text/plain; charset=utf-8",
          contentSchema: { schema_id: "penny.artifact-approach.v1", schema_version: 1 },
        }
      : state === "selecting_artifact_approach"
        ? {
            artifactKind: "artifact-approach-decision",
            mediaType: "text/plain; charset=utf-8",
            contentSchema: {
              schema_id: "penny.artifact-approach-decision.v1",
              schema_version: 1,
            },
          }
        : state === "materializing_artifact"
          ? {
              artifactKind: "produced-artifact-draft",
              mediaType: "text/plain; charset=utf-8",
              contentSchema: { schema_id: "penny.produced-artifact-draft.v2", schema_version: 2 },
            }
          : {};
  return buildOutputArtifactMetadata({
    context,
    phase: state,
    agent: PRODUCE_AGENT_BY_STATE[state],
    branchId: null,
    upstreamRefs,
    ...(revisions === undefined ? {} : { revisions }),
    ...specialized,
  });
}

function refsForState(context: RunContext, state: ProduceWorkerState): readonly ArtifactRef[] {
  const request = admittedProduceRequestArtifact(context);
  const approach = latestApproachArtifact(context);
  const decision = latestApproachDecisionArtifact(context);
  const draft = latestDraftArtifact(context);
  const product = latestProductArtifact(context);
  const carren = latestReviewReport(context, "critiquing_artifact");
  const vera = latestReviewReport(context, "verifying_artifact");
  if (state === "exploring_artifact_approaches") {
    return context.previousState === "verifying_artifact"
      ? uniqueRefs([request, approach, decision, draft, product, carren, vera])
      : [request];
  }
  if (approach === undefined) {
    throw new Error(`${state} requires the exact latest Ida artifact approach`);
  }
  if (state === "selecting_artifact_approach") {
    return context.previousState === "exploring_artifact_approaches" && vera !== undefined
      ? uniqueRefs([request, approach, decision, draft, product, carren, vera])
      : [request, approach];
  }
  if (decision === undefined) {
    throw new Error(`${state} requires the exact latest Demetri approach decision`);
  }
  if (state === "materializing_artifact") {
    return uniqueRefs([
      request,
      approach,
      decision,
      draft,
      product,
      carren,
      vera,
      latestSealFeedbackArtifact(context),
    ]);
  }
  if (draft === undefined || product === undefined) {
    throw new Error(`${state} requires the exact latest draft and sealed ProducedArtifactV2`);
  }
  const subject = [request, approach, decision, draft, product];
  if (state === "critiquing_artifact") return uniqueRefs([...subject, carren, vera]);
  if (carren === undefined) throw new Error("Vera requires the exact current Carren report");
  return uniqueRefs([...subject, carren, vera, latestMechanicalChecks(context)]);
}

function slotForRef(ref: ArtifactRef): string {
  if (ref.kind === "produce-request") return "produce-request";
  if (ref.kind === "produce-mechanical-checks") return "current-host-mechanical-checks";
  if (ref.kind === "artifact-approach") return "latest-artifact-approach";
  if (ref.kind === "artifact-approach-decision") return "latest-artifact-approach-decision";
  if (ref.kind === "produced-artifact-draft") return "latest-produced-artifact-draft";
  if (ref.kind === "seal-diagnostic") return "current-seal-diagnostic";
  if (ref.kind === "produce-seal-feedback") return "produce-seal-feedback";
  if (ref.content_schema?.schema_id === "penny.produced-artifact.v2") {
    return "latest-produced-artifact";
  }
  if (ref.phase === "critiquing_artifact") return "latest-carren-report";
  if (ref.phase === "verifying_artifact") return "latest-vera-report";
  return `input-${ref.artifact_id.slice(-12)}`;
}

function taskForState(state: ProduceWorkerState): string {
  const output =
    state === "critiquing_artifact" || state === "verifying_artifact"
      ? "Return only the complete PRODUCE_REVIEW V2 core. The host projects SUMMARY; do not append a final SUMMARY."
      : "Return complete stage content before one final SUMMARY.";
  const boundary = `artifact_read is mandatory for every needed exact workflow predecessor in input_artifacts; continue through next_range. No other tool or channel may substitute for a missing predecessor ref: never discover predecessor output through memory, /tmp, repository search, historical sessions, or name-only pointers. Other tools in the assigned catalog agent's YAML surface may be used only when materially relevant, permitted by the caller and task, and within this phase's consequence boundary; they do not authorize filesystem mutation or external action. ${output} The owner captures and re-reads bytes; do not claim persistence. Use supplied inline material as supplied, not as independently verified fact. Do not execute tests, compile, run, write files, mutate, browse, fetch, or perform external actions.`;
  switch (state) {
    case "exploring_artifact_approaches":
      return [
        boundary,
        `MECHANICALLY_PROJECTED_ARTIFACT_APPROACH_CONTRACT:${artifactApproachPromptContract()}`,
        "Explore one to four genuinely different ways to satisfy the exact artifact brief and state concrete tradeoffs without ranking, recommending, or choosing. Use one approach when the brief and host output contract fully determine the representation; do not pad the set with cosmetic variants. Do not author any final artifact content. On brief-gap repair, replace the approach set using Vera's exact current findings.",
      ].join("\n\n");
    case "selecting_artifact_approach":
      return [
        boundary,
        `MECHANICALLY_PROJECTED_ARTIFACT_APPROACH_DECISION_CONTRACT:${artifactApproachDecisionPromptContract()}`,
        "Decide among the exact Ida alternatives against the exact request. Assess every option on common decision-relevant dimensions, eliminate infeasible options first, select exactly one only when the supplied brief supports a defensible choice, and state what would change it. When missing preferences or uncertainty prevent a defensible choice, emit an honest unresolved disposition with concrete blocking questions. Do not author the final artifact.",
      ].join("\n\n");
    case "materializing_artifact":
      return [
        boundary,
        `MECHANICALLY_PROJECTED_PRODUCED_ARTIFACT_DRAFT_CONTRACT:${producedArtifactDraftPromptContractV2()}`,
        "Materialize one complete replacement ProducedArtifactDraftV2 from the exact request, Ida alternatives, and latest Demetri selection. Cover every exact request item. A truthful not_applicable is permitted only when required supplied material is absent or the exact constraints make production impossible; explain why and emit empty content. Never claim syntax, compilation, execution, tests, writes, or external checks. Repair all applicable Carren, Vera, or current-epoch seal-diagnostic findings in one replacement draft.",
      ].join("\n\n");
    case "critiquing_artifact":
      return [
        boundary,
        `MECHANICALLY_PROJECTED_PRODUCE_REVIEW_CONTRACT:${produceReviewPromptContract("quality")}`,
        "Subjectively review the exact latest host-sealed ProducedArtifactV2 against the exact brief, Ida alternatives, Demetri decision, and Skribble draft. Supplied earlier Carren/Vera reports are historical regression context only; check applicable findings against this new product, never reuse an earlier approval. Judge fitness for purpose, coherence, clarity, usefulness, restraint, quality of not_applicable reasoning, and whether the artifact actually feels complete. Treat the host effect graph as scoped evidence, not as full confinement. Do not repair it.",
        "APPROVE only when no major or critical quality defect remains. FAIL uses quality_gap/skribble. Never emit a target state.",
      ].join("\n\n");
    case "verifying_artifact":
      return [
        boundary,
        `MECHANICALLY_PROJECTED_PRODUCE_REVIEW_CONTRACT:${produceReviewPromptContract("validity")}`,
        "Independently verify objective correctness and compliance of the exact latest ProducedArtifactV2 against the exact request, Ida alternatives, Demetri decision, Skribble draft, and current Carren report. The latest earlier Vera report, if supplied, is historical regression context only; its PASS cannot validate this product. Read the exact current-product produce-mechanical-checks artifact: the host has recomputed schema/canonicality, content/draft/source/lineage hashes, coverage arrays, JSON canonicality and effect-graph shape with native deterministic validators. Do not claim to have executed those checks yourself. Independently review substantive coverage, acceptance compliance, source fidelity, not_applicable reasoning and truth of limitations; host mechanical PASS is not semantic approval. Treat unknown effect observations or controls as unknown, not as proof of absence. Treat Carren as prior context, not authority. Do not repair the product.",
        "PASS only when host mechanical evidence is exact and semantic review is adequate. Missing verification evidence is UNVERIFIABLE/verification_incomplete/none, not an author defect or repair instruction. Explicit unknown effects alone do not require UNVERIFIABLE. FAIL uses brief_gap/ida when the approach or brief treatment must be reconsidered, or artifact_product_gap/skribble when the draft/product must change. Never emit a target state.",
      ].join("\n\n");
  }
}

function persistVersionedHostArtifact(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly phase: "sealing_artifact" | "admitting_artifact";
  readonly branchId: string | null;
  readonly kind: string;
  readonly operationLabel: string;
  readonly producer: string;
  readonly contentSchema: { readonly schema_id: string; readonly schema_version: number };
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly content: string | Uint8Array;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const operationId = `produce-${input.operationLabel}:${sha256(input.context.identity.run_id).slice(0, 32)}`;
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

/** Product adapter retains the native revision/producer contract required by review receipts.
 * The owner selection is versioned by successful same-run product; an orphan at the
 * next revision must bind the exact draft, inputs and canonical product or conflict.
 */
function persistSealedProduct(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly request: ArtifactRef;
  readonly approach: ArtifactRef;
  readonly decision: ArtifactRef;
  readonly draft: ArtifactRef;
  readonly draftValue: ProducedArtifactDraftV2;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const product = sealProducedArtifactV2({
    request: canonicalProduceRequest(input.store, input.context),
    draft: input.draftValue,
    requestRef: input.request,
    approachRef: input.approach,
    decisionRef: input.decision,
    draftRef: input.draft,
    effectEvidence: unknownEffectEvidenceGraph({
      runId: input.context.identity.run_id,
      phases: PRODUCE_EFFECT_PHASES,
    }),
  });
  const attempt = sealAttempt({
    store: input.store,
    policy: runSealPolicy(input.context, PRODUCE_SEAL_POLICY),
    registered_policy_sha256: sealPolicySha256(runSealPolicy(input.context, PRODUCE_SEAL_POLICY)),
    run_id: input.context.identity.run_id,
    branch_id: null,
    phase: runSealPolicy(input.context, PRODUCE_SEAL_POLICY).seal_phase,
    draft_ref: input.draft,
    epoch_anchor_ref: latestProductArtifact(input.context) ?? null,
    previous_diagnostic_ref: null,
    rejection_ordinal: 0,
    project: () => ({
      status: "sealed",
      content: canonicalJson(product),
      content_schema: { schema_id: "penny.produced-artifact.v2", schema_version: 2 },
      upstream_refs: [input.request, input.approach, input.decision],
      revision_parent_ref: null,
    }),
    validate_product_bytes: (bytes, ref) => {
      validateCanonicalProducedArtifactV2Bytes(bytes, ref);
    },
  });
  if (attempt.status !== "sealed")
    throw new Error(
      `produce seal host fault: ${attempt.status === "fault" ? attempt.code : "unexpected rejection"}`
    );
  return {
    artifact: attempt.product_ref,
    added: addSelectedArtifact(input.context, attempt.product_ref),
  };
}

function eventString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface ProduceExecutionGroup {
  readonly source: PhaseResult;
  readonly routed: PhaseResult;
  readonly receiptIds: readonly string[];
}

function exactAcceptedExecutionGroup(input: {
  readonly context: RunContext;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly artifact: ArtifactRef;
}): ProduceExecutionGroup {
  const expectedAgent = input.artifact.producer.startsWith("agent:")
    ? input.artifact.producer.slice("agent:".length)
    : undefined;
  if (expectedAgent === undefined || expectedAgent.length === 0) {
    throw new Error(`produce artifact '${input.artifact.artifact_id}' has no agent producer`);
  }
  const matches: Array<{
    source: PhaseResult;
    routed: PhaseResult;
    receiptIds: readonly string[];
  }> = [];
  for (const event of input.checkpointer.events(input.context.identity.run_id)) {
    const acceptedId =
      event.eventType === "phase_result_accepted"
        ? eventString(event.payload.receipt_id)
        : undefined;
    if (acceptedId !== undefined) {
      const result = input.checkpointer.receiptResultById(acceptedId);
      if (
        result !== undefined &&
        result.run_id === input.context.identity.run_id &&
        result.state_id === input.artifact.phase &&
        result.agent === expectedAgent &&
        (result.branch_id ?? null) === input.artifact.branch_id &&
        result.worker_receipt.receipt_id === acceptedId &&
        canonicalJson(result.output_artifact) === canonicalJson(input.artifact)
      ) {
        matches.push({ source: result, routed: result, receiptIds: [acceptedId] });
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
        matches.push({ source, routed: repair, receiptIds: [sourceId, repairId] });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `produce artifact '${input.artifact.artifact_id}' requires exactly one accepted execution group`
    );
  }
  const match = matches[0];
  if (match === undefined) throw new Error("accepted produce execution group is absent");
  return match;
}

/** A repaired SUMMARY is authority only through the engine's exact accepted
 * execution group. Source bytes and semantic validation remain unchanged. */
function acceptedRoutingRepairSummary(input: {
  readonly context: RunContext;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly artifact: ArtifactRef;
}): unknown {
  const group = exactAcceptedExecutionGroup(input);
  return group.receiptIds.length === 2
    ? { confidence: group.routed.confidence, ...group.routed.details }
    : undefined;
}

interface ProduceSubjectV1 {
  readonly request: ArtifactRef;
  readonly approach: ArtifactRef;
  readonly decision: ArtifactRef;
  readonly draft: ArtifactRef;
  readonly product: ArtifactRef;
}

function currentSubject(context: RunContext): ProduceSubjectV1 {
  const request = admittedProduceRequestArtifact(context);
  const approach = latestApproachArtifact(context);
  const decision = latestApproachDecisionArtifact(context);
  const draft = latestDraftArtifact(context);
  const product = latestProductArtifact(context);
  if (
    approach === undefined ||
    decision === undefined ||
    draft === undefined ||
    product === undefined
  ) {
    throw new Error("latest produce subject is incomplete");
  }
  return { request, approach, decision, draft, product };
}

/** Native IDs link options, assessments and selection; they are not authored meaning. */
function canonicalApproachBasis(
  approach: ArtifactApproachV1,
  decision: ArtifactApproachDecisionV1
): JsonValue | null {
  if (decision.disposition !== "selected" || decision.selected_approach_id === null) return null;
  // Full canonical option content is the stable key, not its generated ID or position.
  // Ida's alternatives are unranked; assessment order likewise carries no selection.
  const optionKeys = new Map(
    approach.approaches.map(({ approach_id, ...meaning }) => [approach_id, canonicalJson(meaning)])
  );
  const selected = optionKeys.get(decision.selected_approach_id);
  if (selected === undefined || optionKeys.size !== approach.approaches.length) return null;
  const assessments: string[] = [];
  for (const { approach_id, ...meaning } of decision.approach_assessments) {
    const option = optionKeys.get(approach_id);
    if (option === undefined) return null;
    assessments.push(canonicalJson({ approach: option, ...meaning }));
  }
  const {
    approach_assessments: _assessments,
    selected_approach_id: _selected,
    ...selection
  } = decision;
  return {
    approach: {
      schema_version: approach.schema_version,
      confidence: approach.confidence,
      approaches: [...optionKeys.values()].sort(),
    },
    decision: {
      ...selection,
      approach_assessments: assessments.sort(),
      selected_approach: selected,
    },
  };
}

function subjectRefs(subject: ProduceSubjectV1): readonly ArtifactRef[] {
  return [subject.request, subject.approach, subject.decision, subject.draft, subject.product];
}

function latestMechanicalChecks(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (ref) => ref.kind === "produce-mechanical-checks");
}

function mechanicalCheckValue(input: {
  readonly context: RunContext;
  readonly store: ArtifactReader;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}) {
  const subject = currentSubject(input.context);
  for (const ref of subjectRefs(subject)) {
    if (
      ref.run_id !== input.context.identity.run_id ||
      canonicalJson(input.store.refById(ref.artifact_id)) !== canonicalJson(ref)
    )
      throw new Error("mechanical subject custody mismatch");
  }
  const request = canonicalProduceRequest(input.store, input.context);
  const approach = parsePersistedArtifactApproach(
    input.store.readById(subject.approach.artifact_id),
    {
      routingRepairSummary: acceptedRoutingRepairSummary({ ...input, artifact: subject.approach }),
    }
  ).approach;
  const decision = parsePersistedArtifactApproachDecision(
    input.store.readById(subject.decision.artifact_id),
    {
      approach,
      routingRepairSummary: acceptedRoutingRepairSummary({ ...input, artifact: subject.decision }),
    }
  ).decision;
  if (decision.disposition !== "selected")
    throw new Error("mechanical checks require selected approach");
  const draft = parsePersistedProducedArtifactDraftV2(
    input.store.readById(subject.draft.artifact_id),
    {
      request,
      routingRepairSummary: acceptedRoutingRepairSummary({ ...input, artifact: subject.draft }),
    }
  ).draft;
  const product = validateCanonicalProducedArtifactV2Bytes(
    input.store.readById(subject.product.artifact_id),
    subject.product
  );
  assertProducedArtifactLineageV2({
    product,
    request,
    draft,
    requestRef: subject.request,
    approachRef: subject.approach,
    decisionRef: subject.decision,
    draftRef: subject.draft,
    effectEvidence: product.effect_evidence,
  });
  return validateProduceMechanicalChecks({
    schema_id: "penny.produce-mechanical-checks.v1",
    schema_version: 1,
    status: "PASS",
    run_id: input.context.identity.run_id,
    request_ref: subject.request,
    approach_ref: subject.approach,
    decision_ref: subject.decision,
    draft_ref: subject.draft,
    product_ref: subject.product,
    checks: [...PRODUCE_MECHANICAL_CHECK_NAMES],
    product_effect_evidence_sha256: effectEvidenceSha256(product.effect_evidence),
    scope: "host_mechanical_only_not_semantic_or_effect_absence",
  });
}

function verifyMechanicalChecks(input: {
  readonly context: RunContext;
  readonly store: ArtifactReader;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): ArtifactRef {
  const ref = latestMechanicalChecks(input.context);
  if (
    ref === undefined ||
    ref.run_id !== input.context.identity.run_id ||
    ref.phase !== "sealing_artifact" ||
    ref.producer !== "host:produce-product-validator" ||
    ref.content_schema?.schema_id !== "penny.produce-mechanical-checks.v1" ||
    ref.content_schema.schema_version !== 1 ||
    canonicalJson(input.store.refById(ref.artifact_id)) !== canonicalJson(ref) ||
    canonicalJson(readCanonicalJson(input.store, ref, validateProduceMechanicalChecks)) !==
      canonicalJson(mechanicalCheckValue(input))
  ) {
    throw new Error("exact current-product host mechanical evidence is absent or invalid");
  }
  return ref;
}

/** Metadata is required for semantic-only reviews: raw V2 bytes do not name their subject. */
function hasReviewMetadata(
  store: ArtifactReader
): store is ArtifactReader & Pick<ArtifactHostStore, "metadata"> {
  return "metadata" in store && typeof store.metadata === "function";
}

function expectedReviewUpstreams(
  context: RunContext,
  state: ReviewState,
  report: ArtifactRef
): ArtifactRef[] {
  return uniqueRefs([
    ...subjectRefs(currentSubject(context)),
    selectedBefore(
      context,
      report,
      (ref) => ref.kind === "agent-output" && ref.phase === "critiquing_artifact"
    ),
    selectedBefore(
      context,
      report,
      (ref) => ref.kind === "agent-output" && ref.phase === "verifying_artifact"
    ),
    state === "verifying_artifact" ? latestMechanicalChecks(context) : undefined,
  ]);
}

type ReviewAssignmentDirective = Extract<Directive, { action: "invoke_agent" }>;

function reviewAssignmentValue(pending: ReviewAssignmentDirective): ProduceReviewAssignmentV1 {
  const repair = pending.routing_repair_binding;
  return validateProduceReviewAssignment({
    schema_id: "penny.produce-review-assignment.v1",
    schema_version: 1,
    invocation: {
      identity: pending.identity,
      state_id: pending.state_id,
      branch_id: null,
      agent: pending.agent,
      attempt: pending.attempt,
      trust_profile: pending.trust_profile,
      model_override: pending.model_override ?? null,
      ...(pending.execution_purpose !== "routing_repair"
        ? {}
        : {
            execution_purpose: "routing_repair",
            routing_repair_binding_sha256: sha256(canonicalJson(repair)),
          }),
      task_sha256: sha256(pending.task),
      input_artifacts: pending.input_artifacts,
      output_artifact: pending.output_artifact,
    },
    ...(repair === undefined ? {} : { routing_repair_binding: repair }),
  });
}

function reviewAssignmentMetadata(value: ProduceReviewAssignmentV1): OutputArtifactMetadata {
  const invocation = value.invocation;
  return {
    schema_version: 2,
    run_id: invocation.identity.run_id,
    phase: invocation.state_id,
    branch_id: null,
    kind: "produce-review-assignment",
    // Deliberately not addressed by task/input/metadata hashes: drift at an existing
    // assignment coordinate must conflict, not create an apparently fresh binding.
    operation_id: `review-assignment:${sha256(
      canonicalJson({
        state: invocation.state_id,
        attempt: invocation.attempt,
        output_operation: invocation.output_artifact.operation_id,
        output_version: invocation.output_artifact.version,
      })
    )}`,
    version: 1,
    producer: "host:produce-review-assignment",
    media_type: "application/json",
    content_schema: { schema_id: "penny.produce-review-assignment.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: invocation.input_artifacts.artifacts.map((binding) => binding.ref),
  };
}

function frozenReviewAssignment(input: {
  readonly context: RunContext;
  readonly store: ArtifactReader;
  readonly metadata: OutputArtifactMetadata;
  readonly attempt: number;
}): ProduceReviewAssignmentV1 {
  if (!hasReviewMetadata(input.store)) throw new Error("review metadata is unavailable");
  const matches: ProduceReviewAssignmentV1[] = [];
  for (const ref of input.context.selectedArtifacts) {
    if (ref.kind !== "produce-review-assignment" || ref.phase !== input.metadata.phase) continue;
    if (canonicalJson(input.store.refById(ref.artifact_id)) !== canonicalJson(ref))
      throw new Error("review assignment custody mismatch");
    const value = readCanonicalJson(input.store, ref, validateProduceReviewAssignment);
    if (
      canonicalJson(input.store.metadata(ref)) !== canonicalJson(reviewAssignmentMetadata(value)) ||
      canonicalJson(value.invocation.identity) !== canonicalJson(input.context.identity) ||
      value.invocation.trust_profile !== input.context.trustProfile
    )
      throw new Error("review assignment owner lineage mismatch");
    if (
      value.invocation.attempt === input.attempt &&
      canonicalJson(value.invocation.output_artifact) === canonicalJson(input.metadata)
    )
      matches.push(value);
  }
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error("exact frozen review assignment is absent or ambiguous");
  return matches[0];
}

function authenticateReviewResult(input: {
  readonly context: RunContext;
  readonly result: PhaseResult;
  readonly verifyExecutionReceipt?: ExecutionReceiptVerifier;
  readonly assignment?: ProduceReviewAssignmentV1;
}): void {
  if (input.verifyExecutionReceipt === undefined)
    throw new Error("review receipt verifier is unavailable");
  const result = input.result;
  const receipt = input.verifyExecutionReceipt(result.worker_receipt);
  if (
    canonicalJson(receipt) !== canonicalJson(result.worker_receipt) ||
    result.run_id !== input.context.identity.run_id ||
    receipt.run_id !== result.run_id ||
    receipt.state_id !== result.state_id ||
    receipt.agent !== result.agent ||
    receipt.attempt !== result.attempt ||
    receipt.branch_id !== (result.branch_id ?? null) ||
    receipt.exit_code !== 0 ||
    receipt.trust_profile !== input.context.trustProfile ||
    receipt.working_directory !== input.context.projectRoot ||
    canonicalJson(receipt.command) !== canonicalJson(["pi-sdk", result.agent]) ||
    receipt.output_digest !== result.output_artifact.content_digest ||
    canonicalJson(receipt.output_artifact_ref) !== canonicalJson(result.output_artifact)
  )
    throw new Error("review execution receipt/source mismatch");
  const invocation = input.assignment?.invocation;
  if (
    invocation !== undefined &&
    (invocation.state_id !== result.state_id ||
      invocation.agent !== result.agent ||
      invocation.attempt !== result.attempt ||
      invocation.branch_id !== (result.branch_id ?? null) ||
      invocation.model_override !== receipt.model ||
      trustedInvocationDigest(invocation) !== receipt.trusted_invocation_digest)
  )
    throw new Error("signed frozen review assignment mismatch");
}

/** Historical checks use frozen host operands, not today's prompt, schema descriptions,
 * contextual instruction or slot generator. Roles still bind to the current exact subject. */
function checkedSemanticReviewBinding(input: {
  readonly context: RunContext;
  readonly store: ArtifactReader;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly state: ReviewState;
  readonly report: ArtifactRef;
  readonly bytes: Uint8Array;
  readonly executionGroup?: ProduceExecutionGroup;
  readonly allowPendingAssignment?: boolean;
  readonly verifyExecutionReceipt?: ExecutionReceiptVerifier;
}): void {
  if (!hasReviewMetadata(input.store)) throw new Error("review source metadata is unavailable");
  if (input.verifyExecutionReceipt === undefined)
    throw new Error("review receipt verifier is unavailable");
  const metadata = input.store.metadata(input.report);
  const upstreams = expectedReviewUpstreams(input.context, input.state, input.report);
  const pending = input.context.pendingDirective;
  const directPending =
    input.allowPendingAssignment &&
    pending?.action === "invoke_agent" &&
    pending.execution_purpose !== "routing_repair" &&
    pending.state_id === input.state
      ? pending
      : undefined;
  const pendingRepair =
    input.allowPendingAssignment &&
    pending?.action === "invoke_agent" &&
    pending.execution_purpose === "routing_repair" &&
    canonicalJson(pending.routing_repair_binding?.source_artifact_ref) ===
      canonicalJson(input.report)
      ? pending
      : undefined;
  const group =
    directPending !== undefined || pendingRepair !== undefined
      ? undefined
      : (input.executionGroup ?? exactAcceptedExecutionGroup({ ...input, artifact: input.report }));
  const source =
    group?.source ??
    (pendingRepair?.routing_repair_binding === undefined
      ? undefined
      : input.checkpointer.receiptResultById(
          pendingRepair.routing_repair_binding.source_receipt_id
        ));
  const assignment = frozenReviewAssignment({
    ...input,
    metadata,
    attempt: directPending?.attempt ?? source?.attempt ?? -1,
  });
  const invocation = assignment.invocation;
  const contexts = (artifacts: typeof invocation.input_artifacts) =>
    artifacts.artifacts.filter((binding) => binding.designation === "context");
  if (
    assignment.routing_repair_binding !== undefined ||
    canonicalJson(metadata.upstream_refs) !== canonicalJson(upstreams) ||
    canonicalJson(
      invocation.input_artifacts.artifacts
        .filter((binding) => binding.designation !== "context")
        .map((binding) => binding.ref)
    ) !== canonicalJson(upstreams) ||
    canonicalJson(contexts(invocation.input_artifacts)) !==
      canonicalJson(
        contexts(input.context.admittedInputArtifacts ?? { schema_version: 2, artifacts: [] })
      )
  )
    throw new Error("frozen review does not bind the current native/context roles");
  produceReviewProjector(input.state).project({
    bytes: input.bytes,
    source: input.report,
    inputArtifacts: invocation.input_artifacts,
    artifacts: input.store,
  });
  if (directPending !== undefined) {
    if (canonicalJson(reviewAssignmentValue(directPending)) !== canonicalJson(assignment))
      throw new Error("pending review assignment drift");
    return; // Engine has authenticated this still-pending source before early routing.
  }
  if (source === undefined) throw new Error("original review execution receipt is unavailable");
  const captured = input.checkpointer
    .events(input.context.identity.run_id)
    .some(
      (event) =>
        (event.eventType === "phase_result_accepted" ||
          event.eventType === "phase_result_malformed") &&
        event.payload.receipt_id === source.worker_receipt.receipt_id &&
        event.payload.state_id === source.state_id &&
        event.payload.agent === source.agent &&
        event.payload.attempt === source.attempt
    );
  if (!captured || canonicalJson(source.output_artifact) !== canonicalJson(input.report))
    throw new Error("review source was not captured at the frozen assignment");
  authenticateReviewResult({ ...input, result: source, assignment });
  const routed = group?.routed;
  if (pendingRepair !== undefined || (routed !== undefined && routed !== source)) {
    const repair =
      pendingRepair === undefined
        ? routed === undefined
          ? undefined
          : frozenReviewAssignment({
              ...input,
              metadata: input.store.metadata(routed.output_artifact),
              attempt: routed.attempt,
            })
        : frozenReviewAssignment({
            ...input,
            metadata: pendingRepair.output_artifact,
            attempt: pendingRepair.attempt,
          });
    const binding = repair?.routing_repair_binding;
    if (
      repair === undefined ||
      binding === undefined ||
      binding.source_receipt_id !== source.worker_receipt.receipt_id ||
      binding.source_result_sha256 !== sha256(canonicalJson(source)) ||
      binding.source_state_id !== source.state_id ||
      binding.source_agent !== source.agent ||
      binding.source_attempt !== source.attempt ||
      binding.source_branch_id !== null ||
      canonicalJson(binding.source_artifact_ref) !== canonicalJson(input.report) ||
      canonicalJson(
        repair.invocation.input_artifacts.artifacts
          .filter((item) => item.designation !== "context")
          .map((item) => item.ref)
      ) !== canonicalJson([input.report]) ||
      canonicalJson(contexts(repair.invocation.input_artifacts)) !==
        canonicalJson(contexts(invocation.input_artifacts)) ||
      (pendingRepair !== undefined &&
        canonicalJson(reviewAssignmentValue(pendingRepair)) !== canonicalJson(repair))
    )
      throw new Error("review routing repair lost its exact source binding");
    if (pendingRepair === undefined && routed !== undefined)
      authenticateReviewResult({ ...input, result: routed, assignment: repair });
  }
}

function checkedReview(input: {
  readonly context: RunContext;
  readonly store: ArtifactReader;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly state: ReviewState;
  readonly report: ArtifactRef;
  readonly details: Record<string, JsonValue>;
  readonly confidence?: Confidence;
  readonly executionGroup?: ProduceExecutionGroup;
  readonly allowPendingAssignment?: boolean;
  readonly verifyExecutionReceipt?: ExecutionReceiptVerifier;
}) {
  const product = currentSubject(input.context).product;
  const hostCheck =
    input.state === "verifying_artifact" ? verifyMechanicalChecks(input) : undefined;
  if (
    input.report.kind !== "agent-output" ||
    input.report.branch_id !== null ||
    input.report.run_id !== input.context.identity.run_id ||
    input.report.phase !== input.state ||
    input.report.producer !== `agent:${PRODUCE_AGENT_BY_STATE[input.state]}` ||
    canonicalJson(input.store.refById(input.report.artifact_id)) !== canonicalJson(input.report)
  )
    throw new Error("review source custody mismatch");
  const bytes = input.store.readById(input.report.artifact_id);
  if (bytes.length !== input.report.byte_length || sha256(bytes) !== input.report.content_digest)
    throw new Error("review source bytes disagree with custody");
  const parsed = parsePersistedProduceReview(bytes, {
    state: input.state,
    productRef: product,
    ...(hostCheck === undefined ? {} : { hostCheckRef: hostCheck }),
  });
  if (parsed.core.schema_version === 2) checkedSemanticReviewBinding({ ...input, bytes });
  else if (!input.allowPendingAssignment && input.verifyExecutionReceipt !== undefined) {
    // Strict legacy parsing above remains unchanged; never repair or backfill old V1 refs.
    const group =
      input.executionGroup ?? exactAcceptedExecutionGroup({ ...input, artifact: input.report });
    authenticateReviewResult({ ...input, result: group.source });
    if (group.routed.worker_receipt.receipt_id !== group.source.worker_receipt.receipt_id)
      authenticateReviewResult({ ...input, result: group.routed });
  }
  if (
    canonicalJson(parsed.core.review) !== canonicalJson(input.details) ||
    (input.confidence !== undefined && parsed.core.confidence !== input.confidence)
  )
    throw new Error("routing metadata changed immutable review meaning");
  return parsed;
}

function acceptedReviewEvidence(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly state: ReviewState;
  readonly verdict: "APPROVE" | "PASS";
  readonly subject: ProduceSubjectV1;
  readonly carrenReport?: ArtifactRef;
  readonly verifyExecutionReceipt?: ExecutionReceiptVerifier;
}):
  | {
      readonly report: ArtifactRef;
      readonly result: PhaseResult;
      readonly receiptIds: readonly string[];
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
    const previousReport =
      source === undefined
        ? undefined
        : selectedLatest(
            input.context,
            (artifact) =>
              artifact.kind === "agent-output" &&
              artifact.phase === input.state &&
              artifact.version < source.output_artifact.version
          );
    // Admission occurs after current Vera: exclude its report from Carren's earlier inputs.
    // The current Carren gate for Vera remains the exact quality-receipt report.
    const currentVera = latestReviewReport(input.context, "verifying_artifact");
    const earlierVera =
      input.state === "critiquing_artifact"
        ? currentVera === undefined
          ? undefined
          : selectedBefore(
              input.context,
              currentVera,
              (artifact) =>
                artifact.kind === "agent-output" && artifact.phase === "verifying_artifact"
            )
        : previousReport;
    const expectedUpstreams = uniqueRefs([
      ...subjectRefs(input.subject),
      input.state === "critiquing_artifact" ? previousReport : input.carrenReport,
      earlierVera,
      input.state === "verifying_artifact" ? latestMechanicalChecks(input.context) : undefined,
    ]);
    if (
      source === undefined ||
      routed === undefined ||
      source.run_id !== input.context.identity.run_id ||
      routed.run_id !== input.context.identity.run_id ||
      source.state_id !== input.state ||
      canonicalJson(source.output_artifact) !==
        canonicalJson(latestReviewReport(input.context, input.state)) ||
      source.agent !== PRODUCE_AGENT_BY_STATE[input.state] ||
      routed.details.verdict !== input.verdict ||
      canonicalJson(input.store.metadata(source.output_artifact).upstream_refs) !==
        canonicalJson(expectedUpstreams)
    ) {
      continue;
    }
    try {
      const executionGroup = exactAcceptedExecutionGroup({
        ...input,
        artifact: source.output_artifact,
      });
      if (
        canonicalJson(executionGroup.source) !== canonicalJson(source) ||
        canonicalJson(executionGroup.routed) !== canonicalJson(routed)
      )
        throw new Error("review execution evidence changed during readback");
      checkedReview({
        ...input,
        report: executionGroup.source.output_artifact,
        details: executionGroup.routed.details,
        confidence: executionGroup.routed.confidence,
        executionGroup,
      });
      // Mint only from the exact objects just authenticated, not a separately reloaded row.
      return {
        report: executionGroup.source.output_artifact,
        result: executionGroup.routed,
        receiptIds: executionGroup.receiptIds,
      };
    } catch {
      return undefined;
    }
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

function matchingQualityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly subject: ProduceSubjectV1;
}): { readonly artifact: ArtifactRef; readonly value: ProduceQualityReceiptV2 } | undefined {
  const artifact = latestQualityReceipt(input.context);
  if (artifact === undefined) return undefined;
  const value = readCanonicalJson(input.store, artifact, validateProduceQualityReceiptV2);
  return value.product_ref.artifact_id === input.subject.product.artifact_id &&
    value.approach_ref.artifact_id === input.subject.approach.artifact_id &&
    value.decision_ref.artifact_id === input.subject.decision.artifact_id &&
    value.draft_ref.artifact_id === input.subject.draft.artifact_id
    ? { artifact, value }
    : undefined;
}

function matchingValidityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly subject: ProduceSubjectV1;
  readonly quality: ArtifactRef;
}): { readonly artifact: ArtifactRef; readonly value: ProduceValidityReceiptV2 } | undefined {
  const artifact = latestValidityReceipt(input.context);
  if (artifact === undefined) return undefined;
  const value = readCanonicalJson(input.store, artifact, validateProduceValidityReceiptV2);
  return value.product_ref.artifact_id === input.subject.product.artifact_id &&
    value.approach_ref.artifact_id === input.subject.approach.artifact_id &&
    value.decision_ref.artifact_id === input.subject.decision.artifact_id &&
    value.draft_ref.artifact_id === input.subject.draft.artifact_id &&
    value.quality_receipt_ref.artifact_id === input.quality.artifact_id
    ? { artifact, value }
    : undefined;
}

function ensureQualityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly effectEvidenceProvider?: EffectEvidenceProviderV1;
  readonly verifyExecutionReceipt?: ExecutionReceiptVerifier;
}): {
  readonly artifact: ArtifactRef;
  readonly value: ProduceQualityReceiptV2;
  readonly added: boolean;
} {
  const subject = currentSubject(input.context);
  const existing = matchingQualityReceipt({ ...input, subject });
  const evidence = acceptedReviewEvidence({
    ...input,
    state: "critiquing_artifact",
    verdict: "APPROVE",
    subject,
  });
  if (evidence === undefined) throw new Error("latest-product Carren APPROVE is absent");
  if (existing !== undefined) {
    if (
      canonicalJson(existing.value.carren_report_ref) !== canonicalJson(evidence.report) ||
      existing.value.execution_receipt_id !== evidence.result.worker_receipt.receipt_id ||
      existing.value.execution_result_sha256 !== sha256(canonicalJson(evidence.result))
    )
      throw new Error("existing quality receipt contradicts current review evidence");
    return { ...existing, added: false };
  }
  const body: Omit<ProduceQualityReceiptV2, "receipt_id"> = {
    schema_id: "penny.produce-quality-receipt.v2",
    schema_version: 2,
    run_id: input.context.identity.run_id,
    verdict: "APPROVE",
    reviewer: "carren",
    request_ref: subject.request,
    approach_ref: subject.approach,
    decision_ref: subject.decision,
    draft_ref: subject.draft,
    product_ref: subject.product,
    carren_report_ref: evidence.report,
    execution_receipt_id: evidence.result.worker_receipt.receipt_id,
    execution_result_sha256: sha256(canonicalJson(evidence.result)),
    created_at: evidence.result.worker_receipt.ended_at,
    effect_evidence: collectEffectEvidence({
      runId: input.context.identity.run_id,
      phases: PRODUCE_EFFECT_PHASES,
      ...(input.effectEvidenceProvider === undefined
        ? {}
        : { provider: input.effectEvidenceProvider }),
    }),
    minted_by: "host:produce-receipt-authority",
  };
  const value = validateProduceQualityReceiptV2({
    ...body,
    receipt_id: produceQualityReceiptIdV2(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_artifact",
    branchId: "quality",
    kind: "produce-quality-receipt",
    operationLabel: "quality-receipt",
    producer: "host:produce-receipt-authority",
    contentSchema: { schema_id: "penny.produce-quality-receipt.v2", schema_version: 2 },
    upstreamRefs: [...subjectRefs(subject), evidence.report],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function ensureValidityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly quality: { readonly artifact: ArtifactRef; readonly value: ProduceQualityReceiptV2 };
  readonly verifyExecutionReceipt?: ExecutionReceiptVerifier;
}): {
  readonly artifact: ArtifactRef;
  readonly value: ProduceValidityReceiptV2;
  readonly added: boolean;
} {
  const subject = currentSubject(input.context);
  const existing = matchingValidityReceipt({
    context: input.context,
    store: input.store,
    subject,
    quality: input.quality.artifact,
  });
  const evidence = acceptedReviewEvidence({
    ...input,
    state: "verifying_artifact",
    verdict: "PASS",
    subject,
    carrenReport: input.quality.value.carren_report_ref,
  });
  if (evidence === undefined) throw new Error("latest-product Vera PASS is absent");
  if (existing !== undefined) {
    if (
      canonicalJson(existing.value.vera_report_ref) !== canonicalJson(evidence.report) ||
      existing.value.execution_receipt_id !== evidence.result.worker_receipt.receipt_id ||
      existing.value.execution_result_sha256 !== sha256(canonicalJson(evidence.result))
    )
      throw new Error("existing validity receipt contradicts current review evidence");
    return { ...existing, added: false };
  }
  const body: Omit<ProduceValidityReceiptV2, "receipt_id"> = {
    schema_id: "penny.produce-validity-receipt.v2",
    schema_version: 2,
    run_id: input.context.identity.run_id,
    verdict: "PASS",
    reviewer: "vera",
    request_ref: subject.request,
    approach_ref: subject.approach,
    decision_ref: subject.decision,
    draft_ref: subject.draft,
    product_ref: subject.product,
    carren_report_ref: input.quality.value.carren_report_ref,
    vera_report_ref: evidence.report,
    quality_receipt_ref: input.quality.artifact,
    execution_receipt_id: evidence.result.worker_receipt.receipt_id,
    execution_result_sha256: sha256(canonicalJson(evidence.result)),
    created_at: evidence.result.worker_receipt.ended_at,
    effect_evidence: input.quality.value.effect_evidence,
    minted_by: "host:produce-receipt-authority",
  };
  const value = validateProduceValidityReceiptV2({
    ...body,
    receipt_id: produceValidityReceiptIdV2(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_artifact",
    branchId: "validity",
    kind: "produce-validity-receipt",
    operationLabel: "validity-receipt",
    producer: "host:produce-receipt-authority",
    contentSchema: { schema_id: "penny.produce-validity-receipt.v2", schema_version: 2 },
    upstreamRefs: [
      ...subjectRefs(subject),
      input.quality.value.carren_report_ref,
      evidence.report,
      input.quality.artifact,
    ],
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
    throw new Error("produce execution-evidence artifacts must be unique");
  }
  const ids = input.artifacts.flatMap(
    (artifact) => exactAcceptedExecutionGroup({ ...input, artifact }).receiptIds
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error("produce execution receipt IDs must map one-to-one to exact artifacts");
  }
  return ids;
}

function ensureProductIntegrity(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly quality: { readonly artifact: ArtifactRef; readonly value: ProduceQualityReceiptV2 };
  readonly validity: { readonly artifact: ArtifactRef; readonly value: ProduceValidityReceiptV2 };
}): {
  readonly artifact: ArtifactRef;
  readonly value: ProduceProductIntegrityV2;
  readonly added: boolean;
} {
  const subject = currentSubject(input.context);
  const request = canonicalProduceRequest(input.store, input.context);
  const approach = parsePersistedArtifactApproach(
    input.store.readById(subject.approach.artifact_id),
    {
      routingRepairSummary: acceptedRoutingRepairSummary({
        context: input.context,
        checkpointer: input.checkpointer,
        artifact: subject.approach,
      }),
    }
  ).approach;
  const decision = parsePersistedArtifactApproachDecision(
    input.store.readById(subject.decision.artifact_id),
    {
      approach,
      routingRepairSummary: acceptedRoutingRepairSummary({
        context: input.context,
        checkpointer: input.checkpointer,
        artifact: subject.decision,
      }),
    }
  ).decision;
  if (decision.disposition !== "selected")
    throw new Error("Produce integrity requires a selected approach");
  const draft = parsePersistedProducedArtifactDraftV2(
    input.store.readById(subject.draft.artifact_id),
    {
      request,
      routingRepairSummary: acceptedRoutingRepairSummary({
        context: input.context,
        checkpointer: input.checkpointer,
        artifact: subject.draft,
      }),
    }
  ).draft;
  const product = validateCanonicalProducedArtifactV2Bytes(
    input.store.readById(subject.product.artifact_id),
    subject.product
  );
  assertProducedArtifactLineageV2({
    product,
    request,
    draft,
    requestRef: subject.request,
    approachRef: subject.approach,
    decisionRef: subject.decision,
    draftRef: subject.draft,
    effectEvidence: product.effect_evidence,
  });
  if (
    canonicalJson(input.quality.value.effect_evidence) !==
    canonicalJson(input.validity.value.effect_evidence)
  ) {
    throw new Error("ProduceV2 quality and validity effect evidence diverged");
  }
  const executionReceiptIds = exactExecutionReceiptIds({
    context: input.context,
    checkpointer: input.checkpointer,
    artifacts: [
      subject.approach,
      subject.decision,
      subject.draft,
      input.quality.value.carren_report_ref,
      input.validity.value.vera_report_ref,
    ],
  });
  const body: Omit<ProduceProductIntegrityV2, "integrity_id"> = {
    schema_id: "penny.produce-product-integrity.v2",
    schema_version: 2,
    status: "PASS",
    request_ref: subject.request,
    approach_ref: subject.approach,
    decision_ref: subject.decision,
    draft_ref: subject.draft,
    product_ref: subject.product,
    carren_report_ref: input.quality.value.carren_report_ref,
    vera_report_ref: input.validity.value.vera_report_ref,
    quality_receipt_ref: input.quality.artifact,
    validity_receipt_ref: input.validity.artifact,
    execution_receipt_ids: executionReceiptIds,
    checks: [
      "canonical_product",
      "exact_request_coverage",
      "exact_source_lineage",
      "canonical_json_content_when_applicable",
      "latest_quality_receipt",
      "latest_validity_receipt",
      "signed_worker_evidence",
      "effect_evidence_consistency",
    ],
    product_effect_evidence_sha256: effectEvidenceSha256(product.effect_evidence),
    effect_evidence: input.quality.value.effect_evidence,
  };
  const value = validateProduceProductIntegrityV2({
    ...body,
    integrity_id: produceProductIntegrityIdV2(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_artifact",
    branchId: "integrity",
    kind: "produce-product-integrity",
    operationLabel: "product-integrity",
    producer: "host:produce-product-validator",
    contentSchema: { schema_id: "penny.produce-product-integrity.v2", schema_version: 2 },
    upstreamRefs: [
      ...subjectRefs(subject),
      input.quality.value.carren_report_ref,
      input.validity.value.vera_report_ref,
      input.quality.artifact,
      input.validity.artifact,
    ],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function ensureProductEnvelope(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly quality: { readonly artifact: ArtifactRef; readonly value: ProduceQualityReceiptV2 };
  readonly validity: { readonly artifact: ArtifactRef; readonly value: ProduceValidityReceiptV2 };
  readonly integrity: ArtifactRef;
}): {
  readonly artifact: ArtifactRef;
  readonly value: ProduceProductEnvelopeV2;
  readonly added: boolean;
} {
  const subject = currentSubject(input.context);
  const body: Omit<ProduceProductEnvelopeV2, "envelope_id"> = {
    schema_id: "penny.produce-product-envelope.v2",
    schema_version: 2,
    run_id: input.context.identity.run_id,
    status: "complete",
    request_ref: subject.request,
    approach_ref: subject.approach,
    decision_ref: subject.decision,
    draft_ref: subject.draft,
    product_ref: subject.product,
    carren_report_ref: input.quality.value.carren_report_ref,
    vera_report_ref: input.validity.value.vera_report_ref,
    quality_receipt_ref: input.quality.artifact,
    validity_receipt_ref: input.validity.artifact,
    integrity_ref: input.integrity,
    effect_evidence: input.quality.value.effect_evidence,
  };
  const value = validateProduceProductEnvelopeV2({
    ...body,
    envelope_id: produceProductEnvelopeIdV2(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_artifact",
    branchId: null,
    kind: "produce-product-envelope",
    operationLabel: "product-envelope",
    producer: "host:produce-product-validator",
    contentSchema: { schema_id: "penny.produce-product-envelope.v2", schema_version: 2 },
    upstreamRefs: [
      ...subjectRefs(subject),
      input.quality.value.carren_report_ref,
      input.validity.value.vera_report_ref,
      input.quality.artifact,
      input.validity.artifact,
      input.integrity,
    ],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function reviewEvaluation(
  state: ReviewState,
  details: Record<string, JsonValue>
): EvaluationResult | null {
  if (state === "critiquing_artifact") {
    if (details.verdict === "APPROVE") {
      if (details.gap_kind !== "none" || details.repair_owner !== "none") {
        throw new Error("Carren APPROVE must use gap_kind=none and repair_owner=none");
      }
      return null;
    }
    if (details.gap_kind !== "quality_gap" || details.repair_owner !== "skribble") {
      throw new Error("Carren FAIL requires quality_gap owned by Skribble");
    }
  } else {
    if (details.verdict === "PASS") {
      if (details.gap_kind !== "none" || details.repair_owner !== "none") {
        throw new Error("Vera PASS must use gap_kind=none and repair_owner=none");
      }
      return null;
    }
    const expectedOwner = details.gap_kind === "brief_gap" ? "ida" : "skribble";
    if (
      (details.gap_kind !== "brief_gap" && details.gap_kind !== "artifact_product_gap") ||
      details.repair_owner !== expectedOwner
    ) {
      throw new Error("Vera FAIL requires one closed gap with its matching repair owner");
    }
  }
  const findings = Array.isArray(details.findings)
    ? details.findings.flatMap((finding) =>
        typeof finding === "string"
          ? [finding]
          : finding !== null &&
              typeof finding === "object" &&
              !Array.isArray(finding) &&
              typeof finding.message === "string"
            ? [finding.message]
            : []
      )
    : [];
  const produceGap = details.gap_kind;
  if (
    produceGap !== "quality_gap" &&
    produceGap !== "brief_gap" &&
    produceGap !== "artifact_product_gap"
  ) {
    throw new Error(`${state} requires one closed produce repair gap`);
  }
  // Keep the product-specific public vocabulary in the signed report while mapping it onto
  // the stable framework classes. This avoids widening every unrelated skill/evaluation schema.
  const route = PRODUCE_REPAIR_ROUTES.find(
    (candidate) => candidate.origin_state === state && candidate.report_gap_kind === produceGap
  );
  if (route === undefined) throw new Error(`${state}:${produceGap} has no registered repair route`);
  const kind: FrameworkRepairKind = route.framework_kind;
  return {
    schema_version: 2,
    kind,
    detail: `${state} returned ${String(details.verdict)} with ${findings.length} finding(s)`,
    findings: findings.slice(0, 32),
    strategy_delta:
      typeof details.strategy_delta === "string" && details.strategy_delta.trim().length > 0
        ? details.strategy_delta
        : `Replace the ${produceGap} without side effects.`,
  };
}

function bestPartial(context: RunContext): ArtifactRef | undefined {
  return (
    latestProductArtifact(context) ??
    latestDraftArtifact(context) ??
    latestApproachDecisionArtifact(context) ??
    latestApproachArtifact(context)
  );
}

export class ProducePlaybook
  implements
    PlaybookCore,
    HostContinuationCapabilityV1,
    LivenessTerminalCapabilityV1,
    StateAwareRepairCapabilityV1,
    RepairExhaustionCapabilityV1,
    RepairProgressCapabilityV1,
    RoutingRepairCapabilityV1
{
  constructor(
    private readonly revisions?: ArtifactRevisionLookup,
    private readonly artifactStore?: ArtifactHostStore,
    private readonly checkpointer?: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"],
    private readonly hostFault?: (point: string) => void,
    private readonly effectEvidenceProvider?: EffectEvidenceProviderV1,
    private readonly verifyExecutionReceipt?: ExecutionReceiptVerifier
  ) {}

  /** Engine calls only after RunContext has appended all contextual operands. The
   * companion is selected for recovery, never appended to model input/output upstreams. */
  bindDispatch(context: RunContext, directive: Directive): void {
    if (
      directive.action !== "invoke_agent" ||
      (directive.state_id !== "critiquing_artifact" && directive.state_id !== "verifying_artifact")
    )
      return;
    const store = this.artifactStore;
    if (store === undefined) throw new Error("review assignment store is unavailable");
    const value = reviewAssignmentValue(directive);
    const ref = store.persist({
      metadata: reviewAssignmentMetadata(value),
      content: canonicalJson(value),
    });
    if (
      canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref) ||
      canonicalJson(readCanonicalJson(store, ref, validateProduceReviewAssignment)) !==
        canonicalJson(value)
    )
      throw new Error("frozen review assignment failed exact readback");
    // These are separate immutable assignment coordinates, not successive revisions
    // of the manifest's phase/kind selection slot. RunContext retains every exact ref.
    addSelectedArtifact(context, ref);
  }

  initialize(context: RunContext): Directive {
    if (context.identity.playbook !== PRODUCE_PLAYBOOK_NAME) {
      throw new Error(`ProducePlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    context.transition("exploring_artifact_approaches");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    if (!isProduceWorkerState(context.stateId)) {
      throw new Error(`cannot dispatch produce state '${context.stateId}'`);
    }
    const state = context.stateId;
    if (state === "materializing_artifact" && latestSealFeedbackArtifact(context) !== undefined) {
      if (this.artifactStore === undefined) throw new Error("seal diagnostic store is absent");
      currentSealDiagnostic(context, this.artifactStore);
    }
    const refs = refsForState(context, state);
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: state,
      agent: PRODUCE_AGENT_BY_STATE[state],
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
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): EvaluationResult | null {
    if (state !== "critiquing_artifact" && state !== "verifying_artifact") return null;
    if (!this.validCurrentReview(context, state, details)) return null;
    if (details.verdict === "UNVERIFIABLE") return null;
    return reviewEvaluation(state, details);
  }

  repairProgressFingerprint(
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): string | null {
    if (
      (state !== "critiquing_artifact" && state !== "verifying_artifact") ||
      details.verdict !== "FAIL" ||
      !PRODUCE_REPAIR_ROUTES.some(
        (route) => route.origin_state === state && route.report_gap_kind === details.gap_kind
      )
    )
      return null;
    const store = this.artifactStore;
    const checkpointer = this.checkpointer;
    if (store === undefined || checkpointer === undefined)
      throw new Error("produce repair measurement dependencies are unavailable");
    if (!this.validCurrentReview(context, state, details))
      throw new Error("produce repair measurement requires the exact bound review");
    // Recompute native operand/draft/product validation for BOTH reviewers. A valid
    // review core alone cannot authenticate the semantic candidate being measured.
    verifyMechanicalChecks({ context, store, checkpointer });
    const subject = currentSubject(context);
    const { approach } = parsePersistedArtifactApproach(
      store.readById(subject.approach.artifact_id),
      {
        routingRepairSummary: acceptedRoutingRepairSummary({
          context,
          checkpointer,
          artifact: subject.approach,
        }),
      }
    );
    const { decision } = parsePersistedArtifactApproachDecision(
      store.readById(subject.decision.artifact_id),
      {
        approach,
        routingRepairSummary: acceptedRoutingRepairSummary({
          context,
          checkpointer,
          artifact: subject.decision,
        }),
      }
    );
    const approachBasis = canonicalApproachBasis(approach, decision);
    // Unmeasurable native mappings cannot establish a stall. Invalid bytes or
    // custody still throw above; null is not a bypass for review/admission checks.
    if (approachBasis === null) return null;
    const { draft } = parsePersistedProducedArtifactDraftV2(
      store.readById(subject.draft.artifact_id),
      {
        request: canonicalProduceRequest(store, context),
        routingRepairSummary: acceptedRoutingRepairSummary({
          context,
          checkpointer,
          artifact: subject.draft,
        }),
      }
    );
    // Both reviewers judge the approach and selection as well as the draft.
    // Exclude transport/lineage identities, but retain exact authored meaning;
    // only structured native ID links and unranked collection order normalize.
    const { strategy_delta: _strategyDelta, ...failure } = details;
    return sha256(canonicalJson({ candidate: draft, approach_basis: approachBasis, failure }));
  }

  terminalizeRepairStall(
    context: RunContext,
    state: string,
    evaluation: EvaluationResult
  ): Directive {
    return this.terminal(
      context,
      "incomplete",
      false,
      [`repair stalled at ${state}:${evaluation.kind}`],
      undefined,
      {
        incomplete_reason: "repair_stalled",
        stalled: true,
        stall_reason: "exact_candidate_and_failure_repeated",
      }
    );
  }

  private validCurrentReview(
    context: RunContext,
    state: ReviewState,
    details: Record<string, JsonValue>,
    confidence?: Confidence
  ): boolean {
    if (this.artifactStore === undefined || this.checkpointer === undefined) return false;
    const pending = context.pendingDirective;
    const routingRepair =
      pending?.action === "invoke_agent" && pending.execution_purpose === "routing_repair";
    const report = routingRepair
      ? pending.routing_repair_binding?.source_artifact_ref
      : latestReviewReport(context, state);
    if (report === undefined) return false;
    try {
      checkedReview({
        context,
        state,
        store: this.artifactStore,
        checkpointer: this.checkpointer,
        report,
        details,
        ...(confidence === undefined ? {} : { confidence }),
        allowPendingAssignment: true,
        ...(this.verifyExecutionReceipt === undefined
          ? {}
          : { verifyExecutionReceipt: this.verifyExecutionReceipt }),
      });
      return true;
    } catch {
      return false;
    }
  }

  terminalizeRepairExhaustion(
    context: RunContext,
    state: string,
    evaluation: EvaluationResult
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
    confidence: Confidence
  ): PlaybookStepOutcome {
    // Validate complete captured approach/decision bytes before dispatching a
    // consumer, including before accepting an unresolved negative. Routing-only
    // correction may replace routing metadata, never a malformed semantic core.
    if (
      context.stateId === "exploring_artifact_approaches" ||
      context.stateId === "selecting_artifact_approach"
    ) {
      const invalid = this.validateApproachStage(context, details, confidence);
      if (invalid !== undefined) return invalid;
    }
    if (context.stateId === "critiquing_artifact" || context.stateId === "verifying_artifact") {
      if (!this.validCurrentReview(context, context.stateId, details, confidence))
        return this.terminal(
          context,
          "incomplete",
          false,
          ["review evidence is absent, malformed or contradictory"],
          undefined,
          {
            incomplete_reason: "review_evidence_invalid",
            review_report_ref: latestReviewReport(context, context.stateId) ?? null,
          }
        );
      if (details.verdict === "UNVERIFIABLE")
        return this.terminal(
          context,
          "incomplete",
          false,
          ["verification is incomplete; no author defect is established"],
          undefined,
          {
            incomplete_reason: "verification_incomplete",
            review_report_ref: latestReviewReport(context, context.stateId) ?? null,
            verification_findings: details.findings ?? [],
          }
        );
    }
    switch (context.stateId) {
      case "exploring_artifact_approaches":
        if (details.complete !== true) throw new Error("artifact approach summary is incomplete");
        context.transition("selecting_artifact_approach");
        return this.dispatch(context);
      case "selecting_artifact_approach":
        if (details.complete !== true) {
          throw new Error("artifact approach decision summary is incomplete");
        }
        if (details.disposition === "unresolved") {
          return this.terminal(
            context,
            "incomplete",
            false,
            ["artifact approach decision is unresolved"],
            undefined,
            { incomplete_reason: "unresolved_approach_decision" }
          );
        }
        if (details.disposition !== "selected") {
          throw new Error("artifact approach decision has an invalid disposition");
        }
        context.transition("materializing_artifact");
        return this.dispatch(context);
      case "materializing_artifact":
        if (details.complete !== true) throw new Error("artifact draft summary is incomplete");
        context.transition("sealing_artifact");
        return hostContinuation();
      case "critiquing_artifact":
        if (details.verdict !== "APPROVE") {
          throw new Error("Carren quality gap reached happy routing without engine repair");
        }
        context.transition("verifying_artifact");
        return this.dispatch(context);
      case "verifying_artifact":
        if (details.verdict !== "PASS") {
          throw new Error("Vera validity gap reached happy routing without engine repair");
        }
        context.transition("admitting_artifact");
        return hostContinuation();
      default:
        throw new Error(`unexpected produce summary in state '${context.stateId}'`);
    }
  }

  private validateApproachStage(
    context: RunContext,
    details: Record<string, JsonValue>,
    confidence: Confidence
  ): Directive | undefined {
    const store = this.artifactStore;
    const checkpointer = this.checkpointer;
    if (store === undefined || checkpointer === undefined) {
      throw new Error("produce approach validation dependencies are unavailable");
    }
    const approach = latestApproachArtifact(context);
    const artifact =
      context.stateId === "exploring_artifact_approaches"
        ? approach
        : latestApproachDecisionArtifact(context);
    if (approach === undefined || artifact === undefined) {
      throw new Error("captured Produce approach/decision artifact is absent");
    }
    const pending = context.pendingDirective;
    const routedSummary = { confidence, ...details };
    const routingRepairSummary =
      pending?.action === "invoke_agent" &&
      pending.execution_purpose === "routing_repair" &&
      canonicalJson(pending.routing_repair_binding?.source_artifact_ref) === canonicalJson(artifact)
        ? routedSummary
        : undefined;
    try {
      const parsedApproach = parsePersistedArtifactApproach(store.readById(approach.artifact_id), {
        routingRepairSummary:
          artifact.artifact_id === approach.artifact_id
            ? routingRepairSummary
            : acceptedRoutingRepairSummary({ context, checkpointer, artifact: approach }),
      });
      const summary =
        artifact.artifact_id === approach.artifact_id
          ? parsedApproach.summary
          : parsePersistedArtifactApproachDecision(store.readById(artifact.artifact_id), {
              approach: parsedApproach.approach,
              routingRepairSummary,
            }).summary;
      if (canonicalJson(summary) !== canonicalJson(routedSummary)) {
        throw new ProduceDraftValidationError("SEMANTIC_INVALID", [
          "captured core and accepted routing SUMMARY disagree",
        ]);
      }
      return undefined;
    } catch (error) {
      if (!(error instanceof ProduceDraftValidationError)) throw error;
      return this.terminal(
        context,
        "incomplete",
        false,
        ["exact Ida approach or Demetri decision is malformed"],
        undefined,
        {
          incomplete_reason: "malformed_exact_material",
          invalid_material_ref: artifact,
          failure_class: error.failureClass,
          failure_sha256: sha256(error.message),
        }
      );
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
    if (context.maxSteps !== null && context.stepCount >= context.maxSteps) {
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
      task: "Repair routing metadata only. Read the one exact malformed source artifact and emit only the mechanically projected registered phase SUMMARY. Do not alter artifact content, execute checks, write files, or perform actions.",
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
    throw new Error("produce has no user-response state; rerun with a revised closed brief");
  }

  cancel(context: RunContext, reason: string): Directive {
    return this.terminal(context, "cancelled", false, [reason]);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending?.action !== "invoke_agent") return pending;
    if (pending.state_id === "critiquing_artifact" || pending.state_id === "verifying_artifact") {
      if (this.artifactStore === undefined)
        throw new Error("review assignment store is unavailable");
      // Check saved task/inputs/metadata before the explicit ledger-driven output rebind.
      // Never use recovery to bless task or operand drift at an already frozen coordinate.
      const frozen = frozenReviewAssignment({
        context,
        store: this.artifactStore,
        metadata: pending.output_artifact,
        attempt: pending.attempt,
      });
      if (canonicalJson(frozen) !== canonicalJson(reviewAssignmentValue(pending)))
        throw new Error("saved review assignment drift");
    }
    if (pending.execution_purpose === "routing_repair") return pending;
    if (!isProduceWorkerState(pending.state_id)) return pending;
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
      (legacyProduceEffectArtifact(context) !== undefined ||
        context.stateId === "sealing_artifact" ||
        context.stateId === "admitting_artifact")
    );
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context)) {
      throw new Error(`produce state '${context.stateId}' has no deterministic host continuation`);
    }
    const legacy = legacyProduceEffectArtifact(context);
    if (legacy !== undefined) {
      return {
        event_type: "produce_legacy_effect_checkpoint_refused",
        payload: {
          run_id: context.identity.run_id,
          legacy_artifact_id: legacy.artifact_id,
          legacy_schema_id: legacy.content_schema?.schema_id ?? "unknown",
        },
        directive: this.terminal(
          context,
          "incomplete",
          false,
          ["active V1 checkpoint carries only legacy unverified effect assertions"],
          undefined,
          { incomplete_reason: "legacy_effect_evidence_unverified" }
        ),
      };
    }
    const store = this.artifactStore;
    const checkpointer = this.checkpointer;
    if (store === undefined || checkpointer === undefined) {
      throw new Error("produce engine host continuation dependencies are unavailable");
    }
    if (context.stateId === "sealing_artifact") return this.continueSealing(context, store);
    const subject = currentSubject(context);
    const reviewHost = {
      context,
      store,
      checkpointer,
      ...(this.verifyExecutionReceipt === undefined
        ? {}
        : { verifyExecutionReceipt: this.verifyExecutionReceipt }),
    };
    const qualityReview = acceptedReviewEvidence({
      ...reviewHost,
      subject,
      state: "critiquing_artifact",
      verdict: "APPROVE",
    });
    const validityReview =
      qualityReview === undefined
        ? undefined
        : acceptedReviewEvidence({
            ...reviewHost,
            subject,
            state: "verifying_artifact",
            verdict: "PASS",
            carrenReport: qualityReview.report,
          });
    if (qualityReview === undefined || validityReview === undefined) {
      return {
        event_type: "produce_review_evidence_refused",
        payload: { run_id: context.identity.run_id },
        directive: this.terminal(
          context,
          "incomplete",
          false,
          ["current independent review evidence is invalid"],
          undefined,
          { incomplete_reason: "review_evidence_invalid" }
        ),
      };
    }
    const quality = ensureQualityReceipt({
      ...reviewHost,
      ...(this.effectEvidenceProvider === undefined
        ? {}
        : { effectEvidenceProvider: this.effectEvidenceProvider }),
    });
    if (quality.added) {
      this.hostFault?.("admitting_artifact:quality-receipt-persistence");
      return {
        event_type: "produce_quality_receipt_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product.artifact_id,
          receipt_artifact_id: quality.artifact.artifact_id,
        },
      };
    }
    if (quality.value.effect_evidence.assurance === "policy_violation") {
      return {
        event_type: "produce_effect_policy_violation",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product.artifact_id,
          effect_evidence_sha256: effectEvidenceSha256(quality.value.effect_evidence),
        },
        directive: this.terminal(
          context,
          "incomplete",
          false,
          [EFFECT_POLICY_VIOLATION_LIMITATION],
          undefined,
          { incomplete_reason: "effect_policy_violation" },
          quality.value.effect_evidence
        ),
      };
    }
    const validity = ensureValidityReceipt({
      ...reviewHost,
      quality: { artifact: quality.artifact, value: quality.value },
    });
    if (validity.added) {
      this.hostFault?.("admitting_artifact:validity-receipt-persistence");
      return {
        event_type: "produce_validity_receipt_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product.artifact_id,
          receipt_artifact_id: validity.artifact.artifact_id,
        },
      };
    }
    const integrity = ensureProductIntegrity({
      context,
      store,
      checkpointer,
      quality: { artifact: quality.artifact, value: quality.value },
      validity: { artifact: validity.artifact, value: validity.value },
    });
    if (integrity.added) {
      this.hostFault?.("admitting_artifact:integrity-persistence");
      return {
        event_type: "produce_product_integrity_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product.artifact_id,
          integrity_artifact_id: integrity.artifact.artifact_id,
        },
      };
    }
    const envelope = ensureProductEnvelope({
      context,
      store,
      quality: { artifact: quality.artifact, value: quality.value },
      validity: { artifact: validity.artifact, value: validity.value },
      integrity: integrity.artifact,
    });
    if (envelope.added) {
      this.hostFault?.("admitting_artifact:envelope-persistence");
      return {
        event_type: "produce_product_envelope_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product.artifact_id,
          envelope_artifact_id: envelope.artifact.artifact_id,
        },
      };
    }
    return {
      event_type: "produce_product_completion_admitted",
      payload: {
        run_id: context.identity.run_id,
        product_artifact_id: subject.product.artifact_id,
        envelope_artifact_id: envelope.artifact.artifact_id,
      },
      directive: this.terminal(context, "complete", true, []),
      after_checkpoint_fault: "admitting_artifact:completion-admission",
    };
  }

  hostCheckpointCommitted(_context: RunContext, point: string): void {
    this.hostFault?.(point);
  }

  private continueSealing(context: RunContext, store: ArtifactHostStore): HostContinuationStepV1 {
    const request = admittedProduceRequestArtifact(context);
    const approach = latestApproachArtifact(context);
    const decision = latestApproachDecisionArtifact(context);
    const draft = latestDraftArtifact(context);
    const missing = [
      ...(approach === undefined ? ["artifact-approach"] : []),
      ...(decision === undefined ? ["artifact-approach-decision"] : []),
      ...(draft === undefined ? ["produced-artifact-draft"] : []),
    ];
    if (approach === undefined || decision === undefined || draft === undefined) {
      return {
        event_type: "produce_seal_input_absent",
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
    let approachValue: ArtifactApproachV1;
    try {
      if (this.checkpointer === undefined) throw new Error("produce checkpointer is absent");
      approachValue = parsePersistedArtifactApproach(store.readById(approach.artifact_id), {
        routingRepairSummary: acceptedRoutingRepairSummary({
          context,
          checkpointer: this.checkpointer,
          artifact: approach,
        }),
      }).approach;
      const parsedDecision = parsePersistedArtifactApproachDecision(
        store.readById(decision.artifact_id),
        {
          approach: approachValue,
          routingRepairSummary: acceptedRoutingRepairSummary({
            context,
            checkpointer: this.checkpointer,
            artifact: decision,
          }),
        }
      );
      if (parsedDecision.decision.disposition !== "selected") {
        throw new Error("the exact Demetri decision did not select an approach");
      }
    } catch (error) {
      return {
        event_type: "produce_approach_invalid",
        payload: {
          run_id: context.identity.run_id,
          approach_artifact_id: approach.artifact_id,
          decision_artifact_id: decision.artifact_id,
          failure_sha256: sha256(
            error instanceof Error ? error.message : "invalid approach or decision"
          ),
        },
        directive: this.terminal(
          context,
          "incomplete",
          false,
          ["exact Ida approach or Demetri decision is malformed"],
          undefined,
          { incomplete_reason: "malformed_exact_material" }
        ),
      };
    }
    // Approach and selection were checked above; they are host operands, not draft feedback.
    const requestValue = canonicalProduceRequest(store, context);
    const anchor = latestProductArtifact(context) ?? null;
    const previous = currentSealDiagnostic(context, store);
    let draftValue: ProducedArtifactDraftV2;
    try {
      if (this.checkpointer === undefined) throw new Error("produce checkpointer is absent");
      draftValue = parsePersistedProducedArtifactDraftV2(store.readById(draft.artifact_id), {
        request: requestValue,
        routingRepairSummary: acceptedRoutingRepairSummary({
          context,
          checkpointer: this.checkpointer,
          artifact: draft,
        }),
      }).draft;
    } catch (error) {
      if (
        !(error instanceof ProduceDraftValidationError) ||
        error.failureClass === "LINEAGE_INVALID"
      )
        throw error;
      const failureClass = error.failureClass;
      const attempt = sealAttempt({
        store,
        policy: runSealPolicy(context, PRODUCE_SEAL_POLICY),
        registered_policy_sha256: sealPolicySha256(runSealPolicy(context, PRODUCE_SEAL_POLICY)),
        run_id: context.identity.run_id,
        branch_id: null,
        phase: "sealing_artifact",
        draft_ref: draft,
        epoch_anchor_ref: anchor,
        previous_diagnostic_ref: previous?.ref ?? null,
        rejection_ordinal: previous?.diagnostic.rejection_ordinal ?? 0,
        project: () => ({
          status: "rejected",
          failure_class: failureClass,
          issues: error.issues.map((detail, index) => ({
            code: error.failureClass.toLowerCase(),
            path: `/issues/${index}`,
            detail:
              Buffer.byteLength(detail, "utf8") <= 512
                ? detail
                : "Draft validation issue exceeds display limit",
            source_ordinals: [],
          })),
        }),
        validate_product_bytes: () => {
          throw new Error("rejected draft cannot validate as a product");
        },
      });
      if (attempt.status !== "rejected") {
        throw new Error(
          `produce diagnostic host fault: ${attempt.status === "fault" ? attempt.code : "unexpected product"}`
        );
      }
      const added = addSelectedArtifact(context, attempt.diagnostic_ref);
      if (added) this.hostFault?.("sealing_artifact:feedback-persistence");
      if (attempt.diagnostic.disposition === "exhausted") {
        return {
          event_type: "produce_seal_repair_exhausted",
          payload: {
            run_id: context.identity.run_id,
            diagnostic_artifact_id: attempt.diagnostic_ref.artifact_id,
          },
          directive: this.terminal(
            context,
            "incomplete",
            false,
            [`seal repair exhausted: ${attempt.diagnostic.failure_class}`],
            undefined,
            {
              incomplete_reason: "seal_repair_exhausted",
              exhausted: true,
              exhaustion_reason: "seal_defect",
              output_kind: "rejected_draft",
              seal_diagnostics: sealDiagnosticsProjection(
                attempt.diagnostic,
                attempt.diagnostic_ref,
                runSealPolicy(context, PRODUCE_SEAL_POLICY)
              ),
            }
          ),
        };
      }
      context.transition("materializing_artifact");
      const next = this.dispatch(context);
      return {
        event_type: "produce_seal_repair_requested",
        payload: {
          run_id: context.identity.run_id,
          rejected_draft_artifact_id: draft.artifact_id,
          feedback_artifact_id: attempt.diagnostic_ref.artifact_id,
        },
        directive: next,
      };
    }
    const sealed = persistSealedProduct({
      context,
      store,
      request,
      approach,
      decision,
      draft,
      draftValue,
    });
    if (sealed.added) this.hostFault?.("sealing_artifact:artifact-persistence");
    if (this.checkpointer === undefined)
      throw new Error("mechanical checks checkpointer is absent");
    const checks = mechanicalCheckValue({ context, store, checkpointer: this.checkpointer });
    persistVersionedHostArtifact({
      context,
      store,
      phase: "sealing_artifact",
      branchId: "mechanical",
      kind: "produce-mechanical-checks",
      operationLabel: "mechanical-checks",
      producer: "host:produce-product-validator",
      contentSchema: { schema_id: "penny.produce-mechanical-checks.v1", schema_version: 1 },
      upstreamRefs: subjectRefs(currentSubject(context)),
      content: canonicalJson(checks),
    });
    context.transition("critiquing_artifact");
    const next = this.dispatch(context);
    return {
      event_type: "produce_artifact_sealed",
      payload: {
        run_id: context.identity.run_id,
        draft_artifact_id: draft.artifact_id,
        product_artifact_id: sealed.artifact.artifact_id,
      },
      directive: next,
    };
  }

  private terminalEffectEvidence(
    context: RunContext,
    supplied?: EffectEvidenceGraphV1
  ): EffectEvidenceGraphV1 {
    if (supplied !== undefined) return supplied;
    if (this.artifactStore !== undefined) {
      const validityRef = latestValidityReceipt(context);
      if (validityRef !== undefined) {
        return readCanonicalJson(this.artifactStore, validityRef, validateProduceValidityReceiptV2)
          .effect_evidence;
      }
      const qualityRef = latestQualityReceipt(context);
      if (qualityRef !== undefined) {
        return readCanonicalJson(this.artifactStore, qualityRef, validateProduceQualityReceiptV2)
          .effect_evidence;
      }
    }
    return unknownEffectEvidenceGraph({
      runId: context.identity.run_id,
      phases: PRODUCE_EFFECT_PHASES,
    });
  }

  private terminal(
    context: RunContext,
    action: "complete" | "incomplete" | "cancelled",
    met: boolean,
    unresolved: readonly string[],
    liveness?: LivenessSnapshotV1,
    extraResult: Readonly<Record<string, JsonValue>> = {},
    effectEvidence?: EffectEvidenceGraphV1
  ): Directive {
    const origin = context.stateId;
    const currentDiagnostic =
      !met && this.artifactStore !== undefined
        ? currentSealDiagnostic(context, this.artifactStore)
        : undefined;
    const output = met
      ? latestProductArtifact(context)
      : extraResult.incomplete_reason === "seal_repair_exhausted"
        ? latestDraftArtifact(context)
        : bestPartial(context);
    const effects = this.terminalEffectEvidence(context, effectEvidence);
    if (met && output === undefined) throw new Error("positive produce terminal has no product");
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
        ...(!met && output !== undefined
          ? {
              output_kind:
                output.kind === "semantic-core"
                  ? "accepted_product_best_partial"
                  : output.kind.endsWith("-draft")
                    ? "rejected_draft_best_partial"
                    : "unreviewed_best_partial",
            }
          : {}),
        ...(currentDiagnostic === undefined
          ? {}
          : {
              seal_diagnostics: sealDiagnosticsProjection(
                currentDiagnostic.diagnostic,
                currentDiagnostic.ref,
                runSealPolicy(context, PRODUCE_SEAL_POLICY)
              ),
            }),
        ...extraResult,
        effect_assurance: effects.assurance,
        effect_limitation: effects.limitations[0] ?? null,
        effect_scope_notice: BOUNDED_EFFECT_NOTICE,
        effect_evidence_sha256: effectEvidenceSha256(effects),
        effect_evidence: effects,
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
    const subject = currentSubject(context);
    const carren = latestReviewReport(context, "critiquing_artifact");
    const vera = latestReviewReport(context, "verifying_artifact");
    const quality = latestQualityReceipt(context);
    const validity = latestValidityReceipt(context);
    const integrity = latestIntegrityArtifact(context);
    const envelope = latestEnvelopeArtifact(context);
    if (
      carren === undefined ||
      vera === undefined ||
      quality === undefined ||
      validity === undefined ||
      integrity === undefined ||
      envelope === undefined
    ) {
      throw new Error("positive produce terminal graph is incomplete");
    }
    return uniqueRefs([
      ...subjectRefs(subject),
      carren,
      vera,
      quality,
      validity,
      integrity,
      envelope,
    ]);
  }
}

function expectedReceiptResult(
  input: Parameters<CompletionReceiptPredicateV1>[0],
  receipt: ProduceQualityReceiptV2 | ProduceValidityReceiptV2,
  state: ReviewState,
  agent: "carren" | "vera",
  verdict: "APPROVE" | "PASS"
): PhaseResult | undefined {
  const result = input.checkpointer.receiptResultById(receipt.execution_receipt_id);
  return result !== undefined &&
    result.run_id === input.context.identity.run_id &&
    result.state_id === state &&
    result.agent === agent &&
    result.details.verdict === verdict &&
    sha256(canonicalJson(result)) === receipt.execution_result_sha256
    ? result
    : undefined;
}

export function evaluateProduceLatestReviewedArtifactDod(
  input: Parameters<CompletionReceiptPredicateV1>[0]
): ReturnType<CompletionReceiptPredicateV1> {
  try {
    const reader = input.artifactReader;
    if (reader === undefined || input.originState !== "admitting_artifact") {
      return { passed: false, evidence_refs: [] };
    }
    const subject = currentSubject(input.context);
    if (
      subject.product.artifact_id !== input.latestProduct.product_id ||
      subject.product.content_digest !== input.latestProduct.sha256
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const request = canonicalProduceRequest(reader, input.context);
    const approach = parsePersistedArtifactApproach(reader.readById(subject.approach.artifact_id), {
      routingRepairSummary: acceptedRoutingRepairSummary({
        context: input.context,
        checkpointer: input.checkpointer,
        artifact: subject.approach,
      }),
    }).approach;
    const decision = parsePersistedArtifactApproachDecision(
      reader.readById(subject.decision.artifact_id),
      {
        approach,
        routingRepairSummary: acceptedRoutingRepairSummary({
          context: input.context,
          checkpointer: input.checkpointer,
          artifact: subject.decision,
        }),
      }
    ).decision;
    if (decision.disposition !== "selected") return { passed: false, evidence_refs: [] };
    const draft = parsePersistedProducedArtifactDraftV2(
      reader.readById(subject.draft.artifact_id),
      {
        request,
        routingRepairSummary: acceptedRoutingRepairSummary({
          context: input.context,
          checkpointer: input.checkpointer,
          artifact: subject.draft,
        }),
      }
    ).draft;
    const product = validateCanonicalProducedArtifactV2Bytes(
      reader.readById(subject.product.artifact_id),
      subject.product
    );
    assertProducedArtifactLineageV2({
      product,
      request,
      draft,
      requestRef: subject.request,
      approachRef: subject.approach,
      decisionRef: subject.decision,
      draftRef: subject.draft,
      effectEvidence: product.effect_evidence,
    });
    const qualityRef = latestQualityReceipt(input.context);
    const validityRef = latestValidityReceipt(input.context);
    const integrityRef = latestIntegrityArtifact(input.context);
    const envelopeRef = latestEnvelopeArtifact(input.context);
    if (
      qualityRef === undefined ||
      validityRef === undefined ||
      integrityRef === undefined ||
      envelopeRef === undefined
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const quality = readCanonicalJson(reader, qualityRef, validateProduceQualityReceiptV2);
    const validity = readCanonicalJson(reader, validityRef, validateProduceValidityReceiptV2);
    const integrity = readCanonicalJson(reader, integrityRef, validateProduceProductIntegrityV2);
    const envelope = readCanonicalJson(reader, envelopeRef, validateProduceProductEnvelopeV2);
    verifyMechanicalChecks({
      context: input.context,
      store: reader,
      checkpointer: input.checkpointer,
    });
    for (const [state, report, receipt] of [
      ["critiquing_artifact", quality.carren_report_ref, quality],
      ["verifying_artifact", validity.vera_report_ref, validity],
    ] as const) {
      if (canonicalJson(report) !== canonicalJson(latestReviewReport(input.context, state)))
        return { passed: false, evidence_refs: [] };
      const group = exactAcceptedExecutionGroup({
        context: input.context,
        checkpointer: input.checkpointer,
        artifact: report,
      });
      if (group.routed.worker_receipt.receipt_id !== receipt.execution_receipt_id)
        return { passed: false, evidence_refs: [] };
      checkedReview({
        context: input.context,
        store: reader,
        checkpointer: input.checkpointer,
        ...(input.verifyExecutionReceipt === undefined
          ? {}
          : { verifyExecutionReceipt: input.verifyExecutionReceipt }),
        state,
        report,
        details: group.routed.details,
        confidence: group.routed.confidence,
        executionGroup: group,
      });
    }
    const expectedExecutionReceiptIds = exactExecutionReceiptIds({
      context: input.context,
      checkpointer: input.checkpointer,
      artifacts: [
        subject.approach,
        subject.decision,
        subject.draft,
        quality.carren_report_ref,
        validity.vera_report_ref,
      ],
    });
    const qualityExecution = expectedReceiptResult(
      input,
      quality,
      "critiquing_artifact",
      "carren",
      "APPROVE"
    );
    const validityExecution = expectedReceiptResult(
      input,
      validity,
      "verifying_artifact",
      "vera",
      "PASS"
    );
    if (
      canonicalJson(quality.request_ref) !== canonicalJson(subject.request) ||
      canonicalJson(quality.approach_ref) !== canonicalJson(subject.approach) ||
      canonicalJson(quality.decision_ref) !== canonicalJson(subject.decision) ||
      canonicalJson(quality.draft_ref) !== canonicalJson(subject.draft) ||
      canonicalJson(quality.product_ref) !== canonicalJson(subject.product) ||
      canonicalJson(validity.request_ref) !== canonicalJson(subject.request) ||
      canonicalJson(validity.approach_ref) !== canonicalJson(subject.approach) ||
      canonicalJson(validity.decision_ref) !== canonicalJson(subject.decision) ||
      canonicalJson(validity.draft_ref) !== canonicalJson(subject.draft) ||
      canonicalJson(validity.product_ref) !== canonicalJson(subject.product) ||
      canonicalJson(validity.carren_report_ref) !== canonicalJson(quality.carren_report_ref) ||
      canonicalJson(validity.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(integrity.request_ref) !== canonicalJson(subject.request) ||
      canonicalJson(integrity.approach_ref) !== canonicalJson(subject.approach) ||
      canonicalJson(integrity.decision_ref) !== canonicalJson(subject.decision) ||
      canonicalJson(integrity.draft_ref) !== canonicalJson(subject.draft) ||
      canonicalJson(integrity.product_ref) !== canonicalJson(subject.product) ||
      canonicalJson(integrity.carren_report_ref) !== canonicalJson(quality.carren_report_ref) ||
      canonicalJson(integrity.vera_report_ref) !== canonicalJson(validity.vera_report_ref) ||
      canonicalJson(integrity.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(integrity.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(integrity.execution_receipt_ids) !==
        canonicalJson(expectedExecutionReceiptIds) ||
      envelope.run_id !== input.context.identity.run_id ||
      canonicalJson(envelope.request_ref) !== canonicalJson(subject.request) ||
      canonicalJson(envelope.approach_ref) !== canonicalJson(subject.approach) ||
      canonicalJson(envelope.decision_ref) !== canonicalJson(subject.decision) ||
      canonicalJson(envelope.draft_ref) !== canonicalJson(subject.draft) ||
      canonicalJson(envelope.product_ref) !== canonicalJson(subject.product) ||
      canonicalJson(envelope.carren_report_ref) !== canonicalJson(quality.carren_report_ref) ||
      canonicalJson(envelope.vera_report_ref) !== canonicalJson(validity.vera_report_ref) ||
      canonicalJson(envelope.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(envelope.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(envelope.integrity_ref) !== canonicalJson(integrityRef) ||
      qualityExecution === undefined ||
      validityExecution === undefined ||
      qualityExecution.worker_receipt.ended_at !== quality.created_at ||
      validityExecution.worker_receipt.ended_at !== validity.created_at ||
      product.effect_evidence.assurance === "policy_violation" ||
      quality.effect_evidence.assurance === "policy_violation" ||
      canonicalJson(validity.effect_evidence) !== canonicalJson(quality.effect_evidence) ||
      canonicalJson(integrity.effect_evidence) !== canonicalJson(quality.effect_evidence) ||
      canonicalJson(envelope.effect_evidence) !== canonicalJson(quality.effect_evidence) ||
      integrity.product_effect_evidence_sha256 !== effectEvidenceSha256(product.effect_evidence) ||
      input.terminal.result.effect_assurance !== quality.effect_evidence.assurance ||
      input.terminal.result.effect_evidence_sha256 !==
        effectEvidenceSha256(quality.effect_evidence) ||
      canonicalJson(input.terminal.result.effect_evidence) !==
        canonicalJson(quality.effect_evidence) ||
      input.terminal.result.effect_limitation !==
        (quality.effect_evidence.limitations[0] ?? null) ||
      input.terminal.result.effect_scope_notice !== BOUNDED_EFFECT_NOTICE ||
      (quality.effect_evidence.assurance === "unknown" &&
        input.terminal.result.effect_limitation !== UNKNOWN_EFFECT_LIMITATION) ||
      canonicalJson(input.terminal.result.output_artifact_ref) !== canonicalJson(subject.product) ||
      input.terminal.unresolved.length !== 0
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const expectedRefs = [
      ...subjectRefs(subject),
      quality.carren_report_ref,
      validity.vera_report_ref,
      qualityRef,
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
      input.verifyExecutionReceipt?.(result.worker_receipt);
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

export const PRODUCE_COMPLETION_RECEIPT_PREDICATES: ReadonlyMap<
  string,
  CompletionReceiptPredicateV1
> = new Map([
  ["produce_latest_reviewed_artifact_dod.v1", evaluateProduceLatestReviewedArtifactDod],
]);

/** Registration-only pure view. No product/review writes and no completion authority. */
function produceReviewProjector(state: ReviewState): PhaseResultProjectorV1 {
  return {
    declaration: {
      schema_id: "penny.produce-review-semantic-projection.v1",
      schema_version: 1,
      registration_name: PRODUCE_PLAYBOOK_NAME,
      state_id: state,
      agent: PRODUCE_AGENT_BY_STATE[state],
      result_schema_id:
        state === "critiquing_artifact"
          ? "penny.produce.quality-review-summary.v1"
          : "penny.produce.validity-review-summary.v1",
      result_schema_version: 1,
    },
    project: ({ bytes, source, inputArtifacts, artifacts }) => {
      const runId = source.run_id;
      if (
        bytes.length === 0 ||
        bytes.length > MAX_PERSISTED_PRODUCE_DRAFT_BYTES ||
        source.kind !== "agent-output" ||
        source.phase !== state ||
        source.branch_id !== null ||
        source.producer !== `agent:${PRODUCE_AGENT_BY_STATE[state]}` ||
        source.byte_length !== bytes.length ||
        source.content_digest !== sha256(bytes) ||
        canonicalJson(artifacts.refById(source.artifact_id)) !== canonicalJson(source)
      ) {
        throw new Error("Produce review projection source custody mismatch");
      }
      const refs = inputArtifacts.artifacts
        .filter((binding) => binding.designation !== "context")
        .map((binding) => binding.ref);
      const one = (predicate: (ref: ArtifactRef) => boolean): ArtifactRef => {
        const matches = refs.filter(predicate);
        const ref = matches[0];
        if (
          matches.length !== 1 ||
          ref === undefined ||
          ref.run_id !== runId ||
          ref.branch_id !== (ref.kind === "produce-mechanical-checks" ? "mechanical" : null) ||
          canonicalJson(artifacts.refById(ref.artifact_id)) !== canonicalJson(ref)
        ) {
          throw new Error("Produce review projection operand custody mismatch");
        }
        const bytes = artifacts.readById(ref.artifact_id);
        if (bytes.length !== ref.byte_length || sha256(bytes) !== ref.content_digest)
          throw new Error("Produce review operand byte custody mismatch");
        return ref;
      };
      const productRef = one(
        (ref) =>
          ref.kind === "semantic-core" &&
          ref.phase === "sealing_artifact" &&
          ref.producer === "host:artifact-sealer" &&
          ref.content_schema?.schema_id === "penny.produced-artifact.v2" &&
          ref.content_schema.schema_version === 2
      );
      const product = validateCanonicalProducedArtifactV2Bytes(
        artifacts.readById(productRef.artifact_id),
        productRef
      );
      if (product.effect_evidence.run_id !== runId) throw new Error("Produce product run mismatch");
      const requestRef = one(
        (ref) =>
          ref.kind === "produce-request" &&
          ref.phase === "intake" &&
          ref.producer === "host:request-admission" &&
          ref.content_schema?.schema_id === "penny.produce-request.v1" &&
          ref.content_schema.schema_version === 1
      );
      const approachRef = one(
        (ref) =>
          ref.kind === "artifact-approach" &&
          ref.phase === "exploring_artifact_approaches" &&
          ref.producer === "agent:ida" &&
          ref.content_schema?.schema_id === "penny.artifact-approach.v1" &&
          ref.content_schema.schema_version === 1
      );
      const decisionRef = one(
        (ref) =>
          ref.kind === "artifact-approach-decision" &&
          ref.phase === "selecting_artifact_approach" &&
          ref.producer === "agent:demetri" &&
          ref.content_schema?.schema_id === "penny.artifact-approach-decision.v1" &&
          ref.content_schema.schema_version === 1
      );
      const draftRef = one(
        (ref) =>
          ref.kind === "produced-artifact-draft" &&
          ref.phase === "materializing_artifact" &&
          ref.producer === "agent:skribble" &&
          ref.content_schema?.schema_id === "penny.produced-artifact-draft.v2" &&
          ref.content_schema.schema_version === 2
      );
      if (
        product.source_lineage.request_artifact_id !== requestRef.artifact_id ||
        product.source_lineage.request_artifact_sha256 !== requestRef.content_digest ||
        product.source_lineage.approach_artifact_id !== approachRef.artifact_id ||
        product.source_lineage.approach_artifact_sha256 !== approachRef.content_digest ||
        product.source_lineage.decision_artifact_id !== decisionRef.artifact_id ||
        product.source_lineage.decision_artifact_sha256 !== decisionRef.content_digest ||
        product.source_lineage.draft_artifact_id !== draftRef.artifact_id ||
        product.source_lineage.draft_artifact_sha256 !== draftRef.content_digest
      )
        throw new Error("Produce review product/source lineage mismatch");
      let hostCheckRef: ArtifactRef | undefined;
      if (state === "verifying_artifact") {
        hostCheckRef = one((ref) => ref.kind === "produce-mechanical-checks");
        if (
          hostCheckRef.phase !== "sealing_artifact" ||
          hostCheckRef.branch_id !== "mechanical" ||
          hostCheckRef.producer !== "host:produce-product-validator" ||
          hostCheckRef.content_schema?.schema_id !== "penny.produce-mechanical-checks.v1" ||
          hostCheckRef.content_schema.schema_version !== 1
        )
          throw new Error("Produce host check role mismatch");
        const checks = readCanonicalJson(artifacts, hostCheckRef, validateProduceMechanicalChecks);
        const expected = validateProduceMechanicalChecks({
          schema_id: "penny.produce-mechanical-checks.v1",
          schema_version: 1,
          status: "PASS",
          run_id: runId,
          request_ref: requestRef,
          approach_ref: approachRef,
          decision_ref: decisionRef,
          draft_ref: draftRef,
          product_ref: productRef,
          checks: [...PRODUCE_MECHANICAL_CHECK_NAMES],
          product_effect_evidence_sha256: effectEvidenceSha256(product.effect_evidence),
          scope: "host_mechanical_only_not_semantic_or_effect_absence",
        });
        if (canonicalJson(checks) !== canonicalJson(expected)) {
          throw new Error("Produce projection host/product bindings disagree");
        }
      }
      const { core } = parsePersistedProduceReview(bytes, {
        state,
        productRef,
        ...(hostCheckRef === undefined ? {} : { hostCheckRef }),
      });
      return { confidence: core.confidence, details: core.review };
    },
  };
}

export const PRODUCE_PLAYBOOK_REGISTRATION: PlaybookRegistration = {
  name: PRODUCE_PLAYBOOK_NAME,
  repair_progress_policy: "exact_fingerprint_v1",
  seal_policy: PRODUCE_SEAL_POLICY,
  contract: PRODUCE_SKILL_CONTRACT,
  ingress: "skill",
  start_admission: PRODUCE_START_ADMISSION,
  caller_documentation: {
    constraints_schema: ProduceRequestConstraintsV1Schema,
    example: {
      goal: "Produce a short project note.",
      constraints: {
        schema_version: 1,
        output_name: "note.md",
        artifact_kind: "markdown",
        specification: [{ statement: "Write one concise note." }],
        source_material: [{ statement: "The project starts Tuesday.", source_label: "brief" }],
        acceptance_criteria: [{ statement: "State the start date." }],
        hard_constraints: [],
        non_goals: [],
        known_uncertainties: [],
      },
    },
    semantic_caveat: "Produces content only; it does not write, execute, test, or publish it.",
  },
  liveness: {
    resolver_id: "produceLivenessPolicy",
    resolve: () => PRODUCE_LIVENESS_POLICY,
    thinking_policy: "agent_ssot",
  },
  host_states: ["sealing_artifact", "admitting_artifact"],
  worker: {
    kind: "catalog-agent",
    workflow_name: PRODUCE_PLAYBOOK_NAME,
    guidance: PRODUCE_SKILL_CONTRACT.guidance,
    guidance_required: true,
    result_transport: "persisted_summary",
    opening_policy: "registration_guidance_task_artifacts",
    model_policy: "directive_override_or_runtime_default",
    phases: new Map([
      [
        "exploring_artifact_approaches",
        {
          agent: "ida",
          result_schema_id: "penny.produce.approach-summary.v1",
          result_schema_version: 1,
          schema: StageCompleteSummarySchema,
        },
      ],
      [
        "selecting_artifact_approach",
        {
          agent: "demetri",
          result_schema_id: "penny.produce.approach-decision-summary.v1",
          result_schema_version: 1,
          schema: ApproachDecisionSummarySchema,
        },
      ],
      [
        "materializing_artifact",
        {
          agent: "skribble",
          result_schema_id: "penny.produce.materialization-summary.v1",
          result_schema_version: 1,
          schema: StageCompleteSummarySchema,
        },
      ],
      [
        "critiquing_artifact",
        {
          agent: "carren",
          result_schema_id: "penny.produce.quality-review-summary.v1",
          result_schema_version: 1,
          schema: ProduceQualityReviewSummaryV1Schema,
          result_projection: produceReviewProjector("critiquing_artifact"),
        },
      ],
      [
        "verifying_artifact",
        {
          agent: "vera",
          result_schema_id: "penny.produce.validity-review-summary.v1",
          result_schema_version: 1,
          schema: ProduceValidityReviewSummaryV1Schema,
          result_projection: produceReviewProjector("verifying_artifact"),
        },
      ],
    ]),
  },
  completionReceiptPredicates: PRODUCE_COMPLETION_RECEIPT_PREDICATES,
  construct: (options) =>
    new ProducePlaybook(
      options.artifactRevisions,
      options.artifactStore,
      options.checkpointer,
      undefined,
      options.effectEvidenceProvider,
      options.verifyExecutionReceipt
    ),
};
