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
} from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import {
  OrchestrationService,
  buildAgentOpening,
  initializePennyState,
  type AgentCompletion,
  type AgentInvocation,
  type ModelClient,
} from "../dist/index.js";
import { runtimeRegistrationSha256, skillContractSha256 } from "../dist/playbooks/registry.js";
import { trustedInvocationDigest } from "../dist/receipts.js";
import {
  MODEL_DISPATCH_GUARD_V1_SCHEMA,
  MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
} from "../dist/required-model.js";
import {
  SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P05_CHALLENGER_RESULT_V1_SCHEMA,
  SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
  SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
  SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
  SCA_P05_REQUIRED_MODEL,
  scaP05EvidenceAtomId,
  scaP05HypothesisId,
  scaP05ObservableId,
  scaP05SourceSegmentId,
  validateScaP05CheckpointV1,
  validateScaP05CognitivePayloadV1,
  validateScaP05DisclosureAdmissionV1,
  validateScaP05DisclosureScopeV1,
  validateScaP05HypothesisRevisionV1,
  validateScaP05TerminalV1,
  validateScaP05ToP06TransitionV1,
  withSelfDigest,
  type ScaP05HypothesisBodyV1,
} from "../dist/sca/p05-contracts.js";
import {
  SCA_P05_CANDIDATE_PLAYBOOK_NAME,
  SCA_P05_CANDIDATE_REGISTRATION,
  ScaP05CandidatePlaybook,
} from "../dist/sca/p05-playbook.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];

class UnreachableP05Client implements ModelClient {
  async runAgent(_invocation: AgentInvocation): Promise<AgentCompletion> {
    throw new Error("P05 recovery must not invoke a model");
  }
}

class TamperedOpeningP05Client implements ModelClient {
  providerPrompts = 0;

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    invocation.admitResolvedModel?.({
      provider: SCA_P05_REQUIRED_MODEL.provider,
      model: SCA_P05_REQUIRED_MODEL.model,
    });
    const appendix = invocation.providerOpeningAppendix?.();
    const opening = buildAgentOpening({
      invocation,
      registration: invocation.registration,
      agentGuidance: "registration-bound",
      domainGuidance: "registration-bound",
      activeToolNames: [],
      ...(appendix === undefined ? {} : { providerOpeningAppendix: appendix }),
    });
    invocation.guardModelDispatch?.(`${opening}\nsubstituted`);
    this.providerPrompts += 1;
    throw new Error("provider prompt must not be reached");
  }
}

function serviceEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-p05-recovery-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_ENABLED: "false",
  };
  initializePennyState(PROJECT_ROOT, { env });
  return env;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): ArtifactStore {
  const root = mkdtempSync(path.join(tmpdir(), "penny-p05-playbook-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}
function persistJson(
  artifacts: ArtifactStore,
  input: {
    readonly runId: string;
    readonly phase: string;
    readonly kind: string;
    readonly operationId: string;
    readonly producer: string;
    readonly schemaId: string;
    readonly value: unknown;
    readonly upstream?: readonly ArtifactRef[];
  }
): ArtifactRef {
  return artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: input.runId,
      phase: input.phase,
      branch_id: null,
      kind: input.kind,
      operation_id: input.operationId,
      version: 1,
      producer: input.producer,
      media_type: "application/json",
      content_schema: { schema_id: input.schemaId, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [...(input.upstream ?? [])],
    },
    content: canonicalJson(input.value),
  });
}

function fixture(
  artifacts: ArtifactStore,
  runId: string,
  options: { readonly denyConstructorDisclosure?: boolean } = {}
) {
  const selectedId = `p04i_${"1".repeat(64)}`;
  const sourceRef = persistJson(artifacts, {
    runId: "run-p01",
    phase: "SCA-P01",
    kind: "source-snapshot",
    operationId: "source-snapshot",
    producer: "host:test",
    schemaId: "penny.test-source.v1",
    value: { source: true },
  });
  const p04TransitionRef = persistJson(artifacts, {
    runId: "run-p04",
    phase: "SCA-P04",
    kind: "p04-transition",
    operationId: "p04-transition",
    producer: "host:test",
    schemaId: "penny.sca-p04-to-p05-transition.v1",
    value: { transition: true },
  });
  const p04GateRef = persistJson(artifacts, {
    runId: "run-p04",
    phase: "SCA-P04",
    kind: "p04-gate",
    operationId: "p04-gate",
    producer: "host:test",
    schemaId: "penny.sca-p04-gate.v1",
    value: { gate: true },
  });
  const p04LedgerRef = persistJson(artifacts, {
    runId: "run-p04",
    phase: "SCA-P04",
    kind: "p04-ledger",
    operationId: "p04-ledger",
    producer: "host:test",
    schemaId: "penny.sca-p04-successor-ledger.v1",
    value: { ledger: true },
  });
  const selectionRef = persistJson(artifacts, {
    runId: "run-p04",
    phase: "SCA-P04",
    kind: "p04-selection",
    operationId: "p04-selection",
    producer: "host:test",
    schemaId: "penny.sca-p04-selection-dossier.v1",
    value: { selection: true },
  });
  const text = "if (actor.admin) allow(input);";
  const segmentId = scaP05SourceSegmentId({
    origin_ref: sourceRef,
    source_path: "src/auth.ts",
    start_line: 1,
    end_line_exclusive: 2,
    visible_text_sha256: sha256(Buffer.from(text, "utf8")),
  });
  const selector = `source-segment:${segmentId}`;
  const atomId = scaP05EvidenceAtomId({
    origin_ref: sourceRef,
    selector,
    value_sha256: sha256(canonicalJson(text)),
  });
  const authorityRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-disclosure-authority",
    operationId: "sca-p05-disclosure-authority",
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-disclosure-authority.v1",
    value: { approved: true },
  });
  const scope = validateScaP05DisclosureScopeV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P05" as const,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        required_model: SCA_P05_REQUIRED_MODEL,
        destination_class: "cloud" as const,
        purposes: ["p05_hypothesis_construction" as const, "p05_falsification_challenge" as const],
        source_segments: [
          {
            segment_id: segmentId,
            selected_item_id: selectedId,
            origin_ref: sourceRef,
            source_path: "src/auth.ts",
            start_line: 1,
            end_line_exclusive: 2,
            transformation: "verbatim" as const,
            visible_text_sha256: sha256(Buffer.from(text, "utf8")),
            visible_text_utf8: text,
            redaction_ranges: [],
            secrets_status: "absent" as const,
            personal_data_status: "absent" as const,
            allowed: true as const,
          },
        ],
        evidence_permissions: [
          {
            atom_id: atomId,
            selected_item_id: selectedId,
            atom_kind: "source_segment" as const,
            origin_ref: sourceRef,
            selector,
            value_sha256: sha256(canonicalJson(text)),
            allowed: true as const,
          },
        ],
        provider_retention_status: "known" as const,
        provider_retention_days: 0,
        provider_logging_status: "disabled" as const,
        provider_logging_days: 0,
        provider_training_use: "prohibited" as const,
        max_payload_bytes_per_call: 700_000,
        max_provider_calls: 2 as const,
        authority_ref: authorityRef,
        decision: "allow" as const,
        blocker_codes: [],
      },
      "scope_sha256"
    )
  );
  const scopeRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-disclosure-scope",
    operationId: "sca-p05-disclosure-scope",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_DISCLOSURE_SCOPE_V1_SCHEMA,
    value: scope,
  });
  const request = withSelfDigest(
    {
      schema_id: "penny.sca-p05-request.v1" as const,
      schema_version: 1 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: runId,
      phase_id: "SCA-P05" as const,
      p04_transition_ref: p04TransitionRef,
      implementation_identity_ref: sourceRef,
      runtime_policy_ref: sourceRef,
      disclosure_scope_ref: scopeRef,
      requested_at: "2026-09-21T00:00:00.000Z",
    },
    "request_sha256"
  );
  const requestRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-candidate-request",
    operationId: "sca-p05-candidate-request",
    producer: "host:sca-p05-candidate",
    schemaId: "penny.sca-p05-request.v1",
    value: request,
  });
  const cohort = withSelfDigest(
    {
      schema_id: SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
      schema_version: 1 as const,
      phase_id: "SCA-P05" as const,
      run_id: runId,
      p05_request_ref: requestRef,
      p04_transition_ref: p04TransitionRef,
      p04_gate_ref: p04GateRef,
      p04_successor_ledger_ref: p04LedgerRef,
      p04_selection_dossier_ref: selectionRef,
      source_snapshot_ref: sourceRef,
      source_snapshot_sha256: sourceRef.content_digest,
      selected_item_ids: [selectedId],
      runtime_policy_ref: sourceRef,
      disclosure_scope_ref: scopeRef,
      admitted_at: "2026-09-21T00:00:00.000Z",
    },
    "cohort_sha256"
  );
  const cohortRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-accepted-cohort",
    operationId: "sca-p05-accepted-cohort",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_ACCEPTED_COHORT_V1_SCHEMA,
    value: cohort,
  });
  const payload = validateScaP05CognitivePayloadV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P05" as const,
        call_id: "constructor",
        role: "hypothesis_constructor" as const,
        purpose: "p05_hypothesis_construction" as const,
        required_model: SCA_P05_REQUIRED_MODEL,
        accepted_cohort_ref: cohortRef,
        source_snapshot_ref: sourceRef,
        source_snapshot_sha256: sourceRef.content_digest,
        assigned_item_ids: [selectedId],
        items: [
          {
            selected_item_id: selectedId,
            expected_hypothesis_id: scaP05HypothesisId(sourceRef.content_digest, selectedId),
            normalized_locator: "source:src/auth.ts",
            source_path: "src/auth.ts",
            package_coordinate: null,
            selection_rationale_code: "select_for_p05",
            evidence_atom_ids: [atomId],
          },
        ],
        evidence_atoms: [
          {
            atom_id: atomId,
            selected_item_id: selectedId,
            atom_kind: "source_segment" as const,
            origin_ref: sourceRef,
            selector,
            value_sha256: sha256(canonicalJson(text)),
            value: text,
          },
        ],
        constructor_result_ref: null,
        constructor_result: null,
        disclosure_scope_ref: scopeRef,
        content_mode: "authorized_segments_and_exact_evidence_atoms" as const,
      },
      "payload_sha256"
    )
  );
  const payloadRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-cognitive-payload",
    operationId: "sca-p05-constructor-payload",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
    value: payload,
  });
  const disclosure = validateScaP05DisclosureAdmissionV1(
    withSelfDigest(
      {
        schema_id: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
        schema_version: 1 as const,
        run_id: runId,
        phase_id: "SCA-P05" as const,
        call_id: "constructor",
        role: "hypothesis_constructor" as const,
        purpose: "p05_hypothesis_construction" as const,
        required_model: SCA_P05_REQUIRED_MODEL,
        disclosure_scope_ref: scopeRef,
        disclosure_scope_sha256: scope.scope_sha256,
        payload_ref: payloadRef,
        payload_sha256: payloadRef.content_digest,
        payload_byte_length: payloadRef.byte_length,
        serialized_opening_byte_limit: 700_000,
        authorized_segment_ids: [segmentId],
        authorized_atom_ids: [atomId],
        destination: "cloud" as const,
        retention_days: 0,
        logging_status: "disabled" as const,
        logging_days: 0,
        training: "prohibited" as const,
        secrets_embedded: false as const,
        personal_data_embedded: false as const,
        decision: options.denyConstructorDisclosure ? ("deny" as const) : ("allow" as const),
        blocker_codes: options.denyConstructorDisclosure ? ["payload_size_denied"] : [],
        evaluated_before_dispatch: true as const,
      },
      "admission_sha256"
    )
  );
  const disclosureRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P05",
    kind: "sca-p05-disclosure-admission",
    operationId: "sca-p05-constructor-disclosure",
    producer: "host:sca-p05-candidate",
    schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
    value: disclosure,
  });
  return {
    selectedId,
    atomId,
    sourceRef,
    p04TransitionRef,
    scopeRef,
    requestRef,
    cohortRef,
    payloadRef,
    disclosureRef,
  };
}

