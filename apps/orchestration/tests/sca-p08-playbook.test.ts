import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  ExecutionReceiptSchema,
  validateContract,
  type ArtifactRef,
  type Directive,
  type JsonValue,
  type StartRequest,
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { trustedInvocationDigest } from "../dist/receipts.js";
import {
  MODEL_DISPATCH_GUARD_V1_SCHEMA,
  MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
} from "../dist/required-model.js";
import { SCA_PHASE_REGISTRY } from "../dist/sca/phase-registry.js";
import {
  SCA_P08_ASSESSING_STATE,
  SCA_P08_ASSESSMENT_SCHEMA,
  SCA_P08_ASSESSOR_AGENT,
  SCA_P08_PROVIDER_OPENING_GUARD,
  SCA_P08_REQUIRED_MODEL,
  SCA_P08_REVIEWING_STATE,
  SCA_P08_REVIEWER_AGENT,
  SCA_P08_REVIEW_SCHEMA,
  validateScaP08CognitivePayloadV1,
  validateScaP08DisclosureAdmissionV1,
  validateScaP08DispositionRevisionV1,
  validateScaP08EvidenceLedgerV1,
  validateScaP08GateV1,
  validateScaP08ToP09TransitionV1,
  type ScaP08CognitivePayloadV1,
} from "../dist/sca/p08-contracts.js";
import {
  SCA_P08_ASSESSMENT_OUTPUT_KIND,
  SCA_P08_CANDIDATE_PLAYBOOK_NAME,
  SCA_P08_CANDIDATE_REGISTRATION,
  ScaP08CandidatePlaybook,
} from "../dist/sca/p08-playbook.js";
import { PLAYBOOK_REGISTRY, validateRegistrationContract } from "../dist/playbooks/registry.js";
import {
  buildScaP08EquivalenceProof,
  buildScaP08Lineage,
  buildScaP08Reassessment,
  scaP08StartRequest,
  type ScaP08LineageV1,
} from "./sca-p08-lineage.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p08-playbook-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is absent`);
  return value;
}
function readJson(artifacts: ArtifactStore, ref: ArtifactRef): unknown {
  return JSON.parse(artifacts.readById(ref.artifact_id).toString("utf8"));
}
function context(runId: string, refs: readonly ArtifactRef[]): RunContext {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: SCA_P08_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise inactive P08.",
    constraints: {},
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 6,
    initialArtifacts: refs,
  });
}

function materialize(
  artifacts: ArtifactStore,
  lineage: ScaP08LineageV1,
  reassessmentRef: ArtifactRef | null = null,
  equivalenceProofRefs: readonly ArtifactRef[] = []
): { readonly run: RunContext; readonly playbook: ScaP08CandidatePlaybook } {
  const startAdmission = required(
    SCA_P08_CANDIDATE_REGISTRATION.start_admission,
    "P08 start admission"
  );
  const request = scaP08StartRequest(
    lineage,
    "Exercise inactive P08.",
    reassessmentRef,
    equivalenceProofRefs
  );
  const startRequest: StartRequest = {
    schema_version: 2,
    action: "start",
    identity: request.identity,
    goal: request.goal,
    constraints: request.constraints,
    project_root: PROJECT_ROOT,
    trust_profile: "hardened-untrusted",
    input_artifacts: request.inputArtifacts,
  };
  const prepared = startAdmission.prepare(startRequest, {});
  const refs = startAdmission.materialize(prepared, {
    run_id: lineage.run_id,
    artifactStore: artifacts,
    trustedClock: () => new Date("2026-09-26T00:00:03.000Z"),
  });
  const run = context(lineage.run_id, refs);
  const playbook = new ScaP08CandidatePlaybook(
    artifacts,
    {},
    () => new Date("2026-09-26T00:00:03.000Z")
  );
  return { run, playbook };
}

function persistEvidence(
  artifacts: ArtifactStore,
  runId: string,
  directive: Extract<Directive, { action: "invoke_agent" }>,
  details: unknown,
  overrides: {
    readonly observed_model?: { readonly provider: string; readonly model: string };
    readonly provider_opening_guard?: string;
  } = {}
): ArtifactRef {
  const output = artifacts.persist({
    metadata: directive.output_artifact,
    content: `SUMMARY:${canonicalJson(details)}`,
  });
  const coordinate = {
    run_id: runId,
    state_id: directive.state_id,
    branch_id: null,
    agent: directive.agent,
    attempt: directive.attempt,
  };
  const guard = artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: directive.state_id,
      branch_id: null,
      kind: "model-dispatch-guard",
      operation_id: modelDispatchGuardOperationId(coordinate),
      version: 1,
      producer: "host:required-model-runtime",
      media_type: "application/json",
      content_schema: { schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson({
      schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA,
      schema_version: 1,
      coordinate,
      registration_sha256: "3".repeat(64),
      requested_model: SCA_P08_REQUIRED_MODEL,
      input_artifacts_sha256: sha256(canonicalJson(directive.input_artifacts)),
      serialized_opening_sha256: "4".repeat(64),
      serialized_opening_byte_length: 100,
      provider_opening_guard: overrides.provider_opening_guard ?? SCA_P08_PROVIDER_OPENING_GUARD,
      guarded_at: "2026-09-26T00:00:01.000Z",
    }),
  });
  const receipt = validateContract(
    ExecutionReceiptSchema,
    {
      schema_version: 2,
      receipt_id: "receipt-p08",
      run_id: runId,
      state_id: directive.state_id,
      branch_id: null,
      agent: directive.agent,
      attempt: directive.attempt,
      worker_id: "worker-p08",
      executor: "pi-sdk",
      command: ["pi-sdk", directive.agent],
      model: SCA_P08_REQUIRED_MODEL.override,
      requested_model: SCA_P08_REQUIRED_MODEL,
      observed_model: overrides.observed_model ?? {
        provider: SCA_P08_REQUIRED_MODEL.provider,
        model: SCA_P08_REQUIRED_MODEL.model,
      },
      working_directory: PROJECT_ROOT,
      trust_profile: "hardened-untrusted",
      started_at: "2026-09-26T00:00:01.000Z",
      ended_at: "2026-09-26T00:00:02.000Z",
      exit_code: 0,
      output_digest: output.content_digest,
      output_artifact_ref: output,
      trusted_invocation_digest: trustedInvocationDigest({
        identity: directive.identity,
        state_id: directive.state_id,
        branch_id: null,
        agent: directive.agent,
        attempt: directive.attempt,
        trust_profile: directive.trust_profile,
        model_override: directive.model_override ?? null,
        task_sha256: sha256(directive.task),
        input_artifacts: directive.input_artifacts,
        output_artifact: directive.output_artifact,
      }),
      signature: `hmac-sha256:${"9".repeat(64)}`,
    },
    "P08 test receipt"
  );
  artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: directive.state_id,
      branch_id: null,
      kind: "model-execution-receipt",
      operation_id: modelExecutionReceiptOperationId(coordinate),
      version: 1,
      producer: "host:required-model-runtime",
      media_type: "application/json",
      content_schema: { schema_id: MODEL_EXECUTION_RECEIPT_V1_SCHEMA, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [guard],
    },
    content: canonicalJson({
      schema_id: MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      dispatch_guard_ref: guard,
      execution_receipt: receipt,
    }),
  });
  return output;
}
function payloadFor(artifacts: ArtifactStore, directive: Directive): ScaP08CognitivePayloadV1 {
  if (directive.action !== "invoke_agent") throw new Error("expected P08 model directive");
  const ref = required(directive.input_artifacts.artifacts[0]?.ref, "P08 payload ref");
  return validateScaP08CognitivePayloadV1(readJson(artifacts, ref));
}

function assessmentDetails(
  payload: ScaP08CognitivePayloadV1,
  scopeRef: ArtifactRef
): Record<string, JsonValue> {
  return {
    schema_id: SCA_P08_ASSESSMENT_SCHEMA,
    schema_version: 1,
    role: "evidence_disposition_assessor",
    payload_sha256: payload.payload_sha256,
    assigned_item_ids: payload.assigned_item_ids,
    items: payload.items.map((item) => ({
      item_id: item.item_id,
      item_kind: item.item_kind,
      disposition: "out-of-scope",
      claim: null,
      supporting_evidence_refs: [],
      defeating_evidence_refs: [],
      evidence_mode: "none",
      actor_state_stimulus_verified: false,
      target_reachability_observed: false,
      distinguishing_oracle: null,
      complete_code_control_state_evidence: false,
      finite_clean_fuzzing_only: false,
      unresolved_material_link: null,
      resolution_evidence_need: null,
      deferral_reason: null,
      reopening_conditions: [],
      duplicate_of_item_id: null,
      equivalence_evidence_refs: [],
      scope_evidence_ref: scopeRef,
      repository_path: null,
      line_start: null,
      line_end: null,
    })),
    complete: true,
  };
}

