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
import type { Playbook } from "../playbooks/playbook.js";
import type {
  PlaybookRegistration,
  PreparedStartV1,
  StartAdmissionV1,
} from "../playbooks/registry.js";
import type { ScaP07CurrentAuthorityScopeV1 } from "./p07-admission.js";
import type { ScaP09CurrentObligationHeadScopeV1 } from "./p09-admission.js";
import { OpaqueIdSchema } from "../skill-contracts/common.js";
import { effectiveScaObligations } from "./p01-contracts.js";
import { scaP11HasSensitiveContent } from "./p11-redaction.js";
import { validateScaP08DispositionRevisionV1 } from "./p08-contracts.js";
import { admitScaP11Reporting, type ScaP11AdmissionResultV1 } from "./p11-admission.js";
import {
  SCA_P11_ACCEPTANCE_OBLIGATION_ID,
  SCA_P11_ADMISSION_SCHEMA,
  SCA_P11_CANDIDATE_PLAYBOOK_NAME,
  SCA_P11_CANDIDATE_START_SCHEMA,
  SCA_P11_CANCELLED_STATE,
  SCA_P11_CHECKSUM_SCHEMA,
  SCA_P11_COGNITIVE_PAYLOAD_SCHEMA,
  SCA_P11_DISCLOSURE_ADMISSION_SCHEMA,
  SCA_P11_DOWNSTREAM_OBLIGATION_IDS,
  SCA_P11_FINALIZING_STATE,
  SCA_P11_GATE_SCHEMA,
  SCA_P11_MISSING_DOWNSTREAM_ARTIFACTS,
  SCA_P11_OBLIGATION_LEDGER_SCHEMA,
  SCA_P11_PROVIDER_OPENING_GUARD,
  SCA_P11_RECONCILIATION_SCHEMA,
  SCA_P11_REPAIRING_STATE,
  SCA_P11_REPAIR_PATCH_SCHEMA,
  SCA_P11_REPAIR_RECORD_SCHEMA,
  SCA_P11_REPORT_JSON_SCHEMA,
  SCA_P11_REPORT_MARKDOWN_SCHEMA,
  SCA_P11_REPORT_SARIF_SCHEMA,
  SCA_P11_REPORT_SCHEMA,
  SCA_P11_REQUIRED_MODEL,
  SCA_P11_REQUIRED_OBLIGATION_IDS,
  SCA_P11_REQUIRED_TOOL_SUBSET,
  SCA_P11_REVIEW_CALL_ID,
  SCA_P11_REVIEW_PURPOSE,
  SCA_P11_REPAIR_CALL_ID,
  SCA_P11_REPAIR_PURPOSE,
  SCA_P11_SUPPORTED_REPORT_STATUSES,
  SCA_P11_REVIEWING_STATE,
  SCA_P11_REVIEWER_AGENT,
  SCA_P11_REVIEWER_IDENTITY_ID,
  SCA_P11_REVIEWER_LINEAGE_ID,
  SCA_P11_SCORING_RECORDS_SCHEMA,
  SCA_P11_SEMANTIC_REVIEW_SCHEMA,
  SCA_P11_TERMINAL_SCHEMA,
  SCA_P11_TO_P12_TRANSITION_SCHEMA,
  SCA_P11_VALIDATION_RECORDS_SCHEMA,
  ScaP11CandidateStartV1Schema,
  ScaP11RepairPatchV1Schema,
  ScaP11SemanticReviewV1Schema,
  scaP11ReportStatusForDisposition,
  validateScaP11AdmissionV1,
  validateScaP11ChecksumManifestV1,
  validateScaP11CognitivePayloadV1,
  validateScaP11DisclosureAdmissionV1,
  validateScaP11DisclosureScopeV1,
  validateScaP11GateV1,
  validateScaP11ObligationLedgerV1,
  validateScaP11ReassessmentV1,
  validateScaP11ReconciliationV1,
  validateScaP11RepairPatchV1,
  validateScaP11ReportJsonV1,
  validateScaP11ReportPolicyV1,
  validateScaP11ReportSarifV1,
  validateScaP11ReportV1,
  validateScaP11ScoringPolicyV1,
  validateScaP11ScoringRecordsV1,
  validateScaP11SemanticReviewV1,
  validateScaP11TerminalV1,
  validateScaP11ToP12TransitionV1,
  validateScaP11ValidationRecordsV1,
  withP11Digest,
  type ScaP11ReassessmentV1,
  type ScaP11ObligationLedgerV1,
  type ScaP11ReconciliationV1,
  type ScaP11ReportJsonV1,
  type ScaP11ReportPolicyV1,
  type ScaP11RepairPatchV1,
  type ScaP11ScoringRecordsV1,
} from "./p11-contracts.js";
import { reconcileScaP11 } from "./p11-reconcile.js";
import {
  buildScaP11ScoringRecordsV1,
  resolveScaP11CvssScorerAuthority,
  type ScaP11CvssScorerAuthorityV1,
} from "./p11-scoring.js";
import {
  buildScaP11ReportSarifV1,
  renderScaP11MarkdownV1,
  renderScaP11ReportJsonV1,
  scaP11FindingId,
  type ScaP11LocationV1,
} from "./p11-render.js";
import { buildScaP11ValidationRecordsV1 } from "./p11-validation.js";
import {
  buildScaP11CognitivePayloadV1,
  buildScaP11DisclosureAdmissionV1,
  buildScaP11RepairRecordV1,
  evaluateScaP11SemanticReview,
} from "./p11-review.js";

const PRODUCER = "host:sca-p11-candidate" as const;
const P11_PHASE = "SCA-P11" as const;
const REQUEST_KIND = "sca-p11-candidate-request" as const;
const ADMISSION_KIND = "sca-p11-admission" as const;
const RECONCILIATION_KIND = "sca-p11-reconciliation" as const;
const SCORING_KIND = "sca-p11-scoring-records" as const;
const REPORT_JSON_KIND = "sca-p11-report-json" as const;
const REPORT_MARKDOWN_KIND = "sca-p11-report-markdown" as const;
const REPORT_SARIF_KIND = "sca-p11-report-sarif" as const;
const VALIDATION_KIND = "sca-p11-validation-records" as const;
const PAYLOAD_KIND = "sca-p11-cognitive-payload" as const;
const DISCLOSURE_KIND = "sca-p11-disclosure-admission" as const;
const REVIEW_OUTPUT_KIND = "sca-p11-semantic-review" as const;
const REPAIR_PATCH_KIND = "sca-p11-repair-patch" as const;
const REPAIR_RECORD_KIND = "sca-p11-repair-record" as const;
const CHECKSUM_KIND = "sca-p11-checksum-manifest" as const;
const OBLIGATION_KIND = "sca-p11-obligation-ledger" as const;
const REPORT_KIND = "sca-p11-report" as const;
const GATE_KIND = "sca-p11-gate" as const;
const HANDOFF_KIND = "sca-p11-to-p12-transition" as const;
const TERMINAL_KIND = "sca-p11-terminal" as const;

export { SCA_P11_CANDIDATE_PLAYBOOK_NAME };

export interface ScaP11CandidateBindingV1 {
  /** Injected exact qualified CVSS v4 scorer authority. Absent in the provider-free fixture. */
  readonly scorer?: ScaP11CvssScorerAuthorityV1;
  /** Admitted bounded repair budget. The provider-free fixture admits none. */
  readonly repair_budget?: number;
  readonly resolve_current_p07_authority_ref?: (
    scope: ScaP07CurrentAuthorityScopeV1
  ) => ArtifactRef;
  readonly resolve_current_p01_obligation_head_ref?: (
    scope: ScaP09CurrentObligationHeadScopeV1
  ) => ArtifactRef;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function uniqueRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const ref of refs) byId.set(ref.artifact_id, ref);
  return [...byId.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id)
  );
}
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
function exactBytes(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined || !same(stored, ref)) {
    throw new Error(`P11 ${label} exact ref is absent or substituted`);
  }
  const bytes = store.readById(ref.artifact_id);
  if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
    throw new Error(`P11 ${label} exact bytes drifted`);
  }
  return bytes;
}
/** True when one exact ref is present in the host store and its bytes match the declared digest. */
function isExactReadable(store: ArtifactHostStore, ref: ArtifactRef): boolean {
  try {
    exactBytes(store, ref, "evidence");
    return true;
  } catch {
    return false;
  }
}
function exactJson<T>(
  store: ArtifactHostStore,
  ref: ArtifactRef,
  label: string,
  validate: (value: unknown) => T
): T {
  const text = exactBytes(store, ref, label).toString("utf8");
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`P11 ${label} is not canonical JSON`);
  return validate(value);
}

/** Exact representation class of one produced P11 artifact, by kind. */
function representationForKind(kind: string): "markdown" | "json" | "sarif" | "record" {
  if (kind === REPORT_MARKDOWN_KIND) return "markdown";
  if (kind === REPORT_SARIF_KIND) return "sarif";
  if (kind === REPORT_JSON_KIND || kind === REPORT_KIND) return "json";
  return "record";
}

