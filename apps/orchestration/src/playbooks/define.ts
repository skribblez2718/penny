import { Type } from "typebox";

import {
  currentOutputArtifactMetadata,
  type ArtifactHostStore,
  type ArtifactReader,
  type ArtifactRevisionLookup,
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
import { ordinaryLivenessPolicy } from "../liveness.js";
import { SkillSchemaValidationError } from "../skill-contracts/common.js";
import {
  assertSpecificationLineage,
  assertDefinitionProtectedContentRepresentable,
  DefineInvocationV2Schema,
  validateDefineInvocation,
  canonicalizeDefineRequest,
  canonicalizeDefinitionFrame,
  canonicalizeDefinitionFrameV2,
  definitionClarificationChallenge,
  stableDefinitionId,
  mapDefinitionGateResponse,
  validateDefinitionClarificationChallenge,
  validateDefinitionClarificationResponse,
  validateDefinitionFrameV2,
  specificationDraftPromptContract,
  specificationDraftV2PromptContract,
  specificationDraftV3PromptContract,
  specificationDraftRepairPromptContract,
  parseSpecificationDraftV2,
  parseSpecificationDraftV3,
  parseSpecificationDraftV3Candidate,
  parseSpecificationDraftRepair,
  applySpecificationDraftRepair,
  persistedSpecificationDraftV3,
  specificationLineagePromptContract,
  specificationProductEnvelopeId,
  specificationProductEnvelopeV2Id,
  specificationProductIntegrityV2Id,
  validateSpecificationProductEnvelopeV2,
  validateSpecificationProductIntegrityV2,
  specificationProductIntegrityId,
  defineRequestConstraints,
  defineRequestSha256,
  definitionSourceManifest,
  validateDefinitionSourceManifest,
  parseSpecificationDraft,
  sealSpecification,
  validateCanonicalSpecificationBytes,
  validateSpecificationProductEnvelope,
  validateSpecificationProductIntegrity,
  validateDefineRequest,
  validateDefinitionFrame,
  validateSpecificationSealFeedback,
  SpecificationDraftValidationError,
  type SpecificationProductEnvelopeV1,
  type SpecificationProductEnvelopeV2,
  type SpecificationProductIntegrityV1,
  type SpecificationProductIntegrityV2,
  type DefineRequestV1,
  type DefinitionFrameV1,
  type DefinitionFrameV2,
  type DefinitionClarificationChallengeV1,
  type DefinitionSourceManifestV1,
  type SpecificationSealFeedbackV1,
  type SpecificationDraftRepairV1,
  type SpecificationDraftV3,
} from "../skill-contracts/define.js";
import {
  sealDiagnosticsProjection,
  sealPolicySha256,
  runSealPolicy,
  validateSealDiagnostic,
  type SealDiagnosticV1,
  type SealIssueV1,
  type SealPolicyV1,
} from "../skill-contracts/sealing.js";
import { sealAttempt } from "./seal-attempt.js";
import {
  requirePreparedAssurance,
  requireMaterializedAssurance,
  validateCompositionAssurance,
  assertSelectedSpecificationAssurance,
  assertExistingStartAssurance,
  CompositionAssuranceCapabilityUnavailableError,
  type CompositionAssuranceV1,
  type CompositionAdmissionInput,
} from "../composition-assurance.js";
import type { StartAdmissionReadOnlyHostV1 } from "./registry.js";
import {
  evidenceAdmissionId,
  evidenceAdmissionV2Id,
  validateEvidenceAdmissionV2,
  type EvidenceAdmissionV2,
  type DefinitionAllowedUseV1,
  type DefinitionSupportSlotV1,
  validateEvidenceAdmission,
  type EvidenceAdmissionV1,
} from "../skill-contracts/evidence-admission.js";
import {
  reviewReceiptId,
  reviewReceiptV2Id,
  reviewSubjectV2UpstreamRefs,
  reviewSubjectV2UpstreamSha256,
  validateReviewReceiptV2,
  validateReviewReceiptV2Binding,
  reviewSubjectUpstreamRefs,
  reviewSubjectUpstreamSha256,
  validateReviewReceipt,
  validateReviewReceiptBinding,
  type ReviewReceiptV1,
  type ReviewReceiptV2,
  type ReviewSubjectV1,
  type ReviewSubjectV2,
} from "../skill-contracts/review.js";
import { specificationProfile } from "../skill-contracts/define-profiles.js";
import { validateDefinitionSupport } from "../skill-contracts/define-support.js";
import {
  projectDefinitionTrace,
  assertDefinitionTraceProjection,
  validateDefinitionTraceV1,
} from "../skill-contracts/define-trace.js";
import { buildOutputArtifactMetadata } from "./artifact-metadata.js";
import {
  hostContinuation,
  type CompletionReceiptPredicateV1,
  type HostContinuationCapabilityV1,
  type HostContinuationStepV1,
  type GenericGateResponseStorageCapabilityV1,
  type LivenessTerminalCapabilityV1,
  type PlaybookCore,
  type PlaybookStepOutcome,
  type RepairExhaustionCapabilityV1,
  type RepairProgressCapabilityV1,
  type RoutingRepairCapabilityV1,
  type StateAwareRepairCapabilityV1,
} from "./playbook.js";
import type { PlaybookRegistration, PreparedStartV1, StartAdmissionV1 } from "./registry.js";

export const DEFINE_SEAL_POLICY: SealPolicyV1 = {
  schema_id: "penny.seal-policy.v1",
  schema_version: 1,
  skill: "define",
  draft_phase: "authoring_specification",
  seal_phase: "sealing_specification",
  draft_schema: "penny.specification-draft.v3",
  draft_schema_version: 3,
  draft_kind: "specification-draft",
  product_kind: "specification",
  correction_limit: null,
  diagnostic_schema: "penny.seal-diagnostic.v1",
  stall_on_unchanged_rejection: true,
};

const LEGACY_DEFINE_V2_SEAL_POLICY: SealPolicyV1 = {
  schema_id: "penny.seal-policy.v1",
  schema_version: 1,
  skill: "define",
  draft_phase: "authoring_specification",
  seal_phase: "sealing_specification",
  draft_schema: "penny.specification-draft.v2",
  draft_schema_version: 2,
  draft_kind: "specification-draft",
  product_kind: "specification",
  correction_limit: 1,
  diagnostic_schema: "penny.seal-diagnostic.v1",
};

const LEGACY_DEFINE_SEAL_POLICY: SealPolicyV1 = {
  ...LEGACY_DEFINE_V2_SEAL_POLICY,
  draft_schema: "penny.specification-draft.v1",
  draft_schema_version: 1,
};

export const DEFINE_PLAYBOOK_NAME = "define";
export const DEFINE_LIFECYCLE_STATUS = "PREPARED_NOT_MEASURED" as const;

export const DEFINE_AGENT_BY_STATE = {
  framing_definition: "piper",
  gathering_definition_evidence: "echo",
  authoring_specification: "rhea",
  verifying_specification: "vera",
  critiquing_specification: "carren",
} as const;

type DefineWorkerState = keyof typeof DEFINE_AGENT_BY_STATE;
type ReviewState = "verifying_specification" | "critiquing_specification";
type ReviewKind = "validity" | "quality";
type RepairGapKind = "evidence_gap" | "analysis_gap" | "product_gap";
type RepairOwner = "echo" | "piper" | "rhea";

function isDefineWorkerState(value: string): value is DefineWorkerState {
  return Object.hasOwn(DEFINE_AGENT_BY_STATE, value);
}

export const DEFINE_FLOW = {
  states: [
    "intake",
    "framing_definition",
    "definition_readiness_gate",
    "awaiting_clarification",
    "gathering_definition_evidence",
    "authoring_specification",
    "sealing_specification",
    "verifying_specification",
    "critiquing_specification",
    "admitting_specification",
    "complete",
    "incomplete",
    "cancelled",
  ],
  edges: [
    ["intake", "framing_definition"],
    ["framing_definition", "definition_readiness_gate"],
    ["definition_readiness_gate", "awaiting_clarification"],
    ["awaiting_clarification", "framing_definition"],
    ["definition_readiness_gate", "gathering_definition_evidence"],
    ["definition_readiness_gate", "authoring_specification"],
    ["gathering_definition_evidence", "authoring_specification"],
    ["authoring_specification", "sealing_specification"],
    ["sealing_specification", "authoring_specification"],
    ["sealing_specification", "verifying_specification"],
    ["verifying_specification", "framing_definition"],
    ["verifying_specification", "authoring_specification"],
    ["verifying_specification", "critiquing_specification"],
    ["verifying_specification", "incomplete"],
    ["critiquing_specification", "incomplete"],
    ["critiquing_specification", "framing_definition"],
    ["critiquing_specification", "authoring_specification"],
    ["critiquing_specification", "admitting_specification"],
    ["admitting_specification", "complete"],
  ],
} as const;

export const DEFINE_LIVENESS_POLICY = ordinaryLivenessPolicy({
  scope: "orchestrated-define-workflow",
  preset: "ordinary-progress-lease-v3",
}) satisfies LivenessPolicy;

const FindingSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const SpecificationDeltaSchema = Type.String({ minLength: 1, maxLength: 4_096 });
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

const OrientationSummarySchema = Type.Object(
  {
    orientation_complete: Type.Literal(true),
    gap_kind: Type.Literal("none"),
    repair_owner: Type.Literal("none"),
    selected_profile_id: Type.Union([
      Type.Literal("generic"),
      Type.Literal("software"),
      Type.Literal("business_process"),
      Type.Literal("research"),
    ]),
    profile_selection_basis: FindingSchema,
    route: Type.Union([Type.Literal("author"), Type.Literal("clarify"), Type.Literal("evidence")]),
    route_reason: FindingSchema,
    clarification_questions: Type.Array(FindingSchema, { maxItems: 16, uniqueItems: true }),
    evidence_questions: Type.Array(FindingSchema, { maxItems: 16, uniqueItems: true }),
    findings: FindingsSchema,
    specification_delta: SpecificationDeltaSchema,
  },
  { additionalProperties: false }
);
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
const SpecificationSummarySchema = Type.Object(
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
      specification_delta: SpecificationDeltaSchema,
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
      specification_delta: SpecificationDeltaSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      verdict: Type.Literal("UNVERIFIABLE"),
      gap_kind: Type.Literal("verification_incomplete"),
      repair_owner: Type.Literal("none"),
      findings: Type.Array(FindingSchema, { minItems: 1, maxItems: 32 }),
      evidence: EvidenceChecksSchema,
      specification_delta: SpecificationDeltaSchema,
    },
    { additionalProperties: false }
  ),
  verificationFailureSchema("evidence_gap", "echo"),
  verificationFailureSchema("analysis_gap", "piper"),
  verificationFailureSchema("product_gap", "rhea"),
]);

function critiqueRevisionSchema(gapKind: RepairGapKind, repairOwner: RepairOwner) {
  return Type.Object(
    {
      verdict: Type.Literal("NEEDS_REVISION"),
      gap_kind: Type.Literal(gapKind),
      repair_owner: Type.Literal(repairOwner),
      findings: Type.Array(CritiqueFindingSchema, { minItems: 1, maxItems: 32 }),
      evidence: EvidenceChecksSchema,
      specification_delta: SpecificationDeltaSchema,
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
      specification_delta: SpecificationDeltaSchema,
    },
    { additionalProperties: false }
  ),
  critiqueRevisionSchema("evidence_gap", "echo"),
  critiqueRevisionSchema("analysis_gap", "piper"),
  critiqueRevisionSchema("product_gap", "rhea"),
]);

function repairRoute(
  originState: "framing_definition" | ReviewState,
  feedbackKind: RepairGapKind,
  targetState: "definition_readiness_gate" | "framing_definition" | "authoring_specification"
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

function specificationContract(input: { readonly name: string }): SkillContract {
  return {
    schema_version: 2,
    name: input.name,
    objective:
      "Produce one evidence-grounded specification assessment through separate orientation, specification authorship, host sealing, objective verification, and quality critique without taskification or execution.",
    io: {
      request: {
        schema_version: 1,
        name: "define_request",
        direction: "input",
        transport: "inline_request",
        schema_id: "penny.definition-request.v1",
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
          name: "prior_specification",
          direction: "input",
          transport: "artifact",
          schema_id: "penny.specification.v1",
          schema_version_required: 1,
          artifact_kind: "specification",
          source: "either",
          min_items: 0,
          max_items: 1,
          semantic_product: true,
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
        {
          schema_version: 1,
          name: "evidence_context",
          direction: "input",
          transport: "artifact",
          schema_id: "penny.evidence-context.v1",
          schema_version_required: 1,
          artifact_kind: "evidence-context",
          source: "either",
          min_items: 0,
          max_items: 1,
          semantic_product: true,
        },
      ],
      active_output_ports: [
        {
          schema_version: 1,
          name: "specification",
          direction: "output",
          transport: "artifact",
          schema_id: "penny.specification.v1",
          schema_version_required: 1,
          artifact_kind: "specification",
          source: "skill",
          min_items: 1,
          max_items: 1,
          semantic_product: true,
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
      skill_root: ".pi/skills/define/assets/prompts",
      resolution: "per_agent_phase",
      documentation: ["docs/agents/writing/standard.md", "docs/agents/writing/review.md"],
    },
    budget_policy: {
      schema_version: 1,
      policy_id: "penny.define-budget.v1",
      resolver_id: "defineLivenessPolicy",
      admission_id: "LivenessController.admitInvocation",
      snapshot_id: "LivenessController.snapshot",
    },
    repair_routing: {
      schema_version: 1,
      routes: [
        repairRoute("framing_definition", "evidence_gap", "definition_readiness_gate"),
        repairRoute("verifying_specification", "evidence_gap", "framing_definition"),
        repairRoute("verifying_specification", "analysis_gap", "framing_definition"),
        repairRoute("verifying_specification", "product_gap", "authoring_specification"),
        repairRoute("critiquing_specification", "evidence_gap", "framing_definition"),
        repairRoute("critiquing_specification", "analysis_gap", "framing_definition"),
        repairRoute("critiquing_specification", "product_gap", "authoring_specification"),
      ],
    },
    completion_gate: {
      schema_version: 2,
      allowed_terminal_origins: ["admitting_specification"],
      required_visited_states: [
        "framing_definition",
        "definition_readiness_gate",
        "authoring_specification",
        "sealing_specification",
        "verifying_specification",
        "critiquing_specification",
        "admitting_specification",
      ],
      required_receipt_predicates: ["define_latest_reviewed_specification_dod.v2"],
      latest_product: {
        selector: "terminal_artifact",
        schema_id: "penny.specification.v1",
        product_schema_version: 1,
        artifact_kind: "specification",
        producing_state: "sealing_specification",
      },
      unresolved_policy: { mode: "max_count", max_count: 0 },
    },
  };
}

export const DEFINE_SKILL_CONTRACT = specificationContract({ name: DEFINE_PLAYBOOK_NAME });

function selectedLatest(
  context: RunContext,
  predicate: (artifact: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts]
    .reverse()
    .find((artifact) => artifact.run_id === context.identity.run_id && predicate(artifact));
}
function addSelectedArtifact(context: RunContext, artifact: ArtifactRef): boolean {
  const selected = context.selectedArtifacts.find(
    (candidate) => candidate.artifact_id === artifact.artifact_id
  );
  if (selected !== undefined) {
    if (canonicalJson(selected) !== canonicalJson(artifact)) {
      throw new Error("selected specification artifact metadata diverged");
    }
    return false;
  }
  context.selectedArtifacts.push(structuredClone(artifact));
  return true;
}

function isExactDefineInputRef(artifact: ArtifactRef): boolean {
  return (
    (artifact.kind === "specification" &&
      artifact.content_schema?.schema_id === "penny.specification.v1" &&
      artifact.content_schema.schema_version === 1) ||
    (artifact.kind === "semantic-core" &&
      artifact.content_schema?.schema_id === "penny.grounded-synthesis.v1" &&
      artifact.content_schema.schema_version === 1) ||
    (artifact.kind === "semantic-core" &&
      artifact.content_schema?.schema_id === "penny.decision.v2" &&
      artifact.content_schema.schema_version === 2) ||
    (artifact.kind === "evidence-context" &&
      artifact.content_schema?.schema_id === "penny.evidence-context.v1" &&
      artifact.content_schema.schema_version === 1)
  );
}

function exactDefineInputRefs(context: RunContext): readonly ArtifactRef[] {
  // A canonical imported specification has the same phase/kind as our own product.
  // Scope by owning run before comparing versions or selecting prior-input slots.
  return context.selectedArtifacts
    .filter(
      (artifact) => artifact.run_id !== context.identity.run_id && isExactDefineInputRef(artifact)
    )
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function priorSpecificationRef(context: RunContext): ArtifactRef | undefined {
  const matches = exactDefineInputRefs(context).filter(
    (artifact) => artifact.content_schema?.schema_id === "penny.specification.v1"
  );
  if (matches.length > 1) throw new Error("Define admitted more than one prior SpecificationV1");
  return matches[0];
}

function priorSpecification(
  store: Pick<ArtifactReader, "readById">,
  context: RunContext
):
  | {
      readonly ref: ArtifactRef;
      readonly value: ReturnType<typeof validateCanonicalSpecificationBytes>;
    }
  | undefined {
  const ref = priorSpecificationRef(context);
  if (ref === undefined) return undefined;
  return {
    ref,
    value: validateCanonicalSpecificationBytes(store.readById(ref.artifact_id), ref),
  };
}

function admittedDefineRequestArtifact(context: RunContext): ArtifactRef {
  const request = selectedLatest(
    context,
    (artifact) => artifact.kind === "definition-request" && artifact.phase === "intake"
  );
  if (request === undefined) throw new Error("admitted DefineRequestV1 artifact is absent");
  return request;
}

function restoreDefineInputRefs(context: RunContext, store?: ArtifactHostStore): void {
  if (store === undefined) return;
  const request = admittedDefineRequestArtifact(context);
  for (const ref of store.metadata(request).upstream_refs.filter(isExactDefineInputRef)) {
    addSelectedArtifact(context, ref);
  }
  // The manifest was materialized before the run. Recovery adopts exact coordinates.
  const manifest = store.refFor(
    context.identity.run_id,
    "intake",
    null,
    "definition-source-manifest",
    `definition-source-manifest:${sha256(context.identity.run_id).slice(0, 32)}`,
    1
  );
  if (manifest === null) throw new Error("admitted DefinitionSourceManifestV1 is absent");
  readDefinitionSourceManifest(store, manifest, request);
  addSelectedArtifact(context, manifest);
}

function admittedDefinitionSourceManifestArtifact(context: RunContext): ArtifactRef {
  const manifest = selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "definition-source-manifest" &&
      artifact.phase === "intake" &&
      artifact.content_schema?.schema_id === "penny.definition-source-manifest.v1" &&
      artifact.content_schema.schema_version === 1
  );
  if (manifest === undefined) throw new Error("admitted DefinitionSourceManifestV1 is absent");
  return manifest;
}

function readDefinitionSourceManifest(
  store: Pick<ArtifactReader, "readById">,
  artifact: ArtifactRef,
  requestRef: ArtifactRef
): DefinitionSourceManifestV1 {
  if (
    artifact.kind !== "definition-source-manifest" ||
    artifact.phase !== "intake" ||
    artifact.run_id !== requestRef.run_id ||
    artifact.content_schema?.schema_id !== "penny.definition-source-manifest.v1" ||
    artifact.content_schema.schema_version !== 1
  ) {
    throw new Error("DefinitionSourceManifestV1 artifact identity is invalid");
  }
  const requestBytes = store.readById(requestRef.artifact_id).toString("utf8");
  const request = validateDefineRequest(JSON.parse(requestBytes));
  if (canonicalJson(request) !== requestBytes)
    throw new Error("admitted DefineRequestV1 artifact is not canonical JSON");
  const bytes = store.readById(artifact.artifact_id).toString("utf8");
  const manifest = validateDefinitionSourceManifest(JSON.parse(bytes), request, requestRef);
  if (canonicalJson(manifest) !== bytes)
    throw new Error("DefinitionSourceManifestV1 artifact is not canonical JSON");
  return manifest;
}

function latestOrientationArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) => artifact.kind === "agent-output" && artifact.phase === "framing_definition"
  );
}

function latestDefinitionFrameArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "definition-frame" &&
      artifact.phase === "definition_readiness_gate" &&
      (artifact.content_schema?.schema_id === "penny.definition-frame.v1" ||
        artifact.content_schema?.schema_id === "penny.definition-frame.v2") &&
      (artifact.content_schema.schema_version === 1 || artifact.content_schema.schema_version === 2)
  );
}

function latestEvidenceAdmissionArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "evidence-admission" && artifact.phase === "definition_readiness_gate"
  );
}

function latestEvidenceArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "agent-output" && artifact.phase === "gathering_definition_evidence"
  );
}

function latestSpecificationDraftArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "specification-draft" && artifact.phase === "authoring_specification"
  );
}

function specificationDraftTransport(context: RunContext): 1 | 2 | 3 {
  const frame = latestDefinitionFrameArtifact(context);
  if (frame?.content_schema?.schema_id !== "penny.definition-frame.v2") return 1;
  const current = latestSpecificationDraftArtifact(context);
  if (current?.content_schema?.schema_id === "penny.specification-draft.v2") return 2;
  if (current?.content_schema?.schema_id === "penny.specification-draft.v1") return 1;
  return 3;
}

function latestSpecificationDraftRepairArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "specification-draft-repair" &&
      artifact.phase === "authoring_specification" &&
      artifact.content_schema?.schema_id === "penny.specification-draft-repair.v1" &&
      artifact.content_schema.schema_version === 1
  );
}

function latestSpecificationArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "specification" &&
      artifact.phase === "sealing_specification" &&
      artifact.content_schema?.schema_id === "penny.specification.v1" &&
      artifact.content_schema.schema_version === 1
  );
}

function latestDefinitionTraceArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(
    context,
    (artifact) =>
      artifact.kind === "definition-trace" &&
      artifact.phase === "sealing_specification" &&
      artifact.content_schema?.schema_id === "penny.definition-trace.v1"
  );
}

/** Check the checkpoint-selected review graph, not an unselected orphan or older product. */
function assertSelectedDefinitionTrace(context: RunContext, store: ArtifactHostStore): void {
  const frame = latestDefinitionFrameArtifact(context);
  if (frame?.content_schema?.schema_id !== "penny.definition-frame.v2") return;
  const traceRef = latestDefinitionTraceArtifact(context);
  const product = latestSpecificationArtifact(context);
  const admission = latestEvidenceAdmissionArtifact(context);
  const draft = latestSpecificationDraftArtifact(context);
  const binding = context.registrationContractBinding;
  if (
    traceRef === undefined ||
    product === undefined ||
    admission === undefined ||
    draft === undefined ||
    binding?.registration_sha256 === undefined
  ) {
    throw new Error("V2 Define review lacks an exact product-bound trace");
  }
  if (canonicalJson(store.refById(traceRef.artifact_id)) !== canonicalJson(traceRef))
    throw new Error("V2 Define selected trace ref drifted");
  const bytes = store.readById(traceRef.artifact_id).toString("utf8");
  const trace: unknown = JSON.parse(bytes);
  const verified = validateDefinitionTraceV1(trace);
  if (
    canonicalJson(verified) !== bytes ||
    canonicalJson(verified.product_ref) !== canonicalJson(product) ||
    canonicalJson(verified.draft_ref) !== canonicalJson(draft) ||
    canonicalJson(verified.admission_ref) !== canonicalJson(admission) ||
    canonicalJson(verified.frame_ref) !== canonicalJson(frame) ||
    canonicalJson(verified.request_ref) !== canonicalJson(admittedDefineRequestArtifact(context)) ||
    verified.registration_binding.contract_sha256 !== binding.contract_sha256 ||
    verified.registration_binding.registration_sha256 !== binding.registration_sha256
  ) {
    throw new Error("V2 Define selected trace does not bind the current review product");
  }
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

// Historical feedback remains readable under its original V1 contract, but new
// author instructions and allowance use only the checkpoint-selected current epoch.
function currentSealDiagnosticArtifact(context: RunContext): ArtifactRef | undefined {
  const anchor = latestSpecificationArtifact(context);
  const index =
    anchor === undefined
      ? -1
      : context.selectedArtifacts.findIndex((ref) => ref.artifact_id === anchor.artifact_id);
  return [...context.selectedArtifacts]
    .slice(index + 1)
    .reverse()
    .find(
      (ref) =>
        ref.run_id === context.identity.run_id &&
        ref.phase === DEFINE_SEAL_POLICY.seal_phase &&
        ref.kind === "seal-diagnostic" &&
        ref.content_schema?.schema_id === DEFINE_SEAL_POLICY.diagnostic_schema &&
        ref.content_schema.schema_version === 1
    );
}

function defineSealPolicy(context: RunContext): SealPolicyV1 {
  const schema = latestSpecificationDraftArtifact(context)?.content_schema?.schema_id;
  if (schema === "penny.specification-draft.v3") return runSealPolicy(context, DEFINE_SEAL_POLICY);
  if (schema === "penny.specification-draft.v2") return LEGACY_DEFINE_V2_SEAL_POLICY;
  return LEGACY_DEFINE_SEAL_POLICY;
}

function readCurrentSealDiagnostic(
  context: RunContext,
  store: ArtifactHostStore
): { readonly ref: ArtifactRef; readonly value: SealDiagnosticV1 } | undefined {
  const ref = currentSealDiagnosticArtifact(context);
  const policy = defineSealPolicy(context);
  if (ref === undefined) return undefined;
  if (canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref)) {
    throw new Error("selected Define seal diagnostic has invalid custody");
  }
  const bytes = store.readById(ref.artifact_id).toString("utf8");
  const value: unknown = JSON.parse(bytes);
  const diagnostic = validateSealDiagnostic(value, policy);
  if (
    bytes !== canonicalJson(diagnostic) ||
    canonicalJson(diagnostic.epoch_anchor_ref) !==
      canonicalJson(latestSpecificationArtifact(context) ?? null)
  ) {
    throw new Error("selected Define seal diagnostic has stale epoch binding");
  }
  sealDiagnosticsProjection(diagnostic, ref, policy);
  return { ref, value: diagnostic };
}

function narrowSpecificationRepairAvailable(
  context: RunContext,
  store: ArtifactHostStore
): boolean {
  const draft = latestSpecificationDraftArtifact(context);
  const diagnostic = readCurrentSealDiagnostic(context, store)?.value;
  return (
    draft?.content_schema?.schema_id === "penny.specification-draft.v3" &&
    diagnostic?.disposition === "correction_offered" &&
    diagnostic.issues_complete &&
    diagnostic.issues.length > 0 &&
    diagnostic.issues.every((issue) => issue.code === "UNCOVERED_REQUIREMENT")
  );
}

function latestIntegrityArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "specification-product-integrity");
}

function latestEnvelopeArtifact(context: RunContext): ArtifactRef | undefined {
  return selectedLatest(context, (artifact) => artifact.kind === "specification-product-envelope");
}

function uniqueRefs(refs: readonly (ArtifactRef | undefined)[]): ArtifactRef[] {
  return [
    ...new Map(
      refs.flatMap((ref) => (ref === undefined ? [] : [[ref.artifact_id, ref] as const]))
    ).values(),
  ];
}

function readFrameBytes(store: Pick<ArtifactReader, "readById">, artifact: ArtifactRef): unknown {
  const bytes = store.readById(artifact.artifact_id).toString("utf8");
  const parsed: unknown = JSON.parse(bytes);
  if (canonicalJson(parsed) !== bytes || artifact.content_digest !== sha256(bytes)) {
    throw new Error("Definition frame artifact is not canonical or has stale custody");
  }
  return parsed;
}

function readDefinitionFrameV2(
  store: ArtifactHostStore,
  context: RunContext,
  artifact: ArtifactRef
): DefinitionFrameV2 {
  if (
    artifact.content_schema?.schema_id !== "penny.definition-frame.v2" ||
    canonicalJson(store.refById(artifact.artifact_id)) !== canonicalJson(artifact)
  ) {
    throw new Error("DefinitionFrameV2 requires exact selected custody");
  }
  const orientation = store
    .metadata(artifact)
    .upstream_refs.find((ref) => ref.phase === "framing_definition" && ref.kind === "agent-output");
  if (
    orientation === undefined ||
    canonicalJson(store.refById(orientation.artifact_id)) !== canonicalJson(orientation)
  ) {
    throw new Error("DefinitionFrameV2 orientation is absent or changed");
  }
  const frame = validateDefinitionFrameV2(
    readFrameBytes(store, artifact),
    canonicalDefineRequest(store, context),
    admittedDefineRequestArtifact(context),
    orientation
  );
  for (const question of frame.questions) {
    if (
      !store
        .metadata(artifact)
        .upstream_refs.some((ref) => canonicalJson(ref) === canonicalJson(question.origin_ref)) ||
      canonicalJson(store.refById(question.origin_ref.artifact_id)) !==
        canonicalJson(question.origin_ref)
    ) {
      throw new Error("Definition question origin lacks exact frame custody");
    }
  }
  return frame;
}

/** Historical V1 is read verbatim; V2 is adapted only for the still-V1 product path. */
function readDefinitionFrame(
  store: Pick<ArtifactReader, "readById">,
  artifact: ArtifactRef,
  request?: DefineRequestV1,
  requestRef?: ArtifactRef,
  orientationRef?: ArtifactRef
): DefinitionFrameV1 {
  const parsed = readFrameBytes(store, artifact);
  if (artifact.content_schema?.schema_id === "penny.definition-frame.v1") {
    return validateDefinitionFrame(parsed);
  }
  if (
    artifact.content_schema?.schema_id !== "penny.definition-frame.v2" ||
    request === undefined ||
    requestRef === undefined ||
    orientationRef === undefined
  ) {
    throw new Error("Definition frame version or V2 binding is unavailable");
  }
  const frame = validateDefinitionFrameV2(parsed, request, requestRef, orientationRef);
  return canonicalizeDefinitionFrame({
    request,
    selectedProfileId: frame.profile.profile_id,
    profileSelectionBasis: frame.profile_selection_basis,
    route: frame.route,
    routeReason: frame.route_reason,
    clarificationQuestions:
      frame.route === "clarify"
        ? frame.questions
            .filter((q) => q.owner === "caller")
            .slice(0, 16)
            .map((q) => q.question)
        : [],
    evidenceQuestions:
      frame.route === "evidence"
        ? frame.questions
            .filter((q) => q.owner === "evidence")
            .slice(0, 16)
            .map((q) => q.question)
        : [],
  });
}

function canonicalDefineRequest(store: ArtifactHostStore, context: RunContext): DefineRequestV1 {
  const requestArtifact = admittedDefineRequestArtifact(context);
  const bytes = store.readById(requestArtifact.artifact_id).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("admitted DefineRequestV1 artifact is not JSON");
  }
  const request = validateDefineRequest(parsed);
  if (canonicalJson(request) !== bytes) {
    throw new Error("admitted DefineRequestV1 artifact is not canonical JSON");
  }
  return request;
}

function persistDefineRequestArtifact(input: {
  readonly request: DefineRequestV1;
  readonly runId: string;
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly store?: ArtifactHostStore;
}): ArtifactRef | undefined {
  if (input.store === undefined) return undefined;
  const operationId = `definition-request:${sha256(input.runId).slice(0, 32)}`;
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: "intake",
    branch_id: null,
    kind: "definition-request",
    operation_id: operationId,
    version: 1,
    producer: "host:request-admission",
    media_type: "application/json",
    content_schema: { schema_id: "penny.definition-request.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [...input.upstreamRefs].sort((left, right) =>
      left.artifact_id.localeCompare(right.artifact_id)
    ),
  };
  const content = canonicalJson(validateDefineRequest(input.request));
  const existing = input.store.refFor(
    input.runId,
    "intake",
    null,
    "definition-request",
    operationId,
    1
  );
  const ref = existing ?? input.store.persist({ metadata, content });
  if (
    input.store.lastVersion(input.runId, "intake", null, "definition-request", operationId) !== 1 ||
    canonicalJson(input.store.metadata(ref)) !== canonicalJson(metadata) ||
    input.store.readById(ref.artifact_id).toString("utf8") !== content
  ) {
    throw new Error("durable DefineRequestV1 artifact diverged");
  }
  const reread = input.store.refById(ref.artifact_id);
  if (reread === undefined || canonicalJson(reread) !== canonicalJson(ref)) {
    throw new Error("durable DefineRequestV1 artifact failed manifest re-read");
  }
  input.store.select(reread);
  return reread;
}

function persistDefinitionSourceManifest(
  store: ArtifactHostStore,
  requestRef: ArtifactRef,
  request: DefineRequestV1
): ArtifactRef {
  const operationId = `definition-source-manifest:${sha256(requestRef.run_id).slice(0, 32)}`;
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: requestRef.run_id,
    phase: "intake",
    branch_id: null,
    kind: "definition-source-manifest",
    operation_id: operationId,
    version: 1,
    producer: "host:request-admission",
    media_type: "application/json",
    content_schema: { schema_id: "penny.definition-source-manifest.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [requestRef],
  };
  const content = canonicalJson(definitionSourceManifest(request, requestRef));
  const existing = store.refFor(
    requestRef.run_id,
    "intake",
    null,
    "definition-source-manifest",
    operationId,
    1
  );
  const ref = existing ?? store.persist({ metadata, content });
  if (
    store.lastVersion(
      requestRef.run_id,
      "intake",
      null,
      "definition-source-manifest",
      operationId
    ) !== 1 ||
    canonicalJson(store.metadata(ref)) !== canonicalJson(metadata) ||
    store.readById(ref.artifact_id).toString("utf8") !== content ||
    canonicalJson(readDefinitionSourceManifest(store, ref, requestRef)) !== content
  ) {
    throw new Error("DefinitionSourceManifestV1 deterministic persistence diverged");
  }
  const reread = store.refById(ref.artifact_id);
  if (reread === undefined || canonicalJson(reread) !== canonicalJson(ref)) {
    throw new Error("DefinitionSourceManifestV1 manifest re-read failed");
  }
  store.select(reread);
  return reread;
}

function defineAssuranceInput(
  request: import("../contracts.js").StartRequest,
  native: DefineRequestV1,
  mode: CompositionAssuranceV1["mode"],
  host: StartAdmissionReadOnlyHostV1
): CompositionAdmissionInput {
  if (host.assurance === undefined) throw new CompositionAssuranceCapabilityUnavailableError();
  const specificationRefs =
    request.input_artifacts?.artifacts
      .map((binding) => binding.ref)
      .filter((ref) => ref.content_schema?.schema_id === "penny.specification.v1") ?? [];
  if (specificationRefs.length > 1) throw new Error("SPECIFICATION_ASSURANCE_BINDING_INVALID");
  return {
    ...host.assurance,
    invocation: request.constraints,
    request_bytes: canonicalJson(native),
    request_schema: { schema_id: "penny.definition-request.v1", schema_version: 1 },
    specification_ref: specificationRefs[0] ?? null,
    mode: specificationRefs.length === 0 ? "not_applicable" : mode,
  };
}

export const DEFINE_START_ADMISSION: StartAdmissionV1 = {
  schema_id: "penny.definition-request.v1",
  schema_version: 1,
  invocation_versions: [1, 2],
  prepare: (request, host): PreparedStartV1 => {
    const invocation = validateDefineInvocation(request.constraints);
    const exactInputArtifactIds =
      request.input_artifacts?.artifacts
        .filter((binding) => isExactDefineInputRef(binding.ref))
        .map((binding) => binding.ref.artifact_id) ?? [];
    const defineRequest = canonicalizeDefineRequest({
      goal: request.goal,
      constraints: invocation.request,
      exactInputArtifactIds,
    });
    assertDefinitionProtectedContentRepresentable(defineRequest);
    const priorSpecificationCount =
      request.input_artifacts?.artifacts.filter(
        (binding) => binding.ref.content_schema?.schema_id === "penny.specification.v1"
      ).length ?? 0;
    if (
      (defineRequest.mode === "create" && priorSpecificationCount !== 0) ||
      (defineRequest.mode === "revise" && priorSpecificationCount !== 1)
    ) {
      throw new Error(
        "DefinitionRequestV1 create mode forbids a prior specification and revise mode requires exactly one"
      );
    }
    return {
      schema_id: "penny.definition-request.v1",
      schema_version: 1,
      request,
      goal: defineRequest.goal,
      constraints: defineRequestConstraints(defineRequest),
      ...(request.input_artifacts === undefined
        ? {}
        : { input_artifacts: request.input_artifacts }),
      admission_data: {
        native: defineRequest,
        assurance: host.assurance?.checkpointer.runExists(request.identity.run_id)
          ? null
          : requirePreparedAssurance(
              defineAssuranceInput(request, defineRequest, invocation.specification_assurance, host)
            ),
      },
    };
  },
  materialize: (prepared, host) => {
    const data = prepared.admission_data;
    if (typeof data !== "object" || data === null || !("native" in data) || !("assurance" in data))
      throw new Error("Define start admission data is missing");
    const request = validateDefineRequest(data.native);
    const invocation = validateDefineInvocation(prepared.request.constraints);
    const assuranceInput = defineAssuranceInput(
      prepared.request,
      request,
      invocation.specification_assurance,
      host
    );
    const assuranceRef =
      data.assurance === null
        ? assertExistingStartAssurance(assuranceInput)
        : requireMaterializedAssurance(
            assuranceInput,
            validateCompositionAssurance(data.assurance)
          );
    const upstreamRefs = prepared.input_artifacts?.artifacts.map((binding) => binding.ref) ?? [];
    const requestRef = persistDefineRequestArtifact({
      request,
      runId: host.run_id,
      upstreamRefs,
      ...(host.artifactStore === undefined ? {} : { store: host.artifactStore }),
    });
    if (requestRef === undefined || host.artifactStore === undefined)
      throw new Error("Define start requires a writable artifact store");
    const manifestRef = persistDefinitionSourceManifest(host.artifactStore, requestRef, request);
    return [requestRef, manifestRef, ...(assuranceRef === undefined ? [] : [assuranceRef])];
  },
};

function outputMetadata(
  context: RunContext,
  state: DefineWorkerState,
  upstreamRefs: readonly ArtifactRef[],
  revisions?: ArtifactRevisionLookup,
  narrowRepair = false
): OutputArtifactMetadata {
  const draft = state === "authoring_specification";
  const draftTransport = specificationDraftTransport(context);
  return buildOutputArtifactMetadata({
    context,
    phase: state,
    agent: DEFINE_AGENT_BY_STATE[state],
    branchId: null,
    upstreamRefs,
    ...(revisions === undefined ? {} : { revisions }),
    ...(draft
      ? narrowRepair
        ? {
            artifactKind: "specification-draft-repair",
            mediaType: "text/plain; charset=utf-8",
            contentSchema: {
              schema_id: "penny.specification-draft-repair.v1",
              schema_version: 1,
            },
          }
        : {
            artifactKind: "specification-draft",
            mediaType: "text/plain; charset=utf-8",
            contentSchema: {
              schema_id: `penny.specification-draft.v${draftTransport}`,
              schema_version: draftTransport,
            },
          }
      : {}),
  });
}