function reviewDetails(
  payload: ScaP08CognitivePayloadV1,
  assessmentSha: string,
  scopeRef: ArtifactRef
): Record<string, JsonValue> {
  return {
    schema_id: SCA_P08_REVIEW_SCHEMA,
    schema_version: 1,
    role: "evidence_disposition_reviewer",
    payload_sha256: payload.payload_sha256,
    assessment_sha256: assessmentSha,
    assigned_item_ids: payload.assigned_item_ids,
    items: payload.items.map((item) => ({
      item_id: item.item_id,
      item_kind: item.item_kind,
      verdict: "not_permitted",
      exact_record_refs: [scopeRef],
      rationale: "Independent review of the exact admitted lineage.",
    })),
    complete: true,
  };
}

function scopeRefOf(lineage: ScaP08LineageV1): ArtifactRef {
  const ref = lineage.admission.evidence_refs.find(
    (candidate) => candidate.kind === "sca-p06-accepted-cohort"
  );
  return required(ref, "P06 accepted cohort scope evidence");
}

function scopeDecisionRefOf(lineage: ScaP08LineageV1, kind: string): ArtifactRef {
  return required(
    lineage.admission.scope_decision_refs.find((ref) => ref.kind === kind),
    `admitted ${kind} scope decision`
  );
}

function startAssessment(
  artifacts: ArtifactStore,
  lineage: ScaP08LineageV1,
  reassessmentRef: ArtifactRef | null = null,
  equivalenceProofRefs: readonly ArtifactRef[] = []
): {
  readonly run: RunContext;
  readonly playbook: ScaP08CandidatePlaybook;
  readonly directive: Extract<Directive, { action: "invoke_agent" }>;
} {
  const { run, playbook } = materialize(artifacts, lineage, reassessmentRef, equivalenceProofRefs);
  const directive = playbook.initialize(run);
  if (directive.action !== "invoke_agent") throw new Error("expected P08 assessment directive");
  expect(directive.state_id).toBe(SCA_P08_ASSESSING_STATE);
  expect(directive.agent).toBe(SCA_P08_ASSESSOR_AGENT);
  return { run, playbook, directive };
}

function runToReview(
  artifacts: ArtifactStore,
  run: RunContext,
  playbook: ScaP08CandidatePlaybook,
  directive: Extract<Directive, { action: "invoke_agent" }>,
  assessment: Record<string, JsonValue>
): {
  readonly directive: Extract<Directive, { action: "invoke_agent" }>;
  readonly payload: ScaP08CognitivePayloadV1;
} {
  const assessmentOutput = persistEvidence(artifacts, run.identity.run_id, directive, assessment);
  run.selectedArtifacts.push(assessmentOutput);
  const reviewDirective = playbook.acceptSummary(run, assessment, "CERTAIN");
  if (reviewDirective.action !== "invoke_agent") throw new Error("expected P08 review directive");
  expect(reviewDirective.state_id).toBe(SCA_P08_REVIEWING_STATE);
  return { directive: reviewDirective, payload: payloadFor(artifacts, reviewDirective) };
}

function completeReview(
  artifacts: ArtifactStore,
  run: RunContext,
  playbook: ScaP08CandidatePlaybook,
  directive: Extract<Directive, { action: "invoke_agent" }>,
  review: Record<string, JsonValue>
): Directive {
  const output = persistEvidence(artifacts, run.identity.run_id, directive, review);
  run.selectedArtifacts.push(output);
  return playbook.acceptSummary(run, review, "CERTAIN");
}

type P08PayloadItem = ScaP08CognitivePayloadV1["items"][number];
type ScaP08Verdict = "permits_confirmation" | "permits_refutation" | "not_permitted";

function assertionFor(
  item: P08PayloadItem,
  overrides: Record<string, JsonValue> = {}
): Record<string, JsonValue> {
  return {
    item_id: item.item_id,
    item_kind: item.item_kind,
    disposition: "inconclusive",
    claim: null,
    supporting_evidence_refs: [],
    defeating_evidence_refs: [],
    evidence_mode: "none",
    actor_state_stimulus_verified: false,
    target_reachability_observed: false,
    distinguishing_oracle: null,
    complete_code_control_state_evidence: false,
    finite_clean_fuzzing_only: false,
    unresolved_material_link: "unresolved causal link",
    resolution_evidence_need: "the resolving evidence",
    deferral_reason: null,
    reopening_conditions: [],
    duplicate_of_item_id: null,
    equivalence_evidence_refs: [],
    scope_evidence_ref: null,
    repository_path: null,
    line_start: null,
    line_end: null,
    ...overrides,
  };
}

function assessmentFor(
  payload: ScaP08CognitivePayloadV1,
  build: (item: P08PayloadItem) => Record<string, JsonValue>
): Record<string, JsonValue> {
  return {
    schema_id: SCA_P08_ASSESSMENT_SCHEMA,
    schema_version: 1,
    role: "evidence_disposition_assessor",
    payload_sha256: payload.payload_sha256,
    assigned_item_ids: payload.assigned_item_ids,
    items: payload.items.map(build),
    complete: true,
  };
}

function reviewFor(
  payload: ScaP08CognitivePayloadV1,
  assessmentSha: string,
  verdict: ScaP08Verdict,
  exactRefs: readonly ArtifactRef[]
): Record<string, JsonValue> {
  return {
    schema_id: SCA_P08_REVIEW_SCHEMA,
    schema_version: 1,
    role: "evidence_disposition_reviewer",
    payload_sha256: payload.payload_sha256,
    assessment_sha256: assessmentSha,
    assigned_item_ids: payload.assigned_item_ids,
    items: payload.items.map((item) => ({
      item_id: item.item_id,
      item_kind: item.item_kind,
      verdict,
      exact_record_refs: [...exactRefs],
      rationale: "Independent review bound to exact admitted records.",
    })),
    complete: true,
  };
}

function selectedRef(run: RunContext, kind: string): ArtifactRef {
  return required(
    run.selectedArtifacts.find((ref) => ref.kind === kind),
    `selected ${kind}`
  );
}

/**
 * A non-action subject. P07 not-invoked actions can never be confirmed or refuted, so the
 * destination-predicate cases use a hypothesis/obligation item instead.
 */
function nonActionId(ledger: ReturnType<typeof validateScaP08EvidenceLedgerV1>): string {
  return required(
    ledger.items.find((row) => row.item_kind === "hypothesis") ??
      ledger.items.find((row) => row.item_kind === "obligation"),
    "non-action subject row"
  ).item_id;
}

function driveComplete(
  artifacts: ArtifactStore,
  lineage: ScaP08LineageV1,
  buildAssessment: (payload: ScaP08CognitivePayloadV1) => Record<string, JsonValue>,
  buildReview: (
    payload: ScaP08CognitivePayloadV1,
    assessmentSha: string
  ) => Record<string, JsonValue>,
  reassessmentRef: ArtifactRef | null = null,
  equivalenceProofRefs: readonly ArtifactRef[] = []
): { readonly run: RunContext; readonly terminal: Record<string, JsonValue> } {
  const { run, playbook, directive } = startAssessment(
    artifacts,
    lineage,
    reassessmentRef,
    equivalenceProofRefs
  );
  const payload = payloadFor(artifacts, directive);
  const assessment = buildAssessment(payload);
  const review = runToReview(artifacts, run, playbook, directive, assessment);
  const assessmentRef = selectedRef(run, "sca-p08-disposition-assessment");
  const terminalDirective = completeReview(
    artifacts,
    run,
    playbook,
    review.directive,
    buildReview(review.payload, assessmentRef.content_digest)
  );
  if (terminalDirective.action !== "incomplete") throw new Error("expected P08 terminal");
  return { run, terminal: terminalDirective.result as Record<string, JsonValue> };
}

/**
 * Drive one assessment and one independent review to the terminal, returning the terminal and the
 * validated gate. The review always uses `not_permitted`, so the outcome is decided entirely by the
 * assessment's support semantics.
 */