/** Any `"release_eligible": true`-style claim in a produced representation is forbidden. */
const SCA_P11_RELEASE_CLAIM_PATTERN =
  /(release_eligible|campaign_complete|campaign_completion_claimed|p12_release_authorized|phase_gate_passed)\s*["']?\s*[:=]\s*true/iu;
function detectScaP11ReleaseClaim(text: string): boolean {
  return SCA_P11_RELEASE_CLAIM_PATTERN.test(text);
}

const P11RepairOperationSchema = Type.Object(
  {
    operation: Type.Union([
      Type.Literal("rewrite_prose"),
      Type.Literal("add_section"),
      Type.Literal("correct_status_note"),
    ]),
    target_id: Type.String({ minLength: 1, maxLength: 512 }),
    field: Type.Union([
      Type.Literal("description"),
      Type.Literal("remediation"),
      Type.Literal("status_note"),
      Type.Literal("steps_to_reproduce"),
      Type.Literal("code_analysis"),
    ]),
    value: Type.String({ minLength: 1, maxLength: 16_384 }),
  },
  { additionalProperties: false }
);

const P11DataSchema = Type.Object(
  {
    request_ref: ArtifactRefSchema,
    admission_ref: ArtifactRefSchema,
    reconciliation_ref: Type.Optional(ArtifactRefSchema),
    scoring_ref: Type.Optional(ArtifactRefSchema),
    payload_ref: Type.Optional(ArtifactRefSchema),
    disclosure_ref: Type.Optional(ArtifactRefSchema),
    /** Pending bounded-repair transition: the exact base report and operations that produced the
     * current child revision. Cleared implicitly because a repair record is written exactly once
     * per child revision (idempotent on restart). */
    repair_base_report_ref: Type.Optional(ArtifactRefSchema),
    repair_base_revision: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    repair_revision: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
    repair_operations: Type.Optional(Type.Array(P11RepairOperationSchema, { maxItems: 1_024 })),
    /** Exact repairer identity/lineage accepted from the bound repair patch, re-used by the record. */
    repairer_identity_id: Type.Optional(OpaqueIdSchema),
    repairer_lineage_id: Type.Optional(OpaqueIdSchema),
    /** Total P11 cognitive provider openings used by this run, bounded by the admitted scope. */
    provider_calls_used: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
  },
  { additionalProperties: false }
);
type P11Data = Readonly<Static<typeof P11DataSchema>>;
function data(context: RunContext): P11Data {
  return validateContract(P11DataSchema, context.playbookData, "SCA P11 durable state");
}

/**
 * Resolve the immutable persist target for one logical output slot. When `parentRef` is supplied
 * (including an explicit `null`) the artifact joins the append-only version chain for its kind: an
 * existing version of this exact operation id is reused on restart, otherwise the next version is
 * appended atop the previous revision's artifact. When `parentRef` is omitted the legacy single
 * version-1 behavior is preserved.
 */
function resolvePersistTarget(input: {
  readonly store: ArtifactHostStore;
  readonly runId: string;
  readonly phase: string;
  readonly kind: string;
  readonly operationId: string;
  readonly parentRef?: ArtifactRef | null;
}): {
  readonly version: number;
  readonly parentRef: ArtifactRef | null;
  readonly prior: ArtifactRef | null;
} {
  if (input.parentRef === undefined) {
    return {
      version: 1,
      parentRef: null,
      prior: input.store.refFor(input.runId, input.phase, null, input.kind, input.operationId, 1),
    };
  }
  const parentRef = input.parentRef;
  const version = parentRef === null ? 1 : parentRef.version + 1;
  const prior = input.store.refFor(
    input.runId,
    input.phase,
    null,
    input.kind,
    input.operationId,
    version
  );
  return { version, parentRef, prior };
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
  /** When supplied the artifact joins the append-only version chain; `null` starts the chain. */
  readonly parentRef?: ArtifactRef | null;
}): ArtifactRef {
  const content = canonicalJson(input.value);
  const select = input.select ?? true;
  const target = resolvePersistTarget(input);
  if (target.prior !== null) {
    const prior = target.prior;
    if (
      prior.content_digest !== sha256(content) ||
      input.store.readById(prior.artifact_id).toString("utf8") !== content
    ) {
      throw new Error(`P11 artifact '${input.operationId}' conflicts with immutable prior bytes`);
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
    version: target.version,
    producer: PRODUCER,
    media_type: "application/json",
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    parent_ref: target.parentRef,
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
  readonly parentRef?: ArtifactRef | null;
}): ArtifactRef {
  const content = Buffer.from(input.bytes);
  const target = resolvePersistTarget(input);
  if (target.prior !== null) {
    const prior = target.prior;
    if (
      prior.content_digest !== sha256(content) ||
      !input.store.readById(prior.artifact_id).equals(content)
    ) {
      throw new Error(`P11 artifact '${input.operationId}' conflicts with immutable prior bytes`);
    }
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
    version: target.version,
    producer: PRODUCER,
    media_type: input.mediaType,
    content_schema: { schema_id: input.schemaId, schema_version: 1 },
    parent_ref: target.parentRef,
    upstream_refs: uniqueRefs(input.upstreamRefs),
  };
  const ref = input.store.persist({ metadata, content });
  const context = input.context;
  if (
    context !== undefined &&
    !context.selectedArtifacts.some((candidate) => candidate.artifact_id === ref.artifact_id)
  ) {
    context.selectedArtifacts.push(ref);
  }
  return ref;
}

function outputArtifact(input: {
  readonly runId: string;
  readonly state: string;
  readonly agent: string;
  readonly kind: string;
  readonly operationId: string;
  readonly upstream: readonly ArtifactRef[];
  /** Append-only revision index of the persisted summary for this exact output slot. */
  readonly version: number;
  readonly parentRef: ArtifactRef | null;
}): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: input.runId,
    phase: input.state,
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: input.version,
    producer: `agent:${input.agent}`,
    media_type: "text/plain",
    content_schema: { schema_id: "penny.persisted-summary-line.v1", schema_version: 1 },
    parent_ref: input.parentRef,
    upstream_refs: [...input.upstream],
  };
}

function validateScaP11CandidateStart(value: unknown): Static<typeof ScaP11CandidateStartV1Schema> {
  return validateContract(ScaP11CandidateStartV1Schema, value, "SCA P11 start constraints");
}
function latestSelected(
  context: RunContext,
  predicate: (ref: ArtifactRef) => boolean
): ArtifactRef | undefined {
  return [...context.selectedArtifacts].reverse().find(predicate);
}
function requireRef(value: ArtifactRef | null | undefined, label: string): ArtifactRef {
  if (value === null || value === undefined) throw new Error(`P11 ${label} ref is absent`);
  return value;
}

export class ScaP11CandidatePlaybook implements Playbook {
  constructor(
    private readonly store: ArtifactHostStore,
    private readonly binding: ScaP11CandidateBindingV1 = {},
    private readonly trustedClock: () => Date = () => new Date()
  ) {}

  initialize(context: RunContext): Directive {
    return this.startRun(context);
  }

  dispatch(context: RunContext): Directive {
    if (context.pendingDirective !== null) return context.pendingDirective;
    if (context.stateId === SCA_P11_REVIEWING_STATE) return this.issueReview(context);
    if (context.stateId === SCA_P11_REPAIRING_STATE) return this.issueRepair(context);
    if (context.stateId === SCA_P11_FINALIZING_STATE) return this.finalizeFromState(context);
    throw new Error(`SCA P11 has no dispatch for '${context.stateId}'`);
  }

