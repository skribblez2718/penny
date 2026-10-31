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
  type ExecutionReceipt,
  type OutputArtifactMetadata,
  type PhaseResult,
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
import { trustedInvocationDigest, type ReceiptAuthority } from "../dist/receipts.js";
import {
  MODEL_DISPATCH_GUARD_V1_SCHEMA,
  MODEL_EXECUTION_RECEIPT_V1_SCHEMA,
  modelDispatchGuardOperationId,
  modelExecutionReceiptOperationId,
} from "../dist/required-model.js";
import {
  SCA_P04_CANDIDATE_PLAYBOOK_NAME,
  SCA_P04_CANDIDATE_REGISTRATION,
  ScaP04CandidatePlaybook,
  buildScaP04CognitivePayload,
  buildScaP04DisclosureAdmission,
  type ScaP04CognitiveAdmissionV1,
  type ScaP04DisclosurePolicyAdmissionV1,
} from "../dist/sca/p04-playbook.js";
import {
  SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P04_POPULATION_V1_SCHEMA,
  SCA_P04_REQUIRED_MODEL,
  SCA_P04_REQUEST_V1_SCHEMA,
  SCA_P04_SCANNER_SPECIALIST,
  SCA_P04_SPECIALIST_IDS,
  SCA_P04_SPECIALIST_RESULT_V1_SCHEMA,
  SCA_P04_UNDERDETECTED_SPECIALIST,
  scaP04StableDiscoveryId,
  scaP04StableItemId,
  validateScaP04CoverageDossierV1,
  validateScaP04DisclosureAdmissionV1,
  validateScaP04OmissionDossierV1,
  validateScaP04SelectionDossierV1,
  validateScaP04SelectionPopulationV1,
  validateScaP04SpecialistDossierV1,
  validateScaP04SuccessorLedgerV1,
  validateScaP04TerminalV1,
  withSelfDigest,
  type ScaP04PopulationItemV1,
  type ScaP04SelectionPopulationV1,
  type ScaP04SpecialistResultV1,
} from "../dist/sca/p04-contracts.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];

class UnreachableModelClient implements ModelClient {
  async runAgent(_invocation: AgentInvocation): Promise<AgentCompletion> {
    throw new Error("recovery test must not invoke a model");
  }
}