function completeWith(
  artifacts: ArtifactStore,
  run: RunContext,
  playbook: ScaP08CandidatePlaybook,
  directive: Extract<Directive, { action: "invoke_agent" }>,
  payload: ScaP08CognitivePayloadV1,
  assessment: Record<string, JsonValue>,
  scopeRef: ArtifactRef
): {
  readonly terminal: Record<string, JsonValue>;
  readonly gate: ReturnType<typeof validateScaP08GateV1>;
} {
  const assessmentOutput = persistEvidence(artifacts, run.identity.run_id, directive, assessment);
  run.selectedArtifacts.push(assessmentOutput);
  const reviewDirective = playbook.acceptSummary(run, assessment, "CERTAIN");
  if (reviewDirective.action !== "invoke_agent") throw new Error("expected P08 review directive");
  const assessmentRef = selectedRef(run, "sca-p08-disposition-assessment");
  const reviewPayload = payloadFor(artifacts, reviewDirective);
  const review = reviewFor(reviewPayload, assessmentRef.content_digest, "not_permitted", [
    scopeRef,
  ]);
  const reviewOutput = persistEvidence(artifacts, run.identity.run_id, reviewDirective, review);
  run.selectedArtifacts.push(reviewOutput);
  const terminalDirective = playbook.acceptSummary(run, review, "CERTAIN");
  if (terminalDirective.action !== "incomplete") throw new Error("expected P08 terminal");
  void payload;
  return {
    terminal: terminalDirective.result as Record<string, JsonValue>,
    gate: gateOf(artifacts, run),
  };
}

function outOfScope(scopeRef: ArtifactRef): (item: P08PayloadItem) => Record<string, JsonValue> {
  return (item) =>
    assertionFor(item, { disposition: "out-of-scope", scope_evidence_ref: scopeRef });
}

function reassessmentEntries(
  ledger: ReturnType<typeof validateScaP08EvidenceLedgerV1>,
  build: (row: ReturnType<typeof validateScaP08EvidenceLedgerV1>["items"][number]) => {
    change_reason_codes: readonly string[];
    stimulus_refs: readonly ArtifactRef[];
    duplicate_of_item_id?: string | null;
  }
) {
  return ledger.items.map((row) => ({
    item_id: row.item_id,
    item_kind: row.item_kind,
    identity: row.identity,
    ...build(row),
  }));
}

describe("SCA P08 candidate dispositions", () => {
  it("finalizes an exhaustive non-positive P09 handoff when every item is resolved", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-positive",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const assessmentPayload = payloadFor(artifacts, directive);
    const scopeRef = scopeRefOf(lineage);
    const review = runToReview(
      artifacts,
      run,
      playbook,
      directive,
      assessmentDetails(assessmentPayload, scopeRef)
    );
    const assessmentRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-disposition-assessment"),
      "assessment record"
    );
    const terminalDirective = completeReview(
      artifacts,
      run,
      playbook,
      review.directive,
      reviewDetails(review.payload, assessmentRef.content_digest, scopeRef)
    );
    if (terminalDirective.action !== "incomplete") throw new Error("expected P08 terminal");
    const terminal = terminalDirective.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("candidate_complete");
    expect(terminal["release_eligible"]).toBe(false);
    expect(terminal["campaign_complete"]).toBe(false);
    expect(terminal["phase_gate_passed"]).toBe(false);
    expect(terminal["nonterminal_campaign"]).toBe(true);
    expect(terminal["out_of_scope_count"]).toBe(3);
    const ledgerRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-evidence-ledger"),
      "ledger"
    );
    const ledger = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledgerRef));
    expect(ledger.exhaustive_accounting).toBe(true);
    expect(ledger.items).toHaveLength(3);
    const transitionRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-to-p09-transition"),
      "P09 transition"
    );
    const transition = validateScaP08ToP09TransitionV1(readJson(artifacts, transitionRef));
    expect(transition.handoff_kind).toBe("candidate_disposition_only");
    expect(transition.p09_reconciliation_authorized_by_this_transition).toBe(false);
    const revisions = run.selectedArtifacts.filter(
      (ref) => ref.kind === "sca-p08-disposition-revision"
    );
    expect(revisions).toHaveLength(3);
  });

  it("downgrades a confirmation the host cannot support to inconclusive and blocks", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-no-weakening",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const payload = payloadFor(artifacts, directive);
    const scopeRef = scopeRefOf(lineage);
    const confirmed = {
      ...assessmentDetails(payload, scopeRef),
      items: payload.items.map((item) => ({
        item_id: item.item_id,
        item_kind: item.item_kind,
        disposition: "confirmed",
        claim: "claimed outcome",
        supporting_evidence_refs: [scopeRef],
        defeating_evidence_refs: [],
        evidence_mode: "runtime",
        actor_state_stimulus_verified: true,
        target_reachability_observed: true,
        distinguishing_oracle: null,
        complete_code_control_state_evidence: false,
        finite_clean_fuzzing_only: false,
        unresolved_material_link: null,
        resolution_evidence_need: null,
        deferral_reason: null,
        reopening_conditions: [],
        duplicate_of_item_id: null,
        equivalence_evidence_refs: [],
        scope_evidence_ref: null,
        repository_path: null,
        line_start: null,
        line_end: null,
      })),
    };
    const review = runToReview(artifacts, run, playbook, directive, confirmed);
    const assessmentRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-disposition-assessment"),
      "assessment record"
    );
    const terminalDirective = completeReview(
      artifacts,
      run,
      playbook,
      review.directive,
      reviewDetails(review.payload, assessmentRef.content_digest, scopeRef)
    );
    if (terminalDirective.action !== "incomplete") throw new Error("expected P08 terminal");
    const terminal = terminalDirective.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("blocked");
    expect(terminal["confirmed_count"]).toBe(0);
    expect(terminal["inconclusive_count"]).toBe(3);
    expect(terminal["blocker_codes"]).toContain("p08_disposition_validation_failed");
  });

  it("blocks an independent review that carries no exact-record binding", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-review-invalid",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const payload = payloadFor(artifacts, directive);
    const scopeRef = scopeRefOf(lineage);
    const review = runToReview(
      artifacts,
      run,
      playbook,
      directive,
      assessmentDetails(payload, scopeRef)
    );
    const assessmentRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-disposition-assessment"),
      "assessment record"
    );
    const unbound = {
      ...reviewDetails(review.payload, assessmentRef.content_digest, scopeRef),
      items: review.payload.items.map((item) => ({
        item_id: item.item_id,
        item_kind: item.item_kind,
        verdict: "not_permitted",
        exact_record_refs: [],
        rationale: "no exact record",
      })),
    };
    const terminalDirective = completeReview(artifacts, run, playbook, review.directive, unbound);
    if (terminalDirective.action !== "incomplete") throw new Error("expected P08 terminal");
    const terminal = terminalDirective.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("blocked");
    expect(terminal["blocker_codes"]).toContain("p08_review_invalid");
  });

  it("never lets a review upgrade an inconclusive item to confirmed", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-no-upgrade",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const payload = payloadFor(artifacts, directive);
    const scopeRef = scopeRefOf(lineage);
    const inconclusive = {
      ...assessmentDetails(payload, scopeRef),
      items: payload.items.map((item) => ({
        item_id: item.item_id,
        item_kind: item.item_kind,
        disposition: "inconclusive",
        claim: null,
        supporting_evidence_refs: [],
        defeating_evidence_refs: [],
        evidence_mode: "none",
        actor_state_stimulus_verified: false,
        target_reachability_observed: false,
        distinguishing_oracle: null,
        complete_code_control_state_evidence: false,
        finite_clean_fuzzing_only: false,
        unresolved_material_link: "unresolved causal link",
        resolution_evidence_need: "the resolving evidence",
        deferral_reason: null,
        reopening_conditions: [],
        duplicate_of_item_id: null,
        equivalence_evidence_refs: [],
        scope_evidence_ref: null,
        repository_path: null,
        line_start: null,
        line_end: null,
      })),
    };
    const review = runToReview(artifacts, run, playbook, directive, inconclusive);
    const assessmentRef = required(
      run.selectedArtifacts.find((ref) => ref.kind === "sca-p08-disposition-assessment"),
      "assessment record"
    );
    const permissive = {
      ...reviewDetails(review.payload, assessmentRef.content_digest, scopeRef),
      items: review.payload.items.map((item) => ({
        item_id: item.item_id,
        item_kind: item.item_kind,
        verdict: "permits_confirmation",
        exact_record_refs: [scopeRef],
        rationale: "permits",
      })),
    };
    const terminalDirective = completeReview(
      artifacts,
      run,
      playbook,
      review.directive,
      permissive
    );
    if (terminalDirective.action !== "incomplete") throw new Error("expected P08 terminal");
    const terminal = terminalDirective.result as Record<string, unknown>;
    expect(terminal["confirmed_count"]).toBe(0);
    expect(terminal["inconclusive_count"]).toBe(3);
    expect(terminal["status"]).toBe("blocked");
  });

  it("records a cancelled terminal with no P09 handoff", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-cancel",
      kinds: ["source_query"],
    });
    const { run, playbook } = materialize(artifacts, lineage);
    playbook.initialize(run);
    const directive = playbook.cancel(run, "operator cancelled");
    if (directive.action !== "cancelled") throw new Error("expected cancelled directive");
    const terminal = directive.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("cancelled");
    expect(terminal["evidence_ledger_ref"]).toBeNull();
    expect(terminal["gate_ref"]).toBeNull();
    expect(terminal["p09_transition_ref"]).toBeNull();
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p08-to-p09-transition")).toBe(
      false
    );
  });

  it("admits a blocked P07 checkpoint without any model call", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-blocked-checkpoint",
      kinds: ["source_query"],
      with_transition: false,
    });
    const { run, playbook } = materialize(artifacts, lineage);
    const directive = playbook.initialize(run);
    if (directive.action !== "incomplete") throw new Error("expected P08 terminal");
    const terminal = directive.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("blocked");
    expect(terminal["inconclusive_count"]).toBe(3);
    expect(terminal["blocker_codes"]).toContain("p08_blocked_checkpoint");
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p08-disposition-assessment")).toBe(
      false
    );
  });
});