  resume(): Directive {
    throw new Error("SCA P11 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = SCA_P11_CANCELLED_STATE;
    context.status = "cancelled";
    context.met = false;
    void reason;
    const terminal = validateScaP11TerminalV1(
      withP11Digest(
        {
          schema_id: SCA_P11_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P11_PHASE,
          status: "cancelled" as const,
          report_ref: null,
          reconciliation_ref: null,
          validation_records_ref: null,
          gate_ref: null,
          p12_transition_ref: null,
          p12_handoff_ready: false,
          report_status: null,
          missing_downstream_artifacts: [...SCA_P11_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: [...SCA_P11_DOWNSTREAM_OBLIGATION_IDS],
          selected_artifact_refs: this.selectedCoreRefs(context),
          blocker_codes: ["p11_cancelled"],
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          p12_release_authorized: false as const,
          release_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P11_PHASE,
      kind: TERMINAL_KIND,
      operationId: "sca-p11-terminal-cancelled",
      schemaId: SCA_P11_TERMINAL_SCHEMA,
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
    if (context.stateId === SCA_P11_FINALIZING_STATE) {
      try {
        return this.finalizeFromState(context);
      } catch {
        return this.finalizeNonPositive(context, "p11_restart_finalization_failed");
      }
    }
    if (context.stateId === SCA_P11_REVIEWING_STATE) return this.issueReview(context);
    return null;
  }

  acceptSummary(
    context: RunContext,
    details: Record<string, JsonValue>,
    _confidence: Confidence
  ): Directive {
    if (context.stateId === SCA_P11_REVIEWING_STATE) return this.acceptReview(context, details);
    if (context.stateId === SCA_P11_REPAIRING_STATE) return this.acceptRepair(context, details);
    throw new Error(`unexpected SCA P11 summary in '${context.stateId}'`);
  }

  /**
   * Deeply re-derive the recorded P11 reassessment/prior-report chain (`P11-R18`). The reassessment
   * must name the exact prior report and its latest validation by ref and digest; the new revision is
   * exactly `prior.latest_revision + 1` so the append-only chain is gapless; every stimulus and
   * invalidated-evidence ref must resolve to exact admitted bytes. A prior report without a
   * reassessment (or a reassessment whose prior ref disagrees with the declared prior report) fails
   * closed before any report output is produced.
   */
  private readReassessment(
    runId: string,
    constraints: Static<typeof ScaP11CandidateStartV1Schema>
  ): {
    readonly reassessment: ScaP11ReassessmentV1;
    readonly revision: number;
    readonly prior_report_refs: {
      readonly json: ArtifactRef;
      readonly markdown: ArtifactRef;
      readonly sarif: ArtifactRef;
    };
  } | null {
    const reassessmentRef = constraints.p11_reassessment_ref;
    if (reassessmentRef === null) {
      if (constraints.p11_prior_report_ref !== null) {
        throw new Error("SCA P11 prior report requires an exact reassessment");
      }
      return null;
    }
    if (constraints.p11_prior_report_ref === null) {
      throw new Error("SCA P11 reassessment requires the exact prior report ref");
    }
    const reassessment = exactJson(
      this.store,
      reassessmentRef,
      "reassessment",
      validateScaP11ReassessmentV1
    );
    if (reassessment.run_id !== runId) {
      throw new Error("SCA P11 reassessment belongs to another run");
    }
    if (!same(reassessment.prior_report_ref, constraints.p11_prior_report_ref)) {
      throw new Error("SCA P11 reassessment prior report disagrees with the declared prior report");
    }
    const priorReport = exactJson(
      this.store,
      reassessment.prior_report_ref,
      "prior report",
      validateScaP11ReportV1
    );
    const priorValidation = exactJson(
      this.store,
      reassessment.prior_validation_ref,
      "prior validation",
      validateScaP11ValidationRecordsV1
    );
    if (
      priorValidation.revision !== priorReport.latest_revision ||
      priorValidation.report_json_ref.artifact_id !== priorReport.json_ref.artifact_id ||
      priorValidation.report_json_ref.content_digest !== priorReport.json_ref.content_digest
    ) {
      throw new Error(
        "SCA P11 reassessment prior validation is not the prior report's latest revision"
      );
    }
    for (const ref of reassessment.stimulus_refs) {
      exactBytes(this.store, ref, "reassessment stimulus");
    }
    for (const ref of reassessment.invalidated_evidence_refs) {
      exactBytes(this.store, ref, "reassessment invalidated evidence");
    }
    return {
      reassessment,
      revision: priorReport.latest_revision + 1,
      prior_report_refs: {
        json: priorReport.json_ref,
        markdown: priorReport.markdown_ref,
        sarif: priorReport.sarif_ref,
      },
    };
  }

  private startRun(context: RunContext): Directive {
    const runId = context.identity.run_id;
    const requestRef = latestSelected(
      context,
      (ref) => ref.kind === REQUEST_KIND && ref.run_id === runId
    );
    if (requestRef === undefined) throw new Error("SCA P11 admitted request is absent");
    const constraints = exactJson(
      this.store,
      requestRef,
      "candidate request",
      validateScaP11CandidateStart
    );
    const admitted = this.readmit(runId, constraints);
    const admissionRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: ADMISSION_KIND,
      operationId: "sca-p11-admission",
      schemaId: SCA_P11_ADMISSION_SCHEMA,
      value: admitted.admission,
      upstreamRefs: uniqueRefs([requestRef, ...admitted.evidence_refs]),
    });
    Object.assign(context.playbookData, { request_ref: requestRef, admission_ref: admissionRef });
    if (!admitted.reportable) {
      context.transition(SCA_P11_FINALIZING_STATE);
      return this.finalizeNonPositive(
        context,
        admitted.non_reportable_reason ?? "p11_non_reportable_p10_checkpoint"
      );
    }
    const ledger = admitted.p09_ledger;
    if (ledger === null) throw new Error("SCA P11 lacks the re-derived P09 reconciliation ledger");
    const reassessment = this.readReassessment(runId, constraints);
    const revision = reassessment === null ? 1 : reassessment.revision;
    const reconciliation = reconcileScaP11({
      run_id: runId,
      revision,
      p09_reconciliation_ledger_ref: requireRef(
        admitted.admission.p09_reconciliation_ledger_ref,
        "P09 reconciliation ledger"
      ),
      ledger,
      p10_outcome_ref: admitted.admission.p10_outcome_ref,
      p10_outcome: admitted.p10_outcome,
      p10_registry: admitted.p10_registry,
      invalidated_evidence_refs: reassessment?.reassessment.invalidated_evidence_refs ?? [],
    });
    const reconciliationRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: RECONCILIATION_KIND,
      operationId:
        revision === 1
          ? "sca-p11-reconciliation"
          : `sca-p11-reconciliation-revision-${String(revision).padStart(6, "0")}`,
      schemaId: SCA_P11_RECONCILIATION_SCHEMA,
      value: reconciliation,
      upstreamRefs: uniqueRefs([admissionRef, ledger.p08_terminal_ref]),
    });
    const scoringPolicy = this.readScoringPolicy(admitted);
    const scoring = buildScaP11ScoringRecordsV1({
      run_id: runId,
      revision,
      targets: reconciliation.rows
        .filter((row) => row.reportable)
        .map((row) => ({ target_id: row.identity, evidence_refs: row.source_refs })),
      policy: scoringPolicy,
      scorer: this.binding.scorer ?? null,
    }).records;
    const scoringRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: SCORING_KIND,
      operationId:
        revision === 1
          ? "sca-p11-scoring-records"
          : `sca-p11-scoring-records-revision-${String(revision).padStart(6, "0")}`,
      schemaId: SCA_P11_SCORING_RECORDS_SCHEMA,
      value: scoring,
      upstreamRefs: [reconciliationRef],
    });
    Object.assign(context.playbookData, {
      reconciliation_ref: reconciliationRef,
      scoring_ref: scoringRef,
    });
    this.renderRevision({
      context,
      admitted,
      reconciliation,
      reconciliationRef,
      scoring,
      revision,
      patch: null,
      parentRefs: reassessment?.prior_report_refs ?? null,
    });
    context.transition(SCA_P11_REVIEWING_STATE);
    return this.issueReview(context);
  }

  private readmit(
    runId: string,
    constraints: Static<typeof ScaP11CandidateStartV1Schema>
  ): ScaP11AdmissionResultV1 {
    const p07 = this.binding.resolve_current_p07_authority_ref;
    const p01 = this.binding.resolve_current_p01_obligation_head_ref;
    return admitScaP11Reporting({
      store: this.store,
      run_id: runId,
      p10_terminal_ref: constraints.p10_terminal_ref,
      p10_transition_ref: constraints.p10_transition_ref,
      p10_outcome_ref: constraints.p10_outcome_ref,
      p10_gate_ref: constraints.p10_gate_ref,
      p10_admission_ref: constraints.p10_admission_ref,
      p10_eligibility_ledger_ref: constraints.p10_eligibility_ledger_ref,
      p10_candidate_registry_ref: constraints.p10_candidate_registry_ref,
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
      baseline_evidence_ref: constraints.baseline_evidence_ref,
      p10_disclosure_scope_ref: constraints.p10_disclosure_scope_ref,
      promotion_authority_ref: constraints.promotion_authority_ref,
      active_run_rule_release_refs: constraints.active_run_rule_release_refs,
      p09_coverage_input_ref: constraints.p09_coverage_input_ref,
      p09_phase_evidence_refs: constraints.p09_phase_evidence_refs,
      p09_obligation_resolution_ref: constraints.p09_obligation_resolution_ref,
      p09_reassessment_ref: constraints.p09_reassessment_ref,
      p10_reassessment_ref: constraints.p10_reassessment_ref,
      p10_prior_ledger_ref: constraints.p10_prior_ledger_ref,
      p11_disclosure_scope_ref: constraints.p11_disclosure_scope_ref,
      p11_repair_disclosure_scope_ref: constraints.p11_repair_disclosure_scope_ref,
      scoring_policy_ref: constraints.scoring_policy_ref,
      report_policy_ref: constraints.report_policy_ref,
      ...(p07 === undefined ? {} : { resolve_current_p07_authority_ref: p07 }),
      ...(p01 === undefined ? {} : { resolve_current_p01_obligation_head_ref: p01 }),
    });
  }

  private readmitFromState(context: RunContext): ScaP11AdmissionResultV1 {
    const state = data(context);
    const constraints = exactJson(
      this.store,
      state.request_ref,
      "candidate request",
      validateScaP11CandidateStart
    );
    const admitted = this.readmit(context.identity.run_id, constraints);
    const persisted = validateScaP11AdmissionV1(
      exactJson(this.store, state.admission_ref, "admission", validateScaP11AdmissionV1)
    );
    if (!same(admitted.admission, persisted)) {
      throw new Error("SCA P11 durable admission drifted from exact lineage");
    }
    return admitted;
  }

  private readReportPolicy(admitted: ScaP11AdmissionResultV1): ScaP11ReportPolicyV1 {
    return exactJson(
      this.store,
      admitted.admission.report_policy_ref,
      "report policy",
      validateScaP11ReportPolicyV1
    );
  }

  private readScoringPolicy(admitted: ScaP11AdmissionResultV1) {
    return exactJson(
      this.store,
      admitted.admission.scoring_policy_ref,
      "scoring policy",
      validateScaP11ScoringPolicyV1
    );
  }

  private locationsFor(
    rows: readonly { readonly identity: string; readonly source_refs: readonly ArtifactRef[] }[]
  ): {
    readonly by_identity: ReadonlyMap<string, ScaP11LocationV1>;
    readonly omitted: readonly string[];
  } {
    const byIdentity = new Map<string, ScaP11LocationV1>();
    const omitted: string[] = [];
    for (const row of rows) {
      let located = false;
      for (const ref of row.source_refs) {
        if (ref.kind !== "sca-p08-disposition-revision") continue;
        try {
          const revision = exactJson(
            this.store,
            ref,
            "disposition revision",
            validateScaP08DispositionRevisionV1
          );
          if (revision.repository_path !== null && revision.line_start !== null) {
            byIdentity.set(row.identity, {
              path: revision.repository_path,
              line_start: revision.line_start,
            });
            located = true;
          }
        } catch {
          // A source ref that is not a readable disposition revision carries no location.
        }
      }
      if (!located) omitted.push(row.identity);
    }
    return { by_identity: byIdentity, omitted: [...new Set(omitted)].sort() };
  }

  private renderRevision(input: {
    readonly context: RunContext;
    readonly admitted: ScaP11AdmissionResultV1;
    readonly reconciliation: ScaP11ReconciliationV1;
    readonly reconciliationRef: ArtifactRef;
    readonly scoring: ScaP11ScoringRecordsV1;
    readonly revision: number;
    readonly patch: ScaP11RepairPatchV1 | null;
    /**
     * Exact prior-report artifact refs for a reassessment revision. A reassessment run has no
     * current-run predecessor, so the append-only chain must parent onto the recorded prior revision
     * rather than restarting at version 1 (`P11-R18`).
     */
    readonly parentRefs?: {
      readonly json: ArtifactRef;
      readonly markdown: ArtifactRef;
      readonly sarif: ArtifactRef;
    } | null;
  }): { readonly reportRef: ArtifactRef; readonly report: ScaP11ReportJsonV1 } {
    const { context, reconciliation, revision, patch } = input;
    const runId = context.identity.run_id;
    const policy = this.readReportPolicy(input.admitted);
    const patched = patch === null ? policy : this.applyPatch(policy, patch, reconciliation);
    const ledger = input.admitted.p09_ledger;
    if (ledger === null) throw new Error("SCA P11 lacks the re-derived P09 ledger");
    const locations = this.locationsFor(reconciliation.rows);
    let report = renderScaP11ReportJsonV1({
      run_id: runId,
      revision,
      lane: input.admitted.lane ?? "incomplete_closeout",
      status: "complete",
      source_snapshot_sha256: ledger.p08_terminal_ref.content_digest,
      rows: reconciliation.rows,
      policy: patched,
      scoring: input.scoring,
      location_by_identity: locations.by_identity,
    });
    if (locations.omitted.length > 0) {
      report = validateScaP11ReportJsonV1(
        withP11Digest(
          {
            ...(() => {
              const { report_json_sha256: _digest, ...body } = report;
              return body;
            })(),
            representation_omissions: [
              ...report.representation_omissions,
              {
                representation: "sarif" as const,
                omission:
                  "SARIF source locations omitted for identities without an admitted repository path",
                justification:
                  "Only complete repository-root paths may appear in a source citation; an unavailable path is omitted rather than fabricated",
              },
            ],
          },
          "report_json_sha256"
        )
      );
    }
    const priorRefs = input.parentRefs ?? null;
    const sameRunPrior =
      priorRefs !== null && priorRefs.json.run_id === context.identity.run_id ? priorRefs : null;
    const baseReportRef = sameRunPrior
      ? sameRunPrior.json
      : revision === 1
        ? null
        : (latestSelected(context, (ref) => ref.kind === REPORT_JSON_KIND) ?? null);
    const baseMarkdownRef = sameRunPrior
      ? sameRunPrior.markdown
      : revision === 1
        ? null
        : (latestSelected(context, (ref) => ref.kind === REPORT_MARKDOWN_KIND) ?? null);
    const baseSarifRef = sameRunPrior
      ? sameRunPrior.sarif
      : revision === 1
        ? null
        : (latestSelected(context, (ref) => ref.kind === REPORT_SARIF_KIND) ?? null);
    const priorUpstreamRefs =
      priorRefs === null ? [] : [priorRefs.json, priorRefs.markdown, priorRefs.sarif];
    const reportRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: REPORT_JSON_KIND,
      operationId: "sca-p11-report-json",
      schemaId: SCA_P11_REPORT_JSON_SCHEMA,
      value: report,
      upstreamRefs: uniqueRefs([input.reconciliationRef, ...priorUpstreamRefs]),
      parentRef: baseReportRef,
    });
    const markdown = renderScaP11MarkdownV1(report);
    persistBytes({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: REPORT_MARKDOWN_KIND,
      operationId: "sca-p11-report-markdown",
      schemaId: SCA_P11_REPORT_MARKDOWN_SCHEMA,
      mediaType: "text/markdown",
      bytes: Buffer.from(markdown, "utf8"),
      upstreamRefs: [reportRef],
      parentRef: baseMarkdownRef,
    });
    const sarif = buildScaP11ReportSarifV1({
      report,
      location_by_identity: locations.by_identity,
    }).sarif;
    persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: REPORT_SARIF_KIND,
      operationId: "sca-p11-report-sarif",
      schemaId: SCA_P11_REPORT_SARIF_SCHEMA,
      value: sarif,
      upstreamRefs: [reportRef],
      parentRef: baseSarifRef,
    });
    return { reportRef, report };
  }

  private applyPatch(
    policy: ScaP11ReportPolicyV1,
    patch: ScaP11RepairPatchV1,
    reconciliation: ScaP11ReconciliationV1
  ): ScaP11ReportPolicyV1 {
    const identityByFindingId = new Map(
      reconciliation.rows.map((row) => [scaP11FindingId(row.identity), row.identity])
    );
    const byId = new Map(
      policy.entries.map((entry) => [
        entry.identity,
        {
          ...entry,
          steps_to_reproduce: [...entry.steps_to_reproduce],
          code_analysis: [...entry.code_analysis],
        },
      ])
    );
    for (const operation of patch.operations) {
      const identity = identityByFindingId.get(operation.target_id) ?? operation.target_id;
      const entry = byId.get(identity);
      if (entry === undefined) continue;
      if (operation.field === "description") entry.description = operation.value;
      if (operation.field === "remediation") entry.remediation = operation.value;
      if (operation.field === "status_note") entry.status_note = operation.value;
      if (operation.field === "steps_to_reproduce") entry.steps_to_reproduce = [operation.value];
      if (operation.field === "code_analysis") entry.code_analysis = [operation.value];
    }
    return validateScaP11ReportPolicyV1(
      withP11Digest(
        {
          schema_id: policy.schema_id,
          schema_version: 1 as const,
          phase_id: policy.phase_id,
          run_id: policy.run_id,
          statements: policy.statements,
          entries: [...byId.values()].sort((left, right) =>
            left.identity < right.identity ? -1 : 1
          ),
        },
        "policy_sha256"
      )
    );
  }

  private consumeProviderCall(
    context: RunContext,
    scope: { readonly max_provider_calls: number }
  ): boolean {
    const used = data(context).provider_calls_used ?? 0;
    if (used >= scope.max_provider_calls) return false;
    Object.assign(context.playbookData, { provider_calls_used: used + 1 });
    return true;
  }

  private issueReview(context: RunContext): Directive {
    const state = data(context);
    const admitted = this.readmitFromState(context);
    if (state.reconciliation_ref === undefined || state.scoring_ref === undefined) {
      throw new Error("SCA P11 review phase lacks reconciliation or scoring records");
    }
    const reportRef = requireRef(
      latestSelected(context, (ref) => ref.kind === REPORT_JSON_KIND),
      "report json"
    );
    const report = validateScaP11ReportJsonV1(
      exactJson(this.store, reportRef, "report json", validateScaP11ReportJsonV1)
    );
    const scopeRef = admitted.admission.p11_disclosure_scope_ref;
    const scope = validateScaP11DisclosureScopeV1(
      exactJson(this.store, scopeRef, "disclosure scope", validateScaP11DisclosureScopeV1)
    );
    const built = buildScaP11CognitivePayloadV1({
      run_id: context.identity.run_id,
      revision: report.revision,
      report_ref: reportRef,
      report,
      reconciliation_ref: state.reconciliation_ref,
      scoring_records_ref: state.scoring_ref,
      disclosure_scope_ref: scopeRef,
      repair_violations: [],
    });
    const suffix = `-${String(report.revision).padStart(6, "0")}`;
    const payloadRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: SCA_P11_REVIEWING_STATE,
      kind: PAYLOAD_KIND,
      operationId: `sca-p11-review-payload${suffix}`,
      schemaId: SCA_P11_COGNITIVE_PAYLOAD_SCHEMA,
      value: built.payload,
      upstreamRefs: [reportRef, state.reconciliation_ref],
      select: false,
    });
    const disclosure = buildScaP11DisclosureAdmissionV1({
      run_id: context.identity.run_id,
      call_id: "sca-p11-semantic-review",
      scope,
      scope_ref: scopeRef,
      payload_ref: payloadRef,
      payload: built.payload,
      authorized_refs: uniqueRefs([
        reportRef,
        state.reconciliation_ref,
        state.scoring_ref,
        ...built.assertions.flatMap((assertion) => assertion.evidence_allowlist),
      ]),
    });
    const disclosureRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: SCA_P11_REVIEWING_STATE,
      kind: DISCLOSURE_KIND,
      operationId: `sca-p11-review-disclosure${suffix}`,
      schemaId: SCA_P11_DISCLOSURE_ADMISSION_SCHEMA,
      value: disclosure,
      upstreamRefs: [payloadRef, scopeRef],
      select: false,
    });
    Object.assign(context.playbookData, { payload_ref: payloadRef, disclosure_ref: disclosureRef });
    if (disclosure.decision !== "allow") {
      context.transition(SCA_P11_FINALIZING_STATE);
      return this.finalizeNonPositive(context, "p11_review_disclosure_denied");
    }
    if (!this.consumeProviderCall(context, scope)) {
      context.transition(SCA_P11_FINALIZING_STATE);
      return this.finalizeNonPositive(context, "p11_provider_call_budget_exhausted");
    }
    const directive = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: SCA_P11_REVIEWING_STATE,
      agent: SCA_P11_REVIEWER_AGENT,
      attempt: report.revision,
      trust_profile: "hardened-untrusted",
      model_override: SCA_P11_REQUIRED_MODEL.override,
      task: "Perform an evidence-aware semantic review of the exact report assertions in the host-verified payload. For each assigned assertion resolve it to exact evidence and return a closed verdict (supported/refuted/insufficient) with a reason, evidence refs, and any repair candidate. List every open item with a disposition. Never set a gate verdict. Return only the exact closed semantic-review JSON contract. No tools are available.",
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "cognitive_payload", ref: payloadRef },
          { slot: "disclosure_admission", ref: disclosureRef },
        ],
      },
      output_artifact: outputArtifact({
        runId: context.identity.run_id,
        state: SCA_P11_REVIEWING_STATE,
        agent: SCA_P11_REVIEWER_AGENT,
        kind: REVIEW_OUTPUT_KIND,
        operationId: "sca-p11-semantic-review",
        version: report.revision,
        parentRef:
          report.revision === 1
            ? null
            : this.store.refFor(
                context.identity.run_id,
                SCA_P11_REVIEWING_STATE,
                null,
                REVIEW_OUTPUT_KIND,
                "sca-p11-semantic-review",
                report.revision - 1
              ),
        upstream: [payloadRef, disclosureRef],
      }),
    });
    context.pendingDirective = directive;
    return directive;
  }

  /**
   * Bind a P11 cognitive record's declared reviewer/repairer identity to the captured worker result
   * metadata: the exact engine-captured agent output artifact for that call. When the worker output
   * is present (the real-engine path) its producer must equal the recorded identity, so a foreign
   * agent can never be recorded as the reviewer. The provider-free harness captures no worker output
   * artifact, so the record still binds the pinned reviewer registration exactly.
   */
  private assertCognitiveWorkerBinding(
    context: RunContext,
    kind: string,
    declaredIdentityId: string
  ): void {
    const outputRef = latestSelected(
      context,
      (ref) => ref.kind === kind && ref.producer.startsWith("agent:")
    );
    if (outputRef !== undefined && outputRef.producer !== declaredIdentityId) {
      throw new Error(
        "SCA P11 cognitive worker output producer disagrees with the recorded reviewer identity"
      );
    }
  }

  private acceptReview(context: RunContext, details: Record<string, JsonValue>): Directive {
    const runId = context.identity.run_id;
    const state = data(context);
    this.readmitFromState(context);
    const reportRef = requireRef(
      latestSelected(context, (ref) => ref.kind === REPORT_JSON_KIND),
      "report json"
    );
    const reconciliationRef = requireRef(state.reconciliation_ref, "reconciliation");
    const sarifRef = requireRef(
      latestSelected(context, (ref) => ref.kind === REPORT_SARIF_KIND),
      "report sarif"
    );
    const report = validateScaP11ReportJsonV1(
      exactJson(this.store, reportRef, "report json", validateScaP11ReportJsonV1)
    );
    const reconciliation = validateScaP11ReconciliationV1(
      exactJson(this.store, reconciliationRef, "reconciliation", validateScaP11ReconciliationV1)
    );
    const sarif = validateScaP11ReportSarifV1(
      exactJson(this.store, sarifRef, "report sarif", validateScaP11ReportSarifV1)
    );
    const review = validateScaP11SemanticReviewV1(details);
    this.assertCognitiveWorkerBinding(context, REVIEW_OUTPUT_KIND, review.reviewer_identity_id);
    if (
      review.report_sha256 !== reportRef.content_digest ||
      !same(review.report_ref, reportRef) ||
      review.revision !== report.revision
    ) {
      throw new Error("SCA P11 semantic review is not bound to the reviewed revision");
    }
    // A review must resolve every assertion the host actually assigned; a heading-, keyword-, or
    // model-agreement-only pass never counts as proof (`AC-P11` #5, `P11-R13`). A review that
    // resolves fewer (or more) assertions than the exact payload assigned is a vacuous pass and is
    // rejected before any gate can be derived.
    const reviewPayload = validateScaP11CognitivePayloadV1(
      exactJson(
        this.store,
        requireRef(state.payload_ref, "review payload"),
        "review payload",
        validateScaP11CognitivePayloadV1
      )
    );
    if (review.payload_sha256 !== reviewPayload.payload_sha256) {
      throw new Error("SCA P11 semantic review payload binding mismatch");
    }
    const assignedAssertions = new Set(reviewPayload.assigned_assertion_ids);
    const resolvedAssertions = new Set(review.verdicts.map((verdict) => verdict.assertion_id));
    if (
      assignedAssertions.size === 0 ||
      resolvedAssertions.size !== assignedAssertions.size ||
      [...assignedAssertions].some((id) => !resolvedAssertions.has(id))
    ) {
      throw new Error(
        "SCA P11 semantic review does not resolve every assigned assertion exactly once"
      );
    }
    const suffix = `-${String(report.revision).padStart(6, "0")}`;
    const reviewRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: SCA_P11_REVIEWING_STATE,
      kind: REVIEW_OUTPUT_KIND,
      operationId: `sca-p11-semantic-review-record${suffix}`,
      schemaId: SCA_P11_SEMANTIC_REVIEW_SCHEMA,
      value: review,
      upstreamRefs: [reportRef],
      select: false,
    });
    const semanticEvaluation = evaluateScaP11SemanticReview({
      payload: reviewPayload,
      review,
      exactReadable: (ref) => isExactReadable(this.store, ref),
    });
    const openItems = [
      ...review.open_items.map((item) => ({
        open_item_id: item.open_item_id,
        target_id: item.target_id,
        severity: item.severity,
        disposition: item.disposition,
        evidence_refs: [...item.evidence_refs],
      })),
      ...semanticEvaluation.open_items.map((item) => ({
        open_item_id: item.open_item_id,
        target_id: item.target_id,
        severity: item.severity,
        disposition: item.disposition,
        evidence_refs: [...item.evidence_refs],
      })),
    ]
      .sort((left, right) =>
        left.open_item_id < right.open_item_id ? -1 : left.open_item_id > right.open_item_id ? 1 : 0
      )
      .filter(
        (item, index, all) =>
          all.findIndex((other) => other.open_item_id === item.open_item_id) === index
      );
    const semanticPassed =
      semanticEvaluation.passed && openItems.every((item) => item.severity !== "blocking");
    const unresolvedMaterial = reconciliation.rows
      .filter((row) => !row.reportable && row.missing_material.length > 0)
      .map((row) => `${row.identity}: ${row.missing_material.join(", ")}`);
    const validation = buildScaP11ValidationRecordsV1({
      run_id: runId,
      revision: report.revision,
      report_json_ref: reportRef,
      report,
      sarif,
      reconciliation,
      semantic_review_ref: reviewRef,
      semantic_passed: semanticPassed,
      open_items: openItems,
      repair_records: [],
      missing_material: unresolvedMaterial,
    });
    const validationRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: VALIDATION_KIND,
      operationId: "sca-p11-validation-records",
      schemaId: SCA_P11_VALIDATION_RECORDS_SCHEMA,
      value: validation,
      upstreamRefs: [reportRef, reviewRef],
      parentRef: latestSelected(context, (ref) => ref.kind === VALIDATION_KIND) ?? null,
    });
    this.persistRepairRecordIfNeeded({
      context,
      runId,
      report,
      reviewRef,
      validation,
      validationRef,
    });
    const repairBudget = this.binding.repair_budget ?? 0;
    const hasActionable = review.open_items.some(
      (item) => item.disposition === "retained-incomplete"
    );
    if (hasActionable && report.revision <= repairBudget) {
      context.transition(SCA_P11_REPAIRING_STATE);
      return this.issueRepair(context);
    }
    context.transition(SCA_P11_FINALIZING_STATE);
    return this.finalizeFromState(context);
  }

  private issueRepair(context: RunContext): Directive {
    const state = data(context);
    const admitted = this.readmitFromState(context);
    if (state.reconciliation_ref === undefined || state.scoring_ref === undefined) {
      throw new Error("SCA P11 repair phase lacks reconciliation or scoring records");
    }
    const reportRef = requireRef(
      latestSelected(context, (ref) => ref.kind === REPORT_JSON_KIND),
      "report json"
    );
    const report = validateScaP11ReportJsonV1(
      exactJson(this.store, reportRef, "report json", validateScaP11ReportJsonV1)
    );
    const scopeRef =
      admitted.admission.p11_repair_disclosure_scope_ref ??
      admitted.admission.p11_disclosure_scope_ref;
    const scope = validateScaP11DisclosureScopeV1(
      exactJson(this.store, scopeRef, "disclosure scope", validateScaP11DisclosureScopeV1)
    );
    const violations = report.findings
      .filter((finding) => !finding.complete)
      .map((finding) => `${finding.finding_id}: ${finding.missing_material.join(", ")}`);
    const built = buildScaP11CognitivePayloadV1({
      run_id: context.identity.run_id,
      revision: report.revision,
      report_ref: reportRef,
      report,
      reconciliation_ref: state.reconciliation_ref,
      scoring_records_ref: state.scoring_ref,
      disclosure_scope_ref: scopeRef,
      repair_violations: violations.length > 0 ? violations : ["bounded prose repair"],
    });
    const suffix = `-${String(report.revision).padStart(6, "0")}`;
    const payloadRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: SCA_P11_REPAIRING_STATE,
      kind: PAYLOAD_KIND,
      operationId: `sca-p11-repair-payload${suffix}`,
      schemaId: SCA_P11_COGNITIVE_PAYLOAD_SCHEMA,
      value: built.payload,
      upstreamRefs: [reportRef],
      select: false,
    });
    const disclosure = buildScaP11DisclosureAdmissionV1({
      run_id: context.identity.run_id,
      call_id: "sca-p11-bounded-repair",
      scope,
      scope_ref: scopeRef,
      payload_ref: payloadRef,
      payload: built.payload,
      authorized_refs: uniqueRefs([
        reportRef,
        requireRef(state.reconciliation_ref, "reconciliation"),
        requireRef(state.scoring_ref, "scoring records"),
        ...built.assertions.flatMap((a) => a.evidence_allowlist),
      ]),
    });
    const disclosureRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: SCA_P11_REPAIRING_STATE,
      kind: DISCLOSURE_KIND,
      operationId: `sca-p11-repair-disclosure${suffix}`,
      schemaId: SCA_P11_DISCLOSURE_ADMISSION_SCHEMA,
      value: disclosure,
      upstreamRefs: [payloadRef, scopeRef],
      select: false,
    });
    Object.assign(context.playbookData, { payload_ref: payloadRef, disclosure_ref: disclosureRef });
    if (disclosure.decision !== "allow") {
      context.transition(SCA_P11_FINALIZING_STATE);
      return this.finalizeFromState(context);
    }
    if (!this.consumeProviderCall(context, scope)) {
      context.transition(SCA_P11_FINALIZING_STATE);
      return this.finalizeFromState(context);
    }
    const directive = validateDirective({
      schema_version: 2,
      action: "invoke_agent",
      identity: context.identity,
      state_id: SCA_P11_REPAIRING_STATE,
      agent: SCA_P11_REVIEWER_AGENT,
      attempt: report.revision,
      trust_profile: "hardened-untrusted",
      model_override: SCA_P11_REQUIRED_MODEL.override,
      task: "Propose a bounded repair for the exact violations of the reviewed report. You may only rewrite prose, supply a missing narrative section, or correct a status note for an existing finding. You must not remove a finding, upgrade a status or severity, add CWE or threat metadata, or supply a numeric score. Return only the exact closed repair-patch JSON contract. No tools are available.",
      input_artifacts: {
        schema_version: 2,
        artifacts: [
          { slot: "cognitive_payload", ref: payloadRef },
          { slot: "disclosure_admission", ref: disclosureRef },
        ],
      },
      output_artifact: outputArtifact({
        runId: context.identity.run_id,
        state: SCA_P11_REPAIRING_STATE,
        agent: SCA_P11_REVIEWER_AGENT,
        kind: REPAIR_PATCH_KIND,
        operationId: "sca-p11-repair-patch",
        version: report.revision,
        parentRef:
          report.revision === 1
            ? null
            : this.store.refFor(
                context.identity.run_id,
                SCA_P11_REPAIRING_STATE,
                null,
                REPAIR_PATCH_KIND,
                "sca-p11-repair-patch",
                report.revision - 1
              ),
        upstream: [payloadRef, disclosureRef],
      }),
    });
    context.pendingDirective = directive;
    return directive;
  }

  private acceptRepair(context: RunContext, details: Record<string, JsonValue>): Directive {
    const state = data(context);
    const admitted = this.readmitFromState(context);
    const reportRef = requireRef(
      latestSelected(context, (ref) => ref.kind === REPORT_JSON_KIND),
      "report json"
    );
    const report = validateScaP11ReportJsonV1(
      exactJson(this.store, reportRef, "report json", validateScaP11ReportJsonV1)
    );
    const reconciliationRef = requireRef(state.reconciliation_ref, "reconciliation");
    const reconciliation = validateScaP11ReconciliationV1(
      exactJson(this.store, reconciliationRef, "reconciliation", validateScaP11ReconciliationV1)
    );
    const scoring = validateScaP11ScoringRecordsV1(
      exactJson(
        this.store,
        requireRef(state.scoring_ref, "scoring records"),
        "scoring records",
        validateScaP11ScoringRecordsV1
      )
    );
    const patch = validateScaP11RepairPatchV1(details);
    this.assertCognitiveWorkerBinding(context, REPAIR_PATCH_KIND, patch.repairer_identity_id);
    if (patch.report_sha256 !== reportRef.content_digest) {
      throw new Error("SCA P11 repair patch is not bound to the base revision");
    }
    const revision = report.revision + 1;
    const rendered = this.renderRevision({
      context,
      admitted,
      reconciliation,
      reconciliationRef,
      scoring,
      revision,
      patch,
    });
    // A bounded repair may only rewrite prose: it must never delete, add, or downgrade a finding.
    const baseById = new Map(report.findings.map((finding) => [finding.finding_id, finding]));
    const childById = new Map(
      rendered.report.findings.map((finding) => [finding.finding_id, finding])
    );
    if (childById.size !== baseById.size) {
      throw new Error("SCA P11 bounded repair must not delete or add a finding");
    }
    for (const [findingId, base] of baseById) {
      const child = childById.get(findingId);
      if (child === undefined) {
        throw new Error("SCA P11 bounded repair must not delete a finding");
      }
      if (
        child.severity_token !== base.severity_token ||
        child.status !== base.status ||
        child.cwe_id !== base.cwe_id ||
        child.cwe_name !== base.cwe_name ||
        child.threat_model_id !== base.threat_model_id ||
        child.cvss_score !== base.cvss_score ||
        child.exception_shape !== base.exception_shape
      ) {
        throw new Error("SCA P11 bounded repair must not downgrade or upgrade a finding");
      }
    }
    Object.assign(context.playbookData, {
      repair_base_report_ref: reportRef,
      repair_base_revision: report.revision,
      repair_revision: revision,
      repair_operations: patch.operations.map((operation) => ({
        operation: operation.operation,
        target_id: operation.target_id,
        field: operation.field,
        value: operation.value,
      })),
      repairer_identity_id: patch.repairer_identity_id,
      repairer_lineage_id: patch.repairer_lineage_id,
    });
    context.pendingDirective = null;
    context.transition(SCA_P11_REVIEWING_STATE);
    return this.issueReview(context);
  }

  /**
   * Write the immutable bounded-repair record only after the child revision has re-entered both
   * checks. The re-entry receipts therefore bind the child revision's actual deterministic
   * validation and semantic review, and the record names the exact violations the repair was asked
   * to address (`P11-R14`, `P11-R18`). Writing once per child revision makes restart idempotent.
   */
  private persistRepairRecordIfNeeded(input: {
    readonly context: RunContext;
    readonly runId: string;
    readonly report: ScaP11ReportJsonV1;
    readonly reviewRef: ArtifactRef;
    readonly validation: ReturnType<typeof validateScaP11ValidationRecordsV1>;
    readonly validationRef: ArtifactRef;
  }): void {
    const state = data(input.context);
    if (
      state.repair_revision !== input.report.revision ||
      state.repair_base_report_ref === undefined ||
      state.repair_base_revision === undefined ||
      state.repair_operations === undefined
    ) {
      return;
    }
    const operationId = "sca-p11-repair-record";
    const payloadRef = this.store.refFor(
      input.runId,
      SCA_P11_REPAIRING_STATE,
      null,
      PAYLOAD_KIND,
      `sca-p11-repair-payload-${String(state.repair_base_revision).padStart(6, "0")}`,
      1
    );
    const violations =
      payloadRef === null
        ? []
        : validateScaP11CognitivePayloadV1(
            exactJson(this.store, payloadRef, "repair payload", validateScaP11CognitivePayloadV1)
          ).repair_violations;
    const repairRecord = buildScaP11RepairRecordV1({
      run_id: input.runId,
      base_report_ref: state.repair_base_report_ref,
      base_revision: state.repair_base_revision,
      revision: input.report.revision,
      operations: state.repair_operations.map((operation) => ({
        operation: operation.operation,
        target_id: operation.target_id,
        detail: `${operation.field}: ${operation.value.slice(0, 256)}`,
      })),
      violations_addressed: violations.length > 0 ? violations : ["bounded prose repair"],
      repairer_identity_id: state.repairer_identity_id ?? SCA_P11_REVIEWER_IDENTITY_ID,
      repairer_lineage_id: state.repairer_lineage_id ?? SCA_P11_REVIEWER_LINEAGE_ID,
      deterministic_validation_ref: input.validationRef,
      deterministic_validation_passed: input.validation.deterministic_passed,
      semantic_review_ref: input.reviewRef,
      semantic_review_passed: input.validation.semantic_passed,
    });
    persistJson({
      store: this.store,
      context: input.context,
      runId: input.runId,
      phase: P11_PHASE,
      kind: REPAIR_RECORD_KIND,
      operationId,
      schemaId: SCA_P11_REPAIR_RECORD_SCHEMA,
      value: repairRecord,
      upstreamRefs: [state.repair_base_report_ref, input.reviewRef],
      parentRef: latestSelected(input.context, (ref) => ref.kind === REPAIR_RECORD_KIND) ?? null,
    });
  }

  private finalizeFromState(context: RunContext): Directive {
    const state = data(context);
    const admitted = this.readmitFromState(context);
    if (!admitted.reportable) {
      return this.finalizeNonPositive(
        context,
        admitted.non_reportable_reason ?? "p11_non_reportable_p10_checkpoint"
      );
    }
    const runId = context.identity.run_id;
    const reportRef = requireRef(
      latestSelected(context, (ref) => ref.kind === REPORT_JSON_KIND),
      "report json"
    );
    const markdownRef = requireRef(
      latestSelected(context, (ref) => ref.kind === REPORT_MARKDOWN_KIND),
      "report markdown"
    );
    const sarifRef = requireRef(
      latestSelected(context, (ref) => ref.kind === REPORT_SARIF_KIND),
      "report sarif"
    );
    const reconciliationRef = requireRef(state.reconciliation_ref, "reconciliation");
    const scoringRef = requireRef(state.scoring_ref, "scoring records");
    const report = validateScaP11ReportJsonV1(
      exactJson(this.store, reportRef, "report json", validateScaP11ReportJsonV1)
    );
    const reconciliation = validateScaP11ReconciliationV1(
      exactJson(this.store, reconciliationRef, "reconciliation", validateScaP11ReconciliationV1)
    );
    const sarif = validateScaP11ReportSarifV1(
      exactJson(this.store, sarifRef, "report sarif", validateScaP11ReportSarifV1)
    );
    const scoring = validateScaP11ScoringRecordsV1(
      exactJson(this.store, scoringRef, "scoring records", validateScaP11ScoringRecordsV1)
    );
    const validationRef = requireRef(
      latestSelected(context, (ref) => ref.kind === VALIDATION_KIND),
      "validation records"
    );
    const validation = validateScaP11ValidationRecordsV1(
      exactJson(this.store, validationRef, "validation records", validateScaP11ValidationRecordsV1)
    );
    const suffix = `-${String(report.revision).padStart(6, "0")}`;
    const p01ObligationsRef = requireRef(
      admitted.p09_ledger?.p01_obligation_ledger_ref,
      "P01 obligation ledger"
    );
    const p01Obligations = exactJson(
      this.store,
      p01ObligationsRef,
      "P01 obligation ledger",
      effectiveScaObligations
    );
    const producedRefs = this.selectedCoreRefs(context)
      .filter(
        (ref) => ref.kind !== TERMINAL_KIND && ref.kind !== GATE_KIND && ref.kind !== HANDOFF_KIND
      )
      .sort((left, right) => (left.artifact_id < right.artifact_id ? -1 : 1));
    const checksum = validateScaP11ChecksumManifestV1(
      withP11Digest(
        {
          schema_id: SCA_P11_CHECKSUM_SCHEMA,
          schema_version: 1 as const,
          phase_id: P11_PHASE,
          run_id: runId,
          revision: report.revision,
          artifacts: producedRefs.map((ref) => ({
            artifact_id: ref.artifact_id,
            kind: ref.kind,
            content_digest: ref.content_digest,
            byte_length: ref.byte_length,
            representation: representationForKind(ref.kind),
          })),
          artifact_count: producedRefs.length,
          final_closure: {
            closed: false,
            deferred_artifact_kinds: [
              CHECKSUM_KIND,
              OBLIGATION_KIND,
              REPORT_KIND,
              GATE_KIND,
              HANDOFF_KIND,
              TERMINAL_KIND,
            ].sort(),
            note: "The manifest and every artifact produced after it cannot bind themselves; they are named here as deferred and are accounted by the report projection, gate, handoff, and terminal rather than silently omitted.",
          },
        },
        "manifest_sha256"
      )
    );
    const checksumRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: CHECKSUM_KIND,
      operationId: `sca-p11-checksum-manifest${suffix}`,
      schemaId: SCA_P11_CHECKSUM_SCHEMA,
      value: checksum,
      upstreamRefs: producedRefs,
    });
    const p11ArtifactRefs: Readonly<Record<string, readonly ArtifactRef[]>> = {
      [SCA_P11_ACCEPTANCE_OBLIGATION_ID]: [reportRef, validationRef],
      "SCA-OBL-REPORT-MARKDOWN": [markdownRef],
      "SCA-OBL-REPORT-STRUCTURED-JSON": [reportRef],
      "SCA-OBL-REPORT-SARIF": [sarifRef],
      "SCA-OBL-REPORT-RECONCILIATION": [reconciliationRef],
      "SCA-OBL-REPORT-CVSS-V4": [scoringRef],
      "SCA-OBL-REPORT-CHECKSUM-MANIFEST": [checksumRef],
      "SCA-OBL-REPORT-EPS-OBLIGATION-LEDGER": [],
      "SCA-OBL-REPORT-VALIDATION-RECORDS": [validationRef],
    };
    const downstreamPending = new Set(
      admitted.p09_ledger?.downstream_pending_required_result_ids ?? []
    );
    const p10DownstreamIds = new Set(admitted.p10_terminal.required_downstream_obligation_ids);
    const isRemainingDownstream = (id: string): boolean =>
      id.startsWith("SCA-OBL-P12-") ||
      id === "SCA-OBL-BOUNDARY-RELEASE-AUTHORITY" ||
      id === "SCA-OBL-BOUNDARY-INDEPENDENT-REVIEW";
    const obligationEntries: ScaP11ObligationLedgerV1["entries"][number][] = [];
    for (const obligationId of Object.keys(p01Obligations).sort()) {
      const definition = p01Obligations[obligationId];
      if (definition === undefined) continue;
      const p11Refs = p11ArtifactRefs[obligationId];
      if (p11Refs !== undefined) {
        obligationEntries.push({
          obligation_id: obligationId,
          scope: definition.scope,
          covered: true,
          coverage: "produced and bound by this exact P11 report revision",
          artifact_refs: [...p11Refs],
        });
        continue;
      }
      if (isRemainingDownstream(obligationId)) {
        obligationEntries.push({
          obligation_id: obligationId,
          scope: definition.scope,
          covered: false,
          coverage:
            "downstream P12 release obligation explicitly retained pending; P11 does not adjudicate release",
          artifact_refs: [],
        });
        continue;
      }
      obligationEntries.push({
        obligation_id: obligationId,
        scope: definition.scope,
        covered: true,
        coverage:
          "accounted by the exact re-derived P01–P10 campaign lineage reaching P11; P11 does not re-adjudicate it",
        artifact_refs: [],
      });
    }
    const p01ObligationIds = Object.keys(p01Obligations).sort();
    const obligation = validateScaP11ObligationLedgerV1(
      withP11Digest(
        {
          schema_id: SCA_P11_OBLIGATION_LEDGER_SCHEMA,
          schema_version: 1 as const,
          phase_id: P11_PHASE,
          run_id: runId,
          revision: report.revision,
          entries: [...obligationEntries].sort((left, right) =>
            left.obligation_id < right.obligation_id ? -1 : 1
          ),
          entry_count: obligationEntries.length,
          uncovered_obligation_ids: obligationEntries
            .filter((entry) => !entry.covered)
            .map((entry) => entry.obligation_id),
        },
        "ledger_sha256"
      )
    );
    const obligationRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: OBLIGATION_KIND,
      operationId: `sca-p11-obligation-ledger${suffix}`,
      schemaId: SCA_P11_OBLIGATION_LEDGER_SCHEMA,
      value: obligation,
      upstreamRefs: [p01ObligationsRef, reportRef, reconciliationRef, scoringRef, validationRef],
    });
    const reportProjection = validateScaP11ReportV1(
      withP11Digest(
        {
          schema_id: SCA_P11_REPORT_SCHEMA,
          schema_version: 1 as const,
          phase_id: P11_PHASE,
          run_id: runId,
          status: report.status,
          latest_revision: report.revision,
          lane: report.lane,
          markdown_ref: markdownRef,
          json_ref: reportRef,
          sarif_ref: sarifRef,
          reconciliation_ref: reconciliationRef,
          scoring_records_ref: scoringRef,
          checksum_manifest_ref: checksumRef,
          obligation_ledger_ref: obligationRef,
          validation_records_ref: validationRef,
          addendum_refs: [],
        },
        "report_sha256"
      )
    );
    const reportProjectionRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: REPORT_KIND,
      operationId: `sca-p11-report${suffix}`,
      schemaId: SCA_P11_REPORT_SCHEMA,
      value: reportProjection,
      upstreamRefs: [
        reportRef,
        markdownRef,
        sarifRef,
        reconciliationRef,
        scoringRef,
        validationRef,
        checksumRef,
        obligationRef,
      ],
    });
    const semanticReview =
      validation.semantic_review_ref === null
        ? null
        : validateScaP11SemanticReviewV1(
            exactJson(
              this.store,
              validation.semantic_review_ref,
              "semantic review",
              validateScaP11SemanticReviewV1
            )
          );
    const disclosures = this.selectedCoreRefs(context)
      .filter((ref) => ref.kind === DISCLOSURE_KIND)
      .map((ref) =>
        validateScaP11DisclosureAdmissionV1(
          exactJson(this.store, ref, "disclosure admission", validateScaP11DisclosureAdmissionV1)
        )
      );

    const predicates = this.gatePredicates({
      admitted,
      report,
      reconciliation,
      sarif,
      scoring,
      validation,
      checksum,
      obligation,
      semantic_review: semanticReview,
      disclosures,
      p01_obligation_ids: p01ObligationIds,
      downstream_pending_ids: downstreamPending,
      p10_downstream_ids: p10DownstreamIds,
    });
    const blockerCodes = uniqueStrings([
      ...(report.status === "incomplete" ? ["p11_report_incomplete"] : []),
      ...(report.missing_sections.length > 0 ? ["p11_missing_report_material"] : []),
      ...(validation.deterministic_passed ? [] : ["p11_deterministic_validation_failed"]),
      ...(validation.semantic_passed ? [] : ["p11_semantic_review_failed"]),
      ...scoring.records
        .filter((record) => record.exception_shape === "unscored_incomplete")
        .map((record) => `p11_unscored:${record.target_id}`),
      ...validation.open_items
        .filter((item) => item.disposition === "retained-incomplete")
        .map((item) => `p11_open_item_retained:${item.target_id}`),
      ...Object.entries(predicates)
        .filter(([, value]) => value !== true)
        .map(([key]) => `p11_predicate_${key}`),
    ]);
    const blockers = blockerCodes;
    const allPredicates = Object.values(predicates).every((value) => value === true);
    const verdict: "pass_ready" | "pass_blocked" =
      report.status === "complete" && allPredicates && blockers.length === 0
        ? "pass_ready"
        : "pass_blocked";
    const gate = validateScaP11GateV1(
      withP11Digest(
        {
          schema_id: SCA_P11_GATE_SCHEMA,
          schema_version: 1 as const,
          phase_id: P11_PHASE,
          criterion_id: "AC-P11" as const,
          verdict,
          report_ref: reportProjectionRef,
          lane: report.lane,
          ...predicates,
          finding_count: report.finding_count,
          record_count: reconciliation.record_count,
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
      phase: P11_PHASE,
      kind: GATE_KIND,
      operationId: `sca-p11-gate${suffix}`,
      schemaId: SCA_P11_GATE_SCHEMA,
      value: gate,
      upstreamRefs: [reportProjectionRef, validationRef],
    });
    const handoff = validateScaP11ToP12TransitionV1(
      withP11Digest(
        {
          schema_id: SCA_P11_TO_P12_TRANSITION_SCHEMA,
          schema_version: 1 as const,
          source_phase_id: P11_PHASE,
          target_phase_id: "SCA-P12" as const,
          handoff_kind: "accepted_report_evidence_only" as const,
          qualification_scope: "reporting_gate_only_not_p12_release" as const,
          phase_gate_passed: false as const,
          p12_release_authorized_by_this_transition: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          campaign_completion_claimed: false as const,
          report_ref: reportProjectionRef,
          reconciliation_ref: reconciliationRef,
          validation_records_ref: validationRef,
          gate_ref: gateRef,
          obligation_ledger_ref: obligationRef,
          checksum_manifest_ref: checksumRef,
          lane: report.lane,
          retained_gap_refs: [...admitted.unresolved_item_refs],
          required_downstream_obligation_ids: [...SCA_P11_DOWNSTREAM_OBLIGATION_IDS],
          required_gaps_retained: true as const,
        },
        "transition_sha256"
      )
    );
    const handoffRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: HANDOFF_KIND,
      operationId: `sca-p11-to-p12-transition${suffix}`,
      schemaId: SCA_P11_TO_P12_TRANSITION_SCHEMA,
      value: handoff,
      upstreamRefs: [reportProjectionRef, gateRef],
    });
    const status: "reporting_complete" | "reporting_incomplete" =
      verdict === "pass_ready" ? "reporting_complete" : "reporting_incomplete";
    const terminal = validateScaP11TerminalV1(
      withP11Digest(
        {
          schema_id: SCA_P11_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P11_PHASE,
          status,
          lane: report.lane,
          report_ref: reportProjectionRef,
          reconciliation_ref: reconciliationRef,
          validation_records_ref: validationRef,
          gate_ref: gateRef,
          p12_transition_ref: handoffRef,
          p12_handoff_ready: true,
          report_status: report.status,
          missing_downstream_artifacts: [...SCA_P11_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: [...SCA_P11_DOWNSTREAM_OBLIGATION_IDS],
          selected_artifact_refs: uniqueRefs([
            reportProjectionRef,
            reportRef,
            markdownRef,
            sarifRef,
            reconciliationRef,
            scoringRef,
            validationRef,
            checksumRef,
            obligationRef,
            gateRef,
            handoffRef,
            ...this.selectedCoreRefs(context),
          ]).slice(0, 128),
          blocker_codes: blockers,
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          p12_release_authorized: false as const,
          release_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId,
      phase: P11_PHASE,
      kind: TERMINAL_KIND,
      operationId: `sca-p11-terminal${suffix}`,
      schemaId: SCA_P11_TERMINAL_SCHEMA,
      value: terminal,
      upstreamRefs: [reportProjectionRef, gateRef, handoffRef],
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
      artifacts: uniqueRefs([terminalRef, ...terminal.selected_artifact_refs]).slice(0, 128),
      unresolved: blockers.length > 0 ? blockers : ["p11_reporting_remains_separately_adjudicated"],
    });
    context.pendingDirective = directive;
    context.terminalDirective = directive;
    return directive;
  }

  private gatePredicates(input: {
    readonly admitted: ScaP11AdmissionResultV1;
    readonly report: ScaP11ReportJsonV1;
    readonly reconciliation: ScaP11ReconciliationV1;
    readonly sarif: ReturnType<typeof validateScaP11ReportSarifV1>;
    readonly scoring: ScaP11ScoringRecordsV1;
    readonly validation: ReturnType<typeof validateScaP11ValidationRecordsV1>;
    readonly checksum: ReturnType<typeof validateScaP11ChecksumManifestV1>;
    readonly obligation: ReturnType<typeof validateScaP11ObligationLedgerV1>;
    readonly semantic_review: ReturnType<typeof validateScaP11SemanticReviewV1> | null;
    readonly disclosures: readonly ReturnType<typeof validateScaP11DisclosureAdmissionV1>[];
    readonly p01_obligation_ids: readonly string[];
    readonly downstream_pending_ids: ReadonlySet<string>;
    readonly p10_downstream_ids: ReadonlySet<string>;
  }) {
    const { report, reconciliation, sarif, scoring, validation, checksum, obligation } = input;
    const markdown = renderScaP11MarkdownV1(report);
    const markdownIds = new Set(
      [...markdown.matchAll(/^### (sca11find_[a-f0-9]{64}) — /gmu)].map((match) => match[1] ?? "")
    );
    const jsonIds = new Set(report.findings.map((finding) => finding.finding_id));
    const sarifIds = new Set(sarif.results.map((result) => result.finding_id));
    const setEqual =
      jsonIds.size === sarifIds.size &&
      jsonIds.size === markdownIds.size &&
      [...jsonIds].every((id) => sarifIds.has(id) && markdownIds.has(id));
    const reportableRows = reconciliation.rows.filter((row) => row.reportable);
    const semanticOnlyRows = reconciliation.rows.filter(
      (row) => row.semantic_only && row.reportable
    );

    const immutableLineage =
      input.admitted.admission.p10_rederivation_ok &&
      input.admitted.admission.p10_handoff_agreement_ok;

    const expectedUniverse =
      (input.admitted.p09_ledger?.items.length ?? 0) +
      (input.admitted.p10_outcome === null ? 0 : 1) +
      (input.admitted.p10_registry?.candidate_count ?? 0);
    const exhaustiveReconciliation =
      reconciliation.set_equality_valid === true &&
      reconciliation.record_count === expectedUniverse;

    // CWE identifier and name are mandatory for every per-finding block (`P11-R06`).
    const cweComplete = report.findings.every(
      (finding) => finding.cwe_id !== null && finding.cwe_name !== null
    );

    const supportedStatuses = new Set<string>(SCA_P11_SUPPORTED_REPORT_STATUSES);
    const statusMappingValid =
      reconciliation.rows.every((row) => {
        if (row.current_disposition === "not_disposed") {
          return row.report_status === null && !row.reportable;
        }
        return row.report_status === scaP11ReportStatusForDisposition(row.current_disposition);
      }) &&
      report.findings.every(
        (finding) => finding.status !== null && supportedStatuses.has(finding.status)
      );

    const scoredRecords = scoring.records.filter((record) => record.score !== null);
    const bindingScorer = this.binding.scorer ?? null;
    const qualificationOk =
      scoring.scorer_authority_admitted &&
      scoring.scorer_qualification_sha256 !== null &&
      (bindingScorer === null ||
        bindingScorer.qualification.qualification_sha256 === scoring.scorer_qualification_sha256);
    const qualificationRefOk =
      scoring.scorer_qualification_ref === null
        ? bindingScorer?.qualification_ref == null
        : (() => {
            try {
              const reread = resolveScaP11CvssScorerAuthority({
                store: this.store,
                ref: scoring.scorer_qualification_ref,
              });
              return (
                reread.qualification.qualification_sha256 === scoring.scorer_qualification_sha256
              );
            } catch {
              return false;
            }
          })();
    const scoringQualified =
      scoredRecords.length === 0
        ? true
        : qualificationOk &&
          qualificationRefOk &&
          scoredRecords.every((record) => record.nomenclature !== null);

    const exceptionShapesValid = report.findings.every((finding) => {
      const scored =
        finding.exception_shape === "scored" || finding.exception_shape === "none_zero";
      return scored === (finding.cvss_score !== null);
    });

    const checks = new Map(
      validation.deterministic_checks.map((check) => [check.check_id, check.passed])
    );
    const pathsAndRedactionValid =
      checks.get("path_shape") === true &&
      checks.get("redaction_clean") === true &&
      checks.get("host_path_absence") === true &&
      checks.get("safe_curl_prerequisites") === true &&
      !scaP11HasSensitiveContent(markdown) &&
      !scaP11HasSensitiveContent(canonicalJson(report));

    const checksumManifestValid =
      checksum.artifact_count === checksum.artifacts.length &&
      checksum.artifacts.every((entry) => {
        const stored = this.store.refById(entry.artifact_id);
        return (
          stored !== undefined &&
          stored.kind === entry.kind &&
          stored.content_digest === entry.content_digest &&
          stored.byte_length === entry.byte_length
        );
      });

    const requiredObligations = new Set(SCA_P11_REQUIRED_OBLIGATION_IDS);
    const coveredObligations = new Set(
      obligation.entries.filter((entry) => entry.covered).map((entry) => entry.obligation_id)
    );
    const entryIds = obligation.entries.map((entry) => entry.obligation_id).sort();
    const allowedDownstream = new Set<string>([
      ...input.downstream_pending_ids,
      ...input.p10_downstream_ids,
      "SCA-OBL-P12-ACCEPTANCE",
      "SCA-OBL-BOUNDARY-RELEASE-AUTHORITY",
      "SCA-OBL-BOUNDARY-INDEPENDENT-REVIEW",
    ]);
    const obligationLedgerComplete =
      same(entryIds, [...input.p01_obligation_ids].sort()) &&
      [...requiredObligations].every((id) => coveredObligations.has(id)) &&
      obligation.uncovered_obligation_ids.every((id) => allowedDownstream.has(id));

    const latestRevisionOnly =
      validation.revision === report.revision && sarif.revision === report.revision;

    const disclosuresValid =
      input.disclosures.length > 0 &&
      input.disclosures.every(
        (disclosure) =>
          disclosure.decision === "allow" &&
          same(disclosure.required_model, SCA_P11_REQUIRED_MODEL) &&
          disclosure.training === "prohibited" &&
          disclosure.evaluated_before_dispatch === true &&
          !disclosure.secrets_embedded &&
          !disclosure.personal_data_embedded &&
          (disclosure.purpose === SCA_P11_REVIEW_PURPOSE
            ? disclosure.call_id === SCA_P11_REVIEW_CALL_ID
            : disclosure.purpose === SCA_P11_REPAIR_PURPOSE &&
              disclosure.call_id === SCA_P11_REPAIR_CALL_ID)
      );

    const reportingAuthorityRespected =
      input.admitted.reportable &&
      input.admitted.lane === report.lane &&
      immutableLineage &&
      input.semantic_review !== null &&
      input.semantic_review.gate_verdict_set === false;

    const transition = input.admitted.p10_transition;
    const releaseClaimsAbsent =
      transition !== null &&
      transition.phase_gate_passed === false &&
      transition.release_eligible === false &&
      transition.campaign_complete === false &&
      transition.campaign_completion_claimed === false &&
      transition.p11_reporting_authorized_by_this_transition === false &&
      !detectScaP11ReleaseClaim(markdown) &&
      !detectScaP11ReleaseClaim(canonicalJson(report));

    return {
      immutable_p10_lineage_valid: immutableLineage,
      exhaustive_record_reconciliation: exhaustiveReconciliation,
      set_equality_valid: setEqual,
      no_dropped_finding: reportableRows.length === report.findings.length,
      semantic_only_findings_included: semanticOnlyRows.every((row) =>
        report.findings.some((finding) => finding.identity === row.identity)
      ),
      representation_consistency: setEqual,
      deterministic_validation_passed: validation.deterministic_passed,
      semantic_review_passed: validation.semantic_passed,
      no_unresolved_required_item:
        report.status === "complete" &&
        validation.open_items.every((item) => item.disposition !== "retained-incomplete"),
      cwe_metadata_complete: cweComplete,
      status_mapping_valid: statusMappingValid,
      scoring_records_qualified: scoringQualified,
      exception_shapes_valid: exceptionShapesValid,
      paths_and_redaction_valid: pathsAndRedactionValid,
      checksum_manifest_valid: checksumManifestValid,
      obligation_ledger_complete: obligationLedgerComplete,
      latest_revision_only: latestRevisionOnly,
      model_identity_and_disclosure_valid: disclosuresValid,
      p11_reporting_authority_respected: reportingAuthorityRespected,
      p12_or_release_claims_absent: releaseClaimsAbsent,
    };
  }

  private finalizeNonPositive(context: RunContext, blocker: string): Directive {
    const terminal = validateScaP11TerminalV1(
      withP11Digest(
        {
          schema_id: SCA_P11_TERMINAL_SCHEMA,
          schema_version: 1 as const,
          phase_id: P11_PHASE,
          status: "blocked_invalid" as const,
          report_ref: null,
          reconciliation_ref: null,
          validation_records_ref: null,
          gate_ref: null,
          p12_transition_ref: null,
          p12_handoff_ready: false,
          report_status: null,
          missing_downstream_artifacts: [...SCA_P11_MISSING_DOWNSTREAM_ARTIFACTS],
          required_downstream_obligation_ids: [
            ...new Set([...SCA_P11_DOWNSTREAM_OBLIGATION_IDS, ...SCA_P11_REQUIRED_OBLIGATION_IDS]),
          ].sort(),
          selected_artifact_refs: this.selectedCoreRefs(context),
          blocker_codes: [blocker],
          phase_gate_passed: false as const,
          release_eligible: false as const,
          campaign_complete: false as const,
          nonterminal_campaign: true as const,
          p12_release_authorized: false as const,
          release_adjudication_performed: false as const,
        },
        "terminal_sha256"
      )
    );
    const terminalRef = persistJson({
      store: this.store,
      context,
      runId: context.identity.run_id,
      phase: P11_PHASE,
      kind: TERMINAL_KIND,
      operationId: "sca-p11-terminal-blocked-invalid",
      schemaId: SCA_P11_TERMINAL_SCHEMA,
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
      RECONCILIATION_KIND,
      SCORING_KIND,
      REPORT_JSON_KIND,
      REPORT_MARKDOWN_KIND,
      REPORT_SARIF_KIND,
      VALIDATION_KIND,
      PAYLOAD_KIND,
      DISCLOSURE_KIND,
      REVIEW_OUTPUT_KIND,
      REPAIR_PATCH_KIND,
      REPAIR_RECORD_KIND,
      CHECKSUM_KIND,
      OBLIGATION_KIND,
      REPORT_KIND,
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

export const SCA_P11_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Consume the exact recorded P10 learning result plus the complete reconciled record universe, produce the exact accepted report set (Markdown, JSON, SARIF) from one accepted finding/disposition projection, perform deterministic validation and separate evidence-aware semantic review, route actionable defects through bounded repair that re-enters both checks, and emit a derived readiness gate, a non-authorizing P12 handoff, and durable non-positive terminal accounting.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: SCA_P11_CANDIDATE_START_SCHEMA,
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
        name: "p11_admission",
        kind: ADMISSION_KIND,
        schema: SCA_P11_ADMISSION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_reconciliation",
        kind: RECONCILIATION_KIND,
        schema: SCA_P11_RECONCILIATION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_scoring_records",
        kind: SCORING_KIND,
        schema: SCA_P11_SCORING_RECORDS_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_report_json",
        kind: REPORT_JSON_KIND,
        schema: SCA_P11_REPORT_JSON_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_report_markdown",
        kind: REPORT_MARKDOWN_KIND,
        schema: SCA_P11_REPORT_MARKDOWN_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_report_sarif",
        kind: REPORT_SARIF_KIND,
        schema: SCA_P11_REPORT_SARIF_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_validation_records",
        kind: VALIDATION_KIND,
        schema: SCA_P11_VALIDATION_RECORDS_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_report",
        kind: REPORT_KIND,
        schema: SCA_P11_REPORT_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_gate",
        kind: GATE_KIND,
        schema: SCA_P11_GATE_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_to_p12_transition",
        kind: HANDOFF_KIND,
        schema: SCA_P11_TO_P12_TRANSITION_SCHEMA,
        direction: "output",
        min: 0,
      }),
      port({
        name: "p11_terminal",
        kind: TERMINAL_KIND,
        schema: SCA_P11_TERMINAL_SCHEMA,
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
    policy_id: "penny.sca-p11-candidate-budget.v1",
    resolver_id: "scaP11CandidateDeterministicResolver",
    admission_id: "scaP11CandidateAdmission",
    snapshot_id: "scaP11CandidateSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [SCA_P11_FINALIZING_STATE],
    required_visited_states: [SCA_P11_FINALIZING_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: SCA_P11_TERMINAL_SCHEMA,
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

function buildExpectedInputs(constraints: Static<typeof ScaP11CandidateStartV1Schema>): {
  readonly slot: string;
  readonly ref: ArtifactRef;
}[] {
  const optional = (
    slot: string,
    ref: ArtifactRef | null | undefined
  ): { slot: string; ref: ArtifactRef }[] =>
    ref === null || ref === undefined ? [] : [{ slot, ref }];
  return [
    { slot: "p10_terminal", ref: constraints.p10_terminal_ref },
    ...optional("p10_transition", constraints.p10_transition_ref),
    ...optional("p10_outcome", constraints.p10_outcome_ref),
    ...optional("p10_gate", constraints.p10_gate_ref),
    ...optional("p10_admission", constraints.p10_admission_ref),
    ...optional("p10_eligibility_ledger", constraints.p10_eligibility_ledger_ref),
    ...optional("p10_candidate_registry", constraints.p10_candidate_registry_ref),
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
    { slot: "baseline_evidence", ref: constraints.baseline_evidence_ref },
    { slot: "p10_disclosure_scope", ref: constraints.p10_disclosure_scope_ref },
    { slot: "promotion_authority", ref: constraints.promotion_authority_ref },
    ...constraints.active_run_rule_release_refs.map((ref, index) => ({
      slot: `active_run_rule_release_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...optional("p09_coverage_input", constraints.p09_coverage_input_ref),
    ...constraints.p09_phase_evidence_refs.map((ref, index) => ({
      slot: `p09_phase_evidence_${String(index).padStart(4, "0")}`,
      ref,
    })),
    ...optional("p09_obligation_resolution", constraints.p09_obligation_resolution_ref),
    ...optional("p09_reassessment", constraints.p09_reassessment_ref),
    ...optional("p10_reassessment", constraints.p10_reassessment_ref),
    ...optional("p10_prior_ledger", constraints.p10_prior_ledger_ref),
    { slot: "p11_disclosure_scope", ref: constraints.p11_disclosure_scope_ref },
    ...optional("p11_repair_disclosure_scope", constraints.p11_repair_disclosure_scope_ref),
    { slot: "scoring_policy", ref: constraints.scoring_policy_ref },
    { slot: "report_policy", ref: constraints.report_policy_ref },
    ...optional("p11_reassessment", constraints.p11_reassessment_ref),
    ...optional("p11_prior_report", constraints.p11_prior_report_ref),
  ];
}

const START_ADMISSION: StartAdmissionV1 = {
  schema_id: SCA_P11_CANDIDATE_START_SCHEMA,
  schema_version: 1,
  prepare(request: StartRequest): PreparedStartV1 {
    const constraints = validateScaP11CandidateStart(request.constraints);
    if (request.identity.playbook !== SCA_P11_CANDIDATE_PLAYBOOK_NAME) {
      throw new Error("SCA P11 start identity is invalid");
    }
    if (constraints.run_id !== request.identity.run_id) {
      throw new Error("SCA P11 start run identity is invalid");
    }
    const inputs: InputArtifacts | undefined = request.input_artifacts;
    const expected = buildExpectedInputs(constraints);
    // The exact lineage refs are carried by the request constraints. When the caller supplies them
    // as composition inputs they must match exactly; they are otherwise bound into the request
    // artifact's upstream refs by `materialize`. The contract declares no composition input ports,
    // so the prepared start intentionally omits them and the engine's composition validator must
    // never be asked to match an undeclared port.
    if (
      inputs !== undefined &&
      (inputs.artifacts.length !== expected.length ||
        expected.some(
          (entry, index) =>
            inputs.artifacts[index]?.slot !== entry.slot ||
            !same(inputs.artifacts[index]?.ref, entry.ref)
        ))
    ) {
      throw new Error("SCA P11 start inputs do not equal the declared exact lineage refs");
    }
    return {
      schema_id: SCA_P11_CANDIDATE_START_SCHEMA,
      schema_version: 1,
      request,
      goal: request.goal,
      constraints,
      admission_data: constraints,
    };
  },
  materialize(prepared, host) {
    if (host.artifactStore === undefined) {
      throw new Error("SCA P11 materialization requires the artifact host store");
    }
    const constraints = validateScaP11CandidateStart(prepared.constraints);
    const requestRef = persistJson({
      store: host.artifactStore,
      runId: host.run_id,
      phase: P11_PHASE,
      kind: REQUEST_KIND,
      operationId: "sca-p11-candidate-request",
      schemaId: SCA_P11_CANDIDATE_START_SCHEMA,
      value: constraints,
      upstreamRefs: buildExpectedInputs(constraints).map((entry) => entry.ref),
    });
    return [requestRef];
  },
};

function buildScaP11CandidateRegistration(binding: ScaP11CandidateBindingV1): PlaybookRegistration {
  const registration: PlaybookRegistration = {
    name: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
    contract: SCA_P11_CANDIDATE_SKILL_CONTRACT,
    ingress: "skill" as const,
    start_admission: START_ADMISSION,
    caller_documentation: {
      constraints_schema: ScaP11CandidateStartV1Schema,
      example: {
        goal: "Run the inactive P11 reporting, semantic-review, and bounded-repair candidate.",
        constraints: {
          p10_terminal_ref: {},
          p10_transition_ref: null,
          p09_terminal_ref: {},
          p08_terminal_ref: {},
          p01_obligation_ledger_ref: {},
          baseline_evidence_ref: {},
          p10_disclosure_scope_ref: {},
          promotion_authority_ref: {},
          p11_disclosure_scope_ref: {},
          scoring_policy_ref: {},
          report_policy_ref: {},
        },
      },
      semantic_caveat:
        "P11 reports, reviews, and performs a bounded repair only. It runs no scanner, adapter, graph query, target execution, or independent verification; it does not re-disposition, re-learn, adjudicate release, publish, or complete a campaign, and it always emits a non-positive terminal.",
    },
    liveness: {
      resolver_id: SCA_P11_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
      resolve: () =>
        ordinaryLivenessPolicy({ scope: "sca-p11-candidate", preset: "deterministic-host" }),
      thinking_policy: "agent_ssot" as const,
    },
    worker: {
      kind: "catalog-agent" as const,
      workflow_name: SCA_P11_CANDIDATE_PLAYBOOK_NAME,
      guidance: SCA_P11_CANDIDATE_SKILL_CONTRACT.guidance,
      guidance_required: true as const,
      result_transport: "persisted_summary" as const,
      opening_policy: "registration_guidance_task_artifacts" as const,
      model_policy: "directive_override_or_runtime_default" as const,
      phases: new Map([
        [
          SCA_P11_REVIEWING_STATE,
          {
            agent: SCA_P11_REVIEWER_AGENT,
            result_schema_id: SCA_P11_SEMANTIC_REVIEW_SCHEMA,
            result_schema_version: 1 as const,
            schema: ScaP11SemanticReviewV1Schema,
            allowed_tools: SCA_P11_REQUIRED_TOOL_SUBSET,
            required_model: SCA_P11_REQUIRED_MODEL,
            provider_opening_guard: SCA_P11_PROVIDER_OPENING_GUARD,
          },
        ],
        [
          SCA_P11_REPAIRING_STATE,
          {
            agent: SCA_P11_REVIEWER_AGENT,
            result_schema_id: SCA_P11_REPAIR_PATCH_SCHEMA,
            result_schema_version: 1 as const,
            schema: ScaP11RepairPatchV1Schema,
            allowed_tools: SCA_P11_REQUIRED_TOOL_SUBSET,
            required_model: SCA_P11_REQUIRED_MODEL,
            provider_opening_guard: SCA_P11_PROVIDER_OPENING_GUARD,
          },
        ],
      ]),
    },
    host_states: [
      "sca_p11_admitting",
      "sca_p11_reconciling",
      "sca_p11_rendering",
      "sca_p11_scoring",
      "sca_p11_validating",
      SCA_P11_FINALIZING_STATE,
    ],
    completionReceiptPredicates: new Map(),
    construct: (options) => {
      if (options.artifactStore === undefined) {
        throw new Error("SCA P11 candidate requires the artifact host store");
      }
      return new ScaP11CandidatePlaybook(
        options.artifactStore,
        binding,
        options.trustedClock ?? (() => new Date())
      );
    },
  };
  return Object.freeze(registration);
}

/** Production composition factory requiring an injected exact qualified CVSS scorer authority. */
export function createScaP11CandidateRegistrationV1(input: {
  readonly scorer: ScaP11CvssScorerAuthorityV1;
  readonly repair_budget?: number;
  readonly resolve_current_p07_authority_ref?: ScaP11CandidateBindingV1["resolve_current_p07_authority_ref"];
  readonly resolve_current_p01_obligation_head_ref?: ScaP11CandidateBindingV1["resolve_current_p01_obligation_head_ref"];
}): PlaybookRegistration {
  if (input.scorer === undefined || typeof input.scorer.score !== "function") {
    throw new Error("SCA P11 candidate requires an injected qualified CVSS scorer authority");
  }
  return buildScaP11CandidateRegistration({
    scorer: input.scorer,
    repair_budget: input.repair_budget ?? 0,
    ...(input.resolve_current_p07_authority_ref === undefined
      ? {}
      : { resolve_current_p07_authority_ref: input.resolve_current_p07_authority_ref }),
    ...(input.resolve_current_p01_obligation_head_ref === undefined
      ? {}
      : { resolve_current_p01_obligation_head_ref: input.resolve_current_p01_obligation_head_ref }),
  });
}

/** Fixed provider-free compatibility fixture used by focused tests. It admits no scorer. */
export const SCA_P11_CANDIDATE_REGISTRATION: PlaybookRegistration =
  buildScaP11CandidateRegistration({});

export function buildScaP11CandidateRegistrationWithBindingV1(
  binding: ScaP11CandidateBindingV1
): PlaybookRegistration {
  return buildScaP11CandidateRegistration(binding);
}