function refsForState(
  context: RunContext,
  state: DefineWorkerState,
  store?: ArtifactHostStore
): readonly ArtifactRef[] {
  const request = admittedDefineRequestArtifact(context);
  const assuranceRef = context.selectedArtifacts.find(
    (ref) => ref.kind === "composition-assurance"
  );
  const manifest = admittedDefinitionSourceManifestArtifact(context);
  const inputs = exactDefineInputRefs(context);
  const orientation = latestOrientationArtifact(context);
  const frame = latestDefinitionFrameArtifact(context);
  const admission = latestEvidenceAdmissionArtifact(context);
  const evidence = latestEvidenceArtifact(context);
  const draft = latestSpecificationDraftArtifact(context);
  const product = latestSpecificationArtifact(context);
  const veraReport = latestReviewReportArtifact(context, "verifying_specification");
  const carrenReport = latestReviewReportArtifact(context, "critiquing_specification");
  const validityReceipt = latestReviewReceiptArtifact(context, "validity");
  const trace = latestDefinitionTraceArtifact(context);
  const supportRefs =
    (state === "verifying_specification" || state === "critiquing_specification") &&
    frame?.content_schema?.schema_id === "penny.definition-frame.v2" &&
    admission !== undefined &&
    store !== undefined
      ? readCanonicalJson(store, admission, validateEvidenceAdmissionV2).support_slots.map(
          (slot) => slot.ref
        )
      : [];
  if (state === "framing_definition") {
    return uniqueRefs([
      request,
      assuranceRef,
      manifest,
      ...inputs,
      evidence,
      orientation,
      frame,
      ...clarificationEvidenceRefs(context),
      product,
      veraReport,
      carrenReport,
    ]);
  }
  if (state === "gathering_definition_evidence") {
    if (orientation === undefined || frame === undefined) {
      throw new Error("Echo requires the exact Piper orientation and Definition frame");
    }
    return uniqueRefs([
      request,
      assuranceRef,
      manifest,
      ...inputs,
      orientation,
      frame,
      admission,
      product,
      veraReport,
      carrenReport,
    ]);
  }
  if (state === "authoring_specification") {
    if (orientation === undefined || frame === undefined) {
      throw new Error(
        "Rhea specification authorship requires the exact Piper orientation and Definition frame"
      );
    }
    return uniqueRefs([
      request,
      assuranceRef,
      manifest,
      orientation,
      frame,
      admission,
      evidence,
      ...clarificationEvidenceRefs(context),
      ...inputs,
      draft,
      currentSealDiagnosticArtifact(context),
      product,
      veraReport,
      carrenReport,
    ]);
  }
  if (
    orientation === undefined ||
    frame === undefined ||
    admission === undefined ||
    draft === undefined ||
    product === undefined
  ) {
    throw new Error(
      `${state} requires exact orientation, Definition frame, evidence admission, draft, and latest sealed SpecificationV1`
    );
  }
  if (frame.content_schema?.schema_id === "penny.definition-frame.v2" && trace === undefined) {
    throw new Error("V2 Define review requires product-bound trace");
  }
  if (state === "verifying_specification") {
    return uniqueRefs([
      request,
      assuranceRef,
      manifest,
      orientation,
      frame,
      admission,
      draft,
      product,
      trace,
      evidence,
      ...inputs,
      ...supportRefs,
      veraReport,
      carrenReport,
    ]);
  }
  if (veraReport === undefined || validityReceipt === undefined) {
    throw new Error("Carren requires Vera's exact report and host validity receipt");
  }
  return uniqueRefs([
    request,
    assuranceRef,
    manifest,
    orientation,
    frame,
    admission,
    draft,
    product,
    trace,
    evidence,
    ...inputs,
    ...supportRefs,
    veraReport,
    carrenReport,
    validityReceipt,
  ]);
}

function slotForRef(context: RunContext, ref: ArtifactRef): string {
  if (ref.kind === "definition-request") return "definition-request";
  if (ref.kind === "definition-source-manifest") return "definition-source-manifest";
  if (ref.kind === "specification-draft") return "latest-specification-draft";
  if (ref.kind === "specification-draft-repair") return "latest-specification-draft-repair";
  if (ref.kind === "specification-seal-feedback") return "specification-seal-feedback"; // historical reader
  if (ref.kind === "seal-diagnostic") return "seal-diagnostic";
  if (ref.kind === "review-receipt") return `prior-${ref.branch_id ?? "review"}-receipt`;
  if (ref.kind === "evidence-admission") return "specification-evidence-admission";
  if (ref.kind === "definition-frame") return "definition-frame";
  if (ref.kind === "definition-trace") return "definition-trace";
  if (ref.kind === "definition-clarification-challenge")
    return `definition-challenge-${ref.artifact_id.slice(-12)}`;
  if (ref.kind === "definition-clarification-response")
    return `definition-response-${ref.artifact_id.slice(-12)}`;
  if (ref.kind === "evidence-context") return "evidence-context";
  if (ref.phase === "framing_definition") return "latest-specification-orientation";
  if (ref.phase === "gathering_definition_evidence") return "latest-specification-evidence";
  if (ref.phase === "verifying_specification") return "latest-vera-report";
  if (ref.phase === "critiquing_specification") return "latest-carren-report";
  if (ref.content_schema?.schema_id === "penny.grounded-synthesis.v1") {
    return "prior-grounded-synthesis";
  }
  if (ref.content_schema?.schema_id === "penny.decision.v2") return "prior-decision";
  if (ref.content_schema?.schema_id === "penny.specification.v1") {
    return ref.run_id === context.identity.run_id ? "latest-specification" : "prior-specification";
  }
  return `input-${ref.artifact_id.slice(-12)}`;
}

function taskForState(context: RunContext, state: DefineWorkerState, narrowRepair = false): string {
  const draftTransport = specificationDraftTransport(context);
  const common =
    "Read the exact DefinitionRequestV1 and DefinitionSourceManifestV1 in every phase. The host manifest gives the ordered ordinal, kind, stable source ID, and value digest; request bytes supply full values. Do not reconstruct numbering, invent missing rows, or mistake an ordinal's kind. Reviewers must compare meanings with the request; structural coverage alone is not semantic attribution. artifact_read is mandatory for every needed exact workflow predecessor in input_artifacts; continue through next_range. No other tool or channel may substitute for a missing predecessor ref: never discover predecessor output through memory, /tmp, repository search, historical sessions, or name-only pointers. If an exact EvidenceContextV1 is supplied, read it and any needed source_ref artifacts through artifact_read; treat it only as contextual input and never copy the packet into task prose or relabel it as native EvidenceAdmissionV1, gathered evidence, approval, or proof. Other tools in the assigned catalog agent's YAML surface may be used only when materially relevant, permitted by the caller and task, and within this phase's consequence boundary; they must not bypass host-owned evidence admission. On repair, the latest same-run sealed SpecificationV1 is the exact previously reviewed product; use it and the latest reports from both review stages to fix the whole reported contract, not just one example. Reports about earlier product versions are historical feedback, never approval or evidence for a newly sealed product. Recheck the current sealed product; a current-product Vera PASS and its host validity receipt support validity only, not automatic quality approval. The owner captures and re-reads complete bytes; do not claim persistence.";
  switch (state) {
    case "framing_definition":
      return [
        common,
        "Frame only. Read the exact DefinitionRequestV1 and exact optional inputs. Select one registered profile only when materially justified; use generic when no specialized profile fits. Caller-owned ambiguity about mode, scope, audience, authority, or profile routes to clarify. Externally resolvable facts or standards questions route to evidence. Otherwise route to author. Never let evidence decide caller intent. Do not author the specification, plan, taskify, approve, mutate, or execute.",
        "Emit orientation_complete=true, gap_kind=none, repair_owner=none, selected_profile_id, profile_selection_basis, one closed route (author, clarify, or evidence), route_reason, route-appropriate question arrays, findings, and specification_delta. Clarify requires at least one clarification question and no evidence questions. Evidence requires at least one evidence question and no clarification questions. Author requires both arrays empty. Never emit a target state.",
        "On reframing, read the exact selected clarification challenge and response artifacts. Carry support for unchanged question IDs by exact response ref. Never treat an unanswered or declined question as resolved, or re-ask a declined question without new caller intent.",
      ].join("\n\n");
    case "gathering_definition_evidence":
      return [
        common,
        "Resolve only the exact host-admitted specification-blocking gap. When compatible with caller constraints, use narrowly targeted read-only local inspection or web retrieval only for that gap; do not broaden into open-ended research, use memory as evidence acquisition, mutate anything, or execute application business logic. Record a precise source locator for every acquired item (a path plus line/range, or a URL plus relevant section and date), distinguish source-backed findings from inference, and report the gap honestly as unresolved when evidence is unavailable, conflicting, disallowed, or the bounded budget is exhausted. Do not design the specification, taskify, approve, mutate, or execute.",
      ].join("\n\n");
    case "authoring_specification":
      return [
        common,
        `MECHANICALLY_PROJECTED_SPECIFICATION_DRAFT_CONTRACT:${narrowRepair ? specificationDraftRepairPromptContract() : draftTransport === 3 ? specificationDraftV3PromptContract() : draftTransport === 2 ? specificationDraftV2PromptContract() : specificationDraftPromptContract()}`,
        `MECHANICALLY_PROJECTED_SPECIFICATION_LINEAGE_CONTRACT:${specificationLineagePromptContract()}`,
        narrowRepair
          ? "Read the exact rejected SpecificationDraftV3 and its exact SealDiagnosticV1. Emit only one closed SpecificationDraftRepairV1 bound to those exact refs and digest. Use stable draft keys to add acceptance criteria or append diagnosed keys to an otherwise unchanged criterion so every typed UNCOVERED_REQUIREMENT is fixed. Do not remove criteria, remove existing links, or add unrelated requirement links. Preserve the rest of the draft; the host applies the repair, materializes a new immutable complete draft, and validates the entire candidate. Do not emit a complete replacement in this narrow repair route."
          : `Read the exact DefinitionRequestV1 and host-sealed DefinitionFrameV2 directly (historical runs retain their recorded frame and draft transport); orientation, admitted evidence, prior SpecificationV1, GroundedSynthesisV1, DecisionV2, and EvidenceContextV1 inputs are supporting evidence, not authority. EvidenceContext remains contextual input, not native evidence admission or proof. Produce one complete replacement ${draftTransport === 3 ? "SpecificationDraftV3 with stable draft-local keys" : draftTransport === 2 ? "historical SpecificationDraftV2 with its recorded index relationships" : "historical SpecificationDraftV1"}, exact source coverage, target-specific support claims when that transport supports them, profile-required categories, requirement-to-criterion coverage, standards status, planning readiness, and mode-correct supersession intents. Create always emits an empty supersession_intents array, including repair of a same-run sealed product. Revise emits intents only against exact items from the imported prior SpecificationV1 and is a standalone full replacement. Define only; do not plan, taskify, approve, mutate, or execute.`,
      ].join("\n\n");
    case "verifying_specification":
      return [
        common,
        `MECHANICALLY_PROJECTED_SPECIFICATION_LINEAGE_CONTRACT:${specificationLineagePromptContract()}`,
        "Verify the exact latest sealed SpecificationV1 against the exact DefinitionRequestV1, Definition frame (V2 for new runs), Rhea draft, optional admitted evidence, prior specification when revising, and every imported source ref. Check profile semantics, stable IDs, exact source coverage, requirement-to-criterion coverage, standards claims, planning handoff, full-replacement revision closure, explicit supersession, and false planning/taskification/execution flags. PASS only when valid.",
        "On FAIL emit exactly one gap_kind and repair_owner: evidence_gap/echo, analysis_gap/piper, or product_gap/rhea. On PASS use none/none. When verification capability or trustworthy verification evidence is unavailable, emit UNVERIFIABLE with verification_incomplete/none, not an author-repair gap. A valid blocked specification may PASS; unknown effects alone are not a defect. Never emit a target state.",
      ].join("\n\n");
    case "critiquing_specification":
      return [
        common,
        `MECHANICALLY_PROJECTED_SPECIFICATION_LINEAGE_CONTRACT:${specificationLineagePromptContract()}`,
        "Critique the exact Vera-passed latest SpecificationV1 for strategic coherence, risk and contingency quality, useful granularity, implementation freedom, clarity, and non-misleading framing. The prior host validity receipt is evidence, not authority to overlook defects.",
        "APPROVE only with no major or critical finding; minor nonblocking findings may remain. NEEDS_REVISION emits exactly one gap_kind and repair_owner: evidence_gap/echo, analysis_gap/piper, or product_gap/rhea. APPROVE uses none/none. Never emit a target state.",
      ].join("\n\n");
  }
}

function persistVersionedHostArtifact(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly phase:
    | "definition_readiness_gate"
    | "sealing_specification"
    | ReviewState
    | "critiquing_specification";
  readonly branchId: string | null;
  readonly kind: string;
  readonly operationLabel: string;
  readonly producer: string;
  readonly contentSchema: { readonly schema_id: string; readonly schema_version: number };
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly content: string | Uint8Array;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const operationId = `define-${input.operationLabel}:${sha256(input.context.identity.run_id).slice(0, 32)}`;
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

class SpecificationDraftRepairRejectedError extends Error {
  constructor(
    readonly repairRef: ArtifactRef,
    message: string
  ) {
    super(message);
    this.name = "SpecificationDraftRepairRejectedError";
  }
}

function validateNarrowSpecificationDraftRepair(input: {
  readonly base: SpecificationDraftV3;
  readonly repair: SpecificationDraftRepairV1;
  readonly diagnostic: SealDiagnosticV1;
  readonly repairRef: ArtifactRef;
}): void {
  const prefix = "/specification/requirements/by-key/";
  const suffix = "/acceptance_coverage";
  const uncovered = new Set(
    input.diagnostic.issues.map((issue) => {
      if (
        issue.code !== "UNCOVERED_REQUIREMENT" ||
        !issue.path.startsWith(prefix) ||
        !issue.path.endsWith(suffix)
      ) {
        throw new SpecificationDraftRepairRejectedError(
          input.repairRef,
          "closed repair diagnostic is not exclusively key-addressed uncovered requirements"
        );
      }
      return issue.path.slice(prefix.length, -suffix.length);
    })
  );
  const added = new Set<string>();
  for (const operation of input.repair.operations) {
    if (operation.operation === "remove_acceptance_criterion") {
      throw new SpecificationDraftRepairRejectedError(
        input.repairRef,
        "an uncovered-requirement repair cannot remove acceptance criteria"
      );
    }
    if (operation.operation === "add_acceptance_criterion") {
      if (operation.criterion.requirement_keys.some((key) => !uncovered.has(key))) {
        throw new SpecificationDraftRepairRejectedError(
          input.repairRef,
          "an uncovered-requirement repair cannot add unrelated requirement links"
        );
      }
      operation.criterion.requirement_keys.forEach((key) => added.add(key));
      continue;
    }
    const original = input.base.specification.acceptance_criteria.find(
      (criterion) => criterion.draft_key === operation.criterion_key
    );
    if (
      original === undefined ||
      operation.criterion.statement !== original.statement ||
      operation.criterion.observation !== original.observation ||
      canonicalJson(operation.criterion.source_item_indexes) !==
        canonicalJson(original.source_item_indexes) ||
      original.requirement_keys.some((key) => !operation.criterion.requirement_keys.includes(key))
    ) {
      throw new SpecificationDraftRepairRejectedError(
        input.repairRef,
        "an uncovered-requirement replacement may only append requirement links"
      );
    }
    const appended = operation.criterion.requirement_keys.filter(
      (key) => !original.requirement_keys.includes(key)
    );
    if (appended.length === 0 || appended.some((key) => !uncovered.has(key))) {
      throw new SpecificationDraftRepairRejectedError(
        input.repairRef,
        "an uncovered-requirement replacement lacks an exact diagnosed key"
      );
    }
    appended.forEach((key) => added.add(key));
  }
  if (
    added.size !== uncovered.size ||
    [...uncovered].some((requirementKey) => !added.has(requirementKey))
  ) {
    throw new SpecificationDraftRepairRejectedError(
      input.repairRef,
      "closed repair does not address every diagnosed uncovered requirement"
    );
  }
}

function materializeCurrentSpecificationDraftRepair(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
}): ArtifactRef | undefined {
  const { context, store } = input;
  const base = latestSpecificationDraftArtifact(context);
  const repairRef = latestSpecificationDraftRepairArtifact(context);
  const diagnostic = readCurrentSealDiagnostic(context, store);
  if (base === undefined || repairRef === undefined || diagnostic === undefined) return undefined;
  const baseIndex = context.selectedArtifacts.findIndex(
    (ref) => ref.artifact_id === base.artifact_id
  );
  const repairIndex = context.selectedArtifacts.findIndex(
    (ref) => ref.artifact_id === repairRef.artifact_id
  );
  if (baseIndex < 0 || repairIndex <= baseIndex) return undefined;
  if (
    canonicalJson(store.refById(base.artifact_id)) !== canonicalJson(base) ||
    canonicalJson(store.refById(repairRef.artifact_id)) !== canonicalJson(repairRef)
  ) {
    throw new Error("SpecificationDraftRepairV1 operands lack exact custody");
  }
  let repair: SpecificationDraftRepairV1;
  try {
    repair = parseSpecificationDraftRepair(store.readById(repairRef.artifact_id)).repair;
  } catch (error) {
    if (error instanceof SpecificationDraftValidationError) {
      throw new SpecificationDraftRepairRejectedError(repairRef, error.message);
    }
    throw error;
  }
  if (
    canonicalJson(repair.base_draft_ref) !== canonicalJson(base) ||
    repair.base_draft_sha256 !== base.content_digest ||
    canonicalJson(repair.diagnostic_ref) !== canonicalJson(diagnostic.ref) ||
    repairRef.run_id !== context.identity.run_id
  ) {
    throw new SpecificationDraftRepairRejectedError(
      repairRef,
      "SpecificationDraftRepairV1 differs from the checkpoint-selected base"
    );
  }
  const baseCandidate = parseSpecificationDraftV3Candidate(store.readById(base.artifact_id)).draft;
  validateNarrowSpecificationDraftRepair({
    base: baseCandidate,
    repair,
    diagnostic: diagnostic.value,
    repairRef,
  });
  let applied: SpecificationDraftV3;
  try {
    applied = applySpecificationDraftRepair({ base: baseCandidate, repair });
  } catch (error) {
    if (
      error instanceof SpecificationDraftValidationError ||
      error instanceof SkillSchemaValidationError
    ) {
      throw new SpecificationDraftRepairRejectedError(repairRef, error.message);
    }
    throw error;
  }
  const content = persistedSpecificationDraftV3(applied);
  const metadata = currentOutputArtifactMetadata({
    schema_version: 2,
    run_id: context.identity.run_id,
    phase: "authoring_specification",
    branch_id: null,
    kind: "specification-draft",
    operation_id: base.operation_id,
    version: base.version + 1,
    producer: "host:specification-draft-repair",
    media_type: "text/plain; charset=utf-8",
    content_schema: { schema_id: "penny.specification-draft.v3", schema_version: 3 },
    parent_ref: base,
    upstream_refs: [base, repairRef, diagnostic.ref],
  });
  const existing = store.refFor(
    metadata.run_id,
    metadata.phase,
    metadata.branch_id,
    metadata.kind,
    metadata.operation_id,
    metadata.version
  );
  const artifact = existing ?? store.persist({ metadata, content });
  if (
    canonicalJson(store.refById(artifact.artifact_id)) !== canonicalJson(artifact) ||
    canonicalJson(store.metadata(artifact)) !== canonicalJson(metadata) ||
    !store.readById(artifact.artifact_id).equals(content)
  ) {
    throw new Error("materialized SpecificationDraftV3 repair conflicted with immutable custody");
  }
  store.select(artifact);
  addSelectedArtifact(context, artifact);
  return artifact;
}