describe("SCA P08 inactive registration proof", () => {
  it("stays absent from every active registry and changes no public playbook", () => {
    expect(SCA_P08_CANDIDATE_REGISTRATION.name).toBe("sca-p08-candidate");
    expect(SCA_PHASE_REGISTRY.has("sca-p08-candidate")).toBe(false);
    expect(PLAYBOOK_REGISTRY.has("sca-p08-candidate")).toBe(false);
    expect([...PLAYBOOK_REGISTRY.keys()]).not.toContain("sca-p08-candidate");
    expect(validateRegistrationContract(SCA_P08_CANDIDATE_REGISTRATION)).toBe(
      SCA_P08_CANDIDATE_REGISTRATION.contract
    );
    const worker = SCA_P08_CANDIDATE_REGISTRATION.worker;
    if (worker.kind !== "catalog-agent") throw new Error("P08 must be a catalog-agent candidate");
    expect([...worker.phases.keys()]).toEqual([SCA_P08_ASSESSING_STATE, SCA_P08_REVIEWING_STATE]);
    for (const phase of worker.phases.values()) {
      expect(phase.allowed_tools).toEqual([]);
      expect(phase.provider_opening_guard).toBe(SCA_P08_PROVIDER_OPENING_GUARD);
    }
    expect(worker.phases.get(SCA_P08_ASSESSING_STATE)?.agent).toBe(SCA_P08_ASSESSOR_AGENT);
    expect(worker.phases.get(SCA_P08_REVIEWING_STATE)?.agent).toBe(SCA_P08_REVIEWER_AGENT);
  });
});

