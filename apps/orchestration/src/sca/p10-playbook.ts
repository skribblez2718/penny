import { Type, type Static } from "typebox";

import type { ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  validateDirective,
  type ArtifactRef,
  type Confidence,
  type Directive,
  type InputArtifacts,
  type JsonValue,
  type OutputArtifactMetadata,
  type SkillContract,
  type StartRequest,
} from "../contracts.js";
import type { RunContext } from "../context.js";
import { ordinaryLivenessPolicy } from "../liveness.js";
import {
  hostOperationPolicyBinding,
  type HostOperationCallRecordV1,
  type HostOperationDeclarationV1,
} from "../host-operations/contracts.js";
import type { Playbook } from "../playbooks/playbook.js";
import type {
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import {
  SCA_P01_RULE_BUNDLE_V1_SCHEMA,
  SCA_RULE_RELEASE_V1_SCHEMA,
  validateScaP01RuleBundleV1,
  validateScaRuleReleaseV1,
} from "./p01-policy-contracts.js";
import {
  admitScaP10Learning,
  scaP10LanguageForPath,
  type ScaP10AdmissionResultV1,
} from "./p10-admission.js";
import { validateScaP08DispositionRevisionV1 } from "./p08-contracts.js";
import { SCA_P10_CANDIDATE_PLAYBOOK_NAME } from "./p10-contracts.js";
import {
  SCA_P10_ADMISSION_SCHEMA,
  SCA_P10_CANDIDATE_START_SCHEMA,
  SCA_P10_CANCELLED_STATE,
  SCA_P10_CLASSIFYING_STATE,
  SCA_P10_COGNITIVE_PAYLOAD_SCHEMA,
  SCA_P10_CONTENT_MODE,
  SCA_P10_DISCLOSURE_ADMISSION_SCHEMA,
  SCA_P10_DOWNSTREAM_OBLIGATION_IDS,
  SCA_P10_ELIGIBILITY_LEDGER_SCHEMA,
  SCA_P10_EXPECTED_CASE_OUTCOME,
  SCA_P10_FINAL_STATE,
  SCA_P10_GATE_SCHEMA,
  SCA_P10_MISSING_DOWNSTREAM_ARTIFACTS,
  SCA_P10_PROPOSAL_CALL_ID,
  SCA_P10_PROPOSAL_PURPOSE,
  SCA_P10_PROPOSING_STATE,
  SCA_P10_PROPOSER_AGENT,
  SCA_P10_PROPOSER_ROLE,
  SCA_P10_PROVIDER_OPENING_GUARD,
  SCA_P10_REQUIRED_MODEL,
  SCA_P10_REQUIRED_TOOL_SUBSET,
  SCA_P10_RESCAN_DIRECTIVE_SCHEMA,
  SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA,
  SCA_P10_RULE_CANDIDATE_REGISTRY_SCHEMA,
  SCA_P10_RULE_CANDIDATE_REVISION_SCHEMA,
  SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA,
  SCA_P10_RULE_PROMOTION_DECISIONS_SCHEMA,
  SCA_P10_RULE_QUARANTINE_RECORDS_SCHEMA,
  SCA_P10_RULE_TEST_FIXTURE_SOURCE_SCHEMA,
  SCA_P10_RULE_TEST_FIXTURES_SCHEMA,
  SCA_P10_RULE_VALIDATION_RESULTS_SCHEMA,
  SCA_P10_TERMINAL_SCHEMA,
  SCA_P10_TO_P11_TRANSITION_SCHEMA,
  SCA_P10_VALIDATING_STATE,
  SCA_P10_VALIDATION_CASE_CLASSES,
  ScaP10CandidateStartV1Schema,
  ScaP10RuleCandidateProposalV1Schema,
  scaP10CandidateId,
  scaP10RuleSha256,
  validateScaP10AdmissionV1,
  validateScaP10CognitivePayloadV1,
  validateScaP10DisclosureAdmissionV1,
  validateScaP10DisclosureScopeV1,
  validateScaP10EligibilityLedgerV1,
  validateScaP10GateV1,
  validateScaP10PromotionAuthorityV1,
  validateScaP10ReassessmentV1,
  validateScaP10RescanDirectiveV1,
  validateScaP10RuleCandidateProposalV1,
  validateScaP10RuleCandidateRegistryV1,
  validateScaP10RuleCandidateRevisionV1,
  validateScaP10RuleLearningOutcomeV1,
  validateScaP10RulePromotionDecisionsV1,
  validateScaP10RuleQuarantineRecordsV1,
  validateScaP10RuleTestFixturesV1,
  validateScaP10TerminalV1,
  validateScaP10ToP11TransitionV1,
  withP10Digest,
  type ScaP10EligibilityItemV1,
  type ScaP10CandidateStartV1,
  type ScaP10LearningDispositionV1,
  type ScaP10TerminalV1,
} from "./p10-contracts.js";
import {
  SCA_P10_RULE_VALIDATION_DECLARATION,
  SCA_P10_RULE_VALIDATION_REQUEST_KIND,
  SCA_P10_RULE_VALIDATION_REQUEST_SCHEMA,
  buildScaP10ValidationManifest,
  deriveScaP10ValidationEntry,
  scaP10RuleValidationRuntimeV1,
  validateScaP10RuleValidationAdapterResultV1,
  validateScaP10RuleValidationRequestV1,
  type ScaP10RuleValidationRuntimeConfigV1,
} from "./p10-validation.js";
import {
  ScaRulePromotionStore,
  createArtifactScaRulePromotionBackendV1,
  type ScaRulePromotionFaultHook,
} from "./p10-promotion.js";

const PRODUCER = "host:sca-p10-candidate" as const;
const P10_PHASE = "SCA-P10" as const;
const REQUEST_KIND = "sca-p10-candidate-request" as const;
const ADMISSION_KIND = "sca-p10-admission" as const;
const ELIGIBILITY_KIND = "sca-p10-eligibility-ledger" as const;
const PAYLOAD_KIND = "sca-p10-cognitive-payload" as const;
const DISCLOSURE_KIND = "sca-p10-disclosure-admission" as const;
const PROPOSAL_OUTPUT_KIND = "sca-p10-rule-candidate-proposal" as const;
const CANDIDATE_REVISION_KIND = "sca-p10-rule-candidate-revision" as const;
const FIXTURE_KIND = "sca-p10-rule-test-fixture" as const;
const FIXTURE_MANIFEST_KIND = "sca-p10-rule-test-fixtures" as const;
const REGISTRY_KIND = "sca-p10-rule-candidate-registry" as const;
const MANIFEST_KIND = "sca-p10-rule-validation-results" as const;
const QUARANTINE_KIND = "sca-p10-rule-quarantine-records" as const;
const DECISIONS_KIND = "sca-p10-rule-promotion-decisions" as const;
const RESCAN_KIND = "sca-p10-rescan-directive" as const;
const OUTCOME_KIND = "sca-p10-rule-learning-outcome" as const;
const GATE_KIND = "sca-p10-gate" as const;
const HANDOFF_KIND = "sca-p10-to-p11-transition" as const;
const TERMINAL_KIND = "sca-p10-terminal" as const;

type ScaP10ValidationEntryV1 = ReturnType<typeof deriveScaP10ValidationEntry>;
type ScaP10PromotionDecisionEntryV1 = {
  candidate_id: string;
  rule_revision_ref: ArtifactRef;
  decision: "promoted" | "denied" | "not_attempted" | "unavailable";
  predecessor_release_ref: ArtifactRef | null;
  predecessor_release_sha256: string | null;
  successor_release_ref: ArtifactRef | null;
  successor_release_sha256: string | null;
  successor_release_revision: number | null;
  receipt_ref: ArtifactRef | null;
  blocker_codes: string[];
};

export { SCA_P10_CANDIDATE_PLAYBOOK_NAME };

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id < right.artifact_id ? -1 : left.artifact_id > right.artifact_id ? 1 : 0
  );
}
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
/** Exact non-null ref accessor; the learnable path guarantees these lineage refs are present. */
function requireRef(value: ArtifactRef | null | undefined, label: string): ArtifactRef {
  if (value === null || value === undefined) throw new Error(`P10 ${label} ref is absent`);
  return value;
}
function requireString(value: string | null | undefined, label: string): string {
  if (value === null || value === undefined) throw new Error(`P10 ${label} is absent`);
  return value;
}
function latestSelected(
  context: RunContext,
  predicate: (ref: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts].reverse().find(predicate);
}
/**
 * Locate the exact validation result for one candidate. The result is persisted by the normal
 * host-operation owner under its own deterministic coordinate, so it is matched by the exact
 * candidate binding read back from the artifact store rather than by a playbook-chosen operation
 * id. A malformed or foreign result is ignored rather than adopted.
 */
/**
 * Locate the exact validation request for one candidate through its deterministic artifact
 * coordinate. Candidate-scoped requests are persisted unselected (many candidates share one kind),
 * so they are never looked up through the single-selection projection.
 */
function findScaP10ValidationRequest(
  store: ArtifactHostStore,
  runId: string,
  candidateId: string
): ArtifactRef | null {
  return store.refFor(
    runId,
    P10_PHASE,
    null,
    SCA_P10_RULE_VALIDATION_REQUEST_KIND,
    `sca-p10-rule-validation-request-${candidateId}`,
    1
  );
}
function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) {
    throw new Error(`P10 ${label} exact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P10 ${label} exact bytes drifted`);
  }
  return bytes;
}
function exactJson<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string,
  validate: (value: unknown) => T
): T {
  const text = exactBytes(store, ref, label).toString("utf8");
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`P10 ${label} is not canonical JSON`);
  return validate(value);
}
function persistJson(input: {
  readonly store: ArtifactHostStore;
  readonly context?: RunContext;
  readonly runId: string;
  readonly phase: string;
  readonly kind: string;
  readonly operationId: string;
  readonly schemaId: string;
  readonly value: unknown;
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly select?: boolean;
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const select = input.select ?? true;
  const prior = input.store.refFor(
    input.runId,
    input.phase,
    null,
    input.kind,
    input.operationId,
    1
  );
  if (prior !== null) {
    if (
      prior.content_digest !== sha256(content) ||
      input.store.readById(prior.artifact_id).toString("utf8") !== content
    ) {
      throw new Error(`P10 artifact '${input.operationId}' conflicts with immutable prior bytes`);
    }
    if (select) input.store.select(prior);
    const context = input.context;
    if (
      context !== undefined &&
      !context.selectedArtifacts.some((ref) => ref.artifact_id === prior.artifact_id)
    ) {
      context.selectedArtifacts.push(prior);
    }
    return prior;
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: PRODUCER,
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    parent_ref: null,
    upstream_refs: uniqueRefs(input.upstreamRefs),
  };
  const ref = input.store.persist({ metadata, content });
  if (select) input.store.select(ref);
  const context = input.context;
  if (
    context !== undefined &&
    !context.selectedArtifacts.some((candidate) => candidate.artifact_id === ref.artifact_id)
  ) {
    context.selectedArtifacts.push(ref);
  }
  return ref;
}
/**
 * Persist one exact raw-bytes artifact (for example a real fixture source file). It is idempotent:
 * a replay with byte-identical content returns the immutable prior revision, and conflicting bytes
 * fail closed.
 */
function persistBytes(input: {
  readonly store: ArtifactHostStore;
  readonly context?: RunContext;
  readonly runId: string;
  readonly phase: string;
  readonly kind: string;
  readonly operationId: string;
  readonly schemaId: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly upstreamRefs: readonly ArtifactRef[];
  readonly select?: boolean;
}): ArtifactRef {
  const content = Buffer.from(input.bytes);
  const select = input.select ?? false;
  const prior = input.store.refFor(
    input.runId,
    input.phase,
    null,
    input.kind,
    input.operationId,
    1
  );
  if (prior !== null) {
    if (
      prior.content_digest !== sha256(content) ||
      !input.store.readById(prior.artifact_id).equals(content)
    ) {
      throw new Error(`P10 artifact '${input.operationId}' conflicts with immutable prior bytes`);
    }
    if (select) input.store.select(prior);
    const context = input.context;
    if (
      context !== undefined &&
      !context.selectedArtifacts.some((ref) => ref.artifact_id === prior.artifact_id)
    ) {
      context.selectedArtifacts.push(prior);
    }
    return prior;
  }
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id: input.runId,
    phase: input.phase,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: PRODUCER,
    media_type: input.mediaType,
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    parent_ref: null,
    upstream_refs: uniqueRefs(input.upstreamRefs),
  };
  const ref = input.store.persist({ metadata, content });
  if (select) input.store.select(ref);
  const context = input.context;
  if (
    context !== undefined &&
    !context.selectedArtifacts.some((candidate) => candidate.artifact_id === ref.artifact_id)
  ) {
    context.selectedArtifacts.push(ref);
  }
  return ref;
}
function validateScaP10CandidateStart(value: unknown): ScaP10CandidateStartV1 {
  return validateContract(ScaP10CandidateStartV1Schema, value, "SCA P10 start constraints");
}
function outputArtifact(input: {
  readonly runId: string;
  readonly state: string;
  readonly agent: string;
  readonly kind: string;
  readonly operationId: string;
  readonly upstream: readonly ArtifactRef[];
}): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: input.runId,
    phase: input.state,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: 1,
    producer: `agent:${input.agent}`,
    media_type: "text/plain",
    content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
    parent_ref: null,
    upstream_refs: [...input.upstream],
  };
}

