import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { Checkpointer } from "../../orchestration/dist/checkpointer.js";
import { validateContract, type ArtifactRef } from "../../orchestration/dist/contracts.js";
import { RunContext } from "../../orchestration/dist/context.js";
import {
  runtimeRegistrationSha256,
  skillContractSha256,
} from "../../orchestration/dist/playbooks/registry.js";
import { OrchestrationEngine } from "../../orchestration/dist/engine.js";
import { HostOperationLeaseAuthority } from "../../orchestration/dist/host-operations/lease-authority.js";
import { HostOperationRuntimeOwner } from "../../orchestration/dist/host-operations/owner.js";
import { ReceiptAuthority } from "../../orchestration/dist/receipts.js";
import { ProjectCatalog } from "../../orchestration/dist/state/catalog.js";
import { OrchestrationRunner, WorkerExecutor } from "../../orchestration/dist/worker.js";
import {
  SCA_MODEL_ALIAS,
  SCA_MODEL_ID,
  SCA_MODEL_PROVIDER,
} from "../../orchestration/dist/sca/model-identity.js";
import {
  buildScaInitialObligationLedgerV2,
  scaP01SourceTreeDigest,
  validateScaCampaignManifestCoreV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceCustodyCorpusV1,
} from "../../orchestration/dist/sca/p01-contracts.js";
import {
  SCA_P02_DISPOSITION_OBLIGATION_IDS,
  validateScaP02SuccessorLedgerV1,
} from "../../orchestration/dist/sca/p02-contracts.js";
import * as predecessorAdmission from "../../orchestration/dist/sca/p03-admission.js";
import {
  scaP03P01BindingSha256,
  scaP03P02BindingSha256,
  scaP03RuntimeBindingSha256,
  withScaP03Digest,
  validateScaP03EntryAdmissionV2,
  validateScaP03RequestV2,
  validateScaP03IsolationEvidenceV1,
  validateScaP03JoernRuntimeIdentityV1,
  validateScaP03RuntimePolicyV1,
  validateScaP03OperationRequestV1,
  validateScaP03ImplementationIdentityV1,
  validateScaP03TerminalV2,
  validateScaP03P04TransitionV2,
  validateScaP03GateV1,
  validateScaP03GraphSupportMatrixV2,
  validateScaP03GraphCandidatePacketV2,
  validateScaP03BaselineQueryPageV2,
  validateScaP03CoverageMatrixV1,
  SCA_P03_COVERAGE_IDS,
  SCA_P03_PRODUCTION_INPUT_CONTRACTS,
  SCA_P03_ISOLATION_PRODUCER,
  validateScaP03HostIsolationAttestationV1,
  ScaP03BaselineQuerySetV2Schema,
  makeScaP03QueryCandidateV2,
  validateScaP03EvidenceManifestV2,
  type ScaP03FidelityObservationV2,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  ScaP03CandidatePlaybook,
  resolveScaP03HostOperationPlan,
  SCA_P03_CANDIDATE_REGISTRATION,
  SCA_P03_CANDIDATE_PLAYBOOK_NAME,
} from "../../orchestration/dist/sca/p03-playbook.js";
import { requireScaP03OperationalCohort } from "../../orchestration/dist/sca/p03-operational-replay.js";
import type { ScaP03BootstrapQualificationRecordV3 } from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import { readP03BootstrapInputs } from "../src/p03-bootstrap.js";
import { FileHostOperationResultCache } from "../../orchestration/dist/host-operations/result-cache.js";
import {
  createScaP03SimulatedJoernRuntimeV1,
  createScaP03OperationAdaptersV1,
  type ScaP03JoernRuntimeV1,
} from "../src/p03-operations.js";

/** Offline host-owner integration. Only already-admitted P01/P02 predecessor admission is injected;
 * bootstrap proof/brand, service adapters, owner journal, engine, extraction, gate and replay are real.
 * Caller supplies fake Docker/probe and fixture qualification observations, never live evidence.
 */