describe("SCA P08 versioned reassessment", () => {
  it("admits an exact prior P08 ledger and emits versioned revisions under a prior-naming ledger revision", () => {
    using artifacts = store();
    const lineage1 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-ver-1",
      kinds: ["source_query"],
    });
    const scope1 = scopeRefOf(lineage1);
    const first = driveComplete(
      artifacts,
      lineage1,
      (payload) => assessmentFor(payload, outOfScope(scope1)),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope1])
    );
    expect(first.terminal["status"]).toBe("candidate_complete");
    const ledger1Ref = selectedRef(first.run, "sca-p08-evidence-ledger");
    const ledger1 = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledger1Ref));
    expect(ledger1.ledger_revision ?? 1).toBe(1);

    const lineage2 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-ver-2",
      kinds: ["source_query"],
    });
    const scope2 = scopeRefOf(lineage2);
    const reassessmentRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-ver-2",
      prior_ledger_ref: ledger1Ref,
      entries: reassessmentEntries(ledger1, () => ({
        change_reason_codes: ["new_evidence"],
        stimulus_refs: [scope2],
      })),
    });
    const second = driveComplete(
      artifacts,
      lineage2,
      (payload) =>
        assessmentFor(payload, (item) =>
          assertionFor(item, {
            disposition: "inconclusive",
            unresolved_material_link: "new evidence reopened a material link",
            resolution_evidence_need: "renewed exact evidence",
          })
        ),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope2]),
      reassessmentRef
    );
    const ledger2Ref = selectedRef(second.run, "sca-p08-evidence-ledger");
    const ledger2 = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledger2Ref));
    expect(ledger2.ledger_revision).toBe(2);
    expect(ledger2.append_only).toBe(true);
    expect(ledger2Ref.operation_id).not.toBe(ledger1Ref.operation_id);
    expect(ledger2.prior_p08_ledger_ref?.artifact_id).toBe(ledger1Ref.artifact_id);
    expect(ledger2.prior_p08_ledger_sha256).toBe(ledger1Ref.content_digest);
    expect(ledger2.items).toHaveLength(ledger1.items.length);

    for (const row of ledger2.items) {
      const priorRow = required(
        ledger1.items.find((candidate) => candidate.item_id === row.item_id),
        "prior ledger row"
      );
      const revision2 = validateScaP08DispositionRevisionV1(
        readJson(artifacts, row.current_revision_ref)
      );
      expect(revision2.revision).toBe(2);
      expect(revision2.disposition).toBe("inconclusive");
      expect(revision2.parent_revision_ref?.artifact_id).toBe(
        priorRow.current_revision_ref.artifact_id
      );
      expect(revision2.parent_revision_sha256).toBe(priorRow.current_revision_ref.content_digest);
      expect(revision2.change_reason_codes).toEqual(["new_evidence"]);
      expect(revision2.changed_fields.length).toBeGreaterThan(0);
      expect(revision2.review_verdict).toBe("not_permitted");
      expect(revision2.review_ref).not.toBeNull();
      expect(revision2.review_exact_record_refs?.map((ref) => ref.artifact_id)).toEqual([
        scope2.artifact_id,
      ]);
      expect(row.prior_revision_refs.map((ref) => ref.artifact_id)).toEqual([
        priorRow.current_revision_ref.artifact_id,
      ]);
    }
    // Earlier snapshots are retained, never rewritten.
    for (const row of ledger1.items) {
      expect(artifacts.readById(row.current_revision_ref.artifact_id).byteLength).toBe(
        row.current_revision_ref.byte_length
      );
    }
    expect(second.terminal["status"]).toBe("blocked");
  });

  it("covers every SCA-D02 trigger with exact reasons, parents, and changed fields", () => {
    using artifacts = store();
    const kinds = ["source_query", "graph_query"] as const;
    const lineage1 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-five-1",
      kinds,
    });
    const scope1 = scopeRefOf(lineage1);
    const first = driveComplete(
      artifacts,
      lineage1,
      (payload) => assessmentFor(payload, outOfScope(scope1)),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope1])
    );
    const ledger1Ref = selectedRef(first.run, "sca-p08-evidence-ledger");
    const ledger1 = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledger1Ref));
    expect(ledger1.items).toHaveLength(6);
    const rows = ledger1.items;
    const duplicateSubject = required(rows[5], "duplicate subject").item_id;
    const reasons = [
      "new_evidence",
      "invalidated_evidence",
      "changed_snapshot",
      "scope_change",
      "duplicate_resolution",
      "new_evidence",
    ];

    const lineage2 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-five-2",
      kinds,
    });
    const scope2 = scopeRefOf(lineage2);
    const reassessmentRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-five-2",
      prior_ledger_ref: ledger1Ref,
      entries: rows.map((row, index) => {
        const reason = required(reasons[index], "reason code");
        return {
          item_id: row.item_id,
          item_kind: row.item_kind,
          identity: row.identity,
          change_reason_codes: [reason],
          stimulus_refs: [index === 1 ? scope1 : scope2],
          ...(index === 4 ? { duplicate_of_item_id: duplicateSubject } : {}),
        };
      }),
    });
    // Host-issued typed equivalence proof for the exact duplicate pair (rows[4] -> rows[5]).
    const duplicateItem = required(
      lineage2.admission.items.find(
        (candidate) => candidate.item_id === required(rows[4], "duplicate item").item_id
      ),
      "admitted duplicate item"
    );
    const targetItem = required(
      lineage2.admission.items.find((candidate) => candidate.item_id === duplicateSubject),
      "admitted duplicate target"
    );
    const proofRef = buildScaP08EquivalenceProof({
      store: artifacts,
      run_id: "run-p08-five-2",
      duplicate: duplicateItem,
      target: targetItem,
    });
    const second = driveComplete(
      artifacts,
      lineage2,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_id === required(rows[4], "duplicate item").item_id
            ? assertionFor(item, {
                disposition: "duplicate-of",
                duplicate_of_item_id: duplicateSubject,
                equivalence_evidence_refs: [proofRef],
              })
            : assertionFor(item, {
                disposition: "inconclusive",
                unresolved_material_link: "reassessed material link",
                resolution_evidence_need: "reassessed need",
              })
        ),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope2]),
      reassessmentRef,
      [proofRef]
    );
    const ledger2 = validateScaP08EvidenceLedgerV1(
      readJson(artifacts, selectedRef(second.run, "sca-p08-evidence-ledger"))
    );
    expect(ledger2.duplicate_of_count).toBe(1);
    const reasonByItem = new Map(
      rows.map((row, index) => [row.item_id, required(reasons[index], "reason code")])
    );
    for (const row of ledger2.items) {
      const revision2 = validateScaP08DispositionRevisionV1(
        readJson(artifacts, row.current_revision_ref)
      );
      expect(revision2.revision).toBe(2);
      expect(revision2.parent_revision_ref).not.toBeNull();
      expect(revision2.change_reason_codes).toEqual([
        required(reasonByItem.get(row.item_id), "reason"),
      ]);
      expect(revision2.changed_fields.length).toBeGreaterThan(0);
    }
  });

  it("treats a location/severity-only reassessment as a no-op without a new revision", () => {
    using artifacts = store();
    const lineage1 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-noop-1",
      kinds: ["source_query"],
    });
    const scope1 = scopeRefOf(lineage1);
    const rejected = (item: P08PayloadItem, lines: readonly [number, number]) =>
      assertionFor(item, {
        disposition: "rejected-with-evidence",
        claim: "the asserted issue is defeated",
        defeating_evidence_refs: [scope1],
        evidence_mode: "code",
        complete_code_control_state_evidence: true,
        repository_path: "src/value.ts",
        line_start: lines[0],
        line_end: lines[1],
      });
    const first = driveComplete(
      artifacts,
      lineage1,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_kind === "action" ? assertionFor(item) : rejected(item, [10, 20])
        ),
      (payload, sha) => reviewFor(payload, sha, "permits_refutation", [scope1])
    );
    expect(first.terminal["rejected_with_evidence_count"]).toBe(2);
    const ledger1Ref = selectedRef(first.run, "sca-p08-evidence-ledger");
    const ledger1 = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledger1Ref));

    const lineage2 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-noop-2",
      kinds: ["source_query"],
    });
    const reassessmentRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-noop-2",
      prior_ledger_ref: ledger1Ref,
      entries: reassessmentEntries(ledger1, () => ({
        change_reason_codes: ["changed_snapshot"],
        stimulus_refs: [scope1],
      })),
    });
    const second = driveComplete(
      artifacts,
      lineage2,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_kind === "action" ? assertionFor(item) : rejected(item, [30, 40])
        ),
      (payload, sha) => reviewFor(payload, sha, "permits_refutation", [scope1]),
      reassessmentRef
    );
    expect(
      second.run.selectedArtifacts.filter((ref) => ref.kind === "sca-p08-disposition-revision")
    ).toHaveLength(0);
    const ledger2 = validateScaP08EvidenceLedgerV1(
      readJson(artifacts, selectedRef(second.run, "sca-p08-evidence-ledger"))
    );
    expect(ledger2.ledger_revision).toBe(2);
    for (const row of ledger2.items) {
      const priorRow = required(
        ledger1.items.find((candidate) => candidate.item_id === row.item_id),
        "prior ledger row"
      );
      expect(row.current_revision_ref.artifact_id).toBe(priorRow.current_revision_ref.artifact_id);
      expect(row.prior_revision_refs).toHaveLength(0);
    }
  });

  it("requires every destination predicate and a permitting review for uncertain→confirmed", () => {
    using artifacts = store();
    const lineage1 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-up-1",
      kinds: ["source_query"],
    });
    const scope1 = scopeRefOf(lineage1);
    const first = driveComplete(
      artifacts,
      lineage1,
      (payload) => assessmentFor(payload, (item) => assertionFor(item)),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope1])
    );
    const ledger1Ref = selectedRef(first.run, "sca-p08-evidence-ledger");
    const ledger1 = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledger1Ref));
    const subjectId = nonActionId(ledger1);

    const lineage2 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-up-2",
      kinds: ["source_query"],
    });
    const scope2 = scopeRefOf(lineage2);
    const reassessmentRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-up-2",
      prior_ledger_ref: ledger1Ref,
      entries: reassessmentEntries(ledger1, () => ({
        change_reason_codes: ["new_evidence"],
        stimulus_refs: [scope2],
      })),
    });
    const second = driveComplete(
      artifacts,
      lineage2,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_id === subjectId
            ? assertionFor(item, {
                disposition: "confirmed",
                claim: "runtime PoC reached the sink",
                supporting_evidence_refs: [scope2],
                evidence_mode: "runtime",
                actor_state_stimulus_verified: true,
                target_reachability_observed: true,
                distinguishing_oracle: null,
              })
            : assertionFor(item)
        ),
      (payload, sha) => reviewFor(payload, sha, "permits_confirmation", [scope2]),
      reassessmentRef
    );
    expect(second.terminal["confirmed_count"]).toBe(1);
    const ledger2 = validateScaP08EvidenceLedgerV1(
      readJson(artifacts, selectedRef(second.run, "sca-p08-evidence-ledger"))
    );
    const confirmedRow = required(
      ledger2.items.find((row) => row.item_id === subjectId),
      "confirmed row"
    );
    const revision2 = validateScaP08DispositionRevisionV1(
      readJson(artifacts, confirmedRow.current_revision_ref)
    );
    expect(revision2.disposition).toBe("confirmed");
    expect(revision2.change_reason_codes).toEqual(["new_evidence"]);
    expect(revision2.review_verdict).toBe("permits_confirmation");
  });

  it("cannot upgrade to confirmed without a permitting independent review", () => {
    using artifacts = store();
    const lineage1 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-upneg-1",
      kinds: ["source_query"],
    });
    const scope1 = scopeRefOf(lineage1);
    const first = driveComplete(
      artifacts,
      lineage1,
      (payload) => assessmentFor(payload, (item) => assertionFor(item)),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope1])
    );
    const ledger1Ref = selectedRef(first.run, "sca-p08-evidence-ledger");
    const ledger1 = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledger1Ref));
    const subjectId = nonActionId(ledger1);
    const lineage2 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-upneg-2",
      kinds: ["source_query"],
    });
    const scope2 = scopeRefOf(lineage2);
    const reassessmentRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-upneg-2",
      prior_ledger_ref: ledger1Ref,
      entries: reassessmentEntries(ledger1, () => ({
        change_reason_codes: ["new_evidence"],
        stimulus_refs: [scope2],
      })),
    });
    const second = driveComplete(
      artifacts,
      lineage2,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_id === subjectId
            ? assertionFor(item, {
                disposition: "confirmed",
                claim: "claimed",
                supporting_evidence_refs: [scope2],
                evidence_mode: "runtime",
                actor_state_stimulus_verified: true,
                target_reachability_observed: true,
                distinguishing_oracle: null,
              })
            : assertionFor(item)
        ),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope2]),
      reassessmentRef
    );
    expect(second.terminal["confirmed_count"]).toBe(0);
    expect(second.terminal["status"]).toBe("blocked");
  });

  it("enforces the code→PoC destination predicates on upgrade", () => {
    using artifacts = store();
    const lineage1 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-poc-1",
      kinds: ["source_query"],
    });
    const scope1 = scopeRefOf(lineage1);
    const codeConfirmed = (item: P08PayloadItem, ref: ArtifactRef) =>
      assertionFor(item, {
        disposition: "confirmed",
        claim: "code path confirmed",
        supporting_evidence_refs: [ref],
        evidence_mode: "code",
        complete_code_control_state_evidence: true,
      });
    const first = driveComplete(
      artifacts,
      lineage1,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_kind === "action" ? assertionFor(item) : codeConfirmed(item, scope1)
        ),
      (payload, sha) => reviewFor(payload, sha, "permits_confirmation", [scope1])
    );
    const ledger1Ref = selectedRef(first.run, "sca-p08-evidence-ledger");
    const ledger1 = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledger1Ref));
    const subjectId = nonActionId(ledger1);

    const lineage2 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-poc-2",
      kinds: ["source_query"],
    });
    const scope2 = scopeRefOf(lineage2);
    const runtimeConfirmed = (item: P08PayloadItem, ref: ArtifactRef, reachable: boolean) =>
      assertionFor(item, {
        disposition: "confirmed",
        claim: "runtime PoC reached the sink",
        supporting_evidence_refs: [ref],
        evidence_mode: "runtime",
        actor_state_stimulus_verified: true,
        target_reachability_observed: reachable,
        distinguishing_oracle: null,
      });
    const reassessmentRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-poc-2",
      prior_ledger_ref: ledger1Ref,
      entries: reassessmentEntries(ledger1, () => ({
        change_reason_codes: ["new_evidence"],
        stimulus_refs: [scope2],
      })),
    });
    const second = driveComplete(
      artifacts,
      lineage2,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_kind === "action" ? assertionFor(item) : runtimeConfirmed(item, scope2, true)
        ),
      (payload, sha) => reviewFor(payload, sha, "permits_confirmation", [scope2]),
      reassessmentRef
    );
    const ledger2 = validateScaP08EvidenceLedgerV1(
      readJson(artifacts, selectedRef(second.run, "sca-p08-evidence-ledger"))
    );
    const row = required(
      ledger2.items.find((candidate) => candidate.item_id === subjectId),
      "upgraded row"
    );
    const revision2 = validateScaP08DispositionRevisionV1(
      readJson(artifacts, row.current_revision_ref)
    );
    expect(revision2.evidence_mode).toBe("runtime");
    expect(revision2.changed_fields).toContain("evidence_mode");

    // One-defect: a PoC upgrade without observed reachability fails closed.
    const lineage3 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-poc-3",
      kinds: ["source_query"],
    });
    const scope3 = scopeRefOf(lineage3);
    const brokenRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-poc-3",
      prior_ledger_ref: ledger1Ref,
      entries: reassessmentEntries(ledger1, () => ({
        change_reason_codes: ["new_evidence"],
        stimulus_refs: [scope3],
      })),
    });
    const third = driveComplete(
      artifacts,
      lineage3,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_kind === "action" ? assertionFor(item) : runtimeConfirmed(item, scope3, false)
        ),
      (payload, sha) => reviewFor(payload, sha, "permits_confirmation", [scope3]),
      brokenRef
    );
    expect(third.terminal["status"]).toBe("blocked");
    expect(third.terminal["blocker_codes"]).toContain("p08_disposition_validation_failed");
  });

  it("reopens when relied-on evidence is invalidated and never lets it survive as support", () => {
    using artifacts = store();
    const lineage1 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-inv-1",
      kinds: ["source_query"],
    });
    const scope1 = scopeRefOf(lineage1);
    const confirmed = (item: P08PayloadItem, ref: ArtifactRef, claim = "runtime confirmation") =>
      assertionFor(item, {
        disposition: "confirmed",
        claim,
        supporting_evidence_refs: [ref],
        evidence_mode: "runtime",
        actor_state_stimulus_verified: true,
        target_reachability_observed: true,
        distinguishing_oracle: null,
      });
    const first = driveComplete(
      artifacts,
      lineage1,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_kind === "action" ? assertionFor(item) : confirmed(item, scope1)
        ),
      (payload, sha) => reviewFor(payload, sha, "permits_confirmation", [scope1])
    );
    const ledger1Ref = selectedRef(first.run, "sca-p08-evidence-ledger");
    const ledger1 = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledger1Ref));
    const subjectId = nonActionId(ledger1);

    // One-defect: the invalidated ref must not keep supporting a surviving confirmation.
    const lineage2 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-inv-2",
      kinds: ["source_query"],
    });
    const scope2 = scopeRefOf(lineage2);
    const invalidatedRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-inv-2",
      prior_ledger_ref: ledger1Ref,
      entries: reassessmentEntries(ledger1, (row) =>
        row.item_id === subjectId
          ? { change_reason_codes: ["invalidated_evidence"], stimulus_refs: [scope1] }
          : { change_reason_codes: ["changed_snapshot"], stimulus_refs: [scope2] }
      ),
    });
    const second = driveComplete(
      artifacts,
      lineage2,
      (payload) =>
        assessmentFor(payload, (item) =>
          item.item_kind === "action"
            ? assertionFor(item)
            : confirmed(item, scope1, "confirmation reasserted after invalidation")
        ),
      (payload, sha) => reviewFor(payload, sha, "permits_confirmation", [scope1]),
      invalidatedRef
    );
    expect(second.terminal["status"]).toBe("blocked");
    expect(second.terminal["blocker_codes"]).toContain("p08_disposition_validation_failed");

    // Positive: reopening to inconclusive is accepted as a versioned reassessment.
    const lineage3 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-inv-3",
      kinds: ["source_query"],
    });
    const reopenRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-inv-3",
      prior_ledger_ref: ledger1Ref,
      entries: reassessmentEntries(ledger1, (row) =>
        row.item_id === subjectId
          ? { change_reason_codes: ["invalidated_evidence"], stimulus_refs: [scope1] }
          : { change_reason_codes: ["changed_snapshot"], stimulus_refs: [scopeRefOf(lineage3)] }
      ),
    });
    const third = driveComplete(
      artifacts,
      lineage3,
      (payload) =>
        assessmentFor(payload, (item) =>
          assertionFor(item, {
            unresolved_material_link: "invalidated evidence reopened the link",
            resolution_evidence_need: "replacement exact evidence",
          })
        ),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope1]),
      reopenRef
    );
    const ledger3 = validateScaP08EvidenceLedgerV1(
      readJson(artifacts, selectedRef(third.run, "sca-p08-evidence-ledger"))
    );
    const row = required(
      ledger3.items.find((candidate) => candidate.item_id === subjectId),
      "reopened row"
    );
    const revision2 = validateScaP08DispositionRevisionV1(
      readJson(artifacts, row.current_revision_ref)
    );
    expect(revision2.disposition).toBe("inconclusive");
    expect(revision2.change_reason_codes).toEqual(["invalidated_evidence"]);
  });

  it("replays deterministically without creating duplicate revisions", () => {
    using artifacts = store();
    const lineage1 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-replay-1",
      kinds: ["source_query"],
    });
    const scope1 = scopeRefOf(lineage1);
    const first = driveComplete(
      artifacts,
      lineage1,
      (payload) => assessmentFor(payload, outOfScope(scope1)),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope1])
    );
    const ledger1Ref = selectedRef(first.run, "sca-p08-evidence-ledger");
    const ledger1 = validateScaP08EvidenceLedgerV1(readJson(artifacts, ledger1Ref));

    const lineage2 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-replay-2",
      kinds: ["source_query"],
    });
    const scope2 = scopeRefOf(lineage2);
    const reassessmentRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-replay-2",
      prior_ledger_ref: ledger1Ref,
      entries: reassessmentEntries(ledger1, () => ({
        change_reason_codes: ["new_evidence"],
        stimulus_refs: [scope2],
      })),
    });
    const drive = () =>
      driveComplete(
        artifacts,
        lineage2,
        (payload) =>
          assessmentFor(payload, (item) =>
            assertionFor(item, {
              disposition: "inconclusive",
              unresolved_material_link: "replayed material link",
              resolution_evidence_need: "replayed need",
            })
          ),
        (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope2]),
        reassessmentRef
      );
    const runA = drive();
    const revisionRefsA = runA.run.selectedArtifacts
      .filter((ref) => ref.kind === "sca-p08-disposition-revision")
      .map((ref) => ref.artifact_id)
      .sort();
    const ledgerA = selectedRef(runA.run, "sca-p08-evidence-ledger");
    expect(revisionRefsA.length).toBeGreaterThan(0);

    const runB = drive();
    const revisionRefsB = runB.run.selectedArtifacts
      .filter((ref) => ref.kind === "sca-p08-disposition-revision")
      .map((ref) => ref.artifact_id)
      .sort();
    expect(revisionRefsB).toEqual(revisionRefsA);
    expect(selectedRef(runB.run, "sca-p08-evidence-ledger").artifact_id).toBe(ledgerA.artifact_id);
  });

  it("fails closed on a reassessment that names an item outside the admitted universe", () => {
    using artifacts = store();
    const lineage1 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-bad-1",
      kinds: ["source_query"],
    });
    const scope1 = scopeRefOf(lineage1);
    const first = driveComplete(
      artifacts,
      lineage1,
      (payload) => assessmentFor(payload, outOfScope(scope1)),
      (payload, sha) => reviewFor(payload, sha, "not_permitted", [scope1])
    );
    const ledger1Ref = selectedRef(first.run, "sca-p08-evidence-ledger");
    const lineage2 = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-bad-2",
      kinds: ["source_query"],
    });
    const scope2 = scopeRefOf(lineage2);
    const alienRef = buildScaP08Reassessment({
      store: artifacts,
      run_id: "run-p08-bad-2",
      prior_ledger_ref: ledger1Ref,
      entries: [
        {
          item_id: `p08item_${"b".repeat(64)}`,
          item_kind: "action",
          identity: `p06act_${"b".repeat(64)}`,
          change_reason_codes: ["new_evidence"],
          stimulus_refs: [scope2],
        },
      ],
    });
    expect(() => materialize(artifacts, lineage2, alienRef)).toThrow();
  });
});