function specificationDraftAuthoringRefs(
  store: ArtifactHostStore,
  draft: ArtifactRef
): readonly ArtifactRef[] {
  const visited = new Set<string>();
  const read = (current: ArtifactRef): readonly ArtifactRef[] => {
    if (visited.has(current.artifact_id)) {
      throw new Error("materialized SpecificationDraftV3 repair lineage contains a cycle");
    }
    visited.add(current.artifact_id);
    if (current.producer !== "host:specification-draft-repair") return [current];
    const upstream = store.metadata(current).upstream_refs;
    const base = upstream.find((ref) => ref.kind === "specification-draft");
    const repair = upstream.find((ref) => ref.kind === "specification-draft-repair");
    const diagnostic = upstream.find((ref) => ref.kind === "seal-diagnostic");
    if (
      base === undefined ||
      repair === undefined ||
      diagnostic === undefined ||
      upstream.length !== 3
    ) {
      throw new Error("materialized SpecificationDraftV3 lacks its exact repair lineage");
    }
    const { repair: value } = parseSpecificationDraftRepair(store.readById(repair.artifact_id));
    if (
      canonicalJson(value.base_draft_ref) !== canonicalJson(base) ||
      value.base_draft_sha256 !== base.content_digest ||
      canonicalJson(value.diagnostic_ref) !== canonicalJson(diagnostic)
    ) {
      throw new Error("materialized SpecificationDraftV3 repair lineage drifted");
    }
    const applied = applySpecificationDraftRepair({
      base: parseSpecificationDraftV3Candidate(store.readById(base.artifact_id)).draft,
      repair: value,
    });
    if (!store.readById(current.artifact_id).equals(persistedSpecificationDraftV3(applied))) {
      throw new Error("materialized SpecificationDraftV3 bytes drifted from its repair");
    }
    const earlier = read(base);
    return [current, base, repair, diagnostic, ...earlier.slice(1)];
  };
  return read(draft);
}

function specificationDraftExecutionArtifacts(
  store: ArtifactHostStore,
  draft: ArtifactRef
): readonly ArtifactRef[] {
  const authoring = specificationDraftAuthoringRefs(store, draft);
  const original = authoring.find(
    (ref) =>
      ref.kind === "specification-draft" && ref.producer !== "host:specification-draft-repair"
  );
  const repairs = authoring.filter((ref) => ref.kind === "specification-draft-repair").reverse();
  if (original === undefined) {
    throw new Error("materialized SpecificationDraftV3 lacks its original authored draft");
  }
  return [original, ...repairs];
}

function clarificationEvidenceRefs(context: RunContext): ArtifactRef[] {
  return context.selectedArtifacts.filter(
    (ref) =>
      ref.kind === "definition-clarification-challenge" ||
      ref.kind === "definition-clarification-response"
  );
}

/** Fixed gate addresses: bytes and metadata must match even after a pre-checkpoint crash. */
function persistFixedClarification(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly phase: "definition_readiness_gate" | "awaiting_clarification";
  readonly kind: "definition-clarification-challenge" | "definition-clarification-response";
  readonly operationId: string;
  readonly gateId: string;
  readonly producer: string;
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly content: string;
}): { readonly artifact: ArtifactRef; readonly added: boolean } {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.context.identity.run_id,
    phase: input.phase,
    branch_id: input.gateId,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: input.producer,
    media_type: "application/json",
    content_schema: { schema_id: `penny.${input.kind}.v1`, schema_version: 1 },
    parent_ref: null,
    upstream_refs: [...input.upstreamRefs],
  };
  const prior = input.store.refFor(
    input.context.identity.run_id,
    input.phase,
    input.gateId,
    input.kind,
    input.operationId,
    1
  );
  const artifact = prior ?? input.store.persist({ metadata, content: input.content });
  if (
    input.store.lastVersion(
      input.context.identity.run_id,
      input.phase,
      input.gateId,
      input.kind,
      input.operationId
    ) !== 1 ||
    canonicalJson(input.store.metadata(artifact)) !== canonicalJson(metadata) ||
    input.store.readById(artifact.artifact_id).toString("utf8") !== input.content ||
    canonicalJson(input.store.refById(artifact.artifact_id)) !== canonicalJson(artifact)
  ) {
    throw new Error("fixed Define clarification artifact conflict or custody failure");
  }
  input.store.select(artifact);
  return { artifact, added: addSelectedArtifact(input.context, artifact) };
}

function readSelectedChallenge(
  context: RunContext,
  store: ArtifactHostStore,
  ref: ArtifactRef
): DefinitionClarificationChallengeV1 {
  if (
    !context.selectedArtifacts.some((selected) => canonicalJson(selected) === canonicalJson(ref)) ||
    canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref) ||
    ref.kind !== "definition-clarification-challenge" ||
    ref.content_schema?.schema_id !== "penny.definition-clarification-challenge.v1"
  ) {
    throw new Error("Definition clarification challenge has no selected custody");
  }
  const frameArtifact = store
    .metadata(ref)
    .upstream_refs.find((item) => item.kind === "definition-frame");
  if (frameArtifact === undefined)
    throw new Error("Definition clarification challenge has no frame");
  const frame = readDefinitionFrameV2(store, context, frameArtifact);
  const value = validateDefinitionClarificationChallenge(readFrameBytes(store, ref), frame);
  if (
    canonicalJson(value.frame_ref) !== canonicalJson(frameArtifact) ||
    canonicalJson(value.request_ref) !== canonicalJson(admittedDefineRequestArtifact(context)) ||
    canonicalJson(value.manifest_ref) !==
      canonicalJson(admittedDefinitionSourceManifestArtifact(context)) ||
    value.gate_id !==
      stableDefinitionId("definition-gate", {
        run_id: context.identity.run_id,
        frame_ref: frameArtifact,
        gate_visit: value.gate_visit,
      }) ||
    ref.branch_id !== value.gate_id ||
    ref.phase !== "definition_readiness_gate" ||
    ref.operation_id !==
      `definition-challenge:${sha256(canonicalJson({ run_id: context.identity.run_id, gate_id: value.gate_id }))}` ||
    canonicalJson(store.metadata(ref).upstream_refs) !==
      canonicalJson([value.request_ref, value.manifest_ref, value.frame_ref])
  ) {
    throw new Error("Definition clarification challenge request binding changed");
  }
  return value;
}

function priorClarificationAnswers(
  context: RunContext,
  store: ArtifactHostStore
): Map<string, "answered" | "declined" | "not_answered"> {
  const status = new Map<string, "answered" | "declined" | "not_answered">();
  for (const ref of context.selectedArtifacts.filter(
    (item) => item.kind === "definition-clarification-response"
  )) {
    if (
      canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref) ||
      ref.content_schema?.schema_id !== "penny.definition-clarification-response.v1"
    ) {
      throw new Error("selected Definition response has invalid custody");
    }
    const challengeRef = store
      .metadata(ref)
      .upstream_refs.find((item) => item.kind === "definition-clarification-challenge");
    if (challengeRef === undefined) throw new Error("Definition response has no challenge");
    const challenge = readSelectedChallenge(context, store, challengeRef);
    const value = validateDefinitionClarificationResponse({
      value: readFrameBytes(store, ref),
      challenge,
      challengeRef,
    });
    if (
      value.owner_response_id !==
        stableDefinitionId("definition-owner-response", {
          run_id: context.identity.run_id,
          gate_id: challenge.gate_id,
          challenge_ref: challengeRef,
        }) ||
      ref.branch_id !== challenge.gate_id ||
      ref.phase !== "awaiting_clarification" ||
      ref.operation_id !==
        `definition-response:${sha256(canonicalJson({ run_id: context.identity.run_id, gate_id: challenge.gate_id }))}` ||
      canonicalJson(store.metadata(ref).upstream_refs) !==
        canonicalJson([challengeRef, challenge.request_ref])
    ) {
      throw new Error("selected Definition response owner identity changed");
    }
    for (const row of value.answers) status.set(row.question_id, row.disposition);
  }
  return status;
}

function detailStrings(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function persistDefinitionFrame(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: DefinitionFrameV1 | DefinitionFrameV2;
  readonly added: boolean;
} {
  const requestRef = admittedDefineRequestArtifact(input.context);
  const orientation = latestOrientationArtifact(input.context);
  if (orientation === undefined) throw new Error("definition readiness requires Piper framing");
  const execution = exactAcceptedExecutionGroup({
    context: input.context,
    checkpointer: input.checkpointer,
    artifact: orientation,
  });
  const details = execution.routed.details;
  const selectedProfileId = details.selected_profile_id;
  const route = details.route;
  if (
    (selectedProfileId !== "generic" &&
      selectedProfileId !== "software" &&
      selectedProfileId !== "business_process" &&
      selectedProfileId !== "research") ||
    (route !== "author" && route !== "clarify" && route !== "evidence") ||
    typeof details.profile_selection_basis !== "string" ||
    typeof details.route_reason !== "string"
  ) {
    throw new Error("accepted definition framing lacks a closed profile or readiness route");
  }
  // A bound historical V1 run (including a persisted pre-checkpoint V1 orphan)
  // continues its own frame version. Only genuinely new starts mint V2.
  const previous = latestDefinitionFrameArtifact(input.context);
  const operationId = `define-definition-frame:${sha256(input.context.identity.run_id).slice(0, 32)}`;
  const orphan = input.store.refFor(
    input.context.identity.run_id,
    "definition_readiness_gate",
    "frame",
    "definition-frame",
    operationId,
    (previous?.version ?? 0) + 1
  );
  const legacy =
    previous?.content_schema?.schema_id === "penny.definition-frame.v1" ||
    orphan?.content_schema?.schema_id === "penny.definition-frame.v1";
  const request = canonicalDefineRequest(input.store, input.context);
  const proposed = [
    ...detailStrings(details.clarification_questions).map((question) => ({
      question,
      owner: "caller" as const,
      material: true,
    })),
    ...detailStrings(details.evidence_questions).map((question) => ({
      question,
      owner: "evidence" as const,
      material: true,
    })),
  ];
  const previousV2 =
    previous?.content_schema?.schema_id === "penny.definition-frame.v2"
      ? readDefinitionFrameV2(input.store, input.context, previous)
      : undefined;
  const carried =
    previousV2?.questions.filter(
      (q) =>
        q.source_item_index === null &&
        q.material &&
        !proposed.some(
          (item) =>
            item.question === q.question && item.owner === q.owner && item.material === q.material
        )
    ) ?? [];
  const value = legacy
    ? canonicalizeDefinitionFrame({
        request,
        selectedProfileId,
        profileSelectionBasis: details.profile_selection_basis,
        route,
        routeReason: details.route_reason,
        clarificationQuestions: detailStrings(details.clarification_questions),
        evidenceQuestions: detailStrings(details.evidence_questions),
      })
    : canonicalizeDefinitionFrameV2({
        request,
        requestRef,
        orientationRef: orientation,
        selectedProfileId,
        profileSelectionBasis: details.profile_selection_basis,
        route,
        routeReason: details.route_reason,
        discoveredQuestions: proposed,
        carriedQuestions: carried,
      });
  if (
    previous?.content_schema?.schema_id === "penny.definition-frame.v2" &&
    value.schema_version === 2
  ) {
    const oldFrame = readDefinitionFrameV2(input.store, input.context, previous);
    const currentIds = new Set(value.questions.map((q) => q.question_id));
    if (
      oldFrame.questions.some(
        (q) => q.material && q.source_item_index === null && !currentIds.has(q.question_id)
      )
    ) {
      throw new Error(
        "a material discovered Definition question cannot disappear without a reviewed disposition"
      );
    }
  }
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "definition_readiness_gate",
    branchId: "frame",
    kind: "definition-frame",
    operationLabel: "definition-frame",
    producer: "host:definition-framer",
    contentSchema: legacy
      ? { schema_id: "penny.definition-frame.v1", schema_version: 1 }
      : { schema_id: "penny.definition-frame.v2", schema_version: 2 },
    upstreamRefs: uniqueRefs([
      requestRef,
      admittedDefinitionSourceManifestArtifact(input.context),
      orientation,
      ...(value.schema_version === 2 ? value.questions.map((q) => q.origin_ref) : []),
    ]),
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

function definitionAllowedUses(
  frame: DefinitionFrameV2,
  request: DefineRequestV1
): DefinitionAllowedUseV1[] {
  const categories = new Set([
    ...request.standard_hints.map((hint) => hint.category),
    ...specificationProfile(frame.profile.profile_id).required_standard_categories,
  ]);
  return [
    ...frame.questions
      .filter((question) => question.owner === "evidence")
      .map((question) =>
        question.source_item_index === null
          ? { kind: "discovered_question" as const, question_id: question.question_id }
          : { kind: "request_uncertainty" as const, source_item_index: question.source_item_index }
      ),
    ...[...categories].sort().map((category) => ({ kind: "standard_category" as const, category })),
  ];
}

function selectedDefinitionSupportSlots(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly frame: DefinitionFrameV2;
  readonly request: DefineRequestV1;
  readonly native: ArtifactRef | undefined;
}): DefinitionSupportSlotV1[] {
  const { context, store, frame, request } = input;
  const slots: DefinitionSupportSlotV1[] = [];
  for (const ref of context.selectedArtifacts.filter(
    (item) => item.kind === "definition-clarification-response"
  )) {
    const challengeRef = store
      .metadata(ref)
      .upstream_refs.find((item) => item.kind === "definition-clarification-challenge");
    if (challengeRef === undefined) throw new Error("Define selected response lacks a challenge");
    const challenge = readSelectedChallenge(context, store, challengeRef);
    const response = validateDefinitionClarificationResponse({
      value: readFrameBytes(store, ref),
      challenge,
      challengeRef,
    });
    const allowed_uses: DefinitionAllowedUseV1[] = response.answers.flatMap((answer) => {
      const question = frame.questions.find((q) => q.question_id === answer.question_id);
      if (answer.disposition !== "answered" || question?.owner !== "caller") return [];
      return [
        question.source_item_index === null
          ? { kind: "discovered_question" as const, question_id: question.question_id }
          : { kind: "request_uncertainty" as const, source_item_index: question.source_item_index },
      ];
    });
    if (allowed_uses.length > 0)
      slots.push({ ref, role: "caller_response", allowed_uses, challenge_ref: challengeRef });
  }
  const evidenceUses = definitionAllowedUses(frame, request);
  if (input.native !== undefined && evidenceUses.length > 0) {
    slots.push({
      ref: input.native,
      role: "native_evidence",
      allowed_uses: evidenceUses,
      challenge_ref: null,
    });
  }
  for (const ref of exactDefineInputRefs(context)) {
    if (evidenceUses.length > 0) {
      slots.push({
        ref,
        role: "imported_evidence",
        allowed_uses: evidenceUses,
        challenge_ref: null,
      });
    }
  }
  if (slots.length > 69) throw new Error("Define admission exceeds 69 support refs");
  for (const slot of slots) {
    if (canonicalJson(store.refById(slot.ref.artifact_id)) !== canonicalJson(slot.ref)) {
      throw new Error("Define support ref has no exact selected custody");
    }
    store.readById(slot.ref.artifact_id);
  }
  return slots;
}

function persistSpecificationEvidenceAdmission(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: EvidenceAdmissionV1 | EvidenceAdmissionV2;
  readonly added: boolean;
} {
  const orientation = latestOrientationArtifact(input.context);
  if (orientation === undefined)
    throw new Error("specification evidence gate requires Piper orientation");
  const execution = exactAcceptedExecutionGroup({
    context: input.context,
    checkpointer: input.checkpointer,
    artifact: orientation,
  });
  const frameRef = latestDefinitionFrameArtifact(input.context);
  if (frameRef === undefined)
    throw new Error("specification evidence gate requires an exact Definition frame");
  const request = canonicalDefineRequest(input.store, input.context);
  const gap =
    readDefinitionFrame(
      input.store,
      frameRef,
      request,
      admittedDefineRequestArtifact(input.context),
      orientation
    ).route === "evidence";
  const common = {
    run_id: input.context.identity.run_id,
    domain: "specification" as const,
    origin_state: "framing_definition" as const,
    source_artifact_ref: orientation,
    routing_result_sha256: sha256(canonicalJson(execution.routed)),
    source_execution_receipt_ids: [...execution.receiptIds],
    classification: gap
      ? ("specification_blocking_evidence_gap" as const)
      : ("basis_sufficient" as const),
    evidence_required: gap,
    minted_by: "host:evidence-gate" as const,
  };
  const frameV2 =
    frameRef.content_schema?.schema_id === "penny.definition-frame.v2"
      ? readDefinitionFrameV2(input.store, input.context, frameRef)
      : undefined;
  const value =
    frameV2 === undefined
      ? (() => {
          const body: Omit<EvidenceAdmissionV1, "admission_id"> = {
            schema_id: "penny.evidence-admission.v1",
            schema_version: 1,
            ...common,
          };
          return validateEvidenceAdmission({ ...body, admission_id: evidenceAdmissionId(body) });
        })()
      : (() => {
          const body: Omit<EvidenceAdmissionV2, "admission_id"> = {
            schema_id: "penny.evidence-admission.v2",
            schema_version: 2,
            ...common,
            frame_ref: frameRef,
            support_slots: selectedDefinitionSupportSlots({
              context: input.context,
              store: input.store,
              frame: frameV2,
              request,
              native: gap ? latestEvidenceArtifact(input.context) : undefined,
            }),
          };
          return validateEvidenceAdmissionV2({
            ...body,
            admission_id: evidenceAdmissionV2Id(body),
          });
        })();
  const supportRefs =
    value.schema_version === 2
      ? value.support_slots.flatMap((slot) => [
          slot.ref,
          ...(slot.challenge_ref === null ? [] : [slot.challenge_ref]),
        ])
      : [];
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "definition_readiness_gate",
    branchId: null,
    kind: "evidence-admission",
    operationLabel: "evidence-admission",
    producer: "host:evidence-gate",
    contentSchema: { schema_id: value.schema_id, schema_version: value.schema_version },
    upstreamRefs: uniqueRefs([
      admittedDefinitionSourceManifestArtifact(input.context),
      orientation,
      frameRef,
      ...supportRefs,
    ]),
    content: canonicalJson(value),
  });
  return { ...persisted, value };
}

export function readSpecificationSealFeedback(
  store: ArtifactHostStore,
  artifact: ArtifactRef
): SpecificationSealFeedbackV1 {
  const bytes = store.readById(artifact.artifact_id).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("SpecificationSealFeedbackV1 artifact is not JSON");
  }
  const feedback = validateSpecificationSealFeedback(parsed);
  if (canonicalJson(feedback) !== bytes) {
    throw new Error("SpecificationSealFeedbackV1 artifact is not canonical JSON");
  }
  return feedback;
}