class OpeningGuardModelClient implements ModelClient {
  providerPrompts = 0;

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    invocation.admitResolvedModel?.({
      provider: SCA_P04_REQUIRED_MODEL.provider,
      model: SCA_P04_REQUIRED_MODEL.model,
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
    invocation.guardModelDispatch?.(opening);
    this.providerPrompts += 1;
    throw new Error("provider prompt must not be reached");
  }
}

function serviceEnvironment(): NodeJS.ProcessEnv {
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-p04-recovery-"));
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
  const root = mkdtempSync(path.join(tmpdir(), "penny-sca-p04-playbook-"));
  roots.push(root);
  return new ArtifactStore(path.join(root, "artifacts"));
}

function requireRef(value: ArtifactRef | null, label: string): ArtifactRef {
  if (value === null) throw new Error(`${label} ref is absent`);
  return value;
}

function persistJson(
  artifacts: ArtifactStore,
  input: {
    runId: string;
    phase: string;
    branchId?: string | null;
    kind: string;
    operationId: string;
    producer: string;
    schemaId: string;
    value: unknown;
    upstream?: readonly ArtifactRef[];
  }
): ArtifactRef {
  return artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: input.runId,
      phase: input.phase,
      branch_id: input.branchId ?? null,
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

function syntheticFixture(
  artifacts: ArtifactStore,
  runId: string,
  options: { readonly forcePreDispatchPolicyDenial?: boolean } = {}
) {
  const upstream = persistJson(artifacts, {
    runId: "run-p03",
    phase: "SCA-P03",
    kind: "synthetic-p03-cohort",
    operationId: "synthetic-p03-cohort",
    producer: "host:test",
    schemaId: "penny.test-synthetic-p03-cohort.v1",
    value: { schema_id: "penny.test-synthetic-p03-cohort.v1", schema_version: 1 },
  });
  const binaryGraphRef = artifacts.persist({
    metadata: {
      schema_version: 2,
      run_id: "run-p03",
      phase: "SCA-P03",
      branch_id: null,
      kind: "sca-p03-graph-component",
      operation_id: "synthetic-binary-cpg",
      version: 1,
      producer: "host:test",
      media_type: "application/vnd.penny.joern-cpg",
      parent_ref: null,
      upstream_refs: [],
    },
    content: Buffer.from([0, 255, 1, 2, 3, 128]),
  });
  const requestBody = {
    schema_id: SCA_P04_REQUEST_V1_SCHEMA,
    schema_version: 1 as const,
    tenant_id: "tenant",
    project_id: "project",
    run_id: runId,
    phase_id: "SCA-P04" as const,
    p03_transition_ref: upstream,
    implementation_identity_ref: upstream,
    runtime_policy_ref: upstream,
    requested_at: "2026-09-21T00:00:00.000Z",
  };
  const request = withSelfDigest(requestBody, "request_sha256");
  const requestRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P04",
    kind: "sca-p04-candidate-request",
    operationId: "sca-p04-candidate-request",
    producer: "host:sca-p04-candidate",
    schemaId: SCA_P04_REQUEST_V1_SCHEMA,
    value: request,
    upstream: [upstream],
  });
  const cohortRefs = {
    p03_transition_ref: upstream,
    p03_request_ref: upstream,
    p03_entry_ref: upstream,
    p03_qualification_ref: upstream,
    p03_graph_manifest_ref: upstream,
    p03_supported_matrix_ref: upstream,
    p03_query_aggregate_ref: upstream,
    p03_candidate_packet_ref: upstream,
    p03_coverage_matrix_ref: upstream,
    p03_evidence_manifest_ref: upstream,
    p03_successor_ledger_ref: upstream,
    p03_zero_model_ref: upstream,
    p03_gate_ref: upstream,
    p02_m1_ref: upstream,
    p02_evidence_manifest_ref: upstream,
    p01_request_ref: upstream,
    p01_source_snapshot_ref: upstream,
    p01_source_file_manifest_ref: upstream,
    p01_source_custody_ref: upstream,
    p01_model_data_policy_ref: upstream,
  };
  const cohort = withSelfDigest(
    {
      schema_id: SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
      schema_version: 1 as const,
      tenant_id: "tenant",
      project_id: "project",
      run_id: runId,
      phase_id: "SCA-P04" as const,
      p04_request_ref: requestRef,
      implementation_identity_ref: upstream,
      runtime_policy_ref: upstream,
      refs: cohortRefs,
      transitive_refs_sha256: sha256(canonicalJson([upstream])),
      transitive_ref_count: 20,
      qualification_scope: "deterministic_test_only" as const,
      accepted_p03: true as const,
      model_data_policy_status: "approved" as const,
      admitted_at: "2026-09-21T00:00:00.000Z",
    },
    "admission_sha256"
  );
  const cohortRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P04",
    kind: "sca-p04-accepted-cohort",
    operationId: "sca-p04-accepted-cohort",
    producer: "host:sca-p04-candidate",
    schemaId: SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
    value: cohort,
    upstream: [requestRef, upstream],
  });
  const sourceDigest = upstream.content_digest;
  const scannerId = scaP04StableItemId({
    source_snapshot_sha256: sourceDigest,
    item_kind: "scanner_lead",
    normalized_locator: "scanner:src/alerted.ts:9:rule",
    upstream_ids: ["scanner-observation"],
  });
  const noAlertId = scaP04StableItemId({
    source_snapshot_sha256: sourceDigest,
    item_kind: "source_surface",
    normalized_locator: "source:src/no-alert.ts",
    upstream_ids: ["source-file"],
  });
  const unsortedItems: ScaP04PopulationItemV1[] = [
    {
      stable_id: scannerId,
      item_kind: "scanner_lead",
      normalized_locator: "scanner:src/alerted.ts:9:rule",
      source_path: "src/alerted.ts",
      package_coordinate: null,
      alert_state: "scanner_alert",
      aliases: [],
      upstream_ids: ["scanner-observation"],
      evidence_refs: [upstream],
      assigned_specialists: [SCA_P04_SCANNER_SPECIALIST],
      selection_metadata: {
        metadata_kind: "scanner_observation",
        operation_kind: "semgrep_js_ts",
        observation_id: "scanner-observation",
        analyzer_id: "semgrep-js-ts",
        category: "security-rule",
        subject: "scanner lead",
        start_line: 9,
        advisory_id: null,
        correlation_id: "scanner-correlation",
        duplicate_group_id: null,
      },
      description: "Scanner lead for deeper P05 analysis",
    },
    {
      stable_id: noAlertId,
      item_kind: "source_surface",
      normalized_locator: "source:src/no-alert.ts",
      source_path: "src/no-alert.ts",
      package_coordinate: null,
      alert_state: "no_alert",
      aliases: [],
      upstream_ids: ["source-file"],
      evidence_refs: [binaryGraphRef],
      assigned_specialists: [SCA_P04_UNDERDETECTED_SPECIALIST],
      selection_metadata: {
        metadata_kind: "source_surface",
        content_sha256: "f".repeat(64),
        scanner_alert_present: false,
      },
      description: "No-alert source surface; absence is not evidence of safety",
    },
  ];
  const candidateId = "p03c_" + sha256("unresolved candidate");
  const queryId = "p03.unsupported-surface.v2";
  unsortedItems.push({
    stable_id: scaP04StableItemId({
      source_snapshot_sha256: sourceDigest,
      item_kind: "graph_candidate",
      normalized_locator: "graph:unresolved",
      upstream_ids: [candidateId, queryId],
    }),
    item_kind: "graph_candidate",
    normalized_locator: "graph:unresolved",
    source_path: "src/no-alert.ts",
    package_coordinate: null,
    alert_state: "no_alert",
    aliases: [candidateId],
    upstream_ids: [candidateId, queryId].sort(),
    evidence_refs: [binaryGraphRef, upstream].sort((a, b) =>
      a.artifact_id.localeCompare(b.artifact_id)
    ),
    assigned_specialists: [SCA_P04_UNDERDETECTED_SPECIALIST],
    selection_metadata: {
      metadata_kind: "p03_graph_candidate",
      candidate_id: candidateId,
      partition: "javascript_typescript",
      query_id: queryId,
      claim: "unsupported_surface",
      disposition: "unresolved",
      reason_code: "relationship_unproven",
      graph_component_sha256: binaryGraphRef.content_digest,
      source_snapshot_sha256: sourceDigest,
      query_release_sha256: sha256("query release"),
      graph_component_ref: binaryGraphRef,
      page_ref: upstream,
      stable_locator: "unresolved",
      summary: "Relationship remains unproven",
    },
    description: "P03 preparation acceptance is not a safety verdict",
  });
  const items = unsortedItems.sort((left, right) => left.stable_id.localeCompare(right.stable_id));
  const population = validateScaP04SelectionPopulationV1(
    withSelfDigest(
      {
        schema_id: SCA_P04_POPULATION_V1_SCHEMA,
        schema_version: 1 as const,
        phase_id: "SCA-P04" as const,
        run_id: runId,
        source_snapshot_ref: upstream,
        source_snapshot_sha256: sourceDigest,
        accepted_cohort_ref: cohortRef,
        items,
        item_count: items.length,
        max_selected_items: 10,
        specialist_ids: [...SCA_P04_SPECIALIST_IDS],
      },
      "population_sha256"
    )
  );
  const populationRef = persistJson(artifacts, {
    runId,
    phase: "SCA-P04",
    kind: "sca-p04-selection-population",
    operationId: "sca-p04-selection-population",
    producer: "host:sca-p04-candidate",
    schemaId: SCA_P04_POPULATION_V1_SCHEMA,
    value: population,
    upstream: [cohortRef, upstream],
  });
  const admission: ScaP04CognitiveAdmissionV1 & ScaP04DisclosurePolicyAdmissionV1 = {
    request: { run_id: runId },
    runtime_policy: { max_payload_bytes_per_call: 1_000_000 },
    p01_request: { model_data_policy_ref: upstream },
    model_data_policy: {
      payload_limit_bytes: 1_000_000,
      destination_class: "cloud",
      provider_retention_status: "known",
      provider_retention_days: 0,
      provider_training_use: "prohibited",
      data_classes: [
        { data_class: "source-code", treatment: "allow-minimized" },
        { data_class: "scanner-evidence", treatment: "allow-minimized" },
        { data_class: "dependency-coordinates", treatment: "allow-minimized" },
        { data_class: "secrets", treatment: "deny" },
        { data_class: "personal-data", treatment: "deny" },
      ],
    },
  };
  const initialRefs: ArtifactRef[] = [requestRef, cohortRef, populationRef];
  for (const specialistId of SCA_P04_SPECIALIST_IDS) {
    const payload = buildScaP04CognitivePayload({
      admission,
      population,
      population_ref: populationRef,
      specialist_id: specialistId,
    });
    const payloadRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P04",
      branchId: specialistId,
      kind: "sca-p04-cognitive-payload",
      operationId: `sca-p04-${specialistId}-payload`,
      producer: "host:sca-p04-candidate",
      schemaId: "penny.sca-p04-cognitive-payload.v1",
      value: payload,
      upstream: [cohortRef, populationRef],
    });
    const disclosure = buildScaP04DisclosureAdmission({
      admission,
      payload,
      payload_ref: payloadRef,
      agent: specialistId === SCA_P04_SCANNER_SPECIALIST ? "annie" : "echo",
    });
    const finalDisclosure = options.forcePreDispatchPolicyDenial
      ? (() => {
          const { admission_sha256: _digest, ...body } = disclosure;
          return withSelfDigest(
            { ...body, serialized_opening_byte_limit: payloadRef.byte_length },
            "admission_sha256"
          );
        })()
      : disclosure;
    const disclosureRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P04",
      branchId: specialistId,
      kind: "sca-p04-disclosure-admission",
      operationId: `sca-p04-${specialistId}-disclosure-admission`,
      producer: "host:sca-p04-candidate",
      schemaId: SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: finalDisclosure,
      upstream: [payloadRef, upstream],
    });
    initialRefs.push(payloadRef, disclosureRef);
  }
  return { initialRefs, items, population, binaryGraphRef };
}

