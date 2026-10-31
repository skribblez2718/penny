import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import { RunContext } from "../dist/context.js";
import { PiAgentClient } from "../dist/model-client.js";
import { ReceiptAuthority } from "../dist/receipts.js";
import {
  SCA_MODEL_DATA_POLICY_V1_SCHEMA,
  type ScaModelDataPolicyV1,
} from "../dist/sca/p01-policy-contracts.js";
import {
  buildScaP04CognitivePayload,
  buildScaP04DisclosureAdmission,
  SCA_P04_CANDIDATE_REGISTRATION,
  SCA_P04_CANDIDATE_PLAYBOOK_NAME,
  ScaP04CandidatePlaybook,
  type ScaP04CognitiveAdmissionV1,
  type ScaP04DisclosurePolicyAdmissionV1,
} from "../dist/sca/p04-playbook.js";
import {
  SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
  SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
  SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA,
  SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
  SCA_P04_GATE_V1_SCHEMA,
  SCA_P04_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  SCA_P04_OMISSION_DOSSIER_V1_SCHEMA,
  SCA_P04_POPULATION_V1_SCHEMA,
  SCA_P04_REQUEST_V1_SCHEMA,
  SCA_P04_REQUIRED_MODEL,
  SCA_P04_RUNTIME_POLICY_V1_SCHEMA,
  SCA_P04_SCANNER_SPECIALIST,
  SCA_P04_SELECTION_DOSSIER_V1_SCHEMA,
  SCA_P04_SPECIALIST_IDS,
  SCA_P04_TO_P05_TRANSITION_V1_SCHEMA,
  SCA_P04_UNDERDETECTED_SPECIALIST,
  scaP04StableItemId,
  validateScaP04CoverageDossierV1,
  validateScaP04GateV1,
  validateScaP04OmissionDossierV1,
  validateScaP04SelectionDossierV1,
  validateScaP04SelectionPopulationV1,
  validateScaP04SpecialistResultV1,
  validateScaP04TerminalV1,
  validateScaP04ToP05TransitionV1,
  withSelfDigest,
  type ScaP04PopulationItemV1,
} from "../dist/sca/p04-contracts.js";
import { initializePennyState } from "../dist/state/index.js";
import { loadRuntimeConfig } from "../dist/config.js";
import { WorkerExecutor } from "../dist/worker.js";

const ENABLED = process.env.PENNY_SCA_P04_MODEL_SMOKE === "1";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
const priorStateRoot = process.env.PENNY_STATE_ROOT;

function persistJson(
  store: ArtifactStore,
  runId: string,
  branchId: string | null,
  kind: string,
  operationId: string,
  schemaId: string,
  value: unknown,
  upstreamRefs: readonly ArtifactRef[] = []
): ArtifactRef {
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "SCA-P04",
      branch_id: branchId,
      kind,
      operation_id: operationId,
      version: 1,
      producer: "host:sca-p04-candidate",
      media_type: "application/json",
      content_schema: { schema_id: schemaId, schema_version: 1 },
      parent_ref: null,
      upstream_refs: [...upstreamRefs],
    },
    content: canonicalJson(value),
  });
}