function defineSealIssues(error: SpecificationDraftValidationError): SealIssueV1[] {
  const raw =
    error.sealIssues.length > 0
      ? error.sealIssues
      : error.issues.map((detail, index) => {
          const coverage = error.coverageIssues.find((issue) =>
            detail.includes(`ordinal ${issue.ordinal} (`)
          );
          return {
            code: coverage?.code ?? "SPECIFICATION_DRAFT_INVALID",
            path: coverage?.path ?? `/issues/${index}`,
            detail,
            source_ordinals: coverage === undefined ? [] : [coverage.ordinal],
          };
        });
  return raw.map((issue) => {
    // The draft validator bounds issue characters; the shared diagnostic bounds UTF-8
    // bytes. Retain whole code points without turning a long authored issue into a host fault.
    let boundedDetail = "";
    let bytes = 0;
    for (const character of issue.detail) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > 512) break;
      boundedDetail += character;
      bytes += size;
    }
    return {
      code: issue.code,
      path: issue.path,
      detail: boundedDetail,
      source_ordinals: [...issue.source_ordinals],
    };
  });
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
      `specification artifact '${input.artifact.artifact_id}' requires exactly one accepted execution group`
    );
  }
  const match = matches[0];
  if (match === undefined) throw new Error("accepted specification execution group is absent");
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
  const request = admittedDefineRequestArtifact(context);
  const orientation = latestOrientationArtifact(context);
  const admission = latestEvidenceAdmissionArtifact(context);
  const draft = latestSpecificationDraftArtifact(context);
  const product = latestSpecificationArtifact(context);
  if (
    orientation === undefined ||
    admission === undefined ||
    draft === undefined ||
    product === undefined
  ) {
    throw new Error("latest specification review subject is incomplete");
  }
  const evidenceRefs = uniqueRefs([latestEvidenceArtifact(context)]);
  const importedInputRefs = [...exactDefineInputRefs(context)];
  const assuranceRef = context.selectedArtifacts.find(
    (ref) => ref.kind === "composition-assurance"
  );
  return {
    product_ref: product,
    product_schema_id: "penny.specification.v1",
    product_schema_version: 1,
    product_sha256: product.content_digest,
    request_ref: request,
    ...(assuranceRef === undefined ? {} : { specification_assurance_ref: assuranceRef }),
    analysis_ref: orientation,
    admission_ref: admission,
    draft_ref: draft,
    evidence_refs: evidenceRefs,
    imported_input_refs: importedInputRefs,
    admitted_upstream_sha256: reviewSubjectUpstreamSha256({
      request_ref: request,
      ...(assuranceRef === undefined ? {} : { specification_assurance_ref: assuranceRef }),
      analysis_ref: orientation,
      admission_ref: admission,
      draft_ref: draft,
      product_ref: product,
      evidence_refs: evidenceRefs,
      imported_input_refs: importedInputRefs,
    }),
  };
}

function currentReviewSubjectV2(context: RunContext, store: ArtifactHostStore): ReviewSubjectV2 {
  const base = currentReviewSubject(context);
  const frame = latestDefinitionFrameArtifact(context);
  const trace = latestDefinitionTraceArtifact(context);
  if (
    frame?.content_schema?.schema_id !== "penny.definition-frame.v2" ||
    trace === undefined ||
    base.admission_ref.content_schema?.schema_id !== "penny.evidence-admission.v2" ||
    (base.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v2" &&
      base.draft_ref.content_schema?.schema_id !== "penny.specification-draft.v3")
  ) {
    throw new Error("trace-bound Define review subject is incomplete");
  }
  const { admitted_upstream_sha256: ignored, ...fields } = base;
  void ignored;
  const admission = readCanonicalJson(store, base.admission_ref, validateEvidenceAdmissionV2);
  const body = {
    ...fields,
    frame_ref: frame,
    trace_ref: trace,
    support_refs: admission.support_slots.map((slot) => slot.ref),
  };
  return { ...body, admitted_upstream_sha256: reviewSubjectV2UpstreamSha256(body) };
}

function traceCapable(context: RunContext): boolean {
  return (
    latestDefinitionFrameArtifact(context)?.content_schema?.schema_id ===
    "penny.definition-frame.v2"
  );
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

function readReviewReceiptV2(store: ArtifactHostStore, artifact: ArtifactRef): ReviewReceiptV2 {
  if (
    artifact.content_schema?.schema_id !== "penny.review-receipt.v2" ||
    canonicalJson(store.refById(artifact.artifact_id)) !== canonicalJson(artifact)
  )
    throw new Error("trace-bound review receipt custody or schema differs");
  return readCanonicalJson(store, artifact, validateReviewReceiptV2);
}

function matchingReviewReceiptV2(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly kind: ReviewKind;
  readonly subject: ReviewSubjectV2;
}): { readonly artifact: ArtifactRef; readonly receipt: ReviewReceiptV2 } | undefined {
  const artifact = latestReviewReceiptArtifact(input.context, input.kind);
  if (artifact === undefined) return undefined;
  const receipt = readReviewReceiptV2(input.store, artifact);
  return receipt.review_kind === input.kind &&
    canonicalJson(receipt.subject) === canonicalJson(input.subject)
    ? { artifact, receipt }
    : undefined;
}

function ensureReviewReceiptV2(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly kind: ReviewKind;
}): { readonly artifact: ArtifactRef; readonly receipt: ReviewReceiptV2; readonly added: boolean } {
  assertSelectedDefinitionTrace(input.context, input.store);
  const subject = currentReviewSubjectV2(input.context, input.store);
  const existing = matchingReviewReceiptV2({ ...input, subject });
  if (existing !== undefined) return { ...existing, added: false };
  const state = input.kind === "validity" ? "verifying_specification" : "critiquing_specification";
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
  if (input.kind === "quality" && prior === undefined)
    throw new Error("quality requires current validity receipt");
  const priorReceipt = prior === undefined ? undefined : readReviewReceiptV2(input.store, prior);
  const body: Omit<ReviewReceiptV2, "receipt_id"> = {
    schema_id: "penny.review-receipt.v2",
    schema_version: 2,
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
  const receipt = validateReviewReceiptV2Binding({
    receipt: { ...body, receipt_id: reviewReceiptV2Id(body) },
    review_report_upstream_refs: input.store.metadata(evidence.reportRef).upstream_refs,
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
    contentSchema: { schema_id: "penny.review-receipt.v2", schema_version: 2 },
    upstreamRefs: [
      ...reviewSubjectV2UpstreamRefs(subject),
      ...(prior === undefined ? [] : [prior]),
      evidence.reportRef,
    ],
    content: canonicalJson(receipt),
  });
  const reread = readReviewReceiptV2(input.store, persisted.artifact);
  if (canonicalJson(reread) !== canonicalJson(receipt))
    throw new Error("V2 review receipt re-read differs");
  return { ...persisted, receipt: reread };
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
  const state = input.kind === "validity" ? "verifying_specification" : "critiquing_specification";
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
    throw new Error("specification execution-evidence artifacts must be unique");
  }
  const ids = input.artifacts.flatMap(
    (artifact) => exactAcceptedExecutionGroup({ ...input, artifact }).receiptIds
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error("specification execution receipt IDs must map one-to-one to exact artifacts");
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
      "specification evidence admission does not bind the exact accepted orientation result"
    );
  }
  return admission;
}

/** Rebuild the selected trace from exact product, draft, frame, admission and support bytes. */
function replayCurrentDefinitionTrace(context: RunContext, store: ArtifactHostStore): void {
  assertSelectedDefinitionTrace(context, store);
  const subject = currentReviewSubjectV2(context, store);
  const manifest = admittedDefinitionSourceManifestArtifact(context);
  const product = latestSpecificationArtifact(context);
  const binding = context.registrationContractBinding;
  if (
    product === undefined ||
    binding?.registration_sha256 === undefined ||
    binding.registration_name !== "define"
  )
    throw new Error("Define trace registration or product missing");
  const prior = priorSpecification(store, context);
  const value = validateCanonicalSpecificationBytes(
    store.readById(product.artifact_id),
    product,
    ...(prior === undefined ? [] : [{ priorSpecification: prior.value }])
  );
  const trace = readCanonicalJson(store, subject.trace_ref, validateDefinitionTraceV1);
  const request = canonicalDefineRequest(store, context);
  const frameV2 = readDefinitionFrameV2(store, context, subject.frame_ref);
  const admission = readCanonicalJson(store, subject.admission_ref, validateEvidenceAdmissionV2);
  const draftBytes = store.readById(subject.draft_ref.artifact_id);
  const keyedDraft = subject.draft_ref.content_schema?.schema_id === "penny.specification-draft.v3";
  const draft = keyedDraft
    ? parseSpecificationDraftV3(draftBytes, {
        request,
        frame: frameV2,
        admission,
        ...(prior === undefined ? {} : { priorSpecification: prior.value }),
      })
    : parseSpecificationDraftV2(draftBytes, {
        request,
        frame: frameV2,
        admission,
        ...(prior === undefined ? {} : { priorSpecification: prior.value }),
      });
  const frame = readDefinitionFrame(
    store,
    subject.frame_ref,
    request,
    subject.request_ref,
    subject.analysis_ref
  );
  assertSpecificationLineage({
    specification: value,
    request,
    frame,
    draft: draft.legacyCore,
    draftBytes,
    requestArtifactId: subject.request_ref.artifact_id,
    draftArtifactId: subject.draft_ref.artifact_id,
    exactInputArtifactIds: subject.imported_input_refs.map((ref) => ref.artifact_id),
    v2Frame: frameV2,
    v2Admission: admission,
    draftTransportVersion: keyedDraft ? (3 as const) : (2 as const),
    ...(prior === undefined
      ? {}
      : { priorSpecification: prior.value, priorSpecificationArtifactId: prior.ref.artifact_id }),
  });
  const productMetadata = store.metadata(product);
  const productUpstream = productMetadata.upstream_refs;
  const currentIndex = context.selectedArtifacts.findIndex(
    (ref) => ref.artifact_id === product.artifact_id
  );
  const epochAnchor = [...context.selectedArtifacts.slice(0, currentIndex)]
    .reverse()
    .find((ref) => ref.run_id === context.identity.run_id && ref.kind === "specification");
  const requiredProductUpstream = uniqueRefs([
    subject.draft_ref,
    subject.request_ref,
    manifest,
    subject.analysis_ref,
    subject.frame_ref,
    subject.admission_ref,
    ...subject.evidence_refs,
    ...subject.imported_input_refs,
    epochAnchor,
    prior?.ref,
  ]);
  if (
    currentIndex < 0 ||
    canonicalJson(productUpstream) !== canonicalJson(requiredProductUpstream) ||
    productMetadata.parent_ref !== null ||
    canonicalJson(productMetadata.domain_revision_parent_ref ?? null) !==
      canonicalJson(prior?.ref ?? null)
  )
    throw new Error("Define product metadata does not bind the current V2 operands");
  const upstream = store.metadata(subject.trace_ref).upstream_refs;
  const required = [
    subject.request_ref,
    manifest,
    subject.analysis_ref,
    subject.frame_ref,
    subject.admission_ref,
    subject.draft_ref,
    product,
    ...(prior === undefined ? [] : [prior.ref]),
    ...trace.support_refs,
  ];
  if (
    required.some((ref) => !upstream.some((actual) => canonicalJson(actual) === canonicalJson(ref)))
  )
    throw new Error("Define trace upstream custody is incomplete");
  assertDefinitionTraceProjection({
    reader: store,
    trace_ref: subject.trace_ref,
    registration_binding: {
      name: "define",
      contract_sha256: binding.contract_sha256,
      registration_sha256: binding.registration_sha256,
    },
    request_ref: subject.request_ref,
    manifest_ref: manifest,
    frame_ref: subject.frame_ref,
    orientation_ref: subject.analysis_ref,
    admission_ref: subject.admission_ref,
    draft_ref: subject.draft_ref,
    draft_bytes: draftBytes,
    product_ref: product,
    product: value,
    prior_product_ref: prior?.ref ?? null,
  });
}

function assertEvidenceAdmissionV2ExecutionBinding(input: {
  readonly context: RunContext;
  readonly reader: ArtifactReader;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
  readonly subject: ReviewSubjectV2;
}): EvidenceAdmissionV2 {
  const admission = readCanonicalJson(
    input.reader,
    input.subject.admission_ref,
    validateEvidenceAdmissionV2
  );
  const execution = exactAcceptedExecutionGroup({
    context: input.context,
    checkpointer: input.checkpointer,
    artifact: input.subject.analysis_ref,
  });
  if (
    canonicalJson(admission.frame_ref) !== canonicalJson(input.subject.frame_ref) ||
    canonicalJson(admission.source_artifact_ref) !== canonicalJson(input.subject.analysis_ref) ||
    admission.routing_result_sha256 !== sha256(canonicalJson(execution.routed)) ||
    canonicalJson(admission.source_execution_receipt_ids) !== canonicalJson(execution.receiptIds)
  )
    throw new Error("V2 admission lacks exact frame and execution binding");
  return admission;
}