function blockerCodesOf(result: Record<string, unknown>): readonly string[] {
  const codes = result["blocker_codes"];
  return Array.isArray(codes)
    ? codes.filter((code): code is string => typeof code === "string")
    : [];
}

function gateOf(artifacts: ArtifactStore, run: RunContext) {
  return validateScaP08GateV1(readJson(artifacts, selectedRef(run, "sca-p08-gate")));
}

function persistDispatchGuardOnly(
  artifacts: ArtifactStore,
  runId: string,
  directive: Extract<Directive, { action: "invoke_agent" }>
): ArtifactRef {
  const coordinate = {
    run_id: runId,
    state_id: directive.state_id,
    branch_id: null,
    agent: directive.agent,
    attempt: directive.attempt,
  };
  return artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: directive.state_id,
      branch_id: null,
      kind: "model-dispatch-guard",
      operation_id: modelDispatchGuardOperationId(coordinate),
      version: 1,
      producer: "host:required-model-runtime",
      media_type: "application/json",
      content_schema: { schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson({
      schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA,
      schema_version: 1,
      coordinate,
      registration_sha256: "3".repeat(64),
      requested_model: SCA_P08_REQUIRED_MODEL,
      input_artifacts_sha256: sha256(canonicalJson(directive.input_artifacts)),
      serialized_opening_sha256: "4".repeat(64),
      serialized_opening_byte_length: 100,
      provider_opening_guard: SCA_P08_PROVIDER_OPENING_GUARD,
      guarded_at: "2026-09-26T00:00:01.000Z",
    }),
  });
}