const P10DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    eligibility_ledger_ref: Type.Optional(ArtifactRefSchema),
    payload_ref: Type.Optional(ArtifactRefSchema),
    disclosure_ref: Type.Optional(ArtifactRefSchema),
  },
  { additionalProperties: false }
);
type P10Data = Readonly<Static<typeof P10DataSchema>>;
function data(context: RunContext): P10Data {
  return validateContract(P10DataSchema, context.playbookData, "SCA P10 durable state");
}

/**
 * Exact projection of the durable host-operation journal the playbook needs. The production engine
 * passes its `Checkpointer`, which already satisfies this shape; the field is a structural view so
 * the playbook never gains a broader custody surface than the exact per-operation result binding.
 */
export interface ScaP10HostOperationJournalV1 {
  hostOperationCallsForRun(
    runId: string
  ): readonly Pick<
    HostOperationCallRecordV1,
    "state_id" | "operation_id" | "request_ref" | "operation_result_ref" | "disposition"
  >[];
}

export interface ScaP10CandidateBindingV1 {
  readonly resolve_current_p07_authority_ref?: (scope: {
    readonly tenant_id: string;
    readonly project_id: string;
    readonly run_id: string;
    readonly transition_ref: ArtifactRef;
  }) => ArtifactRef;
  readonly resolve_current_p01_obligation_head_ref?: (scope: {
    readonly tenant_id: string;
    readonly project_id: string;
    readonly run_id: string;
  }) => ArtifactRef;
  /** Exact host-operation declaration; absent uses the fixed provider-free compatibility fixture. */
  readonly declaration?: HostOperationDeclarationV1;
  /** Socket-independent backend key; production binds the runtime-derived key. */
  readonly backend_key_sha256?: string;
  /** Local Semgrep runtime; absent uses the fail-closed `unavailable` runtime. */
  readonly rule_validation_runtime?: ScaP10RuleValidationRuntimeConfigV1;
  readonly promotionFault?: ScaRulePromotionFaultHook;
}

/** Stable backend key for the provider-free compatibility fixture (no installed host runtime). */
const DEFAULT_P10_BACKEND_KEY_SHA256 = sha256(
  canonicalJson({
    schema_version: 1,
    operation_kind: SCA_P10_RULE_VALIDATION_DECLARATION.operation_kind,
    adapter_id: SCA_P10_RULE_VALIDATION_DECLARATION.adapter_id,
    backend_binding_id: SCA_P10_RULE_VALIDATION_DECLARATION.backend_binding_id,
    runtime: "unavailable",
  })
);

