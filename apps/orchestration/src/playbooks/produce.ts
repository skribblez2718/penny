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
  artifactApproachPromptContract,
  assertProducedArtifactLineage,
  canonicalizeProduceRequest,
  parsePersistedArtifactApproach,
  parsePersistedProducedArtifactDraft,
  produceProductEnvelopeId,
  produceProductIntegrityId,
  produceQualityReceiptId,
  produceRequestConstraints,
  produceValidityReceiptId,
  producedArtifactDraftPromptContract,
  sealProducedArtifact,
  validateCanonicalProducedArtifactBytes,
  validateProduceProductEnvelope,
  validateProduceProductIntegrity,
  validateProduceQualityReceipt,
  validateProduceRequest,
  validateProduceSealFeedback,
  validateProduceValidityReceipt,
  ProduceDraftValidationError,
  type ProduceProductEnvelopeV1,
  type ProduceProductIntegrityV1,
  type ProduceQualityReceiptV1,
  type ProduceRequestV1,
  type ProduceValidityReceiptV1,
  type ProducedArtifactDraftV1,
} from "../skill-contracts/produce.js";
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

export const PRODUCE_PLAYBOOK_NAME = "produce";

export const PRODUCE_AGENT_BY_STATE = {
  exploring_artifact_approaches: "ida",
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
    ["exploring_artifact_approaches", "materializing_artifact"],
    ["materializing_artifact", "sealing_artifact"],
    ["sealing_artifact", "materializing_artifact"],
    ["sealing_artifact", "critiquing_artifact"],
    ["critiquing_artifact", "materializing_artifact"],
    ["critiquing_artifact", "verifying_artifact"],
    ["verifying_artifact", "exploring_artifact_approaches"],
    ["verifying_artifact", "materializing_artifact"],
    ["verifying_artifact", "admitting_artifact"],
    ["admitting_artifact", "complete"],
  ],
} as const;

export const PRODUCE_LIVENESS_POLICY = {
  schema_version: 1,
  scope: "orchestrated-produce-candidate",
  preset: "bounded-external-non-mutating-v1",
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
const FindingsSchema = Type.Array(FindingSchema, { maxItems: 32 });
const EvidenceSchema = Type.Array(FindingSchema, { minItems: 1, maxItems: 64 });
const StrategyDeltaSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const StageCompleteSummarySchema = Type.Object(
  { complete: Type.Literal(true) },
  { additionalProperties: false }
);
const QualityFindingSchema = Type.Object(
  {
    severity: Type.Union([Type.Literal("minor"), Type.Literal("major"), Type.Literal("critical")]),
    message: FindingSchema,
  },
  { additionalProperties: false }
);
const MinorQualityFindingSchema = Type.Object(
  { severity: Type.Literal("minor"), message: FindingSchema },
  { additionalProperties: false }
);

const QualitySummarySchema = Type.Union([
  Type.Object(
    {
      verdict: Type.Literal("APPROVE"),
      gap_kind: Type.Literal("none"),
      repair_owner: Type.Literal("none"),
      findings: Type.Array(MinorQualityFindingSchema, { maxItems: 32 }),
      evidence: EvidenceSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      verdict: Type.Literal("FAIL"),
      gap_kind: Type.Literal("quality_gap"),
      repair_owner: Type.Literal("skribble"),
      findings: Type.Array(QualityFindingSchema, { minItems: 1, maxItems: 32 }),
      evidence: EvidenceSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  ),
]);

function validityFailureSchema(
  gapKind: "brief_gap" | "artifact_product_gap",
  owner: "ida" | "skribble"
) {
  return Type.Object(
    {
      verdict: Type.Literal("FAIL"),
      gap_kind: Type.Literal(gapKind),
      repair_owner: Type.Literal(owner),
      findings: Type.Array(FindingSchema, { minItems: 1, maxItems: 32 }),
      evidence: EvidenceSchema,
      strategy_delta: StrategyDeltaSchema,
    },
    { additionalProperties: false }
  );
}

const ValiditySummarySchema = Type.Union([
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
  validityFailureSchema("brief_gap", "ida"),
  validityFailureSchema("artifact_product_gap", "skribble"),
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
  release_status: "candidate",
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
        schema_id: "penny.produced-artifact.v1",
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
    skill_root: ".pi/skills/produce/assets/prompts",
    resolution: "per_agent_phase",
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
      "materializing_artifact",
      "sealing_artifact",
      "critiquing_artifact",
      "verifying_artifact",
      "admitting_artifact",
    ],
    required_receipt_predicates: ["produce_latest_reviewed_artifact_dod.v1"],
    latest_product: {
      selector: "terminal_artifact",
      schema_id: "penny.produced-artifact.v1",
      product_schema_version: 1,
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

function latestDraftArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "produced-artifact-draft" && artifact.phase === "materializing_artifact"
  );
}

function latestProductArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "semantic-core" &&
      artifact.phase === "sealing_artifact" &&
      artifact.content_schema?.schema_id === "penny.produced-artifact.v1" &&
      artifact.content_schema.schema_version === 1
  );
}