function livenessSnapshot(
  reason: "worker_inactivity_lease_expired" | "routing_repair_binding_invalid"
) {
  return {
    schema_version: 1 as const,
    policy_state: "bound" as const,
    preset: "standard",
    phase_invocations: 1,
    repair_invocations: 0,
    model_turns: 1,
    tool_calls: 0,
    external_calls: 0,
    malformed_results: 0,
    protocol_errors: 0,
    active_wall_clock_ms: 1,
    open_workers: 0,
    terminal_reason: reason,
  };
}

describe("SCA P08 duplicate chains, evidence semantics, and derived gate", () => {
  it("rejects a duplicate-of chain (A→B→C) instead of emitting a false pass_ready", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-chain",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const payload = payloadFor(artifacts, directive);
    const [a, b, c] = payload.items.map((item) => item.item_id);
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error("P08 chain regression needs three universe items");
    }
    const scopeRef = scopeRefOf(lineage);
    const assessment = assessmentFor(payload, (item) => {
      if (item.item_id === a) {
        return assertionFor(item, { disposition: "duplicate-of", duplicate_of_item_id: b });
      }
      if (item.item_id === b) {
        return assertionFor(item, { disposition: "duplicate-of", duplicate_of_item_id: c });
      }
      return assertionFor(item, { disposition: "out-of-scope", scope_evidence_ref: scopeRef });
    });
    const output = persistEvidence(artifacts, run.identity.run_id, directive, assessment);
    run.selectedArtifacts.push(output);
    const terminalDirective = playbook.acceptSummary(run, assessment, "CERTAIN");
    if (terminalDirective.action !== "incomplete") throw new Error("expected P08 terminal");
    const terminal = terminalDirective.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("blocked");
    expect(blockerCodesOf(terminal)).toContain("p08_assessment_invalid");
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p08-disposition-assessment")).toBe(
      false
    );
    const gate = gateOf(artifacts, run);
    expect(gate.verdict).not.toBe("pass_ready");
    expect(gate.verdict).toBe("blocked_invalid");
    expect(gate.scope_duplicate_deferred_valid).toBe(false);
    expect(gate.support_semantics_valid).toBe(false);
  });

  it("fails closed when a duplicate-of item has no admitted typed equivalence proof", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-no-proof",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const payload = payloadFor(artifacts, directive);
    const [a, b, c] = payload.items.map((item) => item.item_id);
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error("P08 duplicate regression needs three universe items");
    }
    const scopeRef = scopeRefOf(lineage);
    // The duplicate pair is valid (target b is not itself duplicate-of) but no host-issued
    // equivalence proof was admitted, so the arbitrary admitted ref cannot stand in for it.
    const assessment = assessmentFor(payload, (item) =>
      item.item_id === a
        ? assertionFor(item, {
            disposition: "duplicate-of",
            duplicate_of_item_id: b,
            equivalence_evidence_refs: [scopeRef],
          })
        : assertionFor(item)
    );
    const { terminal, gate } = completeWith(
      artifacts,
      run,
      playbook,
      directive,
      payload,
      assessment,
      scopeRef
    );
    expect(terminal["status"]).toBe("blocked");
    expect(blockerCodesOf(terminal)).toContain("p08_disposition_validation_failed");
    expect(gate.scope_duplicate_deferred_valid).toBe(false);
    expect(gate.verdict).toBe("blocked_invalid");
  });

  it("fails closed when out-of-scope cites an admitted ref that is not a scope-decision record", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-bad-scope",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const payload = payloadFor(artifacts, directive);
    const actionRef = required(
      lineage.admission.items.find((item) => item.item_kind === "action"),
      "admitted action"
    ).primary_ref;
    const assessment = assessmentFor(payload, (item) =>
      assertionFor(item, { disposition: "out-of-scope", scope_evidence_ref: actionRef })
    );
    const { terminal, gate } = completeWith(
      artifacts,
      run,
      playbook,
      directive,
      payload,
      assessment,
      scopeRefOf(lineage)
    );
    expect(terminal["status"]).toBe("blocked");
    expect(blockerCodesOf(terminal)).toContain("p08_disposition_validation_failed");
    expect(gate.scope_duplicate_deferred_valid).toBe(false);
  });

  it("fails closed on a runtime refutation that omits its distinguishing oracle", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-oracle",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const payload = payloadFor(artifacts, directive);
    const subjectId = required(
      lineage.admission.items.find((item) => item.item_kind === "hypothesis"),
      "admitted hypothesis"
    ).item_id;
    const scopeRef = scopeRefOf(lineage);
    const assessment = assessmentFor(payload, (item) =>
      item.item_id === subjectId
        ? assertionFor(item, {
            disposition: "rejected-with-evidence",
            claim: "the asserted issue is defeated",
            defeating_evidence_refs: [scopeRef],
            evidence_mode: "runtime",
            actor_state_stimulus_verified: true,
            target_reachability_observed: true,
            distinguishing_oracle: null,
            repository_path: "src/value.ts",
            line_start: 1,
            line_end: 2,
          })
        : assertionFor(item)
    );
    const { terminal, gate } = completeWith(
      artifacts,
      run,
      playbook,
      directive,
      payload,
      assessment,
      scopeRef
    );
    expect(terminal["status"]).toBe("blocked");
    expect(blockerCodesOf(terminal)).toContain("p08_disposition_validation_failed");
    expect(gate.no_false_refutation).toBe(false);
  });

  it("blocks a wrong observed model identity before any disposition is recorded", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-model",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const payload = payloadFor(artifacts, directive);
    const scopeRef = scopeRefOf(lineage);
    const assessment = assessmentDetails(payload, scopeRef);
    const output = persistEvidence(artifacts, run.identity.run_id, directive, assessment, {
      observed_model: { provider: "ollama", model: "some-other-model" },
    });
    run.selectedArtifacts.push(output);
    const terminalDirective = playbook.acceptSummary(run, assessment, "CERTAIN");
    if (terminalDirective.action !== "incomplete") throw new Error("expected P08 terminal");
    const terminal = terminalDirective.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("blocked");
    expect(blockerCodesOf(terminal)).toContain("p08_assessment_invalid");
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p08-disposition-assessment")).toBe(
      false
    );
  });

  it("denies a payload that exceeds the admitted per-call limit before dispatch", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-payload-limit",
      kinds: ["source_query"],
      max_payload_bytes_per_call: 256,
    });
    const { run, playbook } = materialize(artifacts, lineage);
    const directive = playbook.initialize(run);
    if (directive.action !== "incomplete") throw new Error("expected P08 terminal");
    const terminal = directive.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("blocked");
    expect(blockerCodesOf(terminal)).toContain("p08_disclosure_denied_before_dispatch");
    const disclosure = validateScaP08DisclosureAdmissionV1(
      readJson(artifacts, selectedRef(run, "sca-p08-disclosure-admission"))
    );
    expect(disclosure.decision).toBe("deny");
    expect(disclosure.blocker_codes).toContain("p08_payload_limit_exceeded");
    expect(run.selectedArtifacts.some((ref) => ref.kind === SCA_P08_ASSESSMENT_OUTPUT_KIND)).toBe(
      false
    );
  });

  it("terminalizes liveness as a non-positive blocked terminal", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-liveness",
      kinds: ["source_query"],
    });
    const { run, playbook } = materialize(artifacts, lineage);
    playbook.initialize(run);
    const directive = playbook.terminalizeLiveness(
      run,
      "worker_inactivity_lease_expired",
      livenessSnapshot("worker_inactivity_lease_expired")
    );
    if (directive.action !== "incomplete") throw new Error("expected P08 liveness terminal");
    const terminal = directive.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("blocked");
    expect(terminal["phase_gate_passed"]).toBe(false);
    expect(terminal["release_eligible"]).toBe(false);
    expect(blockerCodesOf(terminal)).toContain("p08_liveness_worker_inactivity_lease_expired");
    expect(gateOf(artifacts, run).verdict).toBe("blocked_invalid");
  });

  it("fences a remote-unknown dispatch without replaying it", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-remote-unknown",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    persistDispatchGuardOnly(artifacts, run.identity.run_id, directive);
    const cancelled = playbook.rebindPendingDirective(run);
    if (cancelled === null || cancelled.action !== "cancelled") {
      throw new Error("expected P08 remote-unknown cancellation");
    }
    const terminal = cancelled.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("cancelled");
    expect(terminal["p09_transition_ref"]).toBeNull();
    expect(blockerCodesOf(terminal)).toContain("p08_remote_unknown_quarantined");
  });

  it("fences a persisted-but-uncommitted model outcome by exact durable evidence", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-uncommitted",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    persistDispatchGuardOnly(artifacts, run.identity.run_id, directive);
    // The provider output is persisted but its exact model-execution receipt never committed.
    artifacts.persist({ metadata: directive.output_artifact, content: "SUMMARY:{}" });
    const cancelled = playbook.rebindPendingDirective(run);
    if (cancelled === null || cancelled.action !== "cancelled") {
      throw new Error("expected P08 uncommitted-outcome cancellation");
    }
    const terminal = cancelled.result as Record<string, unknown>;
    expect(terminal["status"]).toBe("cancelled");
    expect(blockerCodesOf(terminal)).toContain("p08_uncommitted_outcome_quarantined");
    expect(run.selectedArtifacts.some((ref) => ref.kind === "sca-p08-disposition-assessment")).toBe(
      false
    );
  });
});