function context(runId: string, initialArtifacts: readonly ArtifactRef[]): RunContext {
  return RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: "sca-p04-candidate",
      engine_owner: "typescript",
    },
    goal: "Exercise synthetic P04 candidate without live authorization.",
    constraints: {},
    projectRoot: "/tmp/penny-sca-p04-test",
    trustProfile: "hardened-untrusted",
    maxSteps: 16,
    initialArtifacts,
  });
}

function requireSpecialistId(
  value: string
): typeof SCA_P04_SCANNER_SPECIALIST | typeof SCA_P04_UNDERDETECTED_SPECIALIST {
  if (value === SCA_P04_SCANNER_SPECIALIST || value === SCA_P04_UNDERDETECTED_SPECIALIST) {
    return value;
  }
  throw new Error(`unexpected P04 specialist: ${value}`);
}

function specialistResult(
  specialistId: typeof SCA_P04_SCANNER_SPECIALIST | typeof SCA_P04_UNDERDETECTED_SPECIALIST,
  population: ScaP04SelectionPopulationV1,
  recommendation: "select" | "omit" | "defer" | "block",
  options: {
    readonly evidenceStatus?: "sufficient_for_selection" | "bounded_but_usable" | "evidence_gap";
    readonly branchGapCodes?: readonly (
      | "assigned_evidence_incomplete"
      | "payload_metadata_insufficient"
      | "population_assignment_inconsistent"
      | "specialist_scope_unavailable"
    )[];
  } = {}
): ScaP04SpecialistResultV1 {
  const assigned = population.items.filter((item) =>
    item.assigned_specialists.includes(specialistId)
  );
  const evidenceStatus =
    options.evidenceStatus ??
    (recommendation === "defer" || recommendation === "block"
      ? "evidence_gap"
      : "bounded_but_usable");
  return {
    schema_id: SCA_P04_SPECIALIST_RESULT_V1_SCHEMA,
    schema_version: 1,
    specialist_id: specialistId,
    role:
      specialistId === SCA_P04_SCANNER_SPECIALIST
        ? "scanner_and_dependency_leads"
        : "underdetected_and_no_alert_surfaces",
    population_sha256: population.population_sha256,
    assigned_item_ids: assigned.map((item) => item.stable_id),
    results: assigned.map((item) => ({
      stable_id: item.stable_id,
      recommendation,
      reason_code:
        recommendation === "select"
          ? "select_for_p05"
          : recommendation === "omit"
            ? "omit_lower_relative_priority"
            : recommendation === "defer"
              ? "defer_pending_evidence"
              : "block_required_evidence_gap",
      evidence_status: evidenceStatus,
      evidence_refs: item.evidence_refs,
      p05_question_codes:
        recommendation === "select"
          ? (["inspect_source_surface"] as const)
          : recommendation === "omit"
            ? []
            : (["resolve_evidence_gap"] as const),
      uncertainty_code:
        evidenceStatus === "evidence_gap"
          ? "missing_required_evidence"
          : item.alert_state === "no_alert"
            ? "scanner_absence_only"
            : "bounded_metadata_only",
    })),
    discoveries: [],
    branch_gap_codes: [...(options.branchGapCodes ?? [])].sort(),
    complete: true,
  };
}