export async function p03HostOwnerRegression(
  input: Parameters<typeof p03HostOwnerOne>[0]
): Promise<void> {
  const qualify = input.runtime.qualify;
  if (input.qualification_fixture !== undefined) {
    const fixture = input.qualification_fixture;
    const receipt = input.record.source_oracle_validation_ref;
    const crossSplicedReceipt = input.store.persist({
      metadata: { ...input.store.metadata(receipt), operation_id: "cross-spliced-receipt" },
      content: input.store.read(receipt),
    });
    expect(crossSplicedReceipt.content_digest).toBe(receipt.content_digest);
    expect(crossSplicedReceipt).not.toEqual(receipt);
    input.runtime.qualify = async (value) => {
      // Exercise the real sealed wrapper before fixture-injecting PASS observations.
      await expect(
        qualify({ ...value, source_oracle_validation_ref: crossSplicedReceipt })
      ).rejects.toThrow("p03_bootstrap_oracle_receipt_cross_splice");
      const observed = await qualify(value);
      expect(observed.executed_query_release_sha256).toBe(value.query_release.release_sha256);
      return fixture(value);
    };
  }
  try {
    for (const defect of input.defect === undefined
      ? (["none", "material", "truncated", "deterministic"] as const)
      : [input.defect])
      await p03HostOwnerOne({ ...input, defect });
  } finally {
    input.runtime.qualify = qualify;
  }
}
async function p03HostOwnerOne(input: {
  readonly store: ArtifactStore;
  readonly runtime: ScaP03JoernRuntimeV1;
  readonly record: ScaP03BootstrapQualificationRecordV3;
  readonly attestation_ref: ArtifactRef;
  readonly qualification_fixture?: ScaP03JoernRuntimeV1["qualify"];
  readonly defect?: "none" | "material" | "truncated" | "deterministic";
}): Promise<void> {
  const { record } = input;
  const runtime =
    input.defect === "deterministic"
      ? createScaP03SimulatedJoernRuntimeV1({
          runtime_id: input.runtime.runtime_id,
          isolation_id: input.runtime.isolation_id,
          runtime_tree_sha256: input.runtime.runtime_tree_sha256,
          isolation_profile_sha256: input.runtime.isolation_profile_sha256,
          implementation_identity_sha256: input.runtime.implementation_identity_sha256,
          deployment_identity_sha256: input.runtime.deployment_identity_sha256,
        })
      : input.runtime;
  if (input.defect === "deterministic") runtime.qualify = input.runtime.qualify;
  const root = mkdtempSync(path.join(tmpdir(), "p03-host-owner-regression-"));
  const stateRoot = path.join(root, "state");
  const catalog = new ProjectCatalog(stateRoot, { create: true });
  const { projectId } = catalog.registerProject(root);
  catalog.close();
  const store = ArtifactStore.provision(path.join(root, "artifacts"), { projectId });
  const copied = new Set<string>();
  const copy = (ref: ArtifactRef): void => {
    if (copied.has(ref.artifact_id)) return;
    const metadata = input.store.metadata(ref);
    for (const upstream of metadata.upstream_refs) copy(upstream);
    if (metadata.parent_ref !== null) copy(metadata.parent_ref);
    expect(store.persist({ metadata, content: input.store.read(ref) })).toEqual(ref);
    copied.add(ref.artifact_id);
  };
  copy(input.attestation_ref);
  for (const ref of [
    record.runtime_policy_ref,
    record.runtime_identity_ref,
    record.implementation_identity_ref,
    record.qualification_profile_ref,
    record.fixture_corpus_ref,
    record.source_oracle_ref,
    record.source_oracle_validation_ref,
    record.baseline_query_set_ref,
    ...record.fixture_content_refs,
    ...record.query_script_refs,
    ...record.query_plan_refs,
    ...record.runtime_package_refs,
  ])
    copy(ref);
  let sequence = 0;
  const persist = (
    value: unknown,
    kind: string,
    schema: string,
    upstream: readonly ArtifactRef[] = [],
    run = "p03-predecessor-fixture",
    operation = `${kind}-${++sequence}`
  ) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id: run,
        phase:
          kind.startsWith("sca-p02-v3") || kind === "sca-p02-phase-gate-v3" ? "SCA-P02" : "SCA-P03",
        branch_id: null,
        kind,
        operation_id: operation,
        version: 1,
        producer:
          Object.values(SCA_P03_PRODUCTION_INPUT_CONTRACTS).find((entry) => entry.kind === kind)
            ?.producer ??
          (kind === "sca-p03-isolation-evidence"
            ? SCA_P03_ISOLATION_PRODUCER
            : kind.startsWith("sca-p02-v3") || kind === "sca-p02-phase-gate-v3"
              ? "host:sca-p02-qualification-authority"
              : "host:test-predecessor"),
        media_type: "application/json",
        content_schema: { schema_id: schema, schema_version: Number(schema.slice(-1)) },
        parent_ref: null,
        upstream_refs: [...upstream].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
      },
      content: canonicalJson(value),
    });
  const dummy = (kind: string, schema = "penny.test-predecessor.v1", operation?: string) =>
    persist({ fixture: kind }, kind, schema, [], "p03-predecessor-fixture", operation);
  const snapshotRef = dummy("source-snapshot");
  const files = ["src/a.php", "src/a.ts"].map((path) => {
    const bytes = Buffer.from(path.endsWith("php") ? "<?php function f() {}" : "function f() {}");
    return { path, bytes, content_sha256: sha256(bytes), byte_count: bytes.length };
  });
  const identities = files.map(({ bytes: _bytes, ...file }) => {
    void _bytes;
    return file;
  });
  const tree = scaP01SourceTreeDigest(identities);
  const sourceManifest = validateScaP01SourceFileManifestV1({
    schema_id: "penny.sca-p01-source-file-manifest.v1",
    schema_version: 1,
    snapshot_id: "snapshot",
    scope: { include_paths: ["src"], exclude_paths: [] },
    files: identities,
    file_count: files.length,
    byte_count: files.reduce((n, f) => n + f.byte_count, 0),
    tree_sha256: tree,
  });
  const sourceManifestRef = persist(
    sourceManifest,
    "sca-p01-source-file-manifest",
    sourceManifest.schema_id
  );
  const custody = validateScaP01SourceCustodyCorpusV1({
    schema_id: "penny.sca-p01-source-custody-corpus.v1",
    schema_version: 1,
    snapshot_id: "snapshot",
    custody_id: "custody",
    file_manifest_ref: sourceManifestRef,
    files: files.map((file) => ({
      path: file.path,
      encoding: "base64",
      content_base64: file.bytes.toString("base64"),
      byte_count: file.byte_count,
      content_sha256: file.content_sha256,
    })),
    file_count: files.length,
    byte_count: sourceManifest.byte_count,
    tree_sha256: tree,
    sealed: true,
  });
  const custodyRef = persist(custody, "sca-p01-source-custody-corpus", custody.schema_id);
  const prior = buildScaInitialObligationLedgerV2({
    tenant_id: "tenant",
    project_id: "project",
    run_id: "p03-predecessor-fixture",
    assigning_authority_id: "fixture-authority",
    policy_refs: [snapshotRef],
    supporting_evidence_refs: [snapshotRef],
    created_at: new Date().toISOString(),
  });
  const priorRef = persist(prior, "p01-ledger", prior.schema_id);
  const refs = {
    source_snapshot_ref: snapshotRef,
    source_file_manifest_ref: sourceManifestRef,
    source_custody_ref: custodyRef,
    source_provenance_ref: snapshotRef,
    analysis_profile_ref: snapshotRef,
    rule_release_ref: snapshotRef,
    rule_bundle_ref: snapshotRef,
    rule_profile_ref: snapshotRef,
    selected_rule_manifest_ref: snapshotRef,
    toolchain_ref: snapshotRef,
    tool_executable_refs: [custodyRef, sourceManifestRef].sort((a, b) =>
      a.artifact_id.localeCompare(b.artifact_id)
    ),
    tool_measurement_receipt_refs: [custodyRef, sourceManifestRef].sort((a, b) =>
      a.artifact_id.localeCompare(b.artifact_id)
    ),
    network_policy_ref: snapshotRef,
    privacy_policy_ref: snapshotRef,
    model_data_policy_ref: snapshotRef,
    resource_policy_ref: snapshotRef,
    output_policy_ref: snapshotRef,
    authority_policy_ref: snapshotRef,
    p01_qualification_ref: snapshotRef,
    qualification_source_file_manifest_ref: sourceManifestRef,
    qualification_source_custody_ref: custodyRef,
    implementation_source_ref: snapshotRef,
    implementation_build_ref: snapshotRef,
  };
  const core = validateScaCampaignManifestCoreV1(
    withScaP03Digest(
      {
        schema_id: "penny.sca-campaign-manifest-core.v1",
        schema_version: 1,
        tenant_id: "tenant",
        project_id: "project",
        run_id: "p03-predecessor-fixture",
        request_ref: snapshotRef,
        obligation_ledger_ref: priorRef,
        implementation_revision: "fixture",
        runtime_cognition: {
          alias: SCA_MODEL_ALIAS,
          provider: SCA_MODEL_PROVIDER,
          model: SCA_MODEL_ID,
        },
        report_namespace: "report",
        authorities: {
          execution_authority_id: "execution",
          release_authority_id: "release",
          promotion_authority_id: "promotion",
        },
        frozen_refs: refs,
        status: "pending_gate",
        sca_completion_claimed: false,
      },
      "binding_sha256"
    )
  );
  const coreRef = persist(core, "p01-core", core.schema_id);
  const p01Gate = dummy(
    "sca-p01-candidate-gate",
    "penny.sca-phase-gate-record.v2",
    "sca-p01-candidate-gate"
  );
  const p01Manifest = dummy(
    "sca-p01-candidate-campaign-manifest",
    "penny.sca-campaign-manifest.v2",
    "sca-p01-candidate-campaign-manifest"
  );
  const operations = [
    "inventory",
    "semgrep_php",
    "semgrep_js_ts",
    "gitleaks",
    "osv_composer",
    "osv_npm",
  ].map((kind) => {
    const suffix = kind.replaceAll("_", "-");
    return {
      result: dummy(`sca-p02-${suffix}-result`, `penny.sca-p02-${suffix}-result.v1`),
      evidence: dummy(
        "sca-p02-persisted-evidence",
        "penny.sca-p02-persisted-evidence.v1",
        `sca-p02-evidence-${suffix}`
      ),
    };
  });
  const coverageRef = dummy(
    "sca-p02-coverage-matrix",
    "penny.sca-p02-coverage-matrix.v1",
    "sca-p02-coverage-matrix"
  );
  const allOperations = operations.flatMap((operation) => [operation.result, operation.evidence]);
  const ledgerEvidence = [
    [p01Gate, p01Manifest],
    allOperations.slice(0, 2),
    allOperations.slice(0, 2),
    allOperations.slice(2, 6),
    allOperations.slice(6, 8),
    allOperations.slice(0, 2),
    allOperations.slice(8),
    operations.map((o) => o.evidence),
    [coverageRef, ...allOperations],
    [coverageRef, ...operations.map((o) => o.evidence)],
  ];
  const p02Ledger = validateScaP02SuccessorLedgerV1(
    withScaP03Digest(
      {
        schema_id: "penny.sca-p02-successor-obligation-ledger.v1",
        schema_version: 1,
        run_id: "p03-predecessor-fixture",
        prior_p01_ledger_ref: priorRef,
        prior_p01_ledger_sha256: priorRef.content_digest,
        prior_entry_count: prior.entries.length,
        prior_event_count: prior.events.length,
        prior_entries: prior.entries,
        prior_events: prior.events,
        p01_campaign_manifest_ref: p01Manifest,
        dispositions: SCA_P02_DISPOSITION_OBLIGATION_IDS.map((obligation_id, index) => ({
          obligation_id,
          status: "satisfied",
          evidence_refs: ledgerEvidence[index],
        })),
        pending_phase_ids: [
          "SCA-P03",
          "SCA-P04",
          "SCA-P05",
          "SCA-P06",
          "SCA-P07",
          "SCA-P08",
          "SCA-P09",
          "SCA-P10",
          "SCA-P11",
          "SCA-P12",
        ],
        append_only: true,
        campaign_completion_claimed: false,
        release_eligible: false,
        recorded_at: new Date().toISOString(),
      },
      "ledger_sha256"
    )
  );
  const p02LedgerRef = persist(p02Ledger, "p02-ledger", p02Ledger.schema_id);
  const acceptedP01 = {
    request_ref: snapshotRef,
    obligation_ledger_ref: priorRef,
    campaign_manifest_core_ref: coreRef,
    admission_evidence_ref: snapshotRef,
    p01_gate_ref: p01Gate,
    campaign_manifest_ref: p01Manifest,
    frozen_refs: [snapshotRef, sourceManifestRef, custodyRef],
  };
  const acceptedP02 = {
    transition_ref: dummy("p02-transition"),
    p02_request_ref: dummy("p02-request"),
    gate_ref: dummy("p02-gate"),
    m1_ref: dummy("p02-m1"),
    coverage_matrix_ref: coverageRef,
    evidence_manifest_ref: dummy("p02-manifest"),
    successor_ledger_ref: p02LedgerRef,
    evidence_refs: Array.from({ length: 26 }, (_, index) => dummy(`p02-detail-${index}`)),
    qualification_definition_ref: dummy(
      "sca-p02-v3-definition-snapshot",
      "penny.sca-p02-v3-definition-snapshot.v1"
    ),
    qualification_gate_ref: dummy("sca-p02-phase-gate-v3", "penny.sca-phase-gate-record.v3"),
  };
  const inputs = readP03BootstrapInputs(store, record, record.fixture_corpus_ref.run_id);
  const attestation = input.attestation_ref;
  const isolationCommon = {
    schema_id: "penny.sca-p03-isolation-evidence.v1",
    schema_version: 1,
    producer_id: "host:sca-p03-isolation-qualification",
    isolation_id: runtime.isolation_id,
    runtime_id: runtime.runtime_id,
    runtime_tree_sha256: runtime.runtime_tree_sha256,
    implementation_identity_sha256: runtime.implementation_identity_sha256,
    deployment_identity_sha256: runtime.deployment_identity_sha256,
    profile_id: inputs.profile.profile_id,
    profile_sha256: inputs.profile.profile_sha256,
    qualified_at: new Date().toISOString(),
  };
  const isolation = validateScaP03IsolationEvidenceV1(
    runtime.qualification_scope === "deterministic_test_only"
      ? {
          ...isolationCommon,
          evidence_kind: "simulated_joern_test_seam",
          runtime_kind: "simulated_joern_test_runtime",
          qualification_scope: "deterministic_test_only",
          simulation_label: "simulated_joern_test_seam",
          qualified: false,
        }
      : {
          ...isolationCommon,
          evidence_kind: "host_qualification_attestation",
          runtime_kind: "host_qualified_joern",
          qualification_scope: "live_qualified",
          qualified: true,
          host_attestation_id: validateScaP03HostIsolationAttestationV1(
            JSON.parse(store.read(attestation).toString())
          ).attestation_id,
          host_attestation_sha256: attestation.content_digest,
          host_attestation_ref: attestation,
        }
  );
  const liveIdentity = validateScaP03JoernRuntimeIdentityV1(
    JSON.parse(store.read(record.runtime_identity_ref).toString())
  );
  const { identity_sha256: _identitySha, ...identityCore } = liveIdentity;
  void _identitySha;
  const runtimeIdentity =
    runtime.qualification_scope === "deterministic_test_only"
      ? validateScaP03JoernRuntimeIdentityV1(
          withScaP03Digest(
            {
              ...identityCore,
              runtime_kind: runtime.runtime_kind,
              qualification_scope: runtime.qualification_scope,
            },
            "identity_sha256"
          )
        )
      : liveIdentity;
  const runtimeIdentityRef =
    runtime.qualification_scope === "deterministic_test_only"
      ? persist(runtimeIdentity, "sca-p03-joern-runtime-identity", runtimeIdentity.schema_id)
      : record.runtime_identity_ref;

  const isolationRef = persist(isolation, "sca-p03-isolation-evidence", isolation.schema_id, [
    attestation,
  ]);
  const baselineQueries = runtime.runBaselineQueries;
  let queryFailure: unknown = null;
  const admission = vi.spyOn(predecessorAdmission, "admitScaP03Candidate");
  try {
    {
      const defect = input.defect ?? "none";
      const run = record.fixture_corpus_ref.run_id;
      const base = {
        schema_id: "penny.sca-p03-request.v2",
        schema_version: 2,
        tenant_id: "tenant",
        project_id: "project",
        run_id: run,
        phase_id: "SCA-P03",
        accepted_p01: acceptedP01,
        accepted_p02: acceptedP02,
        source_snapshot_ref: snapshotRef,
        source_snapshot_sha256: snapshotRef.content_digest,
        runtime_policy_ref: record.runtime_policy_ref,
        joern_runtime_identity_ref: runtimeIdentityRef,
        isolation_evidence_ref: isolationRef,
        host_isolation_attestation_ref:
          runtime.qualification_scope === "live_qualified" ? attestation : null,
        implementation_identity_ref: record.implementation_identity_ref,
        qualification_profile_ref: record.qualification_profile_ref,
        fixture_corpus_ref: record.fixture_corpus_ref,
        source_oracle_ref: record.source_oracle_ref,
        source_oracle_validation_ref: record.source_oracle_validation_ref,
        fixture_content_refs: record.fixture_content_refs,
        fidelity_complement_refs: [],
        baseline_query_set_ref: record.baseline_query_set_ref,
        query_script_refs: record.query_script_refs,
        query_plan_refs: record.query_plan_refs,
        runtime_package_refs: record.runtime_package_refs,
        requested_at: new Date().toISOString(),
      };
      const request = validateScaP03RequestV2(
        withScaP03Digest(
          {
            ...base,
            p01_binding_sha256: scaP03P01BindingSha256(base),
            p02_binding_sha256: scaP03P02BindingSha256(base),
            p03_runtime_binding_sha256: scaP03RuntimeBindingSha256(base),
          },
          "request_sha256"
        )
      );
      admission.mockImplementation(() => ({
        request,
        p02_request: {
          schema_id: "penny.sca-p02-request.v1",
          schema_version: 1,
          tenant_id: "tenant",
          project_id: "project",
          run_id: acceptedP02.p02_request_ref.run_id,
          accepted_p01: acceptedP01,
          runtime_policy_ref: snapshotRef,
          isolation_evidence_ref: snapshotRef,
          isolation_host_attestation_ref: null,
          requested_at: base.requested_at,
        },
        runtime_policy: inputs.policy,
        runtime_identity: runtimeIdentity,
        isolation_evidence: isolation,
        implementation_identity: validateScaP03ImplementationIdentityV1(
          JSON.parse(store.read(record.implementation_identity_ref).toString())
        ),
        qualification_profile: inputs.profile,
        fixture_corpus: inputs.corpus,
        baseline_query_set: validateContract(
          ScaP03BaselineQuerySetV2Schema,
          JSON.parse(store.read(record.baseline_query_set_ref).toString()),
          "query set"
        ),
      }));
      runtime.runBaselineQueries = async (value) => {
        if (defect === "none") {
          for (const key of [
            "implementation_identity_ref",
            "qualification_profile_ref",
            "baseline_query_set_ref",
          ] as const) {
            const ref = value.request[key];
            const reissued = store.persist({
              metadata: {
                ...store.metadata(ref),
                operation_id: `cross-splice-${key}-${value.request.partition}`,
              },
              content: store.read(ref),
            });
            expect(reissued.content_digest).toBe(ref.content_digest);
            expect(reissued).not.toEqual(ref);
            await expect(
              baselineQueries({ ...value, request: { ...value.request, [key]: reissued } })
            ).rejects.toThrow("p03_fidelity_binding_mismatch");
          }
        }
        const output = await baselineQueries(value).catch((error) => {
          queryFailure = error;
          throw error;
        });
        const observations: readonly ScaP03FidelityObservationV2[] =
          defect === "material"
            ? output.fidelity_observations.map((entry, index) =>
                index === 0
                  ? { ...entry, support: "partial", reason_code: "material_relationship_unproven" }
                  : entry
              )
            : output.fidelity_observations;
        return {
          ...output,
          fidelity_observations: observations,
          truncated: defect === "truncated",
          pages: output.pages.map((page) => ({
            ...page,
            complete: defect === "truncated" ? false : page.complete,
          })),
        };
      };
      const runRoot = path.join(root, run);
      using checkpointer = Checkpointer.provision(
        path.join(runRoot, "orchestration.db"),
        undefined,
        { projectId }
      );
      using leases = new HostOperationLeaseAuthority(stateRoot);
      const engine = new OrchestrationEngine(checkpointer, {
        projectRoot: runRoot,
        maxSteps: 30,
        receiptAuthority: ReceiptAuthority.provision(path.join(runRoot, "key")),
        artifactStore: store,
        artifactReader: store,
        artifactRevisions: store,
        playbookRegistration: SCA_P03_CANDIDATE_REGISTRATION,
      });
      let adapterFailure: unknown = null;
      const adapters = new Map(
        [...createScaP03OperationAdaptersV1({ runtime })].map(([id, adapter]) => [
          id,
          {
            ...adapter,
            run: async (context: Parameters<typeof adapter.run>[0]) => {
              try {
                return await adapter.run(context);
              } catch (error) {
                adapterFailure = error;
                throw error;
              }
            },
          },
        ])
      );
      // Exercise each real service operation against a schema-valid, custody-bound
      // policy whose staging digest does not match the branded private runtime.
      const driftPolicy = { ...inputs.policy, staging_parent_sha256: sha256("wrong private path") };
      validateScaP03RuntimePolicyV1(driftPolicy);
      const driftPolicyRef = store.persist({
        metadata: {
          ...store.metadata(record.runtime_policy_ref),
          operation_id: "staging-digest-drift",
        },
        content: canonicalJson(driftPolicy),
      });
      const driftChecks = new Set<string>();
      if (defect === "none") {
        for (const [id, adapter] of adapters) {
          const originalRun = adapter.run;
          adapter.run = async (context) => {
            const raw: unknown = JSON.parse(Buffer.from(context.request_bytes).toString("utf8"));
            if (
              raw === null ||
              typeof raw !== "object" ||
              !("operation_kind" in raw) ||
              (raw.operation_kind !== "qualify_joern" &&
                raw.operation_kind !== "build_source_graph" &&
                raw.operation_kind !== "run_baseline_query_batch")
            )
              throw new Error("invalid regression request");
            const request = validateScaP03OperationRequestV1(raw.operation_kind, raw);
            const { request_sha256: _requestDigest, ...requestCore } = request;
            void _requestDigest;
            const changedRequest = validateScaP03OperationRequestV1(
              request.operation_kind,
              withScaP03Digest(
                {
                  ...requestCore,
                  runtime_policy_ref: driftPolicyRef,
                },
                "request_sha256"
              )
            );
            const changedContext = {
              ...context,
              request_bytes: Buffer.from(canonicalJson(changedRequest)),
              readInput: (slot: string) =>
                slot === "runtime_policy"
                  ? { ref: driftPolicyRef, bytes: store.read(driftPolicyRef) }
                  : context.readInput(slot),
              readCachedResult: async () => {
                throw new Error("drift must fail before cache recovery");
              },
            };
            if (runtime.runtime_kind === "host_qualified_joern") {
              await expect(originalRun(changedContext)).rejects.toThrow(
                "p03_runtime_staging_parent_mismatch"
              );
            } else {
              // Production construction is disabled; never relabel a substituted runner as live
              // just to exercise an unavailable live-only path.
              expect(runtime.qualification_scope).toBe("deterministic_test_only");
            }
            const wrongRefContext = {
              ...context,
              readInput: (slot: string) => {
                const exact = context.readInput(slot);
                return slot === "qualification_profile"
                  ? { ...exact, ref: { ...exact.ref, operation_id: "wrong-custody-ref" } }
                  : exact;
              },
              readCachedResult: async () => {
                throw new Error("wrong ref must fail before cache recovery");
              },
            };
            await expect(originalRun(wrongRefContext)).rejects.toThrow(
              "p03_exact_input_mismatch:qualification_profile"
            );
            driftChecks.add(id);
            return originalRun(context);
          };
        }
      }
      const owner = new HostOperationRuntimeOwner({
        projectId,
        checkpointer,
        artifacts: store,
        leaseAuthority: leases,
        adapters,
        resultCache: await FileHostOperationResultCache.provision(path.join(runRoot, "cache")),
      });
      let modelCalls = 0;
      const runner = new OrchestrationRunner(
        engine,
        new WorkerExecutor(
          {
            runAgent: async () => {
              modelCalls++;
              throw new Error("P03 must not invoke models");
            },
          },
          store,
          {
            projectRoot: runRoot,
            parallelConcurrency: 1,
            registration: SCA_P03_CANDIDATE_REGISTRATION,
          }
        ),
        undefined,
        owner
      );
      const identity = {
        schema_version: 2 as const,
        run_id: run,
        session_id: run,
        playbook: SCA_P03_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript" as const,
      };
      const exactInputs = predecessorAdmission.scaP03InputArtifacts(request);
      const requestRef = store.persist({
        metadata: {
          schema_version: 2,
          run_id: run,
          phase: "SCA-P03",
          branch_id: null,
          kind: "sca-p03-candidate-request",
          operation_id: "sca-p03-candidate-request",
          version: 1,
          producer: "host:sca-p03-candidate",
          media_type: "application/json",
          content_schema: { schema_id: request.schema_id, schema_version: 2 },
          parent_ref: null,
          upstream_refs: exactInputs.artifacts
            .map((entry) => entry.ref)
            .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
        },
        content: canonicalJson(request),
      });
      const plan = resolveScaP03HostOperationPlan(store, requestRef);
      expect(plan.request).toEqual(request);
      if (defect === "none") {
        const changedPlan = (patch: Partial<typeof request>): ArtifactRef => {
          const { request_sha256: _hash, ...unsigned } = request;
          void _hash;
          const next = { ...unsigned, ...patch };
          const changed = validateScaP03RequestV2(
            withScaP03Digest(
              {
                ...next,
                p01_binding_sha256: scaP03P01BindingSha256(next),
                p02_binding_sha256: scaP03P02BindingSha256(next),
                p03_runtime_binding_sha256: scaP03RuntimeBindingSha256(next),
              },
              "request_sha256"
            )
          );
          return store.persist({
            metadata: {
              ...store.metadata(requestRef),
              operation_id: `negative-plan-${++sequence}`,
            },
            content: canonicalJson(changed),
          });
        };
        for (const key of [
          "runtime_policy_ref",
          "joern_runtime_identity_ref",
          "implementation_identity_ref",
          "qualification_profile_ref",
          "fixture_corpus_ref",
          "baseline_query_set_ref",
          "host_isolation_attestation_ref",
        ] as const) {
          const ref = request[key];
          if (ref === null) {
            expect(runtime.qualification_scope).toBe("deterministic_test_only");
            expect(key).toBe("host_isolation_attestation_ref");
            continue;
          }
          const wrongProducer = store.persist({
            metadata: {
              ...store.metadata(ref),
              operation_id: `wrong-producer-${key}`,
              producer: "host:sca-p03-frozen-inputs",
            },
            content: store.read(ref),
          });
          expect(() =>
            resolveScaP03HostOperationPlan(store, changedPlan({ [key]: wrongProducer }))
          ).toThrow("unexpected artifact contract");
          expect(() =>
            resolveScaP03HostOperationPlan(
              store,
              changedPlan({ [key]: { ...ref, operation_id: "wrong-exact-ref" } })
            )
          ).toThrow("exact ref is stale");
        }
        for (const key of [
          "fixture_content_refs",
          "query_script_refs",
          "query_plan_refs",
        ] as const) {
          const [ref, ...rest] = request[key];
          if (ref === undefined) throw new Error("input array empty");
          const wrongProducer = store.persist({
            metadata: {
              ...store.metadata(ref),
              operation_id: `wrong-producer-${key}`,
              producer: "host:sca-p03-frozen-inputs",
            },
            content: store.read(ref),
          });
          expect(() =>
            resolveScaP03HostOperationPlan(store, changedPlan({ [key]: [wrongProducer, ...rest] }))
          ).toThrow("unexpected artifact contract");
        }
      }
      const common = {
        tenant_id: request.tenant_id,
        project_id: request.project_id,
        run_id: run,
        phase_id: "SCA-P03",
        p01_binding_sha256: request.p01_binding_sha256,
        p02_binding_sha256: request.p02_binding_sha256,
        p03_runtime_binding_sha256: request.p03_runtime_binding_sha256,
        source_snapshot_ref: snapshotRef,
        source_snapshot_sha256: snapshotRef.content_digest,
      };
      const entry = validateScaP03EntryAdmissionV2(
        withScaP03Digest(
          {
            schema_id: "penny.sca-p03-entry-admission.v2",
            schema_version: 2,
            ...common,
            p03_request_ref: requestRef,
            source_oracle_ref: record.source_oracle_ref,
            source_oracle_validation_ref: record.source_oracle_validation_ref,
            p02_transition_ref: acceptedP02.transition_ref,
            p02_m1_ref: acceptedP02.m1_ref,
            p01_manifest_ref: p01Manifest,
            admitted_at: base.requested_at,
          },
          "admission_sha256"
        )
      );
      const entryRef = store.persist({
        metadata: {
          ...store.metadata(requestRef),
          kind: "sca-p03-entry-admission",
          operation_id: "sca-p03-entry-admission",
          content_schema: { schema_id: entry.schema_id, schema_version: 2 },
          upstream_refs: [requestRef],
        },
        content: canonicalJson(entry),
      });
      const context = RunContext.create({
        identity,
        goal: "P03 uncertainty regression",
        constraints: {},
        projectRoot: runRoot,
        trustProfile: "trusted-interactive",
        maxSteps: 30,
        initialArtifacts: [requestRef, entryRef],
        registrationContractBinding: {
          schema_version: 1,
          registration_name: SCA_P03_CANDIDATE_REGISTRATION.name,
          contract_sha256: skillContractSha256(SCA_P03_CANDIDATE_REGISTRATION.contract),
          registration_sha256: runtimeRegistrationSha256(SCA_P03_CANDIDATE_REGISTRATION),
        },
      });
      new ScaP03CandidatePlaybook(store, () => new Date()).initialize(context);
      checkpointer.createRun(context, "fixture_predecessor_admitted", {});
      const terminal = await runner
        .runUntilBoundary(engine.handle({ schema_version: 2, action: "recover", identity }))
        .catch((error: unknown) => {
          throw new Error("P03 host-owner regression failed", {
            cause: queryFailure ?? adapterFailure ?? error,
          });
        });
      if (terminal.action !== "incomplete") throw new Error(canonicalJson(terminal));
      const result = validateScaP03TerminalV2(terminal.result);
      expect(modelCalls).toBe(0);
      if (defect === "none") expect(driftChecks.size).toBe(3);
      expect(result).toMatchObject({
        campaign_terminal: false,
        release_eligible: false,
        model_calls: 0,
        model_turns: 0,
        gate_status:
          defect === "none" && runtime.qualification_scope === "live_qualified"
            ? "passed"
            : "blocked",
      });
      expect(checkpointer.hostOperationCallsForRun(run)).toHaveLength(5);
      const packet = validateScaP03GraphCandidatePacketV2(
        JSON.parse(store.read(result.candidate_packet_ref).toString())
      );
      if (defect === "truncated") {
        expect(result.blocker_codes).toContain("query_truncated");
        expect(packet.complete).toBe(false);
        return;
      }
      expect(packet.complete).toBe(true);
      if (defect === "deterministic") {
        expect(result.blocker_codes).toContain("isolation_unqualified");
        expect(result.transition_ref).toBe(null);
        return;
      }
      const uncertainty = packet.candidates.filter(
        (candidate) => candidate.query_id === "p03.unsupported-surface.v2"
      );
      expect(uncertainty.length).toBeGreaterThan(0);
      for (const candidate of uncertainty) {
        expect(candidate).toMatchObject({
          claim: "unsupported_surface",
          disposition: "unresolved",
          reason_code: "relationship_unproven",
        });
        const page = validateScaP03BaselineQueryPageV2(
          JSON.parse(store.read(candidate.page_ref).toString())
        );
        const {
          partition: _partition,
          accounted_paths: _paths,
          graph_component_ref: _graph,
          page_ref: _page,
          ...item
        } = candidate;
        void [_partition, _paths, _graph, _page];
        expect(page.items.find((entry) => entry.candidate_id === candidate.candidate_id)).toEqual(
          item
        );
      }
      const coverage = validateScaP03CoverageMatrixV1(
        JSON.parse(store.read(result.coverage_matrix_ref).toString())
      );
      expect(coverage.entries.map((entry) => entry.coverage_id)).toEqual(SCA_P03_COVERAGE_IDS);
      expect(coverage.entries.every((entry) => entry.status === "complete")).toBe(true);
      if (defect === "material") {
        expect(result.blocker_codes).toContain("material_graph_fidelity_gap");
        expect(result.transition_ref).toBe(null);
        return;
      }
      if (runtime.qualification_scope === "deterministic_test_only") {
        expect(result.blocker_codes).toContain("isolation_unqualified");
        expect(result.transition_ref).toBeNull();
        expect(engine.handle({ schema_version: 2, action: "recover", identity })).toEqual(terminal);
        return;
      }
      const transitionRef = result.transition_ref;
      if (transitionRef === null) throw new Error("positive gate lacks transition");
      const transition = validateScaP03P04TransitionV2(
        JSON.parse(store.read(transitionRef).toString())
      );
      expect(transition).toMatchObject({
        to_phase_id: "SCA-P04",
        p04_entry_authorized: true,
        campaign_terminal: false,
        release_eligible: false,
      });
      const support = validateScaP03GraphSupportMatrixV2(
        JSON.parse(store.read(transition.graph_support_matrix_ref).toString())
      );
      expect(support.complete).toBe(true);
      const gate = validateScaP03GateV1(JSON.parse(store.read(result.gate_ref).toString()));
      expect(gate.status).toBe("passed");
      expect(
        requireScaP03OperationalCohort({
          store,
          transition_ref: transitionRef,
          gate_ref: result.gate_ref,
          tenant_id: "tenant",
          project_id: "project",
          trusted_clock: () => new Date(),
        }).request
      ).toEqual(request);
      expect(engine.handle({ schema_version: 2, action: "recover", identity })).toEqual(terminal);
      const manifest = validateScaP03EvidenceManifestV2(
        JSON.parse(store.read(transition.evidence_manifest_ref).toString())
      );
      const unresolved = uncertainty[0];
      if (unresolved === undefined) throw new Error("uncertainty absent");
      const repersist = (original: ArtifactRef, operation: string, value: unknown) =>
        store.persist({
          metadata: {
            ...store.metadata(original),
            operation_id: operation,
            version: 1,
            parent_ref: null,
          },
          content: canonicalJson(value),
        });
      for (const change of [
        "dropped",
        "modified",
        "relabelled",
        "duplicate",
        "missing_provenance",
      ] as const) {
        const { packet_sha256: _packetSha, ...packetCore } = packet;
        void _packetSha;
        const {
          partition: _partition,
          accounted_paths: _paths,
          graph_component_ref: _graph,
          page_ref: _page,
          candidate_id: _candidateId,
          serialized_bytes: _size,
          ...itemCore
        } = unresolved;
        void [_partition, _paths, _graph, _page, _candidateId, _size];
        const changed =
          change === "relabelled"
            ? makeScaP03QueryCandidateV2({
                ...itemCore,
                disposition: "unsupported",
                reason_code: "unsupported_surface_observed",
              })
            : change === "modified"
              ? makeScaP03QueryCandidateV2({ ...itemCore, summary: "Changed observation" })
              : unresolved;
        const candidates =
          change === "dropped"
            ? packet.candidates.filter((item) => item.candidate_id !== unresolved.candidate_id)
            : change === "duplicate"
              ? [...packet.candidates, unresolved]
              : packet.candidates
                  .map((item) =>
                    item.candidate_id === unresolved.candidate_id
                      ? {
                          ...unresolved,
                          ...changed,
                          page_ref:
                            change === "missing_provenance"
                              ? transition.graph_manifest_ref
                              : unresolved.page_ref,
                        }
                      : item
                  )
                  .sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
        const packetRef = repersist(
          transition.candidate_packet_ref,
          change + "-packet",
          withScaP03Digest({ ...packetCore, candidates }, "packet_sha256")
        );
        const { manifest_sha256: _manifestSha, ...manifestCore } = manifest;
        void _manifestSha;
        const manifestRef = repersist(
          transition.evidence_manifest_ref,
          change + "-manifest",
          withScaP03Digest({ ...manifestCore, candidate_packet_ref: packetRef }, "manifest_sha256")
        );
        const { gate_sha256: _gateSha, ...gateCore } = gate;
        void _gateSha;
        const gateRef = repersist(
          transition.gate_ref,
          change + "-gate",
          withScaP03Digest(
            { ...gateCore, candidate_packet_ref: packetRef, evidence_manifest_ref: manifestRef },
            "gate_sha256"
          )
        );
        const { transition_sha256: _transitionSha, ...transitionCore } = transition;
        void _transitionSha;
        const changedTransition = repersist(
          transitionRef,
          change + "-transition",
          withScaP03Digest(
            {
              ...transitionCore,
              candidate_packet_ref: packetRef,
              evidence_manifest_ref: manifestRef,
              gate_ref: gateRef,
            },
            "transition_sha256"
          )
        );
        expect(() =>
          requireScaP03OperationalCohort({
            store,
            transition_ref: changedTransition,
            gate_ref: gateRef,
            tenant_id: "tenant",
            project_id: "project",
            trusted_clock: () => new Date(),
          })
        ).toThrow(/packet|candidate|page/u);
      }
    }
  } finally {
    admission.mockRestore();
    runtime.runBaselineQueries = baselineQueries;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}