describe("SCA P08 admitted scope-decision evidence", () => {
  it("accepts legitimate P01 source-scope evidence and surfaces it in payload and disclosure", () => {
    using artifacts = store();
    const lineage = buildScaP08Lineage({
      store: artifacts,
      run_id: "run-p08-source-scope",
      kinds: ["source_query"],
    });
    const { run, playbook, directive } = startAssessment(artifacts, lineage);
    const payload = payloadFor(artifacts, directive);
    // The payload carries exactly the admission's allowlist-derived scope-decision records.
    expect(payload.scope_decision_refs.map((ref) => ref.artifact_id)).toEqual(
      lineage.admission.scope_decision_refs.map((ref) => ref.artifact_id)
    );
    // The disclosure authorization carries the same exact refs, so the zero-tool assessor can
    // legitimately cite them.
    const disclosure = validateScaP08DisclosureAdmissionV1(
      readJson(
        artifacts,
        required(
          directive.input_artifacts.artifacts.find((entry) => entry.slot === "disclosure_admission")
            ?.ref,
          "assessment disclosure ref"
        )
      )
    );
    for (const ref of payload.scope_decision_refs) {
      expect(
        disclosure.authorized_refs.some((entry) => entry.artifact_id === ref.artifact_id)
      ).toBe(true);
    }
    const sourceScope = scopeDecisionRefOf(lineage, "source-snapshot");
    expect(sourceScope.kind).toBe("source-snapshot");
    const { terminal, gate } = completeWith(
      artifacts,
      run,
      playbook,
      directive,
      payload,
      assessmentFor(payload, outOfScope(sourceScope)),
      sourceScope
    );
    expect(terminal["status"]).toBe("candidate_complete");
    expect(terminal["out_of_scope_count"]).toBe(payload.items.length);
    expect(gate.scope_duplicate_deferred_valid).toBe(true);
  });

  it("denies out-of-scope evidence from handoff transitions or provider disclosure scope", () => {
    const cases: readonly {
      readonly run_id: string;
      readonly pick: (lineage: ScaP08LineageV1) => ArtifactRef;
    }[] = [
      {
        run_id: "run-p08-deny-p07-handoff",
        pick: (lineage) => required(lineage.p07_transition_ref, "P07→P08 handoff"),
      },
      { run_id: "run-p08-deny-p06-handoff", pick: (lineage) => lineage.p06_transition_ref },
      { run_id: "run-p08-deny-disclosure", pick: (lineage) => lineage.disclosure_scope_ref },
    ];
    for (const entry of cases) {
      using artifacts = store();
      const lineage = buildScaP08Lineage({
        store: artifacts,
        run_id: entry.run_id,
        kinds: ["source_query"],
      });
      const deniedRef = entry.pick(lineage);
      // The ref is admitted lineage evidence, but it is not a campaign/source scope decision.
      expect(lineage.admission.admitted_evidence_ref_ids.has(deniedRef.artifact_id)).toBe(true);
      expect(lineage.admission.scope_decision_ref_ids.has(deniedRef.artifact_id)).toBe(false);
      const { run, playbook, directive } = startAssessment(artifacts, lineage);
      const payload = payloadFor(artifacts, directive);
      const { terminal, gate } = completeWith(
        artifacts,
        run,
        playbook,
        directive,
        payload,
        assessmentFor(payload, outOfScope(deniedRef)),
        scopeRefOf(lineage)
      );
      expect(terminal["status"]).toBe("blocked");
      expect(blockerCodesOf(terminal)).toContain("p08_disposition_validation_failed");
      expect(gate.scope_duplicate_deferred_valid).toBe(false);
    }
  });
});

describe("SCA P08 registration declaration negatives", () => {
  it("rejects a non-empty tool subset, a drifted guard binding, or a missing required model", () => {
    const registration = SCA_P08_CANDIDATE_REGISTRATION;
    const worker = registration.worker;
    if (worker.kind !== "catalog-agent") throw new Error("P08 must be a catalog-agent candidate");

    const withToolSubset = new Map(worker.phases);
    for (const [state, phase] of worker.phases) {
      withToolSubset.set(state, { ...phase, allowed_tools: ["sca_source_query"] });
    }
    expect(() =>
      validateRegistrationContract({
        ...registration,
        worker: { ...worker, phases: withToolSubset },
      })
    ).toThrow();

    // A guard literal that belongs to another SCA phase cannot be bound to this registration.
    const withForeignGuard = new Map(worker.phases);
    for (const [state, phase] of worker.phases) {
      withForeignGuard.set(state, {
        ...phase,
        provider_opening_guard: "sca_p04_payload_disclosure_v1",
      });
    }
    expect(() =>
      validateRegistrationContract({
        ...registration,
        worker: { ...worker, phases: withForeignGuard },
      })
    ).toThrow();

    // A guarded opening phase must declare its exact required model.
    const withoutRequiredModel = new Map(worker.phases);
    for (const [state, phase] of worker.phases) {
      const { required_model: dropped, ...rest } = phase;
      void dropped;
      withoutRequiredModel.set(state, rest);
    }
    expect(() =>
      validateRegistrationContract({
        ...registration,
        worker: { ...worker, phases: withoutRequiredModel },
      })
    ).toThrow();
  });
});
