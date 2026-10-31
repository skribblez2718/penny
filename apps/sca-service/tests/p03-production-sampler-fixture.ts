import {
  type ScaP02ImplementationIdentityV1,
  SCA_P02_QUALIFICATION_ARTIFACTS,
  SCA_P02_QUALIFICATION_CHECKS,
  SCA_P02_QUALIFICATION_CRITERION_IDS,
  buildScaP02CriterionDefinitionV1,
  buildScaP02ImplementationIdentityV1,
  buildScaP02QualificationEvidenceV1,
  createScaP02QualificationDefinitionV1,
} from "../../orchestration/dist/sca/p02-qualification.js";
import {
  SCA_P02_V3_AUTHORITY,
  SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
  SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA,
  SCA_P02_V3_GATE_KIND,
  requireScaP03AcceptedP02Qualification,
} from "../../orchestration/dist/sca/p03-p02-qualification-guard.js";
import {
  SCA_PHASE_GATE_RECORD_V3_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
  SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
  sealScaPhaseReviewReceiptV1,
  sealScaPhaseReviewerAuthorityV1,
} from "../../orchestration/dist/sca/qualification-gate-contracts.js";
import {
  evaluateScaPhaseGateV3,
  evaluateScaPhaseQualificationV3,
  inspectScaQualificationSubjectV1,
  type ScaArtifactContractV1,
} from "../../orchestration/dist/sca/qualification-gate.js";
import type { ScaP03PreLiveInputsV1 } from "../src/p03-initial-live.js";
import { createRequire } from "node:module";
import { measureScaP03ProtectedDependencyRootV1 } from "../src/p03-production-sampler.js";
import { SqliteScaActivationOwner } from "../../orchestration/dist/sca/activation-owner.js";
import { ScaHostKeyInstallation } from "../../orchestration/dist/sca/activation-host-key.js";
import {
  sealScaActivationAuthorityV1,
  sealScaActivationIssuanceV1,
  type ScaActivationScopeV1,
} from "../../orchestration/dist/sca/qualification-activation-contracts.js";
import { runtimeRegistrationSha256 } from "../../orchestration/dist/playbooks/runtime-registration-digest.js";
import { SCA_P03_PHASE_REGISTRATION } from "../../orchestration/dist/sca/p03-playbook.js";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  readdirSync,
  realpathSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ArtifactStore, previewArtifactRef } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../../orchestration/dist/contracts.js";
import * as p01 from "../../orchestration/dist/sca/p01-contracts.js";
import {
  SCA_MODEL_ALIAS,
  SCA_MODEL_PROVIDER,
  SCA_MODEL_ID,
} from "../../orchestration/dist/sca/model-identity.js";
import { scaP02FrozenRefs } from "../../orchestration/dist/sca/p02-contracts.js";
import { validateScaToolchainIdentityV1 } from "../../orchestration/dist/sca/p01-policy-contracts.js";
import {
  SCA_P03_QUERY_IDS,
  projectSourceOracleCases,
  validateScaP03QualificationProfileV2,
  withScaP03Digest,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  planScaP03ImplementationV3,
  freezeScaP03ProductionV1,
} from "../src/p03-bootstrap-freeze.js";
import { SCA_P02_CANDIDATE_SKILL_CONTRACT } from "../../orchestration/dist/sca/p02-playbook.js";
import { buildP01SourceSnapshotV2 } from "../../orchestration/dist/sca/p01-source-snapshot-builder.js";
import { P03_BOOTSTRAP_ROLES } from "../src/p03-bootstrap.js";
import {
  createScaP03LocalHostProbeDeterministicTestOnlyV1,
  type ScaP03ProbeCommandV1,
} from "../src/p03-bootstrap-local-probe.js";
import { ScaP03WorkspaceRegistryV1 } from "../src/p03-bootstrap-workspaces.js";
import { ScaP03HostWitnessSinkV1 } from "../src/p03-bootstrap-witness.js";
import { issueScaP03PostRunEvidenceV3 } from "../src/p03-bootstrap-issuers.js";
import { finalizeScaP03ProductionBootstrapRecordV1 } from "../src/p03-bootstrap-v3.js";
import { runScaP03BootstrapCliV1 } from "../src/p03-bootstrap-cli.js";
import {
  parseScaP03CliCanonical,
  ScaP03CliProductionVerifyManifestSchema,
  scaP03CliMappingSha256,
} from "../src/p03-bootstrap-cli-contracts.js";
import { readSourceOracle } from "./p03-source-oracle.js";
import { observedFromSourceCase } from "./p03-test-oracle.js";
import { createP03ProtectedTempFixture } from "./p03-protected-temp-fixture.js";
import {
  buildP03CompiledFixture,
  protectedOrchestrationFixture,
} from "./p03-compiled-orchestration-fixture.js";

const roots: string[] = [];
const stores: ArtifactStore[] = [];
const owners: Disposable[] = [];
export function disposeSamplerFixtures() {
  for (const owner of owners.splice(0)) owner[Symbol.dispose]();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
function decode(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString());
}

/** Disposable immutable contract fixtures, not qualification or an admitted operational campaign.
 * Sampling/sealing use the actual local probe and closed authority; only Docker observations are replaced.
 */