function latestReviewReport(context: RunContext, state: ReviewState): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "agent-output" && artifact.phase === state
  );
}

function latestSealFeedbackArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "produce-seal-feedback" && artifact.phase === "sealing_artifact"
  );
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
      : state === "materializing_artifact"
        ? {
            artifactKind: "produced-artifact-draft",
            mediaType: "text/plain; charset=utf-8",
            contentSchema: { schema_id: "penny.produced-artifact-draft.v1", schema_version: 1 },
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
  const draft = latestDraftArtifact(context);
  const product = latestProductArtifact(context);
  const carren = latestReviewReport(context, "critiquing_artifact");
  const vera = latestReviewReport(context, "verifying_artifact");
  if (state === "exploring_artifact_approaches") {
    return context.previousState === "verifying_artifact"
      ? uniqueRefs([request, approach, draft, product, carren, vera])
      : [request];
  }
  if (approach === undefined) {
    throw new Error(`${state} requires the exact latest Ida artifact approach`);
  }
  if (state === "materializing_artifact") {
    return uniqueRefs([
      request,
      approach,
      draft,
      product,
      carren,
      vera,
      latestSealFeedbackArtifact(context),
    ]);
  }
  if (draft === undefined || product === undefined) {
    throw new Error(`${state} requires the exact latest draft and sealed ProducedArtifactV1`);
  }
  const subject = [request, approach, draft, product];
  if (state === "critiquing_artifact") return subject;
  if (carren === undefined) throw new Error("Vera requires the exact current Carren report");
  return [...subject, carren];
}

function slotForRef(ref: ArtifactRef): string {
  if (ref.kind === "produce-request") return "produce-request";
  if (ref.kind === "artifact-approach") return "latest-artifact-approach";
  if (ref.kind === "produced-artifact-draft") return "latest-produced-artifact-draft";
  if (ref.kind === "produce-seal-feedback") return "produce-seal-feedback";
  if (ref.content_schema?.schema_id === "penny.produced-artifact.v1") {
    return "latest-produced-artifact";
  }
  if (ref.phase === "critiquing_artifact") return "latest-carren-report";
  if (ref.phase === "verifying_artifact") return "latest-vera-report";
  return `input-${ref.artifact_id.slice(-12)}`;
}