function persistWorkerEvidence(
  artifacts: ArtifactStore,
  runId: string,
  branch: Extract<
    ReturnType<ScaP04CandidatePlaybook["initialize"]>,
    { action: "invoke_agents_parallel" }
  >["branches"][number],
  result: ScaP04SpecialistResultV1,
  authority?: ReceiptAuthority
): {
  output: ArtifactRef;
  guard: ArtifactRef;
  receipt: ArtifactRef;
  workerReceipt: ExecutionReceipt;
} {
  const output = artifacts.persist({
    metadata: branch.output_artifact as OutputArtifactMetadata,
    content: `SUMMARY:${canonicalJson(result)}`,
  });
  const coordinate = {
    run_id: runId,
    state_id: branch.state_id,
    branch_id: branch.branch_id,
    agent: branch.agent,
    attempt: branch.attempt,
  };
  const guard = persistJson(artifacts, {
    runId,
    phase: branch.state_id,
    branchId: branch.branch_id,
    kind: "model-dispatch-guard",
    operationId: modelDispatchGuardOperationId(coordinate),
    producer: "host:required-model-runtime",
    schemaId: MODEL_DISPATCH_GUARD_V1_SCHEMA,
    value: {
      schema_id: MODEL_DISPATCH_GUARD_V1_SCHEMA,
      schema_version: 1,
      coordinate,
      registration_sha256: "7".repeat(64),
      requested_model: SCA_P04_REQUIRED_MODEL,
      input_artifacts_sha256: sha256(canonicalJson(branch.input_artifacts)),
      serialized_opening_sha256: "a".repeat(64),
      serialized_opening_byte_length: 1,
      provider_opening_guard: "sca_p04_payload_disclosure_v1",
      guarded_at: "2026-09-21T00:00:01.000Z",
    },
    upstream: branch.input_artifacts.artifacts.map((binding) => binding.ref),
  });
  const receiptBody = {
    schema_version: 2 as const,
    receipt_id: `receipt-${branch.branch_id}`,
    run_id: runId,
    state_id: branch.state_id,
    branch_id: branch.branch_id,
    agent: branch.agent,
    attempt: branch.attempt,
    worker_id: `worker-${branch.branch_id}`,
    executor: "pi-sdk" as const,
    command: ["pi-sdk", branch.agent],
    model: SCA_P04_REQUIRED_MODEL.override,
    requested_model: SCA_P04_REQUIRED_MODEL,
    observed_model: {
      provider: SCA_P04_REQUIRED_MODEL.provider,
      model: SCA_P04_REQUIRED_MODEL.model,
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
        playbook: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      state_id: branch.state_id,
      branch_id: branch.branch_id,
      agent: branch.agent,
      attempt: branch.attempt,
      trust_profile: "hardened-untrusted",
      model_override: SCA_P04_REQUIRED_MODEL.override,
      task_sha256: sha256(branch.task),
      input_artifacts: branch.input_artifacts,
      output_artifact: branch.output_artifact,
    }),
  };
  const executionReceipt =
    authority === undefined
      ? validateContract(
          ExecutionReceiptSchema,
          { ...receiptBody, signature: `hmac-sha256:${"9".repeat(64)}` },
          "P04 test execution receipt"
        )
      : authority.sign(receiptBody);
  const receipt = persistJson(artifacts, {
    runId,
    phase: branch.state_id,
    branchId: branch.branch_id,
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
    upstream: [guard, output],
  });
  return { output, guard, receipt, workerReceipt: executionReceipt };
}

function completeSpecialistFan(input: {
  readonly artifacts: ArtifactStore;
  readonly runId: string;
  readonly fixture: ReturnType<typeof syntheticFixture>;
  readonly playbook: ScaP04CandidatePlaybook;
  readonly run: RunContext;
  readonly resultFor: (
    specialistId: (typeof SCA_P04_SPECIALIST_IDS)[number]
  ) => ScaP04SpecialistResultV1;
}): ReturnType<ScaP04CandidatePlaybook["acceptSummary"]> {
  const directive = input.playbook.initialize(input.run);
  if (directive.action !== "invoke_agents_parallel") {
    throw new Error("expected P04 specialist fan");
  }
  const results = directive.branches.map((branch) => {
    const result = input.resultFor(requireSpecialistId(branch.branch_id));
    const persisted = persistWorkerEvidence(input.artifacts, input.runId, branch, result);
    const pending = input.run.pendingBranches.find(
      (candidate) => candidate.branch_id === branch.branch_id
    );
    if (pending === undefined) throw new Error("pending P04 branch absent");
    pending.completed = true;
    pending.confidence = "PROBABLE";
    pending.result = result;
    pending.artifact = persisted.output;
    return result;
  });
  return input.playbook.acceptSummary(
    input.run,
    input.playbook.aggregateBranches(results),
    "PROBABLE"
  );
}

type SpecialistResultItem = ScaP04SpecialistResultV1["results"][number];

const SCA_P04_SEMANTIC_ADVERSARIAL_CASES: readonly {
  readonly label: string;
  readonly recommendation: SpecialistResultItem["recommendation"];
  readonly mutate: (entry: SpecialistResultItem) => SpecialistResultItem;
}[] = [
  {
    label: "select_with_evidence_gap",
    recommendation: "select",
    mutate: (entry) => ({ ...entry, evidence_status: "evidence_gap" }),
  },
  {
    label: "omit_with_missing_evidence",
    recommendation: "omit",
    mutate: (entry) => ({ ...entry, uncertainty_code: "missing_required_evidence" }),
  },
  {
    label: "select_with_gap_resolution_question",
    recommendation: "select",
    mutate: (entry) => ({ ...entry, p05_question_codes: ["resolve_evidence_gap"] }),
  },
  {
    label: "defer_without_evidence_gap",
    recommendation: "defer",
    mutate: (entry) => ({ ...entry, evidence_status: "bounded_but_usable" }),
  },
  {
    label: "block_without_missing_evidence",
    recommendation: "block",
    mutate: (entry) => ({ ...entry, uncertainty_code: "bounded_metadata_only" }),
  },
  {
    label: "defer_without_gap_resolution_question",
    recommendation: "defer",
    mutate: (entry) => ({ ...entry, p05_question_codes: [] }),
  },
];

