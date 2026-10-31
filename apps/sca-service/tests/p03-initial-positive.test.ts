/** One complete native initial-path test. Transport observations, the human UI and authority
 * time are deterministic fixtures; scheduling timers and the parent watchdog remain real.
 * The protected Node child creates its own disposable UI signing realm; the parent's master key
 * is never exported. FD 3 names the fixture-only native roots. */
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { ScaP03WorkspaceRegistryV1 } from "../src/p03-bootstrap-workspaces.js";
import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { mock } from "node:test";
import fs, {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { Type } from "typebox";
import { performance } from "node:perf_hooks";
import { syncBuiltinESMExports } from "node:module";
import { ArtifactStore } from "../../orchestration/dist/artifact-store.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  ArtifactRefSchema,
  validateContract,
  validateDirective,
  type ArtifactRef,
} from "../../orchestration/dist/contracts.js";
import { createScaP03NativeOperatorHostV1 } from "../../../.pi/extensions/sca/src/native-operator.js";
import { hostOperationPolicyBinding } from "../../orchestration/dist/host-operations/contracts.js";
import { HostOperationLeaseAuthority } from "../../orchestration/dist/host-operations/lease-authority.js";
import { OrchestrationService } from "../../orchestration/dist/service.js";
import { initializePennyState } from "../../orchestration/dist/state/setup.js";
import * as p02 from "../../orchestration/dist/sca/p02-contracts.js";
import {
  validateScaCampaignManifestCoreV1,
  validateScaObligationLedgerV2,
} from "../../orchestration/dist/sca/p01-contracts.js";
import {
  measureScaP02CurrentHostBinding,
  createScaP02ActivationHostV1,
} from "../../orchestration/dist/sca/p02-activation-host.js";
import { SCA_P02_IMPLEMENTATION_SOURCE_PATHS } from "../../orchestration/dist/sca/p02-qualification.js";
import { createScaP03BootstrapHostAuthorityV1 } from "../src/p03-bootstrap-host.js";
import { createScaP03LocalHostProbeV1 } from "../src/p03-bootstrap-local-probe.js";
import { ScaP03NativeVerificationInvocationV1 } from "../src/p03-bootstrap-verification.js";
import { createScaP03ProductionHostCompositionV1 } from "../src/p03-production-runtime.js";
import { SCA_P03_CANDIDATE_REGISTRATION } from "../../orchestration/dist/sca/p03-playbook.js";
import { scaP03InputArtifacts } from "../../orchestration/dist/sca/p03-admission.js";
import {
  validateScaP03OperationRequestV1,
  validateScaP03OperationResultV1,
  validateScaP03HostIsolationAttestationV1,
  validateScaP03IsolationEvidenceV1,
  scaP03P01BindingSha256,
  scaP03P02BindingSha256,
  scaP03RuntimeBindingSha256,
  validateScaP03RequestV2,
  withScaP03Digest,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  SCA_P03_IMPLEMENTATION_SOURCE_PATHS,
  scaP03SourceManifestSha256,
} from "../../orchestration/dist/sca/p03-qualification.js";
import { createScaP02QualificationDefinitionFromSnapshot } from "../../orchestration/dist/sca/p03-p02-qualification-guard.js";
import { SqliteScaActivationOwner } from "../../orchestration/dist/sca/activation-owner.js";
import { ScaHostKeyInstallation } from "../../orchestration/dist/sca/activation-host-key.js";
import { SqliteScaPhaseActivationRegistry } from "../../orchestration/dist/sca/phase-activation.js";
import { SCA_P02_PHASE_REGISTRATION } from "../../orchestration/dist/sca/p02-playbook.js";
import {
  runtimeRegistrationSha256,
  skillContractSha256,
} from "../../orchestration/dist/playbooks/registry.js";
import {
  sealScaActivationAuthorityV1,
  sealScaActivationIssuanceV1,
  type ScaActivationScopeV1,
} from "../../orchestration/dist/sca/qualification-activation-contracts.js";
import {
  scaQualificationPolicyDataSha256,
  scaProposedStartSha256,
} from "../../orchestration/dist/sca/qualification-activation.js";
import {
  ScaP03InitialAuthorizationV1,
  ScaP03InitialProposalBindingV1,
  readScaP03InitialProposalV1,
  validateScaP03InitialProposalV1,
  type ScaP03InitialResourcesV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import {
  createScaP03InitialQualificationRegistrationV1,
  readScaP03InitialGate,
  ScaP03InitialTransportV1Schema,
} from "../../orchestration/dist/sca/p03-initial-qualification.js";
import {
  registerTrustedQuestionnaireTransport,
  verifyExecutionOwnerSignature,
} from "../../../.pi/extensions/skill/execution-receipts.js";
import { respondToTrustedNativeGateV1 } from "../../../.pi/extensions/skill/trusted-gate-driver.js";
import questionnaire from "../../../.pi/extensions/questionnaire/index.js";
import {
  createExtensionApiHarness,
  requireQuestionnaireTool,
  requireQuestionnaireToolResult,
} from "../../../.pi/extensions/questionnaire/tests/helpers.js";
import {
  ScaP03NativeCapsuleV1Schema,
  ScaP03InitialNativeHostV1,
  ScaP03InitialProgramMeasurementsV1,
  scaP03InitialFileMetadataV1,
} from "../src/p03-initial-host.js";
import {
  createScaP03InitialLiveAdapterV1,
  createScaP03InitialUseValidatorV1,
  ScaP03PreLiveInputsV1Schema,
  ScaP03InitialEvidenceV1Schema,
  ScaP03SealedBootstrapInputsV1Schema,
  ScaP03SealedBootstrapEvidenceV1Schema,
} from "../src/p03-initial-live.js";
import { loadScaP03PredecessorInputsV1 } from "../src/p03-predecessor-inputs.js";
import {
  ScaP01JoernRuntimeClosureV1Schema,
  scaP01JoernImageClosureV1,
} from "../src/p01-joern-root.js";
import {
  ScaP03CliProductionFreezeHandoffSchema,
  ScaP03CliProductionSealedHandoffSchema,
  parseScaP03CliCanonical,
} from "../src/p03-bootstrap-cli-contracts.js";
import { measureScaP03ProtectedDependencyRootV1 } from "../src/p03-production-sampler.js";
import { assertScaP03ClosedDockerArgvV1 } from "../src/p03-live-transport.js";
import {
  productionSamplerFixture,
  disposeSamplerFixtures,
  initialP02QualificationFixture,
  protectedNodeFixture,
  protectedNativeDependenciesFixture,
} from "./p03-production-sampler-fixture.js";
import { readScaP03ConsumedFixtureEvidenceV1 } from "../src/p03-consumed-fixture-evidence.js";
import { runScaP03InitialLiveCohortV1 } from "../src/p03-initial-cohort.js";
import { assertP03FixtureReadOnlyV1 } from "./p03-consumed-fixture-integration.js";
import { pinnedInventory } from "./p03-test-oracle.js";
import { createP03ProtectedTempFixture } from "./p03-protected-temp-fixture.js";
import {
  buildP03CompiledFixture,
  protectedOrchestrationFixture,
} from "./p03-compiled-orchestration-fixture.js";
import {
  collectP03PositiveFixture,
  P03_POSITIVE_MILESTONE_PREFIX,
  P03_POSITIVE_STREAM_OUTPUT_LIMIT_BYTES,
  P03PositiveMilestoneSchema,
  type P03PositiveMilestone,
} from "./p03-positive-watchdog.js";

/** Only the disposable native fixture controls Date. Real timers, monotonic costs,
 * inactivity, cancellation and cleanup continue to run on elapsed wall time. */
function controlFixtureDate() {
  const now = Date.now();
  mock.timers.enable({ apis: ["Date"], now });
  return { now, [Symbol.dispose]: () => mock.timers.reset() };
}

const fixtureAbort = new AbortController();
let fixtureTerminated = false;
const reportMilestone = (() => {
  let sequence = 0;
  return (
    stage: P03PositiveMilestone["stage"],
    command: number | null = null,
    output: string | null = null
  ) => {
    const bytes = output === null ? null : Buffer.from(output, "utf8");
    const milestone = validateContract(
      P03PositiveMilestoneSchema,
      {
        schema_id: "penny.p03-positive-milestone.v1",
        sequence: ++sequence,
        stage,
        command,
        output_sha256: bytes === null ? null : sha256(bytes),
        byte_length: bytes?.byteLength ?? null,
      },
      "completed native fixture work"
    );
    process.stderr.write(`${P03_POSITIVE_MILESTONE_PREFIX}${canonicalJson(milestone)}\n`);
  };
})();

const resources: ScaP03InitialResourcesV1 = {
  cpus: 2,
  memory_bytes: 1_073_741_824,
  pids: 64,
  tmp_bytes: 8_388_608,
  work_bytes: 58_720_256,
  command_output_bytes: 1_048_576,
  concurrency: 1,
  inactivity_ms: 60_000,
  cleanup_grace_ms: 5000,
  max_commands: 512,
  max_source_bytes: 1_048_576,
  max_source_files: 3,
  max_graph_bytes: 1024,
  max_query_bytes: 524_288,
  max_query_items: 256,
  max_page_items: 64,
  max_pages_per_query: 4,
  max_ast_depth: 256,
  max_ast_nodes: 4096,
  max_num_def: 1000,
  jvm_heap_bytes: 536_870_912,
  max_host_workspace_bytes: 4_194_304,
  max_evidence_bytes: 8_388_608,
};
const imageRef = `fixture/joern@sha256:${sha256("image manifest")}`;
const imageId = `sha256:${sha256("image configuration")}`;
const fixtureScopeSchema = Type.Object(
  {
    scope: Type.Literal("disposable-p03-initial-contract-fixture"),
    root: Type.String(),
    source_root: Type.String(),
    oracle_root: Type.String(),
    entrypoint: Type.String(),
    dependency_root: Type.String(),
    invocation: Type.Integer({ minimum: 0, maximum: 5 }),
    scenario: Type.Union([
      Type.Literal("success"),
      Type.Literal("large"),
      Type.Literal("wrapper_scope"),
      Type.Literal("wrapper_blocked"),
      Type.Literal("wrapper_owner_binding"),
      Type.Literal("bootstrap"),
      Type.Literal("factory_bootstrap"),
      Type.Literal("factory_fixture"),
      Type.Literal("expire"),
      Type.Literal("revoke"),
      Type.Literal("cancel"),
      Type.Literal("lost"),
      Type.Literal("omit"),
      Type.Literal("terminate"),
      Type.Literal("source_drift"),
    ]),
  },
  { additionalProperties: false }
);

function rootClosure() {
  const version = "4.0.627";
  const image = scaP01JoernImageClosureV1(
    {
      Id: imageId,
      RepoDigests: [imageRef],
      Config: { Env: [], Volumes: null },
      RootFS: { Type: "layers", Layers: [`sha256:${sha256("layer")}`] },
      Os: "linux",
      Architecture: "amd64",
      Variant: null,
    },
    imageRef
  );
  return validateContract(
    ScaP01JoernRuntimeClosureV1Schema,
    {
      schema_id: "penny.sca-p01-joern-runtime-closure.v1",
      schema_version: 1,
      representation: "docker-local-runtime-closure",
      image_ref: imageRef,
      image,
      image_closure_sha256: sha256(canonicalJson(image)),
      docker_executable_sha256: sha256("fixture docker executable"),
      docker_client_version: "1.0.0",
      docker_server_version: "1.0.0",
      package_root_sha256: sha256("packages"),
      joern_version: version,
      packages: ["joern-cli", "php2cpg", "php2cpg-launcher", "jssrc2cpg", "jssrc2cpg-launcher"].map(
        (part) => ({
          component: part.replace("-launcher", ""),
          filename: `io.joern.${part.replace("-launcher", "")}-${version}${part.endsWith("-launcher") ? "-launcher" : ""}.jar`,
          path_sha256: sha256(part),
          content_sha256: sha256(`bytes:${part}`),
        })
      ),
      launcher: {
        path_sha256: sha256("launcher-path"),
        content_sha256: sha256("launcher"),
        help_sha256: sha256("help"),
        help_bytes: 32,
      },
      init: { path_sha256: sha256("init-path"), content_sha256: sha256("init") },
      confinement: {
        network: "none",
        readonly_rootfs: true,
        privileged: false,
        cap_drop: "ALL",
        no_new_privileges: true,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
        memory_bytes: resources.memory_bytes,
        cpus: 2,
        pids: 64,
        tmpfs_bytes: 67_108_864,
        inactivity_ms: 60_000,
        max_command_output_bytes: 1_048_576,
      },
      cleanup: "verified-absent",
    },
    "deterministic original P01 binary root"
  );
}

async function driver(scope: ReturnType<typeof validateScope>) {
  const factoryOnly =
    scope.scenario === "factory_bootstrap" || scope.scenario === "factory_fixture";
  const sealedPurpose = scope.scenario === "bootstrap" || scope.scenario === "factory_bootstrap";
  const costs = new Map<string, { calls: number; elapsed_ms: number }>();
  const measure = (stage: string, validate: () => void) => {
    const start = performance.now();
    try {
      validate();
    } finally {
      const cost = costs.get(stage) ?? { calls: 0, elapsed_ms: 0 };
      cost.calls++;
      cost.elapsed_ms += performance.now() - start;
      costs.set(stage, cost);
    }
  };
  class MeasuredNativeHost extends ScaP03InitialNativeHostV1 {
    override assertCapsule(proposal: Parameters<ScaP03InitialNativeHostV1["assertCapsule"]>[0]) {
      measure("deployment", () => super.assertCapsule(proposal));
    }
    override assertCurrentP02(...args: Parameters<ScaP03InitialNativeHostV1["assertCurrentP02"]>) {
      measure("current_p02", () => super.assertCurrentP02(...args));
    }
    override assertPredecessorClosure(
      ...args: Parameters<ScaP03InitialNativeHostV1["assertPredecessorClosure"]>
    ) {
      measure("predecessor", () => super.assertPredecessorClosure(...args));
    }
  }
  const projectRoot = scope.source_root; // explicit native fixture root, never proposal-selected
  const stateRoot = path.join(scope.root, "state");
  const state = initializePennyState(projectRoot, { env: { PENNY_STATE_ROOT: stateRoot } });
  // Existing builder provides exact original P01/pre-live native oracle preimages. Its post-run
  // bootstrap fixture is NOT in the initial proposal and is never read by the collector.
  const f = await productionSamplerFixture(false, {
    root: path.join(scope.root, `cohort-${scope.invocation}`),
    run_id: `fixture-p03-initial-${scope.invocation}`,
    storeRoot: state.paths.artifacts.root,
    project_id: state.projectId,
    oracleRoot: scope.oracle_root,
    rootClosure: rootClosure(),
    initial_resources: resources,
    campaign_source: sealedPurpose,
    large_opaque_rules: scope.scenario === "large",
  });
  reportMilestone("preimages_validated");
  using store = ArtifactStore.openExisting(f.storeRoot, { projectId: f.project_id });
  const handoff = parseScaP03CliCanonical(
    ScaP03CliProductionFreezeHandoffSchema,
    readFileSync(f.freezePath)
  );
  const p01 = handoff.production_bindings.roots;
  const persist = (
    run: string,
    phase: string,
    kind: string,
    schema: string,
    value: unknown,
    upstream: readonly ArtifactRef[] = [],
    producer = "host:sca-p02-candidate",
    operation = kind
  ) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id: run,
        phase,
        branch_id: null,
        kind,
        operation_id: operation,
        version: 1,
        producer,
        media_type: "application/json",
        content_schema: { schema_id: schema, schema_version: Number(schema.slice(-1)) },
        parent_ref: null,
        upstream_refs: [...new Map(upstream.map((r) => [r.artifact_id, r])).values()].sort((a, b) =>
          a.artifact_id.localeCompare(b.artifact_id)
        ),
      },
      content: canonicalJson(value),
    });
  const run = p01.accepted_p01.request_ref.run_id,
    time = new Date().toISOString();
  const p = (
    kind: string,
    schema: string,
    value: unknown,
    upstream: readonly ArtifactRef[] = [],
    producer?: string,
    operation?: string
  ) => persist(run, "sca-p02-candidate", kind, schema, value, upstream, producer, operation);
  const profiles = {
    inventory: sha256("inventory"),
    semgrep_php: sha256("semgrep_php"),
    semgrep_js_ts: sha256("semgrep_js_ts"),
    gitleaks: sha256("gitleaks"),
    osv_composer: sha256("osv_composer"),
    osv_npm: sha256("osv_npm"),
  };
  const isolation = {
    isolation_id: "fixture-p02-isolation",
    runtime_id: "fixture-p02-runtime",
    implementation_identity_sha256: sha256("p02-implementation"),
    deployment_identity_sha256: sha256("p02-deployment"),
    profile_id: "fixture-p02-profile",
    profile_sha256: p02.scaP02AggregateProfileSha256(profiles),
    operation_profiles: profiles,
    qualification_scope: "live_qualified",
    runtime_kind: "host_qualified",
    qualified: true,
  };
  const attestation = p02.validateScaP02HostIsolationAttestationV1({
    schema_id: p02.SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
    schema_version: 1,
    attestation_id: "fixture-p02-attestation",
    ...isolation,
    attested_at: time,
  });
  const attRef = p(
    p02.SCA_P02_HOST_ATTESTATION_KIND,
    attestation.schema_id,
    attestation,
    [],
    p02.SCA_P02_ISOLATION_EVIDENCE_PRODUCER
  );
  const iso = p02.validateScaP02IsolationEvidenceV1({
    schema_id: p02.SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
    schema_version: 1,
    producer_id: p02.SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
    ...isolation,
    evidence_kind: "host_qualification_attestation",
    qualified_at: time,
    host_attestation_id: attestation.attestation_id,
    host_attestation_sha256: attRef.content_digest,
    host_attestation_ref: attRef,
  });
  const isoRef = p(
    "sca-p02-isolation-evidence",
    iso.schema_id,
    iso,
    [attRef],
    p02.SCA_P02_ISOLATION_EVIDENCE_PRODUCER
  );
  const policy = p02.validateScaP02RuntimePolicyV1({
    schema_id: p02.SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
    schema_version: 1,
    policy_id: "fixture-p02-policy",
    staging_parent: f.working,
    isolation_evidence_ref: isoRef,
    executables: ["semgrep", "gitleaks"].map((tool_id) => ({
      tool_id,
      executable_path: f.file(`p02-${tool_id}`, "fixture executable", 0o700),
      executable_sha256: f.manifest.config.expected_docker_executable_sha256,
      version: "1",
    })),
    operation_tools: { semgrep_tool_id: "semgrep", gitleaks_tool_id: "gitleaks" },
    semgrep_max_output_bytes: 1024,
    gitleaks_max_output_bytes: 1024,
    process_timeout_ms: 1000,
    internal_component_identities: {
      source_census_sha256: p02.SCA_P02_SOURCE_CENSUS_IDENTITY_SHA256,
      tree_sitter_sha256: sha256("tree"),
    },
    tree_sitter: {
      parse_timeout_micros: 1000,
      max_file_bytes: 1024,
      max_total_bytes: 2048,
      max_files: 10,
      max_nodes_per_file: 100,
      max_depth: 10,
      max_diagnostics_per_file: 10,
      max_symbols_per_file: 100,
      query_match_limit: 100,
    },
    gitleaks_configuration_rule_id: "fixture-rule",
    osv: {
      transport_id: "fixture-none",
      max_batch_size: 128,
      max_concurrency: 2,
      timeout_ms: 1000,
      max_response_bytes: 1024,
      max_advisory_requests: 10,
      freshness_max_age_seconds: 60,
    },
  });
  const policyRef = p(
    "sca-p02-runtime-policy",
    policy.schema_id,
    policy,
    [isoRef],
    p02.SCA_P02_RUNTIME_POLICY_PRODUCER
  );
  const request = p02.validateScaP02RequestV1({
    schema_id: "penny.sca-p02-request.v1",
    schema_version: 1,
    tenant_id: "test-tenant",
    project_id: f.project_id,
    run_id: run,
    accepted_p01: p01.accepted_p01,
    runtime_policy_ref: policyRef,
    isolation_evidence_ref: isoRef,
    isolation_host_attestation_ref: attRef,
    requested_at: time,
  });
  const { scaP02InputArtifacts } = await import("../../orchestration/dist/sca/p02-admission.js");
  const requestRef = p(
    "sca-p02-candidate-request",
    request.schema_id,
    request,
    scaP02InputArtifacts(request).artifacts.map((a) => a.ref)
  );
  const kinds = [
    "inventory",
    "semgrep_php",
    "semgrep_js_ts",
    "gitleaks",
    "osv_composer",
    "osv_npm",
  ] as const;
  const ops = kinds.map((operation_kind) => {
    const suffix = operation_kind.replaceAll("_", "-");
    return {
      operation_kind,
      operation_request_ref: p(`sca-p02-${suffix}-request`, `penny.sca-p02-${suffix}-request.v1`, {
        fixture: operation_kind,
      }),
      operation_result_ref: p(`sca-p02-${suffix}-result`, `penny.sca-p02-${suffix}-result.v1`, {
        fixture: operation_kind,
      }),
      normalized_evidence_ref: p(
        "sca-p02-persisted-evidence",
        p02.SCA_P02_PERSISTED_EVIDENCE_V1_SCHEMA,
        { fixture: operation_kind },
        [],
        undefined,
        `sca-p02-evidence-${suffix}`
      ),
      operation_receipt_ref: p(
        "host-operation-receipt",
        "penny.host-operation-receipt.v1",
        { fixture: operation_kind },
        [],
        "host:host-operation-owner",
        `receipt-${suffix}`
      ),
      status: "complete",
      raw_evidence_ids: [`p02e_${sha256(operation_kind)}`],
      raw_record_ids: [`p02raw_${sha256(operation_kind)}`],
    };
  });
  const operationFor = (id: string) =>
    ops.find(
      (op) =>
        op.operation_kind ===
        (id.startsWith("source-") || id.startsWith("tree-") || id.startsWith("dependency-")
          ? "inventory"
          : id.replaceAll("-", "_"))
    ) ??
    (() => {
      throw new Error(`analyzer absent ${id}`);
    })();
  const coverage = p02.validateScaP02CoverageMatrixV1(
    p02.withScaP02Digest(
      {
        schema_id: p02.SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
        schema_version: 1,
        run_id: run,
        p01_binding_sha256: p02.scaP02P01BindingSha256(request),
        entries: p02.SCA_P02_ANALYZER_IDS.map((analyzer_id) => ({
          analyzer_id,
          operation_kind: operationFor(analyzer_id).operation_kind,
          applicability: "applicable",
          status: "complete",
          fresh: true,
          blocker_codes: [],
          operation_result_ref: operationFor(analyzer_id).operation_result_ref,
          normalized_evidence_ref: operationFor(analyzer_id).normalized_evidence_ref,
        })),
      },
      "coverage_sha256"
    )
  );
  const coverageRef = p("sca-p02-coverage-matrix", coverage.schema_id, coverage);
  const pair = (ks: readonly string[]) =>
    ops
      .filter((o) => ks.includes(o.operation_kind))
      .flatMap((o) => [o.operation_result_ref, o.normalized_evidence_ref]);
  const all = pair(kinds),
    normalized = ops.map((o) => o.normalized_evidence_ref);
  const evidenceByObligation = [
    [p01.accepted_p01.p01_gate_ref, p01.accepted_p01.campaign_manifest_ref],
    pair(["inventory"]),
    pair(["inventory"]),
    pair(["semgrep_php", "semgrep_js_ts"]),
    pair(["gitleaks"]),
    pair(["inventory"]),
    pair(["osv_composer", "osv_npm"]),
    normalized,
    [coverageRef, ...all],
    [coverageRef, ...normalized],
  ];
  const ledger = validateScaObligationLedgerV2(
    JSON.parse(store.read(p01.accepted_p01.obligation_ledger_ref).toString())
  );
  const successor = p02.validateScaP02SuccessorLedgerV1(
    p02.withScaP02Digest(
      {
        schema_id: p02.SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA,
        schema_version: 1,
        run_id: run,
        prior_p01_ledger_ref: p01.accepted_p01.obligation_ledger_ref,
        prior_p01_ledger_sha256: ledger.ledger_sha256,
        prior_entry_count: ledger.entries.length,
        prior_event_count: ledger.events.length,
        prior_entries: ledger.entries,
        prior_events: ledger.events,
        p01_campaign_manifest_ref: p01.accepted_p01.campaign_manifest_ref,
        dispositions: p02.SCA_P02_DISPOSITION_OBLIGATION_IDS.map((obligation_id, i) => ({
          obligation_id,
          status: "satisfied",
          evidence_refs: evidenceByObligation[i],
        })),
        pending_phase_ids: Array.from(
          { length: 10 },
          (_, i) => `SCA-P${String(i + 3).padStart(2, "0")}`
        ),
        append_only: true,
        campaign_completion_claimed: false,
        release_eligible: false,
        recorded_at: time,
      },
      "ledger_sha256"
    )
  );
  const successorRef = p("sca-p02-successor-obligation-ledger", successor.schema_id, successor);
  const authorityRefs = {
    p02_request_ref: requestRef,
    runtime_policy_ref: policyRef,
    isolation_evidence_ref: isoRef,
    isolation_host_attestation_ref: attRef,
  };
  const lineage = {
    p01_request_ref: p01.accepted_p01.request_ref,
    p01_campaign_manifest_core_ref: p01.accepted_p01.campaign_manifest_core_ref,
    p01_campaign_manifest_ref: p01.accepted_p01.campaign_manifest_ref,
  };
  const boundaries = { coverage_matrix_ref: coverageRef, successor_ledger_ref: successorRef };
  const manifest = p02.validateScaP02EvidenceManifestV1(
    p02.withScaP02Digest(
      {
        schema_id: p02.SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA,
        schema_version: 1,
        run_id: run,
        ...authorityRefs,
        ...lineage,
        ...boundaries,
        p01_predecessor_ledger_ref: p01.accepted_p01.obligation_ledger_ref,
        operations: ops,
        analyzers: coverage.entries.map((entry) => ({
          ...entry,
          fetched_at: null,
          max_age_seconds: null,
          expires_at: null,
          unsupported: false,
          truncated: false,
          raw_evidence_ids: operationFor(entry.analyzer_id).raw_evidence_ids,
          raw_record_ids: operationFor(entry.analyzer_id).raw_record_ids,
        })),
        symbol_evidence_refs: [normalized[0]],
        dependency_evidence_refs: [normalized[0]],
        osv_evidence: ["osv-composer", "osv-npm"].map((analyzer_id) => ({
          analyzer_id,
          operation_result_ref: operationFor(analyzer_id).operation_result_ref,
          batch_evidence_ids: operationFor(analyzer_id).raw_evidence_ids,
          coordinate_ids: [],
          occurrence_ids: [],
          fetched_at: null,
          max_age_seconds: null,
          expires_at: null,
        })),
      },
      "manifest_sha256"
    )
  );
  const manifestRef = p("sca-p02-evidence-manifest", manifest.schema_id, manifest, [attRef]);
  const gate = p02.validateScaP02GateV1(
    p02.withScaP02Digest(
      {
        schema_id: p02.SCA_P02_GATE_V1_SCHEMA,
        schema_version: 1,
        run_id: run,
        ...authorityRefs,
        ...boundaries,
        evidence_manifest_ref: manifestRef,
        isolation_scope: "live_qualified",
        status: "passed",
        blocker_codes: [],
        evaluated_at: time,
      },
      "gate_sha256"
    )
  );
  const gateRef = p("sca-p02-gate", gate.schema_id, gate, [attRef]);
  const m1 = p02.validateScaM1RecordV2(
    p02.withScaP02Digest(
      {
        schema_id: p02.SCA_M1_RECORD_V2_SCHEMA,
        schema_version: 2,
        run_id: run,
        phase_id: "SCA-P02",
        ...authorityRefs,
        ...boundaries,
        evidence_manifest_ref: manifestRef,
        gate_ref: gateRef,
        status: "passed",
        nonterminal: true,
        release_eligible: false,
        campaign_terminal: false,
        model_calls: 0,
        model_turns: 0,
        blocker_codes: [],
        transition_authorized: true,
        recorded_at: time,
      },
      "record_sha256"
    )
  );
  const m1Ref = p("sca-m1-record", m1.schema_id, m1, [attRef]);
  const transition = p02.validateScaP02P03TransitionV1(
    p02.withScaP02Digest(
      {
        schema_id: p02.SCA_P02_P03_TRANSITION_V1_SCHEMA,
        schema_version: 1,
        run_id: run,
        from_phase_id: "SCA-P02",
        to_phase_id: "SCA-P03",
        ...authorityRefs,
        ...lineage,
        ...boundaries,
        evidence_manifest_ref: manifestRef,
        p02_gate_ref: gateRef,
        m1_ref: m1Ref,
        consumed_as_of: time,
        qualification_claimed: false,
        campaign_terminal: false,
        release_eligible: false,
      },
      "transition_sha256"
    )
  );
  const transitionRef = p("sca-p02-p03-transition", transition.schema_id, transition, [
    requestRef,
    policyRef,
    isoRef,
    attRef,
    gateRef,
    coverageRef,
    successorRef,
    manifestRef,
    m1Ref,
    ...Object.values(lineage),
  ]);
  const cohort = {
    transition_ref: transitionRef,
    p02_request_ref: requestRef,
    gate_ref: gateRef,
    m1_ref: m1Ref,
    coverage_matrix_ref: coverageRef,
    evidence_manifest_ref: manifestRef,
    successor_ledger_ref: successorRef,
    evidence_refs: [
      policyRef,
      isoRef,
      attRef,
      ...ops.flatMap((o) => [
        o.operation_request_ref,
        o.operation_result_ref,
        o.normalized_evidence_ref,
        o.operation_receipt_ref,
      ]),
    ],
  };
  const summaryRef = persist(
    `fixture-p02-qualification-${scope.invocation}`,
    "SCA-P02",
    "sca-p02-operational-qualification-input",
    "penny.sca-p02-formal-collector-summary.v1",
    {
      schema_id: "penny.sca-p02-formal-collector-summary.v1",
      schema_version: 1,
      tenant_id: "test-tenant",
      project_id: f.project_id,
      run_id: `fixture-p02-qualification-${scope.invocation}`,
      status: "candidate_boundary_passed",
      aggregate_profile_sha256: isolation.profile_sha256,
      deployment: {
        combined: { path: scope.entrypoint, sha256: sha256(readFileSync(scope.entrypoint)) },
      },
      authority_refs: {
        runtime_policy_ref: policyRef,
        isolation_evidence_ref: isoRef,
        host_attestation_ref: attRef,
      },
      gate_ref: gateRef,
    },
    Object.values(cohort).flatMap((v) => (Array.isArray(v) ? v : [v])),
    "host:sca-p02-qualification-custodian"
  );
  const current = measureScaP02CurrentHostBinding({
    project_root: projectRoot,
    store,
    operational_summary_ref: summaryRef,
  });
  reportMilestone("current_p02_binding");
  const formal = initialP02QualificationFixture({
    store,
    root: scope.root,
    tenant_id: "test-tenant",
    project_id: f.project_id,
    cohort,
    summary_ref: summaryRef,
    host_binding_sha256: current.host_binding_sha256,
    source_files: SCA_P02_IMPLEMENTATION_SOURCE_PATHS.map((relative) => {
      const bytes = readFileSync(path.join(projectRoot, relative));
      return { path: relative, sha256: sha256(bytes), byte_length: bytes.byteLength };
    }),
  });
  assert.equal(formal.snapshot.current_source_manifest_sha256, current.source_manifest_sha256);
  const definition = createScaP02QualificationDefinitionFromSnapshot(formal.check());
  reportMilestone("qualification_validated");
  using keys = ScaHostKeyInstallation.provision(
    path.join(scope.root, `keys-${scope.invocation}`),
    "fixture-host",
    () => Date.now()
  );
  keys.provisionKey();
  const start = {
    tenant_id: "test-tenant",
    project_id: f.project_id,
    phase_id: "SCA-P02",
    production_playbook_name: "sca-p02",
    qualification_run_id: formal.snapshot.run_id,
    activation_run_id: `fixture-current-activation-${scope.invocation}`,
    qualification_ref: formal.qualificationRef,
    gate_ref: formal.gateRef,
  };
  const issued = new Date().toISOString();
  const activationScope: ScaActivationScopeV1 = {
    ...start,
    authority_id: "fixture-current-authority",
    nonce: "fixture-fresh-current-nonce",
    decision: "authorize_activation_admission",
    implementation_identity_ref: definition.implementation_identity.ref,
    qualification_policy_data_sha256: scaQualificationPolicyDataSha256(definition),
    registration_contract_sha256: skillContractSha256(SCA_P02_PHASE_REGISTRATION.contract),
    runtime_registration_sha256: runtimeRegistrationSha256(SCA_P02_PHASE_REGISTRATION),
    host_implementation_binding_sha256: current.host_binding_sha256,
    operator_principal_id: "fixture-operator",
    issuer_policy_id: "fixture-issuer",
    proposed_start_sha256: scaProposedStartSha256(start),
    issued_at: issued,
    not_before: issued,
    expires_at: new Date(Date.parse(issued) + 600_000).toISOString(),
    revocation_generation: 1,
  };
  const upstream = [
    start.gate_ref,
    start.qualification_ref,
    activationScope.implementation_identity_ref,
  ];
  const issuance = sealScaActivationIssuanceV1({
    schema_id: "penny.sca-activation-issuance.v1",
    schema_version: 1,
    issuance_id: "fixture-fresh-issuance",
    authority_id: activationScope.authority_id,
    operator_principal_id: activationScope.operator_principal_id,
    issuer_policy_id: activationScope.issuer_policy_id,
    scope_sha256: sha256(canonicalJson(activationScope)),
    issued_at: issued,
  });
  const issuanceRef = persist(
    start.activation_run_id,
    "sca-activation-admission",
    "sca-activation-issuance",
    issuance.schema_id,
    issuance,
    upstream,
    "host:fixture-issuer"
  );
  const authority = sealScaActivationAuthorityV1({
    schema_id: "penny.sca-activation-authority.v1",
    schema_version: 1,
    scope: activationScope,
    issuance_record_ref: issuanceRef,
  });
  const authorityRef = persist(
    start.activation_run_id,
    "sca-activation-admission",
    "sca-activation-authority",
    authority.schema_id,
    authority,
    [...upstream, issuanceRef],
    "host:fixture-issuer"
  );
  const installation = { authority, record: issuance, ref: issuanceRef };
  keys.signGrant("fixture-grant", { ...installation, scope: activationScope });
  using owner = new SqliteScaActivationOwner({
    directory: path.join(scope.root, `activation-${scope.invocation}`),
    issuer_policy_id: "fixture-issuer",
    operator_principal_id: "fixture-operator",
    installation_authenticator_id: keys.authenticator_id,
    installation_authenticator: keys,
    max_admission_age_ms: 30_000,
    revocation_generation: 1,
    now: () => Date.now(),
  });
  owner.install(installation);
  using registry = new SqliteScaPhaseActivationRegistry({
    directory: path.join(scope.root, `phase-${scope.invocation}`),
  });
  const contract = (kind: string, schema_id: string) => ({
    artifact_kind: kind,
    schema_id,
    schema_version: 1,
    producer: "host:fixture-issuer",
    media_type: "application/json",
    max_bytes: 1_048_576,
  });
  const p02Host = {
    project_root: projectRoot,
    partition_project_id: f.project_id,
    tenant_id: "test-tenant",
    project_id: f.project_id,
    definition_ref: formal.snapshotRef,
    gate_ref: formal.gateRef,
    operational_summary_ref: summaryRef,
    issuer_policy_id: "fixture-issuer",
    issuance_contract: contract("sca-activation-issuance", issuance.schema_id),
    authority_contract: contract("sca-activation-authority", authority.schema_id),
    revocation_generation: 1,
  };
  const proposed = {
    ...start,
    authority_ref: authorityRef,
    proposed_start_sha256: activationScope.proposed_start_sha256,
  };
  const host = createScaP02ActivationHostV1({ ...p02Host, store, owner });
  registry.activate({ host, proposed, owner });
  assert.equal(registry.resolve({ host, proposed }).name, "sca-p02");
  reportMilestone("activation_resolved");
  // Freeze only after ordered predecessor evidence and fresh activation have been issued.
  // Native replay may exceed credential validity on a busy host; authority time is explicit,
  // while real scheduling timers and every original ten-minute expiry remain unchanged.
  using clock = controlFixtureDate();
  if (factoryOnly || scope.scenario === "large") {
    // Exercise the REAL issuer-owner and admission clocks, not just the initial profile.
    // Restoring fixture time is not renewal: the original ten-minute scope is unchanged.
    const now = Date.now();
    const expires = Date.parse(activationScope.expires_at);
    const verification = { ...installation, scope: activationScope, policy_id: "fixture-issuer" };
    assert.equal(expires - Date.parse(issued), 600_000);
    try {
      mock.timers.setTime(expires - 1);
      assert.equal(keys.authenticate(verification), true);
      assert.equal(owner.verifyIssuance(verification), true);
      mock.timers.setTime(expires);
      assert.equal(keys.authenticate(verification), false);
      assert.equal(owner.verifyIssuance(verification), false);
      assert.throws(() => registry.resolve({ host, proposed }), /authority_denied/);
    } finally {
      mock.timers.setTime(now);
    }
    assert.equal(owner.verifyIssuance(verification), true);
    assert.equal(registry.resolve({ host, proposed }).name, "sca-p02");
  }
  const replay = loadScaP03PredecessorInputsV1({
    schema_id: "penny.sca-p03-predecessor-inputs.v1",
    schema_version: 1,
    store_root: store.root,
    tenant_id: "test-tenant",
    project_id: f.project_id,
    request_ref: requestRef,
    transition_ref: transitionRef,
    definition_ref: formal.snapshotRef,
    gate_ref: formal.gateRef,
    qualification_ref: formal.qualificationRef,
    historical_authority_ref: authorityRef,
    historical_issuance_ref: issuanceRef,
    issuance_producer: "host:fixture-issuer",
    authority_producer: "host:fixture-issuer",
    root_tool_id: "joern",
    limits: {
      max_refs: 512,
      max_artifact_bytes: 64 * 1_048_576,
      max_json_bytes: 4 * 1_048_576,
      max_total_bytes: 256 * 1_048_576,
    },
  });
  assert.equal(replay.status, "ready", canonicalJson(replay));
  if (replay.status !== "ready") throw new Error("complete closure unavailable");
  if (scope.scenario === "large") {
    const large = replay.value.closure.refs.filter((ref) => ref.byte_length > 16_777_216);
    assert.deepEqual(
      large.map((ref) => ref.byte_length).sort((a, b) => a - b),
      [21_958_840, 35_162_428]
    );
    for (const ref of large)
      assert.ok(
        p01.accepted_p01.frozen_refs.some((frozen) => frozen.artifact_id === ref.artifact_id)
      );
    // This complete real closure fails the former loader limit, not just a padded proposal.
    assert.ok(replay.value.closure.total_bytes > 57_121_268);
  }
  reportMilestone("predecessor_replayed");
  const socket = path.join(scope.root, `fixture-${scope.scenario}.sock`),
    server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  chmodSync(socket, 0o600);
  try {
    const program = (file: string) => ({ path: file, sha256: sha256(readFileSync(file)) });
    const config = {
      ...f.manifest.config,
      memory_bytes: resources.memory_bytes,
      cpus: resources.cpus,
      pids: resources.pids,
      max_workspace_bytes: resources.work_bytes,
      max_command_output_bytes: resources.command_output_bytes,
      max_num_def: resources.max_num_def,
      timeout_ms: resources.inactivity_ms,
    };
    const capsule = validateContract(
      ScaP03NativeCapsuleV1Schema,
      {
        schema_id: sealedPurpose
          ? "penny.sca-p03-sealed-bootstrap-capsule.v1"
          : "penny.sca-p03-pre-live-capsule.v1",
        ...(sealedPurpose
          ? { verification: { manifest_path: f.manifest_path, manifest_sha256: f.manifest_sha256 } }
          : {}),
        schema_version: 1,
        create_store: false,
        project_root: projectRoot,
        state_root: stateRoot,
        store_root: store.root,
        evidence_destination: f.working,
        source_manifest_sha256: scaP03SourceManifestSha256(
          SCA_P03_IMPLEMENTATION_SOURCE_PATHS.map((relative) => {
            const bytes = readFileSync(path.join(projectRoot, relative));
            return { path: relative, sha256: sha256(bytes), byte_length: bytes.byteLength };
          })
        ),
        config,
        docker_socket: socket,
        node: program(process.execPath),
        entrypoint: program(scope.entrypoint),
        module_files: [program(scope.entrypoint)],
        deployment_roots: [scope.root],
        dependency_root: scope.dependency_root,
        dependency_sha256: measureScaP03ProtectedDependencyRootV1(scope.dependency_root),
        toolchain_version_commands: {
          php_frontend: [
            "find",
            "/opt/joern",
            "-type",
            "f",
            "-name",
            "io.joern.php2cpg-*.jar",
            "-printf",
            "%f\\n",
          ],
          javascript_frontend: [
            "find",
            "/opt/joern",
            "-type",
            "f",
            "-name",
            "io.joern.jssrc2cpg-*.jar",
            "-printf",
            "%f\\n",
          ],
          jvm: ["java", "--version"],
          php_runtime: ["php", "--version"],
          helper: ["python3", "--version"],
        },
      },
      "protected native pre-live capsule"
    );
    const capsulePath = f.file("initial-capsule.json", canonicalJson(capsule));
    const backend = sha256(`fixture physical backend slot:${scope.scenario}`);
    const nativeHostInput = {
      capsule_path: capsulePath,
      capsule_sha256: sha256(readFileSync(capsulePath)),
      approved_state_root: stateRoot,
      approved_backend_resource_sha256: backend,
      store,
      p02_owner: owner,
      p02_registry: registry,
      p02_host: p02Host,
    };
    const nativeHost = new MeasuredNativeHost(nativeHostInput);
    // This canonical source is deliberately absent from module_files: the deployed driver
    // is bundled. Its independent source commitment must still detect drift/reconstruction.
    const omittedSource = path.join(projectRoot, "apps/sca-service/src/p03-docker-runtime.ts");
    assert.ok(
      SCA_P03_IMPLEMENTATION_SOURCE_PATHS.includes("apps/sca-service/src/p03-docker-runtime.ts")
    );
    assert.ok(!capsule.module_files.some((file) => file.path === omittedSource));
    const originalSource = readFileSync(omittedSource);
    const mutateSource = () =>
      writeFileSync(
        omittedSource,
        Buffer.concat([originalSource, Buffer.from("\n// source drift fixture\n")])
      );
    // Preserve the original runtime-source regression and also prove that the new
    // reader cannot be adopted by reconstructing a host from an old approved capsule.
    for (const file of [
      omittedSource,
      path.join(projectRoot, "apps/sca-service/src/p03-consumed-fixture-evidence.ts"),
    ]) {
      assert.ok(!capsule.module_files.some((mapping) => mapping.path === file));
      const original = readFileSync(file);
      writeFileSync(file, Buffer.concat([original, Buffer.from("\n// source drift fixture\n")]));
      try {
        assert.throws(
          () => new MeasuredNativeHost(nativeHostInput),
          /p03_initial_source_manifest_drift/
        );
      } finally {
        writeFileSync(file, original);
      }
    }
    reportMilestone("protected_deployment_validated");
    let revoked = false,
      offset = 0;
    const mode =
      scope.scenario === "omit" ||
      scope.scenario === "terminate" ||
      scope.scenario === "large" ||
      scope.scenario === "wrapper_scope" ||
      scope.scenario === "wrapper_blocked" ||
      scope.scenario === "wrapper_owner_binding"
        ? "success"
        : scope.scenario;
    const activeAbort = fixtureAbort;
    let effects = 0,
      commands = 0,
      name = "",
      created: readonly string[] = [],
      running = false,
      fixturePath = "",
      inventories = 0;
    const fences = new Set<string>();
    let bootstrapApprovalValidated = false;
    let adapterFailure: unknown;
    let ownerContext:
      | import("../../orchestration/dist/host-operations/contracts.js").HostOperationExecutionContextV1
      | undefined;
    let ordinaryService: OrchestrationService | undefined;
    let initialService: OrchestrationService | undefined;
    const deterministicTransport: import("../src/p03-docker-runtime.js").DockerRunnerV1 = async (
      command
    ) => {
      commands++;
      assert.ok(ownerContext);
      const activeService = ordinaryService ?? initialService;
      assert.ok(activeService);
      const journal = activeService.checkpointer
        .hostOperationCallsForRun(ownerContext.directive.identity.run_id)
        .find((record) => record.operation_id === ownerContext?.directive.operation_id);
      assert.ok(journal);
      assert.ok(["submitting", "submitted"].includes(journal.lifecycle));
      assert.ok(journal.lease);
      const global = leaseInspector.inspect(backend);
      assert.equal(global.state, "active");
      if (global.state !== "active") throw new Error("canonical global guard missing");
      assert.equal(global.active.phase, "remote_accepted");
      assert.equal(canonicalJson(global.active.lease), canonicalJson(journal.lease));
      fences.add(journal.lease.lease_id);
      const argv = command.argv;
      assertScaP03ClosedDockerArgvV1(argv, imageRef);
      assert.ok(command.output_bytes <= 1_048_576);
      assert.equal(command.timeout_ms, 60_000);
      if (argv[0] === "version")
        return canonicalJson({ Client: { Version: "1.0.0" }, Server: { Version: "1.0.0" } });
      if (argv[0] === "image")
        return canonicalJson({
          Id: imageId,
          RepoDigests: [imageRef],
          Config: {
            Volumes: null,
            Labels: { "org.opencontainers.image.version": "fixture-pinned" },
          },
        });
      if (argv[1] === "create") {
        effects++;
        created = argv;
        name = argv[argv.indexOf("--name") + 1] ?? "";
        running = false;
        assert.equal(argv[argv.indexOf("--pids-limit") + 1], "64");
        if (mode === "lost") throw new Error("p03_live_lost_create_response");
        return "e".repeat(64);
      }
      if (argv[1] === "inspect")
        return canonicalJson({
          Id: "e".repeat(64),
          Image: imageId,
          Name: `/${name}`,
          State: { Status: running ? "running" : "created", Running: running },
          Mounts: created
            .flatMap((v, i) => (v === "--mount" ? [created[i + 1] ?? ""] : []))
            .map((m) => {
              const parts = m.split(",");
              return {
                Type: "bind",
                Source: parts.find((s) => s.startsWith("src="))?.slice(4),
                Destination: parts.find((s) => s.startsWith("dst="))?.slice(4),
                RW: false,
              };
            }),
          Config: {
            User: `${process.getuid?.()}:${process.getgid?.()}`,
            WorkingDir: "/tmp",
            Env: ["HOME=/tmp", `JAVA_TOOL_OPTIONS=-Xmx${resources.jvm_heap_bytes}`],
            Entrypoint: ["sleep"],
            Cmd: ["infinity"],
            Labels: {
              "org.opencontainers.image.version": "fixture-pinned",
              ...Object.fromEntries(
                created
                  .flatMap((v, i) => (v === "--label" ? [created[i + 1] ?? ""] : []))
                  .map((v) => {
                    const i = v.indexOf("=");
                    return [v.slice(0, i), v.slice(i + 1)] as const;
                  })
              ),
            },
          },
          HostConfig: {
            NetworkMode: "none",
            PidMode: "",
            IpcMode: "",
            UTSMode: "",
            ReadonlyRootfs: true,
            Init: true,
            Privileged: false,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
            PidsLimit: 64,
            Memory: resources.memory_bytes,
            MemorySwap: resources.memory_bytes,
            NanoCpus: 2_000_000_000,
            LogConfig: { Type: "none" },
            Tmpfs: Object.fromEntries(
              created
                .flatMap((v, i) => (v === "--tmpfs" ? [created[i + 1] ?? ""] : []))
                .map((v) => {
                  const i = v.indexOf(":");
                  return [v.slice(0, i), v.slice(i + 1)];
                })
            ),
          },
        });
      if (argv[1] === "start") {
        running = true;
        return "";
      }
      if (argv[1] === "rm") {
        if (mode === "lost") throw new Error("p03_live_cleanup_uncertain");
        name = "";
        return "";
      }
      if (argv[1] === "ls") return name === "" ? "" : "e".repeat(64);
      if (argv[1] !== "exec") throw new Error("unexpected transport command");
      if (mode === "expire") offset = 700_000;
      if (mode === "revoke") revoked = true;
      if (mode === "source_drift") mutateSource();
      if (mode === "cancel") activeAbort.abort(new Error("fixture cancel mid-command"));
      if (argv[3] === "find") {
        const part = (argv[argv.indexOf("-name") + 1] ?? "").slice(
          "io.joern.".length,
          -"-*.jar".length
        );
        return `io.joern.${part}-4.0.627.jar\n${part === "joern-cli" ? "" : `io.joern.${part}-4.0.627-launcher.jar\n`}`;
      }
      if (argv[3] === "which") return "/opt/joern/joern-cli/joern\n";
      if (argv[4] === "--help") return "Usage: joern [options] [<cpg.bin>]\n";
      if (argv[4] === "--version") return `${argv[3]} 17.0.0\n`;
      if (argv[3] === "joern-parse") {
        const mount = created.find((v) => v.endsWith("dst=/source,readonly"));
        if (mount === undefined) throw new Error("source mount absent");
        const src = mount
          .split(",")
          .find((v) => v.startsWith("src="))
          ?.slice(4);
        if (src === undefined) throw new Error("source path absent");
        const { readdirSync } = await import("node:fs");
        fixturePath = `src/${readdirSync(path.join(src, "src"))[0]}`;
        return "";
      }
      if (argv[3] === "joern") return "";
      if (argv[3] === "python3" && argv[5] === "graph.cpg.bin")
        return Buffer.from("bounded deterministic graph preimage").toString("base64");
      if (argv[3] === "python3" && argv[5] === "inventory.tsv") {
        inventories++;
        const enc = (v: string) => Buffer.from(v).toString("base64");
        const inventory = `META\t${enc(fixturePath.endsWith(".php") ? "PHP" : "JSSRC")}\n${await pinnedInventory(fixturePath, enc, scope.scenario === "wrapper_blocked" ? "wrong-handler" : undefined, scope.oracle_root)}`;
        assert.ok(Buffer.byteLength(inventory) < resources.max_query_bytes);
        return Buffer.from(inventory).toString("base64");
      }
      throw new Error("unexpected bounded probe");
    };
    let completedCommands = 0;
    const compose = (binding: ScaP03InitialProposalBindingV1) => {
      const authorization = new ScaP03InitialAuthorizationV1(
        {
          current: () => ({
            principal_id: "fixture-operator",
            policy_id: "fixture-initial-only",
            installation_id: "fixture-host",
            project_id: f.project_id,
            state_authority_sha256: sha256(stateRoot),
            backend_resource_sha256: backend,
            revocation_generation: 1,
            revoked,
            permitted_effects: sealedPurpose
              ? ["bootstrap_verification"]
              : ["fixture_qualification"],
          }),
          now: () => new Date(Date.now() + offset),
          authenticatedInteractivePrincipal: () => "fixture-operator",
          assertCurrentInputs: (proposal) => nativeHost.assertCapsule(proposal),
        },
        { verify: verifyExecutionOwnerSignature },
        binding
      );
      const registration = createScaP03InitialQualificationRegistrationV1({
        authorization,
        binding,
      });
      const adapter = createScaP03InitialLiveAdapterV1({
        store,
        authorization,
        native_host: nativeHost,
        binding,
        deterministic_test_transport: async (command) => {
          const text = await deterministicTransport(command);
          // The transport has checked the actual canonical journal/global fenced lease and
          // closed argv. Only a completed, bounded observation renews the harness, including
          // narrowly owned cleanup commands; never a periodic timer or an attempted command.
          assert.ok(Buffer.byteLength(text) <= command.output_bytes);
          reportMilestone("command_completed", ++completedCommands, text);
          return text;
        },
      });
      const service = new OrchestrationService({
        projectRoot,
        env: { PENNY_STATE_ROOT: stateRoot },
        playbookRegistration: registration,
        enableChildWorkflows: false,
        modelClient: {
          async runAgent() {
            throw new Error("model must not be called");
          },
        },
        hostOperationAdapters: new Map([
          [
            adapter.adapter_id,
            {
              ...adapter,
              async run(context) {
                try {
                  ownerContext = context;
                  initialService = service;
                  if (sealedPurpose) {
                    // Genuine native approval admits the purpose-specific preimage, before effects.
                    const approved = readScaP03InitialProposalV1(context.request_bytes);
                    const binding = readScaP03InitialGate(
                      store,
                      context.readInput("initial_proposal").ref,
                      context.readInput("initial_transport").ref
                    );
                    authorization.assertEffect(context, approved, binding);
                    assert.equal(approved.effect, "bootstrap_verification");
                    assert.equal(context.journal.lifecycle, "lease_acquired");
                    assert.ok(context.journal.lease);
                    bootstrapApprovalValidated = true;
                  }
                  if (scope.scenario === "omit")
                    throw new Error("collector deliberately omitted; effects=0 commands=0");
                  return await adapter.run(context);
                } catch (error) {
                  adapterFailure = error;
                  process.stderr.write(
                    `collector failure: ${String(error)} effects=${effects} commands=${commands}\n`
                  );
                  throw error;
                }
              },
            },
          ],
        ]),
        hostOperationUseValidator: createScaP03InitialUseValidatorV1({
          store,
          authorization,
          binding,
          native_host: nativeHost,
        }),
      });
      return { service, authorization, registration, binding };
    };
    using leaseInspector = new HostOperationLeaseAuthority(stateRoot);
    const results: {
      result_ref: ArtifactRef;
      receipt_ref: ArtifactRef;
      evidence: ReturnType<typeof readEvidence>;
    }[] = [];
    const catalog = lstatSync(path.join(stateRoot, "catalog.db"));
    const stateAuthority = factoryOnly
      ? sha256(
          canonicalJson({
            state_root: stateRoot,
            catalog_dev: catalog.dev,
            catalog_ino: catalog.ino,
          })
        )
      : sha256(stateRoot);
    const ordinal = scope.invocation;
    {
      const runId = sealedPurpose ? `operator-${f.run_id}` : f.run_id;
      const b = handoff.bindings;
      const manifest = validateContract(
        ScaP03PreLiveInputsV1Schema,
        {
          schema_id: "penny.sca-p03-pre-live-inputs.v1",
          schema_version: 1,
          run_id: runId,
          tenant_id: "test-tenant",
          project_id: f.project_id,
          ...p01,
          accepted_p02: {
            ...cohort,
            qualification_definition_ref: formal.snapshotRef,
            qualification_gate_ref: formal.gateRef,
          },
          p02_authority_ref: authorityRef,
          p02_issuance_ref: issuanceRef,
          p02_proposed_start: proposed,
          fixture_corpus_ref: b.fixture_corpus_ref,
          fixture_content_refs: b.fixture_content_refs,
          source_oracle_ref: b.source_oracle_ref,
          source_oracle_review_ref: b.source_oracle_review_ref,
          source_oracle_validation_ref: b.source_oracle_validation_ref,
          qualification_profile_ref: b.qualification_profile_ref,
          baseline_query_set_ref: b.baseline_query_set_ref,
          query_script_refs: b.query_script_refs,
          query_plan_refs: b.query_plan_refs,
          deployment_sha256: nativeHost.deploymentSha256(),
          configuration_sha256: sha256(readFileSync(capsulePath)),
          evidence_destination_sha256: sha256(f.working),
          resource_policy_sha256: sha256(canonicalJson(resources)),
        },
        "native initial manifest"
      );
      const initial = (
        kind: string,
        schema: string,
        value: unknown,
        refs: readonly ArtifactRef[] = []
      ) =>
        persist(runId, "SCA-P03", kind, schema, value, refs, "host:sca-p03-initial-authorization");
      const sealed = parseScaP03CliCanonical(
        ScaP03CliProductionSealedHandoffSchema,
        readFileSync(f.sealedPath)
      );
      const sealedInputs = validateContract(
        ScaP03SealedBootstrapInputsV1Schema,
        {
          schema_id: "penny.sca-p03-sealed-bootstrap-inputs.v1",
          schema_version: 1,
          run_id: runId,
          tenant_id: manifest.tenant_id,
          project_id: manifest.project_id,
          accepted_p01: manifest.accepted_p01,
          accepted_p02: manifest.accepted_p02,
          p02_authority_ref: manifest.p02_authority_ref,
          p02_issuance_ref: manifest.p02_issuance_ref,
          p02_proposed_start: manifest.p02_proposed_start,
          root_tool_id: manifest.root_tool_id,
          toolchain_ref: manifest.toolchain_ref,
          root_executable_ref: manifest.root_executable_ref,
          root_measurement_ref: manifest.root_measurement_ref,
          deployment_sha256: manifest.deployment_sha256,
          configuration_sha256: manifest.configuration_sha256,
          evidence_destination_sha256: manifest.evidence_destination_sha256,
          resource_policy_sha256: manifest.resource_policy_sha256,
          manifest_sha256: f.manifest_sha256,
          source_manifest_sha256: nativeHost.sourceManifestSha256(),
          sealed_handoff_sha256: f.manifest.sealed_handoff_sha256,
          production_record_ref: sealed.production_record_ref,
          record_ref: sealed.record_ref,
          binding_ref: sealed.binding_ref,
          review_ref: sealed.review_ref,
          attestation_ref: sealed.host_attestation_ref,
        },
        "native sealed inputs"
      );
      const manifestRef = sealedPurpose
        ? initial("sca-p03-sealed-bootstrap-inputs", sealedInputs.schema_id, sealedInputs)
        : initial("sca-p03-pre-live-inputs", manifest.schema_id, manifest);
      const preliveRefs = [
        b.fixture_corpus_ref,
        ...b.fixture_content_refs,
        b.source_oracle_ref,
        b.source_oracle_review_ref,
        b.source_oracle_validation_ref,
        b.qualification_profile_ref,
        b.baseline_query_set_ref,
        ...b.query_script_refs,
        ...b.query_plan_refs,
      ];
      const proofRefs = [
        ...new Map(
          [
            manifestRef,
            ...preliveRefs,
            ...replay.value.closure.refs,
            ...(sealedPurpose
              ? [
                  b.runtime_policy_ref,
                  b.runtime_identity_ref,
                  b.implementation_identity_ref,
                  ...b.implementation_source_refs,
                  ...b.runtime_package_refs,
                  sealed.production_record_ref,
                  sealed.record_ref,
                  sealed.binding_ref,
                  sealed.review_ref,
                  sealed.host_attestation_ref,
                  sealed.attempt_ref,
                  sealed.cleanup_ref,
                  sealed.isolation_ref,
                  sealed.external_review_ref,
                  sealed.receipt_ref,
                ]
              : []),
          ].map((r) => [r.artifact_id, r])
        ).values(),
      ].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
      for (const ref of sealedPurpose ? [] : proofRefs)
        assert.ok(
          ![
            "sca-p03-runtime-identity",
            "sca-p03-bootstrap-record",
            "sca-p03-bootstrap-attestation",
          ].includes(ref.kind)
        );
      const now = new Date().toISOString();
      const proposal = validateScaP03InitialProposalV1({
        schema_id: "penny.sca-p03-initial-proposal.v1",
        schema_version: 1,
        run_id: runId,
        invocation_nonce: `fresh-nonce-${ordinal}`,
        approval_id: `fixture-approval-${ordinal}`,
        project_id: f.project_id,
        principal_id: "fixture-operator",
        policy_id: "fixture-initial-only",
        installation_id: "fixture-host",
        revocation_generation: 1,
        state_authority_sha256: stateAuthority,
        backend_resource_sha256: backend,
        deployment_sha256: manifest.deployment_sha256,
        configuration_sha256: manifest.configuration_sha256,
        evidence_destination_sha256: manifest.evidence_destination_sha256,
        fixture_cohort_sha256: manifest.fixture_corpus_ref.content_digest,
        issued_at: now,
        not_before: now,
        expires_at: new Date(Date.parse(now) + 600_000).toISOString(),
        effect: sealedPurpose ? "bootstrap_verification" : "fixture_qualification",
        ...(sealedPurpose ? { sealed_bootstrap_inputs_ref: manifestRef } : {}),
        resources,
        input_refs: proofRefs,
      });
      const proposalRef = initial(
        "sca-p03-initial-proposal",
        proposal.schema_id,
        proposal,
        proofRefs
      );
      const pin = new ScaP03InitialProposalBindingV1(store, proposalRef);
      const composition = compose(pin);
      using service = composition.service;
      const { authorization, registration } = composition;
      if (factoryOnly) {
        // The actual native factory and purpose-specific helpers run against protected
        // disposable inputs. No host/auth/store/validator double or approval is supplied.
        using factory = await createScaP03NativeOperatorHostV1({
          ...nativeHostInput,
          project_root: projectRoot,
          env: { PENNY_STATE_ROOT: stateRoot },
          proposal_ref: proposalRef,
          profile: {
            current: () => ({
              principal_id: proposal.principal_id,
              policy_id: proposal.policy_id,
              installation_id: proposal.installation_id,
              project_id: f.project_id,
              state_authority_sha256: stateAuthority,
              backend_resource_sha256: backend,
              revocation_generation: 1,
              revoked,
              permitted_effects: [proposal.effect],
            }),
            now: () => new Date(Date.now() + offset),
            authenticatedInteractivePrincipal: () => undefined,
            assertCurrentInputs: (currentProposal) => nativeHost.assertCapsule(currentProposal),
          },
        });
        factory.authorization.assertProposal(proposal);
        revoked = true;
        assert.throws(
          () => factory.authorization.assertProposal(proposal),
          /p03_initial_authority_denied/
        );
        revoked = false;
        assert.equal(Date.parse(proposal.expires_at) - Date.parse(proposal.issued_at), 600_000);
        offset = 599_999;
        factory.authorization.assertProposal(proposal);
        offset = 600_000;
        assert.throws(
          () => factory.authorization.assertProposal(proposal),
          /p03_initial_authority_denied/
        );
        offset = 700_000;
        assert.throws(
          () => factory.authorization.assertProposal(proposal),
          /p03_initial_authority_denied/
        );
        offset = 0;
        const withManifest = (ref: ArtifactRef) =>
          validateScaP03InitialProposalV1({
            ...proposal,
            ...(sealedPurpose ? { sealed_bootstrap_inputs_ref: ref } : {}),
            input_refs: proofRefs
              .filter((proof) => proof.artifact_id !== manifestRef.artifact_id)
              .concat(ref)
              .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
          });
        const changedInputs = sealedPurpose
          ? { ...sealedInputs, resource_policy_sha256: sha256("different private resource policy") }
          : { ...manifest, tenant_id: "cross-spliced-tenant" };
        const changedInputsRef = persist(
          runId,
          "SCA-P03",
          manifestRef.kind,
          sealedPurpose ? sealedInputs.schema_id : manifest.schema_id,
          changedInputs,
          [],
          "host:sca-p03-initial-authorization",
          "factory-invalid-private-scope"
        );
        assert.throws(
          () => factory.authorization.assertProposal(withManifest(changedInputsRef)),
          /p03_initial_foreign_proposal/
        );
        if (sealedPurpose) {
          const crossSplicedInputsRef = persist(
            runId,
            "SCA-P03",
            manifestRef.kind,
            sealedInputs.schema_id,
            {
              ...sealedInputs,
              record_ref: { ...sealedInputs.record_ref, operation_id: "cross-splice" },
            },
            [],
            "host:sca-p03-initial-authorization",
            "factory-invalid-original-sealed-ref"
          );
          assert.throws(
            () => factory.authorization.assertProposal(withManifest(crossSplicedInputsRef)),
            /p03_initial_foreign_proposal/
          );
        }
        const noncanonicalRef = store.persist({
          metadata: {
            schema_version: 2,
            run_id: runId,
            phase: "SCA-P03",
            branch_id: null,
            kind: manifestRef.kind,
            operation_id: "factory-noncanonical-inputs",
            version: 1,
            producer: "host:sca-p03-initial-authorization",
            media_type: "application/json",
            content_schema: {
              schema_id: sealedPurpose ? sealedInputs.schema_id : manifest.schema_id,
              schema_version: 1,
            },
            parent_ref: null,
            upstream_refs: [],
          },
          content: canonicalJson(sealedPurpose ? sealedInputs : manifest) + "\n",
        });
        assert.throws(
          () => factory.authorization.assertProposal(withManifest(noncanonicalRef)),
          /p03_initial_foreign_proposal/
        );
        const changedRef = {
          ...manifestRef,
          operation_id: manifestRef.operation_id + "-cross-splice",
        };
        assert.throws(
          () =>
            factory.authorization.assertProposal(
              validateScaP03InitialProposalV1({
                ...proposal,
                ...(sealedPurpose ? { sealed_bootstrap_inputs_ref: changedRef } : {}),
                input_refs: proofRefs.map((ref) =>
                  ref.artifact_id === manifestRef.artifact_id ? changedRef : ref
                ),
              })
            ),
          /canonical identity|p03_initial_foreign_proposal/
        );
        // Source-census admission remains independent of module_files and both purposes.
        mutateSource();
        try {
          assert.throws(
            () => factory.authorization.assertProposal(proposal),
            /p03_initial_source_manifest_drift/
          );
        } finally {
          writeFileSync(omittedSource, originalSource);
        }
        const declaration = factory.service.engine.registration.host_operations?.declarations[0];
        assert.ok(declaration && factory.service.hostOperations);
        const directive = validateDirective({
          schema_version: 2,
          host_operation_schema_version: 1,
          action: "invoke_host_operation",
          identity: {
            schema_version: 2,
            run_id: runId,
            session_id: runId,
            playbook: factory.service.engine.registration.name,
            engine_owner: "typescript",
          },
          state_id: "sca_p03_initial_qualification",
          attempt: 1,
          operation_id: `initial:${proposal.approval_id}:${proposal.invocation_nonce}`,
          operation_kind: declaration.operation_kind,
          registration_sha256: runtimeRegistrationSha256(factory.service.engine.registration),
          request_ref: proposalRef,
          request_sha256: proposalRef.content_digest,
          input_artifacts: {
            schema_version: 2,
            artifacts: [
              { slot: "initial_proposal", ref: proposalRef },
              ...proofRefs.map((ref, i) => ({ slot: `proof_${String(i).padStart(3, "0")}`, ref })),
            ],
          },
          expected_result: declaration.result,
          policy_binding: hostOperationPolicyBinding(declaration, backend),
        });
        assert.equal(directive.action, "invoke_host_operation");
        if (directive.action !== "invoke_host_operation")
          throw new Error("native factory directive required");
        // Missing controls must refuse before any body, journal, lease or adapter effect.
        await assert.rejects(
          factory.service.hostOperations.dispatch(factory.service.engine, directive),
          /p03_initial_use_slots_invalid/
        );
        assert.equal(factory.service.checkpointer.hostOperationCallsForRun(runId).length, 0);
        assert.deepEqual({ effects, commands }, { effects: 0, commands: 0 });
        assert.ok(["absent", "free"].includes(leaseInspector.inspect(backend).state));
        assert.equal(factory.service.engine.registration.worker.model_policy, "none");
        return {
          results,
          effects,
          commands,
          current_source_manifest_sha256: current.source_manifest_sha256,
          scenario: scope.scenario,
          disposition: null,
          receipt_ref: null,
        };
      }
      const pending = await service.execute({
        schema_version: 2,
        action: "start",
        identity: {
          schema_version: 2,
          run_id: runId,
          session_id: runId,
          playbook: registration.name,
          engine_owner: "typescript",
        },
        goal: "disposable native initial collector contract",
        project_root: projectRoot,
        trust_profile: "trusted-interactive",
        constraints: { proposal_ref: proposalRef },
      });
      assert.equal(pending.action, "await_user");
      reportMilestone("gate_awaiting_user");
      const transportRef = service.checkpointer
        .loadRunById(runId)
        ?.selectedArtifacts.find((r) => r.kind === "sca-p03-initial-transport");
      assert.ok(transportRef);
      const binding = readScaP03InitialGate(store, proposalRef, transportRef);
      const transport = validateContract(
        ScaP03InitialTransportV1Schema,
        JSON.parse(store.read(transportRef).toString()),
        "native fixture transport"
      );
      const capability = registerTrustedQuestionnaireTransport(transport.questions, {
        runId,
        gateId: binding.gate_id,
        challenge: binding.challenge,
        artifactRef: proposalRef,
        transportRef,
        renderedQuestionsDigest: binding.rendered_questions_digest,
      });
      assert.ok(capability);
      const ui = createExtensionApiHarness();
      questionnaire(ui.api);
      const response = requireQuestionnaireToolResult(
        await requireQuestionnaireTool(ui.registeredTools[0]).execute(
          "native-fixture",
          { trustedTransportCapability: capability },
          undefined,
          undefined,
          {
            hasUI: true,
            ui: {
              notify() {},
              async custom() {
                return {
                  questions: [],
                  answers: [
                    {
                      id: "initial",
                      value: "approve",
                      label: "Approve",
                      wasCustom: false,
                      index: 2,
                    },
                  ],
                  cancelled: false,
                };
              },
            },
          }
        )
      );
      const events = response.details?.trustedHumanEvents;
      assert.ok(Array.isArray(events) && events.length === 1);
      assert.equal(verifyExecutionOwnerSignature(events[0]), true);
      reportMilestone("signed_approval_validated");
      if (scope.scenario === "success" || scope.scenario === "large") {
        // Recheck an already approved proposal before submission; no host operation or
        // transport effect may be created. Restoring the exact bytes preserves the gate.
        const beforeDrift = { effects, commands };
        const leaseBeforeDrift = leaseInspector.inspect(backend);
        assert.ok(["absent", "free"].includes(leaseBeforeDrift.state));
        mutateSource();
        try {
          assert.throws(
            () => authorization.assertProposal(proposal),
            /p03_initial_source_manifest_drift/
          );
          assert.equal(service.checkpointer.hostOperationCallsForRun(runId).length, 0);
          assert.deepEqual({ effects, commands }, beforeDrift);
          assert.deepEqual(leaseInspector.inspect(backend), leaseBeforeDrift);
        } finally {
          writeFileSync(omittedSource, originalSource);
        }
      }
      const wrapper =
        scope.scenario === "wrapper_scope" ||
        scope.scenario === "wrapper_blocked" ||
        scope.scenario === "wrapper_owner_binding";
      if (wrapper) {
        // This UI token deliberately has a different coordinate than the engine witness.
        // It carries the unchanged genuinely signed questionnaire event, not an approval boolean.
        const tokenRef = initial(
          "sca-p03-initial-witness",
          "penny.sca-p03-initial-witness.v1",
          events[0],
          [proposalRef, transportRef]
        );
        const originalRegistration = service.engine.registration;
        const execute = service.execute.bind(service);
        // Refusal-only fault: drift the concrete service declaration AFTER the genuine
        // owner has consumed its operation. Never fabricate a row, receipt or success.
        const executionFault =
          scope.scenario === "wrapper_owner_binding"
            ? mock.method(
                service,
                "execute",
                async (...args: Parameters<OrchestrationService["execute"]>) => {
                  const result = await execute(...args);
                  const completed = service.checkpointer.hostOperationCallsForRun(runId)[0];
                  assert.equal(completed?.lifecycle, "consumed");
                  assert.equal(completed?.disposition?.outcome, "completed");
                  const authority = originalRegistration.host_operations;
                  assert.ok(authority);
                  Object.defineProperty(service.engine, "registration", {
                    configurable: true,
                    value: {
                      ...originalRegistration,
                      host_operations: {
                        ...authority,
                        declarations: authority.declarations.map((d) => ({
                          ...d,
                          max_progress_events: d.max_progress_events - 1,
                        })),
                      },
                    },
                  });
                  return result;
                }
              )
            : undefined;
        try {
          await assert.rejects(
            runScaP03InitialLiveCohortV1(
              {
                service,
                authorization,
                binding: pin,
                proposal_ref: proposalRef,
                transport_ref: transportRef,
                approval_token_ref: tokenRef,
              },
              activeAbort.signal
            ),
            scope.scenario === "wrapper_owner_binding"
              ? { name: "Error", message: "p03_live_owner_binding_mismatch" }
              : {
                  name: "ScaP03ConsumedFixtureErrorV1",
                  code: scope.scenario === "wrapper_blocked" ? "fixture_consistency" : "scope",
                  message:
                    scope.scenario === "wrapper_blocked"
                      ? "p03_consumed_fixture_fixture_consistency"
                      : "p03_consumed_fixture_scope",
                }
          );
        } finally {
          executionFault?.mock.restore();
          Object.defineProperty(service.engine, "registration", {
            configurable: true,
            value: originalRegistration,
          });
        }
        const persisted = service.checkpointer
          .hostOperationCallsForRun(runId)[0]
          ?.directive.input_artifacts.artifacts.find((a) => a.slot === "initial_witness")?.ref;
        assert.ok(persisted);
        assert.notEqual(persisted.artifact_id, tokenRef.artifact_id);
        assert.deepEqual(store.read(persisted), store.read(tokenRef));
      }
      const terminal = wrapper
        ? service.checkpointer.loadRunById(runId)?.terminalDirective
        : await respondToTrustedNativeGateV1({
            service,
            run_id: runId,
            event: events[0],
            signal: activeAbort.signal,
          });
      assert.ok(terminal);
      assert.equal(
        terminal.action,
        mode === "cancel" || fixtureTerminated ? "cancelled" : "incomplete"
      );
      if (terminal.action === "incomplete") assert.equal(terminal.met, false);
      const records = service.checkpointer.hostOperationCallsForRun(runId);
      assert.equal(records.length, 1);
      const record = records[0];
      assert.ok(record);
      if (sealedPurpose) {
        assert.equal(bootstrapApprovalValidated, true);
        assert.equal(adapterFailure, undefined);
        assert.ok(effects > 0 && commands > 0);
        assert.equal(record.lifecycle, "consumed");
        assert.ok(record.operation_result_ref);
        const evidence = validateContract(
          ScaP03SealedBootstrapEvidenceV1Schema,
          JSON.parse(store.read(record.operation_result_ref).toString()),
          "native sealed evidence"
        );
        assert.equal(evidence.status, "verified");
        assert.equal(evidence.request_sha256, proposalRef.content_digest);
        assert.equal(evidence.sample.handoff_sha256, f.manifest.sealed_handoff_sha256);
        assert.equal(
          evidence.sample.production_record_ref.artifact_id,
          sealed.production_record_ref.artifact_id
        );
        assert.equal(evidence.measurement_scope, "deterministic_transport_test");
        assert.equal(evidence.activation_granted, false);
        const before = { effects, commands };
        const replayed = await service.execute({
          schema_version: 2,
          action: "recover",
          identity: terminal.identity,
        });
        assert.equal(replayed.action, "incomplete");
        const adopted = service.checkpointer.hostOperationCallsForRun(runId)[0];
        assert.ok(adopted);
        assert.deepEqual(adopted.operation_result_ref, record.operation_result_ref);
        assert.deepEqual(adopted.host_receipt_ref, record.host_receipt_ref);
        assert.deepEqual({ effects, commands }, before);
        assert.equal(fences.size, 1);
        assert.deepEqual(record.disposition, {
          outcome: "completed",
          remote_disposition: "proven_terminal",
          lease_disposition: "released",
          retryable: false,
          reason_code: null,
        });
        assert.equal(leaseInspector.inspect(backend).state, "free");
        const nativeVerification = new ScaP03NativeVerificationInvocationV1({
          service,
          binding: pin,
          directive: record.directive,
          authorization,
          native_host: nativeHost,
        });
        const consumed = await nativeVerification.collect();
        await assert.rejects(
          new ScaP03NativeVerificationInvocationV1({
            service,
            binding: pin,
            directive: { ...record.directive, operation_id: "sca-p03-build-source-graph-php" },
            authorization,
            native_host: nativeHost,
          }).collect(),
          /purpose_mismatch/
        );
        assert.equal(commands, 11, "current consumed readback must not dispatch");
        const attestationRef = consumed.sample.attestation_ref;
        const attestation = validateScaP03HostIsolationAttestationV1(
          JSON.parse(store.read(attestationRef).toString())
        );
        const operationalIsolation = validateScaP03IsolationEvidenceV1({
          schema_id: "penny.sca-p03-isolation-evidence.v1",
          schema_version: 1,
          producer_id: "host:sca-p03-isolation-qualification",
          evidence_kind: "host_qualification_attestation",
          runtime_kind: attestation.runtime_kind,
          qualification_scope: attestation.qualification_scope,
          qualified: attestation.qualified,
          runtime_id: attestation.runtime_id,
          isolation_id: attestation.isolation_id,
          implementation_identity_sha256: attestation.implementation_identity_sha256,
          deployment_identity_sha256: attestation.deployment_identity_sha256,
          profile_id: attestation.profile_id,
          profile_sha256: attestation.profile_sha256,
          runtime_tree_sha256: attestation.runtime_tree_sha256,
          qualified_at: attestation.attested_at,
          host_attestation_id: attestation.attestation_id,
          host_attestation_sha256: attestationRef.content_digest,
          host_attestation_ref: attestationRef,
        });
        const operationalIsolationRef = persist(
          f.run_id,
          "SCA-P03",
          "sca-p03-isolation-evidence",
          operationalIsolation.schema_id,
          operationalIsolation,
          [attestationRef],
          operationalIsolation.producer_id
        );
        // A fresh native approval, run and nonce reuse the SAME original immutable inputs.
        const freshRun = `${runId}-fresh`;
        const freshProposal = validateScaP03InitialProposalV1({
          ...proposal,
          run_id: freshRun,
          approval_id: proposal.approval_id + "-fresh",
          invocation_nonce: proposal.invocation_nonce + "-fresh",
        });
        const freshRef = persist(
          freshRun,
          "SCA-P03",
          "sca-p03-initial-proposal",
          freshProposal.schema_id,
          freshProposal,
          proofRefs,
          "host:sca-p03-initial-authorization"
        );
        const freshPin = new ScaP03InitialProposalBindingV1(store, freshRef);
        const freshComposition = compose(freshPin);
        using freshService = freshComposition.service;
        const freshIdentity = { ...pending.identity, run_id: freshRun, session_id: freshRun };
        const freshGate = await freshService.execute({
          schema_version: 2,
          action: "start",
          identity: freshIdentity,
          goal: "second exact native verification",
          project_root: projectRoot,
          trust_profile: "trusted-interactive",
          constraints: { proposal_ref: freshRef },
        });
        assert.equal(freshGate.action, "await_user");
        const freshTransportRef = freshService.checkpointer
          .loadRunById(freshRun)
          ?.selectedArtifacts.find((ref) => ref.kind === "sca-p03-initial-transport");
        assert.ok(freshTransportRef);
        const freshBinding = readScaP03InitialGate(store, freshRef, freshTransportRef);
        const freshTransport = validateContract(
          ScaP03InitialTransportV1Schema,
          JSON.parse(store.read(freshTransportRef).toString()),
          "fresh native questions"
        );
        const freshCapability = registerTrustedQuestionnaireTransport(freshTransport.questions, {
          runId: freshRun,
          gateId: freshBinding.gate_id,
          challenge: freshBinding.challenge,
          artifactRef: freshRef,
          transportRef: freshTransportRef,
          renderedQuestionsDigest: freshBinding.rendered_questions_digest,
        });
        assert.ok(freshCapability);
        const freshResponse = requireQuestionnaireToolResult(
          await requireQuestionnaireTool(ui.registeredTools[0]).execute(
            "fresh-native-fixture",
            { trustedTransportCapability: freshCapability },
            undefined,
            undefined,
            {
              hasUI: true,
              ui: {
                notify() {},
                async custom() {
                  return {
                    questions: [],
                    answers: [
                      {
                        id: "initial",
                        value: "approve",
                        label: "Approve",
                        wasCustom: false,
                        index: 2,
                      },
                    ],
                    cancelled: false,
                  };
                },
              },
            }
          )
        );
        const freshEvents = freshResponse.details?.trustedHumanEvents;
        assert.ok(Array.isArray(freshEvents) && freshEvents.length === 1);
        assert.equal(verifyExecutionOwnerSignature(freshEvents[0]), true);
        await respondToTrustedNativeGateV1({
          service: freshService,
          run_id: freshRun,
          event: freshEvents[0],
          signal: activeAbort.signal,
        });
        const freshRecord = freshService.checkpointer.hostOperationCallsForRun(freshRun)[0];
        assert.ok(freshRecord);
        assert.equal(freshRecord.lifecycle, "consumed");
        assert.ok(freshRecord.operation_result_ref);
        assert.ok(freshRecord.host_receipt_ref);
        const freshResult = validateContract(
          ScaP03SealedBootstrapEvidenceV1Schema,
          JSON.parse(store.read(freshRecord.operation_result_ref).toString()),
          "fresh consumed evidence"
        );
        assert.deepEqual(freshResult.sample, evidence.sample);
        assert.deepEqual(
          freshResult.sealed_bootstrap_inputs_ref,
          evidence.sealed_bootstrap_inputs_ref
        );
        assert.notEqual(
          freshRecord.operation_result_ref.artifact_id,
          record.operation_result_ref.artifact_id
        );
        assert.notEqual(
          freshRecord.host_receipt_ref.artifact_id,
          record.host_receipt_ref?.artifact_id
        );
        assert.equal(leaseInspector.inspect(backend).state, "free");
        assert.equal(fences.size, 2);
        const freshInvocation = new ScaP03NativeVerificationInvocationV1({
          service: freshService,
          binding: freshPin,
          directive: freshRecord.directive,
          authorization: freshComposition.authorization,
          native_host: nativeHost,
        });
        const priorCommands = commands;
        assert.deepEqual((await freshInvocation.collect()).sample, evidence.sample);
        assert.equal(commands, priorCommands);
        const proofCommands = commands;
        const probe = createScaP03LocalHostProbeV1({
          store,
          config,
          runtime_package_refs: b.runtime_package_refs,
          registry: ScaP03WorkspaceRegistryV1.resume(path.join(f.working, "registry.json")),
          current_selection_path: f.selection,
          build_files: Object.fromEntries(
            [...f.manifest.implementation, ...f.manifest.runtime_packages].map((entry) => [
              entry.ref.artifact_id,
              entry.path,
            ])
          ),
        });
        const authority = createScaP03BootstrapHostAuthorityV1({
          store,
          probe,
          evaluator_id: f.manifest.evaluator_id,
          reviewer_public_key: createPublicKey(readFileSync(f.keyPath)),
          reviewer_id: f.manifest.reviewer_id,
          reviewer_authority_id: f.manifest.reviewer_authority_id,
          attester_id: f.manifest.attester_id,
          record_ref: sealed.record_ref,
          binding_ref: sealed.binding_ref,
          attempt_ref: sealed.attempt_ref,
          cleanup_ref: sealed.cleanup_ref,
          isolation_ref: sealed.isolation_ref,
          receipt_ref: sealed.receipt_ref,
          implementation_refs: b.implementation_source_refs,
          runtime_package_refs: b.runtime_package_refs,
        });
        const cache = path.join(f.working, "ordinary-cache");
        mkdirSync(cache, { mode: 0o700 });
        const composition = await createScaP03ProductionHostCompositionV1({
          config,
          runner: async (command) => {
            const text = await deterministicTransport(command);
            assert.ok(Buffer.byteLength(text) <= command.output_bytes);
            reportMilestone("command_completed", ++completedCommands, text);
            return text;
          },
          result_cache_root: cache,
          proof: {
            store,
            authority,
            binding_ref: sealed.binding_ref,
            host_attestation_ref: sealed.host_attestation_ref,
            qualification_record_ref: sealed.record_ref,
            review_ref: sealed.review_ref,
            production_record_ref: sealed.production_record_ref,
            production_bindings: handoff.production_bindings,
            owner_policy: { native_host: nativeHost, sealed_inputs: sealedInputs, resources },
          },
        });
        assert.equal(commands, proofCommands, "construction must be read-only");
        const campaignCore = validateScaCampaignManifestCoreV1(
          JSON.parse(store.read(manifest.accepted_p01.campaign_manifest_core_ref).toString())
        );
        assert.ok(handoff.isolation_ref);
        const requestBase = {
          schema_id: "penny.sca-p03-request.v2",
          schema_version: 2,
          tenant_id: manifest.tenant_id,
          project_id: f.project_id,
          run_id: f.run_id,
          phase_id: "SCA-P03",
          accepted_p01: manifest.accepted_p01,
          accepted_p02: manifest.accepted_p02,
          source_snapshot_ref: campaignCore.frozen_refs.source_snapshot_ref,
          source_snapshot_sha256: campaignCore.frozen_refs.source_snapshot_ref.content_digest,
          runtime_policy_ref: b.runtime_policy_ref,
          joern_runtime_identity_ref: b.runtime_identity_ref,
          isolation_evidence_ref: operationalIsolationRef,
          host_isolation_attestation_ref: sealed.host_attestation_ref,
          implementation_identity_ref: b.implementation_identity_ref,
          qualification_profile_ref: b.qualification_profile_ref,
          fixture_corpus_ref: b.fixture_corpus_ref,
          source_oracle_ref: b.source_oracle_ref,
          source_oracle_validation_ref: b.source_oracle_validation_ref,
          fixture_content_refs: b.fixture_content_refs,
          fidelity_complement_refs: [],
          baseline_query_set_ref: b.baseline_query_set_ref,
          query_script_refs: b.query_script_refs,
          query_plan_refs: b.query_plan_refs,
          runtime_package_refs: b.runtime_package_refs,
          bootstrap_verification: {
            purpose: "sealed_bootstrap_verification",
            manifest_sha256: f.manifest_sha256,
            sealed_inputs_ref: manifestRef,
            backend_resource_sha256: backend,
            input_refs: proofRefs.filter((ref) => ref.artifact_id !== manifestRef.artifact_id),
          },
          requested_at: new Date().toISOString(),
        };
        const request = validateScaP03RequestV2(
          withScaP03Digest(
            {
              ...requestBase,
              p01_binding_sha256: scaP03P01BindingSha256(requestBase),
              p02_binding_sha256: scaP03P02BindingSha256(requestBase),
              p03_runtime_binding_sha256: scaP03RuntimeBindingSha256(requestBase),
            },
            "request_sha256"
          )
        );
        using phaseService = new OrchestrationService({
          projectRoot,
          env: { PENNY_STATE_ROOT: stateRoot },
          enableChildWorkflows: false,
          playbookRegistration: SCA_P03_CANDIDATE_REGISTRATION,
          hostOperationResultCache: composition.result_cache,
          hostOperationUseValidator: composition.use_validator,
          hostOperationAdapters: new Map(
            [...composition.adapters].map(([id, operation]) => [
              id,
              {
                ...operation,
                async run(context) {
                  ownerContext = context;
                  return operation.run(context);
                },
              },
            ])
          ),
        });
        ordinaryService = phaseService;
        const directive = phaseService.engine.authorizeDispatch(
          phaseService.engine.handle({
            schema_version: 2,
            action: "start",
            identity: {
              schema_version: 2,
              run_id: f.run_id,
              session_id: f.run_id,
              playbook: SCA_P03_CANDIDATE_REGISTRATION.name,
              engine_owner: "typescript",
            },
            goal: "ordinary P03 native owner production-factory qualification",
            project_root: projectRoot,
            trust_profile: "trusted-interactive",
            constraints: { p03_request: request },
            input_artifacts: scaP03InputArtifacts(request),
          })
        );
        assert.equal(directive.action, "invoke_host_operation");
        if (
          directive.action !== "invoke_host_operation" ||
          phaseService.hostOperations === undefined
        )
          throw new Error("P03 owner absent");
        const next = await phaseService.hostOperations.dispatch(phaseService.engine, directive);
        assert.equal(next.action, "invoke_host_operation");
        const operations = phaseService.checkpointer.hostOperationCallsForRun(f.run_id);
        assert.equal(operations.length, 1);
        const qualification = operations[0];
        assert.ok(qualification);
        assert.equal(qualification.lifecycle, "consumed");
        assert.ok(qualification.operation_result_ref);
        const operationRequest = validateScaP03OperationRequestV1(
          "qualify_joern",
          JSON.parse(store.read(directive.request_ref).toString())
        );
        const result = validateScaP03OperationResultV1(
          "qualify_joern",
          operationRequest,
          JSON.parse(store.read(qualification.operation_result_ref).toString())
        );
        assert.equal(result.status, "complete");
        if (!("cases" in result)) throw new Error("ordinary qualification cases absent");
        assert.equal(result.cases.length, 21);
        assert.ok(result.cases.every((entry) => entry.status === "passed"));
        assert.equal(
          fences.size,
          3,
          "both fresh native invocations and ordinary P03 reserve independent genuine leases"
        );
        assert.equal(leaseInspector.inspect(backend).state, "free");
        phaseService.engine.handle({
          schema_version: 2,
          action: "cancel",
          identity: directive.identity,
          reason: "fixture ends after genuine ordinary qualification",
        });
        reportMilestone("terminal_consumed");
        return {
          results,
          effects,
          commands,
          current_source_manifest_sha256: current.source_manifest_sha256,
          scenario: scope.scenario,
          disposition: record.disposition,
          receipt_ref: record.host_receipt_ref,
        };
      }
      if (mode !== "success" || fixtureTerminated) {
        if (mode === "source_drift")
          assert.match(String(adapterFailure), /p03_initial_source_manifest_drift/);
        assert.notEqual(record.disposition?.outcome, "completed");
        assert.equal(record.operation_result_ref, null);
        assert.equal(record.lifecycle, "consumed");
        assert.ok(effects > 0);
        assert.equal(record.disposition?.lease_disposition, "quarantined");
        assert.equal(leaseInspector.inspect(backend).state, "quarantined");
        assert.equal(fences.size, 1);
        assert.equal(name === "", mode !== "lost");
        if (fixtureTerminated) {
          // Parent termination is never a positive result. Wait for the canonical consumed
          // cancellation/quarantine and independently observed owned absence before exit.
          assert.equal(name, "");
          reportMilestone("terminated_cleanup_observed");
          throw new Error("fixture_watchdog_cancelled_owned_cleanup_observed");
        }
        reportMilestone("terminal_consumed");
        return {
          results,
          effects,
          commands,
          current_source_manifest_sha256: current.source_manifest_sha256,
          scenario: mode,
          disposition: record.disposition,
          receipt_ref: record.host_receipt_ref,
        };
      }
      assert.equal(record.lifecycle, "consumed");
      assert.equal(record.disposition?.outcome, "completed");
      assert.ok(record.operation_result_ref && record.host_receipt_ref);
      const resultRef = record.operation_result_ref;
      const evidence = readEvidence(store, resultRef);
      const declaration = service.engine.registration.host_operations?.declarations[0];
      assert.ok(declaration);
      const readInput = {
        checkpointer: service.checkpointer,
        store,
        binding: pin,
        directive: record.directive,
        declaration,
        expected_measurement_scope: "deterministic_transport_test" as const,
      };
      const readOnly = <T>(read: () => T) =>
        assertP03FixtureReadOnlyV1({
          service,
          store,
          catalog_path: path.join(stateRoot, "catalog.db"),
          commands: () => commands,
          read,
        });
      const witnessRef = record.directive.input_artifacts.artifacts.find(
        (a) => a.slot === "initial_witness"
      )?.ref;
      assert.ok(witnessRef);
      assert.deepEqual(store.read(witnessRef), Buffer.from(canonicalJson(events[0])));
      assert.equal(evidence.formal_qualification_granted, false);
      assert.equal(evidence.activation_granted, false);
      assert.equal(evidence.p04_dispatch_permitted, false);
      assert.equal(evidence.independent_review, "required");
      if (scope.scenario === "wrapper_blocked") {
        assert.equal(evidence.status, "fixture_blocked");
        assert.ok(evidence.cases.some((c) => c.status !== "passed"));
        readOnly(() =>
          assert.throws(
            () => readScaP03ConsumedFixtureEvidenceV1(readInput),
            /^ScaP03ConsumedFixtureErrorV1: p03_consumed_fixture_fixture_consistency$/
          )
        );
        reportMilestone("terminal_consumed");
        return {
          results,
          effects,
          commands,
          current_source_manifest_sha256: current.source_manifest_sha256,
          scenario: scope.scenario,
          disposition: record.disposition,
          receipt_ref: record.host_receipt_ref,
        };
      }
      readOnly(() => {
        const verified = readScaP03ConsumedFixtureEvidenceV1(readInput);
        assert.deepEqual(verified.result_ref, record.operation_result_ref);
        assert.deepEqual(verified.platform_result_ref, record.platform_result_ref);
        assert.deepEqual(verified.receipt_ref, record.host_receipt_ref);
        assert.deepEqual(verified.evidence_bytes, store.read(resultRef));
        assert.deepEqual(verified.evidence, evidence);
        assert.deepEqual(
          verified.attempt_witness_bytes,
          Buffer.from(evidence.attempt_witness_base64, "base64")
        );
        assert.equal(
          canonicalJson(verified.attempt_witness),
          Buffer.from(verified.attempt_witness_bytes).toString("utf8")
        );
        assert.equal(verified.attempt_witness.executions.length, 17);
        assert.equal(verified.verification_scope, "historical_consumed_fixture_evidence");
        assert.equal(verified.current_execution_authorization, "not_evaluated");
        assert.deepEqual(readScaP03ConsumedFixtureEvidenceV1(readInput), verified);
        // Historical replay is not renewal: the existing current authority still refuses.
        offset = 700_000;
        assert.throws(() => authorization.assertProposal(proposal), /p03_initial_authority_denied/);
        assert.deepEqual(readScaP03ConsumedFixtureEvidenceV1(readInput), verified);
        offset = 0;
        revoked = true;
        assert.throws(() => authorization.assertProposal(proposal), /p03_initial_authority_denied/);
        assert.deepEqual(readScaP03ConsumedFixtureEvidenceV1(readInput), verified);
        revoked = false;
        // Local buffer mutation cannot change a later read or the persisted originals.
        verified.evidence_bytes.fill(0);
        verified.attempt_witness_bytes.fill(0);
        const reread = readScaP03ConsumedFixtureEvidenceV1(readInput);
        assert.deepEqual(reread.evidence_bytes, store.read(resultRef));
        assert.deepEqual(
          reread.attempt_witness_bytes,
          Buffer.from(evidence.attempt_witness_base64, "base64")
        );
        assert.throws(
          () =>
            readScaP03ConsumedFixtureEvidenceV1({
              ...readInput,
              expected_measurement_scope: "live_observed",
            }),
          /p03_consumed_fixture_scope/
        );
        assert.throws(
          () =>
            readScaP03ConsumedFixtureEvidenceV1({
              ...readInput,
              directive: {
                ...record.directive,
                registration_sha256: sha256("foreign registration"),
              },
            }),
          /p03_consumed_fixture_owner_binding/
        );
        assert.throws(
          () =>
            readScaP03ConsumedFixtureEvidenceV1({
              ...readInput,
              declaration: { ...declaration, max_output_bytes: declaration.max_output_bytes - 1 },
            }),
          /p03_consumed_fixture_owner_binding/
        );
      });
      assert.equal(leaseInspector.inspect(backend).state, "free");
      assert.equal(fences.size, 1); // 17 owned containers share ONE native fenced operation.
      assert.equal(evidence.status, "observed");
      assert.equal(evidence.measurement_scope, "deterministic_transport_test");
      assert.equal(evidence.invocation_nonce, proposal.invocation_nonce);
      assert.equal(evidence.request_sha256, proposalRef.content_digest);
      assert.equal(evidence.cases.length, 21);
      assert.ok(evidence.cases.every((c) => c.status === "passed"));
      assert.equal(evidence.original_observations.length, 146);
      assert.equal(inventories, 3);
      assert.ok(effects > 10);
      assert.equal(name, "");
      for (const observation of evidence.original_observations) {
        const bytes = Buffer.from(observation.output_base64, "base64");
        assert.equal(sha256(bytes), observation.output_sha256);
        assert.equal(bytes.byteLength, observation.byte_length);
      }
      results.push({
        result_ref: record.operation_result_ref,
        receipt_ref: record.host_receipt_ref,
        evidence,
      });
    }
    reportMilestone("terminal_consumed");
    return {
      results,
      effects,
      commands,
      current_source_manifest_sha256: current.source_manifest_sha256,
      scenario: mode,
      disposition: null,
      receipt_ref: null,
    };
  } finally {
    process.stderr.write(`native-validation-cost ${canonicalJson(Object.fromEntries(costs))}\n`);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    assert.equal(Date.now(), clock.now);
  }
}
function validateScope(value: unknown) {
  return validateContract(fixtureScopeSchema, value, "private FD-owned test scope");
}
function readEvidence(store: ArtifactStore, ref: ArtifactRef) {
  return validateContract(
    ScaP03InitialEvidenceV1Schema,
    JSON.parse(store.read(ref).toString()),
    "consumed collector evidence"
  );
}