export class ScaP10CandidatePlaybook implements Playbook {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly binding: ScaP10CandidateBindingV1 = {},
    private readonly trustedClock: () => Date = () => new Date(),
    private readonly journal?: ScaP10HostOperationJournalV1
  ) {}

  /**
   * Resolve the exact per-candidate validation result from the durable host-operation journal. The
   * owner persists one result per candidate's operation record; because P10 declares the result
   * selection policy `unselected`, the result is never the single current revision of its kind.
   * Binding is by the exact operation id the playbook issued plus the candidate read back from the
   * result bytes, so distinct results of one kind never collide.
   */
  private findScaP10ValidationResult(
    context: RunContext,
    candidateId: string
  ): ArtifactRef | undefined {
    const operationId = `sca-p10-rule-validation-${candidateId}`;
    const requestRef = findScaP10ValidationRequest(
      this.store,
      context.identity.run_id,
      candidateId
    );
    if (requestRef === null) return undefined;
    const records = this.journal?.hostOperationCallsForRun(context.identity.run_id) ?? [];
    let found: ArtifactRef | undefined;
    for (const record of records) {
      if (record.state_id !== SCA_P10_VALIDATING_STATE) continue;
      if (record.operation_id !== operationId) continue;
      const ref = record.operation_result_ref;
      if (ref === null) continue;
      if (record.request_ref.artifact_id !== requestRef.artifact_id) {
        throw new Error("SCA P10 validation journal record is not bound to its request");
      }
      const request = validateScaP10RuleValidationRequestV1(
        exactJson(
          this.store,
          requestRef,
          "rule validation request",
          validateScaP10RuleValidationRequestV1
        )
      );
      const result = exactJson(
        this.store,
        ref,
        "rule validation result",
        validateScaP10RuleValidationAdapterResultV1
      );
      if (result.candidate_id !== candidateId || result.request_sha256 !== request.request_sha256) {
        throw new Error("SCA P10 validation result candidate binding mismatch");
      }
      if (found !== undefined && found.artifact_id !== ref.artifact_id) {
        throw new Error("SCA P10 validation result is ambiguous across journal records");
      }
      found = ref;
    }
    return found;
  }

  initialize(context: RunContext): Directive {
    return this.startRun(context);
  }

  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    if (context.stateId === SCA_P10_PROPOSING_STATE) return this.issueProposal(context);
    if (context.stateId === SCA_P10_VALIDATING_STATE) return this.resumeValidation(context);
    if (context.stateId === SCA_P10_FINAL_STATE) return this.finalizeFromState(context);
    throw new Error(`SCA P10 has no dispatch for '${context.stateId}'`);
  }

  resume(): Directive {
    throw new Error("SCA P10 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = SCA_P10_CANCELLED_STATE;
    context.status = "cancelled";
    context.met = false;
    const terminal = validateScaP10TerminalV1(
      withP10Digest(
        {
          schema_id: SCA_P10_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P10_PHASE,
          status: "cancelled" as const,
          learning_outcome_ref: null,
          gate_ref: null,
          p11_transition_ref: null,
          p11_handoff_ready: false,
          eligibility_ledger_ref: null,
          promotion_performed: false,
          promotion_receipt_ref: null,
          outcome_disposition: null,
          eligible_refs: [],
          ineligible_refs: [],
          missing_downstream_artifacts: [...SCA_P10_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: [...SCA_P10_DOWNSTREAM_OBLIGATION_IDS],
          selected_artifact_refs: this.selectedCoreRefs(context),
          blocker_codes: ["p10_cancelled"],
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          p12_release_authorized: false as const,
          report_or_release_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    void reason;
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P10_PHASE,
      kind: TERMINAL_KIND,
      operationId: "sca-p10-terminal-cancelled",
      schemaId: SCA_P10_TERMINAL_SCHEMA,
      value: terminal,
      upstreamRefs: this.selectedCoreRefs(context),
      select: false,
    });
    const directive = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: terminal,
      artifacts: uniqueRefs([terminalRef, ...this.selectedCoreRefs(context)]).slice(0, 128),
      unresolved: terminal.blocker_codes,
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    const pending = context.pendingDirective;
    if (pending !== null) return pending;
    if (context.stateId === SCA_P10_FINAL_STATE) {
      try {
        return this.finalizeFromState(context);
      } catch {
        return this.finalizeNonPositive(context, "p10_restart_finalization_failed");
      }
    }
    if (context.stateId === SCA_P10_VALIDATING_STATE) return this.resumeValidation(context);
    return null;
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    return this.acceptProposal(context, details);
  }

  private startRun(context: RunContext): Directive {
    const runId = context.identity.run_id;
    const requestRef = latestSelected(
      context,
      (ref) => ref.kind === REQUEST_KIND && ref.run_id === runId
    );
    if (requestRef === undefined) throw new Error("SCA P10 admitted request is absent");
    const constraints = exactJson(
      this.store,
      requestRef,
      "candidate request",
      validateScaP10CandidateStart
    );
    const admitted = this.readmit(runId, constraints);
    const admissionRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P10_PHASE,
      kind: ADMISSION_KIND,
      operationId: "sca-p10-admission",
      schemaId: SCA_P10_ADMISSION_SCHEMA,
      value: admitted.admission,
      upstreamRefs: uniqueRefs([requestRef, ...admitted.evidence_refs]),
    });
    Object.assign(context.playbookData, { request_ref: requestRef, admission_ref: admissionRef });
    if (admitted.non_learnable) {
      context.transition(SCA_P10_FINAL_STATE);
      return this.finalizeNonPositive(
        context,
        admitted.non_learnable_reason ?? "p10_non_learnable_p09_checkpoint"
      );
    }
    if (admitted.eligibility === null) {
      throw new Error("SCA P10 learnable admission lacks an eligibility ledger");
    }
    const revision = admitted.eligibility.eligibility_ledger_revision ?? 1;
    const eligibilityRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P10_PHASE,
      kind: ELIGIBILITY_KIND,
      operationId:
        revision === 1
          ? "sca-p10-eligibility-ledger"
          : `sca-p10-eligibility-ledger-revision-${String(revision).padStart(6, "0")}`,
      schemaId: SCA_P10_ELIGIBILITY_LEDGER_SCHEMA,
      value: admitted.eligibility,
      upstreamRefs: uniqueRefs([
        admissionRef,
        requireRef(admitted.admission.p09_reconciliation_ledger_ref, "P09 reconciliation ledger"),
        ...(constraints.p10_reassessment_ref === null ? [] : [constraints.p10_reassessment_ref]),
        ...(constraints.p10_prior_ledger_ref === null ? [] : [constraints.p10_prior_ledger_ref]),
      ]),
    });
    Object.assign(context.playbookData, { eligibility_ledger_ref: eligibilityRef });
    return this.afterClassification(context, admitted, admissionRef, eligibilityRef);
  }

  private afterClassification(
    context: RunContext,
    admitted: ScaP10AdmissionResultV1,
    admissionRef: ArtifactRef,
    eligibilityRef: ArtifactRef
  ): Directive {
    const established = (admitted.eligibility?.eligible_items ?? []).filter(
      (item) => item.eligible_classification === "established_issue"
    );
    if (established.length === 0) {
      context.transition(SCA_P10_FINAL_STATE);
      return this.finalize(context, admitted, admissionRef, eligibilityRef, "no_rule");
    }
    const payload = this.buildPayload(context, admitted, eligibilityRef, established);
    const disclosure = this.buildDisclosure(
      context,
      admitted,
      payload.payload_ref,
      payload.payload
    );
    Object.assign(context.playbookData, {
      payload_ref: payload.payload_ref,
      disclosure_ref: disclosure.disclosure_ref,
    });
    if (disclosure.disclosure.decision !== "allow") {
      context.transition(SCA_P10_FINAL_STATE);
      return this.finalize(context, admitted, admissionRef, eligibilityRef, "blocked_learning", [
        "p10_disclosure_denied",
        ...disclosure.disclosure.blocker_codes,
      ]);
    }
    context.transition(SCA_P10_PROPOSING_STATE);
    return this.issueProposal(context);
  }

  private readmit(runId: string, constraints: ScaP10CandidateStartV1): ScaP10AdmissionResultV1 {
    const p07 = this.binding.resolve_current_p07_authority_ref;
    const p01 = this.binding.resolve_current_p01_obligation_head_ref;
    return admitScaP10Learning({
      store: this.store,
      run_id: runId,
      p09_terminal_ref: constraints.p09_terminal_ref,
      p09_transition_ref: constraints.p09_transition_ref,
      p09_reconciliation_ledger_ref: constraints.p09_reconciliation_ledger_ref,
      p09_gate_ref: constraints.p09_gate_ref,
      p09_admission_ref: constraints.p09_admission_ref,
      p08_terminal_ref: constraints.p08_terminal_ref,
      p08_transition_ref: constraints.p08_transition_ref,
      p08_evidence_ledger_ref: constraints.p08_evidence_ledger_ref,
      p08_gate_ref: constraints.p08_gate_ref,
      p08_admission_ref: constraints.p08_admission_ref,
      p08_item_universe_ref: constraints.p08_item_universe_ref,
      p01_obligation_ledger_ref: constraints.p01_obligation_ledger_ref,
      p09_coverage_input_ref: constraints.p09_coverage_input_ref,
      p09_phase_evidence_refs: constraints.p09_phase_evidence_refs,
      p09_obligation_resolution_ref: constraints.p09_obligation_resolution_ref,
      p09_reassessment_ref: constraints.p09_reassessment_ref,
      baseline_evidence_ref: constraints.baseline_evidence_ref,
      disclosure_scope_ref: constraints.disclosure_scope_ref,
      promotion_authority_ref: constraints.promotion_authority_ref,
      active_run_rule_release_refs: constraints.active_run_rule_release_refs,
      p10_reassessment_ref: constraints.p10_reassessment_ref,
      p10_prior_eligibility_ledger_ref: constraints.p10_prior_ledger_ref,
      ...(p07 === undefined ? {} : { resolve_current_p07_authority_ref: p07 }),
      ...(p01 === undefined ? {} : { resolve_current_p01_obligation_head_ref: p01 }),
    });
  }

  private readmitFromState(context: RunContext): ScaP10AdmissionResultV1 {
    const state = data(context);
    const constraints = exactJson(
      this.store,
      state.request_ref,
      "candidate request",
      validateScaP10CandidateStart
    );
    const admitted = this.readmit(context.identity.run_id, constraints);
    const persisted = validateScaP10AdmissionV1(
      exactJson(this.store, state.admission_ref, "admission", validateScaP10AdmissionV1)
    );
    if (!same(admitted.admission, persisted)) {
      throw new Error("SCA P10 durable admission drifted from exact lineage");
    }
    return admitted;
  }

  private buildPayload(
    context: RunContext,
    admitted: ScaP10AdmissionResultV1,
    eligibilityRef: ArtifactRef,
    established: readonly ScaP10EligibilityItemV1[]
  ): {
    readonly payload_ref: ArtifactRef;
    readonly payload: ReturnType<typeof validateScaP10CognitivePayloadV1>;
  } {
    const ledgerRef = admitted.admission.p09_reconciliation_ledger_ref;
    if (ledgerRef === null || admitted.baseline === null) {
      throw new Error("P10 proposal requires a reconciliation ledger and baseline evidence");
    }
    const items = established.map((item) => {
      const revision = exactJson(
        this.store,
        item.p08_disposition_ref,
        "established disposition revision",
        validateScaP08DispositionRevisionV1
      );
      const repositoryPath = revision.repository_path;
      const lineStart = revision.line_start;
      const lineEnd = revision.line_end;
      if (repositoryPath === null || lineStart === null || lineEnd === null) {
        throw new Error("P10 established issue is unlocated and cannot seed a candidate");
      }
      return {
        item_id: item.item_id,
        primary_ref: item.primary_ref,
        p08_disposition_ref: item.p08_disposition_ref,
        repository_path: repositoryPath,
        line_start: lineStart,
        line_end: lineEnd,
        root_cause_evidence_refs: [item.p08_disposition_ref, item.primary_ref].sort(
          (left, right) => (left.artifact_id < right.artifact_id ? -1 : 1)
        ),
        distinguishing_oracle: revision.distinguishing_oracle,
        excerpt: `established issue ${item.identity}`,
      };
    });
    const payload = validateScaP10CognitivePayloadV1(
      withP10Digest(
        {
          schema_id: SCA_P10_COGNITIVE_PAYLOAD_SCHEMA,
          schema_version: 1 as const,
          run_id: admitted.admission.run_id,
          phase_id: P10_PHASE,
          call_id: SCA_P10_PROPOSAL_CALL_ID,
          role: SCA_P10_PROPOSER_ROLE,
          purpose: SCA_P10_PROPOSAL_PURPOSE,
          required_model: SCA_P10_REQUIRED_MODEL,
          p09_reconciliation_ledger_ref: ledgerRef,
          eligibility_ledger_ref: eligibilityRef,
          baseline_evidence_ref: admitted.baseline.evidence_ref,
          frozen_rule_release_ref: admitted.baseline.evidence.frozen_rule_release_ref,
          disclosure_scope_ref: admitted.admission.disclosure_scope_ref,
          assigned_item_ids: items.map((item) => item.item_id),
          items,
          content_mode: SCA_P10_CONTENT_MODE,
        },
        "payload_sha256"
      )
    );
    const payloadRef = persistJson({
      store: this.store,
      context,
      runId: admitted.admission.run_id,
      phase: SCA_P10_PROPOSING_STATE,
      kind: PAYLOAD_KIND,
      operationId: "sca-p10-proposal-payload",
      schemaId: SCA_P10_COGNITIVE_PAYLOAD_SCHEMA,
      value: payload,
      upstreamRefs: [ledgerRef, eligibilityRef, admitted.baseline.evidence_ref],
    });
    return { payload_ref: payloadRef, payload };
  }

  private buildDisclosure(
    context: RunContext,
    admitted: ScaP10AdmissionResultV1,
    payloadRef: ArtifactRef,
    payload: ReturnType<typeof validateScaP10CognitivePayloadV1>
  ): {
    readonly disclosure_ref: ArtifactRef;
    readonly disclosure: ReturnType<typeof validateScaP10DisclosureAdmissionV1>;
  } {
    const scope = exactJson(
      this.store,
      admitted.admission.disclosure_scope_ref,
      "disclosure scope",
      validateScaP10DisclosureScopeV1
    );
    const authorized = uniqueRefs([
      payload.p09_reconciliation_ledger_ref,
      payload.eligibility_ledger_ref,
      payload.baseline_evidence_ref,
      payload.frozen_rule_release_ref,
      ...payload.items.flatMap((item) => [
        item.primary_ref,
        item.p08_disposition_ref,
        ...item.root_cause_evidence_refs,
      ]),
    ]);
    const withinLimit = payloadRef.byte_length <= scope.max_payload_bytes_per_call;
    const blocked =
      scope.decision !== "allow" ||
      scope.run_id !== admitted.admission.run_id ||
      !same(scope.required_model, SCA_P10_REQUIRED_MODEL) ||
      !withinLimit;
    const disclosure = validateScaP10DisclosureAdmissionV1(
      withP10Digest(
        {
          schema_id: SCA_P10_DISCLOSURE_ADMISSION_SCHEMA,
          schema_version: 1 as const,
          run_id: admitted.admission.run_id,
          phase_id: P10_PHASE,
          call_id: SCA_P10_PROPOSAL_CALL_ID,
          role: SCA_P10_PROPOSER_ROLE,
          purpose: SCA_P10_PROPOSAL_PURPOSE,
          required_model: SCA_P10_REQUIRED_MODEL,
          disclosure_scope_ref: admitted.admission.disclosure_scope_ref,
          disclosure_scope_sha256: scope.scope_sha256,
          payload_ref: payloadRef,
          payload_sha256: payloadRef.content_digest,
          payload_byte_length: payloadRef.byte_length,
          serialized_opening_byte_limit: scope.max_payload_bytes_per_call,
          authorized_refs: authorized,
          destination: "cloud" as const,
          retention_days: scope.provider_retention_days,
          logging_status: scope.provider_logging_status,
          logging_days: scope.provider_logging_days,
          training: "prohibited" as const,
          secrets_embedded: false as const,
          personal_data_embedded: false as const,
          decision: blocked ? ("deny" as const) : ("allow" as const),
          blocker_codes: blocked
            ? [withinLimit ? "p10_disclosure_scope_denied" : "p10_payload_limit_exceeded"]
            : [],
          evaluated_before_dispatch: true as const,
        },
        "admission_sha256"
      )
    );
    const disclosureRef = persistJson({
      store: this.store,
      context,
      runId: admitted.admission.run_id,
      phase: SCA_P10_PROPOSING_STATE,
      kind: DISCLOSURE_KIND,
      operationId: "sca-p10-disclosure-admission",
      schemaId: SCA_P10_DISCLOSURE_ADMISSION_SCHEMA,
      value: disclosure,
      upstreamRefs: [payloadRef, admitted.admission.disclosure_scope_ref],
    });
    return { disclosure_ref: disclosureRef, disclosure };
  }

  private issueProposal(context: RunContext): Directive {
    const state = data(context);
    if (state.payload_ref === undefined || state.disclosure_ref === undefined) {
      throw new Error("SCA P10 proposal phase lacks payload or disclosure");
    }
    const directive = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: SCA_P10_PROPOSING_STATE,
      agent: SCA_P10_PROPOSER_AGENT,
      attempt: 1,
      trust_profile: "hardened-untrusted",
      model_override: SCA_P10_REQUIRED_MODEL.override,
      task: "Propose zero or more single-rule Semgrep candidates for the established issues in the exact host-verified payload. Each proposal must name an assigned established issue, a root-cause claim grounded in the issue's authorized evidence refs, the issue's source language, a rule_id, a category, and base64 rule content. If no feasible rule exists, set no_feasible_rule true with an empty proposals list. Return only the exact closed rule-candidate-proposal JSON contract. No tools are available.",
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "cognitive_payload", ref: state.payload_ref },
          { slot: "disclosure_admission", ref: state.disclosure_ref },
        ],
      },
      output_artifact: outputArtifact({
        runId: context.identity.run_id,
        state: SCA_P10_PROPOSING_STATE,
        agent: SCA_P10_PROPOSER_AGENT,
        kind: PROPOSAL_OUTPUT_KIND,
        operationId: "sca-p10-rule-candidate-proposal",
        upstream: [state.payload_ref, state.disclosure_ref],
      }),
    });
    context.pendingDirective = directive;
    return directive;
  }

  private acceptProposal(context: RunContext, details: Record<string, JsonValue>): Directive {
    if (context.stateId !== SCA_P10_PROPOSING_STATE) {
      throw new Error(`unexpected SCA P10 summary in '${context.stateId}'`);
    }
    const state = data(context);
    if (state.payload_ref === undefined || state.eligibility_ledger_ref === undefined) {
      throw new Error("SCA P10 proposal lacks a payload or eligibility ledger");
    }
    const payload = exactJson(
      this.store,
      state.payload_ref,
      "proposal payload",
      validateScaP10CognitivePayloadV1
    );
    const proposal = validateScaP10RuleCandidateProposalV1(details);
    if (proposal.payload_sha256 !== payload.payload_sha256) {
      throw new Error("SCA P10 proposal is not bound to the exact payload");
    }
    const admitted = this.readmitFromState(context);
    const registryRef = this.buildCandidates(context, admitted, payload, proposal);
    if (registryRef === null) {
      context.transition(SCA_P10_FINAL_STATE);
      return this.finalize(
        context,
        admitted,
        state.admission_ref,
        state.eligibility_ledger_ref,
        "no_rule"
      );
    }
    context.transition(SCA_P10_VALIDATING_STATE);
    return this.resumeValidation(context);
  }

  private readConstraints(context: RunContext): ScaP10CandidateStartV1 {
    const state = data(context);
    return exactJson(
      this.store,
      state.request_ref,
      "candidate request",
      validateScaP10CandidateStart
    );
  }

  /**
   * Prior immutable candidate revisions named as reassessment stimuli. A reassessment re-proposal
   * for the same candidate appends a new revision whose parent is the exact prior revision; a
   * candidate with no named parent stays revision 1.
   */
  private priorCandidateRevisions(
    reassessmentRef: ArtifactRef | null
  ): Map<string, { readonly ref: ArtifactRef; readonly revision: number }> {
    const prior = new Map<string, { readonly ref: ArtifactRef; readonly revision: number }>();
    if (reassessmentRef === null) return prior;
    const reassessment = exactJson(
      this.store,
      reassessmentRef,
      "reassessment",
      validateScaP10ReassessmentV1
    );
    for (const ref of reassessment.stimulus_refs) {
      if (ref.kind !== CANDIDATE_REVISION_KIND) continue;
      const revision = exactJson(
        this.store,
        ref,
        "prior candidate revision",
        validateScaP10RuleCandidateRevisionV1
      );
      prior.set(revision.candidate_id, { ref, revision: revision.revision });
    }
    return prior;
  }

  private buildCandidates(
    context: RunContext,
    admitted: ScaP10AdmissionResultV1,
    payload: ReturnType<typeof validateScaP10CognitivePayloadV1>,
    proposal: ReturnType<typeof validateScaP10RuleCandidateProposalV1>
  ): ArtifactRef | null {
    const runId = admitted.admission.run_id;
    const baseline = admitted.baseline;
    if (baseline === null) throw new Error("P10 candidate construction requires baseline evidence");
    if (proposal.proposals.length === 0) return null;
    const priorRevisions = this.priorCandidateRevisions(
      this.readConstraints(context).p10_reassessment_ref
    );
    const revisionRefs: ArtifactRef[] = [];
    const candidates: {
      candidate_id: string;
      current_revision_ref: ArtifactRef;
      prior_revision_refs: ArtifactRef[];
    }[] = [];
    for (const proposed of proposal.proposals) {
      const payloadItem = payload.items.find(
        (item) => item.item_id === proposed.established_issue_item_id
      );
      if (payloadItem === undefined) {
        throw new Error("SCA P10 proposal names an issue outside the disclosed payload");
      }
      const issueLanguage = scaP10LanguageForPath(payloadItem.repository_path);
      if (issueLanguage !== proposed.rule_language) {
        throw new Error("SCA P10 proposal rule language disagrees with the issue source language");
      }
      const authorizedRefIds = new Set([
        payloadItem.primary_ref.artifact_id,
        payloadItem.p08_disposition_ref.artifact_id,
        ...payloadItem.root_cause_evidence_refs.map((entry) => entry.artifact_id),
      ]);
      for (const ref of proposed.root_cause_evidence_refs) {
        if (!authorizedRefIds.has(ref.artifact_id)) {
          throw new Error("SCA P10 proposal cites root-cause evidence outside the disclosure");
        }
      }
      const ruleSha256 = scaP10RuleSha256(proposed.rule_content_base64);
      const candidateId = scaP10CandidateId({
        established_issue_item_id: proposed.established_issue_item_id,
        rule_sha256: ruleSha256,
      });
      const fixturesByClass = new Map(proposed.fixtures.map((f) => [f.case_class, f]));
      for (const fixture of proposed.fixtures) {
        if (scaP10LanguageForPath(fixture.file_name) !== proposed.rule_language) {
          throw new Error("SCA P10 proposal fixture file name disagrees with the rule language");
        }
      }
      const fixtureRefs = SCA_P10_VALIDATION_CASE_CLASSES.map((caseClass) => {
        const fixture = fixturesByClass.get(caseClass);
        if (fixture === undefined) {
          throw new Error(`SCA P10 proposal omits the required fixture case '${caseClass}'`);
        }
        // Persist the exact authored fixture source bytes unselected: many candidates share one
        // fixture kind, so selection is never used as the per-candidate identity.
        const fixtureRef = persistBytes({
          store: this.store,
          context,
          runId,
          phase: P10_PHASE,
          kind: FIXTURE_KIND,
          operationId: `sca-p10-fixture-${candidateId}-${caseClass}`,
          schemaId: SCA_P10_RULE_TEST_FIXTURE_SOURCE_SCHEMA,
          mediaType: "text/plain",
          // These are proposer-authored self-test bytes, NOT independent or held-out truth.
          // Production host admission blocks would-be positives until approved truth is supplied.
          bytes: Buffer.from(fixture.content_base64, "base64"),
          upstreamRefs: [payloadItem.p08_disposition_ref],
          select: false,
        });
        return { case_class: caseClass, file_name: fixture.file_name, ref: fixtureRef };
      });
      const fixtureManifest = validateScaP10RuleTestFixturesV1(
        withP10Digest(
          {
            schema_id: SCA_P10_RULE_TEST_FIXTURES_SCHEMA,
            schema_version: 1 as const,
            phase_id: P10_PHASE,
            run_id: runId,
            candidate_id: candidateId,
            fixture_directory: `sca-p10/${candidateId}/fixtures`,
            cases: fixtureRefs.map((entry) => ({
              case_class: entry.case_class,
              file_name: entry.file_name,
              fixture_ref: entry.ref,
              expected_outcome: SCA_P10_EXPECTED_CASE_OUTCOME[entry.case_class],
              content_sha256: entry.ref.content_digest,
            })),
          },
          "fixture_sha256"
        )
      );
      const fixtureManifestRef = persistJson({
        store: this.store,
        context,
        runId,
        phase: P10_PHASE,
        kind: FIXTURE_MANIFEST_KIND,
        operationId: `sca-p10-fixture-manifest-${candidateId}`,
        schemaId: SCA_P10_RULE_TEST_FIXTURES_SCHEMA,
        value: fixtureManifest,
        upstreamRefs: fixtureRefs.map((entry) => entry.ref),
        select: false,
      });
      const priorRevision = priorRevisions.get(candidateId) ?? null;
      const revisionNumber = priorRevision === null ? 1 : priorRevision.revision + 1;
      const revision = validateScaP10RuleCandidateRevisionV1(
        withP10Digest(
          {
            schema_id: SCA_P10_RULE_CANDIDATE_REVISION_SCHEMA,
            schema_version: 1 as const,
            phase_id: P10_PHASE,
            run_id: runId,
            candidate_id: candidateId,
            revision: revisionNumber,
            parent_revision_ref: priorRevision?.ref ?? null,
            parent_revision_sha256: priorRevision?.ref.content_digest ?? null,
            established_issue_item_id: proposed.established_issue_item_id,
            root_cause_claim: proposed.root_cause_claim,
            root_cause_evidence_refs: proposed.root_cause_evidence_refs,
            distinguishing_oracle: proposed.distinguishing_oracle,
            repository_path: payloadItem.repository_path,
            line_start: payloadItem.line_start,
            line_end: payloadItem.line_end,
            source_snapshot_ref: baseline.evidence.source_snapshot_ref,
            source_snapshot_sha256: baseline.evidence.source_snapshot_sha256,
            finding_disposition_revision_ref: payloadItem.p08_disposition_ref,
            finding_disposition_revision_sha256: payloadItem.p08_disposition_ref.content_digest,
            fixture_manifest_ref: fixtureManifestRef,
            fixture_manifest_sha256: fixtureManifestRef.content_digest,
            rule_id: proposed.rule_id,
            rule_language: proposed.rule_language,
            rule_category: proposed.rule_category,
            rule_content_base64: proposed.rule_content_base64,
            rule_sha256: ruleSha256,
            created_at: this.trustedClock().toISOString(),
          },
          "revision_sha256"
        )
      );
      const revisionRef = persistJson({
        store: this.store,
        context,
        runId,
        phase: P10_PHASE,
        kind: CANDIDATE_REVISION_KIND,
        operationId: `sca-p10-candidate-${candidateId}-revision-${String(revisionNumber).padStart(6, "0")}`,
        schemaId: SCA_P10_RULE_CANDIDATE_REVISION_SCHEMA,
        value: revision,
        upstreamRefs: [
          fixtureManifestRef,
          payloadItem.p08_disposition_ref,
          ...(priorRevision === null ? [] : [priorRevision.ref]),
        ],
        select: false,
      });
      revisionRefs.push(revisionRef);
      candidates.push({
        candidate_id: candidateId,
        current_revision_ref: revisionRef,
        prior_revision_refs: priorRevision === null ? [] : [priorRevision.ref],
      });
    }
    const registry = validateScaP10RuleCandidateRegistryV1(
      withP10Digest(
        {
          schema_id: SCA_P10_RULE_CANDIDATE_REGISTRY_SCHEMA,
          schema_version: 1 as const,
          phase_id: P10_PHASE,
          run_id: runId,
          candidates: [...candidates].sort((left, right) =>
            left.candidate_id < right.candidate_id ? -1 : 1
          ),
          candidate_count: candidates.length,
          append_only: true as const,
        },
        "registry_sha256"
      )
    );
    return persistJson({
      store: this.store,
      context,
      runId,
      phase: P10_PHASE,
      kind: REGISTRY_KIND,
      operationId: "sca-p10-rule-candidate-registry",
      schemaId: SCA_P10_RULE_CANDIDATE_REGISTRY_SCHEMA,
      value: registry,
      upstreamRefs: revisionRefs,
    });
  }

  private resumeValidation(context: RunContext): Directive {
    const state = data(context);
    const registryRef = latestSelected(context, (ref) => ref.kind === REGISTRY_KIND);
    if (registryRef === undefined) {
      throw new Error("SCA P10 validation phase lacks a candidate registry");
    }
    const registry = exactJson(
      this.store,
      registryRef,
      "candidate registry",
      validateScaP10RuleCandidateRegistryV1
    );
    const admitted = this.readmitFromState(context);
    if (state.eligibility_ledger_ref === undefined) {
      throw new Error("SCA P10 validation lacks an eligibility ledger");
    }
    const results = new Set<string>();
    for (const candidate of registry.candidates) {
      const resultRef = this.findScaP10ValidationResult(context, candidate.candidate_id);
      if (resultRef === undefined) continue;
      const result = exactJson(
        this.store,
        resultRef,
        "rule validation result",
        validateScaP10RuleValidationAdapterResultV1
      );
      if (result.candidate_id !== candidate.candidate_id) {
        throw new Error("SCA P10 validation result candidate binding mismatch");
      }
      results.add(candidate.candidate_id);
    }
    const next = registry.candidates.find((candidate) => !results.has(candidate.candidate_id));
    if (next !== undefined) return this.issueValidation(context, admitted, next);
    return this.finalize(
      context,
      admitted,
      state.admission_ref,
      state.eligibility_ledger_ref,
      "derive"
    );
  }

  private issueValidation(
    context: RunContext,
    admitted: ScaP10AdmissionResultV1,
    candidate: { readonly candidate_id: string; readonly current_revision_ref: ArtifactRef }
  ): Directive {
    const registrationSha256 = context.registrationContractBinding?.registration_sha256;
    if (registrationSha256 === undefined) {
      throw new Error("SCA P10 lacks a runtime registration binding");
    }
    const revision = exactJson(
      this.store,
      candidate.current_revision_ref,
      "candidate revision",
      validateScaP10RuleCandidateRevisionV1
    );
    const fixtures = exactJson(
      this.store,
      revision.fixture_manifest_ref,
      "fixture manifest",
      validateScaP10RuleTestFixturesV1
    );
    const runtime =
      this.binding.rule_validation_runtime === undefined
        ? {
            state: "unavailable" as const,
            executable: null,
            executable_sha256: null,
            fixed_arguments: [] as string[],
            tool_version: null,
            unavailable_reason: "missing_runtime" as const,
          }
        : scaP10RuleValidationRuntimeV1(this.binding.rule_validation_runtime);
    const request = validateScaP10RuleValidationRequestV1(
      withP10Digest(
        {
          schema_id: SCA_P10_RULE_VALIDATION_REQUEST_SCHEMA,
          schema_version: 1 as const,
          run_id: admitted.admission.run_id,
          candidate_id: candidate.candidate_id,
          rule_revision_ref: candidate.current_revision_ref,
          rule_revision_sha256: candidate.current_revision_ref.content_digest,
          rule_id: revision.rule_id,
          rule_language: revision.rule_language,
          rule_content_base64: revision.rule_content_base64,
          rule_sha256: revision.rule_sha256,
          fixture_directory: fixtures.fixture_directory,
          fixtures: fixtures.cases.map((entry) => ({
            case_class: entry.case_class,
            file_name: entry.file_name,
            fixture_ref: entry.fixture_ref,
            expected_outcome: entry.expected_outcome,
          })),
          runtime,
          performance_bound_ms: 600_000,
          timeout_ms: 600_000,
          max_output_bytes: 1024 * 1024,
        },
        "request_sha256"
      )
    );
    const requestRef = persistJson({
      store: this.store,
      context,
      runId: admitted.admission.run_id,
      phase: P10_PHASE,
      kind: SCA_P10_RULE_VALIDATION_REQUEST_KIND,
      operationId: `sca-p10-rule-validation-request-${candidate.candidate_id}`,
      schemaId: SCA_P10_RULE_VALIDATION_REQUEST_SCHEMA,
      value: request,
      upstreamRefs: [candidate.current_revision_ref, revision.fixture_manifest_ref],
      select: false,
    });
    const declaration = this.binding.declaration ?? SCA_P10_RULE_VALIDATION_DECLARATION;
    const backendKeySha256 = this.binding.backend_key_sha256 ?? DEFAULT_P10_BACKEND_KEY_SHA256;
    const directive = validateDirective({
      schema_version: 2,
      host_operation_schema_version: 1,
      action: "invoke_host_operation",
      identity: context.identity,
      state_id: SCA_P10_VALIDATING_STATE,
      attempt: context.stepCount,
      operation_id: `sca-p10-rule-validation-${candidate.candidate_id}`,
      operation_kind: declaration.operation_kind,
      registration_sha256: registrationSha256,
      request_ref: requestRef,
      request_sha256: requestRef.content_digest,
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "rule_revision", ref: candidate.current_revision_ref },
          { slot: "fixture_manifest", ref: revision.fixture_manifest_ref },
        ],
      },
      expected_result: declaration.result,
      policy_binding: hostOperationPolicyBinding(declaration, backendKeySha256),
    });
    context.pendingDirective = directive;
    return directive;
  }

  private finalizeFromState(context: RunContext): Directive {
    const state = data(context);
    const admitted = this.readmitFromState(context);
    if (admitted.non_learnable) {
      return this.finalizeNonPositive(
        context,
        admitted.non_learnable_reason ?? "p10_non_learnable_p09_checkpoint"
      );
    }
    if (state.eligibility_ledger_ref === undefined) {
      throw new Error("SCA P10 finalization lacks an eligibility ledger");
    }
    return this.finalize(
      context,
      admitted,
      state.admission_ref,
      state.eligibility_ledger_ref,
      "derive"
    );
  }

  /**
   * Build one honest validation entry per registered candidate. A candidate whose host validation
   * result is absent receives an explicit required-but-unrun entry (all eight case classes unrun),
   * so a mixed validated/quarantined/unrun manifest always accounts for every candidate exactly
   * once and never disguises an unrun required validation as a completed one.
   */
  private collectValidationEntries(
    context: RunContext,
    registry: ReturnType<typeof validateScaP10RuleCandidateRegistryV1> | null
  ): {
    readonly entries: ScaP10ValidationEntryV1[];
    readonly real_result_candidate_ids: ReadonlySet<string>;
  } {
    const entries: ScaP10ValidationEntryV1[] = [];
    const realResultCandidateIds = new Set<string>();
    if (registry === null) return { entries, real_result_candidate_ids: realResultCandidateIds };
    for (const candidate of registry.candidates) {
      const requestRef = findScaP10ValidationRequest(
        this.store,
        context.identity.run_id,
        candidate.candidate_id
      );
      const resultRef = this.findScaP10ValidationResult(context, candidate.candidate_id);
      const disposition = this.journal
        ?.hostOperationCallsForRun(context.identity.run_id)
        .find(
          (record) =>
            record.state_id === SCA_P10_VALIDATING_STATE &&
            record.operation_id === `sca-p10-rule-validation-${candidate.candidate_id}` &&
            record.request_ref.artifact_id === requestRef?.artifact_id &&
            record.operation_result_ref?.artifact_id === resultRef?.artifact_id
        )?.disposition;
      if (requestRef !== null && resultRef !== undefined && disposition?.outcome === "completed") {
        const request = validateScaP10RuleValidationRequestV1(
          exactJson(
            this.store,
            requestRef,
            "rule validation request",
            validateScaP10RuleValidationRequestV1
          )
        );
        const result = validateScaP10RuleValidationAdapterResultV1(
          exactJson(
            this.store,
            resultRef,
            "rule validation result",
            validateScaP10RuleValidationAdapterResultV1
          )
        );
        entries.push(deriveScaP10ValidationEntry({ request, result }));
        realResultCandidateIds.add(candidate.candidate_id);
        continue;
      }
      entries.push({
        candidate_id: candidate.candidate_id,
        rule_revision_ref: candidate.current_revision_ref,
        rule_revision_sha256: candidate.current_revision_ref.content_digest,
        validate: {
          invocation_sha256: null,
          invocation_json: null,
          process_result_json: null,
          executable_sha256: null,
          exit_status: null,
          raw_result_sha256: null,
          status: "failed" as const,
        },
        test: {
          collection: null,
          // No request means no declared bound; never synthesize a measurement or legacy PASS.
          performance:
            requestRef === null
              ? null
              : {
                  clock: "host_monotonic" as const,
                  scope: "complete_test_collection" as const,
                  elapsed_ms: null,
                  bound_ms: exactJson(
                    this.store,
                    requestRef,
                    "rule validation request",
                    validateScaP10RuleValidationRequestV1
                  ).performance_bound_ms,
                },
          invocation_sha256: null,
          exit_status: null,
          raw_result_sha256: null,
          status: "failed" as const,
        },
        cases: SCA_P10_VALIDATION_CASE_CLASSES.map((caseClass) => ({
          case_class: caseClass,
          expected_outcome: SCA_P10_EXPECTED_CASE_OUTCOME[caseClass],
          observed_outcome: null,
          status: "unrun" as const,
        })),
        required_unrun_case_classes: [...SCA_P10_VALIDATION_CASE_CLASSES],
        manifest_complete: false,
        blocker_codes: uniqueStrings([
          "p10_required_validation_unrun",
          ...(disposition?.reason_code ? [disposition.reason_code] : []),
        ]),
      });
    }
    return { entries, real_result_candidate_ids: realResultCandidateIds };
  }

  private finalize(
    context: RunContext,
    admitted: ScaP10AdmissionResultV1,
    admissionRef: ArtifactRef,
    eligibilityRef: ArtifactRef,
    mode: "no_rule" | "blocked_learning" | "derive",
    extraBlockers: readonly string[] = []
  ): Directive {
    const runId = context.identity.run_id;
    const eligibility = validateScaP10EligibilityLedgerV1(
      exactJson(this.store, eligibilityRef, "eligibility ledger", validateScaP10EligibilityLedgerV1)
    );
    const registryRef = latestSelected(context, (ref) => ref.kind === REGISTRY_KIND);
    const registry =
      registryRef === undefined
        ? null
        : exactJson(
            this.store,
            registryRef,
            "candidate registry",
            validateScaP10RuleCandidateRegistryV1
          );
    const baseline = admitted.baseline;
    const { entries, real_result_candidate_ids: realResultCandidateIds } =
      this.collectValidationEntries(context, registry);
    const manifest =
      registry === null ? null : buildScaP10ValidationManifest({ run_id: runId, entries });
    const manifestRef =
      manifest === null
        ? null
        : persistJson({
            store: this.store,
            context,
            runId,
            phase: P10_PHASE,
            kind: MANIFEST_KIND,
            operationId: "sca-p10-rule-validation-results",
            schemaId: SCA_P10_RULE_VALIDATION_RESULTS_SCHEMA,
            value: manifest,
            upstreamRefs:
              registry === null ? [] : registry.candidates.map((c) => c.current_revision_ref),
          });

    const validated = entries.filter((entry) => entry.manifest_complete);
    const blockedEntries = entries.filter((entry) => entry.required_unrun_case_classes.length > 0);
    const quarantinedEntries = entries.filter(
      (entry) => !entry.manifest_complete && entry.required_unrun_case_classes.length === 0
    );
    const overfittingOrSuppressed = entries.some((entry) =>
      entry.cases.some(
        (item) =>
          item.status === "failed" &&
          (item.case_class === "generalized" ||
            item.case_class === "retained_vulnerable" ||
            item.case_class === "held_out")
      )
    );

    let disposition: ScaP10LearningDispositionV1;
    let reasonCode: string;
    if (mode === "no_rule") {
      disposition = "no_rule";
      reasonCode = "p10_no_eligible_finding_or_infeasible_rule";
    } else if (mode === "blocked_learning") {
      disposition = "blocked_learning";
      reasonCode = extraBlockers[0] ?? "p10_disclosure_denied";
    } else if (blockedEntries.length > 0) {
      // Any required-but-unrun (or run-and-failed) validation makes the whole assessment blocked;
      // a mixed validated/unrun manifest is never reported as a validated success.
      disposition = "blocked_learning";
      reasonCode = "p10_required_validation_unrun";
    } else if (validated.length > 0) {
      disposition = "validated_candidate";
      reasonCode = "p10_validated_candidate";
    } else if (quarantinedEntries.length > 0) {
      disposition = "quarantined_candidate";
      reasonCode = "p10_candidate_quarantined";
    } else {
      disposition = "blocked_learning";
      reasonCode = "p10_required_validation_unrun";
    }

    const quarantineRecordsRef = this.persistQuarantine(
      context,
      admissionRef,
      quarantinedEntries,
      blockedEntries
    );
    const decisions = this.derivePromotion(
      context,
      admitted,
      registry,
      validated,
      quarantinedEntries,
      blockedEntries,
      disposition === "validated_candidate"
    );

    const blockers = uniqueStrings([
      ...extraBlockers,
      ...entries.flatMap((entry) => entry.blocker_codes),
      ...(disposition === "blocked_learning" ? [reasonCode] : []),
    ]);

    const outcome = validateScaP10RuleLearningOutcomeV1(
      withP10Digest(
        {
          schema_id: SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA,
          schema_version: 1 as const,
          phase_id: P10_PHASE,
          run_id: runId,
          disposition,
          reason_code: reasonCode,
          lane: eligibility.lane,
          eligibility_ledger_ref: eligibilityRef,
          candidate_registry_ref: registryRef ?? null,
          validation_manifest_ref: manifestRef,
          quarantine_records_ref: quarantineRecordsRef,
          promotion_decisions_ref: decisions.decisionsRef,
          eligible_refs: [...admitted.eligible_refs],
          ineligible_refs: [...admitted.ineligible_refs],
          unresolved_item_refs: [...admitted.unresolved_item_refs],
          candidate_count: registry?.candidate_count ?? 0,
          validated_candidate_count: validated.length,
          quarantined_candidate_count: quarantinedEntries.length,
          blocked_candidate_count: blockedEntries.length,
          false_negative_count: eligibility.false_negative_count,
          baseline_hit_count: eligibility.baseline_hit_count,
          coverage_gap_count: eligibility.coverage_gap_count,
          missing_downstream_artifacts: [...SCA_P10_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: [...SCA_P10_DOWNSTREAM_OBLIGATION_IDS],
          blocker_codes: blockers,
          non_positive: true as const,
        },
        "outcome_sha256"
      )
    );
    const eligibilityRevision = eligibility.eligibility_ledger_revision;
    const outcomeRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P10_PHASE,
      kind: OUTCOME_KIND,
      operationId:
        eligibilityRevision === 1
          ? "sca-p10-rule-learning-outcome"
          : `sca-p10-rule-learning-outcome-revision-${String(eligibilityRevision).padStart(6, "0")}`,
      schemaId: SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA,
      value: outcome,
      upstreamRefs: [
        eligibilityRef,
        admissionRef,
        ...(eligibility.prior_eligibility_ledger_ref === null
          ? []
          : [eligibility.prior_eligibility_ledger_ref]),
      ],
    });

    // --- Derived gate facts (never hardcoded literals) -----------------------------------------
    const tryRevision = (ref: ArtifactRef) => {
      try {
        return exactJson(
          this.store,
          ref,
          "candidate revision",
          validateScaP10RuleCandidateRevisionV1
        );
      } catch {
        return null;
      }
    };
    const tryFixtureManifest = (ref: ArtifactRef) => {
      try {
        return exactJson(this.store, ref, "fixture manifest", validateScaP10RuleTestFixturesV1);
      } catch {
        return null;
      }
    };
    const expectedRevisionRef = (candidateId: string, revision: number): ArtifactRef | null =>
      this.store.refFor(
        runId,
        P10_PHASE,
        null,
        CANDIDATE_REVISION_KIND,
        `sca-p10-candidate-${candidateId}-revision-${String(revision).padStart(6, "0")}`,
        1
      );

    const establishedItems = eligibility.eligible_items.filter(
      (item) => item.eligible_classification === "established_issue"
    );
    const eligibleEstablishedIds = new Set(establishedItems.map((item) => item.item_id));
    const ineligibleRefIds = new Set(admitted.ineligible_refs.map((ref) => ref.artifact_id));

    const exhaustiveEligibility =
      eligibility.item_count === eligibility.eligible_count + eligibility.ineligible_items.length &&
      eligibility.eligible_count ===
        eligibility.established_issue_count + eligibility.refutation_count &&
      eligibility.set_equality_valid === true;

    const baselineBindingValid =
      baseline !== null &&
      baseline.rule_release_binding_valid &&
      [...baseline.by_language.values()].every(
        (derived) =>
          derived.applicable &&
          derived.analyzer_complete &&
          derived.source_binding_sha256 === baseline.evidence.source_snapshot_sha256
      );

    // A false negative requires an applicable, completed, unchanged baseline per established issue.
    const falseNegativePredicateValid =
      baselineBindingValid &&
      eligibility.coverage_gap_count +
        eligibility.false_negative_count +
        eligibility.baseline_hit_count ===
        establishedItems.length &&
      establishedItems.every(
        (item) =>
          item.baseline_classification !== null &&
          (item.baseline_classification !== "false_negative" || item.baseline_language !== null)
      );

    const noIneligibleLearning =
      eligibility.set_equality_valid === true &&
      eligibility.ineligible_items.every((item) => item.eligibility !== "eligible") &&
      (registry === null ||
        registry.candidates.every((candidate) => {
          const revision = tryRevision(candidate.current_revision_ref);
          return (
            revision !== null &&
            eligibleEstablishedIds.has(revision.established_issue_item_id) &&
            !ineligibleRefIds.has(revision.finding_disposition_revision_ref.artifact_id)
          );
        }));

    const candidateLineageComplete =
      registry === null
        ? true
        : registry.candidates.every((candidate) => {
            const revision = tryRevision(candidate.current_revision_ref);
            if (revision === null || revision.candidate_id !== candidate.candidate_id) return false;
            const fixtureManifest = tryFixtureManifest(revision.fixture_manifest_ref);
            return (
              fixtureManifest !== null && fixtureManifest.candidate_id === candidate.candidate_id
            );
          });

    const validationManifestComplete =
      registry === null
        ? true
        : manifest !== null &&
          manifest.candidates.length === registry.candidate_count &&
          manifest.candidates.every((entry) => entry.manifest_complete);

    const noUnrunRequiredValidationDisguised =
      disposition === "blocked_learning" ||
      entries.every((entry) => entry.required_unrun_case_classes.length === 0);

    const appendOnlyRevisions =
      eligibility.append_only === true &&
      (registry === null || registry.append_only === true) &&
      (registry === null ||
        registry.candidates.every((candidate) => {
          const revision = tryRevision(candidate.current_revision_ref);
          if (revision === null) return false;
          if (candidate.prior_revision_refs.length !== revision.revision - 1) return false;
          return candidate.prior_revision_refs.every((ref, index) => {
            const expected = expectedRevisionRef(candidate.candidate_id, index + 1);
            return expected !== null && ref.artifact_id === expected.artifact_id;
          });
        })) &&
      (eligibility.prior_eligibility_ledger_ref === null) ===
        (eligibility.eligibility_ledger_revision === 1);

    const disclosureRef = data(context).disclosure_ref;
    const modelIdentityAndDisclosureValid =
      disclosureRef === undefined
        ? !context.selectedArtifacts.some((ref) => ref.kind === PROPOSAL_OUTPUT_KIND)
        : (() => {
            const disclosure = exactJson(
              this.store,
              disclosureRef,
              "disclosure admission",
              validateScaP10DisclosureAdmissionV1
            );
            return (
              disclosure.decision === "allow" &&
              disclosure.evaluated_before_dispatch === true &&
              disclosure.run_id === runId &&
              same(disclosure.required_model, SCA_P10_REQUIRED_MODEL)
            );
          })();

    const deterministicValidationHostOwned =
      manifest === null
        ? entries.length === 0
        : manifest.host_owned === true &&
          manifest.model_calls === 0 &&
          manifest.tool_calls === 0 &&
          entries.every(
            (entry) =>
              !realResultCandidateIds.has(entry.candidate_id) ||
              (entry.validate.invocation_sha256 !== null && entry.test.invocation_sha256 !== null)
          );

    const p12OrReleaseClaimsAbsent =
      outcome.non_positive === true &&
      outcome.missing_downstream_artifacts.some((artifact) => artifact.startsWith("penny.sca-p12"));

    const frozenPreserved =
      decisions.futureOnly &&
      admitted.admission.active_run_rule_release_refs.every(
        (ref) => ref.artifact_id !== decisions.promotedSuccessorId
      );

    const immutableP09LineageValid =
      admitted.admission.p09_rederivation_ok &&
      admitted.admission.p09_reconciliation_rederivation_ok;

    const predicates = {
      immutable_p09_lineage_valid: immutableP09LineageValid,
      exhaustive_eligibility: exhaustiveEligibility,
      false_negative_predicate_valid: falseNegativePredicateValid,
      no_ineligible_learning: noIneligibleLearning,
      baseline_binding_valid: baselineBindingValid,
      candidate_lineage_complete: candidateLineageComplete,
      validation_manifest_complete: validationManifestComplete,
      no_unrun_required_validation_disguised: noUnrunRequiredValidationDisguised,
      no_overfitting_no_suppressed_retained: !overfittingOrSuppressed,
      promotion_separately_authorized: decisions.authorityAdmitted || validated.length === 0,
      promotion_future_only: decisions.futureOnly,
      promotion_atomic_immutable: decisions.atomicImmutable,
      no_promotion_without_receipt: decisions.noPromotionWithoutReceipt,
      append_only_revisions: appendOnlyRevisions,
      frozen_active_run_rules_preserved: frozenPreserved,
      rescan_separate_revision: decisions.rescanPersisted,
      downstream_accounting_present: outcome.missing_downstream_artifacts.length > 0,
      model_identity_and_disclosure_valid: modelIdentityAndDisclosureValid,
      deterministic_validation_host_owned: deterministicValidationHostOwned,
      p12_or_release_claims_absent: p12OrReleaseClaimsAbsent,
    };
    const allPredicates = Object.values(predicates).every((value) => value === true);
    const verdict =
      disposition === "blocked_learning"
        ? ("blocked_invalid" as const)
        : (disposition === "validated_candidate" || disposition === "no_rule") &&
            allPredicates &&
            blockers.length === 0
          ? ("pass_ready" as const)
          : ("pass_blocked" as const);

    const gate = validateScaP10GateV1(
      withP10Digest(
        {
          schema_id: SCA_P10_GATE_SCHEMA,
          schema_version: 1 as const,
          phase_id: P10_PHASE,
          criterion_id: "AC-P10" as const,
          verdict,
          learning_outcome_ref: outcomeRef,
          lane: eligibility.lane,
          outcome_disposition: disposition,
          ...predicates,
          eligible_count: eligibility.eligible_count,
          candidate_count: registry?.candidate_count ?? 0,
          validated_candidate_count: validated.length,
          quarantined_candidate_count: quarantinedEntries.length,
          blocked_candidate_count: blockedEntries.length,
          false_negative_count: eligibility.false_negative_count,
          coverage_gap_count: eligibility.coverage_gap_count,
          blocker_codes: blockers,
          evaluated_at: this.trustedClock().toISOString(),
        },
        "gate_sha256"
      )
    );
    const gateRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P10_PHASE,
      kind: GATE_KIND,
      operationId: "sca-p10-gate",
      schemaId: SCA_P10_GATE_SCHEMA,
      value: gate,
      upstreamRefs: [outcomeRef],
    });

    let handoffRef: ArtifactRef | null = null;
    if (verdict !== "blocked_invalid") {
      const handoff = validateScaP10ToP11TransitionV1(
        withP10Digest(
          {
            schema_id: SCA_P10_TO_P11_TRANSITION_SCHEMA,
            schema_version: 1 as const,
            source_phase_id: P10_PHASE,
            target_phase_id: "SCA-P11" as const,
            handoff_kind: "eligible_only_learning_evidence_only" as const,
            qualification_scope: "learning_gate_only_not_p11_reporting" as const,
            phase_gate_passed: false as const,
            p11_reporting_authorized_by_this_transition: false as const,
            release_eligible: false as const,
            campaign_complete: false as const,
            campaign_completion_claimed: false as const,
            p09_terminal_ref: admitted.admission.p09_terminal_ref,
            p09_reconciliation_ledger_ref: requireRef(
              admitted.admission.p09_reconciliation_ledger_ref,
              "P09 reconciliation ledger"
            ),
            p09_gate_ref: requireRef(admitted.admission.p09_gate_ref, "P09 gate"),
            learning_outcome_ref: outcomeRef,
            gate_ref: gateRef,
            candidate_registry_ref: registryRef ?? null,
            quarantine_records_ref: quarantineRecordsRef,
            promotion_decisions_ref: decisions.decisionsRef,
            frozen_rule_release_ref: requireRef(
              baseline?.evidence.frozen_rule_release_ref,
              "frozen rule release"
            ),
            lane: eligibility.lane,
            eligible_refs: [...admitted.eligible_refs],
            ineligible_refs: [...admitted.ineligible_refs],
            unresolved_item_refs: [...admitted.unresolved_item_refs],
            required_gaps_retained: true as const,
          },
          "transition_sha256"
        )
      );
      handoffRef = persistJson({
        store: this.store,
        context,
        runId,
        phase: P10_PHASE,
        kind: HANDOFF_KIND,
        operationId: "sca-p10-to-p11-transition",
        schemaId: SCA_P10_TO_P11_TRANSITION_SCHEMA,
        value: handoff,
        upstreamRefs: [outcomeRef, gateRef],
      });
    }

    const status: ScaP10TerminalV1["status"] =
      verdict === "pass_ready"
        ? "learning_complete"
        : verdict === "pass_blocked"
          ? "learning_incomplete"
          : "blocked_invalid";
    const terminal = validateScaP10TerminalV1(
      withP10Digest(
        {
          schema_id: SCA_P10_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P10_PHASE,
          status,
          lane: eligibility.lane,
          learning_outcome_ref: outcomeRef,
          gate_ref: gateRef,
          p11_transition_ref: handoffRef,
          p11_handoff_ready: handoffRef !== null,
          eligibility_ledger_ref: eligibilityRef,
          promotion_performed: decisions.promotedCandidateIds.length > 0,
          promotion_receipt_ref: decisions.promotedReceiptRef,
          outcome_disposition: disposition,
          eligible_refs: [...admitted.eligible_refs],
          ineligible_refs: [...admitted.ineligible_refs],
          missing_downstream_artifacts: [...SCA_P10_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: uniqueStrings([
            ...SCA_P10_DOWNSTREAM_OBLIGATION_IDS,
            ...decisions.decisionObligationIds,
          ]),
          selected_artifact_refs: uniqueRefs([
            admissionRef,
            eligibilityRef,
            outcomeRef,
            gateRef,
            ...(handoffRef === null ? [] : [handoffRef]),
            ...(registry === null
              ? []
              : registry.candidates.flatMap((candidate) => {
                  const revision = tryRevision(candidate.current_revision_ref);
                  return revision === null
                    ? [candidate.current_revision_ref]
                    : [candidate.current_revision_ref, revision.fixture_manifest_ref];
                })),
            ...this.selectedCoreRefs(context),
          ]).slice(0, 128),
          blocker_codes: blockers,
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          p12_release_authorized: false as const,
          report_or_release_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P10_PHASE,
      kind: TERMINAL_KIND,
      operationId: "sca-p10-terminal",
      schemaId: SCA_P10_TERMINAL_SCHEMA,
      value: terminal,
      upstreamRefs: [outcomeRef, gateRef, ...(handoffRef === null ? [] : [handoffRef])],
    });
    context.status = "incomplete";
    context.met = false;
    const directive = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: terminal,
      artifacts: uniqueRefs([
        admissionRef,
        eligibilityRef,
        outcomeRef,
        gateRef,
        ...(handoffRef === null ? [] : [handoffRef]),
        terminalRef,
        ...this.selectedCoreRefs(context),
      ]).slice(0, 128),
      unresolved: blockers.length > 0 ? blockers : ["p10_learning_remains_separately_adjudicated"],
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private persistQuarantine(
    context: RunContext,
    admissionRef: ArtifactRef,
    quarantined: readonly ScaP10ValidationEntryV1[],
    blocked: readonly ScaP10ValidationEntryV1[]
  ): ArtifactRef {
    const records = [...quarantined, ...blocked].map((entry) => {
      const failed = entry.cases
        .filter((item) => item.status === "failed")
        .map((item) => item.case_class)
        .sort();
      return {
        candidate_id: entry.candidate_id,
        rule_revision_ref: entry.rule_revision_ref,
        reason_code:
          entry.required_unrun_case_classes.length > 0
            ? "p10_required_validation_unrun"
            : "p10_validation_failed",
        failed_case_classes: failed,
        required_unrun_case_classes: [...entry.required_unrun_case_classes],
        lineage_complete: true,
        blocker_codes: [...entry.blocker_codes],
      };
    });
    const value = validateScaP10RuleQuarantineRecordsV1(
      withP10Digest(
        {
          schema_id: SCA_P10_RULE_QUARANTINE_RECORDS_SCHEMA,
          schema_version: 1 as const,
          phase_id: P10_PHASE,
          run_id: context.identity.run_id,
          records,
          record_count: records.length,
        },
        "quarantine_sha256"
      )
    );
    return persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P10_PHASE,
      kind: QUARANTINE_KIND,
      operationId: "sca-p10-rule-quarantine-records",
      schemaId: SCA_P10_RULE_QUARANTINE_RECORDS_SCHEMA,
      value,
      upstreamRefs: [admissionRef],
    });
  }

  private derivePromotion(
    context: RunContext,
    admitted: ScaP10AdmissionResultV1,
    registry: ReturnType<typeof validateScaP10RuleCandidateRegistryV1> | null,
    validated: readonly ScaP10ValidationEntryV1[],
    quarantined: readonly ScaP10ValidationEntryV1[],
    blocked: readonly ScaP10ValidationEntryV1[],
    allowPromotion: boolean
  ): {
    readonly decisionsRef: ArtifactRef | null;
    readonly authorityAdmitted: boolean;
    readonly promotedCandidateIds: readonly string[];
    readonly promotedReceiptRef: ArtifactRef | null;
    readonly promotedSuccessorId: string | null;
    readonly futureOnly: boolean;
    readonly atomicImmutable: boolean;
    readonly noPromotionWithoutReceipt: boolean;
    readonly rescanPersisted: boolean;
    readonly decisionObligationIds: readonly string[];
  } {
    const runId = context.identity.run_id;
    const authority = this.readPromotionAuthority(admitted.admission.promotion_authority_ref);
    const authorityAdmitted =
      authority !== null &&
      authority.decision === "allow" &&
      authority.run_id === runId &&
      authority.blocker_codes.length === 0;

    const decisions: ScaP10PromotionDecisionEntryV1[] = [];
    const promotedCandidateIds: string[] = [];
    let promotedReceiptRef: ArtifactRef | null = null;
    let promotedSuccessorId: string | null = null;
    // Promotion-posture facts derived from the actual promotion receipts, never hardcoded.
    let futureOnly = true;
    let atomicImmutable = true;
    let rescanPersisted = true;
    let promotionAttempted = false;

    const store =
      registry !== null && validated.length > 0 && allowPromotion
        ? new ScaRulePromotionStore({
            backend: createArtifactScaRulePromotionBackendV1({
              store: this.store,
              runId,
              phase: P10_PHASE,
            }),
            store: this.store,
            runId,
            phase: P10_PHASE,
            now: this.trustedClock,
            ...(this.binding.promotionFault === undefined
              ? {}
              : { fault: this.binding.promotionFault }),
          })
        : null;

    for (const entry of validated) {
      const revisionRef = entry.rule_revision_ref;
      const revision = exactJson(
        this.store,
        revisionRef,
        "candidate revision",
        validateScaP10RuleCandidateRevisionV1
      );
      const predecessor = store?.currentHead() ?? null;
      if (store === null || !authorityAdmitted) {
        decisions.push({
          candidate_id: entry.candidate_id,
          rule_revision_ref: revisionRef,
          decision: allowPromotion ? "denied" : "not_attempted",
          predecessor_release_ref: predecessor?.release_ref ?? null,
          predecessor_release_sha256: predecessor?.release_sha256 ?? null,
          successor_release_ref: null,
          successor_release_sha256: null,
          successor_release_revision: null,
          receipt_ref: null,
          blocker_codes: allowPromotion
            ? ["p10_promotion_authority_not_admitted"]
            : ["p10_assessment_blocked_no_promotion"],
        });
        continue;
      }
      promotionAttempted = true;
      const successor = this.persistSuccessorRelease(context, admitted, revision, revisionRef);
      const outcome = store.promote({
        candidate_id: entry.candidate_id,
        promotion_authority_ref: admitted.admission.promotion_authority_ref,
        promotion_authority_admitted: true,
        successor_release_ref: successor.releaseRef,
        bundle_ref: successor.bundleRef,
        expected_predecessor: predecessor,
        active_run_rule_release_refs: admitted.admission.active_run_rule_release_refs,
      });
      if (outcome.outcome === "promoted" && outcome.receipt !== null) {
        promotedCandidateIds.push(entry.candidate_id);
        promotedReceiptRef = outcome.receipt_ref;
        promotedSuccessorId = successor.releaseRef.artifact_id;
        futureOnly = futureOnly && outcome.receipt.future_only === true;
        atomicImmutable =
          atomicImmutable && outcome.receipt.atomic === true && outcome.receipt.immutable === true;
        decisions.push({
          candidate_id: entry.candidate_id,
          rule_revision_ref: revisionRef,
          decision: "promoted",
          predecessor_release_ref: outcome.receipt.predecessor_release_ref,
          predecessor_release_sha256: outcome.receipt.predecessor_release_sha256,
          successor_release_ref: successor.releaseRef,
          successor_release_sha256: successor.releaseRef.content_digest,
          successor_release_revision: outcome.receipt.successor_release_revision,
          receipt_ref: outcome.receipt_ref,
          blocker_codes: [],
        });
        const rescan = validateScaP10RescanDirectiveV1(
          withP10Digest(
            {
              schema_id: SCA_P10_RESCAN_DIRECTIVE_SCHEMA,
              schema_version: 1 as const,
              phase_id: P10_PHASE,
              run_id: runId,
              promotion_receipt_ref: requireRef(outcome.receipt_ref, "promotion receipt"),
              successor_release_ref: successor.releaseRef,
              successor_release_sha256: successor.releaseRef.content_digest,
              source_snapshot_ref: requireRef(
                admitted.baseline?.evidence.source_snapshot_ref,
                "source snapshot"
              ),
              source_snapshot_sha256: requireString(
                admitted.baseline?.evidence.source_snapshot_sha256,
                "source snapshot digest"
              ),
              retained_baseline_ref: requireRef(
                admitted.baseline?.evidence_ref,
                "retained baseline"
              ),
              rescan_revision: 1,
              reenters_investigation_at: "SCA-P04" as const,
              executed: false as const,
            },
            "directive_sha256"
          )
        );
        persistJson({
          store: this.store,
          context,
          runId,
          phase: P10_PHASE,
          kind: RESCAN_KIND,
          operationId: `sca-p10-rescan-directive-${entry.candidate_id}`,
          schemaId: SCA_P10_RESCAN_DIRECTIVE_SCHEMA,
          value: rescan,
          upstreamRefs: [
            requireRef(outcome.receipt_ref, "promotion receipt"),
            successor.releaseRef,
          ],
          select: false,
        });
        rescanPersisted =
          rescanPersisted &&
          rescan.executed === false &&
          same(rescan.promotion_receipt_ref, outcome.receipt_ref);
      } else {
        decisions.push({
          candidate_id: entry.candidate_id,
          rule_revision_ref: revisionRef,
          decision: outcome.outcome === "unavailable" ? "unavailable" : "denied",
          predecessor_release_ref: predecessor?.release_ref ?? null,
          predecessor_release_sha256: predecessor?.release_sha256 ?? null,
          successor_release_ref: null,
          successor_release_sha256: null,
          successor_release_revision: null,
          receipt_ref: null,
          blocker_codes: [...outcome.blocker_codes],
        });
      }
    }
    for (const entry of [...quarantined, ...blocked]) {
      decisions.push({
        candidate_id: entry.candidate_id,
        rule_revision_ref: entry.rule_revision_ref,
        decision: "not_attempted",
        predecessor_release_ref: null,
        predecessor_release_sha256: null,
        successor_release_ref: null,
        successor_release_sha256: null,
        successor_release_revision: null,
        receipt_ref: null,
        blocker_codes:
          entry.required_unrun_case_classes.length > 0
            ? ["p10_required_validation_unrun"]
            : ["p10_validation_failed"],
      });
    }
    if (registry !== null && decisions.length > 0) {
      const value = validateScaP10RulePromotionDecisionsV1(
        withP10Digest(
          {
            schema_id: SCA_P10_RULE_PROMOTION_DECISIONS_SCHEMA,
            schema_version: 1 as const,
            phase_id: P10_PHASE,
            run_id: runId,
            promotion_authority_ref: admitted.admission.promotion_authority_ref,
            promotion_authority_admitted: authorityAdmitted,
            policy_default: "deny" as const,
            promotion_attempted: promotionAttempted,
            decisions: [...decisions].sort((left, right) =>
              left.candidate_id < right.candidate_id ? -1 : 1
            ),
            decision_count: decisions.length,
          },
          "decisions_sha256"
        )
      );
      const decisionsRef = persistJson({
        store: this.store,
        context,
        runId,
        phase: P10_PHASE,
        kind: DECISIONS_KIND,
        operationId: "sca-p10-rule-promotion-decisions",
        schemaId: SCA_P10_RULE_PROMOTION_DECISIONS_SCHEMA,
        value,
        upstreamRefs: registry.candidates.map((candidate) => candidate.current_revision_ref),
      });
      return {
        decisionsRef,
        authorityAdmitted,
        promotedCandidateIds,
        promotedReceiptRef,
        promotedSuccessorId,
        futureOnly,
        atomicImmutable,
        noPromotionWithoutReceipt: decisions.every(
          (entry) => (entry.decision === "promoted") === (entry.receipt_ref !== null)
        ),
        rescanPersisted,
        decisionObligationIds:
          promotedCandidateIds.length > 0 ? ["SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY"] : [],
      };
    }
    return {
      decisionsRef: null,
      authorityAdmitted,
      promotedCandidateIds,
      promotedReceiptRef,
      promotedSuccessorId,
      futureOnly,
      atomicImmutable,
      noPromotionWithoutReceipt: true,
      rescanPersisted,
      decisionObligationIds: [],
    };
  }

  private persistSuccessorRelease(
    context: RunContext,
    admitted: ScaP10AdmissionResultV1,
    revision: ReturnType<typeof validateScaP10RuleCandidateRevisionV1>,
    revisionRef: ArtifactRef
  ): { readonly releaseRef: ArtifactRef; readonly bundleRef: ArtifactRef } {
    const suffix = revision.rule_sha256.slice(0, 24);
    const releaseId = `sca-p10-rule-release-${suffix}`;
    const bundle = validateScaP01RuleBundleV1({
      schema_id: SCA_P01_RULE_BUNDLE_V1_SCHEMA,
      schema_version: 1,
      bundle_id: `${releaseId}-bundle`,
      release_id: releaseId,
      immutable: true,
      rules: [
        {
          rule_id: revision.rule_id,
          language: revision.rule_language,
          encoding: "base64",
          content_base64: revision.rule_content_base64,
          content_sha256: revision.rule_sha256,
        },
      ],
    });
    const bundleRef = persistJson({
      store: this.store,
      context,
      runId: admitted.admission.run_id,
      phase: P10_PHASE,
      kind: "sca-p01-rule-bundle",
      operationId: `sca-p10-rule-bundle-${suffix}`,
      schemaId: SCA_P01_RULE_BUNDLE_V1_SCHEMA,
      value: bundle,
      upstreamRefs: [revisionRef],
      select: false,
    });
    const release = validateScaRuleReleaseV1({
      schema_id: SCA_RULE_RELEASE_V1_SCHEMA,
      schema_version: 1,
      release_id: releaseId,
      trust_status: "host-declared",
      status: "approved",
      immutable: true,
      languages: [revision.rule_language],
      rule_count: 1,
      rule_bundle_ref: bundleRef,
      rules_sha256: bundleRef.content_digest,
    });
    const releaseRef = persistJson({
      store: this.store,
      context,
      runId: admitted.admission.run_id,
      phase: P10_PHASE,
      kind: "sca-rule-release",
      operationId: `sca-p10-rule-release-${suffix}`,
      schemaId: SCA_RULE_RELEASE_V1_SCHEMA,
      value: release,
      upstreamRefs: [bundleRef, revisionRef],
      select: false,
    });
    return { releaseRef, bundleRef };
  }

  private readPromotionAuthority(ref: ArtifactRef) {
    try {
      return exactJson(this.store, ref, "promotion authority", validateScaP10PromotionAuthorityV1);
    } catch {
      return null;
    }
  }

  private finalizeNonPositive(context: RunContext, blocker: string): Directive {
    const runId = context.identity.run_id;
    const terminal = validateScaP10TerminalV1(
      withP10Digest(
        {
          schema_id: SCA_P10_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P10_PHASE,
          status: "learning_incomplete" as const,
          learning_outcome_ref: null,
          gate_ref: null,
          p11_transition_ref: null,
          p11_handoff_ready: false,
          eligibility_ledger_ref: null,
          promotion_performed: false,
          promotion_receipt_ref: null,
          outcome_disposition: "blocked_learning" as const,
          eligible_refs: [],
          ineligible_refs: [],
          missing_downstream_artifacts: [...SCA_P10_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: [...SCA_P10_DOWNSTREAM_OBLIGATION_IDS],
          selected_artifact_refs: this.selectedCoreRefs(context),
          blocker_codes: [blocker],
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          p12_release_authorized: false as const,
          report_or_release_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P10_PHASE,
      kind: TERMINAL_KIND,
      operationId: "sca-p10-terminal",
      schemaId: SCA_P10_TERMINAL_SCHEMA,
      value: terminal,
      upstreamRefs: this.selectedCoreRefs(context),
    });
    context.status = "incomplete";
    context.met = false;
    const directive = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: terminal,
      artifacts: uniqueRefs([terminalRef, ...this.selectedCoreRefs(context)]).slice(0, 128),
      unresolved: terminal.blocker_codes,
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private selectedCoreRefs(context: RunContext): ArtifactRef[] {
    const kinds = new Set<string>([
      REQUEST_KIND,
      ADMISSION_KIND,
      ELIGIBILITY_KIND,
      PAYLOAD_KIND,
      DISCLOSURE_KIND,
      PROPOSAL_OUTPUT_KIND,
      CANDIDATE_REVISION_KIND,
      FIXTURE_MANIFEST_KIND,
      REGISTRY_KIND,
      MANIFEST_KIND,
      QUARANTINE_KIND,
      DECISIONS_KIND,
      RESCAN_KIND,
      OUTCOME_KIND,
      GATE_KIND,
      HANDOFF_KIND,
      TERMINAL_KIND,
    ]);
    return uniqueRefs(
      context.selectedArtifacts.filter(
        (ref) => ref.run_id === context.identity.run_id && kinds.has(ref.kind)
      )
    ).slice(0, 128);
  }
}

function port(input: {
  readonly name: string;
  readonly kind: string;
  readonly schema: string;
  readonly direction: "input" | "output";
  readonly min?: number;
  readonly max?: number;
}) {
  return {
    schema_version: 1 as const,
    name: input.name,
    direction: input.direction,
    transport: "artifact" as const,
    schema_id: input.schema,
    schema_version_required: 1 as const,
    artifact_kind: input.kind,
    source: input.direction === "input" ? ("caller" as const) : ("skill" as const),
    min_items: input.min ?? 1,
    max_items: input.max ?? 1,
    semantic_product: input.direction === "output",
  };
}

export const SCA_P10_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Consume the exact recorded P09 reconciliation result in either reconciled lane, derive eligible-only false-negative classification from exact baseline evidence, perform one bounded DeepSeek candidate proposal, validate candidates through a deterministic host-owned Semgrep validate/test manifest, record a separately authorized future-only promotion decision and a separate rescan revision, and emit a derived readiness gate, a non-authorizing P11 handoff, and durable non-positive terminal accounting.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: SCA_P10_CANDIDATE_START_SCHEMA,
      schema_version_required: 1,
      artifact_kind: null,
      source: "caller",
      min_items: 1,
      max_items: 1,
      semantic_product: false,
    },
    input_ports: [],
    active_output_ports: [
      port({
        name: "p10_admission",
        kind: ADMISSION_KIND,
        schema: SCA_P10_ADMISSION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p10_eligibility_ledger",
        kind: ELIGIBILITY_KIND,
        schema: SCA_P10_ELIGIBILITY_LEDGER_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p10_rule_candidate_registry",
        kind: REGISTRY_KIND,
        schema: SCA_P10_RULE_CANDIDATE_REGISTRY_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p10_rule_validation_manifest",
        kind: MANIFEST_KIND,
        schema: SCA_P10_RULE_VALIDATION_RESULTS_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p10_rule_learning_outcome",
        kind: OUTCOME_KIND,
        schema: SCA_P10_RULE_LEARNING_OUTCOME_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p10_gate",
        kind: GATE_KIND,
        schema: SCA_P10_GATE_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p10_to_p11_transition",
        kind: HANDOFF_KIND,
        schema: SCA_P10_TO_P11_TRANSITION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p10_terminal",
        kind: TERMINAL_KIND,
        schema: SCA_P10_TERMINAL_SCHEMA,
        direction: "output",
        min: 0,
      }),
    ],
  },
  behavior: {
    side_effects: {
      external_reads: "host_policy_only",
      external_mutations: "forbidden",
      filesystem_writes: "host_policy_only",
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
  guidance: { skill_root: "apps/orchestration/src/sca", resolution: "per_agent_phase" },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.sca-p10-candidate-budget.v1",
    resolver_id: "scaP10CandidateDeterministicResolver",
    admission_id: "scaP10CandidateAdmission",
    snapshot_id: "scaP10CandidateSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [SCA_P10_FINAL_STATE],
    required_visited_states: [SCA_P10_FINAL_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: SCA_P10_TERMINAL_SCHEMA,
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

const START_ADMISSION: StartAdmissionV1 = {
  schema_id: SCA_P10_CANDIDATE_START_SCHEMA,
  schema_version: 1,
  prepare(request: StartRequest): PreparedStartV1 {
    const constraints = validateScaP10CandidateStart(request.constraints);
    if (request.identity.playbook !== SCA_P10_CANDIDATE_PLAYBOOK_NAME) {
      throw new Error("SCA P10 start identity is invalid");
    }
    if (constraints.run_id !== request.identity.run_id) {
      throw new Error("SCA P10 start run identity is invalid");
    }
    const inputs: InputArtifacts | undefined = request.input_artifacts;
    const expected = buildExpectedInputs(constraints);
    if (
      inputs === undefined ||
      inputs.artifacts.length !== expected.length ||
      expected.some(
        (entry, index) =>
          inputs.artifacts[index]?.slot !== entry.slot ||
          !same(inputs.artifacts[index]?.ref, entry.ref)
      )
    ) {
      throw new Error("SCA P10 start inputs do not equal the declared exact lineage refs");
    }
    return {
      schema_id: SCA_P10_CANDIDATE_START_SCHEMA,
      schema_version: 1,
      request,
      goal: request.goal,
      constraints,
      input_artifacts: inputs,
      admission_data: constraints,
    };
  },
  materialize(prepared, host) {
    if (host.artifactStore === undefined || prepared.input_artifacts === undefined) {
      throw new Error("SCA P10 materialization requires artifact store and exact inputs");
    }
    const constraints = validateScaP10CandidateStart(prepared.constraints);
    const requestRef = persistJson({
      store: host.artifactStore,
      runId: host.run_id,
      phase: P10_PHASE,
      kind: REQUEST_KIND,
      operationId: "sca-p10-candidate-request",
      schemaId: SCA_P10_CANDIDATE_START_SCHEMA,
      value: constraints,
      upstreamRefs: buildExpectedInputs(constraints).map((entry) => entry.ref),
    });
    return [requestRef];
  },
};

function buildExpectedInputs(
  constraints: ScaP10CandidateStartV1
): { readonly slot: string; readonly ref: ArtifactRef }[] {
  const optional = (
    slot: string,
    ref: ArtifactRef | null | undefined
  ): { slot: string; ref: ArtifactRef }[] =>
    ref === null || ref === undefined ? [] : [{ slot, ref }];
  return [
    { slot: "p09_terminal", ref: constraints.p09_terminal_ref },
    ...optional("p09_transition", constraints.p09_transition_ref),
    ...optional("p09_reconciliation_ledger", constraints.p09_reconciliation_ledger_ref),
    ...optional("p09_gate", constraints.p09_gate_ref),
    ...optional("p09_admission", constraints.p09_admission_ref),
    { slot: "p08_terminal", ref: constraints.p08_terminal_ref },
    ...optional("p08_transition", constraints.p08_transition_ref),
    ...optional("p08_evidence_ledger", constraints.p08_evidence_ledger_ref),
    ...optional("p08_gate", constraints.p08_gate_ref),
    ...optional("p08_admission", constraints.p08_admission_ref),
    ...optional("p08_item_universe", constraints.p08_item_universe_ref),
    { slot: "p01_obligation_ledger", ref: constraints.p01_obligation_ledger_ref },
    ...optional("p09_coverage_input", constraints.p09_coverage_input_ref),
    ...constraints.p09_phase_evidence_refs.map((ref, index) => ({
      slot: `p09_phase_evidence_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...optional("p09_obligation_resolution", constraints.p09_obligation_resolution_ref),
    ...optional("p09_reassessment", constraints.p09_reassessment_ref),
    { slot: "baseline_evidence", ref: constraints.baseline_evidence_ref },
    { slot: "disclosure_scope", ref: constraints.disclosure_scope_ref },
    { slot: "promotion_authority", ref: constraints.promotion_authority_ref },
    ...constraints.active_run_rule_release_refs.map((ref, index) => ({
      slot: `active_run_rule_release_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...optional("p10_reassessment", constraints.p10_reassessment_ref),
    ...optional("p10_prior_ledger", constraints.p10_prior_ledger_ref),
  ];
}

function buildScaP10CandidateRegistration(binding: ScaP10CandidateBindingV1): PlaybookRegistration {
  const registration: PlaybookRegistration = {
    name: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
    contract: SCA_P10_CANDIDATE_SKILL_CONTRACT,
    ingress: "skill" as const,
    start_admission: START_ADMISSION,
    caller_documentation: {
      constraints_schema: ScaP10CandidateStartV1Schema,
      example: {
        goal: "Run the inactive P10 post-disposition rule-learning candidate.",
        constraints: {
          p09_terminal_ref: {},
          p09_transition_ref: null,
          p09_reconciliation_ledger_ref: null,
          p09_gate_ref: null,
          p09_admission_ref: null,
          p08_terminal_ref: {},
          p01_obligation_ledger_ref: {},
          baseline_evidence_ref: {},
          disclosure_scope_ref: {},
          promotion_authority_ref: {},
        },
      },
      semantic_caveat:
        "P10 learns candidate rules from eligible reconciled evidence only. It does not re-disposition, re-gather evidence, re-reconcile coverage, report, release, or complete a campaign, and it never claims public success.",
    },
    liveness: {
      resolver_id: SCA_P10_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
      resolve: () =>
        ordinaryLivenessPolicy({ scope: "sca-p10-candidate", preset: "deterministic-host" }),
      thinking_policy: "agent_ssot" as const,
    },
    worker: {
      kind: "catalog-agent" as const,
      workflow_name: SCA_P10_CANDIDATE_PLAYBOOK_NAME,
      guidance: SCA_P10_CANDIDATE_SKILL_CONTRACT.guidance,
      guidance_required: true as const,
      result_transport: "persisted_summary" as const,
      opening_policy: "registration_guidance_task_artifacts" as const,
      model_policy: "directive_override_or_runtime_default" as const,
      phases: new Map([
        [
          SCA_P10_PROPOSING_STATE,
          {
            agent: SCA_P10_PROPOSER_AGENT,
            result_schema_id: SCA_P10_RULE_CANDIDATE_PROPOSAL_SCHEMA,
            result_schema_version: 1 as const,
            schema: ScaP10RuleCandidateProposalV1Schema,
            allowed_tools: SCA_P10_REQUIRED_TOOL_SUBSET,
            required_model: SCA_P10_REQUIRED_MODEL,
            provider_opening_guard: SCA_P10_PROVIDER_OPENING_GUARD,
          },
        ],
      ]),
    },
    host_states: [SCA_P10_CLASSIFYING_STATE, SCA_P10_VALIDATING_STATE, SCA_P10_FINAL_STATE],
    host_operations: {
      schema_version: 1,
      max_active_per_run: 1,
      declarations: [SCA_P10_RULE_VALIDATION_DECLARATION],
    },
    completionReceiptPredicates: new Map(),
    construct: (options) => {
      if (options.artifactStore === undefined) {
        throw new Error("SCA P10 candidate requires the artifact host store");
      }
      return new ScaP10CandidatePlaybook(
        options.artifactStore,
        binding,
        options.trustedClock ?? (() => new Date()),
        options.checkpointer
      );
    },
  };
  return Object.freeze(registration);
}

/** Production composition factory requiring independent P07/P01 authority resolvers. */
export function createScaP10CandidateRegistrationV1(input: {
  readonly resolve_current_p07_authority_ref: (scope: {
    readonly tenant_id: string;
    readonly project_id: string;
    readonly run_id: string;
    readonly transition_ref: ArtifactRef;
  }) => ArtifactRef;
  readonly resolve_current_p01_obligation_head_ref: (scope: {
    readonly tenant_id: string;
    readonly project_id: string;
    readonly run_id: string;
  }) => ArtifactRef;
}): PlaybookRegistration {
  if (typeof input.resolve_current_p07_authority_ref !== "function") {
    throw new Error("SCA P10 candidate requires an independent current P07 authority resolver");
  }
  if (typeof input.resolve_current_p01_obligation_head_ref !== "function") {
    throw new Error("SCA P10 candidate requires an independent P01 obligation-head resolver");
  }
  return buildScaP10CandidateRegistration({
    resolve_current_p07_authority_ref: input.resolve_current_p07_authority_ref,
    resolve_current_p01_obligation_head_ref: input.resolve_current_p01_obligation_head_ref,
  });
}

/** Fixed provider-free compatibility fixture used by focused tests. */
export const SCA_P10_CANDIDATE_REGISTRATION: PlaybookRegistration =
  buildScaP10CandidateRegistration({});

export function buildScaP10CandidateRegistrationWithBindingV1(
  binding: ScaP10CandidateBindingV1
): PlaybookRegistration {
  return buildScaP10CandidateRegistration(binding);
}