afterEach(() => {
  if (priorStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = priorStateRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

(ENABLED ? describe : describe.skip)("opt-in SCA P04 DeepSeek full-gate smoke", () => {
  it("runs both distinct specialists and passes the complete P04 gate on the exact required DeepSeek identity", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-sca-p04-live-smoke-"));
    roots.push(root);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PENNY_STATE_ROOT: path.join(root, "state"),
      PI_OBSERVABILITY_AUTO_START: "false",
      PI_OBSERVABILITY_ENABLED: "false",
    };
    process.env.PENNY_STATE_ROOT = env.PENNY_STATE_ROOT;
    const initialized = initializePennyState(PROJECT_ROOT, { env });
    const config = loadRuntimeConfig(PROJECT_ROOT, env);
    using artifacts = new ArtifactStore(initialized.paths.artifacts.root);
    const runId = "run-sca-p04-live-schema-smoke";
    const evidenceRef = persistJson(
      artifacts,
      "run-p03-smoke",
      null,
      "sca-p04-smoke-evidence",
      "sca-p04-smoke-evidence",
      "penny.sca-p04-smoke-evidence.v1",
      { schema_id: "penny.sca-p04-smoke-evidence.v1", schema_version: 1 }
    );
    const modelDataPolicy: ScaModelDataPolicyV1 = {
      schema_id: SCA_MODEL_DATA_POLICY_V1_SCHEMA,
      schema_version: 1,
      policy_id: "p04-live-smoke-model-policy",
      trust_status: "host-declared",
      status: "approved",
      model_alias: "deepseek-flash",
      provider: "ollama",
      model: "deepseek-v4.1-flash:cloud",
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
      payload_limit_bytes: 1_000_000,
    };
    const modelDataPolicyRef = persistJson(
      artifacts,
      "run-p03-smoke",
      null,
      "sca-model-data-policy",
      "sca-model-data-policy",
      SCA_MODEL_DATA_POLICY_V1_SCHEMA,
      modelDataPolicy
    );
    const implementationIdentityRef = persistJson(
      artifacts,
      runId,
      null,
      "sca-p04-implementation-identity",
      "sca-p04-implementation-identity",
      SCA_P04_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
      {
        schema_id: SCA_P04_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P04",
        implementation_revision: "live-gate-smoke-current-tree",
        contracts_sha256: sha256("sca-p04-live-gate-smoke-contracts"),
        prompts_sha256: sha256("sca-p04-live-gate-smoke-prompts"),
        identity_scope: "caller_declaration_not_runtime_attestation",
        host_issued: true,
        required_model: SCA_P04_REQUIRED_MODEL,
      }
    );
    const runtimePolicyRef = persistJson(
      artifacts,
      runId,
      null,
      "sca-p04-runtime-policy",
      "sca-p04-runtime-policy",
      SCA_P04_RUNTIME_POLICY_V1_SCHEMA,
      {
        schema_id: SCA_P04_RUNTIME_POLICY_V1_SCHEMA,
        schema_version: 1,
        phase_id: "SCA-P04",
        qualification_scope: "live_only",
        max_population_items: 10,
        max_payload_bytes_per_call: 1_000_000,
        max_selected_items: 10,
        specialist_count: 2,
        independent_contexts_required: true,
        semantic_reconciliation_call: false,
        required_tools: [],
        required_model: SCA_P04_REQUIRED_MODEL,
        host_issued: true,
      }
    );
    const request = withSelfDigest(
      {
        schema_id: SCA_P04_REQUEST_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: "tenant-live-gate-smoke",
        project_id: "project-live-gate-smoke",
        run_id: runId,
        phase_id: "SCA-P04" as const,
        p03_transition_ref: evidenceRef,
        implementation_identity_ref: implementationIdentityRef,
        runtime_policy_ref: runtimePolicyRef,
        requested_at: "2026-09-22T00:00:00.000Z",
      },
      "request_sha256"
    );
    const requestRef = persistJson(
      artifacts,
      runId,
      null,
      "sca-p04-candidate-request",
      "sca-p04-candidate-request",
      SCA_P04_REQUEST_V1_SCHEMA,
      request,
      [evidenceRef, implementationIdentityRef, runtimePolicyRef]
    );
    const cohortRefs = {
      p03_transition_ref: evidenceRef,
      p03_request_ref: evidenceRef,
      p03_entry_ref: evidenceRef,
      p03_qualification_ref: evidenceRef,
      p03_graph_manifest_ref: evidenceRef,
      p03_supported_matrix_ref: evidenceRef,
      p03_query_aggregate_ref: evidenceRef,
      p03_candidate_packet_ref: evidenceRef,
      p03_coverage_matrix_ref: evidenceRef,
      p03_evidence_manifest_ref: evidenceRef,
      p03_successor_ledger_ref: evidenceRef,
      p03_zero_model_ref: evidenceRef,
      p03_gate_ref: evidenceRef,
      p02_m1_ref: evidenceRef,
      p02_evidence_manifest_ref: evidenceRef,
      p01_request_ref: evidenceRef,
      p01_source_snapshot_ref: evidenceRef,
      p01_source_file_manifest_ref: evidenceRef,
      p01_source_custody_ref: evidenceRef,
      p01_model_data_policy_ref: modelDataPolicyRef,
    };
    const acceptedCohort = withSelfDigest(
      {
        schema_id: SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: request.tenant_id,
        project_id: request.project_id,
        run_id: runId,
        phase_id: "SCA-P04" as const,
        p04_request_ref: requestRef,
        implementation_identity_ref: implementationIdentityRef,
        runtime_policy_ref: runtimePolicyRef,
        refs: cohortRefs,
        transitive_refs_sha256: sha256(canonicalJson(Object.values(cohortRefs))),
        transitive_ref_count: 20,
        qualification_scope: "live_qualified" as const,
        accepted_p03: true as const,
        model_data_policy_status: "approved" as const,
        admitted_at: "2026-09-22T00:00:00.000Z",
      },
      "admission_sha256"
    );
    const acceptedCohortRef = persistJson(
      artifacts,
      runId,
      null,
      "sca-p04-accepted-cohort",
      "sca-p04-accepted-cohort",
      SCA_P04_ACCEPTED_COHORT_V1_SCHEMA,
      acceptedCohort,
      [requestRef, implementationIdentityRef, runtimePolicyRef, evidenceRef, modelDataPolicyRef]
    );
    const sourceDigest = evidenceRef.content_digest;
    const unsortedItems: ScaP04PopulationItemV1[] = [
      {
        stable_id: scaP04StableItemId({
          source_snapshot_sha256: sourceDigest,
          item_kind: "scanner_lead",
          normalized_locator: "scanner:src/example.ts:1:smoke",
          upstream_ids: ["smoke-scanner"],
        }),
        item_kind: "scanner_lead",
        normalized_locator: "scanner:src/example.ts:1:smoke",
        source_path: "src/example.ts",
        package_coordinate: null,
        alert_state: "scanner_alert",
        aliases: [],
        upstream_ids: ["smoke-scanner"],
        evidence_refs: [evidenceRef],
        assigned_specialists: [SCA_P04_SCANNER_SPECIALIST],
        selection_metadata: {
          metadata_kind: "scanner_observation",
          operation_kind: "smoke_scanner",
          observation_id: "smoke-scanner",
          analyzer_id: "smoke-analyzer",
          category: "smoke-category",
          subject: "smoke scanner lead",
          start_line: 1,
          advisory_id: null,
          correlation_id: "smoke-correlation",
          duplicate_group_id: null,
        },
        description: "Synthetic scanner lead for schema compatibility only",
      },
      {
        stable_id: scaP04StableItemId({
          source_snapshot_sha256: sourceDigest,
          item_kind: "source_surface",
          normalized_locator: "source:src/no-alert.ts",
          upstream_ids: ["smoke-no-alert"],
        }),
        item_kind: "source_surface",
        normalized_locator: "source:src/no-alert.ts",
        source_path: "src/no-alert.ts",
        package_coordinate: null,
        alert_state: "no_alert",
        aliases: [],
        upstream_ids: ["smoke-no-alert"],
        evidence_refs: [evidenceRef],
        assigned_specialists: [SCA_P04_UNDERDETECTED_SPECIALIST],
        selection_metadata: {
          metadata_kind: "source_surface",
          content_sha256: "f".repeat(64),
          scanner_alert_present: false,
        },
        description:
          "Important no-alert authentication and authorization state transition; absence is not evidence of safety",
      },
    ];
    const items = unsortedItems.sort((left, right) =>
      left.stable_id.localeCompare(right.stable_id)
    );
    const population = validateScaP04SelectionPopulationV1(
      withSelfDigest(
        {
          schema_id: "penny.sca-p04-selection-population.v1" as const,
          schema_version: 1 as const,
          phase_id: "SCA-P04" as const,
          run_id: runId,
          source_snapshot_ref: evidenceRef,
          source_snapshot_sha256: sourceDigest,
          accepted_cohort_ref: acceptedCohortRef,
          items,
          item_count: items.length,
          max_selected_items: 10,
          specialist_ids: [...SCA_P04_SPECIALIST_IDS],
        },
        "population_sha256"
      )
    );
    const populationRef = persistJson(
      artifacts,
      runId,
      null,
      "sca-p04-selection-population",
      "sca-p04-selection-population",
      SCA_P04_POPULATION_V1_SCHEMA,
      population,
      [acceptedCohortRef, evidenceRef]
    );
    const admission: ScaP04CognitiveAdmissionV1 & ScaP04DisclosurePolicyAdmissionV1 = {
      request: { run_id: runId },
      runtime_policy: { max_payload_bytes_per_call: 1_000_000 },
      p01_request: { model_data_policy_ref: modelDataPolicyRef },
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
    const initialArtifacts: ArtifactRef[] = [requestRef, acceptedCohortRef, populationRef];
    for (const specialistId of SCA_P04_SPECIALIST_IDS) {
      const agent = specialistId === SCA_P04_SCANNER_SPECIALIST ? "annie" : "echo";
      const payload = buildScaP04CognitivePayload({
        admission,
        population,
        population_ref: populationRef,
        specialist_id: specialistId,
      });
      const payloadRef = persistJson(
        artifacts,
        runId,
        specialistId,
        "sca-p04-cognitive-payload",
        `sca-p04-${specialistId}-payload`,
        SCA_P04_COGNITIVE_PAYLOAD_V1_SCHEMA,
        payload,
        [populationRef]
      );
      const disclosure = buildScaP04DisclosureAdmission({
        admission,
        payload,
        payload_ref: payloadRef,
        agent,
      });
      const disclosureRef = persistJson(
        artifacts,
        runId,
        specialistId,
        "sca-p04-disclosure-admission",
        `sca-p04-${specialistId}-disclosure`,
        SCA_P04_DISCLOSURE_ADMISSION_V1_SCHEMA,
        disclosure,
        [payloadRef, modelDataPolicyRef]
      );
      initialArtifacts.push(payloadRef, disclosureRef);
    }
    const run = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: "session-sca-p04-live-gate-smoke",
        playbook: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      goal: "Qualify the full inactive P04 gate with two live DeepSeek specialists.",
      constraints: {},
      projectRoot: PROJECT_ROOT,
      trustProfile: "hardened-untrusted",
      maxSteps: 16,
      initialArtifacts,
    });
    const playbook = new ScaP04CandidatePlaybook(
      artifacts,
      () => new Date("2026-09-22T00:00:03.000Z")
    );
    const directive = playbook.initialize(run);
    expect(directive.action).toBe("invoke_agents_parallel");
    if (directive.action !== "invoke_agents_parallel") {
      throw new Error("P04 full-gate qualification did not dispatch both specialists");
    }
    const client = new PiAgentClient({
      catalogSessions: {
        projectId: config.projectId,
        root: config.subagentSessionRoot,
      },
    });
    const workers = new WorkerExecutor(client, artifacts, {
      projectRoot: PROJECT_ROOT,
      parallelConcurrency: 2,
      registration: SCA_P04_CANDIDATE_REGISTRATION,
    });
    workers.setReceiptAuthority(ReceiptAuthority.createEphemeral());
    const results = await workers.execute({
      schema_version: 2,
      action: "invoke_agents_parallel",
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: "session-sca-p04-live-schema-smoke",
        playbook: SCA_P04_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      },
      state_id: directive.state_id,
      branches: directive.branches,
    });
    expect(results).toHaveLength(2);
    const summaries = results.map((result) => {
      let summary;
      try {
        summary = validateScaP04SpecialistResultV1(result.details);
      } catch (error) {
        throw new Error(
          `live P04 specialist response was not schema-compatible: ${error instanceof Error ? error.message : String(error)}; details=${canonicalJson(result.details)}; persisted=${artifacts.readById(result.output_artifact.artifact_id).toString("utf8")}`
        );
      }
      expect(summary.complete).toBe(true);
      expect(result.worker_receipt.requested_model).toEqual(SCA_P04_REQUIRED_MODEL);
      expect(result.worker_receipt.observed_model).toEqual({
        provider: SCA_P04_REQUIRED_MODEL.provider,
        model: SCA_P04_REQUIRED_MODEL.model,
      });
      const pending = run.pendingBranches.find(
        (branch) => branch.branch_id === summary.specialist_id
      );
      if (pending === undefined) throw new Error("live P04 pending specialist branch is absent");
      pending.completed = true;
      pending.confidence = result.confidence;
      pending.result = summary;
      pending.artifact = result.output_artifact;
      return summary;
    });
    expect(new Set(summaries.map((summary) => summary.specialist_id))).toEqual(
      new Set(SCA_P04_SPECIALIST_IDS)
    );

    const terminalDirective = playbook.acceptSummary(
      run,
      playbook.aggregateBranches(summaries),
      "PROBABLE"
    );
    expect(terminalDirective.action).toBe("incomplete");
    if (terminalDirective.action !== "incomplete") {
      throw new Error("live P04 full gate did not return its nonterminal campaign result");
    }
    const terminal = validateScaP04TerminalV1(terminalDirective.result);
    expect(terminal.status).toBe("candidate_complete");
    expect(terminal.p05_authorized).toBe(true);
    expect(terminal.blocker_codes).toEqual([]);
    if (terminal.gate_ref === null || terminal.p05_transition_ref === null) {
      throw new Error("live P04 full gate did not produce its gate and P05 transition");
    }
    const gate = validateScaP04GateV1(
      JSON.parse(artifacts.readById(terminal.gate_ref.artifact_id).toString("utf8"))
    );
    const transition = validateScaP04ToP05TransitionV1(
      JSON.parse(artifacts.readById(terminal.p05_transition_ref.artifact_id).toString("utf8"))
    );
    expect(gate.gate_status).toBe("passed");
    expect(gate.qualification_scope).toBe("live_qualified");
    expect(gate.exhaustive_accounting).toBe(true);
    expect(gate.pending_obligation_count).toBe(0);
    expect(transition.authorized).toBe(true);
    expect(transition.gate_sha256).toBe(terminal.gate_ref.content_digest);

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
    if (selectionRef === null || omissionRef === null || coverageRef === null) {
      throw new Error("live P04 full gate omitted a required dossier");
    }
    const selection = validateScaP04SelectionDossierV1(
      JSON.parse(artifacts.readById(selectionRef.artifact_id).toString("utf8"))
    );
    const omission = validateScaP04OmissionDossierV1(
      JSON.parse(artifacts.readById(omissionRef.artifact_id).toString("utf8"))
    );
    const coverage = validateScaP04CoverageDossierV1(
      JSON.parse(artifacts.readById(coverageRef.artifact_id).toString("utf8"))
    );
    const byStableId = new Map(population.items.map((item) => [item.stable_id, item]));
    expect(
      selection.selected.some(
        (entry) => byStableId.get(entry.stable_id)?.alert_state === "no_alert"
      )
    ).toBe(true);
    expect(omission.omitted.every((entry) => entry.safe_claim === false)).toBe(true);
    expect(coverage.exhaustive).toBe(true);
    expect(coverage.final_accounted_ids).toEqual(
      population.items.map((item) => item.stable_id).sort()
    );
    expect(sha256(canonicalJson(summaries))).toMatch(/^[a-f0-9]{64}$/u);

    console.log(
      `P04_QUALIFICATION:${canonicalJson({
        schema_version: 1,
        qualification: "full_p04_gate_live_deepseek",
        gate_schema: SCA_P04_GATE_V1_SCHEMA,
        transition_schema: SCA_P04_TO_P05_TRANSITION_V1_SCHEMA,
        selection_schema: SCA_P04_SELECTION_DOSSIER_V1_SCHEMA,
        omission_schema: SCA_P04_OMISSION_DOSSIER_V1_SCHEMA,
        coverage_schema: SCA_P04_COVERAGE_DOSSIER_V1_SCHEMA,
        requested_model: SCA_P04_REQUIRED_MODEL,
        specialist_count: summaries.length,
        selected_count: selection.selected_count,
        omitted_count: omission.omitted_count,
        no_alert_selected: true,
        exhaustive_accounting: coverage.exhaustive,
        pending_obligation_count: gate.pending_obligation_count,
        gate_status: gate.gate_status,
        gate_sha256: gate.gate_sha256,
        transition_sha256: transition.transition_sha256,
      })}`
    );
  }, 300_000);
});