function hypothesis(input: {
  readonly selectedId: string;
  readonly sourceSha: string;
  readonly atomId: string;
}): ScaP05HypothesisBodyV1 {
  return {
    hypothesis_id: scaP05HypothesisId(input.sourceSha, input.selectedId),
    selected_item_id: input.selectedId,
    bounded_claim: "A non-admin actor may reach the protected operation through this path.",
    actor: { claim: "A non-admin actor", evidence_atom_ids: [input.atomId] },
    controlled_input: { claim: "An actor-controlled input", evidence_atom_ids: [input.atomId] },
    relevant_state: { claim: "The actor lacks admin state", evidence_atom_ids: [input.atomId] },
    causal_path: [
      {
        ordinal: 1,
        causal_link: "The input reaches the authorization branch.",
        state_before: "Request received",
        state_after: "Authorization branch evaluated",
        basis: "observed",
        evidence_atom_ids: [input.atomId],
      },
    ],
    security_sensitive_outcome: {
      claim: "The protected operation is allowed",
      evidence_atom_ids: [input.atomId],
    },
    competing_benign_explanation: {
      explanation: "An exact admin guard may always stop the path.",
      discriminating_observation: "Observe whether the guard rejects the same request.",
      evidence_atom_ids: [input.atomId],
    },
    expected_supporting_observations: [
      {
        observable_id: scaP05ObservableId({
          selected_item_id: input.selectedId,
          kind: "supporting",
          ordinal: 1,
        }),
        observation: "The operation is reached.",
        expected_if_claim: true,
        evidence_mode: "graph",
        basis_atom_ids: [input.atomId],
      },
    ],
    expected_refuting_observations: [
      {
        observable_id: scaP05ObservableId({
          selected_item_id: input.selectedId,
          kind: "refuting",
          ordinal: 1,
        }),
        observation: "The exact guard dominates the path.",
        expected_if_claim: false,
        evidence_mode: "graph",
        basis_atom_ids: [input.atomId],
      },
    ],
    next_evidence_need: {
      question: "Does the guard dominate the protected operation?",
      evidence_mode: "graph",
      target: "The guard and protected operation",
      discriminating_result: "A path exists without guard domination.",
    },
    stopping_conditions: {
      supported: "Stop when the complete path is observed.",
      refuted: "Stop when the exact guard dominates every path.",
      inconclusive: "Stop when admitted evidence cannot distinguish the alternatives.",
    },
    reopening_conditions: [
      {
        trigger: "Source or graph evidence changes.",
        changed_basis_required: "A new exact snapshot or invalidated control.",
      },
    ],
  };
}