export async function productionSamplerFixture(
  badSignature = false,
  options: {
    readonly project_id?: string;
    readonly root?: string;
    readonly storeRoot?: string;
    readonly oracleRoot?: string;
    readonly run_id?: string;
    readonly rootClosure?: unknown;
    readonly campaign_source?: boolean;
    /** Two real frozen rule operands, consumed by P01/P02 predecessor admission. */
    readonly large_opaque_rules?: boolean;
    readonly initial_resources?: import("../../orchestration/dist/sca/p03-initial-authorization.js").ScaP03InitialResourcesV1;
  } = {}
) {
  const root = options.root ?? createP03ProtectedTempFixture("p03-sampler-");
  roots.push(root);
  const storeRoot = options.storeRoot ?? path.join(root, "store");
  const project_id = options.project_id ?? `prj_${"a".repeat(32)}`;
  const store =
    options.storeRoot === undefined
      ? ArtifactStore.provision(storeRoot, { projectId: project_id })
      : ArtifactStore.openExisting(storeRoot, { projectId: project_id });
  stores.push(store);
  const working = path.join(root, "private");
  mkdirSync(working, { mode: 0o700 });
  const file = (name: string, bytes: string | Uint8Array, mode = 0o600) => {
    const target = path.join(working, name);
    writeFileSync(target, bytes, { mode });
    return target;
  };
  let ordinal = 0;
  const persist = (
    value: unknown,
    kind: string,
    schema: string,
    producer: string,
    run_id: string,
    upstream_refs: readonly ArtifactRef[] = [],
    operation_id = `fixture-${++ordinal}`,
    media_type = "application/json"
  ) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id,
        phase:
          options.rootClosure !== undefined &&
          ["sca-p01-tool-executable-package", "sca-p01-tool-measurement-receipt"].includes(kind)
            ? "sca-p01"
            : "SCA-P03",
        branch_id: null,
        kind,
        operation_id,
        version: 1,
        producer,
        media_type,
        content_schema: { schema_id: schema, schema_version: Number(schema.slice(-1)) },
        parent_ref: null,
        upstream_refs: [...upstream_refs],
      },
      content: canonicalJson(value),
    });
  const campaign = options.run_id === undefined ? "fixture-p01-campaign" : `${options.run_id}-p01`;
  const qualificationRun =
    options.run_id === undefined
      ? "fixture-p01-qualification"
      : `${options.run_id}-p01-qualification`;
  const run_id = options.run_id ?? "fixture-p03";
  const time = new Date().toISOString();
  const identity = { tenant_id: "test-tenant", project_id, run_id: campaign };
  const contractNames: Readonly<Record<string, string>> = {
    profile: "analysis_profile",
    release: "rule_release",
    bundle: "rule_bundle",
    "rule-profile": "rule_profile",
    "selected-rules": "selected_rule_manifest",
    network: "network_policy",
    privacy: "privacy_policy",
    "model-data": "model_data_policy",
    resources: "resource_policy",
    output: "output_policy",
    authority: "authority_policy",
    "q-files": "source_manifests",
    "q-custody": "source_custodies",
    "impl-source": "implementation_source",
    "impl-build": "implementation_build",
  };
  const dummy = (name: string, run = campaign) => {
    const contract =
      options.campaign_source === true
        ? SCA_P02_CANDIDATE_SKILL_CONTRACT.io.input_ports.find(
            (port) => port.name === contractNames[name]
          )
        : undefined;
    if (options.large_opaque_rules === true && (name === "release" || name === "bundle")) {
      const bytes = Buffer.alloc(
        name === "release" ? 35_162_428 : 21_958_840,
        name === "release" ? 0x71 : 0x72
      );
      return store.persist({
        metadata: {
          schema_version: 2,
          run_id: run,
          phase: "SCA-P01",
          branch_id: null,
          kind: `fixture-${name}`,
          operation_id: `frozen-${name}`,
          version: 1,
          producer: "host:test",
          media_type: "application/octet-stream",
          parent_ref: null,
          upstream_refs: [],
        },
        content: bytes,
      });
    }
    return persist(
      { fixture: name },
      contract?.artifact_kind ?? `fixture-${name}`,
      contract?.schema_id ?? "penny.sampler-fixture.v1",
      "host:test",
      run
    );
  };
  const candidate = (value: unknown, kind: string, schema: string) =>
    persist(value, kind, schema, "host:sca-p01-candidate", campaign, [], kind);
  const tools = ["joern", "scanner"].map((tool_id) => {
    const role = tool_id === "joern" ? ("parser" as const) : ("scanner" as const);
    const executable_ref = persist(
      tool_id === "joern" && options.rootClosure !== undefined
        ? options.rootClosure
        : { fixture: tool_id },
      "sca-p01-tool-executable-package",
      "penny.sca-p01-tool-executable-package.v1",
      "host:sca-tool-executable-custody",
      campaign,
      [],
      `executable-${tool_id}`,
      "application/octet-stream"
    );
    const version = "4.0.627";
    const measurement_receipt_ref = persist(
      {
        schema_id: "penny.sca-p01-tool-measurement-receipt.v1",
        schema_version: 1,
        receipt_id: tool_id,
        tool_id,
        role,
        version,
        executable_ref,
        executable_sha256: executable_ref.content_digest,
        measurement_method: "host-sha256",
        measured_at: time,
        status: "verified",
      },
      "sca-p01-tool-measurement-receipt",
      "penny.sca-p01-tool-measurement-receipt.v1",
      "host:sca-tool-measurement-authority",
      campaign,
      [executable_ref]
    );
    return {
      tool_id,
      role,
      version,
      executable_ref,
      executable_sha256: executable_ref.content_digest,
      measurement_receipt_ref,
      languages: ["javascript", "php", "typescript"],
      target_execution: "forbidden",
      network_access: "denied",
      acquisition: "preinstalled-only",
    };
  });
  const toolchain = validateScaToolchainIdentityV1({
    schema_id: "penny.sca-toolchain-identity.v1",
    schema_version: 1,
    toolchain_id: "fixture-toolchain",
    trust_status: "host-declared",
    status: "approved",
    analysis_profile_id: "profile",
    source_posture: "read-only",
    package_acquisition: "forbidden",
    target_startup: "forbidden",
    tools,
  });
  const toolchain_ref = persist(
    toolchain,
    "sca-toolchain",
    toolchain.schema_id,
    "host:sca-toolchain-authority",
    campaign
  );
  const qualification = p01.validateScaPhaseQualificationRecordV2({
    schema_id: p01.SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
    schema_version: 2,
    record_kind: "implementation_qualification",
    ...identity,
    run_id: qualificationRun,
    phase_id: "SCA-P01",
    implementation_revision: "revision",
    qualification_profile_ref: dummy("q-profile", qualificationRun),
    source_snapshot_ref: dummy("q-source", qualificationRun),
    implementation_ref: dummy("q-implementation", qualificationRun),
    implementer_identity_id: "implementer",
    implementer_lineage_id: "implementer-lineage",
    reviewer_authority_ref: dummy("q-authority", qualificationRun),
    reviewer_receipt_ref: dummy("q-receipt", qualificationRun),
    criteria: p01.SCA_P01_REQUIRED_CRITERION_IDS.map((criterion_id, i) => ({
      criterion_id,
      status: "PASS",
      variants: p01.SCA_P01_QUALIFICATION_VARIANT_IDS.map((variant_id) => ({
        variant_id,
        applicability: "applicable",
        status: "PASS",
        fixture_ref: dummy(`q-fixture-${i}-${variant_id}`, qualificationRun),
        evidence_ref: dummy(`q-evidence-${i}-${variant_id}`, qualificationRun),
      })),
    })),
    remaining_gaps: [],
    status: "PASS",
    recorded_at: time,
  });
  const p01_qualification_ref = persist(
    qualification,
    "sca-phase-qualification",
    qualification.schema_id,
    p01.SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.qualification,
    qualificationRun
  );
  let source: ReturnType<typeof buildP01SourceSnapshotV2> | undefined;
  if (options.campaign_source === true) {
    const sourceRoot = path.join(working, "campaign-source");
    mkdirSync(path.join(sourceRoot, "src"), { recursive: true, mode: 0o700 });
    for (const [file, bytes] of [
      ["a.php", "<?php function target($x) { return $x; } target(1);"],
      ["a.js", "function target(x) { return x; } target(1);"],
      ["a.ts", "function target(x: number) { return x; } target(1);"],
    ]) {
      if (file === undefined || bytes === undefined) throw new Error("campaign fixture absent");
      writeFileSync(path.join(sourceRoot, "src", file), bytes, { mode: 0o600 });
    }
    source = buildP01SourceSnapshotV2({
      source_root: sourceRoot,
      store,
      run_id: campaign,
      snapshot_id: "native-campaign",
      policy: {
        include_paths: ["src"],
        exclude_paths: [],
        max_files: 3,
        max_total_bytes: 4096,
        max_file_bytes: 1024,
        max_walk_entries: 8,
      },
    });
  }
  const frozen = {
    source_snapshot_ref: source?.snapshot_ref ?? dummy("snapshot"),
    source_file_manifest_ref: source?.file_manifest_ref ?? dummy("files"),
    source_custody_ref: source?.custody_ref ?? dummy("custody"),
    source_provenance_ref: source?.provenance_ref ?? dummy("provenance"),
    analysis_profile_ref: dummy("profile"),
    rule_release_ref: dummy("release"),
    rule_bundle_ref: dummy("bundle"),
    rule_profile_ref: dummy("rule-profile"),
    selected_rule_manifest_ref: dummy("selected-rules"),
    toolchain_ref,
    tool_executable_refs: tools
      .map((t) => t.executable_ref)
      .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
    tool_measurement_receipt_refs: tools
      .map((t) => t.measurement_receipt_ref)
      .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
    network_policy_ref: dummy("network"),
    privacy_policy_ref: dummy("privacy"),
    model_data_policy_ref: dummy("model-data"),
    resource_policy_ref: dummy("resources"),
    output_policy_ref: dummy("output"),
    authority_policy_ref: dummy("authority"),
    p01_qualification_ref,
    qualification_source_file_manifest_ref: dummy("q-files"),
    qualification_source_custody_ref: dummy("q-custody"),
    implementation_source_ref: dummy("impl-source"),
    implementation_build_ref: dummy("impl-build"),
  };
  const runtime_cognition = {
    alias: SCA_MODEL_ALIAS,
    provider: SCA_MODEL_PROVIDER,
    model: SCA_MODEL_ID,
  };
  const authorities = {
    execution_authority_id: "execution",
    promotion_authority_id: "promotion",
    release_authority_id: "release",
  };
  const request = p01.validateScaP01AdmissionRequestV3({
    schema_id: p01.SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
    schema_version: 3,
    ...identity,
    source: {
      snapshot_ref: frozen.source_snapshot_ref,
      provenance_ref: frozen.source_provenance_ref,
    },
    scope: { include_paths: ["src"], exclude_paths: [] },
    analysis_profile: {
      profile_id: "profile",
      profile_ref: frozen.analysis_profile_ref,
      languages: ["javascript", "php", "typescript"],
      frameworks: [],
    },
    rule_release_ref: frozen.rule_release_ref,
    rule_profile_ref: frozen.rule_profile_ref,
    toolchain_ref,
    network_policy_ref: frozen.network_policy_ref,
    privacy_policy_ref: frozen.privacy_policy_ref,
    model_data_policy_ref: frozen.model_data_policy_ref,
    resource_policy_ref: frozen.resource_policy_ref,
    output_policy_ref: frozen.output_policy_ref,
    authority_policy_ref: frozen.authority_policy_ref,
    p01_qualification_ref,
    implementation_revision: "revision",
    runtime_cognition,
    report_namespace: "fixture",
    requested_at: time,
    authorities,
  });
  const request_ref = candidate(request, "sca-p01-candidate-request", request.schema_id);
  const ledger = p01.buildScaInitialObligationLedgerV2({
    ...identity,
    created_at: time,
    assigning_authority_id: "execution",
    policy_refs: [frozen.authority_policy_ref],
    supporting_evidence_refs: [request_ref],
  });
  const obligation_ledger_ref = candidate(
    ledger,
    "sca-p01-candidate-obligation-ledger",
    ledger.schema_id
  );
  const core = p01.validateScaCampaignManifestCoreV1(
    withScaP03Digest(
      {
        schema_id: p01.SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
        schema_version: 1,
        ...identity,
        request_ref,
        obligation_ledger_ref,
        implementation_revision: "revision",
        runtime_cognition,
        report_namespace: "fixture",
        authorities,
        frozen_refs: frozen,
        status: "pending_gate",
        sca_completion_claimed: false,
      },
      "binding_sha256"
    )
  );
  const campaign_manifest_core_ref = candidate(
    core,
    "sca-p01-candidate-manifest-core",
    core.schema_id
  );
  const evidence = p01.validateScaP01AdmissionEvidenceV1({
    schema_id: p01.SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
    schema_version: 1,
    ...identity,
    request_ref,
    obligation_ledger_ref,
    manifest_core_ref: campaign_manifest_core_ref,
    qualification_ref: p01_qualification_ref,
    evidence_refs: [request_ref],
    checks: [
      "artifact-bindings",
      "semantic-policies",
      "trusted-qualification",
      "zero-dispatch",
    ].map((check_id) => ({ check_id, status: "PASS" })),
    dispatch_delta: { model: 0, scanner: 0, application: 0 },
    status: "passed",
    evaluated_at: time,
  });
  const admission_evidence_ref = candidate(
    evidence,
    "sca-p01-candidate-admission-evidence",
    evidence.schema_id
  );
  const gate = p01.validateScaPhaseGateRecordV2({
    schema_id: p01.SCA_PHASE_GATE_RECORD_V2_SCHEMA,
    schema_version: 2,
    ...identity,
    phase_id: "SCA-P01",
    implementation_revision: "revision",
    request_ref,
    obligation_ledger_ref,
    manifest_core_ref: campaign_manifest_core_ref,
    qualification_ref: p01_qualification_ref,
    admission_evidence_ref,
    criterion_results: p01.SCA_P01_REQUIRED_CRITERION_IDS.map((criterion_id) => ({
      criterion_id,
      status: "PASS",
    })),
    status: "passed",
    evaluated_at: time,
  });
  const p01_gate_ref = candidate(gate, "sca-p01-candidate-gate", gate.schema_id);
  const campaignManifest = p01.validateScaCampaignManifestV2(
    withScaP03Digest(
      {
        schema_id: p01.SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
        schema_version: 2,
        ...identity,
        manifest_core_ref: campaign_manifest_core_ref,
        p01_gate_ref,
        request_ref,
        obligation_ledger_ref,
        authority_policy_ref: frozen.authority_policy_ref,
        admitted_phase_id: "SCA-P01",
        m1_status: "not_reached",
        campaign_status: "admitted",
        sca_completion_claimed: false,
        admitted_at: time,
      },
      "admission_binding_sha256"
    )
  );
  const campaign_manifest_ref = candidate(
    campaignManifest,
    "sca-p01-candidate-campaign-manifest",
    campaignManifest.schema_id
  );
  const accepted_p01 = {
    request_ref,
    obligation_ledger_ref,
    campaign_manifest_core_ref,
    admission_evidence_ref,
    p01_gate_ref,
    campaign_manifest_ref,
    frozen_refs: scaP02FrozenRefs(core),
  };
  const joern = toolchain.tools.find((t) => t.tool_id === "joern");
  if (joern === undefined) throw new Error("fixture joern missing");

  const { oracle, fixtures } = await readSourceOracle(options.oracleRoot);
  const implementation = (["source", "build", "normalizer", "query_runner"] as const).map(
    (role) => {
      const bytes = Buffer.from(`test-${role}`);
      return { role, path: file(`${role}.ts`, bytes), bytes, current_bytes: bytes };
    }
  );
  const plan = planScaP03ImplementationV3(
    run_id,
    "fixture-implementation",
    "revision",
    implementation
  );
  const profile = validateScaP03QualificationProfileV2(
    withScaP03Digest(
      {
        schema_id: "penny.sca-p03-qualification-profile.v2",
        schema_version: 2,
        profile_id: "fixture-profile",
        phase_id: "SCA-P03",
        required_languages: ["php", "javascript", "typescript"],
        required_query_ids: SCA_P03_QUERY_IDS,
        fidelity_requirements: (["php", "javascript", "typescript"] as const).flatMap((language) =>
          [
            "language",
            ...(language === "typescript" ? [] : ["framework", "edge_class", "surface"]),
          ].map((dimension) => ({
            requirement_id: `${language}-${dimension}`,
            dimension,
            subject:
              dimension === "language" ? language : dimension === "edge_class" ? "call" : "fixture",
            partition: language === "php" ? "php" : "javascript_typescript",
            materiality: "material",
            complement_evidence_ref: null,
          }))
        ),
        requires_live_runtime: true,
        criterion_ids: [
          "AC-P03.graph-construction",
          "AC-P03.baseline-queries",
          "AC-P03.recovery-cancellation",
          "AC-P03.zero-model-ordering",
        ],
      },
      "profile_sha256"
    )
  );
  const dockerBytes = Buffer.from("fixture docker executable");
  const docker = file("docker", dockerBytes, 0o700);
  const image_id = `sha256:${sha256("image configuration")}`;
  const config = {
    docker_executable: docker,
    image_ref: `fixture/joern@sha256:${sha256("image manifest")}`,
    expected_joern_version: "4.0.627",
    expected_docker_executable_sha256: sha256(dockerBytes),
    expected_docker_client_version: "1.0.0",
    expected_docker_server_version: "1.0.0",
    runtime_id: "fixture-runtime",
    isolation_id: "fixture-isolation",
    isolation_profile_sha256: profile.profile_sha256,
    implementation_identity_sha256: plan.identity.implementation_sha256,
    deployment_identity_sha256: sha256(
      canonicalJson({
        docker_executable_sha256: sha256(dockerBytes),
        docker_client_version: "1.0.0",
        docker_server_version: "1.0.0",
        image_id,
        joern_version: "4.0.627",
      })
    ),
    staging_parent: working,
    memory_bytes: 512 * 1_048_576,
    cpus: 1,
    pids: 128,
    max_workspace_bytes: 4 * 1_048_576,
    max_num_def: 100,
    max_command_output_bytes: 100_000,
    timeout_ms: 3000,
    ...(options.initial_resources === undefined
      ? {}
      : {
          memory_bytes: options.initial_resources.memory_bytes,
          cpus: options.initial_resources.cpus,
          pids: options.initial_resources.pids,
          max_workspace_bytes: options.initial_resources.work_bytes,
          max_num_def: options.initial_resources.max_num_def,
          max_command_output_bytes: options.initial_resources.command_output_bytes,
          timeout_ms: options.initial_resources.inactivity_ms,
        }),
  };
  const policy = {
    schema_id: "penny.sca-p03-runtime-policy.v1" as const,
    schema_version: 1 as const,
    policy_id: "fixture-policy",
    staging_parent_sha256: sha256(working),
    source_posture: "read_only" as const,
    network_access: "denied" as const,
    package_acquisition: "forbidden" as const,
    target_execution: "forbidden" as const,
    shell_execution: "forbidden" as const,
    joern_server: "forbidden" as const,
    process_timeout_ms: config.timeout_ms,
    max_graph_bytes: 1_048_576,
    max_query_output_bytes: 1_048_576,
    max_query_items: 100,
    max_page_items: 10,
    max_pages_per_query: 10,
    max_ast_depth: 8,
    max_ast_nodes: 32,
    max_num_def: config.max_num_def,
  };
  const oracle_ref = previewArtifactRef({
    metadata: {
      schema_version: 2,
      run_id,
      phase: "SCA-P03",
      branch_id: null,
      kind: "sca-p03-source-oracle",
      operation_id: "freeze-oracle",
      version: 1,
      producer: "host:sca-p03-source-oracle-authority",
      media_type: "application/json",
      content_schema: { schema_id: "penny.sca-p03-source-oracle.v2", schema_version: 2 },
      parent_ref: null,
      upstream_refs: [],
    },
    content: canonicalJson(oracle),
  });
  const review = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-source-oracle-review.v1",
      schema_version: 1,
      producer: "host:sca-p03-source-oracle-review",
      oracle_sha256: oracle.oracle_sha256,
      parser_identity_sha256: oracle.parser.identity_sha256,
      fixture_content_sha256: (["php", "javascript", "typescript"] as const).map((language) => {
        const f = fixtures.find((f) => f.language === language);
        if (!f) throw new Error("fixture missing");
        return f.content_sha256;
      }),
      expected_cases: projectSourceOracleCases(oracle),
    },
    "review_sha256"
  );
  const review_ref = persist(
    review,
    "sca-p03-source-oracle-review",
    review.schema_id,
    review.producer,
    run_id,
    [oracle_ref]
  );
  const result = freezeScaP03ProductionV1(store, {
    run_id,
    corpus_id: "fixture-corpus",
    query_set_id: "fixture-queries",
    release_id: "fixture-release",
    implementation_id: "fixture-implementation",
    implementation_revision: "revision",
    root_tool_id: "joern",
    policy_id: policy.policy_id,
    profile,
    policy,
    config,
    measured: {
      docker_executable_bytes: dockerBytes,
      docker_client_version: "1.0.0",
      docker_server_version: "1.0.0",
      image_id,
      image_ref: config.image_ref,
      joern_version: "4.0.627",
      php_frontend_version: "4.0.627",
      javascript_frontend_version: "4.0.627",
      jvm_version: "17",
      php_runtime_version: "8",
      helper_version: "1",
    },
    oracle_bytes: Buffer.from(canonicalJson(oracle)),
    review_ref,
    review_bytes: Buffer.from(canonicalJson(review)),
    validated_at: time,
    fixtures: fixtures.map((f) => ({ language: f.language, bytes: f.bytes })),
    implementation,
    accepted_p01,
    toolchain_ref,
    root_executable_ref: joern.executable_ref,
    root_measurement_ref: joern.measurement_receipt_ref,
  });
  const b = result.bindings;
  const packages = result.package_descriptors
    .map((p, i) => ({ ref: p.ref, path: file(`package-${i}.json`, p.bytes) }))
    .sort((a, b) => a.ref.artifact_id.localeCompare(b.ref.artifact_id));
  const mapped = result.implementation_mappings.map((m) => ({
    role: m.role,
    ref: m.ref,
    path: m.path,
  }));
  const build_files = Object.fromEntries(
    [...mapped, ...packages].map((m) => [m.ref.artifact_id, m.path])
  );
  const registry = ScaP03WorkspaceRegistryV1.create(path.join(working, "registry.json"));
  const selection = path.join(working, "selection.json");
  const observations = samplerDockerObservations(config, image_id);
  const { command, commands } = observations;
  const probeInput = {
    config,
    store,
    build_files,
    runtime_package_refs: b.runtime_package_refs,
    current_selection_path: selection,
    registry,
  };
  const probe = createScaP03LocalHostProbeDeterministicTestOnlyV1(probeInput, command);
  const sink = new ScaP03HostWitnessSinkV1(
    {
      run_id,
      candidate_sha256: sha256(
        canonicalJson({
          run_id,
          runtime_id: b.runtime_id,
          isolation_id: b.isolation_id,
          implementation_sha256: b.implementation_identity_sha256,
          deployment_sha256: b.deployment_identity_sha256,
          profile_sha256: b.profile_sha256,
          implementation_source_refs: b.implementation_source_refs,
        })
      ),
      identity: await probe.measureIdentity(),
    },
    registry
  );
  const workspace = path.join(working, "fixture-workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const stat = lstatSync(workspace);
  sink.startWorkspace(canonicalJson({ path: workspace, dev: stat.dev, ino: stat.ino }));
  const name = `penny-p03-${randomUUID()}`;
  const id = "b".repeat(64);
  sink.create(name, ["container", "create"]);
  sink.id(name, id);
  sink.inspect(
    name,
    "{}",
    canonicalJson({
      image: image_id,
      id,
      name: `/${name}`,
      network: "none",
      pid_mode: "",
      ipc_mode: "",
      uts_mode: "",
      readonly_root: true,
      privileged: false,
      init: true,
      running: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges"],
      pids: config.pids,
      memory: config.memory_bytes,
      memory_swap: config.memory_bytes,
      nano_cpus: Math.round(config.cpus * 1_000_000_000),
      log: "none",
      tmpfs: {
        "/tmp": "rw,exec,nosuid,nodev,size=67108864",
        "/work": `rw,exec,nosuid,nodev,size=${config.max_workspace_bytes},mode=0700,uid=${process.getuid?.()},gid=${process.getgid?.()}`,
      },
      user: `${process.getuid?.()}:${process.getgid?.()}`,
      workdir: "/tmp",
      env: ["HOME=/tmp"],
      entrypoint: ["sleep"],
      command: ["infinity"],
      mounts: [
        {
          destination: "/scripts",
          type: "bind",
          readonly: true,
          source_sha256: sha256("fixture scripts"),
        },
      ],
    })
  );
  sink.startContainer(name);
  sink.command(name, ["container", "exec"], true);
  sink.response(name, "fixture observations");
  sink.readback(name, Buffer.from("fixture graph"));
  sink.removal(name, true);
  rmSync(workspace, { recursive: true });
  sink.finishWorkspace(true);
  const witness_bytes = sink.finalize("completed");
  const attempt_ref = persist(
    decode(witness_bytes),
    "sca-p03-attempt-witness",
    "penny.sca-p03-attempt-witness.v1",
    P03_BOOTSTRAP_ROLES.evaluator,
    run_id,
    [
      b.runtime_policy_ref,
      b.implementation_identity_ref,
      b.runtime_identity_ref,
      ...b.implementation_source_refs,
    ]
  );
  const evidenceInput = {
    store,
    probe,
    config,
    attempt_ref,
    policy_ref: b.runtime_policy_ref,
    implementation_identity_ref: b.implementation_identity_ref,
    runtime_identity_ref: b.runtime_identity_ref,
    implementation_source_refs: b.implementation_source_refs,
  };
  const postrun = await issueScaP03PostRunEvidenceV3(evidenceInput);
  const cleanup_ref = persist(
    decode(postrun.cleanup_bytes),
    "sca-p03-cleanup-evidence",
    "penny.sca-p03-bootstrap-cleanup-evidence.v2",
    P03_BOOTSTRAP_ROLES.cleanup,
    run_id,
    [attempt_ref, b.runtime_policy_ref]
  );
  const isolation_ref = persist(
    decode(postrun.isolation_bytes),
    "sca-p03-isolation-evidence",
    "penny.sca-p03-bootstrap-isolation-evidence.v2",
    P03_BOOTSTRAP_ROLES.isolation,
    run_id,
    [attempt_ref, b.runtime_policy_ref]
  );
  const record = await finalizeScaP03ProductionBootstrapRecordV1({
    run_id,
    production_bindings: result.production_bindings,
    measured: {
      witness_bytes,
      disposition: "completed",
      output: {
        executed_query_release_sha256: b.release_sha256,
        cases: projectSourceOracleCases(oracle).map((expected) => {
          const f = fixtures.find((f) => f.language === expected.language);
          if (!f) throw new Error("fixture missing");
          return observedFromSourceCase(
            expected,
            f,
            b.release_sha256,
            b.source_oracle_validation_ref
          );
        }),
      },
    },
    attempt_ref,
    cleanup_ref,
    isolation_ref,
    implementation_refs: b.implementation_source_refs,
    store,
    probe,
  });
  const record_ref = persist(
    record,
    "sca-p03-bootstrap-record",
    record.schema_id,
    P03_BOOTSTRAP_ROLES.evaluator,
    run_id,
    [
      b.fixture_corpus_ref,
      b.source_oracle_ref,
      b.source_oracle_validation_ref,
      b.source_oracle_review_ref,
      b.baseline_query_set_ref,
      b.qualification_profile_ref,
      b.runtime_policy_ref,
      b.implementation_identity_ref,
      b.runtime_identity_ref,
      ...b.fixture_content_refs,
      ...b.query_script_refs,
      ...b.query_plan_refs,
      ...b.runtime_package_refs,
      ...b.implementation_source_refs,
      attempt_ref,
      cleanup_ref,
      isolation_ref,
    ]
  );
  const freezePath = file(
    "production-freeze-handoff.json",
    canonicalJson({
      schema_id: "penny.sca-p03-cli-production-freeze-handoff.v1",
      schema_version: 1,
      store_root: storeRoot,
      project_id,
      run_id,
      status: "ready_for_review",
      bindings: b,
      production_bindings: result.production_bindings,
      mapping_sha256: scaP03CliMappingSha256(mapped),
      attempt_ref,
      cleanup_ref,
      isolation_ref,
      record_ref,
    })
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signed = {
    external_review_id: "fixture-review",
    record_ref,
    attempt_ref,
    cleanup_ref,
    isolation_ref,
    reviewer_id: "fixture-reviewer",
    reviewer_authority_id: "fixture-review-authority",
    decision: "PASS",
    reviewed_at: new Date(Date.now() + 2000).toISOString(),
  };
  const reviewPath = file(
    "external.json",
    canonicalJson({
      ...signed,
      signature: (badSignature
        ? Buffer.alloc(64)
        : sign(null, Buffer.from(canonicalJson(signed)), privateKey)
      ).toString("base64"),
    })
  );
  const keyPath = file("key.pem", publicKey.export({ type: "spki", format: "pem" }));
  const seal = {
    schema_id: "penny.sca-p03-cli-production-seal-manifest.v1",
    schema_version: 1,
    store_root: storeRoot,
    project_id,
    run_id,
    working_dir: working,
    config,
    freeze_handoff_path: freezePath,
    freeze_handoff_sha256: sha256(readFileSync(freezePath)),
    implementation: mapped,
    runtime_packages: packages,
    external_review_path: reviewPath,
    reviewer_public_key_path: keyPath,
    reviewer_public_key_sha256: sha256(publicKey.export({ type: "spki", format: "der" })),
    reviewer_id: signed.reviewer_id,
    reviewer_authority_id: signed.reviewer_authority_id,
    evaluator_id: "fixture-evaluator",
    attester_id: "fixture-attester",
    attestation_id: "fixture-attestation",
  };
  const sealPath = file("seal.json", canonicalJson(seal));
  await runScaP03BootstrapCliV1(["seal-production", "--manifest", sealPath], {
    createProbe: (input) => createScaP03LocalHostProbeDeterministicTestOnlyV1(input, command),
    emit: () => undefined,
  });
  const sealedPath = path.join(working, "production-sealed-handoff.json");
  const manifest = parseScaP03CliCanonical(
    ScaP03CliProductionVerifyManifestSchema,
    Buffer.from(
      canonicalJson({
        ...seal,
        schema_id: "penny.sca-p03-cli-production-verify-manifest.v1",
        sealed_handoff_path: sealedPath,
        sealed_handoff_sha256: sha256(readFileSync(sealedPath)),
      })
    )
  );
  const manifest_path = file("verify.json", canonicalJson(manifest));
  store.close();
  stores.splice(stores.indexOf(store), 1);
  commands.length = 0;
  return {
    root,
    working,
    storeRoot,
    project_id,
    run_id,
    file,
    manifest,
    manifest_path,
    manifest_sha256: sha256(readFileSync(manifest_path)),
    sealedPath,
    freezePath,
    selection,
    record_ref,
    keyPath,
    reviewPath,
    implementation,
    packages,
    ...observations,
  };
}

/** Bounded Docker observations only; the verifier still owns all parsing/custody/proof decisions. */
export function samplerDockerObservations(
  config: import("../src/p03-docker-runtime.js").ScaP03DockerCandidateConfigV1,
  image_id: string
) {
  let createdName = "";
  let drift = false;
  let unavailable = false;
  let residue = false;
  const commands: string[][] = [];
  const command: ScaP03ProbeCommandV1 = async (argv) => {
    commands.push([...argv]);
    if (unavailable) throw new Error("test Docker unavailable");
    if (argv[0] === "version")
      return JSON.stringify({ Client: { Version: "1.0.0" }, Server: { Version: "1.0.0" } });
    if (argv[0] === "image")
      return JSON.stringify({
        Id: drift ? `sha256:${sha256("drift")}` : image_id,
        RepoDigests: [config.image_ref],
      });
    if (argv[1] === "create") {
      createdName = argv[argv.indexOf("--name") + 1] ?? "";
      return "a".repeat(64);
    }
    if (argv[1] === "inspect")
      return JSON.stringify({
        Id: "a".repeat(64),
        Image: drift ? `sha256:${sha256("drift")}` : image_id,
        Name: `/${createdName}`,
        Mounts: [],
        HostConfig: {
          NetworkMode: "none",
          PidMode: "",
          IpcMode: "",
          UTSMode: "",
          ReadonlyRootfs: true,
          Privileged: false,
          Init: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          PidsLimit: config.pids,
          Memory: config.memory_bytes,
          MemorySwap: config.memory_bytes,
          NanoCpus: Math.round(config.cpus * 1_000_000_000),
          LogConfig: { Type: "none" },
          Tmpfs: { "/tmp": "rw,exec,nosuid,nodev,size=67108864" },
        },
        Config: {
          User: `${process.getuid?.()}:${process.getgid?.()}`,
          WorkingDir: "/tmp",
          Env: ["HOME=/tmp"],
          Entrypoint: ["sleep"],
          Cmd: ["infinity"],
        },
      });
    if (argv[1] === "exec") {
      if (argv[3] === "find") return "io.joern.joern-cli-4.0.627.jar\n";
      if (argv[3] === "which") return "/opt/joern/joern-cli/joern\n";
      if (argv[3] === "joern") return "Usage: joern [options] [<cpg.bin>]\n";
      throw new Error("unexpected test command");
    }
    if (argv[1] === "ls") return residue ? "leftover" : "";
    return "";
  };
  return {
    command,
    commands,
    setDrift: (value: boolean) => {
      drift = value;
    },
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    setResidue: (value: boolean) => {
      residue = value;
    },
  };
}

// A bounded real child test double for Docker observations; no verifier, authority, parser or sample is mocked.
export function verificationChild(f: Awaited<ReturnType<typeof productionSamplerFixture>>) {
  const node_executable = protectedNodeFixture(f.working);
  const counter = path.join(f.working, "child-count");
  const driver = f.file(
    "driver.ts",
    `
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    process.argv[1] = undefined; // importing a bundled CLI must not also run its main guard
    const { runScaP03BootstrapCliV1 } = await import(${JSON.stringify(fileURLToPath(new URL("../src/p03-bootstrap-cli.ts", import.meta.url)))});
    const { createScaP03LocalHostProbeDeterministicTestOnlyV1 } = await import(${JSON.stringify(fileURLToPath(new URL("../src/p03-bootstrap-local-probe.ts", import.meta.url)))});
    const { samplerDockerObservations } = await import(${JSON.stringify(fileURLToPath(new URL("./p03-production-sampler-fixture.ts", import.meta.url)))});
    const counter = ${JSON.stringify(counter)};
    writeFileSync(counter, String(existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1), { mode: 0o600 });
    const { command } = samplerDockerObservations(${canonicalJson(f.manifest.config)}, ${JSON.stringify(`sha256:${sha256("image configuration")}`)});
    await runScaP03BootstrapCliV1(process.argv.slice(2), { createProbe: (input) => createScaP03LocalHostProbeDeterministicTestOnlyV1(input, command) });
  `
  );
  const cli_entrypoint = path.join(f.working, "verification-child.mjs");
  const dependencies = protectedNativeDependenciesFixture(f.working);
  const orchestration = protectedOrchestrationFixture(dependencies);
  buildP03CompiledFixture({ entrypoint: driver, outfile: cli_entrypoint, orchestration });
  const config = {
    manifest_path: f.manifest_path,
    manifest_sha256: sha256(readFileSync(f.manifest_path)),
    node_executable,
    node_executable_sha256: sha256(readFileSync(node_executable)),
    cli_entrypoint,
    cli_entrypoint_sha256: sha256(readFileSync(cli_entrypoint)),
    deployment_roots: [f.root, path.dirname(node_executable)],
    external_dependency_root: dependencies,
    external_dependency_sha256: measureScaP03ProtectedDependencyRootV1(dependencies),
    timeout_ms: 10_000,
    max_output_bytes: 131_072,
  };
  return { config, counter, orchestration };
}

/** Explicit test-only authorization fixture. Real canonical owner, signatures, key ledger and
 * irreversible revocation; NOT formal AC-P03 issuance or live operator approval. */
export function samplerAuthorityFixture(
  root: string,
  overrides: Partial<ScaActivationScopeV1> = {}
) {
  const directory = path.join(root, `authority-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  const now = Date.now();
  const clock = () => now;
  const keys = ScaHostKeyInstallation.provision(
    path.join(directory, "keys"),
    "fixture-host",
    clock
  );
  owners.push(keys);
  keys.provisionKey();
  const placeholder = previewArtifactRef({
    metadata: {
      schema_version: 2,
      run_id: "fixture-qualification",
      phase: "SCA-P03",
      branch_id: null,
      kind: "fixture-prerequisite",
      operation_id: "prerequisite",
      version: 1,
      producer: "host:test-only",
      media_type: "application/json",
      parent_ref: null,
      upstream_refs: [],
    },
    content: "{}",
  });
  const scope: ScaActivationScopeV1 = {
    authority_id: `fixture-authority-${randomUUID()}`,
    nonce: `fixture-nonce-${randomUUID()}`,
    tenant_id: "fixture-tenant",
    project_id: "fixture-project",
    phase_id: "SCA-P03",
    production_playbook_name: "sca-p03",
    qualification_run_id: "fixture-qualification",
    activation_run_id: `fixture-activation-${randomUUID()}`,
    decision: "authorize_activation_admission",
    qualification_ref: placeholder,
    gate_ref: placeholder,
    implementation_identity_ref: placeholder,
    qualification_policy_data_sha256: sha256("fixture-policy"),
    registration_contract_sha256: sha256("fixture-contract"),
    runtime_registration_sha256: runtimeRegistrationSha256(SCA_P03_PHASE_REGISTRATION),
    host_implementation_binding_sha256: sha256("fixture-binding"),
    operator_principal_id: "fixture-operator",
    issuer_policy_id: "fixture-policy",
    proposed_start_sha256: sha256("fixture-start"),
    issued_at: new Date(now - 1000).toISOString(),
    not_before: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 300000).toISOString(),
    revocation_generation: 0,
    ...overrides,
  };
  const authorizeTestOnly = (scope: ScaActivationScopeV1) => {
    const record = sealScaActivationIssuanceV1({
      schema_id: "penny.sca-activation-issuance.v1",
      schema_version: 1,
      issuance_id: `fixture-issuance-${randomUUID()}`,
      authority_id: scope.authority_id,
      operator_principal_id: scope.operator_principal_id,
      issuer_policy_id: scope.issuer_policy_id,
      scope_sha256: sha256(canonicalJson(scope)),
      issued_at: scope.issued_at,
    });
    const ref = previewArtifactRef({
      metadata: {
        schema_version: 2,
        run_id: scope.activation_run_id,
        phase: "sca-activation-admission",
        branch_id: null,
        kind: "activation-issuance",
        operation_id: record.issuance_id,
        version: 1,
        producer: "host:test-only",
        media_type: "application/json",
        content_schema: { schema_id: record.schema_id, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(record),
    });
    const authority = sealScaActivationAuthorityV1({
      schema_id: "penny.sca-activation-authority.v1",
      schema_version: 1,
      scope,
      issuance_record_ref: ref,
    });
    const installation = { authority, record, ref };
    keys.signGrant(`fixture-grant-${randomUUID()}`, { ...installation, scope });
    return installation;
  };
  const installation = authorizeTestOnly(scope);
  const options = {
    directory: path.join(directory, "owner"),
    issuer_policy_id: scope.issuer_policy_id,
    operator_principal_id: scope.operator_principal_id,
    installation_authenticator_id: keys.authenticator_id,
    installation_authenticator: keys,
    max_admission_age_ms: 30000,
    revocation_generation: scope.revocation_generation,
    now: clock,
  };
  const owner = new SqliteScaActivationOwner(options);
  owners.push(owner);
  owner.install(installation);
  const view = {
    authority_id: scope.authority_id,
    authority_sha256: installation.authority.authority_sha256,
    issuance_sha256: installation.record.issuance_sha256,
    tenant_id: scope.tenant_id,
    project_id: scope.project_id,
    phase_id: scope.phase_id,
    production_playbook_name: scope.production_playbook_name,
    qualification_run_id: scope.qualification_run_id,
    activation_run_id: scope.activation_run_id,
    qualification_artifact_content_sha256: scope.qualification_ref.content_digest,
    gate_artifact_content_sha256: scope.gate_ref.content_digest,
    implementation_identity_artifact_content_sha256:
      scope.implementation_identity_ref.content_digest,
    qualification_policy_data_sha256: scope.qualification_policy_data_sha256,
    registration_contract_sha256: scope.registration_contract_sha256,
    runtime_registration_sha256: scope.runtime_registration_sha256,
    host_implementation_binding_sha256: scope.host_implementation_binding_sha256,
    proposed_start_sha256: scope.proposed_start_sha256,
    revocation_generation: scope.revocation_generation,
    checked_at: new Date(now).toISOString(),
    expires_at: scope.expires_at,
  };
  return {
    view,
    owner,
    installation,
    reopen: () => {
      owner.close();
      const reopened = new SqliteScaActivationOwner(options);
      owners.push(reopened);
      return { owner: reopened, installation };
    },
    successor: () => {
      // Same canonical owner/key ledger, but separate explicit test approval with fresh identifiers.
      // Never clear/reinstall the failed identity.
      const successor = authorizeTestOnly({
        ...scope,
        authority_id: `fixture-successor-${randomUUID()}`,
        nonce: `fixture-successor-nonce-${randomUUID()}`,
        activation_run_id: `fixture-successor-run-${randomUUID()}`,
      });
      const reopened = new SqliteScaActivationOwner(options);
      owners.push(reopened);
      reopened.install(successor);
      return { owner: reopened, installation: successor };
    },
  };
}

/** Copy the installed runtime only into disposable protected test deployment; no install/build. */
export function protectedNodeFixture(root: string): string {
  const node = path.join(root, "node");
  cpSync(realpathSync(process.execPath), node);
  chmodSync(node, 0o700);
  return node;
}

const RUN = "fixture-p02-qualification";
const REVISION = "fixture-current-p02";
function sorted(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((a, b) =>
    Buffer.compare(Buffer.from(a.artifact_id), Buffer.from(b.artifact_id))
  );
}
function persistInitialP02(
  store: ArtifactStore,
  operation: string,
  kind: string,
  producer: string,
  value: unknown,
  upstream: readonly ArtifactRef[] = [],
  schema?: string,
  schemaVersion = 1,
  phase = "SCA-P02",
  run_id = RUN
): ArtifactRef {
  const metadata: OutputArtifactMetadata = {
    schema_version: 2,
    run_id,
    phase,
    branch_id: null,
    kind,
    operation_id: operation,
    version: 1,
    parent_ref: null,
    producer,
    media_type: "application/json",
    ...(schema === undefined
      ? {}
      : { content_schema: { schema_id: schema, schema_version: schemaVersion } }),
    upstream_refs: sorted(upstream),
  };
  return store.persist({ metadata, content: canonicalJson(value) });
}
function descriptor(
  kind: string,
  schema: string,
  producer: string,
  version = 1
): ScaArtifactContractV1 {
  return {
    artifact_kind: kind,
    schema_id: schema,
    schema_version: version,
    producer,
    media_type: "application/json",
    max_bytes: 4 * 1_048_576,
  };
}
// Adapted from the existing P02 V3 guard fixture. Deterministic schema evidence only; NOT live observations.
export function initialP02QualificationFixture(options: {
  store: ArtifactStore;
  root: string;
  tenant_id: string;
  project_id: string;
  cohort: Omit<
    ScaP03PreLiveInputsV1["accepted_p02"],
    "qualification_definition_ref" | "qualification_gate_ref"
  >;
  summary_ref: ArtifactRef;
  host_binding_sha256: string;
  source_files: ScaP02ImplementationIdentityV1["source_files"];
}) {
  const RUN = options.summary_ref.run_id;
  const persist = (
    store: ArtifactStore,
    operation: string,
    kind: string,
    producer: string,
    value: unknown,
    upstream: readonly ArtifactRef[] = [],
    schema?: string,
    schemaVersion = 1,
    phase = "SCA-P02"
  ) =>
    persistInitialP02(
      store,
      operation,
      kind,
      producer,
      value,
      upstream,
      schema,
      schemaVersion,
      phase,
      RUN
    );
  const gaps: readonly string[] = [];
  const TENANT = options.tenant_id,
    PROJECT = options.project_id,
    HOST = options.host_binding_sha256;
  const TIME = [0, 1, 2, 3].map((i) => new Date(Date.now() + i).toISOString());
  const root = options.root;
  const store = options.store;
  const formal = persist(store, "review", "agent-output", "agent:vera", { review: "independent" });
  const reviewer = {
    authority: "penny:sca-p02-independent-review-authority",
    identity: "agent:vera",
    lineage: formal.artifact_id,
  };
  const identity = buildScaP02ImplementationIdentityV1({
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    implementation_revision: REVISION,
    host_binding_sha256: HOST,
    implementer_identity_id: "p02-implementer",
    implementer_lineage_id: "p02-implementer-lineage",
    source_files: options.source_files,
  });
  const identityRef = persist(
    store,
    "identity",
    SCA_P02_QUALIFICATION_ARTIFACTS.identity.artifact_kind,
    SCA_P02_QUALIFICATION_ARTIFACTS.identity.producer,
    identity,
    [],
    identity.schema_id
  );
  const operationalCohort = options.cohort;
  const operational = operationalCohort.gate_ref,
    transition = operationalCohort.transition_ref;
  const summary = options.summary_ref;
  const inputs = sorted([summary, formal]);
  const definitions = SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
    criterion_id,
    ref: persist(
      store,
      `criterion-${criterion_id}`,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.producer,
      buildScaP02CriterionDefinitionV1({
        tenant_id: TENANT,
        project_id: PROJECT,
        run_id: RUN,
        implementation_revision: REVISION,
        criterion_id,
      }),
      [identityRef, ...inputs],
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.schema_id
    ),
  }));
  const requiredDefinition = (index: number) => {
    const found = definitions[index];
    if (found === undefined) throw new Error("P02 fixture definition missing");
    return found.ref;
  };
  const definitionRefs = {
    "p02-containment-egress-and-minimization": requiredDefinition(0),
    "p02-current-predecessor-and-implementation": requiredDefinition(1),
    "p02-required-variants-and-lifecycle": requiredDefinition(2),
    "p02-six-operation-deterministic-coverage": requiredDefinition(3),
  };
  const contracts = {
    implementation_identity: descriptor(
      SCA_P02_QUALIFICATION_ARTIFACTS.identity.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.identity.schema_id,
      SCA_P02_QUALIFICATION_ARTIFACTS.identity.producer
    ),
    criterion_definition: descriptor(
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.schema_id,
      SCA_P02_QUALIFICATION_ARTIFACTS.definition.producer
    ),
    criterion_evidence: descriptor(
      SCA_P02_QUALIFICATION_ARTIFACTS.evidence.artifact_kind,
      SCA_P02_QUALIFICATION_ARTIFACTS.evidence.schema_id,
      SCA_P02_QUALIFICATION_ARTIFACTS.evidence.producer
    ),
    reviewer_authority: descriptor(
      "sca-p02-phase-reviewer-authority",
      SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
      "host:sca-p02-qualification-review-authority"
    ),
    reviewer_receipt: descriptor(
      "sca-p02-phase-review-receipt",
      SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
      "host:sca-p02-qualification-review-authority"
    ),
    qualification: descriptor(
      "sca-p02-phase-qualification-v3",
      SCA_PHASE_QUALIFICATION_RECORD_V3_SCHEMA,
      SCA_P02_V3_AUTHORITY,
      3
    ),
    gate: descriptor(
      SCA_P02_V3_GATE_KIND,
      SCA_PHASE_GATE_RECORD_V3_SCHEMA,
      SCA_P02_V3_AUTHORITY,
      3
    ),
  };
  const binding = (ref: ArtifactRef) => {
    const metadata = store.metadata(ref);
    return { ref, parent_ref: metadata.parent_ref, upstream_refs: [...metadata.upstream_refs] };
  };
  const definition = createScaP02QualificationDefinitionV1({
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    implementation_revision: REVISION,
    current_host_binding_sha256: HOST,
    current_source_manifest_sha256: identity.source_manifest_sha256,
    max_unique_artifact_bytes: 16 * 1_048_576,
    max_json_artifact_bytes: 4 * 1_048_576,
    reviewer_authority_id: reviewer.authority,
    reviewer_identity_id: reviewer.identity,
    reviewer_lineage_id: reviewer.lineage,
    implementation_identity: binding(identityRef),
    qualified_inputs: inputs.map(binding),
    criterion_definition_refs: definitionRefs,
    reviewer_authority_contract: contracts.reviewer_authority,
    reviewer_receipt_contract: contracts.reviewer_receipt,
    qualification_record_contract: contracts.qualification,
    gate_record_contract: contracts.gate,
  });
  const subject = inspectScaQualificationSubjectV1({ store, definition });
  const evidence = SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
    criterion_id,
    evidence_refs: [
      persist(
        store,
        `evidence-${criterion_id}`,
        contracts.criterion_evidence.artifact_kind,
        contracts.criterion_evidence.producer,
        buildScaP02QualificationEvidenceV1({
          tenant_id: TENANT,
          project_id: PROJECT,
          run_id: RUN,
          implementation_revision: REVISION,
          host_binding_sha256: HOST,
          implementer_identity_id: "p02-implementer",
          implementer_lineage_id: "p02-implementer-lineage",
          criterion_id,
          subject_sha256: subject.subject_sha256,
          supporting_refs: inputs,
          observations: SCA_P02_QUALIFICATION_CHECKS[criterion_id].map((check_id) => ({
            check_id,
            observed: true,
          })),
        }),
        [identityRef, ...inputs, definitionRefs[criterion_id]],
        contracts.criterion_evidence.schema_id
      ),
    ],
  }));
  const evidenceRefs = sorted(evidence.flatMap((item) => item.evidence_refs));
  const subjectRefs = [identityRef, ...inputs, ...definitions.map((item) => item.ref)];
  const reviewFields = {
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    phase_id: "SCA-P02",
    implementation_revision: REVISION,
    implementation_assurance_scope: "host_derived_binding" as const,
    reviewer_identity_id: reviewer.identity,
    reviewer_lineage_id: reviewer.lineage,
    subject_sha256: subject.subject_sha256,
    evidence_refs: evidenceRefs,
  };
  const authority = persist(
    store,
    "authority",
    contracts.reviewer_authority.artifact_kind,
    contracts.reviewer_authority.producer,
    sealScaPhaseReviewerAuthorityV1({
      schema_id: SCA_PHASE_REVIEWER_AUTHORITY_V1_SCHEMA,
      schema_version: 1,
      authority_id: reviewer.authority,
      ...reviewFields,
      decision: "authorized",
      issued_at: TIME[0],
    }),
    [...subjectRefs, ...evidenceRefs],
    contracts.reviewer_authority.schema_id
  );
  const receipt = persist(
    store,
    "receipt",
    contracts.reviewer_receipt.artifact_kind,
    contracts.reviewer_receipt.producer,
    sealScaPhaseReviewReceiptV1({
      schema_id: SCA_PHASE_REVIEW_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      receipt_id: "p02-review-receipt",
      ...reviewFields,
      reviewer_authority_ref: authority,
      criterion_results: SCA_P02_QUALIFICATION_CRITERION_IDS.map((criterion_id) => ({
        criterion_id,
        status: "PASS" as const,
      })),
      decision: "PASS",
      reviewed_at: TIME[1],
    }),
    [...subjectRefs, ...evidenceRefs, authority],
    contracts.reviewer_receipt.schema_id
  );
  const qualification = evaluateScaPhaseQualificationV3({
    store,
    definition,
    criterion_evidence: evidence,
    reviewer_authority_ref: authority,
    reviewer_receipt_ref: receipt,
    remaining_gaps: gaps,
    recorded_at: TIME[2],
  });
  const qualificationRef = persist(
    store,
    "qualification",
    contracts.qualification.artifact_kind,
    contracts.qualification.producer,
    qualification,
    [...subjectRefs, ...evidenceRefs, authority, receipt],
    contracts.qualification.schema_id,
    3
  );
  const gate = evaluateScaPhaseGateV3({
    store,
    definition,
    qualification_ref: qualificationRef,
    evaluated_at: TIME[3],
  });
  const gateRef = persist(
    store,
    "gate",
    contracts.gate.artifact_kind,
    contracts.gate.producer,
    gate,
    [qualificationRef],
    contracts.gate.schema_id,
    3
  );
  const unsigned = {
    schema_id: SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA,
    schema_version: 1 as const,
    tenant_id: TENANT,
    project_id: PROJECT,
    run_id: RUN,
    phase_id: "SCA-P02" as const,
    implementation_revision: REVISION,
    required_assurance_scope: "host_derived_binding" as const,
    current_host_binding_sha256: HOST,
    current_source_manifest_sha256: identity.source_manifest_sha256,
    max_unique_artifact_bytes: 16 * 1_048_576,
    max_json_artifact_bytes: 4 * 1_048_576,
    reviewer_authority_id: reviewer.authority,
    reviewer_identity_id: reviewer.identity,
    reviewer_lineage_id: reviewer.lineage,
    source_policy_module: "apps/orchestration/src/sca/p02-qualification.ts" as const,
    criterion_ids: [...SCA_P02_QUALIFICATION_CRITERION_IDS],
    contracts,
    implementation_identity: binding(identityRef),
    qualified_inputs: inputs.map(binding),
    criterion_definition_refs: definitionRefs,
    reviewer_authority_ref: authority,
    reviewer_receipt_ref: receipt,
    formal_review_ref: formal,
    qualification_ref: qualificationRef,
    gate_ref: gateRef,
    subject_sha256: subject.subject_sha256,
    activation_performed: false as const,
    registration_performed: false as const,
    p03_admission_performed: false as const,
  };
  const snapshot = { ...unsigned, definition_snapshot_sha256: sha256(canonicalJson(unsigned)) };
  const provenance = [gateRef, qualificationRef, authority, receipt, formal];
  const snapshotRef = persist(
    store,
    "snapshot",
    SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
    SCA_P02_V3_AUTHORITY,
    snapshot,
    provenance,
    SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA
  );
  const check = (
    ref = snapshotRef,
    gate_ref = gateRef,
    accepted_p02_refs: readonly ArtifactRef[] = [operational, transition]
  ) =>
    requireScaP03AcceptedP02Qualification({
      store,
      definition_ref: ref,
      gate_ref,
      tenant_id: TENANT,
      project_id: PROJECT,
      accepted_p02_refs,
    });
  const altered = (change: (value: typeof unsigned) => unknown) => {
    const value = change(unsigned);
    const payload =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== "definition_snapshot_sha256")
          )
        : { invalid: value };
    const newRef = persist(
      store,
      `snapshot-${sha256(canonicalJson(payload)).slice(0, 10)}`,
      SCA_P02_V3_DEFINITION_SNAPSHOT_KIND,
      SCA_P02_V3_AUTHORITY,
      { ...payload, definition_snapshot_sha256: sha256(canonicalJson(payload)) },
      provenance,
      SCA_P02_V3_DEFINITION_SNAPSHOT_SCHEMA
    );
    return () => check(newRef);
  };
  return {
    root,
    store,
    snapshot,
    snapshotRef,
    gateRef,
    qualificationRef,
    authority,
    receipt,
    formal,
    operational,
    transition,
    operationalCohort,
    check,
    altered,
  };
}

export function protectedNativeDependenciesFixture(working: string, runtimeOnly = false) {
  const dependencies = path.join(working, "node_modules");
  mkdirSync(dependencies, { mode: 0o700 });
  const require = createRequire(import.meta.url);
  for (const name of [
    "tree-sitter",
    "tree-sitter-javascript",
    "tree-sitter-php",
    "tree-sitter-typescript",
    "node-gyp-build",
    "node-addon-api",
  ]) {
    const source = name.startsWith("node-")
      ? realpathSync(
          path.join(
            path.dirname(realpathSync(require.resolve("tree-sitter/package.json"))),
            "..",
            name
          )
        )
      : path.dirname(realpathSync(require.resolve(`${name}/package.json`)));
    cpSync(source, path.join(dependencies, name), {
      recursive: true,
      dereference: true,
      ...(runtimeOnly
        ? {
            filter: (file: string) => {
              const relative = path.relative(source, file);
              if (
                relative.startsWith("prebuilds/") &&
                !relative.startsWith(`prebuilds/${process.platform}-${process.arch}`)
              )
                return false;
              return lstatSync(file).isDirectory() || /\.(?:js|json|node)$/.test(file);
            },
          }
        : {}),
    });
  }
  const protect = (dir: string) => {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (lstatSync(file).isDirectory()) protect(file);
      else chmodSync(file, lstatSync(file).mode & 0o700);
    }
  };
  protect(dependencies);
  return dependencies;
}