function taskForState(context: RunContext, state: ProduceWorkerState): string {
  const boundary =
    "artifact_read is mandatory for every needed exact workflow predecessor in input_artifacts; continue through next_range. No other tool or channel may substitute for a missing predecessor ref: never discover predecessor output through memory, /tmp, repository search, historical sessions, or name-only pointers. Other tools in the assigned catalog agent's YAML surface may be used only when materially relevant, permitted by the caller and task, and within this phase's consequence boundary; they do not authorize filesystem mutation or external action. Return complete stage content before one final SUMMARY. The owner captures and re-reads bytes; do not claim persistence. Use supplied inline material as supplied, not as independently verified fact. Do not execute tests, compile, run, write files, mutate, browse, fetch, or perform external actions.";
  switch (state) {
    case "exploring_artifact_approaches":
      return [
        boundary,
        `MECHANICALLY_PROJECTED_ARTIFACT_APPROACH_CONTRACT:${artifactApproachPromptContract()}`,
        "Explore two to four genuinely different ways to satisfy the exact artifact brief, compare concrete tradeoffs, and recommend one. Do not author any final artifact content. On brief-gap repair, replace the approach set using Vera's exact current findings.",
      ].join("\n\n");
    case "materializing_artifact":
      return [
        boundary,
        `MECHANICALLY_PROJECTED_PRODUCED_ARTIFACT_DRAFT_CONTRACT:${producedArtifactDraftPromptContract()}`,
        "Materialize one complete replacement ProducedArtifactDraftV1 from the exact request and latest Ida recommendation. Cover every exact request item. A truthful not_applicable is permitted only when required supplied material is absent or the exact constraints make production impossible; explain why and emit empty content. Never claim syntax, compilation, execution, tests, writes, or external checks. Repair all applicable Carren, Vera, or seal-feedback findings in one replacement draft.",
      ].join("\n\n");
    case "critiquing_artifact":
      return [
        boundary,
        "Subjectively review the exact latest host-sealed ProducedArtifactV1 against the exact brief, Ida approach, and Skribble draft. Judge fitness for purpose, coherence, clarity, usefulness, restraint, quality of not_applicable reasoning, and whether the artifact actually feels complete. Do not repair it.",
        "APPROVE only when no major or critical quality defect remains. FAIL uses quality_gap/skribble. Never emit a target state.",
      ].join("\n\n");
    case "verifying_artifact":
      return [
        boundary,
        "Independently verify objective correctness and compliance of the exact latest ProducedArtifactV1 against the exact request, Ida approach, Skribble draft, and current Carren report. Recompute request coverage, media type, content hash, JSON parse/canonicality when applicable, not_applicable emptiness, no-action flags, exact request/draft/source lineage, and ref roles. Treat Carren as prior context, not authority. Do not repair the product.",
        "PASS only when every objective check holds. FAIL uses brief_gap/ida when the approach or brief treatment must be reconsidered, or artifact_product_gap/skribble when the draft/product must change. Never emit a target state.",
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

function persistSealFeedback(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly draft: ArtifactRef;
  readonly failure: ProduceDraftValidationError;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  if (input.failure.failureClass === "LINEAGE_INVALID") {
    throw new Error("Produce draft lineage failures are not model-correctable");
  }
  const feedback = validateProduceSealFeedback({
    schema_id: "penny.produce-seal-feedback.v1",
    schema_version: 1,
    attempt: 1,
    rejected_draft_artifact_id: input.draft.artifact_id,
    failure_class: input.failure.failureClass,
    issues: input.failure.issues,
  });
  const operationId = `produce-seal-feedback:${sha256(input.context.identity.run_id).slice(0, 32)}`;
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: "sealing_artifact",
    branch_id: null,
    kind: "produce-seal-feedback",
    operation_id: operationId,
    version: 1,
    producer: "host:artifact-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.produce-seal-feedback.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [input.draft],
  };
  const content = canonicalJson(feedback);
  const existing = input.store.refFor(
    input.context.identity.run_id,
    "sealing_artifact",
    null,
    "produce-seal-feedback",
    operationId,
    1
  );
  const artifact = existing ?? input.store.persist({ metadata, content });
  if (
    canonicalJson(input.store.metadata(artifact)) !== canonicalJson(metadata) ||
    input.store.readById(artifact.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("ProduceSealFeedbackV1 deterministic persistence diverged");
  }
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined) throw new Error("ProduceSealFeedbackV1 manifest re-read failed");
  input.store.select(reread);
  return { artifact: reread, added: addSelectedArtifact(input.context, reread) };
}

function persistSealedProduct(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly request: ArtifactRef;
  readonly approach: ArtifactRef;
  readonly draft: ArtifactRef;
  readonly draftValue: ProducedArtifactDraftV1;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const product = sealProducedArtifact({
    request: canonicalProduceRequest(input.store, input.context),
    draft: input.draftValue,
    requestRef: input.request,
    approachRef: input.approach,
    draftRef: input.draft,
  });
  const content = canonicalJson(product);
  const upstreamRefs = [input.request, input.approach, input.draft];
  const operationId = `sealed-produced-artifact:${sha256(input.context.identity.run_id).slice(0, 32)}`;
  const parent = latestProductArtifact(input.context);
  const storedVersion = input.store.lastVersion(
    input.context.identity.run_id,
    "sealing_artifact",
    null,
    "semantic-core",
    operationId
  );
  const interrupted =
    storedVersion === 0
      ? null
      : input.store.refFor(
          input.context.identity.run_id,
          "sealing_artifact",
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
    validateCanonicalProducedArtifactBytes(
      input.store.readById(interrupted.artifact_id),
      interrupted
    );
    return { artifact: interrupted, added: addSelectedArtifact(input.context, interrupted) };
  }
  const version = Math.max(parent?.version ?? 0, storedVersion) + 1;
  const parentRef =
    version === 1
      ? null
      : input.store.refFor(
          input.context.identity.run_id,
          "sealing_artifact",
          null,
          "semantic-core",
          operationId,
          version - 1
        );
  if (version > 1 && parentRef === null) {
    throw new Error("ProducedArtifactV1 revision chain is missing its preceding product");
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: "sealing_artifact",
    branch_id: null,
    kind: "semantic-core",
    operation_id: operationId,
    version,
    producer: "host:artifact-sealer",
    media_type: "application/json",
    content_schema: { schema_id: "penny.produced-artifact.v1", schema_version: 1 },
    parent_ref: parentRef,
    upstream_refs: upstreamRefs,
  };
  const orphan = input.store.refFor(
    input.context.identity.run_id,
    "sealing_artifact",
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
    throw new Error("ProducedArtifactV1 diverged from deterministic host sealing");
  }
  const reread = input.store.refById(artifact.artifact_id);
  if (reread === undefined) throw new Error("ProducedArtifactV1 failed manifest re-read");
  input.store.select(reread);
  validateCanonicalProducedArtifactBytes(input.store.readById(reread.artifact_id), reread);
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
  const expectedAgent = input.artifact.producer.startsWith("agent:")
    ? input.artifact.producer.slice("agent:".length)
    : undefined;
  if (expectedAgent === undefined || expectedAgent.length === 0) {
    throw new Error(`produce artifact '${input.artifact.artifact_id}' has no agent producer`);
  }
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
        matches.push({ routed: repair, receiptIds: [sourceId, repairId] });
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

interface ProduceSubjectV1 {
  readonly request: ArtifactRef;
  readonly approach: ArtifactRef;
  readonly draft: ArtifactRef;
  readonly product: ArtifactRef;
}

function currentSubject(context: RunContext): ProduceSubjectV1 {
  const request = admittedProduceRequestArtifact(context);
  const approach = latestApproachArtifact(context);
  const draft = latestDraftArtifact(context);
  const product = latestProductArtifact(context);
  if (approach === undefined || draft === undefined || product === undefined) {
    throw new Error("latest produce subject is incomplete");
  }
  return { request, approach, draft, product };
}

function subjectRefs(subject: ProduceSubjectV1): readonly ArtifactRef[] {
  return [subject.request, subject.approach, subject.draft, subject.product];
}

function acceptedReviewEvidence(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly state: ReviewState;
  readonly verdict: "APPROVE" | "PASS";
  readonly subject: ProduceSubjectV1;
  readonly carrenReport?: ArtifactRef;
}):
  | {
      readonly report: ArtifactRef;
      readonly result: PhaseResult;
      readonly receiptIds: readonly string[];
    }
  | undefined {
  const expectedUpstreams = [
    ...subjectRefs(input.subject),
    ...(input.carrenReport === undefined ? [] : [input.carrenReport]),
  ];
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
      source.run_id !== input.context.identity.run_id ||
      routed.run_id !== input.context.identity.run_id ||
      source.state_id !== input.state ||
      source.agent !== PRODUCE_AGENT_BY_STATE[input.state] ||
      routed.details.verdict !== input.verdict ||
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

function matchingQualityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly subject: ProduceSubjectV1;
}): { readonly artifact: ArtifactRef; readonly value: ProduceQualityReceiptV1 } | undefined {
  const artifact = latestQualityReceipt(input.context);
  if (artifact === undefined) return undefined;
  const value = readCanonicalJson(input.store, artifact, validateProduceQualityReceipt);
  return value.product_ref.artifact_id === input.subject.product.artifact_id &&
    value.approach_ref.artifact_id === input.subject.approach.artifact_id &&
    value.draft_ref.artifact_id === input.subject.draft.artifact_id
    ? { artifact, value }
    : undefined;
}

function matchingValidityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly subject: ProduceSubjectV1;
  readonly quality: ArtifactRef;
}): { readonly artifact: ArtifactRef; readonly value: ProduceValidityReceiptV1 } | undefined {
  const artifact = latestValidityReceipt(input.context);
  if (artifact === undefined) return undefined;
  const value = readCanonicalJson(input.store, artifact, validateProduceValidityReceipt);
  return value.product_ref.artifact_id === input.subject.product.artifact_id &&
    value.approach_ref.artifact_id === input.subject.approach.artifact_id &&
    value.draft_ref.artifact_id === input.subject.draft.artifact_id &&
    value.quality_receipt_ref.artifact_id === input.quality.artifact_id
    ? { artifact, value }
    : undefined;
}

function ensureQualityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: ProduceQualityReceiptV1;
  readonly added: boolean;
} {
  const subject = currentSubject(input.context);
  const existing = matchingQualityReceipt({ ...input, subject });
  if (existing !== undefined) return { ...existing, added: false };
  const evidence = acceptedReviewEvidence({
    ...input,
    state: "critiquing_artifact",
    verdict: "APPROVE",
    subject,
  });
  if (evidence === undefined) throw new Error("latest-product Carren APPROVE is absent");
  const body: Omit<ProduceQualityReceiptV1, "receipt_id"> = {
    schema_id: "penny.produce-quality-receipt.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    verdict: "APPROVE",
    reviewer: "carren",
    request_ref: subject.request,
    approach_ref: subject.approach,
    draft_ref: subject.draft,
    product_ref: subject.product,
    carren_report_ref: evidence.report,
    execution_receipt_id: evidence.result.worker_receipt.receipt_id,
    execution_result_sha256: sha256(canonicalJson(evidence.result)),
    created_at: evidence.result.worker_receipt.ended_at,
    external_actions_performed: false,
    filesystem_writes_performed: false,
    tests_executed: false,
    minted_by: "host:produce-receipt-authority",
  };
  const value = validateProduceQualityReceipt({
    ...body,
    receipt_id: produceQualityReceiptId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_artifact",
    branchId: "quality",
    kind: "produce-quality-receipt",
    operationLabel: "quality-receipt",
    producer: "host:produce-receipt-authority",
    contentSchema: { schema_id: "penny.produce-quality-receipt.v1", schema_version: 1 },
    upstreamRefs: [...subjectRefs(subject), evidence.report],
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function ensureValidityReceipt(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly quality: { readonly artifact: ArtifactRef; readonly value: ProduceQualityReceiptV1 };
}): {
  readonly artifact: ArtifactRef;
  readonly value: ProduceValidityReceiptV1;
  readonly added: boolean;
} {
  const subject = currentSubject(input.context);
  const existing = matchingValidityReceipt({
    context: input.context,
    store: input.store,
    subject,
    quality: input.quality.artifact,
  });
  if (existing !== undefined) return { ...existing, added: false };
  const evidence = acceptedReviewEvidence({
    context: input.context,
    store: input.store,
    checkpointer: input.checkpointer,
    state: "verifying_artifact",
    verdict: "PASS",
    subject,
    carrenReport: input.quality.value.carren_report_ref,
  });
  if (evidence === undefined) throw new Error("latest-product Vera PASS is absent");
  const body: Omit<ProduceValidityReceiptV1, "receipt_id"> = {
    schema_id: "penny.produce-validity-receipt.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    verdict: "PASS",
    reviewer: "vera",
    request_ref: subject.request,
    approach_ref: subject.approach,
    draft_ref: subject.draft,
    product_ref: subject.product,
    carren_report_ref: input.quality.value.carren_report_ref,
    vera_report_ref: evidence.report,
    quality_receipt_ref: input.quality.artifact,
    execution_receipt_id: evidence.result.worker_receipt.receipt_id,
    execution_result_sha256: sha256(canonicalJson(evidence.result)),
    created_at: evidence.result.worker_receipt.ended_at,
    external_actions_performed: false,
    filesystem_writes_performed: false,
    tests_executed: false,
    minted_by: "host:produce-receipt-authority",
  };
  const value = validateProduceValidityReceipt({
    ...body,
    receipt_id: produceValidityReceiptId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_artifact",
    branchId: "validity",
    kind: "produce-validity-receipt",
    operationLabel: "validity-receipt",
    producer: "host:produce-receipt-authority",
    contentSchema: { schema_id: "penny.produce-validity-receipt.v1", schema_version: 1 },
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
  readonly quality: { readonly artifact: ArtifactRef; readonly value: ProduceQualityReceiptV1 };
  readonly validity: { readonly artifact: ArtifactRef; readonly value: ProduceValidityReceiptV1 };
}): {
  readonly artifact: ArtifactRef;
  readonly value: ProduceProductIntegrityV1;
  readonly added: boolean;
} {
  const subject = currentSubject(input.context);
  const request = canonicalProduceRequest(input.store, input.context);
  parsePersistedArtifactApproach(input.store.readById(subject.approach.artifact_id));
  const draft = parsePersistedProducedArtifactDraft(
    input.store.readById(subject.draft.artifact_id),
    { request }
  ).draft;
  const product = validateCanonicalProducedArtifactBytes(
    input.store.readById(subject.product.artifact_id),
    subject.product
  );
  assertProducedArtifactLineage({
    product,
    request,
    draft,
    requestRef: subject.request,
    approachRef: subject.approach,
    draftRef: subject.draft,
  });
  const executionReceiptIds = exactExecutionReceiptIds({
    context: input.context,
    checkpointer: input.checkpointer,
    artifacts: [
      subject.approach,
      subject.draft,
      input.quality.value.carren_report_ref,
      input.validity.value.vera_report_ref,
    ],
  });
  const body: Omit<ProduceProductIntegrityV1, "integrity_id"> = {
    schema_id: "penny.produce-product-integrity.v1",
    schema_version: 1,
    status: "PASS",
    request_ref: subject.request,
    approach_ref: subject.approach,
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
      "no_side_effects",
    ],
    external_actions_performed: false,
    filesystem_writes_performed: false,
    tests_executed: false,
  };
  const value = validateProduceProductIntegrity({
    ...body,
    integrity_id: produceProductIntegrityId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_artifact",
    branchId: "integrity",
    kind: "produce-product-integrity",
    operationLabel: "product-integrity",
    producer: "host:produce-product-validator",
    contentSchema: { schema_id: "penny.produce-product-integrity.v1", schema_version: 1 },
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
  readonly quality: { readonly artifact: ArtifactRef; readonly value: ProduceQualityReceiptV1 };
  readonly validity: { readonly artifact: ArtifactRef; readonly value: ProduceValidityReceiptV1 };
  readonly integrity: ArtifactRef;
}): {
  readonly artifact: ArtifactRef;
  readonly value: ProduceProductEnvelopeV1;
  readonly added: boolean;
} {
  const subject = currentSubject(input.context);
  const body: Omit<ProduceProductEnvelopeV1, "envelope_id"> = {
    schema_id: "penny.produce-product-envelope.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    status: "complete",
    request_ref: subject.request,
    approach_ref: subject.approach,
    draft_ref: subject.draft,
    product_ref: subject.product,
    carren_report_ref: input.quality.value.carren_report_ref,
    vera_report_ref: input.validity.value.vera_report_ref,
    quality_receipt_ref: input.quality.artifact,
    validity_receipt_ref: input.validity.artifact,
    integrity_ref: input.integrity,
  };
  const value = validateProduceProductEnvelope({
    ...body,
    envelope_id: produceProductEnvelopeId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "admitting_artifact",
    branchId: null,
    kind: "produce-product-envelope",
    operationLabel: "product-envelope",
    producer: "host:produce-product-validator",
    contentSchema: { schema_id: "penny.produce-product-envelope.v1", schema_version: 1 },
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
): EvaluationResultV2 | null {
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
    latestApproachArtifact(context)
  );
}

export class ProducePlaybook
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
    const refs = refsForState(context, state);
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: state,
      agent: PRODUCE_AGENT_BY_STATE[state],
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
    return state === "critiquing_artifact" || state === "verifying_artifact"
      ? reviewEvaluation(state, details)
      : null;
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
      case "exploring_artifact_approaches":
        if (details.complete !== true) throw new Error("artifact approach summary is incomplete");
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
      (context.stateId === "sealing_artifact" || context.stateId === "admitting_artifact")
    );
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context)) {
      throw new Error(`produce state '${context.stateId}' has no deterministic host continuation`);
    }
    const store = this.artifactStore;
    const checkpointer = this.checkpointer;
    if (store === undefined || checkpointer === undefined) {
      throw new Error("produce engine host continuation dependencies are unavailable");
    }
    if (context.stateId === "sealing_artifact") return this.continueSealing(context, store);
    const subject = currentSubject(context);
    const quality = ensureQualityReceipt({ context, store, checkpointer });
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
    const validity = ensureValidityReceipt({
      context,
      store,
      checkpointer,
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
    const draft = latestDraftArtifact(context);
    const missing = [
      ...(approach === undefined ? ["artifact-approach"] : []),
      ...(draft === undefined ? ["produced-artifact-draft"] : []),
    ];
    if (approach === undefined || draft === undefined) {
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
    try {
      parsePersistedArtifactApproach(store.readById(approach.artifact_id));
    } catch (error) {
      return {
        event_type: "produce_approach_invalid",
        payload: {
          run_id: context.identity.run_id,
          approach_artifact_id: approach.artifact_id,
          failure_sha256: sha256(error instanceof Error ? error.message : "invalid approach"),
        },
        directive: this.terminal(
          context,
          "incomplete",
          false,
          ["exact Ida approach is malformed"],
          undefined,
          { incomplete_reason: "malformed_exact_material" }
        ),
      };
    }
    let draftValue: ProducedArtifactDraftV1;
    try {
      draftValue = parsePersistedProducedArtifactDraft(store.readById(draft.artifact_id), {
        request: canonicalProduceRequest(store, context),
      }).draft;
    } catch (error) {
      if (!(error instanceof ProduceDraftValidationError)) throw error;
      if (latestSealFeedbackArtifact(context) !== undefined) {
        return {
          event_type: "produce_seal_repair_exhausted",
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
      if (feedback.added) this.hostFault?.("sealing_artifact:feedback-persistence");
      context.transition("materializing_artifact");
      const next = this.dispatch(context);
      return {
        event_type: "produce_seal_repair_requested",
        payload: {
          run_id: context.identity.run_id,
          rejected_draft_artifact_id: draft.artifact_id,
          feedback_artifact_id: feedback.artifact.artifact_id,
        },
        directive: next,
      };
    }
    const sealed = persistSealedProduct({
      context,
      store,
      request,
      approach,
      draft,
      draftValue,
    });
    if (sealed.added) this.hostFault?.("sealing_artifact:artifact-persistence");
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

  private terminal(
    context: RunContext,
    action: "complete" | "incomplete" | "cancelled",
    met: boolean,
    unresolved: readonly string[],
    liveness?: LivenessSnapshotV1,
    extraResult: Readonly<Record<string, JsonValue>> = {}
  ): Directive {
    const origin = context.stateId;
    const output = met ? latestProductArtifact(context) : bestPartial(context);
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
        external_actions_performed: false,
        filesystem_writes_performed: false,
        tests_executed: false,
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
  receipt: ProduceQualityReceiptV1 | ProduceValidityReceiptV1,
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
    parsePersistedArtifactApproach(reader.readById(subject.approach.artifact_id));
    const draft = parsePersistedProducedArtifactDraft(reader.readById(subject.draft.artifact_id), {
      request,
    }).draft;
    const product = validateCanonicalProducedArtifactBytes(
      reader.readById(subject.product.artifact_id),
      subject.product
    );
    assertProducedArtifactLineage({
      product,
      request,
      draft,
      requestRef: subject.request,
      approachRef: subject.approach,
      draftRef: subject.draft,
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
    const quality = readCanonicalJson(reader, qualityRef, validateProduceQualityReceipt);
    const validity = readCanonicalJson(reader, validityRef, validateProduceValidityReceipt);
    const integrity = readCanonicalJson(reader, integrityRef, validateProduceProductIntegrity);
    const envelope = readCanonicalJson(reader, envelopeRef, validateProduceProductEnvelope);
    const expectedExecutionReceiptIds = exactExecutionReceiptIds({
      context: input.context,
      checkpointer: input.checkpointer,
      artifacts: [
        subject.approach,
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
      canonicalJson(quality.draft_ref) !== canonicalJson(subject.draft) ||
      canonicalJson(quality.product_ref) !== canonicalJson(subject.product) ||
      canonicalJson(validity.request_ref) !== canonicalJson(subject.request) ||
      canonicalJson(validity.approach_ref) !== canonicalJson(subject.approach) ||
      canonicalJson(validity.draft_ref) !== canonicalJson(subject.draft) ||
      canonicalJson(validity.product_ref) !== canonicalJson(subject.product) ||
      canonicalJson(validity.carren_report_ref) !== canonicalJson(quality.carren_report_ref) ||
      canonicalJson(validity.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(integrity.request_ref) !== canonicalJson(subject.request) ||
      canonicalJson(integrity.approach_ref) !== canonicalJson(subject.approach) ||
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
      product.external_actions_performed !== false ||
      product.filesystem_writes_performed !== false ||
      product.tests_executed !== false ||
      input.terminal.result.external_actions_performed !== false ||
      input.terminal.result.filesystem_writes_performed !== false ||
      input.terminal.result.tests_executed !== false ||
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

export const PRODUCE_CANDIDATE_REGISTRATION: PlaybookRegistrationV1 = {
  name: PRODUCE_PLAYBOOK_NAME,
  contract: PRODUCE_SKILL_CONTRACT,
  ingress: "skill",
  start_admission: PRODUCE_START_ADMISSION,
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
          result_schema_id: "penny.produce.quality-summary.v1",
          result_schema_version: 1,
          schema: QualitySummarySchema,
        },
      ],
      [
        "verifying_artifact",
        {
          agent: "vera",
          result_schema_id: "penny.produce.validity-summary.v1",
          result_schema_version: 1,
          schema: ValiditySummarySchema,
        },
      ],
    ]),
  },
  completionReceiptPredicates: PRODUCE_COMPLETION_RECEIPT_PREDICATES,
  construct: (options) =>
    new ProducePlaybook(options.artifactRevisions, options.artifactStore, options.checkpointer),
};