function context(runId: string, refs: readonly ArtifactRef[]): RunContext {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript",
    },
    goal: "Exercise an inactive synthetic P05 checkpoint.",
    constraints: {},
    projectRoot: PROJECT_ROOT,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
    initialArtifacts: refs,
  });
}

function persistWorkerEvidence(
  artifacts: ArtifactStore,
  runId: string,
  directive: Extract<Directive, { action: "invoke_agent" }>,
  details: unknown
): readonly ArtifactRef[] {
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
  const guard = persistJson(artifacts, {
    runId,
    phase: directive.state_id,
    kind: "model-dispatch-guard",
    operationId: modelDispatchGuardOperationId(coordinate),
    producer: "host:required-model-runtime",
    schemaId: MODEL_DISPATCH_GUARD_V1_SCHEMA,
    value: {
      schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA,
      schema_version: 1,
      coordinate,
      registration_sha256: "3".repeat(64),
      requested_model: SCA_P05_REQUIRED_MODEL,
      input_artifacts_sha256: sha256(canonicalJson(directive.input_artifacts)),
      serialized_opening_sha256: "4".repeat(64),
      serialized_opening_byte_length: 100,
      provider_opening_guard: "sca_p05_payload_disclosure_v1",
      guarded_at: "2026-09-21T00:00:01.000Z",
    },
  });
  const receiptBody = {
    schema_version: 2 as const,
    receipt_id: "receipt-p05-constructor",
    run_id: runId,
    state_id: directive.state_id,
    branch_id: null,
    agent: directive.agent,
    attempt: directive.attempt,
    worker_id: "worker-p05-constructor",
    executor: "pi-sdk" as const,
    command: ["pi-sdk", directive.agent],
    model: SCA_P05_REQUIRED_MODEL.override,
    requested_model: SCA_P05_REQUIRED_MODEL,
    observed_model: {
      provider: SCA_P05_REQUIRED_MODEL.provider,
      model: SCA_P05_REQUIRED_MODEL.model,
    },
    working_directory: PROJECT_ROOT,
    trust_profile: "hardened-untrusted" as const,
    started_at: "2026-09-21T00:00:01.000Z",
    ended_at: "2026-09-21T00:00:02.000Z",
    exit_code: 0,
    output_digest: output.content_digest,
    output_artifact_ref: output,
    trusted_invocation_digest: trustedInvocationDigest({
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: `session-${runId}`,
        playbook: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      state_id: directive.state_id,
      branch_id: null,
      agent: directive.agent,
      attempt: directive.attempt,
      trust_profile: "hardened-untrusted",
      model_override: SCA_P05_REQUIRED_MODEL.override,
      task_sha256: sha256(directive.task),
      input_artifacts: directive.input_artifacts,
      output_artifact: directive.output_artifact,
    }),
  };
  const executionReceipt = validateContract(
    ExecutionReceiptSchema,
    { ...receiptBody, signature: `hmac-sha256:${"9".repeat(64)}` },
    "P05 test execution receipt"
  );
  const receipt = persistJson(artifacts, {
    runId,
    phase: directive.state_id,
    kind: "model-execution-receipt",
    operationId: modelExecutionReceiptOperationId(coordinate),
    producer: "host:required-model-runtime",
    schemaId: MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
    value: {
      schema_id: MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      dispatch_guard_ref: guard,
      execution_receipt: executionReceipt,
    },
  });
  artifacts.select(output);
  artifacts.select(guard);
  artifacts.select(receipt);
  return [output, guard, receipt];
}