function ensureProductIntegrityV2(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: SpecificationProductIntegrityV2;
  readonly added: boolean;
} {
  replayCurrentDefinitionTrace(input.context, input.store);
  const subject = currentReviewSubjectV2(input.context, input.store);
  const admission = assertEvidenceAdmissionV2ExecutionBinding({
    ...input,
    reader: input.store,
    subject,
  });
  if (admission.evidence_required !== (subject.evidence_refs.length === 1))
    throw new Error("Define evidence admission and selected Echo artifact differ");
  const validity = matchingReviewReceiptV2({ ...input, kind: "validity", subject });
  const quality = matchingReviewReceiptV2({ ...input, kind: "quality", subject });
  if (
    validity === undefined ||
    quality === undefined ||
    canonicalJson(quality.receipt.prior_review_receipt_ref) !== canonicalJson(validity.artifact)
  )
    throw new Error("Define V2 current review chain missing");
  const executionReceiptIds = exactExecutionReceiptIds({
    context: input.context,
    checkpointer: input.checkpointer,
    artifacts: [
      subject.analysis_ref,
      ...subject.evidence_refs,
      ...specificationDraftExecutionArtifacts(input.store, subject.draft_ref),
      validity.receipt.review_report_ref,
      quality.receipt.review_report_ref,
    ],
  });
  const body: Omit<SpecificationProductIntegrityV2, "integrity_id"> = {
    schema_id: "penny.specification-product-integrity.v2",
    schema_version: 2,
    status: "PASS",
    request_ref: subject.request_ref,
    ...(subject.specification_assurance_ref === undefined
      ? {}
      : { specification_assurance_ref: subject.specification_assurance_ref }),
    frame_ref: subject.frame_ref,
    orientation_ref: subject.analysis_ref,
    admission_ref: subject.admission_ref,
    trace_ref: subject.trace_ref,
    evidence_refs: subject.evidence_refs,
    imported_input_refs: subject.imported_input_refs,
    draft_ref: subject.draft_ref,
    specification_ref: subject.product_ref,
    vera_report_ref: validity.receipt.review_report_ref,
    carren_report_ref: quality.receipt.review_report_ref,
    validity_receipt_ref: validity.artifact,
    quality_receipt_ref: quality.artifact,
    execution_receipt_ids: executionReceiptIds,
    checks: [
      "canonical_specification",
      "exact_lineage",
      "profile_semantics",
      "complete_source_coverage",
      "revision_supersession",
      "signed_worker_evidence",
      "latest_validity_receipt",
      "latest_quality_receipt",
      "no_planning_taskification_or_execution",
      "exact_definition_trace_and_support",
    ],
    planning_started: false,
    taskification_started: false,
    execution_started: false,
    execution_authorized: false,
  };
  const value = validateSpecificationProductIntegrityV2({
    ...body,
    integrity_id: specificationProductIntegrityV2Id(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "critiquing_specification",
    branchId: "integrity",
    kind: "specification-product-integrity",
    operationLabel: "product-integrity",
    producer: "host:product-validator",
    contentSchema: { schema_id: "penny.specification-product-integrity.v2", schema_version: 2 },
    upstreamRefs: [
      admittedDefinitionSourceManifestArtifact(input.context),
      ...reviewSubjectV2UpstreamRefs(subject),
      ...specificationDraftAuthoringRefs(input.store, subject.draft_ref).slice(1),
      validity.receipt.review_report_ref,
      quality.receipt.review_report_ref,
      validity.artifact,
      quality.artifact,
    ],
    content: canonicalJson(value),
  });
  if (
    canonicalJson(
      readCanonicalJson(input.store, persisted.artifact, validateSpecificationProductIntegrityV2)
    ) !== canonicalJson(value)
  )
    throw new Error("V2 integrity re-read differs");
  return { ...persisted, value };
}

function ensureProductEnvelopeV2(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly integrity: ArtifactRef;
}): {
  readonly artifact: ArtifactRef;
  readonly value: SpecificationProductEnvelopeV2;
  readonly added: boolean;
} {
  const subject = currentReviewSubjectV2(input.context, input.store);
  const validity = matchingReviewReceiptV2({ ...input, kind: "validity", subject });
  const quality = matchingReviewReceiptV2({ ...input, kind: "quality", subject });
  if (
    validity === undefined ||
    quality === undefined ||
    input.integrity.content_schema?.schema_id !== "penny.specification-product-integrity.v2"
  )
    throw new Error("V2 envelope requires current integrity and reviews");
  const body: Omit<SpecificationProductEnvelopeV2, "envelope_id"> = {
    schema_id: "penny.specification-product-envelope.v2",
    schema_version: 2,
    run_id: input.context.identity.run_id,
    status: "complete",
    request_ref: subject.request_ref,
    ...(subject.specification_assurance_ref === undefined
      ? {}
      : { specification_assurance_ref: subject.specification_assurance_ref }),
    frame_ref: subject.frame_ref,
    orientation_ref: subject.analysis_ref,
    admission_ref: subject.admission_ref,
    trace_ref: subject.trace_ref,
    evidence_refs: subject.evidence_refs,
    imported_input_refs: subject.imported_input_refs,
    draft_ref: subject.draft_ref,
    specification_ref: subject.product_ref,
    vera_report_ref: validity.receipt.review_report_ref,
    carren_report_ref: quality.receipt.review_report_ref,
    validity_receipt_ref: validity.artifact,
    quality_receipt_ref: quality.artifact,
    integrity_ref: input.integrity,
  };
  const value = validateSpecificationProductEnvelopeV2({
    ...body,
    envelope_id: specificationProductEnvelopeV2Id(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "critiquing_specification",
    branchId: null,
    kind: "specification-product-envelope",
    operationLabel: "product-envelope",
    producer: "host:product-validator",
    contentSchema: { schema_id: "penny.specification-product-envelope.v2", schema_version: 2 },
    upstreamRefs: [
      admittedDefinitionSourceManifestArtifact(input.context),
      ...reviewSubjectV2UpstreamRefs(subject),
      ...specificationDraftAuthoringRefs(input.store, subject.draft_ref).slice(1),
      validity.artifact,
      quality.artifact,
      input.integrity,
    ],
    content: canonicalJson(value),
  });
  if (
    canonicalJson(
      readCanonicalJson(input.store, persisted.artifact, validateSpecificationProductEnvelopeV2)
    ) !== canonicalJson(value)
  )
    throw new Error("V2 envelope re-read differs");
  return { ...persisted, value };
}

function ensureProductIntegrity(input: {
  readonly context: RunContext;
  readonly store: ArtifactHostStore;
  readonly checkpointer: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"];
}): {
  readonly artifact: ArtifactRef;
  readonly value: SpecificationProductIntegrityV1;
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
    throw new Error(
      "specification product integrity requires current validity and quality receipts"
    );
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
    throw new Error("specification product integrity lacks exact signed worker execution evidence");
  }
  const frameRef = latestDefinitionFrameArtifact(input.context);
  if (frameRef === undefined)
    throw new Error("specification product integrity requires an exact Definition frame");
  const prior = priorSpecification(input.store, input.context);
  validateCanonicalSpecificationBytes(
    input.store.readById(subject.product_ref.artifact_id),
    subject.product_ref,
    ...(prior === undefined ? [] : [{ priorSpecification: prior.value }])
  );
  const body: Omit<SpecificationProductIntegrityV1, "integrity_id"> = {
    schema_id: "penny.specification-product-integrity.v1",
    schema_version: 1,
    status: "PASS",
    request_ref: subject.request_ref,
    frame_ref: frameRef,
    orientation_ref: subject.analysis_ref,
    admission_ref: subject.admission_ref,
    evidence_refs: subject.evidence_refs,
    imported_input_refs: subject.imported_input_refs,
    draft_ref: subject.draft_ref,
    specification_ref: subject.product_ref,
    vera_report_ref: validity.receipt.review_report_ref,
    carren_report_ref: quality.receipt.review_report_ref,
    validity_receipt_ref: validity.artifact,
    quality_receipt_ref: quality.artifact,
    execution_receipt_ids: executionReceiptIds,
    checks: [
      "canonical_specification",
      "exact_lineage",
      "profile_semantics",
      "complete_source_coverage",
      "revision_supersession",
      "signed_worker_evidence",
      "latest_validity_receipt",
      "latest_quality_receipt",
      "no_planning_taskification_or_execution",
    ],
    planning_started: false,
    taskification_started: false,
    execution_started: false,
    execution_authorized: false,
  };
  const value = validateSpecificationProductIntegrity({
    ...body,
    integrity_id: specificationProductIntegrityId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "critiquing_specification",
    branchId: "integrity",
    kind: "specification-product-integrity",
    operationLabel: "product-integrity",
    producer: "host:product-validator",
    contentSchema: { schema_id: "penny.specification-product-integrity.v1", schema_version: 1 },
    upstreamRefs: [
      frameRef,
      admittedDefinitionSourceManifestArtifact(input.context),
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
  readonly value: SpecificationProductEnvelopeV1;
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
    throw new Error("specification product envelope requires current review receipts");
  }
  const frameRef = latestDefinitionFrameArtifact(input.context);
  if (frameRef === undefined)
    throw new Error("specification product envelope requires an exact Definition frame");
  const body: Omit<SpecificationProductEnvelopeV1, "envelope_id"> = {
    schema_id: "penny.specification-product-envelope.v1",
    schema_version: 1,
    run_id: input.context.identity.run_id,
    status: "complete",
    specification_ref: subject.product_ref,
    request_ref: subject.request_ref,
    frame_ref: frameRef,
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
  const value = validateSpecificationProductEnvelope({
    ...body,
    envelope_id: specificationProductEnvelopeId(body),
  });
  const persisted = persistVersionedHostArtifact({
    context: input.context,
    store: input.store,
    phase: "critiquing_specification",
    branchId: null,
    kind: "specification-product-envelope",
    operationLabel: "product-envelope",
    producer: "host:product-validator",
    contentSchema: { schema_id: "penny.specification-product-envelope.v1", schema_version: 1 },
    upstreamRefs: [
      frameRef,
      admittedDefinitionSourceManifestArtifact(input.context),
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
  return "rhea";
}

function reviewEvaluation(
  state: ReviewState,
  details: Record<string, JsonValue>
): EvaluationResult | null {
  const verdict = details.verdict;
  if (state === "verifying_specification" && verdict === "UNVERIFIABLE") return null;
  const rawKind = details.gap_kind;
  const rawOwner = details.repair_owner;
  const findings =
    state === "critiquing_specification" && Array.isArray(details.findings)
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
    state === "critiquing_specification" &&
    verdict === "APPROVE" &&
    Array.isArray(details.findings) &&
    details.findings.some(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        !Array.isArray(finding) &&
        (finding.severity === "major" || finding.severity === "critical")
    );
  const accepted = state === "verifying_specification" ? verdict === "PASS" : verdict === "APPROVE";
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
  const owner = majorOnApprove ? "rhea" : rawOwner;
  if (owner !== gapOwner(kind)) {
    throw new Error(`${state} gap kind and repair owner disagree`);
  }
  return {
    schema_version: 2,
    kind,
    detail: `${state} returned ${String(verdict)} with ${findings.length} finding(s)`,
    findings: findings.slice(0, 32),
    strategy_delta:
      typeof details.specification_delta === "string" &&
      details.specification_delta.trim().length > 0
        ? details.specification_delta
        : `Repair the ${kind} without changing role boundaries.`,
  };
}

function bestPartial(context: RunContext): ArtifactRef | undefined {
  return (
    latestSpecificationArtifact(context) ??
    latestSpecificationDraftArtifact(context) ??
    latestOrientationArtifact(context)
  );
}

export class DefinePlaybook
  implements
    PlaybookCore,
    HostContinuationCapabilityV1,
    LivenessTerminalCapabilityV1,
    StateAwareRepairCapabilityV1,
    RepairExhaustionCapabilityV1,
    RepairProgressCapabilityV1,
    RoutingRepairCapabilityV1,
    GenericGateResponseStorageCapabilityV1
{
  constructor(
    private readonly revisions?: ArtifactRevisionLookup,
    private readonly artifactStore?: ArtifactHostStore,
    private readonly checkpointer?: Parameters<CompletionReceiptPredicateV1>[0]["checkpointer"],
    private readonly hostFault?: (point: string) => void
  ) {}

  initialize(context: RunContext): Directive {
    if (context.identity.playbook !== DEFINE_PLAYBOOK_NAME) {
      throw new Error(`DefinePlaybook cannot run playbook '${context.identity.playbook}'`);
    }
    restoreDefineInputRefs(context, this.artifactStore);
    context.transition("framing_definition");
    return this.dispatch(context);
  }

  dispatch(context: RunContext): Directive {
    if (!Object.hasOwn(DEFINE_AGENT_BY_STATE, context.stateId)) {
      throw new Error(`cannot dispatch define state '${context.stateId}'`);
    }
    const state: DefineWorkerState =
      context.stateId === "framing_definition" ||
      context.stateId === "gathering_definition_evidence" ||
      context.stateId === "authoring_specification" ||
      context.stateId === "verifying_specification" ||
      context.stateId === "critiquing_specification"
        ? context.stateId
        : (() => {
            throw new Error(`unknown define state '${context.stateId}'`);
          })();
    let mechanicalEvidence = "";
    if (state === "verifying_specification" || state === "critiquing_specification") {
      try {
        mechanicalEvidence = this.hostMechanicalEvidence(context, state);
      } catch {
        return this.reviewIncomplete(context, "host_mechanical_check_failed");
      }
    }
    const narrowRepair =
      state === "authoring_specification" && this.artifactStore !== undefined
        ? narrowSpecificationRepairAvailable(context, this.artifactStore)
        : false;
    if (state === "authoring_specification" && this.artifactStore !== undefined) {
      readCurrentSealDiagnostic(context, this.artifactStore);
    }
    const refs = refsForState(context, state, this.artifactStore);
    const next = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: state,
      agent: DEFINE_AGENT_BY_STATE[state],
      attempt: context.stepCount,
      trust_profile: context.trustProfile,
      task: [taskForState(context, state, narrowRepair), mechanicalEvidence]
        .filter(Boolean)
        .join("\n\n"),
      input_artifacts: {
        schema_version: 2,
        artifacts: refs.map((ref) => ({ slot: slotForRef(context, ref), ref })),
      },
      output_artifact: outputMetadata(context, state, refs, this.revisions, narrowRepair),
    });
    context.pendingDirective = next;
    context.status = "running";
    return next;
  }

  evaluateRepair(
    _context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): EvaluationResult | null {
    if (state === "framing_definition") {
      if (details.orientation_complete === true) {
        if (details.gap_kind !== "none" || details.repair_owner !== "none") {
          throw new Error(
            "complete specification orientation must use gap_kind=none and repair_owner=none"
          );
        }
        return null;
      }
      if (details.gap_kind !== "evidence_gap" || details.repair_owner !== "echo") {
        throw new Error("incomplete specification orientation requires evidence_gap owned by echo");
      }
      return {
        schema_version: 2,
        kind: "evidence_gap",
        detail: "Piper identified one closed specification-sensitive evidence gap",
        findings: Array.isArray(details.findings)
          ? details.findings.filter((finding): finding is string => typeof finding === "string")
          : [],
        strategy_delta:
          typeof details.specification_delta === "string"
            ? details.specification_delta
            : "Inspect admitted evidence.",
      };
    }
    if (state === "verifying_specification" || state === "critiquing_specification") {
      return reviewEvaluation(state, details);
    }
    return null;
  }

  repairProgressFingerprint(
    context: RunContext,
    state: string,
    details: Record<string, JsonValue>
  ): string | null {
    if (state !== "verifying_specification" && state !== "critiquing_specification") return null;
    const store = this.requireArtifactStore();
    const draftRef = latestSpecificationDraftArtifact(context);
    if (draftRef?.content_schema?.schema_id !== "penny.specification-draft.v3") return null;
    replayCurrentDefinitionTrace(context, store);
    const { draft } = parseSpecificationDraftV3Candidate(store.readById(draftRef.artifact_id));
    const admissionRef = latestEvidenceAdmissionArtifact(context);
    if (admissionRef === undefined) return null;
    const admission = readCanonicalJson(store, admissionRef, validateEvidenceAdmissionV2);
    // Ref/revision/frame identities and review strategy prose cannot manufacture progress.
    // Exact evidence bytes remain significant; no paraphrase-equivalence claim is made.
    const evidence = admission.support_slots.map((slot) => {
      const bytes = store.readById(slot.ref.artifact_id);
      if (slot.ref.kind === "definition-clarification-response") {
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (value === null || typeof value !== "object" || !("answers" in value)) {
          throw new Error("Definition response has no answer inventory");
        }
        return { allowed_uses: slot.allowed_uses, answers: value.answers };
      }
      return { allowed_uses: slot.allowed_uses, content_sha256: sha256(bytes) };
    });
    return sha256(
      canonicalJson({
        candidate: draft.specification,
        support_claims: draft.support_claims,
        evidence,
        failure: {
          verdict: details.verdict,
          gap_kind: details.gap_kind,
          repair_owner: details.repair_owner,
          findings: details.findings,
          evidence: details.evidence,
        },
      })
    );
  }

  terminalizeRepairStall(
    context: RunContext,
    _state: string,
    _evaluation: EvaluationResult
  ): Directive {
    return this.reviewIncomplete(context, "repair_stalled");
  }

  private reviewIncomplete(context: RunContext, reason: string): Directive {
    const reports = uniqueRefs([
      latestReviewReportArtifact(context, "verifying_specification"),
      latestReviewReportArtifact(context, "critiquing_specification"),
    ]);
    return this.terminal(
      context,
      "incomplete",
      false,
      [reason],
      undefined,
      {
        incomplete_reason: reason,
        ...(reason === "repair_stalled" ? { stalled: true, stall_reason: reason } : {}),
        feedback_artifact_refs: reports,
      },
      reports
    );
  }

  private hostMechanicalEvidence(context: RunContext, state: ReviewState): string {
    const store = this.requireArtifactStore();
    const product = latestSpecificationArtifact(context);
    if (product === undefined) throw new Error("Define review product missing");
    const checks = ["exact_selected_ref_and_byte_custody", "canonical_specification"];
    validateCanonicalSpecificationBytes(store.readById(product.artifact_id), product);
    if (traceCapable(context)) {
      replayCurrentDefinitionTrace(context, store);
      if (this.checkpointer === undefined) throw new Error("Define execution evidence unavailable");
      assertEvidenceAdmissionV2ExecutionBinding({
        context,
        reader: store,
        checkpointer: this.checkpointer,
        subject: currentReviewSubjectV2(context, store),
      });
      checks.push(
        "specification_lineage",
        "definition_trace_projection_and_support",
        "evidence_admission_execution_binding"
      );
    }
    const sources = refsForState(context, state, store);
    for (const ref of sources) {
      if (canonicalJson(store.refById(ref.artifact_id)) !== canonicalJson(ref)) {
        throw new Error("Define review source custody changed");
      }
      const bytes = store.readById(ref.artifact_id);
      if (sha256(bytes) !== ref.content_digest || bytes.length !== ref.byte_length) {
        throw new Error("Define review source bytes changed");
      }
    }
    return `HOST_MECHANICAL_CHECKS:${canonicalJson({
      schema_version: 1,
      product_ref: product,
      source_refs: sources.filter((ref) => ref.artifact_id !== product.artifact_id),
      checks: checks.map((check) => ({ check, status: "passed" })),
      scope: "host_mechanical_only_not_semantic_or_effect_absence",
    })}`;
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
    _confidence: Confidence
  ): PlaybookStepOutcome {
    switch (context.stateId) {
      case "framing_definition":
        if (details.orientation_complete !== true) {
          throw new Error("orientation gap reached happy routing without engine-owned repair");
        }
        context.transition("definition_readiness_gate");
        return hostContinuation();
      case "gathering_definition_evidence":
        if (this.artifactStore === undefined || this.checkpointer === undefined)
          throw new Error("Define evidence host unavailable");
        persistSpecificationEvidenceAdmission({
          context,
          store: this.artifactStore,
          checkpointer: this.checkpointer,
        });
        context.transition("authoring_specification");
        return this.dispatch(context);
      case "authoring_specification":
        if (details.complete !== true) throw new Error("specification draft summary is incomplete");
        context.transition("sealing_specification");
        return hostContinuation();
      case "verifying_specification":
        if (details.verdict === "UNVERIFIABLE") {
          return this.reviewIncomplete(context, "verification_incomplete");
        }
        if (details.verdict !== "PASS") {
          throw new Error("Vera gap reached happy routing without engine-owned repair");
        }
        context.transition("critiquing_specification");
        return hostContinuation();
      case "critiquing_specification":
        if (details.verdict !== "APPROVE") {
          throw new Error("Carren revision reached happy routing without engine-owned repair");
        }
        context.pendingDirective = null;
        return hostContinuation();
      default:
        throw new Error(`unexpected define summary in state '${context.stateId}'`);
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

  genericGateResponseStorage(context: RunContext): "digest-only" {
    if (context.stateId !== "awaiting_clarification") {
      throw new Error("Define digest-only storage requires its clarification gate");
    }
    return "digest-only";
  }

  resume(context: RunContext, response: JsonValue): Directive {
    const pending = context.pendingDirective;
    if (
      context.status !== "awaiting_user" ||
      context.stateId !== "awaiting_clarification" ||
      pending?.action !== "await_user" ||
      this.artifactStore === undefined
    ) {
      throw new Error("define run is not awaiting a durable clarification");
    }
    const store = this.artifactStore;
    const challengeRef = clarificationEvidenceRefs(context).find(
      (ref) =>
        ref.kind === "definition-clarification-challenge" &&
        ref.content_digest === pending.payload_digest
    );
    if (challengeRef === undefined) {
      // Historical V1 gates remain readable on recovery but cannot store a new raw answer.
      throw new Error("Define clarification requires an exact V2 challenge artifact");
    }
    const challenge = readSelectedChallenge(context, store, challengeRef);
    if (
      pending.gate_id !== challenge.gate_id ||
      pending.challenge !== challenge.challenge_id ||
      canonicalJson(pending.questions.map((q) => q.id)) !== canonicalJson(challenge.question_ids)
    ) {
      throw new Error("Definition clarification pending gate binding changed");
    }
    let mappedAnswers: Record<string, string | null> | undefined;
    if (typeof response === "object" && response !== null && !Array.isArray(response)) {
      mappedAnswers = {};
      for (const [id, answer] of Object.entries(response)) {
        if (typeof answer !== "string" && answer !== null) {
          throw new Error("Definition clarification field must be text or null");
        }
        Object.defineProperty(mappedAnswers, id, {
          value: answer,
          enumerable: true,
          configurable: true,
        });
      }
    } else if (typeof response !== "string") {
      throw new Error("Definition clarification response must be text or a question-ID map");
    }
    if (typeof response === "string" && challenge.question_ids.length !== 1) {
      throw new Error("Multiple Definition questions require a question-ID map");
    }
    const value = mapDefinitionGateResponse({
      challenge,
      challengeRef,
      ownerResponseId: stableDefinitionId("definition-owner-response", {
        run_id: context.identity.run_id,
        gate_id: pending.gate_id,
        challenge_ref: challengeRef,
      }),
      ...(mappedAnswers === undefined
        ? typeof response === "string"
          ? { freeText: response }
          : {}
        : { mappedAnswers }),
    });
    persistFixedClarification({
      context,
      store,
      phase: "awaiting_clarification",
      kind: "definition-clarification-response",
      gateId: pending.gate_id,
      operationId: `definition-response:${sha256(canonicalJson({ run_id: context.identity.run_id, gate_id: pending.gate_id }))}`,
      producer: "host:definition-clarification",
      upstreamRefs: [challengeRef, challenge.request_ref],
      content: canonicalJson(value),
    });
    this.hostFault?.("awaiting_clarification:response-persistence");
    context.iteration = 0;
    context.iterationHistory = [];
    context.transition("framing_definition");
    return this.dispatch(context);
  }

  cancel(context: RunContext, reason: string): Directive {
    return this.terminal(context, "cancelled", false, [reason]);
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending?.action !== "invoke_agent") return pending;
    if (pending.execution_purpose === "routing_repair") return pending;
    if (!isDefineWorkerState(pending.state_id)) return pending;
    const state = pending.state_id;
    if (state === "verifying_specification" || state === "critiquing_specification") {
      try {
        const evidence = this.hostMechanicalEvidence(context, state);
        const boundEvidence = pending.task
          .split("\n")
          .filter((line) => line.startsWith("HOST_MECHANICAL_CHECKS:"));
        if (boundEvidence.length !== 1 || boundEvidence[0] !== evidence)
          throw new Error("Define mechanical task binding changed");
        // Preserve the signed task, including shared contextual-input enrichment, exactly.
      } catch {
        return this.reviewIncomplete(context, "host_mechanical_check_failed");
      }
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
    const narrowRepair =
      state === "authoring_specification" && this.artifactStore !== undefined
        ? narrowSpecificationRepairAvailable(context, this.artifactStore)
        : false;
    return validateDirective({
      ...pending,
      task: taskForState(context, state, narrowRepair),
      output_artifact: outputMetadata(
        context,
        state,
        pending.output_artifact.upstream_refs,
        this.revisions,
        narrowRepair
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
      (context.stateId === "definition_readiness_gate" ||
        context.stateId === "sealing_specification" ||
        context.stateId === "admitting_specification" ||
        (context.stateId === "critiquing_specification" && context.pendingDirective === null))
    );
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context)) {
      throw new Error(`define state '${context.stateId}' has no deterministic host continuation`);
    }
    const store = this.artifactStore;
    const checkpointer = this.checkpointer;
    if (store === undefined || checkpointer === undefined) {
      throw new Error("define engine host continuation dependencies are unavailable");
    }
    if (context.stateId === "definition_readiness_gate") {
      return this.continueEvidenceGate(context, store, checkpointer);
    }
    if (context.stateId === "sealing_specification") {
      return this.continueSealing(context, store);
    }
    if (context.stateId === "admitting_specification") {
      return {
        event_type: "define_product_completion_admitted",
        payload: { run_id: context.identity.run_id },
        directive: this.terminal(context, "complete", true, []),
        after_checkpoint_fault: "admitting_specification:completion-admission",
      };
    }
    const subject = currentReviewSubject(context);
    const carren = acceptedReviewEvidence({
      context,
      store,
      checkpointer,
      state: "critiquing_specification",
      verdict: "APPROVE",
      product: subject.product_ref,
    });
    if (carren === undefined) {
      const validity = traceCapable(context)
        ? ensureReviewReceiptV2({ context, store, checkpointer, kind: "validity" })
        : ensureReviewReceipt({ context, store, checkpointer, kind: "validity" });
      if (validity.added) {
        this.hostFault?.("verifying_specification:receipt-persistence");
        return {
          event_type: "define_validity_receipt_persisted",
          payload: {
            run_id: context.identity.run_id,
            product_artifact_id: subject.product_ref.artifact_id,
            receipt_artifact_id: validity.artifact.artifact_id,
          },
        };
      }
      const next = this.dispatch(context);
      return {
        event_type: "define_quality_review_dispatched",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          next_action: next.action,
        },
        directive: next,
      };
    }
    const quality = traceCapable(context)
      ? ensureReviewReceiptV2({ context, store, checkpointer, kind: "quality" })
      : ensureReviewReceipt({ context, store, checkpointer, kind: "quality" });
    if (quality.added) {
      this.hostFault?.("critiquing_specification:receipt-persistence");
      return {
        event_type: "define_quality_receipt_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          receipt_artifact_id: quality.artifact.artifact_id,
        },
      };
    }
    const integrity = traceCapable(context)
      ? ensureProductIntegrityV2({ context, store, checkpointer })
      : ensureProductIntegrity({ context, store, checkpointer });
    if (integrity.added) {
      this.hostFault?.("critiquing_specification:integrity-persistence");
      return {
        event_type: "define_product_integrity_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          integrity_artifact_id: integrity.artifact.artifact_id,
        },
      };
    }
    const envelope = traceCapable(context)
      ? ensureProductEnvelopeV2({ context, store, integrity: integrity.artifact })
      : ensureProductEnvelope({ context, store, integrity: integrity.artifact });
    if (envelope.added) {
      this.hostFault?.("critiquing_specification:envelope-persistence");
      return {
        event_type: "define_product_envelope_persisted",
        payload: {
          run_id: context.identity.run_id,
          product_artifact_id: subject.product_ref.artifact_id,
          envelope_artifact_id: envelope.artifact.artifact_id,
        },
      };
    }
    context.transition("admitting_specification");
    return {
      event_type: "define_product_completion_candidate",
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
    const frame = persistDefinitionFrame({ context, store, checkpointer });
    if (frame.added) {
      this.hostFault?.("definition_readiness_gate:frame-persistence");
      return {
        event_type: "define_frame_persisted",
        payload: {
          run_id: context.identity.run_id,
          frame_artifact_id: frame.artifact.artifact_id,
          route: frame.value.route,
        },
      };
    }
    if (frame.value.schema_version === 2 && frame.value.route !== "clarify") {
      const statuses = priorClarificationAnswers(context, store);
      if (
        frame.value.questions.some(
          (q) =>
            q.owner === "caller" &&
            q.material &&
            statuses.get(q.question_id) !== "answered" &&
            statuses.get(q.question_id) !== "declined"
        )
      ) {
        return {
          event_type: "define_clarification_unresolved",
          payload: {
            run_id: context.identity.run_id,
            frame_artifact_id: frame.artifact.artifact_id,
          },
          directive: this.terminal(context, "incomplete", false, [
            "material caller clarification remains unresolved",
          ]),
        };
      }
    }
    if (frame.value.route === "clarify") {
      if (frame.value.schema_version !== 2) {
        throw new Error("historical V1 clarification has no per-question challenge binding");
      }
      const statuses = priorClarificationAnswers(context, store);
      const pendingQuestions = frame.value.questions
        .filter(
          (q) =>
            q.owner === "caller" &&
            statuses.get(q.question_id) !== "answered" &&
            statuses.get(q.question_id) !== "declined"
        )
        .slice(0, 16);
      if (
        pendingQuestions.length > 0 &&
        context.selectedArtifacts.filter((ref) => ref.kind === "definition-clarification-response")
          .length >= 64
      ) {
        return {
          event_type: "define_clarification_unresolved",
          payload: {
            run_id: context.identity.run_id,
            frame_artifact_id: frame.artifact.artifact_id,
          },
          directive: this.terminal(context, "incomplete", false, [
            "caller clarification remains unresolved",
          ]),
        };
      }
      if (pendingQuestions.length === 0) {
        // Explicit declines are durable support outcomes. They do not authorize invention,
        // but they do permit authoring an honestly blocked specification.
      } else {
        const gateVisit = context.stepCount;
        const gateId = stableDefinitionId("definition-gate", {
          run_id: context.identity.run_id,
          frame_ref: frame.artifact,
          gate_visit: gateVisit,
        });
        const challenge = definitionClarificationChallenge({
          requestRef: admittedDefineRequestArtifact(context),
          manifestRef: admittedDefinitionSourceManifestArtifact(context),
          frameRef: frame.artifact,
          frame: frame.value,
          gateId,
          gateVisit,
          questionIds: pendingQuestions.map((q) => q.question_id),
        });
        const persisted = persistFixedClarification({
          context,
          store,
          phase: "definition_readiness_gate",
          kind: "definition-clarification-challenge",
          gateId,
          operationId: `definition-challenge:${sha256(canonicalJson({ run_id: context.identity.run_id, gate_id: gateId }))}`,
          producer: "host:definition-clarification",
          upstreamRefs: [challenge.request_ref, challenge.manifest_ref, frame.artifact],
          content: canonicalJson(challenge),
        });
        if (persisted.added) {
          this.hostFault?.("definition_readiness_gate:challenge-persistence");
          return {
            event_type: "define_clarification_challenge_persisted",
            payload: {
              run_id: context.identity.run_id,
              challenge_artifact_id: persisted.artifact.artifact_id,
            },
          };
        }
        const next = this.awaitUser(context, challenge, persisted.artifact, pendingQuestions);
        return {
          event_type: "define_clarification_requested",
          payload: {
            run_id: context.identity.run_id,
            frame_artifact_id: frame.artifact.artifact_id,
            challenge_artifact_id: persisted.artifact.artifact_id,
          },
          directive: next,
        };
      }
    }
    const admission = persistSpecificationEvidenceAdmission({ context, store, checkpointer });
    if (admission.added) {
      this.hostFault?.("definition_readiness_gate:admission-persistence");
      return {
        event_type: "define_evidence_admission_persisted",
        payload: {
          run_id: context.identity.run_id,
          admission_artifact_id: admission.artifact.artifact_id,
          evidence_required: admission.value.evidence_required,
        },
      };
    }
    const nextState = admission.value.evidence_required
      ? "gathering_definition_evidence"
      : "authoring_specification";
    context.transition(nextState);
    const next = this.dispatch(context);
    return {
      event_type: "define_readiness_gate_routed",
      payload: {
        run_id: context.identity.run_id,
        frame_artifact_id: frame.artifact.artifact_id,
        admission_artifact_id: admission.artifact.artifact_id,
        next_state: nextState,
      },
      directive: next,
    };
  }

  private awaitUser(
    context: RunContext,
    challenge: DefinitionClarificationChallengeV1,
    challengeRef: ArtifactRef,
    questions: readonly DefinitionFrameV2["questions"][number][]
  ): Directive {
    context.transition("awaiting_clarification");
    context.status = "awaiting_user";
    const next = validateDirective({
      schema_version: 2,
      action: "await_user",
      identity: context.identity,
      state_id: "awaiting_clarification",
      gate_id: challenge.gate_id,
      challenge: challenge.challenge_id,
      payload_digest: challengeRef.content_digest,
      questions: questions.map((q) => ({ id: q.question_id, prompt: q.question })),
    });
    context.pendingDirective = next;
    return next;
  }

  private continueSealing(context: RunContext, store: ArtifactHostStore): HostContinuationStepV1 {
    const requestArtifact = admittedDefineRequestArtifact(context);
    const orientationArtifact = latestOrientationArtifact(context);
    const frameArtifact = latestDefinitionFrameArtifact(context);
    let draftArtifact = latestSpecificationDraftArtifact(context);
    if (
      draftArtifact === undefined ||
      orientationArtifact === undefined ||
      frameArtifact === undefined
    ) {
      const missingExactInputs = [
        ...(draftArtifact === undefined ? ["specification-draft"] : []),
        ...(orientationArtifact === undefined ? ["specification-orientation"] : []),
        ...(frameArtifact === undefined ? ["definition-frame"] : []),
      ];
      return {
        event_type: "define_seal_input_absent",
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
    let repairedDraft: ArtifactRef | undefined;
    try {
      repairedDraft = materializeCurrentSpecificationDraftRepair({ context, store });
    } catch (error) {
      if (!(error instanceof SpecificationDraftRepairRejectedError)) throw error;
      return {
        event_type: "define_seal_repair_invalid",
        payload: {
          run_id: context.identity.run_id,
          repair_artifact_id: error.repairRef.artifact_id,
        },
        directive: this.terminal(
          context,
          "incomplete",
          false,
          [
            `seal repair invalid: ${error.message}`,
            `rejected repair artifact: ${error.repairRef.artifact_id}`,
          ],
          undefined,
          {
            incomplete_reason: "seal_repair_invalid",
            stalled: true,
            stall_reason: "seal_defect",
          },
          uniqueRefs([error.repairRef, currentSealDiagnosticArtifact(context)])
        ),
      };
    }
    if (repairedDraft !== undefined) draftArtifact = repairedDraft;
    const inputRefs = exactDefineInputRefs(context);
    const evidenceRefs = uniqueRefs([latestEvidenceArtifact(context)]);
    const request = canonicalDefineRequest(store, context);
    readDefinitionSourceManifest(
      store,
      admittedDefinitionSourceManifestArtifact(context),
      requestArtifact
    );
    const frame = readDefinitionFrame(
      store,
      frameArtifact,
      request,
      requestArtifact,
      orientationArtifact
    );
    const prior = priorSpecification(store, context);
    const admissionArtifact = latestEvidenceAdmissionArtifact(context);
    if (admissionArtifact === undefined) {
      throw new Error("sealed SpecificationV1 requires exact evidence admission");
    }
    // The checkpoint order, not a version counter or an imported prior, defines
    // the current epoch. Validate the previous rejection before attempting a correction.
    const previous = readCurrentSealDiagnostic(context, store);
    const policy = defineSealPolicy(context);
    const frameV2 =
      frameArtifact.content_schema?.schema_id === "penny.definition-frame.v2"
        ? readDefinitionFrameV2(store, context, frameArtifact)
        : undefined;
    const admissionV2 =
      frameV2 === undefined
        ? undefined
        : (() => {
            const bytes = store.readById(admissionArtifact.artifact_id).toString("utf8");
            const value: unknown = JSON.parse(bytes);
            const admitted = validateEvidenceAdmissionV2(value);
            if (
              canonicalJson(admitted) !== bytes ||
              canonicalJson(store.refById(admissionArtifact.artifact_id)) !==
                canonicalJson(admissionArtifact)
            ) {
              throw new Error("Define evidence admission lacks exact V2 custody");
            }
            return admitted;
          })();
    const manifestRef = admittedDefinitionSourceManifestArtifact(context);
    const traceInput = (
      product: ReturnType<typeof validateCanonicalSpecificationBytes>,
      productRef: ArtifactRef,
      draftBytes: Uint8Array
    ) => {
      if (frameV2 === undefined || admissionV2 === undefined)
        throw new Error("Definition trace requires V2 inputs");
      const binding = context.registrationContractBinding;
      if (binding?.registration_name !== "define" || binding.registration_sha256 === undefined) {
        throw new Error("Definition trace requires current registration binding");
      }
      return projectDefinitionTrace({
        reader: store,
        registration_binding: {
          name: "define",
          contract_sha256: binding.contract_sha256,
          registration_sha256: binding.registration_sha256,
        },
        request_ref: requestArtifact,
        manifest_ref: manifestRef,
        frame_ref: frameArtifact,
        orientation_ref: orientationArtifact,
        admission_ref: admissionArtifact,
        draft_ref: draftArtifact,
        draft_bytes: draftBytes,
        product_ref: productRef,
        product,
        prior_product_ref: prior?.ref ?? null,
      });
    };
    const anchor = latestSpecificationArtifact(context) ?? null;
    const attempt = sealAttempt({
      store,
      policy,
      registered_policy_sha256: sealPolicySha256(policy),
      run_id: context.identity.run_id,
      branch_id: null,
      phase: policy.seal_phase,
      draft_ref: draftArtifact,
      epoch_anchor_ref: anchor,
      previous_diagnostic_ref: previous?.ref ?? null,
      rejection_ordinal: previous?.value.rejection_ordinal ?? 0,
      project: (draftBytes) => {
        try {
          const keyedDraft =
            frameV2 !== undefined &&
            draftArtifact.content_schema?.schema_id === "penny.specification-draft.v3";
          const draft =
            frameV2 === undefined
              ? parseSpecificationDraft(draftBytes, {
                  request,
                  frame,
                  ...(prior === undefined ? {} : { priorSpecification: prior.value }),
                }).draft
              : keyedDraft
                ? parseSpecificationDraftV3(draftBytes, {
                    request,
                    frame: frameV2,
                    ...(admissionV2 === undefined ? {} : { admission: admissionV2 }),
                    ...(prior === undefined ? {} : { priorSpecification: prior.value }),
                  }).legacyCore
                : parseSpecificationDraftV2(draftBytes, {
                    request,
                    frame: frameV2,
                    ...(admissionV2 === undefined ? {} : { admission: admissionV2 }),
                    ...(prior === undefined ? {} : { priorSpecification: prior.value }),
                  }).legacyCore;
          const specification = sealSpecification({
            request,
            frame,
            draft,
            draftBytes,
            ...(frameV2 === undefined || admissionV2 === undefined
              ? {}
              : {
                  v2Frame: frameV2,
                  v2Admission: admissionV2,
                  draftTransportVersion: keyedDraft ? (3 as const) : (2 as const),
                }),
            requestSha256: defineRequestSha256(request),
            sourceRequestArtifactId: requestArtifact.artifact_id,
            sourceDraftArtifactId: draftArtifact.artifact_id,
            exactInputArtifactIds: inputRefs.map((ref) => ref.artifact_id),
            ...(prior === undefined
              ? {}
              : {
                  priorSpecification: prior.value,
                  priorSpecificationArtifactId: prior.ref.artifact_id,
                }),
          });
          if (frameV2 !== undefined && admissionV2 !== undefined) {
            const supportDraft = keyedDraft
              ? parseSpecificationDraftV3(draftBytes, {
                  request,
                  frame: frameV2,
                  admission: admissionV2,
                  ...(prior === undefined ? {} : { priorSpecification: prior.value }),
                }).compatibilityDraft
              : parseSpecificationDraftV2(draftBytes, {
                  request,
                  frame: frameV2,
                  admission: admissionV2,
                  ...(prior === undefined ? {} : { priorSpecification: prior.value }),
                }).draft;
            try {
              validateDefinitionSupport({
                reader: store,
                request,
                frame: frameV2,
                admission: admissionV2,
                draft: supportDraft,
                product: specification,
              });
            } catch (error) {
              throw new SpecificationDraftValidationError("SEMANTIC_INVALID", [
                error instanceof Error ? error.message : "invalid Define support claim",
              ]);
            }
          }
          return {
            status: "sealed",
            content: canonicalJson(specification),
            content_schema: { schema_id: "penny.specification.v1", schema_version: 1 },
            upstream_refs: [
              requestArtifact,
              admittedDefinitionSourceManifestArtifact(context),
              orientationArtifact,
              frameArtifact,
              admissionArtifact,
              ...evidenceRefs,
              ...inputRefs,
            ],
            revision_parent_ref: prior?.ref ?? null,
          };
        } catch (error) {
          if (!(error instanceof SpecificationDraftValidationError)) throw error;
          return {
            status: "rejected",
            failure_class: error.failureClass,
            issues: defineSealIssues(error),
          };
        }
      },
      validate_product_bytes: (bytes, ref) => {
        const product = validateCanonicalSpecificationBytes(
          bytes,
          ref,
          ...(prior === undefined ? [] : [{ priorSpecification: prior.value }])
        );
        if (frameV2 !== undefined)
          traceInput(product, ref, store.readById(draftArtifact.artifact_id));
      },
    });
    if (attempt.status === "fault") throw new Error(`define seal host fault: ${attempt.code}`);
    if (attempt.status === "rejected") {
      const added = addSelectedArtifact(context, attempt.diagnostic_ref);
      if (added) this.hostFault?.("sealing_specification:feedback-persistence");
      if (attempt.diagnostic.disposition !== "correction_offered") {
        const stalled = attempt.diagnostic.disposition === "stalled";
        return {
          event_type: stalled ? "define_seal_repair_stalled" : "define_seal_repair_exhausted",
          payload: {
            run_id: context.identity.run_id,
            failure_sha256: sha256(canonicalJson(attempt.diagnostic.issues)),
            diagnostic_artifact_id: attempt.diagnostic_ref.artifact_id,
          },
          directive: this.terminal(
            context,
            "incomplete",
            false,
            [
              `${stalled ? "seal repair stalled" : "seal repair exhausted"}: ${attempt.diagnostic.failure_class}`,
              `latest seal diagnostic: ${attempt.diagnostic_ref.artifact_id}`,
            ],
            undefined,
            {
              incomplete_reason: stalled ? "seal_repair_stalled" : "seal_repair_exhausted",
              ...(stalled
                ? { stalled: true, stall_reason: attempt.diagnostic.stall_reason ?? "seal_defect" }
                : { exhausted: true, exhaustion_reason: "seal_defect" }),
              seal_diagnostics: sealDiagnosticsProjection(
                attempt.diagnostic,
                attempt.diagnostic_ref,
                policy
              ),
            }
          ),
        };
      }
      context.transition("authoring_specification");
      const next = this.dispatch(context);
      return {
        event_type: "define_seal_repair_requested",
        payload: {
          run_id: context.identity.run_id,
          rejected_draft_artifact_id: draftArtifact.artifact_id,
          feedback_artifact_id: attempt.diagnostic_ref.artifact_id,
        },
        directive: next,
      };
    }
    const added = addSelectedArtifact(context, attempt.product_ref);
    if (added) this.hostFault?.("sealing_specification:artifact-persistence");
    if (frameV2 !== undefined) {
      const product = validateCanonicalSpecificationBytes(
        store.readById(attempt.product_ref.artifact_id),
        attempt.product_ref,
        ...(prior === undefined ? [] : [{ priorSpecification: prior.value }])
      );
      const draftBytes = store.readById(draftArtifact.artifact_id);
      const trace = traceInput(product, attempt.product_ref, draftBytes);
      const traceRefs = uniqueRefs([
        requestArtifact,
        manifestRef,
        orientationArtifact,
        frameArtifact,
        admissionArtifact,
        draftArtifact,
        attempt.product_ref,
        prior?.ref,
        ...(admissionV2?.support_slots ?? []).flatMap((slot) => [
          slot.ref,
          ...(slot.challenge_ref === null ? [] : [slot.challenge_ref]),
        ]),
      ]);
      const persisted = persistVersionedHostArtifact({
        context,
        store,
        phase: "sealing_specification",
        branchId: "trace",
        kind: "definition-trace",
        operationLabel: "definition-trace",
        producer: "host:definition-trace",
        contentSchema: { schema_id: "penny.definition-trace.v1", schema_version: 1 },
        upstreamRefs: traceRefs,
        content: canonicalJson(trace),
      });
      assertDefinitionTraceProjection({
        reader: store,
        trace_ref: persisted.artifact,
        registration_binding: trace.registration_binding,
        request_ref: requestArtifact,
        manifest_ref: manifestRef,
        orientation_ref: orientationArtifact,
        frame_ref: frameArtifact,
        admission_ref: admissionArtifact,
        draft_ref: draftArtifact,
        draft_bytes: draftBytes,
        product_ref: attempt.product_ref,
        product,
        prior_product_ref: prior?.ref ?? null,
      });
      if (persisted.added) this.hostFault?.("sealing_specification:trace-persistence");
    }
    context.transition("verifying_specification");
    const next = this.dispatch(context);
    return {
      event_type: "define_specification_sealed",
      payload: {
        run_id: context.identity.run_id,
        draft_artifact_id: draftArtifact.artifact_id,
        specification_artifact_id: attempt.product_ref.artifact_id,
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
    extraResult: Readonly<Record<string, JsonValue>> = {},
    negativeArtifacts: readonly ArtifactRef[] = []
  ): Directive {
    const origin = context.stateId;
    const output = met ? latestSpecificationArtifact(context) : bestPartial(context);
    if (met && output === undefined) throw new Error("positive define terminal has no product");
    const graph = met
      ? this.positiveTerminalArtifacts(context)
      : uniqueRefs([output, ...negativeArtifacts]);
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

  private requireArtifactStore(): ArtifactHostStore {
    if (this.artifactStore === undefined) throw new Error("Define trace custody owner unavailable");
    return this.artifactStore;
  }

  private positiveTerminalArtifacts(context: RunContext): ArtifactRef[] {
    const subject = currentReviewSubject(context);
    const validity = latestReviewReceiptArtifact(context, "validity");
    const quality = latestReviewReceiptArtifact(context, "quality");
    const integrity = latestIntegrityArtifact(context);
    const envelope = latestEnvelopeArtifact(context);
    const vera = latestReviewReportArtifact(context, "verifying_specification");
    const carren = latestReviewReportArtifact(context, "critiquing_specification");
    if (
      validity === undefined ||
      quality === undefined ||
      integrity === undefined ||
      envelope === undefined ||
      vera === undefined ||
      carren === undefined
    ) {
      throw new Error("positive specification terminal graph is incomplete");
    }
    const frame = latestDefinitionFrameArtifact(context);
    if (frame === undefined)
      throw new Error("positive specification terminal lacks an exact Definition frame");
    return uniqueRefs([
      subject.request_ref,
      subject.specification_assurance_ref,
      admittedDefinitionSourceManifestArtifact(context),
      subject.analysis_ref,
      frame,
      subject.admission_ref,
      ...subject.evidence_refs,
      ...subject.imported_input_refs,
      ...specificationDraftAuthoringRefs(this.requireArtifactStore(), subject.draft_ref),
      subject.product_ref,
      ...(traceCapable(context)
        ? [
            currentReviewSubjectV2(context, this.requireArtifactStore()).trace_ref,
            ...currentReviewSubjectV2(context, this.requireArtifactStore()).support_refs,
          ]
        : []),
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
  receipt: ReviewReceiptV1 | ReviewReceiptV2
): PhaseResult | undefined {
  const result = input.checkpointer.receiptResultById(receipt.execution_receipt_id);
  return result !== undefined && sha256(canonicalJson(result)) === receipt.execution_result_sha256
    ? result
    : undefined;
}

function hasDefinitionTraceReader(reader: ArtifactReader): reader is ArtifactHostStore {
  return (
    "metadata" in reader &&
    typeof reader.metadata === "function" &&
    "refFor" in reader &&
    typeof reader.refFor === "function" &&
    "lastVersion" in reader &&
    typeof reader.lastVersion === "function" &&
    "persist" in reader &&
    typeof reader.persist === "function" &&
    "select" in reader &&
    typeof reader.select === "function"
  );
}

function evaluateTraceBoundDefineCompletion(
  input: Parameters<CompletionReceiptPredicateV1>[0]
): ReturnType<CompletionReceiptPredicateV1> {
  try {
    const reader = input.artifactReader;
    if (
      reader === undefined ||
      !hasDefinitionTraceReader(reader) ||
      input.originState !== "admitting_specification"
    )
      return { passed: false, evidence_refs: [] };
    const context = input.context;
    const subject = currentReviewSubjectV2(context, reader);
    const assuranceRef = assertSelectedSpecificationAssurance({
      context,
      reader,
      checkpointer: input.checkpointer,
      native_request_ref: subject.request_ref,
      imported_input_refs: subject.imported_input_refs,
    });
    if (canonicalJson(subject.specification_assurance_ref) !== canonicalJson(assuranceRef))
      return { passed: false, evidence_refs: [] };
    const manifest = admittedDefinitionSourceManifestArtifact(context);
    const product = latestSpecificationArtifact(context);
    const validityRef = latestReviewReceiptArtifact(context, "validity");
    const qualityRef = latestReviewReceiptArtifact(context, "quality");
    const integrityRef = latestIntegrityArtifact(context);
    const envelopeRef = latestEnvelopeArtifact(context);
    if (
      product === undefined ||
      validityRef === undefined ||
      qualityRef === undefined ||
      integrityRef === undefined ||
      envelopeRef === undefined ||
      product.artifact_id !== input.latestProduct.product_id ||
      product.content_digest !== input.latestProduct.sha256 ||
      canonicalJson(input.terminal.result.output_artifact_ref) !== canonicalJson(product) ||
      input.terminal.result.execution_started !== false ||
      input.terminal.result.execution_authorized !== false ||
      input.terminal.unresolved.length !== 0
    )
      return { passed: false, evidence_refs: [] };
    replayCurrentDefinitionTrace(context, reader);
    const admission = assertEvidenceAdmissionV2ExecutionBinding({
      context,
      reader,
      checkpointer: input.checkpointer,
      subject,
    });
    if (
      canonicalJson(subject.support_refs) !==
        canonicalJson(admission.support_slots.map((slot) => slot.ref)) ||
      admission.evidence_required !== (subject.evidence_refs.length === 1)
    )
      return { passed: false, evidence_refs: [] };
    const validity = readReviewReceiptV2(reader, validityRef);
    const quality = readReviewReceiptV2(reader, qualityRef);
    for (const [ref, receipt] of [
      [validityRef, validity],
      [qualityRef, quality],
    ] as const) {
      const reportMeta = reader.metadata(receipt.review_report_ref);
      validateReviewReceiptV2Binding({
        receipt,
        review_report_upstream_refs: reportMeta.upstream_refs,
        ...(receipt.review_kind === "quality"
          ? { prior_review: { artifact_ref: validityRef, receipt: validity } }
          : {}),
      });
      const result = expectedReceiptResult(input, receipt);
      const accepted = exactAcceptedExecutionGroup({
        context,
        checkpointer: input.checkpointer,
        artifact: receipt.review_report_ref,
      });
      if (
        result === undefined ||
        result.worker_receipt.receipt_id !== accepted.routed.worker_receipt.receipt_id ||
        (receipt.review_kind === "validity"
          ? accepted.routed.details.verdict !== "PASS"
          : accepted.routed.details.verdict !== "APPROVE") ||
        canonicalJson(receipt.subject) !== canonicalJson(subject) ||
        canonicalJson(reader.refById(ref.artifact_id)) !== canonicalJson(ref)
      )
        return { passed: false, evidence_refs: [] };
    }
    if (
      validity.review_kind !== "validity" ||
      quality.review_kind !== "quality" ||
      canonicalJson(quality.prior_review_receipt_ref) !== canonicalJson(validityRef)
    )
      return { passed: false, evidence_refs: [] };
    const integrity = readCanonicalJson(
      reader,
      integrityRef,
      validateSpecificationProductIntegrityV2
    );
    const envelope = readCanonicalJson(reader, envelopeRef, validateSpecificationProductEnvelopeV2);
    const executionReceiptIds = exactExecutionReceiptIds({
      context,
      checkpointer: input.checkpointer,
      artifacts: [
        subject.analysis_ref,
        ...subject.evidence_refs,
        ...specificationDraftExecutionArtifacts(reader, subject.draft_ref),
        validity.review_report_ref,
        quality.review_report_ref,
      ],
    });
    const expectedIntegrity: Omit<SpecificationProductIntegrityV2, "integrity_id"> = {
      schema_id: "penny.specification-product-integrity.v2",
      schema_version: 2,
      status: "PASS",
      request_ref: subject.request_ref,
      ...(subject.specification_assurance_ref === undefined
        ? {}
        : { specification_assurance_ref: subject.specification_assurance_ref }),
      frame_ref: subject.frame_ref,
      orientation_ref: subject.analysis_ref,
      admission_ref: subject.admission_ref,
      trace_ref: subject.trace_ref,
      evidence_refs: subject.evidence_refs,
      imported_input_refs: subject.imported_input_refs,
      draft_ref: subject.draft_ref,
      specification_ref: product,
      vera_report_ref: validity.review_report_ref,
      carren_report_ref: quality.review_report_ref,
      validity_receipt_ref: validityRef,
      quality_receipt_ref: qualityRef,
      execution_receipt_ids: executionReceiptIds,
      checks: [
        "canonical_specification",
        "exact_lineage",
        "profile_semantics",
        "complete_source_coverage",
        "revision_supersession",
        "signed_worker_evidence",
        "latest_validity_receipt",
        "latest_quality_receipt",
        "no_planning_taskification_or_execution",
        "exact_definition_trace_and_support",
      ],
      planning_started: false,
      taskification_started: false,
      execution_started: false,
      execution_authorized: false,
    };
    const expectedEnvelope: Omit<SpecificationProductEnvelopeV2, "envelope_id"> = {
      schema_id: "penny.specification-product-envelope.v2",
      schema_version: 2,
      run_id: context.identity.run_id,
      status: "complete",
      request_ref: subject.request_ref,
      ...(subject.specification_assurance_ref === undefined
        ? {}
        : { specification_assurance_ref: subject.specification_assurance_ref }),
      frame_ref: subject.frame_ref,
      orientation_ref: subject.analysis_ref,
      admission_ref: subject.admission_ref,
      trace_ref: subject.trace_ref,
      evidence_refs: subject.evidence_refs,
      imported_input_refs: subject.imported_input_refs,
      draft_ref: subject.draft_ref,
      specification_ref: product,
      vera_report_ref: validity.review_report_ref,
      carren_report_ref: quality.review_report_ref,
      validity_receipt_ref: validityRef,
      quality_receipt_ref: qualityRef,
      integrity_ref: integrityRef,
    };
    if (
      canonicalJson(integrity) !==
        canonicalJson({
          ...expectedIntegrity,
          integrity_id: specificationProductIntegrityV2Id(expectedIntegrity),
        }) ||
      canonicalJson(envelope) !==
        canonicalJson({
          ...expectedEnvelope,
          envelope_id: specificationProductEnvelopeV2Id(expectedEnvelope),
        })
    )
      return { passed: false, evidence_refs: [] };
    const refs = uniqueRefs([
      subject.request_ref,
      assuranceRef,
      manifest,
      subject.analysis_ref,
      subject.frame_ref,
      subject.admission_ref,
      ...subject.evidence_refs,
      ...subject.imported_input_refs,
      ...specificationDraftAuthoringRefs(reader, subject.draft_ref),
      product,
      subject.trace_ref,
      ...subject.support_refs,
      validity.review_report_ref,
      quality.review_report_ref,
      validityRef,
      qualityRef,
      integrityRef,
      envelopeRef,
    ]);
    if (
      refs.some((ref) => canonicalJson(reader.refById(ref.artifact_id)) !== canonicalJson(ref)) ||
      canonicalJson(
        [...input.terminal.artifacts].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id))
      ) !== canonicalJson([...refs].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id))) ||
      ![integrityRef, envelopeRef].every((ref) =>
        [subject.trace_ref, product, validityRef, qualityRef].every((required) =>
          reader
            .metadata(ref)
            .upstream_refs.some((upstream) => canonicalJson(upstream) === canonicalJson(required))
        )
      )
    )
      return { passed: false, evidence_refs: [] };
    return {
      passed: true,
      evidence_refs: executionReceiptIds.map((receiptId) => {
        const result = input.checkpointer.receiptResultById(receiptId);
        if (result === undefined) throw new Error("Define execution receipt missing");
        return {
          kind: "execution_receipt" as const,
          reference_id: receiptId,
          sha256: sha256(canonicalJson(result)),
        };
      }),
    };
  } catch {
    return { passed: false, evidence_refs: [] };
  }
}

export function evaluateDefineLatestReviewedSpecificationDod(
  input: Parameters<CompletionReceiptPredicateV1>[0]
): ReturnType<CompletionReceiptPredicateV1> {
  try {
    if (traceCapable(input.context)) return evaluateTraceBoundDefineCompletion(input);
    const reader = input.artifactReader;
    if (reader === undefined || input.originState !== "admitting_specification") {
      return { passed: false, evidence_refs: [] };
    }
    const product = input.context.selectedArtifacts.find(
      (artifact) => artifact.artifact_id === input.latestProduct.product_id
    );
    const orientation = latestOrientationArtifact(input.context);
    const frameRef = latestDefinitionFrameArtifact(input.context);
    const admission = latestEvidenceAdmissionArtifact(input.context);
    const draft = latestSpecificationDraftArtifact(input.context);
    const requestRef = admittedDefineRequestArtifact(input.context);
    const manifestRef = admittedDefinitionSourceManifestArtifact(input.context);
    if (
      product === undefined ||
      orientation === undefined ||
      frameRef === undefined ||
      admission === undefined ||
      draft === undefined ||
      product.kind !== "specification" ||
      product.content_digest !== input.latestProduct.sha256
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const storedRefs = [
      requestRef,
      manifestRef,
      orientation,
      frameRef,
      admission,
      ...uniqueRefs([latestEvidenceArtifact(input.context)]),
      ...exactDefineInputRefs(input.context),
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
    const request = validateDefineRequest(JSON.parse(requestBytes));
    if (canonicalJson(request) !== requestBytes) return { passed: false, evidence_refs: [] };
    readDefinitionSourceManifest(reader, manifestRef, requestRef);
    const imported = exactDefineInputRefs(input.context);
    const frame = readDefinitionFrame(reader, frameRef, request, requestRef, orientation);
    const prior = priorSpecification(reader, input.context);
    const draftBytes = reader.readById(draft.artifact_id);
    const parsedDraft = parseSpecificationDraft(draftBytes, {
      request,
      frame,
      ...(prior === undefined ? {} : { priorSpecification: prior.value }),
    });
    const specification = validateCanonicalSpecificationBytes(
      reader.readById(product.artifact_id),
      product,
      ...(prior === undefined ? [] : [{ priorSpecification: prior.value }])
    );
    assertSpecificationLineage({
      specification,
      request,
      frame,
      requestArtifactId: requestRef.artifact_id,
      draftArtifactId: draft.artifact_id,
      draft: parsedDraft.draft,
      draftBytes,
      exactInputArtifactIds: imported.map((ref) => ref.artifact_id),
      ...(prior === undefined
        ? {}
        : {
            priorSpecification: prior.value,
            priorSpecificationArtifactId: prior.ref.artifact_id,
          }),
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
    const integrity = readCanonicalJson(
      reader,
      integrityRef,
      validateSpecificationProductIntegrity
    );
    const envelope = readCanonicalJson(reader, envelopeRef, validateSpecificationProductEnvelope);
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
      canonicalJson(integrity.frame_ref) !== canonicalJson(frameRef) ||
      canonicalJson(integrity.orientation_ref) !== canonicalJson(subject.analysis_ref) ||
      canonicalJson(integrity.admission_ref) !== canonicalJson(subject.admission_ref) ||
      canonicalJson(integrity.evidence_refs) !== canonicalJson(subject.evidence_refs) ||
      canonicalJson(integrity.imported_input_refs) !== canonicalJson(subject.imported_input_refs) ||
      canonicalJson(integrity.draft_ref) !== canonicalJson(subject.draft_ref) ||
      canonicalJson(integrity.specification_ref) !== canonicalJson(subject.product_ref) ||
      canonicalJson(integrity.vera_report_ref) !== canonicalJson(validity.review_report_ref) ||
      canonicalJson(integrity.carren_report_ref) !== canonicalJson(quality.review_report_ref) ||
      canonicalJson(integrity.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(integrity.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(integrity.execution_receipt_ids) !==
        canonicalJson(expectedExecutionReceiptIds) ||
      envelope.run_id !== input.context.identity.run_id ||
      canonicalJson(envelope.request_ref) !== canonicalJson(subject.request_ref) ||
      canonicalJson(envelope.frame_ref) !== canonicalJson(frameRef) ||
      canonicalJson(envelope.orientation_ref) !== canonicalJson(subject.analysis_ref) ||
      canonicalJson(envelope.admission_ref) !== canonicalJson(subject.admission_ref) ||
      canonicalJson(envelope.evidence_refs) !== canonicalJson(subject.evidence_refs) ||
      canonicalJson(envelope.imported_input_refs) !== canonicalJson(subject.imported_input_refs) ||
      canonicalJson(envelope.draft_ref) !== canonicalJson(subject.draft_ref) ||
      canonicalJson(envelope.specification_ref) !== canonicalJson(subject.product_ref) ||
      canonicalJson(envelope.vera_report_ref) !== canonicalJson(validity.review_report_ref) ||
      canonicalJson(envelope.carren_report_ref) !== canonicalJson(quality.review_report_ref) ||
      canonicalJson(envelope.validity_receipt_ref) !== canonicalJson(validityRef) ||
      canonicalJson(envelope.quality_receipt_ref) !== canonicalJson(qualityRef) ||
      canonicalJson(envelope.integrity_ref) !== canonicalJson(integrityRef) ||
      expectedReceiptResult(input, validity) === undefined ||
      expectedReceiptResult(input, quality) === undefined ||
      specification.planning_started !== false ||
      specification.taskification_started !== false ||
      specification.execution_started !== false ||
      integrity.planning_started !== false ||
      integrity.taskification_started !== false ||
      input.terminal.result.execution_started !== false ||
      input.terminal.result.execution_authorized !== false ||
      canonicalJson(input.terminal.result.output_artifact_ref) !== canonicalJson(product) ||
      input.terminal.unresolved.length !== 0
    ) {
      return { passed: false, evidence_refs: [] };
    }
    const expectedRefs = [
      requestRef,
      manifestRef,
      orientation,
      frameRef,
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

export const DEFINE_COMPLETION_RECEIPT_PREDICATES: ReadonlyMap<
  string,
  CompletionReceiptPredicateV1
> = new Map([
  ["define_latest_reviewed_specification_dod.v2", evaluateDefineLatestReviewedSpecificationDod],
]);

function defineRegistration(input: {
  readonly name: string;
  readonly contract: SkillContract;
}): PlaybookRegistration {
  const phases = new Map([
    [
      "framing_definition",
      {
        agent: "piper",
        result_schema_id: "penny.define.orientation-summary.v1",
        result_schema_version: 1 as const,
        schema: OrientationSummarySchema,
      },
    ],
    [
      "gathering_definition_evidence",
      {
        agent: "echo",
        result_schema_id: "penny.define.evidence-summary.v1",
        result_schema_version: 1 as const,
        schema: EvidenceSummarySchema,
      },
    ],
    [
      "authoring_specification",
      {
        agent: "rhea",
        result_schema_id: "penny.define.specification-summary.v1",
        result_schema_version: 1 as const,
        schema: SpecificationSummarySchema,
      },
    ],
    [
      "verifying_specification",
      {
        agent: "vera",
        routing_repair_policy: "preserve_source_summary_v1" as const,
        result_schema_id: "penny.define.verification-summary.v1",
        result_schema_version: 1 as const,
        schema: VerificationSummarySchema,
      },
    ],
    [
      "critiquing_specification",
      {
        agent: "carren",
        routing_repair_policy: "preserve_source_summary_v1" as const,
        result_schema_id: "penny.define.critique-summary.v1",
        result_schema_version: 1 as const,
        schema: CritiqueSummarySchema,
      },
    ],
  ]);
  return {
    name: input.name,
    contract: input.contract,
    seal_policy: DEFINE_SEAL_POLICY,
    repair_progress_policy: "exact_fingerprint_v1",
    ingress: "skill",
    start_admission: DEFINE_START_ADMISSION,
    caller_documentation: {
      constraints_schema: DefineInvocationV2Schema,
      example: {
        goal: "Define an expiring document-share-link capability.",
        constraints: {
          schema_version: 2,
          specification_assurance: "reviewed_definition",
          request: {
            schema_version: 1,
            mode: "create",
            requested_profile_id: "software",
            desired_outcomes: ["Owners can issue and revoke bounded public links."],
            audiences: ["Document owners", "Link recipients"],
            in_scope: ["Creation, expiry, and revocation"],
            out_of_scope: ["Changing authenticated sharing"],
            hard_constraints: ["Do not expose document identifiers."],
            non_goals: [],
            known_assumptions: [],
            known_uncertainties: [],
            prior_decisions: [],
            standard_hints: [],
          },
        },
      },
      semantic_caveat:
        "Produces specification only; it does not taskify or execute the specification.",
    },
    liveness: {
      resolver_id: "defineLivenessPolicy",
      resolve: () => DEFINE_LIVENESS_POLICY,
      thinking_policy: "agent_ssot",
    },
    host_states: ["definition_readiness_gate", "sealing_specification", "admitting_specification"],
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
    completionReceiptPredicates: DEFINE_COMPLETION_RECEIPT_PREDICATES,
    construct: (options) =>
      new DefinePlaybook(options.artifactRevisions, options.artifactStore, options.checkpointer),
  };
}

export const DEFINE_PLAYBOOK_REGISTRATION = defineRegistration({
  name: DEFINE_PLAYBOOK_NAME,
  contract: DEFINE_SKILL_CONTRACT,
});