describe("SCA P04 deterministic specialist convergence", () => {
  it("creates distinct specialist dossiers and an exhaustive stable partition without authorizing P05 from synthetic lineage", () => {
    using artifacts = store();
    const runId = "run-p04-synthetic";
    const fixture = syntheticFixture(artifacts, runId);
    const run = context(runId, fixture.initialRefs);
    const playbook = new ScaP04CandidatePlaybook(
      artifacts,
      () => new Date("2026-09-21T00:00:03.000Z")
    );
    const directive = playbook.initialize(run);
    expect(directive.action).toBe("invoke_agents_parallel");
    if (directive.action !== "invoke_agents_parallel")
      throw new Error("expected P04 specialist fan");
    expect(directive.branches.map((branch) => branch.agent).sort()).toEqual(["annie", "echo"]);
    expect(
      directive.branches.every(
        (branch) => branch.model_override === SCA_P04_REQUIRED_MODEL.override
      )
    ).toBe(true);
    expect(
      directive.branches.every(
        (branch) =>
          canonicalJson(branch.input_artifacts.artifacts.map((binding) => binding.slot).sort()) ===
          canonicalJson(["cognitive_payload", "disclosure_admission"].sort())
      )
    ).toBe(true);

    const results = directive.branches.map((branch) => {
      const result = specialistResult(
        requireSpecialistId(branch.branch_id),
        fixture.population,
        branch.branch_id === SCA_P04_SCANNER_SPECIALIST ? "select" : "omit"
      );
      const persisted = persistWorkerEvidence(artifacts, runId, branch, result);
      const pending = run.pendingBranches.find(
        (candidate) => candidate.branch_id === branch.branch_id
      );
      if (pending === undefined) throw new Error("pending P04 branch absent");
      pending.completed = true;
      pending.confidence = "PROBABLE";
      pending.result = result;
      pending.artifact = persisted.output;
      return result;
    });
    const aggregate = playbook.aggregateBranches(results);
    const terminal = playbook.acceptSummary(run, aggregate, "PROBABLE");
    expect(terminal.action).toBe("incomplete");
    if (terminal.action !== "incomplete") throw new Error("expected P04 nonterminal result");
    const result = validateScaP04TerminalV1(terminal.result);
    expect(result.status).toBe("blocked");
    expect(result.p05_authorized).toBe(false);
    expect(result.p05_transition_ref).toBeNull();
    expect(result.blocker_codes).toContain("synthetic_lineage_not_authorizing");
    expect(
      artifacts.refFor(
        runId,
        "SCA-P04",
        null,
        "sca-p04-to-p05-transition",
        "sca-p04-to-p05-transition",
        1
      )
    ).toBeNull();

    const selectionRef = artifacts.refFor(
      runId,
      "SCA-P04",
      null,
      "sca-p04-selection-dossier",
      "sca-p04-selection-dossier",
      1
    );
    const omissionRef = artifacts.refFor(
      runId,
      "SCA-P04",
      null,
      "sca-p04-omission-dossier",
      "sca-p04-omission-dossier",
      1
    );
    const coverageRef = artifacts.refFor(
      runId,
      "SCA-P04",
      null,
      "sca-p04-coverage-dossier",
      "sca-p04-coverage-dossier",
      1
    );
    const selection = validateScaP04SelectionDossierV1(
      JSON.parse(
        artifacts.readById(requireRef(selectionRef, "selection").artifact_id).toString("utf8")
      )
    );
    const omission = validateScaP04OmissionDossierV1(
      JSON.parse(
        artifacts.readById(requireRef(omissionRef, "omission").artifact_id).toString("utf8")
      )
    );
    const coverage = validateScaP04CoverageDossierV1(
      JSON.parse(
        artifacts.readById(requireRef(coverageRef, "coverage").artifact_id).toString("utf8")
      )
    );
    expect(selection.selected_count).toBe(1);
    expect(omission.omitted_count).toBe(2);
    expect(omission.omitted.every((entry) => entry.safe_claim === false)).toBe(true);
    expect(
      [...selection.selected, ...omission.omitted].map((entry) => entry.stable_id).sort()
    ).toEqual(fixture.items.map((item) => item.stable_id).sort());
    expect(coverage.exhaustive).toBe(true);
    expect(coverage.no_alert_semantics).toBe("absence_of_scanner_alert_is_not_evidence_of_safety");
    expect(artifacts.readById(fixture.binaryGraphRef.artifact_id)).toEqual(
      Buffer.from([0, 255, 1, 2, 3, 128])
    );
    const ledgerRef = artifacts.refFor(
      runId,
      "SCA-P04",
      null,
      "sca-p04-successor-obligation-ledger",
      "sca-p04-successor-obligation-ledger",
      1
    );
    const ledger = validateScaP04SuccessorLedgerV1(
      JSON.parse(artifacts.readById(requireRef(ledgerRef, "ledger").artifact_id).toString("utf8"))
    );
    expect(ledger.pending_obligations).toEqual([]);
    expect(ledger.dispositions.map((entry) => [entry.obligation_id, entry.status])).toEqual([
      ["SCA-OBL-P04-ACCEPTANCE", "satisfied"],
      ["SCA-OBL-OUTPUT-P04-SPECIALIST-DOSSIERS", "satisfied"],
      ["SCA-OBL-OUTPUT-P04-SELECTION-DOSSIER", "satisfied"],
      ["SCA-OBL-OUTPUT-P04-OMISSION-DOSSIER", "satisfied"],
      ["SCA-OBL-OUTPUT-P04-COVERAGE-DOSSIER", "satisfied"],
    ]);

    const dossiers = SCA_P04_SPECIALIST_IDS.map((specialistId) => {
      const dossierRef = artifacts.refFor(
        runId,
        "SCA-P04",
        specialistId,
        "sca-p04-specialist-dossier",
        `sca-p04-${specialistId}-dossier`,
        1
      );
      return validateScaP04SpecialistDossierV1(
        JSON.parse(
          artifacts
            .readById(requireRef(dossierRef, "specialist dossier").artifact_id)
            .toString("utf8")
        )
      );
    });
    expect(dossiers.map((dossier) => dossier.role).sort()).toEqual([
      "scanner_and_dependency_leads",
      "underdetected_and_no_alert_surfaces",
    ]);
    expect(dossiers.map((dossier) => dossier.agent).sort()).toEqual(["annie", "echo"]);
    expect(
      SCA_P04_SPECIALIST_IDS.map((specialistId) => {
        const agent = specialistId === SCA_P04_SCANNER_SPECIALIST ? "annie" : "echo";
        return artifacts.refFor(
          runId,
          "selecting_surfaces",
          specialistId,
          "model-execution-receipt",
          modelExecutionReceiptOperationId({
            run_id: runId,
            state_id: "selecting_surfaces",
            branch_id: specialistId,
            agent,
            attempt: 1,
          }),
          1
        );
      }).filter((ref) => ref !== null)
    ).toHaveLength(2);
  });

  it.each([
    {
      label: "deferred selection",
      recommendation: "defer" as const,
      options: {},
      blocker: "deferred_selection_pending",
      reason: "deferred_selection",
    },
    {
      label: "blocked evidence gap",
      recommendation: "block" as const,
      options: {},
      blocker: "blocked_evidence_gap",
      reason: "blocked_evidence_gap",
    },
    {
      label: "branch gap",
      recommendation: "select" as const,
      options: { branchGapCodes: ["payload_metadata_insufficient" as const] },
      blocker: "specialist_branch_gap",
      reason: "branch_gap",
    },
  ])(
    "keeps successor obligations pending for $label",
    ({ recommendation, options, blocker, reason }) => {
      using artifacts = store();
      const runId = `run-p04-gap-${reason}`;
      const fixture = syntheticFixture(artifacts, runId);
      const run = context(runId, fixture.initialRefs);
      const playbook = new ScaP04CandidatePlaybook(artifacts);
      const terminal = completeSpecialistFan({
        artifacts,
        runId,
        fixture,
        playbook,
        run,
        resultFor: (specialistId) =>
          specialistResult(
            specialistId,
            fixture.population,
            specialistId === SCA_P04_SCANNER_SPECIALIST ? recommendation : "omit",
            specialistId === SCA_P04_SCANNER_SPECIALIST ? options : {}
          ),
      });
      if (terminal.action !== "incomplete") throw new Error("expected blocked P04 terminal");
      const result = validateScaP04TerminalV1(terminal.result);
      expect(result.blocker_codes).toContain(blocker);
      if (recommendation === "defer" || recommendation === "block") {
        expect(result.blocker_codes).toContain("required_evidence_gap");
      }
      expect(result.p05_authorized).toBe(false);
      const ledgerRef = requireRef(
        artifacts.refFor(
          runId,
          "SCA-P04",
          null,
          "sca-p04-successor-obligation-ledger",
          "sca-p04-successor-obligation-ledger",
          1
        ),
        "gap ledger"
      );
      const ledger = validateScaP04SuccessorLedgerV1(
        JSON.parse(artifacts.readById(ledgerRef.artifact_id).toString("utf8"))
      );
      expect(ledger.pending_obligations.some((entry) => entry.reason_code === reason)).toBe(true);
      expect(ledger.dispositions[0]?.status).toBe("pending");
      expect(ledger.dispositions.slice(1).every((entry) => entry.status === "satisfied")).toBe(
        true
      );
    }
  );

  it.each(SCA_P04_SEMANTIC_ADVERSARIAL_CASES)(
    "rejects $label during full finalization before any P05 gate can pass",
    ({ label, recommendation, mutate }) => {
      using artifacts = store();
      const runId = `run-p04-adversarial-${label}`;
      const fixture = syntheticFixture(artifacts, runId);
      const run = context(runId, fixture.initialRefs);
      const playbook = new ScaP04CandidatePlaybook(artifacts);
      expect(() =>
        completeSpecialistFan({
          artifacts,
          runId,
          fixture,
          playbook,
          run,
          resultFor: (specialistId) => {
            const valid = specialistResult(
              specialistId,
              fixture.population,
              specialistId === SCA_P04_SCANNER_SPECIALIST ? recommendation : "omit"
            );
            if (specialistId !== SCA_P04_SCANNER_SPECIALIST) return valid;
            return { ...valid, results: valid.results.map((entry) => mutate(entry)) };
          },
        })
      ).toThrow(/evidence-gap semantics mismatch/u);
      expect(
        artifacts.refFor(runId, "SCA-P04", null, "sca-p04-gate", "sca-p04-gate", 1)
      ).toBeNull();
    }
  );

  it("rejects a forged exact evidence ref even when its artifact ID exists", () => {
    using artifacts = store();
    const runId = "run-p04-forged-ref";
    const fixture = syntheticFixture(artifacts, runId);
    const run = context(runId, fixture.initialRefs);
    const playbook = new ScaP04CandidatePlaybook(artifacts);
    expect(() =>
      completeSpecialistFan({
        artifacts,
        runId,
        fixture,
        playbook,
        run,
        resultFor: (specialistId) => {
          const valid = specialistResult(specialistId, fixture.population, "select");
          if (specialistId !== SCA_P04_SCANNER_SPECIALIST) return valid;
          const first = valid.results[0];
          const admittedEvidence = first?.evidence_refs[0];
          if (first === undefined || admittedEvidence === undefined) {
            throw new Error("scanner result evidence absent");
          }
          return {
            ...valid,
            results: [
              {
                ...first,
                evidence_refs: [{ ...admittedEvidence, kind: "forged-kind" }],
              },
            ],
          };
        },
      })
    ).toThrow(/non-admitted exact evidence/u);
  });

  it("rejects cross-specialist discovery evidence outside its basis item", () => {
    using artifacts = store();
    const runId = "run-p04-cross-specialist-discovery";
    const fixture = syntheticFixture(artifacts, runId);
    const run = context(runId, fixture.initialRefs);
    const playbook = new ScaP04CandidatePlaybook(artifacts);
    expect(() =>
      completeSpecialistFan({
        artifacts,
        runId,
        fixture,
        playbook,
        run,
        resultFor: (specialistId) => {
          const valid = specialistResult(specialistId, fixture.population, "select");
          if (specialistId !== SCA_P04_SCANNER_SPECIALIST) return valid;
          const basis = fixture.items.find((item) =>
            item.assigned_specialists.includes(SCA_P04_SCANNER_SPECIALIST)
          );
          if (basis === undefined) throw new Error("scanner basis item absent");
          const evidenceRefs = [fixture.binaryGraphRef];
          const normalizedLocator = "source:src/cross-specialist.ts";
          return {
            ...valid,
            discoveries: [
              {
                stable_id: scaP04StableDiscoveryId({
                  source_snapshot_sha256: fixture.population.source_snapshot_sha256,
                  specialist_id: SCA_P04_SCANNER_SPECIALIST,
                  basis_item_id: basis.stable_id,
                  normalized_locator: normalizedLocator,
                  evidence_refs: evidenceRefs,
                }),
                basis_item_id: basis.stable_id,
                normalized_locator: normalizedLocator,
                source_path: "src/cross-specialist.ts",
                package_coordinate: null,
                recommendation: "select",
                reason_code: "select_for_p05",
                evidence_refs: evidenceRefs,
              },
            ],
          };
        },
      })
    ).toThrow(/basis item/u);
  });

  it("blocks a payload/admission digest splice before any specialist dispatch", () => {
    using artifacts = store();
    const runId = "run-p04-payload-splice";
    const fixture = syntheticFixture(artifacts, runId);
    const scannerDisclosureRef = fixture.initialRefs.find(
      (ref) =>
        ref.branch_id === SCA_P04_SCANNER_SPECIALIST && ref.kind === "sca-p04-disclosure-admission"
    );
    if (scannerDisclosureRef === undefined) throw new Error("scanner disclosure fixture absent");
    const valid = validateScaP04DisclosureAdmissionV1(
      JSON.parse(artifacts.readById(scannerDisclosureRef.artifact_id).toString("utf8"))
    );
    const { admission_sha256: _discard, ...body } = valid;
    const forged = withSelfDigest({ ...body, payload_sha256: "0".repeat(64) }, "admission_sha256");
    const forgedRef = persistJson(artifacts, {
      runId,
      phase: "SCA-P04",
      branchId: SCA_P04_SCANNER_SPECIALIST,
      kind: "sca-p04-disclosure-admission",
      operationId: "sca-p04-scanner-forged-disclosure",
      producer: "host:sca-p04-candidate",
      schemaId: SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
      value: forged,
      upstream: [scannerDisclosureRef],
    });
    const run = context(runId, [...fixture.initialRefs, forgedRef]);
    const playbook = new ScaP04CandidatePlaybook(artifacts);
    expect(() => playbook.initialize(run)).toThrow(/payload\/disclosure binding drift/u);
    expect(run.pendingBranches).toEqual([]);
  });

  it("durably terminalizes a pre-dispatch opening denial and never replays it after SQLite reopen", async () => {
    const env = serviceEnvironment();
    const runId = "run-p04-pre-dispatch-policy-denied";
    const identity = {
      schema_version: 2 as const,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript" as const,
    };
    const client = new OpeningGuardModelClient();
    let terminal: Awaited<ReturnType<OrchestrationService["execute"]>>;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: client,
        playbookRegistration: SCA_P04_CANDIDATE_REGISTRATION,
      });
      const fixture = syntheticFixture(first.artifacts, runId, {
        forcePreDispatchPolicyDenial: true,
      });
      const checkpoint = RunContext.create({
        identity,
        goal: "Deny a forged opening admission before provider dispatch.",
        constraints: {},
        projectRoot: PROJECT_ROOT,
        trustProfile: "hardened-untrusted",
        maxSteps: 20,
        registrationContractBinding: {
          schema_version: 1,
          registration_name: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
          contract_sha256: skillContractSha256(first.engine.contract),
          registration_sha256: runtimeRegistrationSha256(first.engine.registration),
        },
        initialArtifacts: fixture.initialRefs,
      });
      new ScaP04CandidatePlaybook(first.artifacts).initialize(checkpoint);
      first.checkpointer.createRun(checkpoint, "test_pre_dispatch_denial_pending", {
        run_id: runId,
      });

      terminal = await first.execute({ schema_version: 2, action: "recover", identity });
      expect(terminal.action).toBe("cancelled");
      if (terminal.action !== "cancelled") throw new Error("expected cancelled P04 terminal");
      expect(terminal.result).toMatchObject({
        blocker_codes: ["pre_dispatch_policy_denied"],
        p05_authorized: false,
        p05_transition_ref: null,
      });
      expect(client.providerPrompts).toBe(0);
      for (const specialistId of SCA_P04_SPECIALIST_IDS) {
        const agent = specialistId === SCA_P04_SCANNER_SPECIALIST ? "annie" : "echo";
        expect(
          first.artifacts.refFor(
            runId,
            "selecting_surfaces",
            specialistId,
            "model-dispatch-guard",
            modelDispatchGuardOperationId({
              run_id: runId,
              state_id: "selecting_surfaces",
              branch_id: specialistId,
              agent,
              attempt: 1,
            }),
            1
          )
        ).toBeNull();
      }
      expect(first.checkpointer.loadRun(identity).terminalDirective).not.toBeNull();
    }

    {
      using reopened = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new UnreachableModelClient(),
        playbookRegistration: SCA_P04_CANDIDATE_REGISTRATION,
      });
      const recovered = await reopened.execute({
        schema_version: 2,
        action: "recover",
        identity,
      });
      expect(canonicalJson(recovered)).toBe(canonicalJson(terminal));
      expect(reopened.checkpointer.loadRun(identity).terminalDirective).not.toBeNull();
    }
  });

  it("recovers only an incomplete branch and durably quarantines a dispatched unknown across SQLite reopen", () => {
    const env = serviceEnvironment();
    const runId = "run-p04-sqlite-recovery";
    const identity = {
      schema_version: 2 as const,
      run_id: runId,
      session_id: `session-${runId}`,
      playbook: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
      engine_owner: "typescript" as const,
    };
    let completedBranchResult: PhaseResult | undefined;
    {
      using first = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new UnreachableModelClient(),
        playbookRegistration: SCA_P04_CANDIDATE_REGISTRATION,
      });
      const fixture = syntheticFixture(first.artifacts, runId);
      const checkpoint = RunContext.create({
        identity,
        goal: "Select bounded P04 surfaces without vulnerability adjudication.",
        constraints: {},
        projectRoot: PROJECT_ROOT,
        trustProfile: "hardened-untrusted",
        maxSteps: 20,
        registrationContractBinding: {
          schema_version: 1,
          registration_name: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
          contract_sha256: skillContractSha256(first.engine.contract),
          registration_sha256: runtimeRegistrationSha256(first.engine.registration),
        },
        initialArtifacts: fixture.initialRefs,
      });
      const directive = new ScaP04CandidatePlaybook(first.artifacts).initialize(checkpoint);
      if (directive.action !== "invoke_agents_parallel") {
        throw new Error("expected initial P04 fan");
      }
      const scanner = directive.branches.find(
        (branch) => branch.branch_id === SCA_P04_SCANNER_SPECIALIST
      );
      const missingBranch = directive.branches.find(
        (branch) => branch.branch_id === SCA_P04_UNDERDETECTED_SPECIALIST
      );
      if (scanner === undefined || missingBranch === undefined) {
        throw new Error("expected both P04 branches");
      }
      const scannerResult = specialistResult(
        SCA_P04_SCANNER_SPECIALIST,
        fixture.population,
        "select"
      );
      const evidence = persistWorkerEvidence(
        first.artifacts,
        runId,
        scanner,
        scannerResult,
        first.engine.receiptAuthority
      );
      const pending = checkpoint.pendingBranches.find(
        (branch) => branch.branch_id === SCA_P04_SCANNER_SPECIALIST
      );
      if (pending === undefined) throw new Error("scanner checkpoint branch absent");
      pending.completed = true;
      pending.confidence = "PROBABLE";
      pending.result = scannerResult;
      pending.artifact = evidence.output;
      first.checkpointer.createRun(checkpoint, "test_partial_fan_committed", {
        run_id: runId,
        completed_branch_id: SCA_P04_SCANNER_SPECIALIST,
      });
      const duplicate: PhaseResult = {
        schema_version: 2,
        run_id: runId,
        state_id: scanner.state_id,
        branch_id: scanner.branch_id,
        agent: scanner.agent,
        attempt: scanner.attempt,
        confidence: "PROBABLE",
        details: scannerResult,
        output_artifact: evidence.output,
        worker_receipt: evidence.workerReceipt,
      };
      completedBranchResult = duplicate;
      expect(() =>
        first.handle({ schema_version: 2, action: "step", identity, result: duplicate })
      ).toThrow(/duplicate_branch/u);
      expect(
        first.checkpointer
          .loadRun(identity)
          .pendingBranches.find((branch) => branch.branch_id === SCA_P04_SCANNER_SPECIALIST)
          ?.completed
      ).toBe(true);
    }

    {
      using recovered = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new UnreachableModelClient(),
        playbookRegistration: SCA_P04_CANDIDATE_REGISTRATION,
      });
      const retry = recovered.handle({ schema_version: 2, action: "recover", identity });
      if (retry.action !== "invoke_agents_parallel") {
        throw new Error("expected missing-branch recovery fan");
      }
      expect(retry.branches.map((branch) => branch.branch_id)).toEqual([
        SCA_P04_UNDERDETECTED_SPECIALIST,
      ]);
      if (completedBranchResult === undefined) throw new Error("completed branch result absent");
      expect(() =>
        recovered.handle({
          schema_version: 2,
          action: "step",
          identity,
          result: completedBranchResult,
        })
      ).toThrow(/wrong_branch/u);
      const persisted = recovered.checkpointer.loadRun(identity);
      expect(persisted.pendingDirective).toMatchObject({
        action: "invoke_agents_parallel",
        branches: [{ branch_id: SCA_P04_UNDERDETECTED_SPECIALIST }],
      });
      expect(
        persisted.pendingBranches.find((branch) => branch.branch_id === SCA_P04_SCANNER_SPECIALIST)
      ).toMatchObject({ completed: true, confidence: "PROBABLE" });
      const branch = retry.branches[0];
      if (branch === undefined) throw new Error("missing recovery branch absent");
      const population = validateScaP04SelectionPopulationV1(
        JSON.parse(
          recovered.artifacts
            .readById(
              requireRef(
                persisted.selectedArtifacts.find(
                  (ref) => ref.kind === "sca-p04-selection-population"
                ) ?? null,
                "recovered population"
              ).artifact_id
            )
            .toString("utf8")
        )
      );
      persistWorkerEvidence(
        recovered.artifacts,
        runId,
        branch,
        specialistResult(SCA_P04_UNDERDETECTED_SPECIALIST, population, "select")
      );
    }

    let quarantined: ReturnType<OrchestrationService["handle"]>;
    {
      using recovered = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new UnreachableModelClient(),
        playbookRegistration: SCA_P04_CANDIDATE_REGISTRATION,
      });
      quarantined = recovered.handle({ schema_version: 2, action: "recover", identity });
      expect(quarantined.action).toBe("cancelled");
      if (quarantined.action !== "cancelled") throw new Error("expected quarantine");
      expect(validateScaP04TerminalV1(quarantined.result).blocker_codes).toEqual([
        "remote_model_outcome_unknown",
      ]);
    }

    {
      using reopened = new OrchestrationService({
        projectRoot: PROJECT_ROOT,
        env,
        modelClient: new UnreachableModelClient(),
        playbookRegistration: SCA_P04_CANDIDATE_REGISTRATION,
      });
      const replay = reopened.handle({ schema_version: 2, action: "recover", identity });
      expect(canonicalJson(replay)).toBe(canonicalJson(quarantined));
      expect(reopened.checkpointer.loadRun(identity).terminalDirective).not.toBeNull();
      expect(
        reopened.artifacts.refFor(
          runId,
          "SCA-P04",
          null,
          "sca-p04-to-p05-transition",
          "sca-p04-to-p05-transition",
          1
        )
      ).toBeNull();
    }
  });

  it("cancellation, including remote-unknown quarantine, never creates a P05 transition", () => {
    using artifacts = store();
    const runId = "run-p04-cancel";
    const fixture = syntheticFixture(artifacts, runId);
    const run = context(runId, fixture.initialRefs);
    const playbook = new ScaP04CandidatePlaybook(artifacts);
    playbook.initialize(run);
    const cancelled = playbook.cancel(
      run,
      "model call outcome remote_unknown; durable dispatch fencing prohibits automatic replay"
    );
    expect(cancelled.action).toBe("cancelled");
    if (cancelled.action !== "cancelled") throw new Error("expected cancelled P04 terminal");
    const result = validateScaP04TerminalV1(cancelled.result);
    expect(result.blocker_codes).toEqual(["remote_model_outcome_unknown"]);
    expect(result.p05_authorized).toBe(false);
    expect(
      artifacts.refFor(
        runId,
        "SCA-P04",
        null,
        "sca-p04-to-p05-transition",
        "sca-p04-to-p05-transition",
        1
      )
    ).toBeNull();
  });
});