describe("SCA P05 explicit incomplete accounting and recovery", () => {
  it("preserves an unable-to-form checkpoint and blocks P06", () => {
    using artifacts = store();
    const runId = "run-p05-checkpoint";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.cohortRef,
      built.payloadRef,
      built.disclosureRef,
    ]);
    const playbook = new ScaP05CandidatePlaybook(
      artifacts,
      () => new Date("2026-09-21T00:00:03.000Z")
    );
    const directive = playbook.initialize(run);
    if (directive.action !== "invoke_agent") throw new Error("expected constructor directive");
    const details = {
      schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
      schema_version: 1,
      role: "hypothesis_constructor",
      payload_sha256: built.payloadRef.content_digest,
      assigned_item_ids: [built.selectedId],
      items: [
        {
          selected_item_id: built.selectedId,
          disposition: "checkpointed_incomplete",
          hypothesis: null,
          reason_code: "insufficient_causal_basis",
          missing_evidence_need: "A complete source-bound causal link is absent.",
          stop_condition: "Stop before asserting the causal claim.",
          reopen_condition: "Reopen when exact source or graph evidence supplies the missing link.",
          vulnerability_adjudication: "not_performed",
          safe_claim: false,
        },
      ],
      complete: true,
    };
    const workerRefs = persistWorkerEvidence(artifacts, runId, directive, details);
    // The engine selects only the semantic output; guard/receipt resolution must use exact store coordinates.
    for (const selected of workerRefs.slice(0, 1)) {
      if (!run.selectedArtifacts.some((ref) => ref.artifact_id === selected.artifact_id)) {
        run.selectedArtifacts.push(selected);
      }
    }
    const terminal = playbook.acceptSummary(run, details, "UNCERTAIN");
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("expected blocked P05 terminal");
    const result = validateScaP05TerminalV1(terminal.result);
    expect(result.status).toBe("blocked");
    expect(result.p06_authorized).toBe(false);
    expect(result.p06_transition_ref).toBeNull();
    expect(result.blocker_codes).toContain("checkpointed_incomplete");
    expect(result.selected_artifact_refs.some((ref) => ref.kind === "sca-p05-checkpoint")).toBe(
      true
    );
  });

  it("builds exhaustive positive traceability, gate, ledger, and a P06 transition", () => {
    using artifacts = store();
    const runId = "run-p05-positive";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.cohortRef,
      built.payloadRef,
      built.disclosureRef,
    ]);
    const playbook = new ScaP05CandidatePlaybook(
      artifacts,
      () => new Date("2026-09-21T00:00:03.000Z")
    );
    const constructorDirective = playbook.initialize(run);
    if (constructorDirective.action !== "invoke_agent") {
      throw new Error("expected constructor directive");
    }
    const body = hypothesis({
      selectedId: built.selectedId,
      sourceSha: built.sourceRef.content_digest,
      atomId: built.atomId,
    });
    const constructorResult = {
      schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
      schema_version: 1,
      role: "hypothesis_constructor",
      payload_sha256: built.payloadRef.content_digest,
      assigned_item_ids: [built.selectedId],
      items: [
        {
          selected_item_id: built.selectedId,
          disposition: "formed",
          hypothesis: body,
        },
      ],
      complete: true,
    };
    const [constructorOutput] = persistWorkerEvidence(
      artifacts,
      runId,
      constructorDirective,
      constructorResult
    );
    if (constructorOutput === undefined) throw new Error("expected constructor output");
    run.selectedArtifacts.push(constructorOutput);
    const revision = validateScaP05HypothesisRevisionV1(
      withSelfDigest(
        {
          schema_id: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
          schema_version: 1 as const,
          hypothesis_id: body.hypothesis_id,
          revision: 1 as const,
          parent_revision_ref: null,
          parent_revision_sha256: null,
          body,
          body_sha256: sha256(canonicalJson(body)),
          source_snapshot_ref: built.sourceRef,
          source_snapshot_sha256: built.sourceRef.content_digest,
          p04_transition_ref: built.p04TransitionRef,
          selected_item_id: built.selectedId,
          cognitive_payload_ref: built.payloadRef,
          model_output_ref: constructorOutput,
          evidence_atom_ids: [built.atomId],
          change_reason_codes: ["initial_constructor"],
          changed_fields: [],
          created_at: "2026-09-21T00:00:03.000Z",
        },
        "revision_sha256"
      )
    );
    const revisionRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-hypothesis-revision",
      operationId: `sca-p05-${built.selectedId}-revision-1`,
      producer: "host:sca-p05-candidate",
      schemaId: SCA_P05_HYPOTHESIS_REVISION_V1_SCHEMA,
      value: revision,
      upstream: [built.cohortRef, built.payloadRef, constructorOutput],
    });
    run.selectedArtifacts.push(revisionRef);
    const rawPayload: unknown = JSON.parse(artifacts.read(built.payloadRef).toString("utf8"));
    const constructorPayload = validateScaP05CognitivePayloadV1(rawPayload);
    const { payload_sha256: _payloadDigest, ...payloadBody } = constructorPayload;
    const challengerPayload = validateScaP05CognitivePayloadV1(
      withSelfDigest(
        {
          ...payloadBody,
          call_id: "challenger",
          role: "falsification_challenger" as const,
          purpose: "p05_falsification_challenge" as const,
          constructor_result_ref: constructorOutput,
          constructor_result: constructorResult,
        },
        "payload_sha256"
      )
    );
    const challengerPayloadRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-cognitive-payload",
      operationId: "sca-p05-challenger-payload",
      producer: "host:sca-p05-candidate",
      schemaId: SCA_P05_COGNITIVE_PAYLOAD_V1_SCHEMA,
      value: challengerPayload,
      upstream: [built.cohortRef, constructorOutput, built.scopeRef],
    });
    const rawDisclosure: unknown = JSON.parse(artifacts.read(built.disclosureRef).toString("utf8"));
    const constructorDisclosure = validateScaP05DisclosureAdmissionV1(rawDisclosure);
    const { admission_sha256: _admissionDigest, ...disclosureBody } = constructorDisclosure;
    const challengerDisclosure = validateScaP05DisclosureAdmissionV1(
      withSelfDigest(
        {
          ...disclosureBody,
          call_id: "challenger",
          role: "falsification_challenger" as const,
          purpose: "p05_falsification_challenge" as const,
          payload_ref: challengerPayloadRef,
          payload_sha256: challengerPayloadRef.content_digest,
          payload_byte_length: challengerPayloadRef.byte_length,
        },
        "admission_sha256"
      )
    );
    const challengerDisclosureRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P05",
      kind: "sca-p05-disclosure-admission",
      operationId: "sca-p05-challenger-disclosure",
      producer: "host:sca-p05-candidate",
      schemaId: SCA_P05_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: challengerDisclosure,
      upstream: [challengerPayloadRef, built.scopeRef],
    });
    Object.assign(run.playbookData, {
      challenger_payload_ref: challengerPayloadRef,
      challenger_disclosure_ref: challengerDisclosureRef,
    });
    run.selectedArtifacts.push(challengerPayloadRef, challengerDisclosureRef);
    run.transition("challenging_hypotheses");
    const challengerDirective = playbook.dispatch(run);
    if (challengerDirective.action !== "invoke_agent") {
      throw new Error("expected challenger directive");
    }
    const challengerResult = {
      schema_id: SCA_P05_CHALLENGER_RESULT_V1_SCHEMA,
      schema_version: 1,
      role: "falsification_challenger",
      payload_sha256: challengerPayloadRef.content_digest,
      assigned_item_ids: [built.selectedId],
      items: [
        {
          selected_item_id: built.selectedId,
          hypothesis_id: body.hypothesis_id,
          decision: "accept_for_investigation",
          replacement_hypothesis: null,
          control_atom_ids: [],
          rationale: "The bounded record remains falsifiable and evidence-bound.",
        },
      ],
      complete: true,
    };
    const [challengerOutput] = persistWorkerEvidence(
      artifacts,
      runId,
      challengerDirective,
      challengerResult
    );
    if (challengerOutput === undefined) throw new Error("expected challenger output");
    run.selectedArtifacts.push(challengerOutput);
    const terminal = playbook.acceptSummary(run, challengerResult, "PROBABLE");
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("expected nonterminal P05 result");
    const result = validateScaP05TerminalV1(terminal.result);
    expect(result.status).toBe("candidate_complete");
    expect(result.p06_authorized).toBe(true);
    if (result.p06_transition_ref === null) throw new Error("expected P06 transition");
    const transitionRaw: unknown = JSON.parse(
      artifacts.read(result.p06_transition_ref).toString("utf8")
    );
    const transition = validateScaP05ToP06TransitionV1(transitionRaw);
    expect(transition.active_hypothesis_ids).toEqual([body.hypothesis_id]);
    expect(transition.refuted_hypothesis_ids).toEqual([]);
  });

  it("durably terminalizes runner-level opening denial with zero provider calls and no replay", async () => {
    const env = serviceEnvironment();
    const runId = "run-p05-runner-opening-denied";
    const identity = {
      schema_version: 2 as const,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript" as const,
    };
    const client = new TamperedOpeningP05Client();
    let terminal: Awaited<ReturnType<OrchestrationService["execute"]>>;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: SCA_P05_CANDIDATE_REGISTRATION,
      });
      const built = fixture(first.artifacts, runId);
      const checkpoint = RunContext.create({
        identity,
        goal: "Reject substituted P05 opening bytes before cloud dispatch.",
        constraints: {},
        projectRoot: PROJECT_ROOT,
        trustProfile: "hardened-untrusted",
        maxSteps: 20,
        registrationContractBinding: {
          schema_version: 1,
          registration_name: SCA_P05_CANDIDATE_PLAYBOOK_NAME,
          contract_sha256: skillContractSha256(first.engine.contract),
          registration_sha256: runtimeRegistrationSha256(first.engine.registration),
        },
        initialArtifacts: [
          built.requestRef,
          built.cohortRef,
          built.payloadRef,
          built.disclosureRef,
        ],
      });
      new ScaP05CandidatePlaybook(first.artifacts).initialize(checkpoint);
      first.checkpointer.createRun(checkpoint, "test_p05_opening_denial_pending", {
        run_id: runId,
      });
      terminal = await first.execute({ schema_version: 2, action: "recover", identity });
      expect(terminal.action).toBe("cancelled");
      if (terminal.action !== "cancelled") throw new Error("expected cancelled P05 terminal");
      expect(terminal.result).toMatchObject({
        status: "cancelled",
        p06_authorized: false,
        blocker_codes: ["pre_dispatch_policy_denied"],
      });
      expect(client.providerPrompts).toBe(0);
      expect(first.checkpointer.loadRun(identity).terminalDirective).not.toBeNull();
    }
    {
      using reopened = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new UnreachableP05Client(),
        playbookRegistration: SCA_P05_CANDIDATE_REGISTRATION,
      });
      const recovered = await reopened.execute({ schema_version: 2, action: "recover", identity });
      expect(recovered).toEqual(terminal);
    }
  });

  it("turns a constructor disclosure denial into exhaustive traceability and a blocked gate", () => {
    using artifacts = store();
    const runId = "run-p05-constructor-denied";
    const built = fixture(artifacts, runId, { denyConstructorDisclosure: true });
    const run = context(runId, [
      built.requestRef,
      built.cohortRef,
      built.payloadRef,
      built.disclosureRef,
    ]);
    for (let index = 0; index < 160; index += 1) {
      const ref = persistJson(artifacts, {
        runId,
        phase: "SCA-P05",
        kind: "sca-p05-test-detail",
        operationId: `sca-p05-test-detail-${String(index)}`,
        producer: "host:test",
        schemaId: "penny.sca-p05-test-detail.v1",
        value: { schema_id: "penny.sca-p05-test-detail.v1", schema_version: 1, index },
      });
      run.selectedArtifacts.push(ref);
    }
    const terminal = new ScaP05CandidatePlaybook(artifacts).initialize(run);
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("expected denied P05 terminal");
    expect(terminal.artifacts.length).toBeLessThanOrEqual(128);
    const result = validateScaP05TerminalV1(terminal.result);
    expect(result.status).toBe("blocked");
    expect(result.p06_transition_ref).toBeNull();
    expect(result.selected_artifact_refs.some((ref) => ref.kind === "sca-p05-checkpoint")).toBe(
      true
    );
    expect(result.selected_artifact_refs.some((ref) => ref.kind === "sca-p05-traceability")).toBe(
      true
    );
    expect(result.selected_artifact_refs.some((ref) => ref.kind === "sca-p05-gate")).toBe(true);
  });

  it("checkpoints schema-valid output with wrong deterministic payload binding without retry", () => {
    using artifacts = store();
    const runId = "run-p05-semantic-rejection";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.cohortRef,
      built.payloadRef,
      built.disclosureRef,
    ]);
    const playbook = new ScaP05CandidatePlaybook(artifacts);
    const pending = playbook.initialize(run);
    if (pending.action !== "invoke_agent") throw new Error("expected constructor directive");
    const details = {
      schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
      schema_version: 1,
      role: "hypothesis_constructor",
      payload_sha256: "f".repeat(64),
      assigned_item_ids: [built.selectedId],
      items: [
        {
          selected_item_id: built.selectedId,
          disposition: "checkpointed_incomplete",
          hypothesis: null,
          reason_code: "insufficient_causal_basis",
          missing_evidence_need: "A complete source-bound causal link is absent.",
          stop_condition: "Stop before asserting the causal claim.",
          reopen_condition: "Reopen with new exact evidence.",
          vulnerability_adjudication: "not_performed",
          safe_claim: false,
        },
      ],
      complete: true,
    };
    const [outputRef] = persistWorkerEvidence(artifacts, runId, pending, details);
    if (outputRef === undefined) throw new Error("expected semantic output");
    run.selectedArtifacts.push(outputRef);
    const terminal = playbook.acceptSummary(run, details, "UNCERTAIN");
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("expected semantic rejection terminal");
    const result = validateScaP05TerminalV1(terminal.result);
    expect(result.p06_authorized).toBe(false);
    expect(result.selected_artifact_refs.some((ref) => ref.kind === "sca-p05-checkpoint")).toBe(
      true
    );
    expect(playbook.rebindPendingDirective(run)?.action).toBe("incomplete");
  });

  it("durably checkpoints and refuses to replay a remote-unknown constructor dispatch", () => {
    using artifacts = store();
    const runId = "run-p05-remote-unknown";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.cohortRef,
      built.payloadRef,
      built.disclosureRef,
    ]);
    const playbook = new ScaP05CandidatePlaybook(artifacts);
    const pending = playbook.initialize(run);
    if (pending.action !== "invoke_agent") throw new Error("expected constructor directive");
    const coordinate = {
      run_id: runId,
      state_id: pending.state_id,
      branch_id: null,
      agent: pending.agent,
      attempt: pending.attempt,
    };
    persistJson(artifacts, {
      runId,
      phase: pending.state_id,
      kind: "model-dispatch-guard",
      operationId: modelDispatchGuardOperationId(coordinate),
      producer: "host:required-model-runtime",
      schemaId: MODEL_DISPATCH_GUARD_V1_SCHEMA,
      value: { guarded: true },
    });
    const recovered = playbook.rebindPendingDirective(run);
    expect(recovered?.action).toBe("cancelled");
    if (recovered?.action !== "cancelled") throw new Error("expected fenced cancellation");
    const result = validateScaP05TerminalV1(recovered.result);
    expect(result.blocker_codes).toContain("remote_model_outcome_unknown");
    expect(result.selected_artifact_refs.some((ref) => ref.kind === "sca-p05-checkpoint")).toBe(
      true
    );
    expect(playbook.rebindPendingDirective(run)?.action).toBe("cancelled");
  });

  it("quarantines a complete but uncommitted outcome without replay and preserves exact evidence", () => {
    using artifacts = store();
    const runId = "run-p05-uncommitted";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.cohortRef,
      built.payloadRef,
      built.disclosureRef,
    ]);
    const playbook = new ScaP05CandidatePlaybook(artifacts);
    const pending = playbook.initialize(run);
    if (pending.action !== "invoke_agent") throw new Error("expected constructor directive");
    const details = {
      schema_id: SCA_P05_CONSTRUCTOR_RESULT_V1_SCHEMA,
      schema_version: 1,
      role: "hypothesis_constructor",
      payload_sha256: built.payloadRef.content_digest,
      assigned_item_ids: [built.selectedId],
      items: [
        {
          selected_item_id: built.selectedId,
          disposition: "checkpointed_incomplete",
          hypothesis: null,
          reason_code: "insufficient_causal_basis",
          missing_evidence_need: "A complete source-bound causal link is absent.",
          stop_condition: "Stop before asserting the causal claim.",
          reopen_condition: "Reopen with new exact evidence.",
          vulnerability_adjudication: "not_performed",
          safe_claim: false,
        },
      ],
      complete: true,
    };
    persistWorkerEvidence(artifacts, runId, pending, details);
    const recovered = playbook.rebindPendingDirective(run);
    expect(recovered?.action).toBe("cancelled");
    if (recovered?.action !== "cancelled") throw new Error("expected quarantine cancellation");
    const result = validateScaP05TerminalV1(recovered.result);
    expect(result.blocker_codes).toContain("uncommitted_model_outcome_quarantined");
    const checkpointRef = result.selected_artifact_refs.find(
      (ref) => ref.kind === "sca-p05-checkpoint"
    );
    if (checkpointRef === undefined) throw new Error("expected interruption checkpoint");
    const parsedCheckpoint: unknown = JSON.parse(artifacts.read(checkpointRef).toString("utf8"));
    const checkpoint = validateScaP05CheckpointV1(parsedCheckpoint);
    expect(checkpoint.evidence_refs.some((ref) => ref.kind === "model-dispatch-guard")).toBe(true);
    expect(checkpoint.evidence_refs.some((ref) => ref.kind === "model-execution-receipt")).toBe(
      true
    );
    expect(checkpoint.evidence_refs.some((ref) => ref.kind === "sca-p05-constructor-output")).toBe(
      true
    );
  });

  it("turns malformed semantic output into exhaustive durable checkpoints without retry", () => {
    using artifacts = store();
    const runId = "run-p05-malformed";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.cohortRef,
      built.payloadRef,
      built.disclosureRef,
    ]);
    const playbook = new ScaP05CandidatePlaybook(artifacts);
    playbook.initialize(run);
    const terminal = playbook.terminalizeLiveness(run, "routing_repair_binding_invalid", {
      schema_version: 1,
      policy_state: "bound",
      preset: "standard",
      phase_invocations: 1,
      repair_invocations: 0,
      model_turns: 1,
      tool_calls: 0,
      external_calls: 1,
      malformed_results: 1,
      protocol_errors: 0,
      active_wall_clock_ms: 1,
      open_workers: 0,
      terminal_reason: "routing_repair_binding_invalid",
    });
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("expected malformed terminal");
    const result = validateScaP05TerminalV1(terminal.result);
    expect(result.p06_authorized).toBe(false);
    expect(result.blocker_codes).toContain("liveness_routing_repair_binding_invalid");
    expect(result.selected_artifact_refs.some((ref) => ref.kind === "sca-p05-checkpoint")).toBe(
      true
    );
    expect(playbook.rebindPendingDirective(run)?.action).toBe("incomplete");
  });

  it("rebinds a pending challenger without replaying the completed constructor", () => {
    using artifacts = store();
    const runId = "run-p05-challenger-rebind";
    const built = fixture(artifacts, runId);
    const run = context(runId, [
      built.requestRef,
      built.cohortRef,
      built.payloadRef,
      built.disclosureRef,
    ]);
    const playbook = new ScaP05CandidatePlaybook(artifacts);
    const constructor = playbook.initialize(run);
    expect(constructor.action).toBe("invoke_agent");
    Object.assign(run.playbookData, {
      challenger_payload_ref: built.payloadRef,
      challenger_disclosure_ref: built.disclosureRef,
    });
    run.transition("challenging_hypotheses");
    const challenger = playbook.dispatch(run);
    if (challenger.action !== "invoke_agent") throw new Error("expected challenger directive");
    const rebound = playbook.rebindPendingDirective(run);
    expect(rebound?.action).toBe("invoke_agent");
    if (rebound?.action !== "invoke_agent") throw new Error("expected rebound challenger");
    expect(rebound.agent).toBe("annie");
    expect(rebound.state_id).toBe("challenging_hypotheses");
    expect(rebound.output_artifact.operation_id).toBe(challenger.output_artifact.operation_id);
  });
});