if (process.argv[2] === "--fixture-fd") {
  process.once("SIGTERM", () => {
    fixtureTerminated = true;
    fixtureAbort.abort(new Error("fixture_harness_sigterm"));
  });
  const scope = validateScope(JSON.parse(readFileSync(3, "utf8")));
  try {
    const result = await driver(scope);
    process.stdout.write(canonicalJson(result));
  } finally {
    disposeSamplerFixtures();
  }
} else {
  const { it, expect, vi } = await import("vitest");
  it("fixture Date control leaves real timers and monotonic elapsed time running", async () => {
    const realDate = Date;
    const wall = performance.now();
    {
      using clock = controlFixtureDate();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(performance.now()).toBeGreaterThan(wall);
      expect(Date.now()).toBe(clock.now);
      expect(new Date().getTime()).toBe(clock.now);
      mock.timers.setTime(clock.now + 700_000);
      expect(Date.now()).toBe(clock.now + 700_000);
      expect(new Date().getTime()).toBe(clock.now + 700_000);
    }
    expect(Date).toBe(realDate);
  });
  it("keys every lossless program metadata field, including nanosecond changes", () => {
    const metadata = {
      dev: 1n,
      ino: 2n,
      size: 3n,
      uid: 4n,
      mode: 5n,
      nlink: 1n,
      mtimeNs: 9007199254740993n,
      ctimeNs: 9007199254740993n,
    };
    for (const key of [
      "dev",
      "ino",
      "size",
      "uid",
      "mode",
      "nlink",
      "mtimeNs",
      "ctimeNs",
    ] as const) {
      expect(scaP03InitialFileMetadataV1({ ...metadata, [key]: metadata[key] + 1n })).not.toBe(
        scaP03InitialFileMetadataV1(metadata)
      );
    }
  });
  it("rehashes protected programs after restored-mtime, inode, ancestor and entry changes", () => {
    const root = createP03ProtectedTempFixture("p03-program-metadata-");
    try {
      const parent = path.join(root, "programs");
      mkdirSync(parent, { mode: 0o700 });
      const file = path.join(parent, "loader.js");
      writeFileSync(file, "original", { mode: 0o600 });
      utimesSync(file, 1234, 1234);
      const measurements = new ScaP03InitialProgramMeasurementsV1([root]);
      const digest = sha256("original");
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
      // An unrelated entry change in a shared sticky ancestor may safely force a reread.
      // A cache hit is an optimization, not the integrity contract exercised below.
      expect(["unchanged", "rehashed"]).toContain(measurements.assertProgram(file, digest));
      const original = lstatSync(file, { bigint: true });
      writeFileSync(file, "modified");
      utimesSync(file, 1234, 1234);
      expect(lstatSync(file, { bigint: true }).mtimeNs).toBe(original.mtimeNs);
      expect(() => measurements.assertProgram(file, digest)).toThrow(/program_drift/);
      writeFileSync(file, "original");
      utimesSync(file, 1234, 1234);
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
      // A revert of mode/content/mtime is not a revert of ctime. This kills mtime-only caches.
      const before = lstatSync(file, { bigint: true });
      chmodSync(file, 0o400);
      chmodSync(file, 0o600);
      expect(lstatSync(file, { bigint: true }).ctimeNs).not.toBe(before.ctimeNs);
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
      utimesSync(file, 1235, 1235);
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
      const replacement = path.join(parent, "replacement.js");
      writeFileSync(replacement, "original", { mode: 0o600 });
      renameSync(replacement, file);
      expect(lstatSync(file, { bigint: true }).ino).not.toBe(before.ino);
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
      const entry = path.join(parent, "added-loader.js");
      writeFileSync(entry, "another loader", { mode: 0o600 });
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
      unlinkSync(entry);
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
      renameSync(parent, `${parent}-renamed`);
      renameSync(`${parent}-renamed`, parent);
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("rehashes rather than caching across ancestor churn and still rejects restored-mtime tampering", () => {
    const root = createP03ProtectedTempFixture("p03-program-ancestor-churn-");
    const file = path.join(root, "loader.js");
    const entry = path.join(root, "unrelated-entry");
    writeFileSync(file, "original", { mode: 0o600 });
    utimesSync(file, 1234, 1234);
    const original = lstatSync(file, { bigint: true });
    const read = fs.readSync;
    let changes = 0;
    // Change a real ancestor's entry during each exact-byte read. No file metadata or
    // digest is mocked; this deterministically exercises the safe non-cacheable branch.
    const churn = vi
      .spyOn(fs, "readSync")
      .mockImplementation((...args: Parameters<typeof read>) => {
        if (++changes % 2 === 1) writeFileSync(entry, "entry", { mode: 0o600 });
        else unlinkSync(entry);
        return read(...args);
      });
    syncBuiltinESMExports();
    try {
      const measurements = new ScaP03InitialProgramMeasurementsV1([root]);
      const digest = sha256("original");
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
      expect(measurements.assertProgram(file, digest)).toBe("rehashed");
      expect(changes).toBeGreaterThanOrEqual(4);
      writeFileSync(file, "modified");
      utimesSync(file, 1234, 1234);
      expect(lstatSync(file, { bigint: true }).mtimeNs).toBe(original.mtimeNs);
      expect(() => measurements.assertProgram(file, digest)).toThrow(/program_drift/);
    } finally {
      churn.mockRestore();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("denies unsafe program files, ancestors, links and undeclared mappings even after a hit", () => {
    const root = createP03ProtectedTempFixture("p03-program-denial-");
    try {
      const parent = path.join(root, "programs");
      mkdirSync(parent, { mode: 0o700 });
      const file = path.join(parent, "loader.js"),
        backup = path.join(parent, "backup");
      writeFileSync(file, "original", { mode: 0o600 });
      const measurements = new ScaP03InitialProgramMeasurementsV1([root]);
      const digest = sha256("original");
      measurements.assertProgram(file, digest);
      linkSync(file, backup);
      expect(() => measurements.assertProgram(file, digest)).toThrow(/program_drift/);
      unlinkSync(backup);
      chmodSync(file, 0o666);
      expect(() => measurements.assertProgram(file, digest)).toThrow(/program_drift/);
      chmodSync(file, 0o600);
      measurements.assertProgram(file, digest);
      chmodSync(parent, 0o777);
      expect(() => measurements.assertProgram(file, digest)).toThrow(/writable_ancestor/);
      chmodSync(parent, 0o700);
      renameSync(file, backup);
      symlinkSync(backup, file);
      expect(() => measurements.assertProgram(file, digest)).toThrow(/not_canonical/);
      unlinkSync(file);
      renameSync(backup, file);
      expect(() =>
        measurements.assertProgram(path.join(path.dirname(root), "other"), digest)
      ).toThrow(/outside_deployment/);
      unlinkSync(file);
      expect(() => measurements.assertProgram(file, digest)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("continues hashing the complete dependency tree and denies changed or unsafe loaders", () => {
    const root = createP03ProtectedTempFixture("p03-dependency-integrity-");
    try {
      const loader = path.join(root, "loader.js"),
        extra = path.join(root, "new-loader.js");
      writeFileSync(loader, "original", { mode: 0o600 });
      const digest = measureScaP03ProtectedDependencyRootV1(root);
      writeFileSync(extra, "new", { mode: 0o600 });
      expect(measureScaP03ProtectedDependencyRootV1(root)).not.toBe(digest);
      unlinkSync(extra);
      writeFileSync(loader, "modified");
      expect(measureScaP03ProtectedDependencyRootV1(root)).not.toBe(digest);
      writeFileSync(loader, "original");
      expect(measureScaP03ProtectedDependencyRootV1(root)).toBe(digest);
      linkSync(loader, extra);
      expect(() => measureScaP03ProtectedDependencyRootV1(root)).toThrow();
      unlinkSync(extra);
      symlinkSync(loader, extra);
      expect(() => measureScaP03ProtectedDependencyRootV1(root)).toThrow();
      unlinkSync(extra);
      chmodSync(loader, 0o666);
      expect(() => measureScaP03ProtectedDependencyRootV1(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const milestoneLine = (
    sequence: number,
    stage: P03PositiveMilestone["stage"],
    command: number | null = null
  ) =>
    `${P03_POSITIVE_MILESTONE_PREFIX}${canonicalJson({
      schema_id: "penny.p03-positive-milestone.v1",
      sequence,
      stage,
      command,
      output_sha256: command === null ? null : sha256("bounded output"),
      byte_length: command === null ? null : 14,
    })}\n`;
  const childScript = (script: string) =>
    spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
  it("watchdog uses a distinct finite cold-start budget then renews every completed command", async () => {
    const script = `const lines=${JSON.stringify([milestoneLine(1, "preimages_validated"), ...[1, 2, 3, 4].map((command) => milestoneLine(command + 1, "command_completed", command))])};
      await new Promise(r=>setTimeout(r,1100));
      for(const line of lines){process.stderr.write(line);await new Promise(r=>setTimeout(r,300));}
      process.stdout.write('complete');`;
    const output = await collectP03PositiveFixture(childScript(script), {
      cold_start_ms: 3000,
      inactivity_ms: 1000,
      termination_grace_ms: 1000,
    });
    expect(output.toString()).toBe("complete");
  });
  it("watchdog rejects heartbeat/noise renewal and observes signal, stage and bounded forced termination", async () => {
    const script = `process.on('SIGTERM',()=>{});process.stderr.write(${JSON.stringify(milestoneLine(1, "preimages_validated"))});setInterval(()=>process.stderr.write('heartbeat\\n'),25);`;
    await expect(
      collectP03PositiveFixture(childScript(script), {
        cold_start_ms: 3000,
        inactivity_ms: 200,
        termination_grace_ms: 200,
      })
    ).rejects.toThrow(
      /signal=SIGKILL elapsed_ms=\d+ stage=preimages_validated watchdog=milestone_inactivity_expired termination_grace=expired after_kill_cleanup=unproven/
    );
  });
  it("watchdog rejects replayed or noncanonical milestones and never passes exit zero after watchdog cleanup", async () => {
    const valid = milestoneLine(1, "preimages_validated");
    const replay = childScript(
      `process.on('SIGTERM',()=>process.exit(0));process.stderr.write(${JSON.stringify(valid + valid)});setInterval(()=>{},100);`
    );
    await expect(
      collectP03PositiveFixture(replay, {
        cold_start_ms: 3000,
        inactivity_ms: 200,
        termination_grace_ms: 1000,
      })
    ).rejects.toThrow(/watchdog=invalid_milestone/);
    const noncanonical = childScript(
      `process.stderr.write(${JSON.stringify(valid.replace("{", "{ "))});setInterval(()=>{},100);`
    );
    await expect(
      collectP03PositiveFixture(noncanonical, {
        cold_start_ms: 3000,
        inactivity_ms: 200,
        termination_grace_ms: 1000,
      })
    ).rejects.toThrow(/watchdog=invalid_milestone/);
    const settled = childScript(
      `process.on('SIGTERM',()=>{process.stderr.write(${JSON.stringify(milestoneLine(2, "terminated_cleanup_observed"))});process.exit(0)});process.stderr.write(${JSON.stringify(valid)});setInterval(()=>{},100);`
    );
    await expect(
      collectP03PositiveFixture(settled, {
        cold_start_ms: 3000,
        inactivity_ms: 200,
        termination_grace_ms: 1000,
      })
    ).rejects.toThrow(
      /code=0 signal=null .*watchdog=milestone_inactivity_expired termination_grace=settled after_kill_cleanup=observed/
    );
  });
  it("watchdog expires finite cold start without an invented validation heartbeat", async () => {
    await expect(
      collectP03PositiveFixture(
        childScript("setInterval(()=>process.stderr.write('loading\\n'),25)"),
        { cold_start_ms: 200, inactivity_ms: 1000, termination_grace_ms: 200 }
      )
    ).rejects.toThrow(/stage=cold_start watchdog=cold_start_expired/);
  });

  const controlledWatchdogChild = () => {
    const child = new ChildProcess();
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    return { child, stdout, stderr, kill };
  };
  const watchdogFailure = (execution: Promise<Buffer>) =>
    execution.then(
      () => null,
      (error: unknown) => {
        assert.ok(error instanceof Error);
        return error;
      }
    );
  it.each([1, P03_POSITIVE_STREAM_OUTPUT_LIMIT_BYTES])(
    "watchdog accepts explicit stream byte limit boundary %s",
    async (limit) => {
      const { child, stdout, stderr, kill } = controlledWatchdogChild();
      const execution = collectP03PositiveFixture(child, undefined, undefined, undefined, limit);
      try {
        stdout.write(Buffer.from("x"));
        stderr.write(Buffer.from("\n"));
        expect(kill).not.toHaveBeenCalled();
      } finally {
        child.emit("close", 0, null);
      }
      expect(await execution).toEqual(Buffer.from("x"));
    }
  );
  it("watchdog keeps one bounded stderr owner while forwarding productive milestones", async () => {
    const { child, stdout, stderr, kill } = controlledWatchdogChild();
    const onMilestone = vi.fn();
    const execution = collectP03PositiveFixture(child, undefined, onMilestone, undefined, 1024);
    try {
      expect(stderr.listenerCount("data")).toBe(1);
      expect(stdout.listenerCount("data")).toBe(1);
      stderr.write(Buffer.from("advisory timing noise\n"));
      expect(onMilestone).not.toHaveBeenCalled();
      stderr.write(Buffer.from(milestoneLine(1, "preimages_validated")));
      stderr.write(Buffer.from(milestoneLine(2, "command_completed", 1)));
      expect(onMilestone).toHaveBeenCalledTimes(2);
      expect(onMilestone).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ sequence: 1, stage: "preimages_validated" })
      );
      expect(onMilestone).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ sequence: 2, stage: "command_completed", command: 1 })
      );
      stdout.write(Buffer.from("complete"));
      expect(kill).not.toHaveBeenCalled();
    } finally {
      child.emit("close", 0, null);
    }
    expect(await execution).toEqual(Buffer.from("complete"));
  });
  it("watchdog accepts independent exact per-stream byte ceilings", async () => {
    const { child, stdout, stderr, kill } = controlledWatchdogChild();
    const line = Buffer.from("é\n"); // Three raw bytes, but only two decoded characters.
    const lineCount = 256,
      limit = line.byteLength * lineCount;
    const execution = collectP03PositiveFixture(child, undefined, undefined, undefined, limit);
    for (let i = 0; i < lineCount; i++) {
      stdout.write(line);
      stderr.write(line);
    }
    child.emit("close", 0, null);
    expect(kill).not.toHaveBeenCalled();
    expect(await execution).toEqual(Buffer.alloc(limit, line));
  });
  it.each(["stdout", "stderr"] as const)(
    "watchdog rejects cumulative %s overflow before decoding, even with exit zero",
    async (stream) => {
      const { child, stdout, stderr, kill } = controlledWatchdogChild();
      const onMilestone = vi.fn();
      const line = Buffer.from("é\n"),
        lineCount = 256;
      const limit = line.byteLength * lineCount;
      const failure = watchdogFailure(
        collectP03PositiveFixture(child, undefined, onMilestone, undefined, limit)
      );
      try {
        // All lines are tiny and newline-terminated: frame/tail bounds cannot detect this.
        for (let i = 0; i < lineCount; i++) ({ stdout, stderr })[stream].write(line);
        expect(kill).not.toHaveBeenCalled();
        const overflow = Buffer.from("x");
        const decodeOverflow = vi.spyOn(overflow, "toString");
        ({ stdout, stderr })[stream].write(overflow);
        const late = Buffer.from(milestoneLine(1, "preimages_validated") + "post-limit-noise\n");
        const decodeLate = vi.spyOn(late, "toString");
        for (let i = 0; i < 16; i++) {
          stderr.write(late);
          stdout.write(late);
        }
        expect(kill.mock.calls).toEqual([["SIGTERM"]]);
        expect(decodeOverflow).not.toHaveBeenCalled();
        expect(decodeLate).not.toHaveBeenCalled();
        expect(onMilestone).not.toHaveBeenCalled();
      } finally {
        child.emit("close", 0, null);
      }
      const error = await failure;
      assert.ok(error instanceof Error);
      expect(error.message).toMatch(
        new RegExp(`code=0 signal=null .*watchdog=${stream}_limit termination_grace=settled`)
      );
      expect(error.message).not.toContain("post-limit-noise");
    }
  );
  it.each(["stdout", "stderr"] as const)(
    "watchdog retains the default 8 MiB cumulative ceiling for %s",
    async (stream) => {
      expect(P03_POSITIVE_STREAM_OUTPUT_LIMIT_BYTES).toBe(8 * 1_048_576);
      const { child, stdout, stderr, kill } = controlledWatchdogChild();
      const failure = watchdogFailure(collectP03PositiveFixture(child));
      try {
        // 8,192 short lines fit the stderr frame limit while exactly filling its byte budget.
        const line = Buffer.from("x".repeat(1023) + "\n");
        ({ stdout, stderr })[stream].write(
          Buffer.alloc(P03_POSITIVE_STREAM_OUTPUT_LIMIT_BYTES, line)
        );
        expect(kill).not.toHaveBeenCalled();
        ({ stdout, stderr })[stream].write(Buffer.from("x"));
        expect(kill.mock.calls).toEqual([["SIGTERM"]]);
      } finally {
        child.emit("close", 0, null);
      }
      const error = await failure;
      assert.ok(error instanceof Error);
      expect(error.message).toContain(`watchdog=${stream}_limit`);
    }
  );
  it("watchdog bounds cumulative stderr flood and preserves forced-termination grace", async () => {
    vi.useFakeTimers();
    const { child, stdout, stderr, kill } = controlledWatchdogChild();
    const failure = watchdogFailure(
      collectP03PositiveFixture(
        child,
        { cold_start_ms: 3000, inactivity_ms: 1000, termination_grace_ms: 200 },
        undefined,
        undefined,
        768
      )
    );
    try {
      for (let i = 0; i < 257; i++) stderr.write(Buffer.from("é\n"));
      const late = Buffer.from("still-writing\n");
      const decodeLate = vi.spyOn(late, "toString");
      vi.advanceTimersByTime(199);
      for (let i = 0; i < 256; i++) {
        stderr.write(late);
        stdout.write(late);
      }
      expect(kill.mock.calls).toEqual([["SIGTERM"]]);
      expect(decodeLate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      child.emit("close", null, "SIGKILL");
      const error = await failure;
      assert.ok(error instanceof Error);
      expect(error.message).toMatch(
        /signal=SIGKILL .*watchdog=stderr_limit termination_grace=expired after_kill_cleanup=unproven/
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.emit("close", null, "SIGKILL");
      vi.useRealTimers();
    }
  });
  it("watchdog preserves cancellation and bounded cleanup but rejects exit zero", async () => {
    vi.useFakeTimers();
    const { child, stderr, kill } = controlledWatchdogChild();
    const controller = new AbortController();
    const onMilestone = vi.fn();
    const failure = watchdogFailure(
      collectP03PositiveFixture(child, undefined, onMilestone, controller.signal, 1024)
    );
    try {
      stderr.write(Buffer.from(milestoneLine(1, "preimages_validated")));
      controller.abort();
      stderr.write(Buffer.from(milestoneLine(2, "terminated_cleanup_observed")));
      expect(kill.mock.calls).toEqual([["SIGTERM"]]);
      expect(onMilestone).toHaveBeenCalledTimes(2);
      child.emit("close", 0, null);
      const error = await failure;
      assert.ok(error instanceof Error);
      expect(error.message).toMatch(
        /code=0 signal=null .*watchdog=harness_cancelled termination_grace=settled after_kill_cleanup=observed/
      );
      vi.advanceTimersByTime(30_000);
      expect(kill.mock.calls).toEqual([["SIGTERM"]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.emit("close", 0, null);
      vi.useRealTimers();
    }
  });
  it.each([
    0,
    -1,
    1.5,
    P03_POSITIVE_STREAM_OUTPUT_LIMIT_BYTES + 1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    -Infinity,
    NaN,
  ])("watchdog refuses invalid stream byte limit %s", (limit) => {
    vi.useFakeTimers();
    const { child, stdout, stderr, kill } = controlledWatchdogChild();
    try {
      expect(() =>
        collectP03PositiveFixture(child, undefined, undefined, undefined, limit)
      ).toThrow("invalid_fixture_budget");
      expect(stdout.listenerCount("data")).toBe(0);
      expect(stderr.listenerCount("data")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label:
        "large opaque closure passes real replay and native host admission with unchanged evidence",
      scenarios: ["large"] as const,
    },
    {
      label:
        "native factory admits sealed inputs and wires its genuine host to use-time refusal before effects",
      scenarios: ["factory_bootstrap"] as const,
    },
    {
      label: "native factory retains pre-live authority and exact-custody refusal before effects",
      scenarios: ["factory_fixture"] as const,
    },
    {
      label: "consumes two fresh native collector observations with all 21 original-output cases",
      scenarios: ["success", "success"] as const,
    },
    {
      label: "real live wrapper reaches strict readback and refuses deterministic scope",
      scenarios: ["wrapper_scope"] as const,
    },
    {
      label: "real live wrapper refuses post-owner service declaration drift",
      scenarios: ["wrapper_owner_binding"] as const,
    },
    {
      label: "real live wrapper refuses genuinely owner-completed fixture_blocked evidence",
      scenarios: ["wrapper_blocked"] as const,
    },
    {
      label:
        "verifies sealed bootstrap AFTER native approval under one fence and replays the SAME exact refs without effects",
      scenarios: ["bootstrap"] as const,
    },
    {
      label: "stops work on mid-command expiry and consumes a non-positive quarantined receipt",
      scenarios: ["expire"] as const,
    },
    {
      label: "stops work on mid-command revocation and consumes a non-positive quarantined receipt",
      scenarios: ["revoke"] as const,
    },
    {
      label:
        "stops fixture work when a canonical source omitted from module mappings drifts mid-command",
      scenarios: ["source_drift"] as const,
    },
    {
      label: "cancels work while narrowly authorized cleanup observes owned absence",
      scenarios: ["cancel"] as const,
    },
    {
      label: "quarantines a lost create response with unproven cleanup",
      scenarios: ["lost"] as const,
    },
    {
      label: "observes bounded owned cleanup after harness SIGTERM without passing",
      scenarios: ["terminate"] as const,
    },
    {
      label: "fails positive assertions on omitted collector",
      scenarios: ["omit"] as const,
    },
  ])(
    "$label",
    async ({ scenarios }) => {
      const root = createP03ProtectedTempFixture("p03-initial-positive-");
      try {
        mkdirSync(path.join(root, "cohort"), { mode: 0o700 });
        const scratch = path.join(root, "tmp");
        mkdirSync(scratch, { mode: 0o700 });
        const node = protectedNodeFixture(root),
          dependencies = protectedNativeDependenciesFixture(root, true),
          entrypoint = path.join(root, "initial-driver.mjs");
        const orchestration = protectedOrchestrationFixture(dependencies);
        buildP03CompiledFixture({
          entrypoint: fileURLToPath(import.meta.url),
          outfile: entrypoint,
          orchestration,
          initial: true,
        });
        chmodSync(entrypoint, 0o600);
        const repository = fileURLToPath(new URL("../../../", import.meta.url));
        const sourceRoot = path.join(root, "protected-source");
        mkdirSync(sourceRoot, { mode: 0o700 });
        for (const relative of new Set([
          ...SCA_P02_IMPLEMENTATION_SOURCE_PATHS,
          ...SCA_P03_IMPLEMENTATION_SOURCE_PATHS,
        ])) {
          const file = path.join(sourceRoot, relative);
          mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, readFileSync(path.join(repository, relative)), { mode: 0o600 });
        }
        const consumed: { result_ref: ArtifactRef; receipt_ref: ArtifactRef }[] = [];
        for (const [invocation, scenario] of scenarios.entries()) {
          mkdirSync(path.join(root, `cohort-${invocation}`), { mode: 0o700 });
          const scope = validateScope({
            scope: "disposable-p03-initial-contract-fixture",
            root,
            source_root: sourceRoot,
            oracle_root: fileURLToPath(new URL("./fixtures/p03-v2/", import.meta.url)),
            entrypoint,
            dependency_root: dependencies,
            invocation,
            scenario,
          });
          const capability = path.join(root, "scope.json");
          writeFileSync(capability, canonicalJson(scope), { mode: 0o600 });
          const fd = openSync(capability, "r");
          try {
            const child = spawn(node, [entrypoint, "--fixture-fd"], {
              stdio: ["ignore", "pipe", "pipe", fd],
              env: {
                PATH: "/usr/bin:/bin",
                HOME:
                  scenario === "factory_bootstrap" || scenario === "factory_fixture"
                    ? process.env.HOME
                    : root,
                TMPDIR: scratch,
                ...(scenario === "factory_bootstrap" || scenario === "factory_fixture"
                  ? { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }
                  : {}),
              },
            });
            const childStarted = performance.now();
            const harnessAbort = new AbortController();
            const execution = collectP03PositiveFixture(
              child,
              undefined,
              (milestone) => {
                process.stderr.write(
                  `${P03_POSITIVE_MILESTONE_PREFIX}${canonicalJson(milestone)}\n`
                );
                if (milestone.sequence === 1)
                  process.stderr.write(
                    `native-cold-start scenario=${scenario} elapsed_ms=${Math.round(performance.now() - childStarted)}\n`
                  );
                if (scenario === "terminate" && milestone.command === 3) harnessAbort.abort();
              },
              harnessAbort.signal
            );
            child.once("close", (code, signal) => {
              process.stderr.write(
                `native-child-terminal scenario=${scenario} code=${String(code)} signal=${String(signal)} elapsed_ms=${Math.round(performance.now() - childStarted)}\n`
              );
            });
            // Only the bounded collector owns raw stderr data; a diagnostic listener
            // would bypass its pre-decode byte limit.
            assert.equal(child.stderr?.listenerCount("data"), 1);
            if (scenario === "terminate") {
              await expect(execution).rejects.toThrow(
                /watchdog=harness_cancelled termination_grace=settled after_kill_cleanup=observed/
              );
              continue;
            }
            if (scenario === "omit") {
              await expect(execution).rejects.toThrow(
                /collector deliberately omitted; effects=0 commands=0/
              );
              continue;
            }
            const output = await execution;
            const result = validateContract(
              Type.Object(
                {
                  results: Type.Array(
                    Type.Object(
                      {
                        result_ref: ArtifactRefSchema,
                        receipt_ref: ArtifactRefSchema,
                        evidence: ScaP03InitialEvidenceV1Schema,
                      },
                      { additionalProperties: false }
                    )
                  ),
                  effects: Type.Integer(),
                  commands: Type.Integer(),
                  current_source_manifest_sha256: Type.String(),
                  scenario: Type.String(),
                  disposition: Type.Unknown(),
                  receipt_ref: Type.Union([ArtifactRefSchema, Type.Null()]),
                },
                { additionalProperties: false }
              ),
              JSON.parse(output.toString()),
              "positive fixture driver result"
            );
            if (
              scenario === "success" ||
              scenario === "large" ||
              scenario === "wrapper_scope" ||
              scenario === "wrapper_owner_binding"
            ) {
              expect(result.results).toHaveLength(1);
              expect(result.effects).toBeGreaterThan(10);
              const r = result.results[0];
              assert.ok(r);
              consumed.push(r);
              process.stderr.write(
                `native-consumed-proof ${canonicalJson({ result_ref: r.result_ref, receipt_ref: r.receipt_ref, run_id: r.evidence.run_id, invocation_nonce: r.evidence.invocation_nonce, request_sha256: r.evidence.request_sha256, measurement_scope: r.evidence.measurement_scope, cases: r.evidence.cases.length, observations: r.evidence.original_observations.length })}\n`
              );
            } else if (scenario === "factory_bootstrap" || scenario === "factory_fixture") {
              expect(result.results).toHaveLength(0);
              expect(result.effects).toBe(0);
              expect(result.commands).toBe(0);
              expect(result.disposition).toBeNull();
              expect(result.receipt_ref).toBeNull();
            } else if (scenario === "bootstrap" || scenario === "wrapper_blocked") {
              expect(result.results).toHaveLength(0);
              expect(result.effects).toBeGreaterThan(0);
              expect(result.commands).toBeGreaterThan(0);
              expect(result.disposition).toMatchObject({
                outcome: "completed",
                lease_disposition: "released",
                remote_disposition: "proven_terminal",
              });
              expect(result.receipt_ref).not.toBeNull();
            } else {
              expect(result.results).toHaveLength(0);
              expect(result.effects).toBeGreaterThan(0);
            }
            process.stderr.write(
              `verified native scenario ${scenario}: ${result.commands} commands, ${result.effects} creates\n`
            );
          } finally {
            closeSync(fd);
          }
        }
        if (scenarios[0] === "success") {
          expect(consumed).toHaveLength(2);
          expect(consumed[0]?.result_ref.artifact_id).not.toBe(consumed[1]?.result_ref.artifact_id);
          expect(consumed[0]?.receipt_ref.artifact_id).not.toBe(
            consumed[1]?.receipt_ref.artifact_id
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    // Each child is bounded by collectP03PositiveFixture's cold-start, completed-work
    // inactivity, output and milestone limits, plus cancellation and bounded termination.
    // A second wall deadline would discard healthy progress across the two fresh runs.
    0
  );
}
