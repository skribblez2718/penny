import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Type, type Static } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactStore,
  previewArtifactRef,
  type ArtifactHostStore,
  type PersistArtifactInput,
} from "../dist/artifact-store.js";
import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { Checkpointer } from "../dist/checkpointer.js";
import {
  TerminalDirectiveSchema,
  validateContract,
  validateDirective,
  type ArtifactRef,
  type CurrentArtifactRef,
  type Directive,
  type OutputArtifactMetadata,
  type RunIdentity,
  type SkillContract,
} from "../dist/contracts.js";
import type { RunContext } from "../dist/context.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";
import { HostOperationLeaseAuthority } from "../dist/host-operations/lease-authority.js";
import {
  HostOperationRuntimeOwner,
  HostOperationSimulatedCrashError,
} from "../dist/host-operations/owner.js";
import type {
  HostContinuationCapabilityV1,
  HostContinuationStepV1,
  PlaybookCore,
} from "../dist/playbooks/playbook.js";
import {
  PLAYBOOK_REGISTRY,
  passthroughStartAdmission,
  type PlaybookConstructionOptions,
  type PlaybookRegistration,
} from "../dist/playbooks/registry.js";
import {
  buildScaP01VariantCaptureManifestV1,
  readScaP01VariantCaptureV1,
} from "../dist/sca/p01-source-variants.js";
import { buildP01SourceSnapshotV2 } from "../dist/sca/p01-source-snapshot-builder.js";
import {
  validateScaP01VariantCaptureManifestV1,
  scaP01VariantCaptureManifestRefs,
  SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA,
} from "../dist/sca/p01-contracts.js";
import { issueScaP01CampaignGate } from "../dist/sca/p01-campaign-issuer.js";
import {
  installP01HostDispatchObserver,
  attemptSafeChildBoundary,
  attemptSafeTcpBoundary,
  attemptSafeUnixBoundary,
} from "./fixtures/p01-host-dispatch-observer.js";
import {
  ScaP01AdmissionError,
  admitScaP01Candidate,
  reviseScaP01ObligationLedgerCandidate,
  type ScaP01AdmissionResultV1,
} from "../dist/sca/p01-admission.js";
import {
  SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
  SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
  SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
  SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA,
  SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  SCA_OBLIGATION_LEDGER_V2_SCHEMA,
  SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
  SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
  SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
  SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
  SCA_P01_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
  SCA_P01_QUALIFICATION_LOG_CONTENT_V1_SCHEMA,
  SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA,
  SCA_P01_QUALIFICATION_VARIANT_IDS,
  SCA_P01_REQUIRED_CRITERION_IDS,
  SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
  SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
  SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS,
  SCA_PHASE_GATE_RECORD_V2_SCHEMA,
  SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
  SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
  SCA_QUALIFICATION_FIXTURE_V1_SCHEMA,
  SCA_QUALIFICATION_LOG_V1_SCHEMA,
  SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
  SCA_REVIEW_RECEIPT_V1_SCHEMA,
  SCA_SOURCE_PROVENANCE_V1_SCHEMA,
  appendScaObligationLedgerV2,
  effectiveScaObligations,
  scaP01AdmissionRequestRefs,
  scaP01SourceTreeDigest,
  scaPhaseQualificationRefs,
  validateScaCampaignManifestCoreV1,
  validateScaCampaignManifestV2,
  validateScaCampaignSourceSnapshotV2,
  validateScaObligationLedgerV2,
  validateScaP01AdmissionContextV1,
  validateScaP01AdmissionEvidenceV1,
  validateScaP01AdmissionRequestV3,
  validateScaPhaseGateRecordV2,
  validateScaPhaseQualificationRecordV2,
  type ScaP01AdmissionRequestV3,
  type ScaPhaseQualificationRecordV2,
} from "../dist/sca/p01-contracts.js";
import {
  SCA_ANALYSIS_PROFILE_V1_SCHEMA,
  SCA_AUTHORITY_POLICY_V1_SCHEMA,
  SCA_MODEL_DATA_POLICY_V1_SCHEMA,
  SCA_NETWORK_POLICY_V1_SCHEMA,
  SCA_OUTPUT_POLICY_V1_SCHEMA,
  SCA_P01_RULE_BUNDLE_V1_SCHEMA,
  SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA,
  SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
  SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
  SCA_P01_TRUSTED_PRODUCERS,
  SCA_PRIVACY_POLICY_V1_SCHEMA,
  SCA_RESOURCE_POLICY_V1_SCHEMA,
  SCA_RULE_PROFILE_V1_SCHEMA,
  SCA_RULE_RELEASE_V1_SCHEMA,
  SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
  validateScaAuthorityPolicyV1,
  validateScaToolchainIdentityV1,
} from "../dist/sca/p01-policy-contracts.js";
import {
  SCA_P02_HOST_ATTESTATION_KIND,
  SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
  SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
  SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
  SCA_P02_REQUEST_V1_SCHEMA,
  SCA_P02_RUNTIME_POLICY_PRODUCER,
  SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
  SCA_P02_SOURCE_CENSUS_IDENTITY_SHA256,
  buildScaP02RawEvidenceV1,
  decodeScaP02RawEvidenceV1,
  deriveScaP02ProvenanceV1,
  scaP02FrozenRefs,
  scaP02AggregateProfileSha256,
  validateScaP02CoverageMatrixV1,
  validateScaP02EvidenceManifestV1,
  validateScaP02GateAgainstCoverageV1,
  validateScaP02IsolationEvidenceV1,
  validateScaP02OperationRequestV1,
  validateScaP02OperationResultV1,
  validateScaP02PersistedEvidenceV1,
  validateScaP02P03TransitionV1,
  validateScaP02RequestV1,
  validateScaP02SuccessorLedgerV1,
  validateScaP02TransitionAgainstM1V1,
  validateScaM1RecordV2,
  validateScaM1AgainstGateV2,
  validateScaP02GateV1,
  type ScaP02OperationKind,
  type ScaP02OperationResultV1,
} from "../dist/sca/p02-contracts.js";
import {
  admitScaP02Candidate,
  createScaP03TransitionAdmissionV1,
  scaP02InputArtifacts,
} from "../dist/sca/p02-admission.js";
import {
  SCA_P02_CANDIDATE_PLAYBOOK_NAME,
  SCA_P02_CANDIDATE_REGISTRATION,
} from "../dist/sca/p02-playbook.js";
import {
  admitScaP03Candidate,
  createScaP03ProductionUseValidatorV1,
  scaP03InputArtifacts,
} from "../dist/sca/p03-admission.js";
import {
  validateScaP03P01RuntimeIdentityRootV1,
  validateScaP03P01RuntimeRootV1,
} from "../dist/sca/p03-p01-runtime-root.js";
import {
  SCA_P03_BASELINE_QUERY_SET_V1_SCHEMA,
  SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  SCA_P03_IMPLEMENTATION_PRODUCER,
  SCA_P03_ISOLATION_EVIDENCE_V1_SCHEMA,
  SCA_P03_ISOLATION_PRODUCER,
  SCA_P03_JOERN_RUNTIME_IDENTITY_V1_SCHEMA,
  SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
  SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
  SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V1_SCHEMA,
  SCA_P03_QUALIFICATION_PROFILE_V1_SCHEMA,
  SCA_P03_QUERY_AUTHORITY_PRODUCER,
  SCA_P03_QUERY_IDS,
  SCA_P03_QUERY_PLAN_V1_SCHEMA,
  SCA_P03_QUERY_SCRIPT_V1_SCHEMA,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_REQUEST_V2_SCHEMA,
  SCA_P03_RUNTIME_IDENTITY_PRODUCER,
  SCA_P03_RUNTIME_POLICY_PRODUCER,
  SCA_P03_RUNTIME_POLICY_V1_SCHEMA,
  SCA_P03_SUCCESSOR_LEDGER_V1_SCHEMA,
  scaP03P01BindingSha256,
  scaP03P02BindingSha256,
  scaP03RuntimeBindingSha256,
  projectSourceOracleCases,
  validateScaP03CoverageMatrixV1,
  validateScaP03GateV1,
  validateScaP03GraphManifestV1,
  validateScaP03GraphSupportMatrixV2,
  validateScaP03JoernRuntimeIdentityV1,
  validateScaP03QualificationProfileV2,
  validateScaP03RequestV2,
  validateScaP03SuccessorLedgerV1,
  withScaP03Digest,
} from "../dist/sca/p03-contracts.js";
import {
  SCA_P03_CANDIDATE_PLAYBOOK_NAME,
  SCA_P03_CANDIDATE_REGISTRATION,
} from "../dist/sca/p03-playbook.js";
import type { ModelClient } from "../dist/model-client.js";
import { ProjectCatalog } from "../dist/state/catalog.js";
import { OrchestrationRunner, WorkerExecutor } from "../dist/worker.js";
import { inspectInstalledTreeSitterIdentitiesV2 } from "../../sca-service/src/adapters/tree-sitter-index.js";
import { createScaP02ComponentValidationAuthorityV1 } from "../../sca-service/src/p02-component-authority.js";
import {
  createScaP02OperationAdaptersV1,
  type ScaP02OperationAdapterOptionsV1,
} from "../../sca-service/src/p02-operations.js";
import {
  freezeScaP03ProductionV1,
  planScaP03ImplementationV3,
} from "../../sca-service/src/p03-bootstrap-freeze.js";
import {
  runScaP03BootstrapCliV1,
  type ScaP03BootstrapCliDepsV1,
} from "../../sca-service/src/p03-bootstrap-cli.js";
import {
  ScaP03CliProductionFreezeHandoffSchema,
  ScaP03CliProductionSealedHandoffSchema,
  parseScaP03CliCanonical,
} from "../../sca-service/src/p03-bootstrap-cli-contracts.js";
import {
  readP03ProductionInputs,
  scaP03ProductionUseAuthorityFromBindingsV1,
} from "../../sca-service/src/p03-bootstrap.js";
import {
  createScaP03OperationAdaptersV1,
  createScaP03SimulatedJoernRuntimeV1,
} from "../../sca-service/src/p03-operations.js";
import type { DockerRunnerV1 } from "../../sca-service/src/p03-docker-runtime.js";
import { syntheticSourceOracle } from "../../sca-service/tests/p03-synthetic-source-oracle.js";
import { observedFromSourceCase } from "../../sca-service/tests/p03-test-oracle.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";

const CREATED_AT = "2026-09-19T12:00:00.000Z";
const RUN_ID = "sca-p01-candidate-run";
const P03_RUN_ID = "sca-p03-candidate-run";
const REUSABLE_RUN_ID = "sca-p01-reusable-run";
const QUALIFICATION_RUN_ID = "sca-p01-qualification-run";
const CANDIDATE_PHASE = "sca-p01-candidate-admission";
const CANDIDATE_PRODUCER = "host:sca-p01-candidate";
const ARTIFACT_PROJECT_ID = "prj_11111111111111111111111111111111";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const P02_INTEGRATION_FIXTURE_LABEL = "p02-real-integration";
interface P02ScannerFixture {
  readonly executableContent: string;
  readonly counterPath: string;
}

interface P02ScannerFixtures {
  readonly semgrep: P02ScannerFixture;
  readonly gitleaks: P02ScannerFixture;
}

function p02ScannerFixtures(): P02ScannerFixtures {
  // Pinned execution uses a private copy and removes its staging. Retain invocation
  // evidence in a separate test-owned root, disposed by the ordinary fixture cleanup.
  const counterRoot = temporaryRoot("p02-invocation-counters");
  const scanner = (name: string, stdout: string): P02ScannerFixture => {
    const counterPath = path.join(counterRoot, `${name}.calls`);
    return {
      counterPath,
      executableContent: [
        `#!${process.execPath}`,
        `require('node:fs').appendFileSync(${JSON.stringify(counterPath)}, '1');`,
        `process.stdout.write(${JSON.stringify(stdout)});`,
        "",
      ].join("\n"),
    };
  };
  return {
    semgrep: scanner("semgrep", JSON.stringify({ results: [], errors: [] })),
    gitleaks: scanner("gitleaks", "[]"),
  };
}
const P03_SIMULATED_JOERN_EXECUTABLE = "penny-simulated-joern-test-runtime-v1\n";
const roots: string[] = [];
const stores: ArtifactStore[] = [];
const integrationProjectIds = new WeakMap<ArtifactStore, string>();
const integrationStateRoots = new WeakMap<ArtifactStore, string>();
const artifactRoots = new WeakMap<ArtifactStore, string>();

interface Fixture {
  readonly store: ArtifactStore;
  readonly request: ScaP01AdmissionRequestV3;
  readonly qualification: ScaPhaseQualificationRecordV2;
  readonly values: Readonly<Record<string, unknown>>;
  readonly refs: Readonly<Record<string, ArtifactRef>>;
}

function temporaryRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `penny-p01-${label}-`));
  roots.push(root);
  return root;
}

function artifactStore(label: string): ArtifactStore {
  const root = temporaryRoot(label);
  let projectId = ARTIFACT_PROJECT_ID;
  let stateRoot: string | null = null;
  if (label === P02_INTEGRATION_FIXTURE_LABEL) {
    stateRoot = path.join(root, "state");
    const catalog = new ProjectCatalog(stateRoot, { create: true });
    projectId = catalog.registerProject(root).projectId;
    catalog.close();
  }
  const storeRoot = path.join(root, "artifacts");
  const store = ArtifactStore.provision(storeRoot, { projectId });
  stores.push(store);
  artifactRoots.set(store, storeRoot);
  if (stateRoot !== null) {
    integrationProjectIds.set(store, projectId);
    integrationStateRoots.set(store, stateRoot);
  }
  return store;
}

function sortedRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function requiredRef(refs: Readonly<Record<string, ArtifactRef>>, key: string): ArtifactRef {
  const ref = refs[key];
  if (ref === undefined) throw new Error(`fixture ref '${key}' is absent`);
  return ref;
}

function requiredValue(values: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!(key in values)) throw new Error(`fixture value '${key}' is absent`);
  return values[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function requiredRecord(
  values: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> {
  const value = requiredValue(values, key);
  if (!isRecord(value)) throw new Error(`fixture value '${key}' is not an object`);
  return value;
}

function artifactMetadata(input: {
  readonly runId: string;
  readonly kind: string;
  readonly operationId: string;
  readonly schemaId: string;
  readonly schemaVersion?: number;
  readonly producer: string;
  readonly mediaType?: string;
  readonly phase?: string;
  readonly version?: number;
  readonly parentRef?: ArtifactRef | null;
  readonly upstreamRefs?: readonly ArtifactRef[];
}): OutputArtifactMetadata {
  return {
    schema_version: 2,
    run_id: input.runId,
    phase: input.phase ?? "sca-p01-fixture",
    branch_id: null,
    kind: input.kind,
    operation_id: input.operationId,
    version: input.version ?? 1,
    producer: input.producer,
    media_type: input.mediaType ?? "application/json",
    content_schema: {
      schema_id: input.schemaId,
      schema_version: input.schemaVersion ?? 1,
    },
    parent_ref: input.parentRef ?? null,
    upstream_refs: sortedRefs(input.upstreamRefs ?? []),
  };
}

function persistJson(
  store: ArtifactStore,
  input: {
    readonly runId: string;
    readonly kind: string;
    readonly operationId: string;
    readonly schemaId: string;
    readonly schemaVersion?: number;
    readonly producer: string;
    readonly value: unknown;
    readonly phase?: string;
    readonly version?: number;
    readonly parentRef?: ArtifactRef | null;
    readonly upstreamRefs?: readonly ArtifactRef[];
  }
): ArtifactRef {
  return store.persist({
    metadata: artifactMetadata(input),
    content: canonicalJson(input.value),
  });
}

function persistBytes(
  store: ArtifactStore,
  input: {
    readonly runId: string;
    readonly kind: string;
    readonly operationId: string;
    readonly schemaId: string;
    readonly producer: string;
    readonly mediaType: string;
    readonly content: Uint8Array | string;
    readonly upstreamRefs?: readonly ArtifactRef[];
  }
): ArtifactRef {
  return store.persist({
    metadata: artifactMetadata({
      runId: input.runId,
      kind: input.kind,
      operationId: input.operationId,
      schemaId: input.schemaId,
      producer: input.producer,
      mediaType: input.mediaType,
      ...(input.upstreamRefs === undefined ? {} : { upstreamRefs: input.upstreamRefs }),
    }),
    content: input.content,
  });
}

const ZERO_DISPATCH_PROBE = Object.freeze({
  snapshot: () => ({ model: 0, scanner: 0, application: 0 }),
});

function campaignCandidateRef(store: ArtifactHostStore, operationId: string): ArtifactRef | null {
  return store.refFor(RUN_ID, CANDIDATE_PHASE, null, operationId, operationId, 1);
}

function candidateLedgerRevisionRef(store: ArtifactHostStore, version: number): ArtifactRef | null {
  return store.refFor(
    RUN_ID,
    CANDIDATE_PHASE,
    null,
    "sca-p01-candidate-obligation-ledger",
    "sca-p01-candidate-obligation-ledger",
    version
  );
}

const CANDIDATE_OPERATIONS = [
  "sca-p01-candidate-request",
  "sca-p01-candidate-obligation-ledger",
  "sca-p01-candidate-manifest-core",
  "sca-p01-candidate-admission-evidence",
  "sca-p01-candidate-gate",
  "sca-p01-candidate-campaign-manifest",
] as const;
const PERSISTENCE_BOUNDARY_ORDINALS = [1, 2, 3, 4, 5, 6] as const;

function expectNoCandidateWrites(store: ArtifactHostStore): void {
  for (const operationId of CANDIDATE_OPERATIONS) {
    expect(campaignCandidateRef(store, operationId), operationId).toBeNull();
  }
}

function admitCandidate(input: {
  readonly store: ArtifactHostStore;
  readonly request: unknown;
  readonly options?: Parameters<typeof admitScaP01Candidate>[0]["options"];
}): ScaP01AdmissionResultV1 {
  return admitScaP01Candidate({
    store: input.store,
    request: input.request,
    options: {
      ...input.options,
      dispatchProbe: input.options?.dispatchProbe ?? ZERO_DISPATCH_PROBE,
    },
  });
}

function admissionError(input: {
  readonly store: ArtifactHostStore;
  readonly request: unknown;
  readonly options?: Parameters<typeof admitScaP01Candidate>[0]["options"];
  readonly withoutDispatchObserver?: boolean;
}): ScaP01AdmissionError {
  try {
    admitScaP01Candidate({
      store: input.store,
      request: input.request,
      options: {
        ...input.options,
        ...(input.withoutDispatchObserver === true || input.options?.dispatchProbe !== undefined
          ? {}
          : { dispatchProbe: ZERO_DISPATCH_PROBE }),
      },
    });
  } catch (error) {
    if (error instanceof ScaP01AdmissionError) return error;
    throw error;
  }
  throw new Error("P01 candidate admission unexpectedly succeeded");
}

function revisionError(
  input: Parameters<typeof reviseScaP01ObligationLedgerCandidate>[0]
): ScaP01AdmissionError {
  try {
    reviseScaP01ObligationLedgerCandidate(input);
  } catch (error) {
    if (error instanceof ScaP01AdmissionError) return error;
    throw error;
  }
  throw new Error("P01 candidate obligation revision unexpectedly succeeded");
}

function parsed(store: ArtifactHostStore, ref: ArtifactRef): unknown {
  const value: unknown = JSON.parse(store.readById(ref.artifact_id).toString("utf8"));
  return value;
}

function resultRefs(result: ScaP01AdmissionResultV1): readonly ArtifactRef[] {
  return [
    result.request_ref,
    result.obligation_ledger_ref,
    result.manifest_core_ref,
    result.admission_evidence_ref,
    result.p01_gate_ref,
    result.campaign_manifest_ref,
  ];
}

const P01_CANDIDATE_PLAYBOOK_NAME = "sca-p01-candidate-engine-qualification";
const P01_CANDIDATE_HOST_STATE = "sca_p01_admission";
const P01_CANDIDATE_DUMMY_WORKER_STATE = "unreachable_p02_worker";
const P01_CANDIDATE_INPUT_KIND = "sca-p01-candidate-input";
const P01_CANDIDATE_INPUT_OPERATION = "sca-p01-candidate-input";
const P01_CANDIDATE_INPUT_PRODUCER = "host:sca-p01-candidate-engine-qualification";
const P01_CANDIDATE_HOST_EVENT = "sca_p01_candidate_blocked_at_p02";
const P01_CANDIDATE_POST_CHECKPOINT = "sca_p01_admission:blocked_at_p02";
const P01_CANDIDATE_TENANT_ID = "tenant-p01";
const P01_CANDIDATE_PROJECT_ID = "project-p01";

interface CandidateDispatchCounts {
  model: number;
  scanner: number;
  application: number;
}

interface CandidateHarness {
  readonly dispatch: CandidateDispatchCounts;
  workerDispatches: number;
  initialRequestValidations: number;
  admissionCalls: number;
  readonly afterCheckpoint?: (point: string) => void;
}

interface ScaP01CandidatePlaybookDefinition {
  readonly name: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly hostState: string;
  construct(
    options: PlaybookConstructionOptions,
    harness: CandidateHarness
  ): ScaP01CandidatePlaybook;
}

const ScaP01CandidateTerminalResultV1Schema = Type.Object(
  {
    admitted_phase_id: Type.Literal("SCA-P01"),
    p01_status: Type.Literal("passed"),
    next_required_phase_id: Type.Literal("SCA-P02"),
    terminal_reason: Type.Literal("blocked_at_p02"),
    m1_status: Type.Literal("not_reached"),
    sca_completion_claimed: Type.Literal(false),
  },
  { additionalProperties: false }
);

const P01_CANDIDATE_SKILL_CONTRACT: SkillContract = {
  schema_version: 2,
  name: P01_CANDIDATE_PLAYBOOK_NAME,
  objective:
    "Qualify the inactive deterministic SCA P01 candidate through the canonical engine without worker dispatch.",
  io: {
    request: {
      schema_version: 1,
      name: "request",
      direction: "input",
      transport: "inline_request",
      schema_id: "penny.test-sca-p01-candidate-engine-request.v1",
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
        name: "sca_p01_admission_request",
        direction: "input",
        transport: "artifact",
        schema_id: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
        schema_version_required: 3,
        artifact_kind: P01_CANDIDATE_INPUT_KIND,
        source: "caller",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
    ],
    active_output_ports: [
      {
        schema_version: 1,
        name: "candidate_request",
        direction: "output",
        transport: "artifact",
        schema_id: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
        schema_version_required: 3,
        artifact_kind: "sca-p01-candidate-request",
        source: "skill",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
      {
        schema_version: 1,
        name: "obligation_ledger",
        direction: "output",
        transport: "artifact",
        schema_id: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
        schema_version_required: 2,
        artifact_kind: "sca-p01-candidate-obligation-ledger",
        source: "skill",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
      {
        schema_version: 1,
        name: "manifest_core",
        direction: "output",
        transport: "artifact",
        schema_id: SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
        schema_version_required: 1,
        artifact_kind: "sca-p01-candidate-manifest-core",
        source: "skill",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
      {
        schema_version: 1,
        name: "admission_evidence",
        direction: "output",
        transport: "artifact",
        schema_id: SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
        schema_version_required: 1,
        artifact_kind: "sca-p01-candidate-admission-evidence",
        source: "skill",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
      {
        schema_version: 1,
        name: "p01_gate",
        direction: "output",
        transport: "artifact",
        schema_id: SCA_PHASE_GATE_RECORD_V2_SCHEMA,
        schema_version_required: 2,
        artifact_kind: "sca-p01-candidate-gate",
        source: "skill",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
      {
        schema_version: 1,
        name: "campaign_manifest",
        direction: "output",
        transport: "artifact",
        schema_id: SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
        schema_version_required: 2,
        artifact_kind: "sca-p01-candidate-campaign-manifest",
        source: "skill",
        min_items: 1,
        max_items: 1,
        semantic_product: false,
      },
    ],
  },
  behavior: {
    side_effects: {
      external_reads: "host_policy_only",
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
    skill_root: "apps/orchestration/tests/fixtures/skills/generic-ingress/prompts",
    resolution: "per_agent_phase",
  },
  budget_policy: {
    schema_version: 1,
    policy_id: "penny.test-sca-p01-candidate-budget.v1",
    resolver_id: "scaP01CandidateTestResolver",
    admission_id: "scaP01CandidateTestAdmission",
    snapshot_id: "scaP01CandidateTestSnapshot",
  },
  repair_routing: { schema_version: 1, routes: [] },
  completion_gate: {
    schema_version: 2,
    allowed_terminal_origins: [P01_CANDIDATE_DUMMY_WORKER_STATE],
    required_visited_states: [P01_CANDIDATE_DUMMY_WORKER_STATE],
    required_receipt_predicates: [],
    latest_product: {
      selector: "terminal_result",
      schema_id: "penny.test-sca-p01-candidate-positive-terminal.v1",
      product_schema_version: 1,
    },
    unresolved_policy: { mode: "max_count", max_count: 0 },
  },
};

function candidateHarness(afterCheckpoint?: (point: string) => void): CandidateHarness {
  return {
    dispatch: { model: 0, scanner: 0, application: 0 },
    workerDispatches: 0,
    initialRequestValidations: 0,
    admissionCalls: 0,
    ...(afterCheckpoint === undefined ? {} : { afterCheckpoint }),
  };
}

function sameExactRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateCandidateResultRefs(
  store: ArtifactHostStore,
  result: ScaP01AdmissionResultV1
): readonly ArtifactRef[] {
  const outputs = [
    {
      ref: result.request_ref,
      kind: "sca-p01-candidate-request",
      schemaId: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
      schemaVersion: 3,
      validate: validateScaP01AdmissionRequestV3,
    },
    {
      ref: result.obligation_ledger_ref,
      kind: "sca-p01-candidate-obligation-ledger",
      schemaId: SCA_OBLIGATION_LEDGER_V2_SCHEMA,
      schemaVersion: 2,
      validate: validateScaObligationLedgerV2,
    },
    {
      ref: result.manifest_core_ref,
      kind: "sca-p01-candidate-manifest-core",
      schemaId: SCA_CAMPAIGN_MANIFEST_CORE_V1_SCHEMA,
      schemaVersion: 1,
      validate: validateScaCampaignManifestCoreV1,
    },
    {
      ref: result.admission_evidence_ref,
      kind: "sca-p01-candidate-admission-evidence",
      schemaId: SCA_P01_ADMISSION_EVIDENCE_V1_SCHEMA,
      schemaVersion: 1,
      validate: validateScaP01AdmissionEvidenceV1,
    },
    {
      ref: result.p01_gate_ref,
      kind: "sca-p01-candidate-gate",
      schemaId: SCA_PHASE_GATE_RECORD_V2_SCHEMA,
      schemaVersion: 2,
      validate: validateScaPhaseGateRecordV2,
    },
    {
      ref: result.campaign_manifest_ref,
      kind: "sca-p01-candidate-campaign-manifest",
      schemaId: SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
      schemaVersion: 2,
      validate: validateScaCampaignManifestV2,
    },
  ] as const;

  for (const output of outputs) {
    const current = store.refById(output.ref.artifact_id);
    if (current === undefined || !sameExactRef(current, output.ref)) {
      throw new Error(`candidate output '${output.kind}' is not the exact current manifest ref`);
    }
    const metadata = store.metadata(output.ref);
    if (
      metadata.run_id !== RUN_ID ||
      metadata.phase !== CANDIDATE_PHASE ||
      metadata.branch_id !== null ||
      metadata.kind !== output.kind ||
      metadata.operation_id !== output.kind ||
      metadata.version !== 1 ||
      metadata.producer !== CANDIDATE_PRODUCER ||
      metadata.media_type !== "application/json" ||
      metadata.content_schema?.schema_id !== output.schemaId ||
      metadata.content_schema.schema_version !== output.schemaVersion
    ) {
      throw new Error(`candidate output '${output.kind}' metadata is not exact`);
    }
    const bytes = store.readById(output.ref.artifact_id);
    if (
      bytes.byteLength !== output.ref.byte_length ||
      sha256(bytes) !== output.ref.content_digest
    ) {
      throw new Error(`candidate output '${output.kind}' bytes do not match its ref`);
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const validated = output.validate(value);
    if (bytes.toString("utf8") !== canonicalJson(validated)) {
      throw new Error(`candidate output '${output.kind}' is not canonical JSON`);
    }
  }
  return outputs.map((output) => output.ref);
}

class ScaP01CandidatePlaybook implements PlaybookCore, HostContinuationCapabilityV1 {
  constructor(
    private readonly definition: ScaP01CandidatePlaybookDefinition,
    private readonly store: ArtifactHostStore,
    private readonly harness: CandidateHarness
  ) {}

  initialize(context: RunContext): Directive {
    context.transition(this.definition.hostState);
    const next = validateDirective({
      schema_version: 2,
      action: "status",
      identity: context.identity,
      status: "running",
      state_id: this.definition.hostState,
      terminal: false,
      met: false,
    });
    context.pendingDirective = next;
    return next;
  }

  dispatch(): Directive {
    this.harness.workerDispatches += 1;
    throw new Error("the P01 candidate dummy worker phase is unreachable");
  }

  resume(): Directive {
    throw new Error("the P01 candidate has no user gate");
  }

  cancel(context: RunContext, reason: string): Directive {
    context.previousState = context.stateId;
    context.stateId = "cancelled";
    context.status = "cancelled";
    context.met = false;
    context.pendingBranches = [];
    const next = validateDirective({
      schema_version: 2,
      action: "cancelled",
      identity: context.identity,
      status: "cancelled",
      met: false,
      result: { terminal_reason: "cancelled", sca_completion_claimed: false },
      artifacts: [],
      unresolved: [reason],
    });
    context.pendingDirective = next;
    context.terminalDirective = next;
    return next;
  }

  acceptSummary(): Directive {
    throw new Error("the P01 candidate never accepts worker summaries");
  }

  rebindPendingDirective(context: RunContext): Directive | null {
    return context.pendingDirective;
  }

  needsHostContinuation(context: RunContext): boolean {
    return context.stateId === this.definition.hostState && context.terminalDirective === null;
  }

  continueHost(context: RunContext): HostContinuationStepV1 {
    if (!this.needsHostContinuation(context)) {
      throw new Error(`P01 candidate state '${context.stateId}' has no host continuation`);
    }
    const request = this.readExactInitialRequest(context);
    this.harness.initialRequestValidations += 1;
    this.harness.admissionCalls += 1;
    const result = admitScaP01Candidate({
      store: this.store,
      request,
      options: { dispatchProbe: { snapshot: () => ({ ...this.harness.dispatch }) } },
    });
    const refs = validateCandidateResultRefs(this.store, result);
    for (const ref of refs) {
      if (!context.selectedArtifacts.some((selected) => selected.artifact_id === ref.artifact_id)) {
        context.selectedArtifacts.push(ref);
      }
    }
    const terminalResult = validateContract(
      ScaP01CandidateTerminalResultV1Schema,
      {
        admitted_phase_id: "SCA-P01",
        p01_status: "passed",
        next_required_phase_id: "SCA-P02",
        terminal_reason: "blocked_at_p02",
        m1_status: "not_reached",
        sca_completion_claimed: false,
      },
      "SCA P01 candidate terminal result"
    );
    context.previousState = context.stateId;
    context.stateId = "incomplete";
    context.status = "incomplete";
    context.met = false;
    context.pendingBranches = [];
    const terminal = validateDirective({
      schema_version: 2,
      action: "incomplete",
      identity: context.identity,
      status: "incomplete",
      met: false,
      result: terminalResult,
      artifacts: [...refs],
      unresolved: ["SCA-P02 is not implemented by this candidate-only harness."],
    });
    context.pendingDirective = terminal;
    context.terminalDirective = terminal;
    return {
      event_type: P01_CANDIDATE_HOST_EVENT,
      payload: {
        run_id: context.identity.run_id,
        admitted_phase_id: "SCA-P01",
        next_required_phase_id: "SCA-P02",
        terminal_reason: "blocked_at_p02",
        selected_candidate_refs: refs.length,
      },
      directive: terminal,
      after_checkpoint_fault: P01_CANDIDATE_POST_CHECKPOINT,
    };
  }

  hostCheckpointCommitted(_context: RunContext, point: string): void {
    this.harness.afterCheckpoint?.(point);
  }

  private readExactInitialRequest(context: RunContext): ScaP01AdmissionRequestV3 {
    const inputs = context.selectedArtifacts.filter((ref) => ref.kind === P01_CANDIDATE_INPUT_KIND);
    const ref = inputs[0];
    if (context.selectedArtifacts.length !== 1 || inputs.length !== 1 || ref === undefined) {
      throw new Error("P01 candidate requires exactly one selected initial request artifact");
    }
    const current = this.store.refById(ref.artifact_id);
    if (current === undefined || !sameExactRef(current, ref)) {
      throw new Error("P01 candidate initial request ref is absent, stale, or not exact");
    }
    const bytes = this.store.readById(ref.artifact_id);
    if (bytes.byteLength !== ref.byte_length || sha256(bytes) !== ref.content_digest) {
      throw new Error("P01 candidate initial request bytes do not match the exact ref");
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const request = validateScaP01AdmissionRequestV3(value);
    const expectedMetadata = artifactMetadata({
      runId: context.identity.run_id,
      phase: this.definition.hostState,
      kind: P01_CANDIDATE_INPUT_KIND,
      operationId: P01_CANDIDATE_INPUT_OPERATION,
      schemaId: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
      schemaVersion: 3,
      producer: P01_CANDIDATE_INPUT_PRODUCER,
      upstreamRefs: scaP01AdmissionRequestRefs(request),
    });
    const metadata = this.store.metadata(ref);
    const canonicalRequest = canonicalJson(request);
    const expectedRef = previewArtifactRef({
      metadata: expectedMetadata,
      content: canonicalRequest,
    });
    if (
      bytes.toString("utf8") !== canonicalRequest ||
      canonicalJson(metadata) !== canonicalJson(expectedMetadata) ||
      !sameExactRef(ref, expectedRef)
    ) {
      throw new Error("P01 candidate initial request bytes or metadata are not exact");
    }
    if (
      context.identity.playbook !== this.definition.name ||
      request.tenant_id !== this.definition.tenantId ||
      request.project_id !== this.definition.projectId ||
      request.run_id !== context.identity.run_id
    ) {
      throw new Error("P01 candidate request identity does not match the engine identity");
    }
    return request;
  }
}

const P01_CANDIDATE_DEFINITION: ScaP01CandidatePlaybookDefinition = {
  name: P01_CANDIDATE_PLAYBOOK_NAME,
  tenantId: P01_CANDIDATE_TENANT_ID,
  projectId: P01_CANDIDATE_PROJECT_ID,
  hostState: P01_CANDIDATE_HOST_STATE,
  construct: (options, harness) => {
    if (options.artifactStore === undefined) {
      throw new Error("P01 candidate construction requires canonical artifact-store custody");
    }
    return new ScaP01CandidatePlaybook(P01_CANDIDATE_DEFINITION, options.artifactStore, harness);
  },
};

const P01_CANDIDATE_START_ADMISSION = passthroughStartAdmission({
  schema_id: P01_CANDIDATE_SKILL_CONTRACT.io.request.schema_id,
  schema_version: P01_CANDIDATE_SKILL_CONTRACT.io.request.schema_version_required,
});

function candidateRegistration(harness: CandidateHarness): PlaybookRegistration {
  return {
    name: P01_CANDIDATE_PLAYBOOK_NAME,
    contract: P01_CANDIDATE_SKILL_CONTRACT,
    ingress: "skill",
    start_admission: {
      ...P01_CANDIDATE_START_ADMISSION,
      prepare: (request, host) => {
        if (Object.keys(request.constraints).length !== 0) {
          throw new Error("P01 candidate engine request constraints must be empty");
        }
        return P01_CANDIDATE_START_ADMISSION.prepare(request, host);
      },
    },
    liveness: {
      resolver_id: P01_CANDIDATE_SKILL_CONTRACT.budget_policy.resolver_id,
      resolve: () => undefined,
      thinking_policy: "agent_ssot",
    },
    worker: {
      kind: "catalog-agent",
      workflow_name: P01_CANDIDATE_PLAYBOOK_NAME,
      guidance: P01_CANDIDATE_SKILL_CONTRACT.guidance,
      guidance_required: true,
      result_transport: "persisted_summary",
      opening_policy: "registration_guidance_task_artifacts",
      model_policy: "directive_override_or_runtime_default",
      phases: new Map([
        [
          P01_CANDIDATE_DUMMY_WORKER_STATE,
          {
            agent: "echo",
            result_schema_id: "penny.test-sca-p01-candidate-unreachable.v1",
            result_schema_version: 1,
            schema: Type.Object(
              { unreachable: Type.Literal(true) },
              { additionalProperties: false }
            ),
          },
        ],
      ]),
    },
    host_states: [P01_CANDIDATE_HOST_STATE],
    completionReceiptPredicates: new Map(),
    construct: (options) => P01_CANDIDATE_DEFINITION.construct(options, harness),
  };
}

function candidateIdentity(): RunIdentity {
  return {
    schema_version: 2,
    run_id: RUN_ID,
    session_id: "session-sca-p01-candidate-engine-qualification",
    playbook: P01_CANDIDATE_PLAYBOOK_NAME,
    engine_owner: "typescript",
  };
}

function persistCandidateInitialRequest(setup: Fixture): ArtifactRef {
  return persistJson(setup.store, {
    runId: RUN_ID,
    phase: P01_CANDIDATE_HOST_STATE,
    kind: P01_CANDIDATE_INPUT_KIND,
    operationId: P01_CANDIDATE_INPUT_OPERATION,
    schemaId: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
    schemaVersion: 3,
    producer: P01_CANDIDATE_INPUT_PRODUCER,
    value: setup.request,
    upstreamRefs: scaP01AdmissionRequestRefs(setup.request),
  });
}

function candidateEngine(input: {
  readonly checkpointer: Checkpointer;
  readonly projectRoot: string;
  readonly store: ArtifactHostStore;
  readonly harness: CandidateHarness;
}): OrchestrationEngine {
  return new OrchestrationEngine(input.checkpointer, {
    projectRoot: input.projectRoot,
    maxSteps: 8,
    receiptAuthority: TEST_RECEIPT_AUTHORITY,
    artifactRevisions: input.store,
    artifactStore: input.store,
    artifactReader: input.store,
    playbookRegistration: candidateRegistration(input.harness),
  });
}

function startCandidate(
  engine: OrchestrationEngine,
  projectRoot: string,
  requestRef: ArtifactRef
): Directive {
  return engine.handle({
    schema_version: 2,
    action: "start",
    identity: candidateIdentity(),
    goal: "Qualify the inactive deterministic SCA P01 candidate.",
    constraints: {},
    project_root: projectRoot,
    trust_profile: "hardened-untrusted",
    input_artifacts: {
      schema_version: 2,
      artifacts: [{ slot: "sca-p01-admission-request", ref: requestRef }],
    },
  });
}

function recoverCandidate(engine: OrchestrationEngine): Directive {
  return engine.handle({ schema_version: 2, action: "recover", identity: candidateIdentity() });
}

type CandidateTerminalDirective = Static<typeof TerminalDirectiveSchema>;

function requireIncompleteCandidate(value: Directive): CandidateTerminalDirective {
  if (value.action !== "incomplete") {
    throw new Error(`expected incomplete P01 candidate terminal, received '${value.action}'`);
  }
  return value;
}

function currentCandidateRefs(store: ArtifactHostStore): ArtifactRef[] {
  return CANDIDATE_OPERATIONS.map((operationId) => {
    const ref = campaignCandidateRef(store, operationId);
    if (ref === null) throw new Error(`candidate ref '${operationId}' is absent`);
    return ref;
  });
}

function expectBlockedAtP02(terminal: CandidateTerminalDirective): void {
  expect(terminal).toMatchObject({
    action: "incomplete",
    status: "incomplete",
    met: false,
    result: {
      admitted_phase_id: "SCA-P01",
      p01_status: "passed",
      next_required_phase_id: "SCA-P02",
      terminal_reason: "blocked_at_p02",
      m1_status: "not_reached",
      sca_completion_claimed: false,
    },
    unresolved: ["SCA-P02 is not implemented by this candidate-only harness."],
  });
}

function persistSourceMaterial(input: {
  readonly store: ArtifactStore;
  readonly runId: string;
  readonly operationPrefix: string;
  readonly snapshotId: string;
  readonly scope: {
    readonly include_paths: readonly string[];
    readonly exclude_paths: readonly string[];
  };
  readonly files: readonly { readonly path: string; readonly content: string }[];
}) {
  const identities = input.files.map((file) => {
    const bytes = Buffer.from(file.content, "utf8");
    return {
      path: file.path,
      byte_count: bytes.byteLength,
      content_sha256: sha256(bytes),
    };
  });
  const byteCount = identities.reduce((total, file) => total + file.byte_count, 0);
  const treeDigest = scaP01SourceTreeDigest(identities);
  const manifest = {
    schema_id: SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
    schema_version: 1,
    snapshot_id: input.snapshotId,
    scope: input.scope,
    files: identities,
    file_count: identities.length,
    byte_count: byteCount,
    tree_sha256: treeDigest,
  };
  const manifestRef = persistJson(input.store, {
    runId: input.runId,
    kind: "sca-p01-source-file-manifest",
    operationId: `${input.operationPrefix}-file-manifest`,
    schemaId: SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
    value: manifest,
  });
  const custody = {
    schema_id: SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
    schema_version: 1,
    custody_id: `${input.operationPrefix}-custody`,
    snapshot_id: input.snapshotId,
    file_manifest_ref: manifestRef,
    files: input.files.map((file, index) => {
      const identity = identities[index];
      if (identity === undefined) throw new Error("source identity fixture is sparse");
      return {
        path: file.path,
        encoding: "base64",
        content_base64: Buffer.from(file.content, "utf8").toString("base64"),
        byte_count: identity.byte_count,
        content_sha256: identity.content_sha256,
      };
    }),
    file_count: identities.length,
    byte_count: byteCount,
    tree_sha256: treeDigest,
    sealed: true,
  };
  const custodyRef = persistJson(input.store, {
    runId: input.runId,
    kind: "sca-p01-source-custody-corpus",
    operationId: `${input.operationPrefix}-custody`,
    schemaId: SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
    value: custody,
    upstreamRefs: [manifestRef],
  });
  const snapshot = {
    schema_id: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
    schema_version: 2,
    snapshot_id: input.snapshotId,
    tree_sha256: treeDigest,
    file_manifest_ref: manifestRef,
    file_manifest_sha256: manifestRef.content_digest,
    custody_ref: custodyRef,
    custody_sha256: custodyRef.content_digest,
    scope: input.scope,
    file_count: identities.length,
    byte_count: byteCount,
    status: "frozen",
  };
  const snapshotRef = persistJson(input.store, {
    runId: input.runId,
    kind: "source-snapshot",
    operationId: input.operationPrefix,
    schemaId: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
    schemaVersion: 2,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
    value: snapshot,
    upstreamRefs: [manifestRef, custodyRef],
  });
  return { manifest, manifestRef, custody, custodyRef, snapshot, snapshotRef };
}

function policyValues() {
  return {
    profile: {
      schema_id: SCA_ANALYSIS_PROFILE_V1_SCHEMA,
      schema_version: 1,
      profile_id: "php-js-ts-profile",
      trust_status: "host-declared",
      status: "approved",
      languages: ["javascript", "php", "typescript"],
      frameworks: [
        { framework_id: "express", language: "javascript", support_status: "supported" },
        { framework_id: "wordpress", language: "php", support_status: "supported" },
        { framework_id: "nestjs", language: "typescript", support_status: "supported" },
      ],
    },
    ruleRelease: {
      schema_id: SCA_RULE_RELEASE_V1_SCHEMA,
      schema_version: 1,
      release_id: "rule-release-2026-09",
      trust_status: "host-declared",
      status: "approved",
      immutable: true,
      languages: ["javascript", "php", "typescript"],
    },
    ruleProfile: {
      schema_id: SCA_RULE_PROFILE_V1_SCHEMA,
      schema_version: 1,
      rule_profile_id: "rule-profile-web",
      trust_status: "host-declared",
      status: "approved",
      analysis_profile_id: "php-js-ts-profile",
      rule_release_id: "rule-release-2026-09",
      languages: ["javascript", "php", "typescript"],
    },
    toolchain: {
      schema_id: SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
      schema_version: 1,
      toolchain_id: "toolchain-qualified-2026-09",
      trust_status: "host-declared",
      status: "approved",
      analysis_profile_id: "php-js-ts-profile",
      source_posture: "read-only",
      package_acquisition: "forbidden",
      target_startup: "forbidden",
      tools: [
        {
          tool_id: "parser-js",
          role: "parser",
          version: "tree-sitter-js-1",
          languages: ["javascript", "typescript"],
          target_execution: "forbidden",
          network_access: "denied",
          acquisition: "preinstalled-only",
        },
        {
          tool_id: "parser-php",
          role: "parser",
          version: "tree-sitter-php-1",
          languages: ["php"],
          target_execution: "forbidden",
          network_access: "denied",
          acquisition: "preinstalled-only",
        },
        {
          tool_id: "scanner-js",
          role: "scanner",
          version: "semgrep-ce-1",
          languages: ["javascript", "typescript"],
          target_execution: "forbidden",
          network_access: "denied",
          acquisition: "preinstalled-only",
        },
        {
          tool_id: "scanner-php",
          role: "scanner",
          version: "semgrep-ce-1",
          languages: ["php"],
          target_execution: "forbidden",
          network_access: "denied",
          acquisition: "preinstalled-only",
        },
      ],
    },
    network: {
      schema_id: SCA_NETWORK_POLICY_V1_SCHEMA,
      schema_version: 1,
      policy_id: "network-default-deny",
      trust_status: "host-declared",
      status: "approved",
      default_action: "deny",
      scanner_posture: "offline",
      parser_posture: "offline",
      package_acquisition: "forbidden",
      target_startup: "forbidden",
      dependency_coordinate_lookup: "separate-admission-required",
    },
    privacy: {
      schema_id: SCA_PRIVACY_POLICY_V1_SCHEMA,
      schema_version: 1,
      policy_id: "privacy-confidential-source",
      trust_status: "host-declared",
      status: "approved",
      source_classification: "confidential",
      local_retention_days: 30,
      secrets_treatment: "redact-and-deny-disclosure",
      personal_data_treatment: "minimize-and-require-explicit-disclosure",
    },
    modelData: {
      schema_id: SCA_MODEL_DATA_POLICY_V1_SCHEMA,
      schema_version: 1,
      policy_id: "model-data-known-treatment",
      trust_status: "host-declared",
      status: "approved",
      model_alias: "deepseek-flash",
      provider: "ollama",
      model: "deepseek-v4.1-flash:cloud",
      destination_class: "cloud",
      provider_retention_status: "known",
      provider_retention_days: 30,
      provider_training_use: "prohibited",
      data_classes: [
        { data_class: "dependency-coordinates", treatment: "allow-minimized" },
        { data_class: "personal-data", treatment: "deny" },
        { data_class: "scanner-evidence", treatment: "allow-minimized" },
        { data_class: "secrets", treatment: "deny" },
        { data_class: "source-code", treatment: "allow-redacted" },
      ],
      payload_limit_bytes: 1_048_576,
    },
    resource: {
      schema_id: SCA_RESOURCE_POLICY_V1_SCHEMA,
      schema_version: 1,
      policy_id: "resource-finite",
      trust_status: "host-declared",
      status: "approved",
      cpu_millis: 120_000,
      memory_bytes: 536_870_912,
      process_count: 16,
      storage_bytes: 1_073_741_824,
      output_bytes: 67_108_864,
      concurrency: 2,
      operation_inactivity_ms: 30_000,
    },
    output: {
      schema_id: SCA_OUTPUT_POLICY_V1_SCHEMA,
      schema_version: 1,
      policy_id: "output-safe-namespace",
      trust_status: "host-declared",
      status: "approved",
      report_namespace: "sca-report-candidate",
      namespace_owner: "caller",
      overwrite: "deny",
      symbolic_links: "deny",
      source_overlap: "deny",
    },
    authority: {
      schema_id: SCA_AUTHORITY_POLICY_V1_SCHEMA,
      schema_version: 1,
      policy_id: "authority-p01-admission",
      trust_status: "host-declared",
      status: "approved",
      tenant_id: "tenant-p01",
      project_id: "project-p01",
      admission_authority_id: "authority-admission",
      admission_lineage_id: "lineage-admission",
      admission_decision: "allow",
      grants: [
        {
          authority_id: "authority-execution",
          lineage_id: "lineage-execution",
          role: "execution",
          posture: "separate-gate-required",
          scope: "sca-execution-policy-binding",
        },
        {
          authority_id: "authority-promotion",
          lineage_id: "lineage-promotion",
          role: "promotion",
          posture: "separate-gate-required",
          scope: "sca-rule-promotion",
        },
        {
          authority_id: "authority-release",
          lineage_id: "lineage-release",
          role: "release",
          posture: "separate-gate-required",
          scope: "sca-campaign-release",
        },
      ],
      rationale:
        "Distinct host authorities admit policy binding without authorizing later actions.",
    },
  };
}

function fixture(
  label: string,
  p02Scanners: P02ScannerFixtures | undefined = label === P02_INTEGRATION_FIXTURE_LABEL
    ? p02ScannerFixtures()
    : undefined
): Fixture {
  const store = artifactStore(label);
  const refs: Record<string, ArtifactRef> = {};
  const values: Record<string, unknown> = {};

  const campaignSource = persistSourceMaterial({
    store,
    runId: RUN_ID,
    operationPrefix: "campaign-source",
    snapshotId: "campaign-source-1",
    scope: { include_paths: ["app", "packages/security"], exclude_paths: ["app/generated"] },
    files: [
      ...(label === P02_INTEGRATION_FIXTURE_LABEL
        ? [
            {
              path: "app/composer.json",
              content: canonicalJson({ require: { "vendor/example": "^1.0" } }),
            },
            {
              path: "app/composer.lock",
              content: canonicalJson({
                packages: [{ name: "vendor/example", version: "1.2.3" }],
                "packages-dev": [],
              }),
            },
          ]
        : []),
      { path: "app/index.php", content: "<?php echo 'campaign';\n" },
      ...(label === P02_INTEGRATION_FIXTURE_LABEL
        ? [
            {
              path: "app/package-lock.json",
              content: canonicalJson({
                name: "p02-fixture",
                version: "1.0.0",
                lockfileVersion: 3,
                packages: {
                  "": { dependencies: { lodash: "4.17.21" } },
                  "node_modules/lodash": { version: "4.17.21" },
                },
              }),
            },
            {
              path: "app/package.json",
              content: canonicalJson({ dependencies: { lodash: "4.17.21" } }),
            },
          ]
        : []),
      { path: "packages/security/check.ts", content: "export const secure = true;\n" },
    ],
  });
  values.sourceManifest = campaignSource.manifest;
  values.sourceCustody = campaignSource.custody;
  values.source = campaignSource.snapshot;
  refs.sourceManifest = campaignSource.manifestRef;
  refs.sourceCustody = campaignSource.custodyRef;
  refs.source = campaignSource.snapshotRef;
  values.provenance = {
    schema_id: SCA_SOURCE_PROVENANCE_V1_SCHEMA,
    schema_version: 1,
    snapshot_ref: refs.source,
    file_manifest_ref: refs.sourceManifest,
    custody_ref: refs.sourceCustody,
    custody_sha256: refs.sourceCustody.content_digest,
    capture_method: "host-frozen",
    custody_status: "verified",
  };
  refs.provenance = persistJson(store, {
    runId: RUN_ID,
    kind: "source-provenance",
    operationId: "campaign-source-provenance",
    schemaId: SCA_SOURCE_PROVENANCE_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
    value: values.provenance,
    upstreamRefs: [refs.source, refs.sourceManifest, refs.sourceCustody],
  });

  const policyBase = policyValues();
  const toolchainTools = [
    ...(label === P02_INTEGRATION_FIXTURE_LABEL
      ? [
          ...policyBase.toolchain.tools,
          {
            tool_id: "scanner-semgrep-p02",
            role: "scanner",
            version: "semgrep-fixture-1",
            languages: ["javascript", "php", "typescript"],
            target_execution: "forbidden",
            network_access: "denied",
            acquisition: "preinstalled-only",
          },
          {
            tool_id: "scanner-gitleaks-p02",
            role: "scanner",
            version: "gitleaks-fixture-1",
            languages: ["javascript", "php", "typescript"],
            target_execution: "forbidden",
            network_access: "denied",
            acquisition: "preinstalled-only",
          },
          {
            tool_id: "parser-joern-p03",
            role: "parser",
            version: "4.0.627",
            languages: ["javascript", "php", "typescript"],
            target_execution: "forbidden",
            network_access: "denied",
            acquisition: "preinstalled-only",
          },
        ]
      : policyBase.toolchain.tools),
  ].sort((left, right) => left.tool_id.localeCompare(right.tool_id));
  values.profile = policyBase.profile;
  refs.profile = persistJson(store, {
    runId: REUSABLE_RUN_ID,
    kind: "sca-analysis-profile",
    operationId: "profile",
    schemaId: SCA_ANALYSIS_PROFILE_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_PRODUCERS.profile,
    value: policyBase.profile,
  });

  const ruleBundle = {
    schema_id: SCA_P01_RULE_BUNDLE_V1_SCHEMA,
    schema_version: 1,
    bundle_id: "rule-bundle-2026-09",
    release_id: "rule-release-2026-09",
    immutable: true,
    rules: [
      ...(label === P02_INTEGRATION_FIXTURE_LABEL
        ? [
            {
              rule_id: "gitleaks-configuration",
              language: "php",
              encoding: "base64",
              content_base64: Buffer.from("[allowlist]\n", "utf8").toString("base64"),
              content_sha256: sha256("[allowlist]\n"),
            },
          ]
        : []),
      {
        rule_id: "rule-javascript-xss",
        language: "javascript",
        encoding: "base64",
        content_base64: Buffer.from("rules: javascript-xss\n", "utf8").toString("base64"),
        content_sha256: sha256("rules: javascript-xss\n"),
      },
      {
        rule_id: "rule-php-sqli",
        language: "php",
        encoding: "base64",
        content_base64: Buffer.from("rules: php-sqli\n", "utf8").toString("base64"),
        content_sha256: sha256("rules: php-sqli\n"),
      },
      {
        rule_id: "rule-typescript-authz",
        language: "typescript",
        encoding: "base64",
        content_base64: Buffer.from("rules: typescript-authz\n", "utf8").toString("base64"),
        content_sha256: sha256("rules: typescript-authz\n"),
      },
    ],
  };
  values.ruleBundle = ruleBundle;
  refs.ruleBundle = persistJson(store, {
    runId: REUSABLE_RUN_ID,
    kind: "sca-p01-rule-bundle",
    operationId: "rule-bundle",
    schemaId: SCA_P01_RULE_BUNDLE_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_PRODUCERS.rule_bundle,
    value: ruleBundle,
  });
  const ruleRelease = {
    ...policyBase.ruleRelease,
    rule_count: ruleBundle.rules.length,
    rule_bundle_ref: refs.ruleBundle,
    rules_sha256: refs.ruleBundle.content_digest,
  };
  values.ruleRelease = ruleRelease;
  refs.ruleRelease = persistJson(store, {
    runId: REUSABLE_RUN_ID,
    kind: "sca-rule-release",
    operationId: "ruleRelease",
    schemaId: SCA_RULE_RELEASE_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_PRODUCERS.rules,
    value: ruleRelease,
    upstreamRefs: [refs.ruleBundle],
  });
  const selectedRuleManifest = {
    schema_id: SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA,
    schema_version: 1,
    selection_id: "rule-selection-web",
    rule_profile_id: "rule-profile-web",
    analysis_profile_id: "php-js-ts-profile",
    rule_release_id: "rule-release-2026-09",
    rule_release_ref: refs.ruleRelease,
    selected_rule_ids: ruleBundle.rules.map((rule) => rule.rule_id),
  };
  values.selectedRuleManifest = selectedRuleManifest;
  refs.selectedRuleManifest = persistJson(store, {
    runId: REUSABLE_RUN_ID,
    kind: "sca-p01-selected-rule-manifest",
    operationId: "selected-rule-manifest",
    schemaId: SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_PRODUCERS.rules,
    value: selectedRuleManifest,
    upstreamRefs: [refs.ruleRelease, refs.ruleBundle],
  });
  const ruleProfile = {
    ...policyBase.ruleProfile,
    rule_release_ref: refs.ruleRelease,
    selected_rule_manifest_ref: refs.selectedRuleManifest,
    selection_sha256: refs.selectedRuleManifest.content_digest,
  };
  values.ruleProfile = ruleProfile;
  refs.ruleProfile = persistJson(store, {
    runId: REUSABLE_RUN_ID,
    kind: "sca-rule-profile",
    operationId: "ruleProfile",
    schemaId: SCA_RULE_PROFILE_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_PRODUCERS.rules,
    value: ruleProfile,
    upstreamRefs: [refs.ruleRelease, refs.selectedRuleManifest],
  });

  const measuredTools = toolchainTools.map((tool, index) => {
    const executableContent =
      tool.tool_id === "scanner-semgrep-p02"
        ? p02Scanners?.semgrep.executableContent
        : tool.tool_id === "scanner-gitleaks-p02"
          ? p02Scanners?.gitleaks.executableContent
          : tool.tool_id === "parser-joern-p03"
            ? P03_SIMULATED_JOERN_EXECUTABLE
            : `executable:${tool.tool_id}:${tool.version}\n`;
    if (executableContent === undefined) throw new Error("P02 scanner fixture bytes are absent");
    const executableRef = persistBytes(store, {
      runId: REUSABLE_RUN_ID,
      kind: "sca-p01-tool-executable-package",
      operationId: `tool-executable-${String(index + 1).padStart(2, "0")}-${tool.tool_id}`,
      schemaId: SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.tool_executable,
      mediaType: "application/octet-stream",
      content: Buffer.from(executableContent, "utf8"),
    });
    const measurement = {
      schema_id: SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
      schema_version: 1,
      receipt_id: `measurement-${tool.tool_id}`,
      tool_id: tool.tool_id,
      role: tool.role,
      version: tool.version,
      executable_ref: executableRef,
      executable_sha256: executableRef.content_digest,
      measurement_method: "host-sha256",
      measured_at: CREATED_AT,
      status: "verified",
    };
    const measurementRef = persistJson(store, {
      runId: REUSABLE_RUN_ID,
      kind: "sca-p01-tool-measurement-receipt",
      operationId: `tool-measurement-${String(index + 1).padStart(2, "0")}-${tool.tool_id}`,
      schemaId: SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.tool_measurement,
      value: measurement,
      upstreamRefs: [executableRef],
    });
    refs[`toolExecutable-${String(index + 1).padStart(2, "0")}`] = executableRef;
    refs[`toolMeasurement-${String(index + 1).padStart(2, "0")}`] = measurementRef;
    values[`toolMeasurement-${String(index + 1).padStart(2, "0")}`] = measurement;
    return {
      ...tool,
      executable_ref: executableRef,
      executable_sha256: executableRef.content_digest,
      measurement_receipt_ref: measurementRef,
    };
  });
  const toolchain = { ...policyBase.toolchain, tools: measuredTools };
  values.toolchain = toolchain;
  refs.toolchain = persistJson(store, {
    runId: REUSABLE_RUN_ID,
    kind: "sca-toolchain",
    operationId: "toolchain",
    schemaId: SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_PRODUCERS.toolchain,
    value: toolchain,
    upstreamRefs: measuredTools.flatMap((tool) => [
      tool.executable_ref,
      tool.measurement_receipt_ref,
    ]),
  });

  const remainingPolicies = [
    [
      "network",
      "sca-network-policy",
      SCA_NETWORK_POLICY_V1_SCHEMA,
      SCA_P01_TRUSTED_PRODUCERS.policy,
    ],
    [
      "privacy",
      "sca-privacy-policy",
      SCA_PRIVACY_POLICY_V1_SCHEMA,
      SCA_P01_TRUSTED_PRODUCERS.policy,
    ],
    [
      "modelData",
      "sca-model-data-policy",
      SCA_MODEL_DATA_POLICY_V1_SCHEMA,
      SCA_P01_TRUSTED_PRODUCERS.policy,
    ],
    [
      "resource",
      "sca-resource-policy",
      SCA_RESOURCE_POLICY_V1_SCHEMA,
      SCA_P01_TRUSTED_PRODUCERS.policy,
    ],
    ["output", "sca-output-policy", SCA_OUTPUT_POLICY_V1_SCHEMA, SCA_P01_TRUSTED_PRODUCERS.policy],
    [
      "authority",
      "sca-authority-policy",
      SCA_AUTHORITY_POLICY_V1_SCHEMA,
      SCA_P01_TRUSTED_PRODUCERS.authority,
    ],
  ] as const;
  for (const [key, kind, schemaId, producer] of remainingPolicies) {
    const value = policyBase[key];
    values[key] = value;
    refs[key] = persistJson(store, {
      runId: REUSABLE_RUN_ID,
      kind,
      operationId: key,
      schemaId,
      producer,
      value,
    });
  }

  const qualificationSource = persistSourceMaterial({
    store,
    runId: QUALIFICATION_RUN_ID,
    operationPrefix: "qualification-source",
    snapshotId: "qualification-source-1",
    scope: { include_paths: ["apps/orchestration/src/sca"], exclude_paths: [] },
    files: [
      {
        path: "apps/orchestration/src/sca/p01-admission.ts",
        content: readFileSync(
          path.join(REPO_ROOT, "apps/orchestration/src/sca/p01-admission.ts"),
          "utf8"
        ),
      },
      {
        path: "apps/orchestration/src/sca/p01-contracts.ts",
        content: readFileSync(
          path.join(REPO_ROOT, "apps/orchestration/src/sca/p01-contracts.ts"),
          "utf8"
        ),
      },
      {
        path: "apps/orchestration/src/sca/p01-policy-contracts.ts",
        content: readFileSync(
          path.join(REPO_ROOT, "apps/orchestration/src/sca/p01-policy-contracts.ts"),
          "utf8"
        ),
      },
    ],
  });
  values.qualificationSourceManifest = qualificationSource.manifest;
  values.qualificationSourceCustody = qualificationSource.custody;
  values.qualificationSource = qualificationSource.snapshot;
  refs.qualificationSourceManifest = qualificationSource.manifestRef;
  refs.qualificationSourceCustody = qualificationSource.custodyRef;
  refs.qualificationSource = qualificationSource.snapshotRef;
  values.qualificationProfile = {
    schema_id: SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA,
    schema_version: 1,
    profile_id: "p01-real-boundary-profile",
    phase_id: "SCA-P01",
    trust_status: "host-issued",
    implementation_revision: "sca-p01-candidate-r2",
    criterion_ids: SCA_P01_REQUIRED_CRITERION_IDS,
    variant_ids: SCA_P01_QUALIFICATION_VARIANT_IDS,
  };
  refs.qualificationProfile = persistJson(store, {
    runId: QUALIFICATION_RUN_ID,
    kind: "sca-p01-qualification-profile",
    operationId: "qualification-profile",
    schemaId: SCA_P01_QUALIFICATION_PROFILE_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.qualification_profile,
    value: values.qualificationProfile,
  });
  const implementationSourceBytes = Buffer.from(
    canonicalJson({
      files: qualificationSource.custody.files,
      qualification_source_tree_sha256: qualificationSource.snapshot.tree_sha256,
      revision: "sca-p01-candidate-r2",
    }),
    "utf8"
  );
  refs.implementationSource = persistBytes(store, {
    runId: QUALIFICATION_RUN_ID,
    kind: "sca-p01-implementation-source-bundle",
    operationId: "implementation-source-bundle",
    schemaId: SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.implementation_source,
    mediaType: "application/octet-stream",
    content: implementationSourceBytes,
    upstreamRefs: [
      refs.qualificationSource,
      refs.qualificationSourceManifest,
      refs.qualificationSourceCustody,
    ],
  });
  const implementationBuildBytes = Buffer.from(
    canonicalJson({
      build_identity: "orchestration-build-r2",
      implementation_source_sha256: refs.implementationSource.content_digest,
      output: "deterministic-p01-candidate-host-module",
      revision: "sca-p01-candidate-r2",
    }),
    "utf8"
  );
  refs.implementationBuild = persistBytes(store, {
    runId: QUALIFICATION_RUN_ID,
    kind: "sca-p01-implementation-build-bundle",
    operationId: "implementation-build-bundle",
    schemaId: SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.implementation_build,
    mediaType: "application/octet-stream",
    content: implementationBuildBytes,
    upstreamRefs: [refs.implementationSource],
  });
  values.implementation = {
    schema_id: SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    schema_version: 1,
    implementation_revision: "sca-p01-candidate-r2",
    source_ref: refs.implementationSource,
    source_sha256: refs.implementationSource.content_digest,
    build_ref: refs.implementationBuild,
    build_sha256: refs.implementationBuild.content_digest,
    build_identity: "orchestration-build-r2",
    status: "frozen",
  };
  refs.implementation = persistJson(store, {
    runId: QUALIFICATION_RUN_ID,
    kind: "sca-implementation-identity",
    operationId: "implementation-identity",
    schemaId: SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.implementation,
    value: values.implementation,
    upstreamRefs: [refs.implementationSource, refs.implementationBuild],
  });

  const qualificationCriteria: Array<{
    criterion_id: string;
    status: "PASS";
    variants: Array<{
      variant_id: (typeof SCA_P01_QUALIFICATION_VARIANT_IDS)[number];
      fixture_ref: ArtifactRef;
      evidence_ref: ArtifactRef;
      applicability: "applicable";
      status: "PASS";
    }>;
  }> = [];
  const allEvidenceRefs: ArtifactRef[] = [];
  for (const [criterionIndex, criterionId] of SCA_P01_REQUIRED_CRITERION_IDS.entries()) {
    const variants: Array<{
      variant_id: (typeof SCA_P01_QUALIFICATION_VARIANT_IDS)[number];
      fixture_ref: ArtifactRef;
      evidence_ref: ArtifactRef;
      applicability: "applicable";
      status: "PASS";
    }> = [];
    for (const [variantIndex, variantId] of SCA_P01_QUALIFICATION_VARIANT_IDS.entries()) {
      const identity = `${String(criterionIndex + 1).padStart(2, "0")}-${String(variantIndex + 1).padStart(2, "0")}`;
      const commandId = `command-${identity}`;
      const jobId = `job-${identity}`;
      const expectedResult = canonicalJson({
        criterion_id: criterionId,
        variant_id: variantId,
        expected_terminal_status: "PASS",
      });
      const observedResult = canonicalJson({
        criterion_id: criterionId,
        dispatch_delta: { model: 0, scanner: 0, application: 0 },
        execution_lineage_id: "lineage-implementer-run",
        observed_terminal_status: "PASS",
        variant_id: variantId,
      });
      const configurationSha256 = sha256(
        canonicalJson({
          implementation_ref: refs.implementation,
          qualification_profile_ref: refs.qualificationProfile,
        })
      );
      const fixtureContent = Buffer.from(
        canonicalJson({
          command_id: commandId,
          criterion_id: criterionId,
          fixture_id: `fixture-${identity}`,
          input: `deterministic-input-${identity}`,
          variant_id: variantId,
        }),
        "utf8"
      );
      const fixtureContentRef = persistBytes(store, {
        runId: QUALIFICATION_RUN_ID,
        kind: "sca-p01-qualification-fixture-content",
        operationId: `fixture-content-${identity}`,
        schemaId: SCA_P01_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
        producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.fixture_content,
        mediaType: "application/octet-stream",
        content: fixtureContent,
      });
      const fixtureValue = {
        schema_id: SCA_QUALIFICATION_FIXTURE_V1_SCHEMA,
        schema_version: 1,
        fixture_id: `fixture-${identity}`,
        criterion_id: criterionId,
        variant_id: variantId,
        fixture_content_ref: fixtureContentRef,
        fixture_sha256: fixtureContentRef.content_digest,
        status: "frozen",
      };
      const fixtureRef = persistJson(store, {
        runId: QUALIFICATION_RUN_ID,
        kind: "sca-qualification-fixture",
        operationId: `fixture-${identity}`,
        schemaId: SCA_QUALIFICATION_FIXTURE_V1_SCHEMA,
        producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.fixture,
        value: fixtureValue,
        upstreamRefs: [fixtureContentRef],
      });
      const logContent = [
        `job_id=${jobId}`,
        `criterion_id=${criterionId}`,
        `variant_id=${variantId}`,
        `execution_lineage_id=lineage-implementer-run`,
        `expected_result_sha256=${sha256(expectedResult)}`,
        `observed_result_sha256=${sha256(observedResult)}`,
        "terminal_status=PASS",
        "",
      ].join("\n");
      const logContentRef = persistBytes(store, {
        runId: QUALIFICATION_RUN_ID,
        kind: "sca-p01-qualification-log-content",
        operationId: `log-content-${identity}`,
        schemaId: SCA_P01_QUALIFICATION_LOG_CONTENT_V1_SCHEMA,
        producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.log_content,
        mediaType: "text/plain; charset=utf-8",
        content: logContent,
      });
      const logValue = {
        schema_id: SCA_QUALIFICATION_LOG_V1_SCHEMA,
        schema_version: 1,
        log_id: `log-${identity}`,
        job_id: jobId,
        criterion_id: criterionId,
        variant_id: variantId,
        log_content_ref: logContentRef,
        log_sha256: logContentRef.content_digest,
        truncated: false,
      };
      const logRef = persistJson(store, {
        runId: QUALIFICATION_RUN_ID,
        kind: "sca-qualification-log",
        operationId: `log-${identity}`,
        schemaId: SCA_QUALIFICATION_LOG_V1_SCHEMA,
        producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.log,
        value: logValue,
        upstreamRefs: [logContentRef],
      });
      const receiptValue = {
        schema_id: SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA,
        schema_version: 1,
        receipt_id: `receipt-${identity}`,
        boundary: "orchestration-host-artifact-boundary",
        operation_kind: "sca-p01-candidate-admission",
        job_id: jobId,
        attempt: 1,
        implementation_revision: "sca-p01-candidate-r2",
        configuration_sha256: configurationSha256,
        command_sha256: sha256(commandId),
        execution_lineage_id: "lineage-implementer-run",
        implementation_ref: refs.implementation,
        implementation_source_ref: refs.implementationSource,
        implementation_build_ref: refs.implementationBuild,
        fixture_ref: fixtureRef,
        fixture_content_ref: fixtureContentRef,
        log_ref: logRef,
        log_content_ref: logContentRef,
        expected_result_sha256: sha256(expectedResult),
        observed_result_sha256: sha256(observedResult),
        terminal_status: "PASS",
      };
      const receiptRef = persistJson(store, {
        runId: QUALIFICATION_RUN_ID,
        kind: "sca-host-boundary-receipt",
        operationId: `receipt-${identity}`,
        schemaId: SCA_HOST_BOUNDARY_RECEIPT_V1_SCHEMA,
        producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.boundary_receipt,
        value: receiptValue,
        upstreamRefs: [
          refs.implementation,
          refs.implementationSource,
          refs.implementationBuild,
          fixtureRef,
          fixtureContentRef,
          logRef,
          logContentRef,
        ],
      });
      const evidenceValue = {
        schema_id: SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
        schema_version: 1,
        evidence_id: `evidence-${identity}`,
        qualification_run_id: QUALIFICATION_RUN_ID,
        phase_id: "SCA-P01",
        criterion_id: criterionId,
        variant_id: variantId,
        implementation_revision: "sca-p01-candidate-r2",
        implementation_ref: refs.implementation,
        qualification_profile_ref: refs.qualificationProfile,
        fixture_ref: fixtureRef,
        fixture_content_ref: fixtureContentRef,
        applicability: "applicable",
        applicability_rationale: null,
        command_id: commandId,
        job_id: jobId,
        execution_lineage_id: "lineage-implementer-run",
        configuration_sha256: configurationSha256,
        expected_result: expectedResult,
        expected_result_sha256: sha256(expectedResult),
        observed_result: observedResult,
        observed_result_sha256: sha256(observedResult),
        result: "PASS",
        log_ref: logRef,
        log_content_ref: logContentRef,
        boundary_receipt_ref: receiptRef,
      };
      const evidenceRef = persistJson(store, {
        runId: QUALIFICATION_RUN_ID,
        kind: "sca-qualification-evidence",
        operationId: `evidence-${identity}`,
        schemaId: SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
        producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.evidence,
        value: evidenceValue,
        upstreamRefs: [
          refs.implementation,
          refs.qualificationProfile,
          fixtureRef,
          fixtureContentRef,
          logRef,
          logContentRef,
          receiptRef,
        ],
      });
      refs[`fixtureContent-${identity}`] = fixtureContentRef;
      refs[`fixture-${identity}`] = fixtureRef;
      refs[`logContent-${identity}`] = logContentRef;
      refs[`log-${identity}`] = logRef;
      refs[`receipt-${identity}`] = receiptRef;
      refs[`evidence-${identity}`] = evidenceRef;
      values[`fixture-${identity}`] = fixtureValue;
      values[`log-${identity}`] = logValue;
      values[`receipt-${identity}`] = receiptValue;
      values[`evidence-${identity}`] = evidenceValue;
      allEvidenceRefs.push(evidenceRef);
      variants.push({
        variant_id: variantId,
        fixture_ref: fixtureRef,
        evidence_ref: evidenceRef,
        applicability: "applicable",
        status: "PASS",
      });
    }
    qualificationCriteria.push({ criterion_id: criterionId, status: "PASS", variants });
  }

  values.reviewerAuthority = {
    schema_id: SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
    schema_version: 1,
    authority_id: "review-authority-p01",
    reviewer_identity_id: "reviewer-independent",
    reviewer_lineage_id: "lineage-reviewer-independent",
    phase_id: "SCA-P01",
    implementation_revision: "sca-p01-candidate-r2",
    decision: "authorized",
  };
  refs.reviewerAuthority = persistJson(store, {
    runId: QUALIFICATION_RUN_ID,
    kind: "sca-reviewer-authority",
    operationId: "reviewer-authority",
    schemaId: SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.reviewer_authority,
    value: values.reviewerAuthority,
  });
  values.reviewReceipt = {
    schema_id: SCA_REVIEW_RECEIPT_V1_SCHEMA,
    schema_version: 1,
    receipt_id: "review-receipt-p01",
    reviewer_authority_ref: refs.reviewerAuthority,
    reviewer_identity_id: "reviewer-independent",
    reviewer_lineage_id: "lineage-reviewer-independent",
    qualification_profile_ref: refs.qualificationProfile,
    implementation_revision: "sca-p01-candidate-r2",
    evidence_refs: sortedRefs(allEvidenceRefs),
    decision: "PASS",
    reviewed_at: CREATED_AT,
  };
  refs.reviewReceipt = persistJson(store, {
    runId: QUALIFICATION_RUN_ID,
    kind: "sca-review-receipt",
    operationId: "review-receipt",
    schemaId: SCA_REVIEW_RECEIPT_V1_SCHEMA,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.review_receipt,
    value: values.reviewReceipt,
    upstreamRefs: [refs.reviewerAuthority, refs.qualificationProfile, ...allEvidenceRefs],
  });

  const qualification = validateScaPhaseQualificationRecordV2({
    schema_id: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
    schema_version: 2,
    record_kind: "implementation_qualification",
    tenant_id: "tenant-p01",
    project_id: "project-p01",
    run_id: QUALIFICATION_RUN_ID,
    phase_id: "SCA-P01",
    implementation_revision: "sca-p01-candidate-r2",
    qualification_profile_ref: refs.qualificationProfile,
    source_snapshot_ref: refs.qualificationSource,
    implementation_ref: refs.implementation,
    implementer_identity_id: "implementer-p01",
    implementer_lineage_id: "lineage-implementer-run",
    reviewer_authority_ref: refs.reviewerAuthority,
    reviewer_receipt_ref: refs.reviewReceipt,
    criteria: qualificationCriteria,
    remaining_gaps: [],
    status: "PASS",
    recorded_at: CREATED_AT,
  });
  values.qualification = qualification;
  refs.qualification = persistJson(store, {
    runId: QUALIFICATION_RUN_ID,
    kind: "sca-phase-qualification",
    operationId: "p01-qualification",
    schemaId: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
    schemaVersion: 2,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.qualification,
    value: qualification,
    upstreamRefs: scaPhaseQualificationRefs(qualification),
  });

  const request = validateScaP01AdmissionRequestV3({
    schema_id: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
    schema_version: 3,
    tenant_id: "tenant-p01",
    project_id: "project-p01",
    run_id: RUN_ID,
    source: { snapshot_ref: refs.source, provenance_ref: refs.provenance },
    scope: { include_paths: ["app", "packages/security"], exclude_paths: ["app/generated"] },
    analysis_profile: {
      profile_id: "php-js-ts-profile",
      profile_ref: refs.profile,
      languages: ["javascript", "php", "typescript"],
      frameworks: [
        { framework_id: "express", language: "javascript" },
        { framework_id: "wordpress", language: "php" },
        { framework_id: "nestjs", language: "typescript" },
      ],
    },
    rule_release_ref: refs.ruleRelease,
    rule_profile_ref: refs.ruleProfile,
    toolchain_ref: refs.toolchain,
    network_policy_ref: refs.network,
    privacy_policy_ref: refs.privacy,
    model_data_policy_ref: refs.modelData,
    resource_policy_ref: refs.resource,
    output_policy_ref: refs.output,
    authority_policy_ref: refs.authority,
    p01_qualification_ref: refs.qualification,
    implementation_revision: "sca-p01-candidate-r2",
    runtime_cognition: {
      alias: "deepseek-flash",
      provider: "ollama",
      model: "deepseek-v4.1-flash:cloud",
    },
    report_namespace: "sca-report-candidate",
    requested_at: CREATED_AT,
    authorities: {
      execution_authority_id: "authority-execution",
      release_authority_id: "authority-release",
      promotion_authority_id: "authority-promotion",
    },
  });
  const setup = { store, request, qualification, values, refs };
  return label === P02_INTEGRATION_FIXTURE_LABEL ? withVariantCapture(setup) : setup;
}

function capturedVariant(
  store: ArtifactStore,
  label: string,
  body = "captured fixture bytes",
  snapshotSuffix = "",
  runLabel = label
): ReturnType<typeof buildP01SourceSnapshotV2> {
  const root = temporaryRoot("variant-capture");
  mkdirSync(path.join(root, "source"));
  writeFileSync(path.join(root, "source", "sample.txt"), body);
  return buildP01SourceSnapshotV2({
    store,
    source_root: root,
    run_id: `${RUN_ID}-${runLabel}`,
    snapshot_id: `capture-${label}${snapshotSuffix}`,
    policy: {
      include_paths: ["source"],
      exclude_paths: [],
      max_files: 2,
      max_file_bytes: 1024,
      max_total_bytes: 2048,
      max_walk_entries: 4,
    },
  });
}
function withVariantCapture(setup: Fixture): Fixture {
  const entries = ["alpha", "beta"].map((label) => ({
    label,
    ...capturedVariant(setup.store, label),
  }));
  const root = buildScaP01VariantCaptureManifestV1({
    store: setup.store,
    manifest: {
      schema_id: SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA,
      schema_version: 1,
      tenant_id: setup.request.tenant_id,
      project_id: setup.request.project_id,
      run_id: setup.request.run_id,
      implementation_revision: setup.request.implementation_revision,
      baseline_snapshot_ref: setup.request.source.snapshot_ref,
      baseline_provenance_ref: setup.request.source.provenance_ref,
      entries,
    },
  });
  return {
    ...setup,
    request: validateScaP01AdmissionRequestV3({
      ...setup.request,
      source: { ...setup.request.source, variant_capture_manifest_ref: root },
    }),
  };
}
function captureOf(setup: Fixture) {
  const ref = setup.request.source.variant_capture_manifest_ref;
  if (ref === undefined) throw new Error("capture fixture missing root");
  return {
    ref,
    ...readScaP01VariantCaptureV1({
      store: setup.store,
      manifest_ref: ref,
      context: setup.request,
    }),
  };
}
function p02CaptureAdmissionFixture(setup: Fixture, accepted: ScaP01AdmissionResultV1) {
  const core = validateScaCampaignManifestCoreV1(parsed(setup.store, accepted.manifest_core_ref));
  const isolationRef = persistJson(setup.store, {
    runId: RUN_ID,
    phase: "sca-p02-input",
    kind: "sca-p02-isolation-evidence",
    operationId: "capture-p02-isolation",
    schemaId: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
    producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
    value: {
      schema_id: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
      schema_version: 1,
      producer_id: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
      evidence_kind: "simulated_test_seam",
      runtime_kind: "simulated_test_runtime",
      isolation_id: "capture-isolation",
      runtime_id: "capture-runtime",
      implementation_identity_sha256: sha256("offline implementation"),
      deployment_identity_sha256: sha256("offline deployment"),
      qualification_scope: "deterministic_test_only",
      qualified: false,
      profile_id: "capture-profile",
      profile_sha256: sha256("offline profile"),
      qualified_at: CREATED_AT,
    },
  });
  const runtimeRef = persistJson(setup.store, {
    runId: RUN_ID,
    phase: "sca-p02-input",
    kind: "sca-p02-runtime-policy",
    operationId: "capture-p02-runtime",
    schemaId: SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
    producer: SCA_P02_RUNTIME_POLICY_PRODUCER,
    upstreamRefs: [isolationRef],
    value: {
      schema_id: SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
      schema_version: 1,
      policy_id: "capture-runtime-policy",
      staging_parent: "/fixture/staging",
      isolation_evidence_ref: isolationRef,
      executables: [
        {
          tool_id: "offline-semgrep",
          executable_path: "/fixture/semgrep",
          executable_sha256: sha256("offline-semgrep"),
          version: "1",
        },
        {
          tool_id: "offline-gitleaks",
          executable_path: "/fixture/gitleaks",
          executable_sha256: sha256("offline-gitleaks"),
          version: "1",
        },
      ],
      operation_tools: { semgrep_tool_id: "offline-semgrep", gitleaks_tool_id: "offline-gitleaks" },
      semgrep_max_output_bytes: 1024,
      gitleaks_max_output_bytes: 1024,
      process_timeout_ms: 1000,
      internal_component_identities: {
        source_census_sha256: SCA_P02_SOURCE_CENSUS_IDENTITY_SHA256,
        tree_sitter_sha256: sha256("offline-tree"),
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
      gitleaks_configuration_rule_id: "offline-gitleaks-config",
      osv: {
        transport_id: "offline-no-transport",
        max_batch_size: 128,
        max_concurrency: 2,
        timeout_ms: 1000,
        max_response_bytes: 1024,
        max_advisory_requests: 10,
        freshness_max_age_seconds: 60,
      },
    },
  });
  return validateScaP02RequestV1({
    schema_id: SCA_P02_REQUEST_V1_SCHEMA,
    schema_version: 1,
    tenant_id: setup.request.tenant_id,
    project_id: setup.request.project_id,
    run_id: RUN_ID,
    accepted_p01: {
      request_ref: accepted.request_ref,
      obligation_ledger_ref: accepted.obligation_ledger_ref,
      campaign_manifest_core_ref: accepted.manifest_core_ref,
      admission_evidence_ref: accepted.admission_evidence_ref,
      p01_gate_ref: accepted.p01_gate_ref,
      campaign_manifest_ref: accepted.campaign_manifest_ref,
      frozen_refs: [...scaP02FrozenRefs(core)],
    },
    runtime_policy_ref: runtimeRef,
    isolation_evidence_ref: isolationRef,
    isolation_host_attestation_ref: null,
    requested_at: CREATED_AT,
  });
}

function validateFixtureContext(
  setup: Fixture,
  accepted: ScaP01AdmissionResultV1,
  override: Partial<Parameters<typeof validateScaP01AdmissionContextV1>[0]> = {}
): void {
  const core = validateScaCampaignManifestCoreV1(parsed(setup.store, accepted.manifest_core_ref));
  validateScaP01AdmissionContextV1({
    request: setup.request,
    request_ref: accepted.request_ref,
    ledger: validateScaObligationLedgerV2(parsed(setup.store, accepted.obligation_ledger_ref)),
    ledger_ref: accepted.obligation_ledger_ref,
    core,
    core_ref: accepted.manifest_core_ref,
    frozen_material_refs: core.frozen_refs,
    qualification: setup.qualification,
    qualification_ref: setup.request.p01_qualification_ref,
    admission_evidence: validateScaP01AdmissionEvidenceV1(
      parsed(setup.store, accepted.admission_evidence_ref)
    ),
    admission_evidence_ref: accepted.admission_evidence_ref,
    gate: validateScaPhaseGateRecordV2(parsed(setup.store, accepted.p01_gate_ref)),
    gate_ref: accepted.p01_gate_ref,
    manifest: validateScaCampaignManifestV2(parsed(setup.store, accepted.campaign_manifest_ref)),
    ...override,
  });
}

function replaceRequestArtifact(input: {
  readonly setup: Fixture;
  readonly key: string;
  readonly requestField:
    | "network_policy_ref"
    | "privacy_policy_ref"
    | "model_data_policy_ref"
    | "resource_policy_ref"
    | "output_policy_ref"
    | "authority_policy_ref"
    | "rule_profile_ref"
    | "toolchain_ref";
  readonly kind: string;
  readonly schemaId: string;
  readonly producer: string;
  readonly value: unknown;
}): unknown {
  const ref = persistJson(input.setup.store, {
    runId: REUSABLE_RUN_ID,
    kind: input.kind,
    operationId: `replacement-${input.key}`,
    schemaId: input.schemaId,
    producer: input.producer,
    value: input.value,
  });
  return { ...input.setup.request, [input.requestField]: ref };
}

function replaceQualification(
  setup: Fixture,
  value: ScaPhaseQualificationRecordV2,
  operationId: string
): ArtifactRef {
  return persistJson(setup.store, {
    runId: QUALIFICATION_RUN_ID,
    kind: "sca-phase-qualification",
    operationId,
    schemaId: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
    schemaVersion: 2,
    producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.qualification,
    value,
    upstreamRefs: scaPhaseQualificationRefs(value),
  });
}

function artifactStoreView(
  backing: ArtifactStore,
  overrides: {
    readonly refById?: (artifactId: string) => ArtifactRef | undefined;
    readonly readById?: (artifactId: string) => Buffer;
    readonly metadata?: (ref: ArtifactRef) => OutputArtifactMetadata;
    readonly persist?: (input: PersistArtifactInput) => CurrentArtifactRef;
  }
): ArtifactHostStore {
  return {
    refById: overrides.refById ?? ((artifactId) => backing.refById(artifactId)),
    readById: overrides.readById ?? ((artifactId) => backing.readById(artifactId)),
    lastVersion: (runId, phase, branchId, kind, operationId) =>
      backing.lastVersion(runId, phase, branchId, kind, operationId),
    refFor: (runId, phase, branchId, kind, operationId, version) =>
      backing.refFor(runId, phase, branchId, kind, operationId, version),
    persist: overrides.persist ?? ((input) => backing.persist(input)),
    select: (ref) => {
      backing.select(ref);
    },
    metadata: overrides.metadata ?? ((ref) => backing.metadata(ref)),
  };
}

function instrumentedStore(backing: ArtifactStore, failAtPersist?: number) {
  const counts = { reads: 0, persists: 0 };
  const persistOperations: string[] = [];
  const store: ArtifactHostStore = {
    refById(artifactId: string): ArtifactRef | undefined {
      counts.reads += 1;
      return backing.refById(artifactId);
    },
    readById(artifactId: string): Buffer {
      counts.reads += 1;
      return backing.readById(artifactId);
    },
    lastVersion(
      runId: string,
      phase: string,
      branchId: string | null,
      kind: string,
      operationId: string
    ): number {
      counts.reads += 1;
      return backing.lastVersion(runId, phase, branchId, kind, operationId);
    },
    refFor(
      runId: string,
      phase: string,
      branchId: string | null,
      kind: string,
      operationId: string,
      version: number
    ): ArtifactRef | null {
      counts.reads += 1;
      return backing.refFor(runId, phase, branchId, kind, operationId, version);
    },
    persist(input: PersistArtifactInput): CurrentArtifactRef {
      counts.persists += 1;
      persistOperations.push(input.metadata.operation_id);
      if (counts.persists === failAtPersist) throw new Error("injected persistence interruption");
      return backing.persist(input);
    },
    select(ref: ArtifactRef): void {
      backing.select(ref);
    },
    metadata(ref: ArtifactRef): OutputArtifactMetadata {
      counts.reads += 1;
      return backing.metadata(ref);
    },
  };
  return { store, counts, persistOperations };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    try {
      execFileSync("chmod", ["-R", "u+rwx", root]);
    } catch {
      // Best-effort permission restoration for read-only custody staging fixtures.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("canonical engine/checkpointer qualification for the inactive P01 candidate", () => {
  it("checkpoints the host state before P01 and recovers to an honest blocked-at-P02 terminal", () => {
    const setup = fixture("engine-lifecycle");
    const requestRef = persistCandidateInitialRequest(setup);
    const projectRoot = temporaryRoot("engine-lifecycle-state");
    const harness = candidateHarness();
    using checkpointer = new Checkpointer(path.join(projectRoot, "orchestration.db"));
    const runtime = candidateEngine({
      checkpointer,
      projectRoot,
      store: setup.store,
      harness,
    });

    const started = startCandidate(runtime, projectRoot, requestRef);
    expect(started).toMatchObject({
      action: "status",
      status: "running",
      state_id: P01_CANDIDATE_HOST_STATE,
      terminal: false,
      met: false,
    });
    const startedRun = checkpointer.loadRun(candidateIdentity());
    expect(startedRun.stateId).toBe(P01_CANDIDATE_HOST_STATE);
    expect(startedRun.terminalDirective).toBeNull();
    expect(startedRun.selectedArtifacts).toEqual([requestRef]);
    expect(checkpointer.events(RUN_ID).map((event) => event.eventType)).toContain("run_started");
    expect(setup.store.readById(requestRef.artifact_id).toString("utf8")).toBe(
      canonicalJson(setup.request)
    );
    expect(setup.store.metadata(requestRef)).toEqual(
      artifactMetadata({
        runId: RUN_ID,
        phase: P01_CANDIDATE_HOST_STATE,
        kind: P01_CANDIDATE_INPUT_KIND,
        operationId: P01_CANDIDATE_INPUT_OPERATION,
        schemaId: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
        schemaVersion: 3,
        producer: P01_CANDIDATE_INPUT_PRODUCER,
        upstreamRefs: scaP01AdmissionRequestRefs(setup.request),
      })
    );
    expectNoCandidateWrites(setup.store);
    expect(harness.admissionCalls).toBe(0);

    const terminal = requireIncompleteCandidate(recoverCandidate(runtime));
    const expectedRefs = currentCandidateRefs(setup.store);
    expectBlockedAtP02(terminal);
    expect(terminal.artifacts).toEqual(expectedRefs);
    const durable = checkpointer.loadRun(candidateIdentity());
    expect(durable.stateId).toBe("incomplete");
    expect(durable.status).toBe("incomplete");
    expect(durable.met).toBe(false);
    expect(
      durable.selectedArtifacts.filter((ref) =>
        CANDIDATE_OPERATIONS.some((operationId) => operationId === ref.kind)
      )
    ).toEqual(expectedRefs);
    expect(checkpointer.events(RUN_ID).at(-1)?.eventType).toBe(P01_CANDIDATE_HOST_EVENT);
    const evidenceRef = expectedRefs[3];
    if (evidenceRef === undefined) throw new Error("P01 admission evidence ref is absent");
    const evidence = validateScaP01AdmissionEvidenceV1(parsed(setup.store, evidenceRef));
    expect(evidence.dispatch_delta).toEqual({ model: 0, scanner: 0, application: 0 });
    expect(harness).toMatchObject({
      dispatch: { model: 0, scanner: 0, application: 0 },
      workerDispatches: 0,
      initialRequestValidations: 1,
      admissionCalls: 1,
    });
  });

  it("durably cancels after the initial checkpoint and replays without any P01 output", () => {
    const setup = fixture("engine-cancel");
    const requestRef = persistCandidateInitialRequest(setup);
    const projectRoot = temporaryRoot("engine-cancel-state");
    const databasePath = path.join(projectRoot, "orchestration.db");
    const firstHarness = candidateHarness();
    let cancelledWire = "";

    {
      using checkpointer = new Checkpointer(databasePath);
      const runtime = candidateEngine({
        checkpointer,
        projectRoot,
        store: setup.store,
        harness: firstHarness,
      });
      startCandidate(runtime, projectRoot, requestRef);
      const cancelled = runtime.handle({
        schema_version: 2,
        action: "cancel",
        identity: candidateIdentity(),
        reason: "cancel before P01 host continuation",
      });
      expect(cancelled).toMatchObject({
        action: "cancelled",
        status: "cancelled",
        met: false,
        artifacts: [],
      });
      cancelledWire = canonicalJson(cancelled);
      expect(checkpointer.loadRun(candidateIdentity()).terminalDirective).toEqual(cancelled);
      expectNoCandidateWrites(setup.store);
    }

    const replayHarness = candidateHarness();
    using reopened = new Checkpointer(databasePath);
    const replayRuntime = candidateEngine({
      checkpointer: reopened,
      projectRoot,
      store: setup.store,
      harness: replayHarness,
    });
    const replayed = recoverCandidate(replayRuntime);
    expect(canonicalJson(replayed)).toBe(cancelledWire);
    expect(reopened.loadRun(candidateIdentity()).terminalDirective).toEqual(replayed);
    expectNoCandidateWrites(setup.store);
    expect(firstHarness).toMatchObject({
      dispatch: { model: 0, scanner: 0, application: 0 },
      workerDispatches: 0,
      initialRequestValidations: 0,
      admissionCalls: 0,
    });
    expect(replayHarness).toMatchObject({
      dispatch: { model: 0, scanner: 0, application: 0 },
      workerDispatches: 0,
      initialRequestValidations: 0,
      admissionCalls: 0,
    });
  });

  it("recovers exact partial P01 artifacts after interrupted host persistence without model work", () => {
    const setup = fixture("engine-persistence-interruption");
    const requestRef = persistCandidateInitialRequest(setup);
    const projectRoot = temporaryRoot("engine-persistence-state");
    const databasePath = path.join(projectRoot, "orchestration.db");
    const interruptedStore = instrumentedStore(setup.store, 6);
    const firstHarness = candidateHarness();
    const partialRefs: ArtifactRef[] = [];

    {
      using checkpointer = new Checkpointer(databasePath);
      const runtime = candidateEngine({
        checkpointer,
        projectRoot,
        store: interruptedStore.store,
        harness: firstHarness,
      });
      startCandidate(runtime, projectRoot, requestRef);
      expect(() => recoverCandidate(runtime)).toThrow(/could not be persisted/u);
      const interruptedRun = checkpointer.loadRun(candidateIdentity());
      expect(interruptedRun.stateId).toBe(P01_CANDIDATE_HOST_STATE);
      expect(interruptedRun.status).toBe("running");
      expect(interruptedRun.terminalDirective).toBeNull();
      expect(interruptedRun.selectedArtifacts).toEqual([requestRef]);
      for (const operationId of CANDIDATE_OPERATIONS.slice(0, -1)) {
        const ref = campaignCandidateRef(setup.store, operationId);
        if (ref === null) throw new Error(`partial candidate ref '${operationId}' is absent`);
        partialRefs.push(ref);
      }
      expect(partialRefs).toHaveLength(5);
      expect(campaignCandidateRef(setup.store, CANDIDATE_OPERATIONS[5])).toBeNull();
    }

    const recoveredStore = instrumentedStore(setup.store);
    const recoveredHarness = candidateHarness();
    using reopened = new Checkpointer(databasePath);
    const recoveredRuntime = candidateEngine({
      checkpointer: reopened,
      projectRoot,
      store: recoveredStore.store,
      harness: recoveredHarness,
    });
    const terminal = requireIncompleteCandidate(recoverCandidate(recoveredRuntime));
    const expectedRefs = currentCandidateRefs(setup.store);
    expectBlockedAtP02(terminal);
    expect(terminal.artifacts).toEqual(expectedRefs);
    expect(expectedRefs.slice(0, -1)).toEqual(partialRefs);
    expect(
      recoveredStore.persistOperations.filter(
        (operationId) => operationId === "sca-p01-candidate-campaign-manifest"
      )
    ).toHaveLength(1);
    expect(
      setup.store.lastVersion(
        RUN_ID,
        CANDIDATE_PHASE,
        null,
        "sca-p01-candidate-campaign-manifest",
        "sca-p01-candidate-campaign-manifest"
      )
    ).toBe(1);
    const persistCount = recoveredStore.counts.persists;
    expect(canonicalJson(recoverCandidate(recoveredRuntime))).toBe(canonicalJson(terminal));
    expect(recoveredStore.counts.persists).toBe(persistCount);
    expect(firstHarness).toMatchObject({
      dispatch: { model: 0, scanner: 0, application: 0 },
      workerDispatches: 0,
      initialRequestValidations: 1,
      admissionCalls: 1,
    });
    expect(recoveredHarness).toMatchObject({
      dispatch: { model: 0, scanner: 0, application: 0 },
      workerDispatches: 0,
      initialRequestValidations: 1,
      admissionCalls: 1,
    });
  });

  it("replays exact terminal refs and bytes after a post-checkpoint restart", () => {
    const setup = fixture("engine-post-checkpoint-restart");
    const requestRef = persistCandidateInitialRequest(setup);
    const projectRoot = temporaryRoot("engine-post-checkpoint-state");
    const databasePath = path.join(projectRoot, "orchestration.db");
    let faulted = false;
    const firstHarness = candidateHarness((point) => {
      if (!faulted && point === P01_CANDIDATE_POST_CHECKPOINT) {
        faulted = true;
        throw new Error("injected P01 post-checkpoint interruption");
      }
    });
    let terminalWire = "";
    let terminalRefs: readonly ArtifactRef[] = [];
    let terminalBytes: readonly string[] = [];

    {
      using checkpointer = new Checkpointer(databasePath);
      const runtime = candidateEngine({
        checkpointer,
        projectRoot,
        store: setup.store,
        harness: firstHarness,
      });
      startCandidate(runtime, projectRoot, requestRef);
      expect(() => recoverCandidate(runtime)).toThrow(/post-checkpoint interruption/u);
      const durable = checkpointer.loadRun(candidateIdentity()).terminalDirective;
      if (durable === null) throw new Error("post-checkpoint terminal was not durable");
      const terminal = requireIncompleteCandidate(durable);
      terminalWire = canonicalJson(terminal);
      terminalRefs = [...terminal.artifacts];
      terminalBytes = terminal.artifacts.map((ref) =>
        setup.store.readById(ref.artifact_id).toString("hex")
      );
      expectBlockedAtP02(terminal);
    }

    const replayHarness = candidateHarness();
    using reopened = new Checkpointer(databasePath);
    const replayRuntime = candidateEngine({
      checkpointer: reopened,
      projectRoot,
      store: setup.store,
      harness: replayHarness,
    });
    const replayed = requireIncompleteCandidate(recoverCandidate(replayRuntime));
    expect(canonicalJson(replayed)).toBe(terminalWire);
    expect(replayed.artifacts).toEqual(terminalRefs);
    expect(
      replayed.artifacts.map((ref) => setup.store.readById(ref.artifact_id).toString("hex"))
    ).toEqual(terminalBytes);
    expect(faulted).toBe(true);
    expect(firstHarness).toMatchObject({
      dispatch: { model: 0, scanner: 0, application: 0 },
      workerDispatches: 0,
      initialRequestValidations: 1,
      admissionCalls: 1,
    });
    expect(replayHarness).toMatchObject({
      dispatch: { model: 0, scanner: 0, application: 0 },
      workerDispatches: 0,
      initialRequestValidations: 0,
      admissionCalls: 0,
    });
  });

  it("rejects initial request metadata or engine-identity drift before calling P01", () => {
    const rejectBeforeAdmission = (
      setup: Fixture,
      requestRef: ArtifactRef,
      errorPattern: RegExp,
      label: string
    ): void => {
      const projectRoot = temporaryRoot(`engine-input-rejection-${label}`);
      const harness = candidateHarness();
      using checkpointer = new Checkpointer(path.join(projectRoot, "orchestration.db"));
      const runtime = candidateEngine({
        checkpointer,
        projectRoot,
        store: setup.store,
        harness,
      });
      startCandidate(runtime, projectRoot, requestRef);
      expect(() => recoverCandidate(runtime)).toThrow(errorPattern);
      expect(checkpointer.loadRun(candidateIdentity()).stateId).toBe(P01_CANDIDATE_HOST_STATE);
      expect(harness.admissionCalls).toBe(0);
      expect(harness.dispatch).toEqual({ model: 0, scanner: 0, application: 0 });
      expectNoCandidateWrites(setup.store);
    };

    const metadataDrift = fixture("engine-input-metadata-drift");
    const metadataDriftRef = persistJson(metadataDrift.store, {
      runId: RUN_ID,
      phase: P01_CANDIDATE_HOST_STATE,
      kind: P01_CANDIDATE_INPUT_KIND,
      operationId: P01_CANDIDATE_INPUT_OPERATION,
      schemaId: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
      schemaVersion: 3,
      producer: "host:wrong-p01-input-producer",
      value: metadataDrift.request,
      upstreamRefs: scaP01AdmissionRequestRefs(metadataDrift.request),
    });
    rejectBeforeAdmission(
      metadataDrift,
      metadataDriftRef,
      /bytes or metadata are not exact/u,
      "metadata"
    );

    const identityDrift = fixture("engine-input-identity-drift");
    const wrongTenantRequest = validateScaP01AdmissionRequestV3({
      ...identityDrift.request,
      tenant_id: "tenant-other",
    });
    const identityDriftRef = persistJson(identityDrift.store, {
      runId: RUN_ID,
      phase: P01_CANDIDATE_HOST_STATE,
      kind: P01_CANDIDATE_INPUT_KIND,
      operationId: P01_CANDIDATE_INPUT_OPERATION,
      schemaId: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
      schemaVersion: 3,
      producer: P01_CANDIDATE_INPUT_PRODUCER,
      value: wrongTenantRequest,
      upstreamRefs: scaP01AdmissionRequestRefs(wrongTenantRequest),
    });
    rejectBeforeAdmission(
      identityDrift,
      identityDriftRef,
      /request identity does not match the engine identity/u,
      "identity"
    );
  });
});

describe("semantic P01 admission packet", () => {
  it("persists pending core, current evidence, gate, and sole admitted marker with exact bindings", () => {
    const setup = fixture("roundtrip");
    const dispatch = { model: 0, scanner: 0, application: 0 };
    const result = admitScaP01Candidate({
      store: setup.store,
      request: setup.request,
      options: { dispatchProbe: { snapshot: () => ({ ...dispatch }) } },
    });

    const ledger = validateScaObligationLedgerV2(parsed(setup.store, result.obligation_ledger_ref));
    const core = validateScaCampaignManifestCoreV1(parsed(setup.store, result.manifest_core_ref));
    const evidence = validateScaP01AdmissionEvidenceV1(
      parsed(setup.store, result.admission_evidence_ref)
    );
    const gate = validateScaPhaseGateRecordV2(parsed(setup.store, result.p01_gate_ref));
    const manifest = validateScaCampaignManifestV2(
      parsed(setup.store, result.campaign_manifest_ref)
    );
    const campaignSource = validateScaCampaignSourceSnapshotV2(
      parsed(setup.store, setup.request.source.snapshot_ref)
    );
    const qualificationSource = validateScaCampaignSourceSnapshotV2(
      parsed(setup.store, setup.qualification.source_snapshot_ref)
    );
    const authority = validateScaAuthorityPolicyV1(
      parsed(setup.store, setup.request.authority_policy_ref)
    );

    expect(SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA).toBe("penny.sca-campaign-source-snapshot.v2");
    expect(campaignSource.scope).toEqual(setup.request.scope);
    expect(qualificationSource).not.toEqual(campaignSource);
    expect(authority.admission_decision).toBe("allow");
    expect(authority.grants.every((grant) => grant.posture === "separate-gate-required")).toBe(
      true
    );
    expect(authority.grants.every((grant) => !("decision" in grant))).toBe(true);
    expect(core.status).toBe("pending_gate");
    expect(core).not.toHaveProperty("campaign_status");
    expect(gate.status).toBe("passed");
    expect(gate).not.toHaveProperty("campaign_status");
    expect(manifest).toMatchObject({
      campaign_status: "admitted",
      manifest_core_ref: result.manifest_core_ref,
      p01_gate_ref: result.p01_gate_ref,
      authority_policy_ref: setup.request.authority_policy_ref,
      m1_status: "not_reached",
      sca_completion_claimed: false,
    });
    expect(evidence.dispatch_delta).toEqual({ model: 0, scanner: 0, application: 0 });
    expect(evidence.qualification_ref).toEqual(setup.request.p01_qualification_ref);
    expect(core.frozen_refs).toMatchObject({
      source_file_manifest_ref: requiredRef(setup.refs, "sourceManifest"),
      source_custody_ref: requiredRef(setup.refs, "sourceCustody"),
      rule_bundle_ref: requiredRef(setup.refs, "ruleBundle"),
      selected_rule_manifest_ref: requiredRef(setup.refs, "selectedRuleManifest"),
      qualification_source_file_manifest_ref: requiredRef(
        setup.refs,
        "qualificationSourceManifest"
      ),
      qualification_source_custody_ref: requiredRef(setup.refs, "qualificationSourceCustody"),
      implementation_source_ref: requiredRef(setup.refs, "implementationSource"),
      implementation_build_ref: requiredRef(setup.refs, "implementationBuild"),
    });
    for (const requiredMaterialRef of [
      requiredRef(setup.refs, "sourceManifest"),
      requiredRef(setup.refs, "sourceCustody"),
      requiredRef(setup.refs, "ruleBundle"),
      requiredRef(setup.refs, "selectedRuleManifest"),
      requiredRef(setup.refs, "toolExecutable-01"),
      requiredRef(setup.refs, "toolMeasurement-01"),
      requiredRef(setup.refs, "fixtureContent-01-01"),
      requiredRef(setup.refs, "logContent-01-01"),
      requiredRef(setup.refs, "implementationSource"),
      requiredRef(setup.refs, "implementationBuild"),
    ]) {
      expect(evidence.evidence_refs, requiredMaterialRef.artifact_id).toContainEqual(
        requiredMaterialRef
      );
      expect(setup.store.refById(requiredMaterialRef.artifact_id)).toEqual(requiredMaterialRef);
      expect(sha256(setup.store.readById(requiredMaterialRef.artifact_id))).toBe(
        requiredMaterialRef.content_digest
      );
    }
    expect(ledger.campaign_completion_claimed).toBe(false);
    expect(
      resultRefs(result).every((ref) => setup.store.refById(ref.artifact_id) !== undefined)
    ).toBe(true);
    expect(setup.store.metadata(result.campaign_manifest_ref).upstream_refs).toEqual(
      sortedRefs([
        result.manifest_core_ref,
        result.p01_gate_ref,
        result.request_ref,
        result.obligation_ledger_ref,
      ])
    );
  });

  it("resolves every admitted transitive input ref after an artifact-store restart", () => {
    const setup = fixture("restart-material-resolution");
    const result = admitCandidate({ store: setup.store, request: setup.request });
    const evidence = validateScaP01AdmissionEvidenceV1(
      parsed(setup.store, result.admission_evidence_ref)
    );
    const root = setup.store.root;
    setup.store.close();
    const priorIndex = stores.indexOf(setup.store);
    if (priorIndex >= 0) stores.splice(priorIndex, 1);
    const reopened = ArtifactStore.openExisting(root, { projectId: ARTIFACT_PROJECT_ID });
    stores.push(reopened);
    for (const ref of evidence.evidence_refs) {
      expect(reopened.refById(ref.artifact_id), ref.artifact_id).toEqual(ref);
      const bytes = reopened.readById(ref.artifact_id);
      expect(bytes.byteLength, ref.artifact_id).toBe(ref.byte_length);
      expect(sha256(bytes), ref.artifact_id).toBe(ref.content_digest);
      expect(reopened.metadata(ref).run_id, ref.artifact_id).toBe(ref.run_id);
    }
  });

  it("rejects unknown, denied, contradictory, or unsafe semantic policy bytes before writes", () => {
    const denied = fixture("policy-denied");
    const deniedNetwork = {
      ...requiredRecord(denied.values, "network"),
      status: "denied",
    };
    const deniedRequest = replaceRequestArtifact({
      setup: denied,
      key: "network-denied",
      requestField: "network_policy_ref",
      kind: "sca-network-policy",
      schemaId: SCA_NETWORK_POLICY_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.policy,
      value: deniedNetwork,
    });
    expect(admissionError({ store: denied.store, request: deniedRequest }).code).toBe(
      "semantic_policy_denied"
    );
    expectNoCandidateWrites(denied.store);

    const unknown = fixture("policy-unknown");
    const unknownPrivacy = { ...requiredRecord(unknown.values, "privacy"), surprise: true };
    const unknownRequest = replaceRequestArtifact({
      setup: unknown,
      key: "privacy-unknown",
      requestField: "privacy_policy_ref",
      kind: "sca-privacy-policy",
      schemaId: SCA_PRIVACY_POLICY_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.policy,
      value: unknownPrivacy,
    });
    expect(admissionError({ store: unknown.store, request: unknownRequest }).code).toBe(
      "artifact_contract_mismatch"
    );
    expectNoCandidateWrites(unknown.store);

    const contradiction = fixture("policy-contradiction");
    const wrongRules = {
      ...requiredRecord(contradiction.values, "ruleProfile"),
      rule_release_id: "different-release",
    };
    const contradictionRequest = replaceRequestArtifact({
      setup: contradiction,
      key: "rule-contradiction",
      requestField: "rule_profile_ref",
      kind: "sca-rule-profile",
      schemaId: SCA_RULE_PROFILE_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.rules,
      value: wrongRules,
    });
    expect(admissionError({ store: contradiction.store, request: contradictionRequest }).code).toBe(
      "artifact_contract_mismatch"
    );
    expectNoCandidateWrites(contradiction.store);

    const authority = fixture("authority-denied");
    const deniedAuthority = {
      ...requiredRecord(authority.values, "authority"),
      admission_decision: "deny",
    };
    const authorityRequest = replaceRequestArtifact({
      setup: authority,
      key: "authority-denied",
      requestField: "authority_policy_ref",
      kind: "sca-authority-policy",
      schemaId: SCA_AUTHORITY_POLICY_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.authority,
      value: deniedAuthority,
    });
    expect(admissionError({ store: authority.store, request: authorityRequest }).code).toBe(
      "semantic_policy_denied"
    );
    expectNoCandidateWrites(authority.store);
  });

  it("requires separate later gates and digest-bound scanner/parser identities", () => {
    const authority = fixture("later-authority-posture");
    const authorityPolicy = policyValues().authority;
    const deniedLaterGate = {
      ...authorityPolicy,
      grants: authorityPolicy.grants.map((grant) =>
        grant.role === "execution" ? { ...grant, posture: "denied" } : grant
      ),
    };
    const authorityRequest = replaceRequestArtifact({
      setup: authority,
      key: "later-authority-denied",
      requestField: "authority_policy_ref",
      kind: "sca-authority-policy",
      schemaId: SCA_AUTHORITY_POLICY_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.authority,
      value: deniedLaterGate,
    });
    expect(admissionError({ store: authority.store, request: authorityRequest }).code).toBe(
      "semantic_policy_denied"
    );
    expectNoCandidateWrites(authority.store);

    const toolchain = fixture("toolchain-executable-identity");
    const toolchainPolicy = validateScaToolchainIdentityV1(
      requiredValue(toolchain.values, "toolchain")
    );
    const invalidExecutableIdentity = {
      ...toolchainPolicy,
      tools: toolchainPolicy.tools.map((tool, index) =>
        index === 0 ? { ...tool, executable_sha256: "version-string-is-not-identity" } : tool
      ),
    };
    const toolchainRequest = replaceRequestArtifact({
      setup: toolchain,
      key: "toolchain-executable-identity",
      requestField: "toolchain_ref",
      kind: "sca-toolchain",
      schemaId: SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.toolchain,
      value: invalidExecutableIdentity,
    });
    expect(admissionError({ store: toolchain.store, request: toolchainRequest }).code).toBe(
      "artifact_contract_mismatch"
    );
    expectNoCandidateWrites(toolchain.store);
  });

  it("cross-binds inline profile, fixed cognition, output namespace, and exact trusted producer", () => {
    const profile = fixture("profile-mismatch");
    expect(
      admissionError({
        store: profile.store,
        request: {
          ...profile.request,
          analysis_profile: {
            ...profile.request.analysis_profile,
            frameworks: [{ framework_id: "unknown-framework", language: "php" }],
          },
        },
      }).code
    ).toBe("artifact_contract_mismatch");
    expectNoCandidateWrites(profile.store);

    const model = fixture("model-mismatch");
    expect(
      admissionError({
        store: model.store,
        request: {
          ...model.request,
          runtime_cognition: { ...model.request.runtime_cognition, model: "other-model" },
        },
      }).code
    ).toBe("invalid_request");
    expectNoCandidateWrites(model.store);

    const output = fixture("output-mismatch");
    expect(
      admissionError({
        store: output.store,
        request: { ...output.request, report_namespace: "different-namespace" },
      }).code
    ).toBe("semantic_policy_denied");
    expectNoCandidateWrites(output.store);

    const producer = fixture("producer-mismatch");
    const untrusted = persistJson(producer.store, {
      runId: REUSABLE_RUN_ID,
      kind: "sca-network-policy",
      operationId: "untrusted-network",
      schemaId: SCA_NETWORK_POLICY_V1_SCHEMA,
      producer: "caller:untrusted",
      value: requiredValue(producer.values, "network"),
    });
    expect(
      admissionError({
        store: producer.store,
        request: { ...producer.request, network_policy_ref: untrusted },
      }).code
    ).toBe("artifact_contract_mismatch");
    expectNoCandidateWrites(producer.store);
  });

  it("rejects a campaign source scope mismatch before any candidate write", () => {
    const setup = fixture("source-scope-mismatch");
    const mismatchedSnapshot = {
      ...requiredRecord(setup.values, "source"),
      snapshot_id: "campaign-source-scope-mismatch",
      scope: { include_paths: ["app"], exclude_paths: ["app/generated"] },
    };
    const snapshotRef = persistJson(setup.store, {
      runId: RUN_ID,
      kind: "source-snapshot",
      operationId: "campaign-source-scope-mismatch",
      schemaId: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
      schemaVersion: 2,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
      value: mismatchedSnapshot,
    });
    const provenanceRef = persistJson(setup.store, {
      runId: RUN_ID,
      kind: "source-provenance",
      operationId: "campaign-source-scope-mismatch-provenance",
      schemaId: SCA_SOURCE_PROVENANCE_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
      value: {
        schema_id: SCA_SOURCE_PROVENANCE_V1_SCHEMA,
        schema_version: 1,
        snapshot_ref: snapshotRef,
        file_manifest_ref: requiredRef(setup.refs, "sourceManifest"),
        custody_ref: requiredRef(setup.refs, "sourceCustody"),
        custody_sha256: requiredRef(setup.refs, "sourceCustody").content_digest,
        capture_method: "host-frozen",
        custody_status: "verified",
      },
      upstreamRefs: [
        snapshotRef,
        requiredRef(setup.refs, "sourceManifest"),
        requiredRef(setup.refs, "sourceCustody"),
      ],
    });

    expect(
      admissionError({
        store: setup.store,
        request: {
          ...setup.request,
          source: { snapshot_ref: snapshotRef, provenance_ref: provenanceRef },
        },
      }).code
    ).toBe("artifact_contract_mismatch");
    expectNoCandidateWrites(setup.store);
  });

  it("rejects missing, tampered, misbound, or prewrite-mutated source material", () => {
    const setup = fixture("source-material-negatives");
    const sourceManifestRef = requiredRef(setup.refs, "sourceManifest");
    const sourceCustodyRef = requiredRef(setup.refs, "sourceCustody");

    const missing = artifactStoreView(setup.store, {
      refById: (artifactId) =>
        artifactId === sourceManifestRef.artifact_id ? undefined : setup.store.refById(artifactId),
    });
    expect(admissionError({ store: missing, request: setup.request }).code).toBe("missing_ref");

    const tampered = artifactStoreView(setup.store, {
      readById: (artifactId) =>
        artifactId === sourceCustodyRef.artifact_id
          ? Buffer.from("tampered custody", "utf8")
          : setup.store.readById(artifactId),
    });
    expect(admissionError({ store: tampered, request: setup.request }).code).toBe(
      "digest_mismatch"
    );

    const qualificationManifestRef = requiredRef(setup.refs, "qualificationSourceManifest");
    const qualificationCustodyRef = requiredRef(setup.refs, "qualificationSourceCustody");
    const misboundSnapshot = {
      ...requiredRecord(setup.values, "source"),
      file_manifest_ref: qualificationManifestRef,
      file_manifest_sha256: qualificationManifestRef.content_digest,
      custody_ref: qualificationCustodyRef,
      custody_sha256: qualificationCustodyRef.content_digest,
    };
    const misboundSnapshotRef = persistJson(setup.store, {
      runId: RUN_ID,
      kind: "source-snapshot",
      operationId: "campaign-source-misbound-material",
      schemaId: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
      schemaVersion: 2,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
      value: misboundSnapshot,
      upstreamRefs: [qualificationManifestRef, qualificationCustodyRef],
    });
    const misboundProvenanceRef = persistJson(setup.store, {
      runId: RUN_ID,
      kind: "source-provenance",
      operationId: "campaign-source-misbound-material-provenance",
      schemaId: SCA_SOURCE_PROVENANCE_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.source,
      value: {
        schema_id: SCA_SOURCE_PROVENANCE_V1_SCHEMA,
        schema_version: 1,
        snapshot_ref: misboundSnapshotRef,
        file_manifest_ref: qualificationManifestRef,
        custody_ref: qualificationCustodyRef,
        custody_sha256: qualificationCustodyRef.content_digest,
        capture_method: "host-frozen",
        custody_status: "verified",
      },
      upstreamRefs: [misboundSnapshotRef, qualificationManifestRef, qualificationCustodyRef],
    });
    expect(
      admissionError({
        store: setup.store,
        request: {
          ...setup.request,
          source: {
            snapshot_ref: misboundSnapshotRef,
            provenance_ref: misboundProvenanceRef,
          },
        },
      }).code
    ).toBe("artifact_contract_mismatch");

    let mutateBeforeWrite = false;
    let persistenceCalls = 0;
    const mutated = artifactStoreView(setup.store, {
      readById: (artifactId) =>
        mutateBeforeWrite && artifactId === sourceCustodyRef.artifact_id
          ? Buffer.from("mutated before candidate write", "utf8")
          : setup.store.readById(artifactId),
      persist: (input) => {
        persistenceCalls += 1;
        return setup.store.persist(input);
      },
    });
    expect(
      admissionError({
        store: mutated,
        request: setup.request,
        options: {
          onBoundary: (event) => {
            if (event.stage === "before_persist" && event.ordinal === 1) {
              mutateBeforeWrite = true;
            }
          },
        },
      }).code
    ).toBe("digest_mismatch");
    expect(persistenceCalls).toBe(0);
    expectNoCandidateWrites(setup.store);
  });

  it("rejects missing or misbound rule and tool material before writes", () => {
    const setup = fixture("rule-tool-material-negatives");
    const ruleBundleRef = requiredRef(setup.refs, "ruleBundle");
    const missingRuleBundle = artifactStoreView(setup.store, {
      refById: (artifactId) =>
        artifactId === ruleBundleRef.artifact_id ? undefined : setup.store.refById(artifactId),
    });
    expect(admissionError({ store: missingRuleBundle, request: setup.request }).code).toBe(
      "missing_ref"
    );

    const executableRef = requiredRef(setup.refs, "toolExecutable-01");
    const tamperedExecutable = artifactStoreView(setup.store, {
      readById: (artifactId) =>
        artifactId === executableRef.artifact_id
          ? Buffer.from("tampered executable", "utf8")
          : setup.store.readById(artifactId),
    });
    expect(admissionError({ store: tamperedExecutable, request: setup.request }).code).toBe(
      "digest_mismatch"
    );

    const invalidSelection = {
      ...requiredRecord(setup.values, "selectedRuleManifest"),
      selection_id: "rule-selection-invalid",
      selected_rule_ids: ["rule-does-not-exist"],
    };
    const invalidSelectionRef = persistJson(setup.store, {
      runId: REUSABLE_RUN_ID,
      kind: "sca-p01-selected-rule-manifest",
      operationId: "selected-rule-manifest-invalid",
      schemaId: SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.rules,
      value: invalidSelection,
      upstreamRefs: [setup.request.rule_release_ref, requiredRef(setup.refs, "ruleBundle")],
    });
    const invalidRuleProfile = {
      ...requiredRecord(setup.values, "ruleProfile"),
      selected_rule_manifest_ref: invalidSelectionRef,
      selection_sha256: invalidSelectionRef.content_digest,
    };
    const invalidRuleRequest = replaceRequestArtifact({
      setup,
      key: "rule-profile-invalid-selection",
      requestField: "rule_profile_ref",
      kind: "sca-rule-profile",
      schemaId: SCA_RULE_PROFILE_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.rules,
      value: invalidRuleProfile,
    });
    expect(admissionError({ store: setup.store, request: invalidRuleRequest }).code).toBe(
      "artifact_contract_mismatch"
    );

    const toolchain = validateScaToolchainIdentityV1(requiredValue(setup.values, "toolchain"));
    const firstTool = toolchain.tools[0];
    if (firstTool === undefined) throw new Error("toolchain fixture is empty");
    const wrongMeasurement = {
      ...requiredRecord(setup.values, "toolMeasurement-01"),
      tool_id: "different-tool",
    };
    const wrongMeasurementRef = persistJson(setup.store, {
      runId: REUSABLE_RUN_ID,
      kind: "sca-p01-tool-measurement-receipt",
      operationId: "tool-measurement-misbound",
      schemaId: SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.tool_measurement,
      value: wrongMeasurement,
      upstreamRefs: [firstTool.executable_ref],
    });
    const misboundToolchain = {
      ...toolchain,
      tools: [
        { ...firstTool, measurement_receipt_ref: wrongMeasurementRef },
        ...toolchain.tools.slice(1),
      ],
    };
    const request = replaceRequestArtifact({
      setup,
      key: "toolchain-misbound-measurement",
      requestField: "toolchain_ref",
      kind: "sca-toolchain",
      schemaId: SCA_TOOLCHAIN_IDENTITY_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.toolchain,
      value: misboundToolchain,
    });
    expect(admissionError({ store: setup.store, request }).code).toBe("semantic_policy_denied");
    expectNoCandidateWrites(setup.store);
  });

  it("rejects unknown request fields, unsafe scope, and exact-ref drift before writes", () => {
    const unknown = fixture("request-unknown");
    expect(
      admissionError({ store: unknown.store, request: { ...unknown.request, surprise: true } }).code
    ).toBe("invalid_request");
    expectNoCandidateWrites(unknown.store);

    const scope = fixture("scope-invalid");
    expect(
      admissionError({
        store: scope.store,
        request: {
          ...scope.request,
          scope: { include_paths: ["app", "app/security"], exclude_paths: [] },
        },
      }).code
    ).toBe("invalid_request");
    expectNoCandidateWrites(scope.store);

    const ref = fixture("ref-drift");
    expect(
      admissionError({
        store: ref.store,
        request: {
          ...ref.request,
          network_policy_ref: {
            ...ref.request.network_policy_ref,
            producer: "host:different-producer",
          },
        },
      }).code
    ).toBe("artifact_contract_mismatch");
    expectNoCandidateWrites(ref.store);
  });
});

describe("trusted implementation qualification", () => {
  it("uses distinct typed criterion/variant evidence including cancellation and interruption replay", () => {
    const setup = fixture("qualification-shape");
    const evidenceIds = setup.qualification.criteria.flatMap((criterion) =>
      criterion.variants.map((variant) => variant.evidence_ref.artifact_id)
    );
    const fixtureIds = setup.qualification.criteria.flatMap((criterion) =>
      criterion.variants.map((variant) => variant.fixture_ref.artifact_id)
    );
    expect(new Set(evidenceIds).size).toBe(evidenceIds.length);
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    for (const criterion of setup.qualification.criteria) {
      expect(criterion.variants.slice(0, 5).map((variant) => variant.variant_id)).toEqual([
        "normal",
        "negative",
        "recovery",
        "cancellation",
        "interruption-replay",
      ]);
      expect(
        criterion.variants
          .slice(0, 5)
          .every((variant) => variant.applicability === "applicable" && variant.status === "PASS")
      ).toBe(true);
      expect(
        criterion.variants.every(
          (variant) => variant.applicability === "applicable" && variant.status === "PASS"
        )
      ).toBe(true);
    }
    expect(
      admitCandidate({ store: setup.store, request: setup.request }).campaign_manifest_ref
    ).toBeDefined();
  });

  it("rejects a skipped required variant and missing or tampered raw evidence", () => {
    const setup = fixture("qualification-required-raw-evidence");
    const firstCriterion = setup.qualification.criteria[0];
    const firstVariant = firstCriterion?.variants[0];
    if (firstCriterion === undefined || firstVariant === undefined) {
      throw new Error("qualification matrix fixture is incomplete");
    }
    const skippedQualification = {
      ...setup.qualification,
      criteria: [
        {
          ...firstCriterion,
          status: "NOT RUN",
          variants: [{ ...firstVariant, status: "NOT RUN" }, ...firstCriterion.variants.slice(1)],
        },
        ...setup.qualification.criteria.slice(1),
      ],
      status: "NOT RUN",
    };
    const skippedRef = persistJson(setup.store, {
      runId: QUALIFICATION_RUN_ID,
      kind: "sca-phase-qualification",
      operationId: "qualification-skipped-required-variant",
      schemaId: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
      schemaVersion: 2,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.qualification,
      value: skippedQualification,
      upstreamRefs: scaPhaseQualificationRefs(setup.qualification),
    });
    expect(
      admissionError({
        store: setup.store,
        request: { ...setup.request, p01_qualification_ref: skippedRef },
      }).code
    ).toBe("unqualified_p01");

    const fixtureContentRef = requiredRef(setup.refs, "fixtureContent-01-01");
    const missingRawFixture = artifactStoreView(setup.store, {
      refById: (artifactId) =>
        artifactId === fixtureContentRef.artifact_id ? undefined : setup.store.refById(artifactId),
    });
    expect(admissionError({ store: missingRawFixture, request: setup.request }).code).toBe(
      "missing_ref"
    );

    const logContentRef = requiredRef(setup.refs, "logContent-01-01");
    const tamperedRawLog = artifactStoreView(setup.store, {
      readById: (artifactId) =>
        artifactId === logContentRef.artifact_id
          ? Buffer.from("tampered qualification log", "utf8")
          : setup.store.readById(artifactId),
    });
    expect(admissionError({ store: tamperedRawLog, request: setup.request }).code).toBe(
      "digest_mismatch"
    );
    expectNoCandidateWrites(setup.store);
  });

  it("rejects measured implementation source or build identity drift", () => {
    const setup = fixture("qualification-implementation-drift");
    const implementation = requiredRecord(setup.values, "implementation");
    const driftCases = [
      {
        operationId: "implementation-source-drift",
        identity: {
          ...implementation,
          source_sha256: requiredRef(setup.refs, "implementationBuild").content_digest,
        },
      },
      {
        operationId: "implementation-build-drift",
        identity: {
          ...implementation,
          build_sha256: requiredRef(setup.refs, "implementationSource").content_digest,
        },
      },
    ];
    for (const drift of driftCases) {
      const implementationRef = persistJson(setup.store, {
        runId: QUALIFICATION_RUN_ID,
        kind: "sca-implementation-identity",
        operationId: drift.operationId,
        schemaId: SCA_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
        producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.implementation,
        value: drift.identity,
        upstreamRefs: [
          requiredRef(setup.refs, "implementationSource"),
          requiredRef(setup.refs, "implementationBuild"),
        ],
      });
      const qualificationRef = persistJson(setup.store, {
        runId: QUALIFICATION_RUN_ID,
        kind: "sca-phase-qualification",
        operationId: `qualification-${drift.operationId}`,
        schemaId: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
        schemaVersion: 2,
        producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.qualification,
        value: { ...setup.qualification, implementation_ref: implementationRef },
        upstreamRefs: [implementationRef, ...scaPhaseQualificationRefs(setup.qualification)],
      });
      expect(
        admissionError({
          store: setup.store,
          request: { ...setup.request, p01_qualification_ref: qualificationRef },
        }).code,
        drift.operationId
      ).toBe("unqualified_p01");
    }
    expectNoCandidateWrites(setup.store);
  });

  it("rejects an untrusted qualification producer before writes", () => {
    const setup = fixture("qualification-producer");
    const untrustedQualificationRef = persistJson(setup.store, {
      runId: QUALIFICATION_RUN_ID,
      kind: "sca-phase-qualification",
      operationId: "untrusted-qualification",
      schemaId: SCA_PHASE_QUALIFICATION_RECORD_V2_SCHEMA,
      schemaVersion: 2,
      producer: "caller:untrusted",
      value: setup.qualification,
      upstreamRefs: scaPhaseQualificationRefs(setup.qualification),
    });
    expect(
      admissionError({
        store: setup.store,
        request: { ...setup.request, p01_qualification_ref: untrustedQualificationRef },
      }).code
    ).toBe("artifact_contract_mismatch");
    expectNoCandidateWrites(setup.store);
  });

  it("rejects reused evidence and stale host-boundary bindings before writes", () => {
    const reused = fixture("qualification-reused");
    const firstCriterion = reused.qualification.criteria[0];
    const secondCriterion = reused.qualification.criteria[1];
    if (firstCriterion === undefined || secondCriterion === undefined) {
      throw new Error("qualification fixture is incomplete");
    }
    const firstVariant = firstCriterion.variants[0];
    const secondVariant = secondCriterion.variants[0];
    if (firstVariant === undefined || secondVariant === undefined) {
      throw new Error("qualification variant fixture is incomplete");
    }
    const duplicateRecord: unknown = {
      ...reused.qualification,
      criteria: [
        firstCriterion,
        {
          ...secondCriterion,
          variants: [
            {
              ...secondVariant,
              fixture_ref: firstVariant.fixture_ref,
              evidence_ref: firstVariant.evidence_ref,
            },
            ...secondCriterion.variants.slice(1),
          ],
        },
        ...reused.qualification.criteria.slice(2),
      ],
    };
    expect(() => validateScaPhaseQualificationRecordV2(duplicateRecord)).toThrow(
      "distinct fixture and evidence"
    );

    const stale = fixture("qualification-stale-receipt");
    const criterion = stale.qualification.criteria[0];
    const variant = criterion?.variants[0];
    if (criterion === undefined || variant === undefined) throw new Error("fixture is incomplete");
    const originalEvidence = requiredRecord(stale.values, "evidence-01-01");
    const staleEvidence = { ...originalEvidence, job_id: "job-different" };
    const staleEvidenceRef = persistJson(stale.store, {
      runId: QUALIFICATION_RUN_ID,
      kind: "sca-qualification-evidence",
      operationId: "stale-evidence",
      schemaId: SCA_QUALIFICATION_EVIDENCE_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.evidence,
      value: staleEvidence,
      upstreamRefs: [
        requiredRef(stale.refs, "qualificationProfile"),
        variant.fixture_ref,
        requiredRef(stale.refs, "log-01-01"),
        requiredRef(stale.refs, "receipt-01-01"),
      ],
    });
    const staleRecord = validateScaPhaseQualificationRecordV2({
      ...stale.qualification,
      criteria: [
        {
          ...criterion,
          variants: [
            { ...variant, evidence_ref: staleEvidenceRef },
            ...criterion.variants.slice(1),
          ],
        },
        ...stale.qualification.criteria.slice(1),
      ],
    });
    const staleQualificationRef = replaceQualification(
      stale,
      staleRecord,
      "qualification-stale-receipt"
    );
    expect(
      admissionError({
        store: stale.store,
        request: { ...stale.request, p01_qualification_ref: staleQualificationRef },
      }).code
    ).toBe("unqualified_p01");
    expectNoCandidateWrites(stale.store);
  });

  it("requires exact trusted reviewer authority and separate execution lineage", () => {
    const setup = fixture("reviewer-lineage");
    const reviewerAuthority = {
      ...requiredRecord(setup.values, "reviewerAuthority"),
      reviewer_lineage_id: "lineage-implementer-run",
    };
    const authorityRef = persistJson(setup.store, {
      runId: QUALIFICATION_RUN_ID,
      kind: "sca-reviewer-authority",
      operationId: "reviewer-authority-overlap",
      schemaId: SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.reviewer_authority,
      value: reviewerAuthority,
    });
    const receipt = {
      ...requiredRecord(setup.values, "reviewReceipt"),
      receipt_id: "review-receipt-overlap",
      reviewer_authority_ref: authorityRef,
      reviewer_lineage_id: "lineage-implementer-run",
    };
    const receiptRef = persistJson(setup.store, {
      runId: QUALIFICATION_RUN_ID,
      kind: "sca-review-receipt",
      operationId: "review-receipt-overlap",
      schemaId: SCA_REVIEW_RECEIPT_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.review_receipt,
      value: receipt,
      upstreamRefs: [authorityRef, ...scaPhaseQualificationRefs(setup.qualification)],
    });
    const record = validateScaPhaseQualificationRecordV2({
      ...setup.qualification,
      reviewer_authority_ref: authorityRef,
      reviewer_receipt_ref: receiptRef,
    });
    const qualificationRef = replaceQualification(setup, record, "qualification-reviewer-overlap");
    expect(
      admissionError({
        store: setup.store,
        request: { ...setup.request, p01_qualification_ref: qualificationRef },
      }).code
    ).toBe("invalid_reviewer");
    expectNoCandidateWrites(setup.store);
  });
});

describe("topology and obligation revision mechanics", () => {
  it("encodes the exact P01 -> P02 -> M1 -> P03 -> P04 topology", () => {
    const setup = fixture("topology");
    const result = admitCandidate({ store: setup.store, request: setup.request });
    const ledger = validateScaObligationLedgerV2(parsed(setup.store, result.obligation_ledger_ref));
    const effective = effectiveScaObligations(ledger);
    const p01 = effective["SCA-OBL-P01-ACCEPTANCE"];
    const p02 = effective["SCA-OBL-P02-ACCEPTANCE"];
    const m1 = effective["SCA-OBL-M1-NONTERMINAL"];
    const p03 = effective["SCA-OBL-P03-ACCEPTANCE"];
    const p04 = effective["SCA-OBL-P04-ACCEPTANCE"];
    if (
      p01 === undefined ||
      p02 === undefined ||
      m1 === undefined ||
      p03 === undefined ||
      p04 === undefined
    ) {
      throw new Error("topology obligations are incomplete");
    }
    expect(p02.predecessor_ids[0]).toBe(p01.obligation_id);
    expect(m1.predecessor_ids).toEqual([
      p02.obligation_id,
      "SCA-OBL-OUTPUT-SOURCE-CENSUS",
      "SCA-OBL-OUTPUT-SYNTAX-INDEX",
      "SCA-OBL-OUTPUT-SEMGREP",
      "SCA-OBL-OUTPUT-SECRET-SCAN",
      "SCA-OBL-OUTPUT-DEPENDENCY-INVENTORY",
      "SCA-OBL-OUTPUT-OSV-EVIDENCE",
      "SCA-OBL-OUTPUT-NORMALIZED-CANDIDATES",
    ]);
    expect(m1.completion_effect).toBe("nonterminal");
    expect(m1.predecessor_ids.some((id) => id.includes("GRAPH"))).toBe(false);
    expect(p03.predecessor_ids).toEqual([
      m1.obligation_id,
      "SCA-OBL-OUTPUT-SOURCE-BOUND-GRAPH",
      "SCA-OBL-OUTPUT-BASELINE-GRAPH-QUERIES",
      "SCA-OBL-OUTPUT-GRAPH-CANDIDATES",
    ]);
    expect(p04.predecessor_ids).toEqual([
      p03.obligation_id,
      "SCA-OBL-BOUNDARY-MODEL-IDENTITY",
      "SCA-OBL-BOUNDARY-MODEL-DISCLOSURE",
      "SCA-OBL-OUTPUT-P04-SPECIALIST-DOSSIERS",
      "SCA-OBL-OUTPUT-P04-SELECTION-DOSSIER",
      "SCA-OBL-OUTPUT-P04-OMISSION-DOSSIER",
      "SCA-OBL-OUTPUT-P04-COVERAGE-DOSSIER",
    ]);
  });

  it("pins every known P04-P10 mandatory output into the exact phase topology", () => {
    const setup = fixture("mandatory-output-topology");
    const result = admitCandidate({ store: setup.store, request: setup.request });
    const ledger = validateScaObligationLedgerV2(parsed(setup.store, result.obligation_ledger_ref));
    const effective = effectiveScaObligations(ledger);
    const phaseTopology = [
      {
        phase: "SCA-P04",
        prior: "SCA-OBL-P03-ACCEPTANCE",
        outputIds: [
          "SCA-OBL-OUTPUT-P04-SPECIALIST-DOSSIERS",
          "SCA-OBL-OUTPUT-P04-SELECTION-DOSSIER",
          "SCA-OBL-OUTPUT-P04-OMISSION-DOSSIER",
          "SCA-OBL-OUTPUT-P04-COVERAGE-DOSSIER",
        ],
      },
      {
        phase: "SCA-P05",
        prior: "SCA-OBL-P04-ACCEPTANCE",
        outputIds: [
          "SCA-OBL-OUTPUT-P05-FALSIFIABLE-HYPOTHESES",
          "SCA-OBL-OUTPUT-P05-HYPOTHESIS-TRACEABILITY",
        ],
      },
      {
        phase: "SCA-P06",
        prior: "SCA-OBL-P05-ACCEPTANCE",
        outputIds: [
          "SCA-OBL-OUTPUT-P06-BOUNDED-INVESTIGATION-PLANS",
          "SCA-OBL-OUTPUT-P06-EVIDENCE-DECISION-PLANS",
        ],
      },
      {
        phase: "SCA-P07",
        prior: "SCA-OBL-P06-ACCEPTANCE",
        outputIds: [
          "SCA-OBL-OUTPUT-P07-BOUNDED-QUERY-EVIDENCE",
          "SCA-OBL-OUTPUT-P07-APPLICATION-TEST-EVIDENCE",
          "SCA-OBL-OUTPUT-P07-REACHABILITY-RECORDS",
          "SCA-OBL-OUTPUT-P07-ORACLE-RECORDS",
          "SCA-OBL-OUTPUT-P07-CLEANUP-RECORDS",
        ],
      },
      {
        phase: "SCA-P08",
        prior: "SCA-OBL-P07-ACCEPTANCE",
        outputIds: ["SCA-OBL-OUTPUT-P08-PER-ITEM-DISPOSITIONS"],
      },
      {
        phase: "SCA-P09",
        prior: "SCA-OBL-P08-ACCEPTANCE",
        outputIds: [
          "SCA-OBL-OUTPUT-P09-OBLIGATION-RECONCILIATION",
          "SCA-OBL-OUTPUT-P09-COVERAGE-RECONCILIATION",
          "SCA-OBL-OUTPUT-P09-REMAINING-GAPS",
        ],
      },
      {
        phase: "SCA-P10",
        prior: "SCA-OBL-P09-ACCEPTANCE",
        outputIds: [
          "SCA-OBL-OUTPUT-P10-RULE-CANDIDATE-REGISTRY",
          "SCA-OBL-OUTPUT-P10-RULE-TEST-FIXTURES",
          "SCA-OBL-OUTPUT-P10-RULE-VALIDATION-RESULTS",
          "SCA-OBL-OUTPUT-P10-RULE-QUARANTINE-RECORDS",
          "SCA-OBL-OUTPUT-P10-RULE-PROMOTION-DECISIONS",
          "SCA-OBL-OUTPUT-P10-RULE-LEARNING",
        ],
      },
    ] as const;
    for (const { phase, prior, outputIds } of phaseTopology) {
      const phaseGate = effective[`SCA-OBL-${phase.slice("SCA-".length)}-ACCEPTANCE`];
      if (phaseGate === undefined) throw new Error(`${phase} gate obligation is absent`);
      for (const outputId of outputIds) {
        expect(effective[outputId], outputId).toMatchObject({
          obligation_class: "required-result",
          scope: "phase-output",
          semantic_phase_id: phase,
          predecessor_ids: [prior],
          completion_effect: "required-for-campaign",
        });
        expect(phaseGate.predecessor_ids, `${phase} missing ${outputId}`).toContain(outputId);
      }
      const observedPhaseOutputIds = ledger.entries
        .filter((entry) => entry.semantic_phase_id === phase && entry.scope === "phase-output")
        .map((entry) => entry.obligation_id);
      expect(observedPhaseOutputIds, phase).toEqual(outputIds);
    }
  });

  it("records all classes, no-rule required work, and exploratory denial without weakening precedence", () => {
    const setup = fixture("obligation-goldens");
    const result = admitCandidate({ store: setup.store, request: setup.request });
    const ledger = validateScaObligationLedgerV2(parsed(setup.store, result.obligation_ledger_ref));
    expect(new Set(ledger.entries.map((entry) => entry.obligation_class))).toEqual(
      new Set(["required-result", "attempt-and-report", "optional"])
    );
    expect(
      ledger.entries.find((entry) => entry.obligation_id === "SCA-OBL-OUTPUT-P10-RULE-LEARNING")
    ).toMatchObject({
      obligation_class: "required-result",
      allowed_dispositions: ["pending", "satisfied", "blocked", "no-rule"],
    });
    expect(
      ledger.entries.find((entry) => entry.obligation_id === "SCA-OBL-BOUNDARY-PROMOTION-AUTHORITY")
    ).toMatchObject({
      obligation_class: "attempt-and-report",
      allowed_dispositions: ["pending", "attempted", "denied", "not-needed", "unavailable"],
    });
    for (const entry of ledger.entries) {
      expect(entry.purpose.length).toBeGreaterThan(0);
      expect(entry.source_mandate.requirement_id.length).toBeGreaterThan(0);
      expect(entry.assigning_authority_id).toBe("authority-admission");
      expect(entry.policy_refs.length).toBeGreaterThan(0);
      expect(entry.rationale.length).toBeGreaterThan(0);
      expect(entry.supporting_evidence_refs.length).toBeGreaterThan(0);
      expect(entry.precedence).toBeGreaterThan(0);
    }
  });

  it("requires the exact P11 report bundle and its P10 learning predecessor", () => {
    const setup = fixture("p11-obligation-bundle");
    const result = admitCandidate({ store: setup.store, request: setup.request });
    const ledger = validateScaObligationLedgerV2(parsed(setup.store, result.obligation_ledger_ref));
    const effective = effectiveScaObligations(ledger);
    const ruleLearningId = "SCA-OBL-OUTPUT-P10-RULE-LEARNING";
    const reportOutputIds = [
      "SCA-OBL-REPORT-MARKDOWN",
      "SCA-OBL-REPORT-STRUCTURED-JSON",
      "SCA-OBL-REPORT-SARIF",
      "SCA-OBL-REPORT-RECONCILIATION",
      "SCA-OBL-REPORT-CVSS-V4",
      "SCA-OBL-REPORT-CHECKSUM-MANIFEST",
      "SCA-OBL-REPORT-EPS-OBLIGATION-LEDGER",
      "SCA-OBL-REPORT-VALIDATION-RECORDS",
    ];
    expect(
      ledger.entries
        .filter((entry) => entry.scope === "report-output")
        .map((entry) => entry.obligation_id)
    ).toEqual(reportOutputIds);
    for (const obligationId of reportOutputIds) {
      expect(effective[obligationId]).toMatchObject({
        obligation_class: "required-result",
        scope: "report-output",
        semantic_phase_id: "SCA-P11",
        predecessor_ids: ["SCA-OBL-P10-ACCEPTANCE", ruleLearningId],
        completion_effect: "required-for-campaign",
      });
    }
    expect(effective[ruleLearningId]).toMatchObject({
      obligation_class: "required-result",
      scope: "phase-output",
      semantic_phase_id: "SCA-P10",
    });
    expect(effective["SCA-OBL-P11-ACCEPTANCE"]?.predecessor_ids).toEqual([
      "SCA-OBL-P10-ACCEPTANCE",
      ruleLearningId,
      ...reportOutputIds,
    ]);
  });

  it("appends a new registration and promotion, adopts exact replay, and preserves prior history", () => {
    const setup = fixture("obligation-revision");
    const admission = admitCandidate({ store: setup.store, request: setup.request });
    const policyRefs = sortedRefs([
      setup.request.authority_policy_ref,
      setup.request.resource_policy_ref,
    ]);
    const discovery = setup.request.source.provenance_ref;
    const registration = {
      schema_id: "penny.sca-obligation-revision-operation.v1",
      schema_version: 1,
      operation_id: "register-late-material-surface",
      action: "register",
      obligation_id: "SCA-OBL-DISCOVERED-LATE-SURFACE",
      requested_class: "optional",
      discovery_evidence_ref: discovery,
      policy_refs: policyRefs,
      rationale: "The surface is recorded before action and is not yet material.",
      scope_decision: "allow",
      authority_decision: "allow",
      resource_policy_decision: "allow",
      material: false,
      action_started: false,
      occurred_at: CREATED_AT,
      purpose: "Track one later-discovered security surface before action or reliance.",
      source_mandate: { mandate_kind: "discovery", requirement_id: "discovery-late-surface" },
      assigning_authority_id: "authority-admission",
      supporting_evidence_refs: [discovery],
      scope: "exploratory",
      semantic_phase_id: "SCA-P06",
      predecessor_ids: ["SCA-OBL-P06-ACCEPTANCE"],
      allowed_dispositions: ["pending", "omitted", "promoted"],
      completion_effect: "none",
    };
    const registeredRef = reviseScaP01ObligationLedgerCandidate({
      store: setup.store,
      prior_ledger_ref: admission.obligation_ledger_ref,
      operation: registration,
      authority_policy_ref: setup.request.authority_policy_ref,
      resource_policy_ref: setup.request.resource_policy_ref,
    });
    const replayRef = reviseScaP01ObligationLedgerCandidate({
      store: setup.store,
      prior_ledger_ref: admission.obligation_ledger_ref,
      operation: registration,
      authority_policy_ref: setup.request.authority_policy_ref,
      resource_policy_ref: setup.request.resource_policy_ref,
    });
    expect(replayRef).toEqual(registeredRef);

    const promotion = {
      schema_id: "penny.sca-obligation-revision-operation.v1",
      schema_version: 1,
      operation_id: "promote-late-material-surface",
      action: "promote",
      obligation_id: "SCA-OBL-DISCOVERED-LATE-SURFACE",
      requested_class: "required-result",
      discovery_evidence_ref: discovery,
      assigning_authority_id: "authority-admission",
      policy_refs: policyRefs,
      rationale: "New exact evidence makes this surface material to an in-scope claim.",
      scope_decision: "allow",
      authority_decision: "allow",
      resource_policy_decision: "allow",
      material: true,
      action_started: false,
      occurred_at: "2026-09-19T12:01:00.000Z",
      supporting_evidence_refs: [discovery],
    };
    const promotedRef = reviseScaP01ObligationLedgerCandidate({
      store: setup.store,
      prior_ledger_ref: registeredRef,
      operation: promotion,
      authority_policy_ref: setup.request.authority_policy_ref,
      resource_policy_ref: setup.request.resource_policy_ref,
    });
    const promoted = validateScaObligationLedgerV2(parsed(setup.store, promotedRef));
    const history = promoted.entries.filter(
      (entry) => entry.obligation_id === "SCA-OBL-DISCOVERED-LATE-SURFACE"
    );
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.obligation_class)).toEqual(["optional", "required-result"]);
    expect(history[0]?.entry_sha256).toBe(history[1]?.prior_entry_sha256);
    expect(effectiveScaObligations(promoted)["SCA-OBL-DISCOVERED-LATE-SURFACE"]).toMatchObject({
      effective_class: "required-result",
      precedence: 3,
    });
    expect(
      reviseScaP01ObligationLedgerCandidate({
        store: setup.store,
        prior_ledger_ref: registeredRef,
        operation: promotion,
        authority_policy_ref: setup.request.authority_policy_ref,
        resource_policy_ref: setup.request.resource_policy_ref,
      })
    ).toEqual(promotedRef);
  });

  it("reads and rejects denied, untrusted, or missing revision policies before persistence", () => {
    const setup = fixture("obligation-revision-policy-negatives");
    const admission = admitCandidate({ store: setup.store, request: setup.request });
    const deniedResourceRef = persistJson(setup.store, {
      runId: REUSABLE_RUN_ID,
      kind: "sca-resource-policy",
      operationId: "revision-resource-denied",
      schemaId: SCA_RESOURCE_POLICY_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.policy,
      value: { ...policyValues().resource, status: "denied" },
    });
    const untrustedAuthorityRef = persistJson(setup.store, {
      runId: REUSABLE_RUN_ID,
      kind: "sca-authority-policy",
      operationId: "revision-authority-untrusted",
      schemaId: SCA_AUTHORITY_POLICY_V1_SCHEMA,
      producer: "caller:untrusted",
      value: policyValues().authority,
    });
    const missingResourceValue = policyValues().resource;
    const missingResourceRef = previewArtifactRef({
      metadata: artifactMetadata({
        runId: REUSABLE_RUN_ID,
        kind: "sca-resource-policy",
        operationId: "revision-resource-missing",
        schemaId: SCA_RESOURCE_POLICY_V1_SCHEMA,
        producer: SCA_P01_TRUSTED_PRODUCERS.policy,
      }),
      content: canonicalJson(missingResourceValue),
    });
    const operation = (input: {
      readonly operationId: string;
      readonly authorityPolicyRef: ArtifactRef;
      readonly resourcePolicyRef: ArtifactRef;
    }) => ({
      schema_id: "penny.sca-obligation-revision-operation.v1",
      schema_version: 1,
      operation_id: input.operationId,
      action: "register",
      obligation_id: `SCA-OBL-${input.operationId.toUpperCase()}`,
      requested_class: "optional",
      discovery_evidence_ref: setup.request.source.provenance_ref,
      assigning_authority_id: "authority-admission",
      policy_refs: sortedRefs([input.authorityPolicyRef, input.resourcePolicyRef]),
      rationale: "Exercise a fail-closed revision-policy boundary.",
      scope_decision: "allow",
      authority_decision: "allow",
      resource_policy_decision: "allow",
      material: false,
      action_started: false,
      occurred_at: CREATED_AT,
      purpose: "Reject a revision before persistence when its exact policy cannot authorize it.",
      source_mandate: { mandate_kind: "discovery", requirement_id: input.operationId },
      supporting_evidence_refs: [setup.request.source.provenance_ref],
      scope: "exploratory",
      semantic_phase_id: "SCA-P06",
      predecessor_ids: ["SCA-OBL-P06-ACCEPTANCE"],
      allowed_dispositions: ["pending", "omitted"],
      completion_effect: "none",
    });

    const cases = [
      {
        expectedCode: "semantic_policy_denied",
        authorityPolicyRef: setup.request.authority_policy_ref,
        resourcePolicyRef: deniedResourceRef,
        operationId: "REVISION-DENIED",
      },
      {
        expectedCode: "artifact_contract_mismatch",
        authorityPolicyRef: untrustedAuthorityRef,
        resourcePolicyRef: setup.request.resource_policy_ref,
        operationId: "REVISION-UNTRUSTED",
      },
      {
        expectedCode: "missing_ref",
        authorityPolicyRef: setup.request.authority_policy_ref,
        resourcePolicyRef: missingResourceRef,
        operationId: "REVISION-MISSING",
      },
    ] as const;
    for (const testCase of cases) {
      const error = revisionError({
        store: setup.store,
        prior_ledger_ref: admission.obligation_ledger_ref,
        operation: operation(testCase),
        authority_policy_ref: testCase.authorityPolicyRef,
        resource_policy_ref: testCase.resourcePolicyRef,
      });
      expect(error.code, testCase.operationId).toBe(testCase.expectedCode);
      expect(candidateLedgerRevisionRef(setup.store, 2), testCase.operationId).toBeNull();
    }
  });

  it("rejects revision campaign, assigning-authority, and exact-policy-ref mismatches", () => {
    const setup = fixture("obligation-revision-binding-negatives");
    const admission = admitCandidate({ store: setup.store, request: setup.request });
    const wrongProjectAuthorityRef = persistJson(setup.store, {
      runId: REUSABLE_RUN_ID,
      kind: "sca-authority-policy",
      operationId: "revision-authority-wrong-project",
      schemaId: SCA_AUTHORITY_POLICY_V1_SCHEMA,
      producer: SCA_P01_TRUSTED_PRODUCERS.authority,
      value: { ...policyValues().authority, project_id: "different-project" },
    });
    const baseOperation = {
      schema_id: "penny.sca-obligation-revision-operation.v1",
      schema_version: 1,
      operation_id: "REVISION-BINDING-NEGATIVE",
      action: "register",
      obligation_id: "SCA-OBL-REVISION-BINDING-NEGATIVE",
      requested_class: "optional",
      discovery_evidence_ref: setup.request.source.provenance_ref,
      assigning_authority_id: "authority-admission",
      policy_refs: sortedRefs([
        setup.request.authority_policy_ref,
        setup.request.resource_policy_ref,
      ]),
      rationale: "Exercise exact campaign and policy binding.",
      scope_decision: "allow",
      authority_decision: "allow",
      resource_policy_decision: "allow",
      material: false,
      action_started: false,
      occurred_at: CREATED_AT,
      purpose: "Reject a semantically misbound obligation revision before persistence.",
      source_mandate: { mandate_kind: "discovery", requirement_id: "binding-negative" },
      supporting_evidence_refs: [setup.request.source.provenance_ref],
      scope: "exploratory",
      semantic_phase_id: "SCA-P06",
      predecessor_ids: ["SCA-OBL-P06-ACCEPTANCE"],
      allowed_dispositions: ["pending", "omitted"],
      completion_effect: "none",
    };

    expect(
      revisionError({
        store: setup.store,
        prior_ledger_ref: admission.obligation_ledger_ref,
        operation: {
          ...baseOperation,
          operation_id: "REVISION-WRONG-PROJECT",
          obligation_id: "SCA-OBL-REVISION-WRONG-PROJECT",
          policy_refs: sortedRefs([wrongProjectAuthorityRef, setup.request.resource_policy_ref]),
        },
        authority_policy_ref: wrongProjectAuthorityRef,
        resource_policy_ref: setup.request.resource_policy_ref,
      }).code
    ).toBe("artifact_contract_mismatch");
    expect(
      revisionError({
        store: setup.store,
        prior_ledger_ref: admission.obligation_ledger_ref,
        operation: {
          ...baseOperation,
          operation_id: "REVISION-WRONG-ASSIGNER",
          obligation_id: "SCA-OBL-REVISION-WRONG-ASSIGNER",
          assigning_authority_id: "authority-promotion",
        },
        authority_policy_ref: setup.request.authority_policy_ref,
        resource_policy_ref: setup.request.resource_policy_ref,
      }).code
    ).toBe("semantic_policy_denied");
    expect(
      revisionError({
        store: setup.store,
        prior_ledger_ref: admission.obligation_ledger_ref,
        operation: {
          ...baseOperation,
          operation_id: "REVISION-MISSING-POLICY-REF",
          obligation_id: "SCA-OBL-REVISION-MISSING-POLICY-REF",
          policy_refs: sortedRefs([
            setup.request.authority_policy_ref,
            setup.request.output_policy_ref,
          ]),
        },
        authority_policy_ref: setup.request.authority_policy_ref,
        resource_policy_ref: setup.request.resource_policy_ref,
      }).code
    ).toBe("semantic_policy_denied");
    expect(candidateLedgerRevisionRef(setup.store, 2)).toBeNull();
  });

  it("rejects mandatory weakening, denied expansion, action-before-registration, changed identity, and conflicting replay", () => {
    const setup = fixture("obligation-negatives");
    const admission = admitCandidate({ store: setup.store, request: setup.request });
    const prior = validateScaObligationLedgerV2(
      parsed(setup.store, admission.obligation_ledger_ref)
    );
    const policyRefs = sortedRefs([
      setup.request.authority_policy_ref,
      setup.request.resource_policy_ref,
    ]);
    const base = {
      schema_id: "penny.sca-obligation-revision-operation.v1",
      schema_version: 1,
      operation_id: "register-negative",
      action: "register",
      obligation_id: "SCA-OBL-DISCOVERED-NEGATIVE",
      requested_class: "attempt-and-report",
      discovery_evidence_ref: setup.request.source.provenance_ref,
      policy_refs: policyRefs,
      rationale: "Negative contract fixture.",
      scope_decision: "allow",
      authority_decision: "allow",
      resource_policy_decision: "allow",
      material: true,
      action_started: false,
      occurred_at: CREATED_AT,
      purpose: "Reject weakening of newly material discovered work.",
      source_mandate: { mandate_kind: "discovery", requirement_id: "negative-discovery" },
      assigning_authority_id: "authority-admission",
      supporting_evidence_refs: [setup.request.source.provenance_ref],
      scope: "exploratory",
      semantic_phase_id: "SCA-P06",
      predecessor_ids: ["SCA-OBL-P06-ACCEPTANCE"],
      allowed_dispositions: ["pending", "attempted", "denied"],
      completion_effect: "required-for-campaign",
    };
    for (const mutant of [
      base,
      { ...base, requested_class: "required-result", authority_decision: "deny" },
      { ...base, requested_class: "required-result", action_started: true },
    ]) {
      expect(() =>
        appendScaObligationLedgerV2({
          prior_ledger: prior,
          prior_ledger_ref: admission.obligation_ledger_ref,
          operation: mutant,
          authority_policy_ref: setup.request.authority_policy_ref,
          resource_policy_ref: setup.request.resource_policy_ref,
        })
      ).toThrow();
    }

    const foreignEvidence = persistJson(setup.store, {
      runId: REUSABLE_RUN_ID,
      kind: "discovery-evidence",
      operationId: "foreign-discovery",
      schemaId: "penny.sca-discovery-evidence.v1",
      producer: "host:sca-admission",
      value: { schema_id: "penny.sca-discovery-evidence.v1", schema_version: 1 },
    });
    expect(() =>
      appendScaObligationLedgerV2({
        prior_ledger: prior,
        prior_ledger_ref: admission.obligation_ledger_ref,
        operation: {
          ...base,
          requested_class: "required-result",
          discovery_evidence_ref: foreignEvidence,
          supporting_evidence_refs: [foreignEvidence],
        },
        authority_policy_ref: setup.request.authority_policy_ref,
        resource_policy_ref: setup.request.resource_policy_ref,
      })
    ).toThrow("exact campaign run");

    const valid = { ...base, requested_class: "required-result", material: true };
    const firstRef = reviseScaP01ObligationLedgerCandidate({
      store: setup.store,
      prior_ledger_ref: admission.obligation_ledger_ref,
      operation: valid,
      authority_policy_ref: setup.request.authority_policy_ref,
      resource_policy_ref: setup.request.resource_policy_ref,
    });
    expect(firstRef.version).toBe(2);
    const registered = validateScaObligationLedgerV2(parsed(setup.store, firstRef));
    expect(() =>
      appendScaObligationLedgerV2({
        prior_ledger: registered,
        prior_ledger_ref: firstRef,
        operation: {
          schema_id: "penny.sca-obligation-revision-operation.v1",
          schema_version: 1,
          operation_id: "downgrade-after-registration",
          action: "promote",
          obligation_id: "SCA-OBL-DISCOVERED-NEGATIVE",
          requested_class: "attempt-and-report",
          discovery_evidence_ref: setup.request.source.provenance_ref,
          assigning_authority_id: "authority-admission",
          policy_refs: policyRefs,
          rationale: "A failure cannot justify a downgrade.",
          scope_decision: "allow",
          authority_decision: "allow",
          resource_policy_decision: "allow",
          material: false,
          action_started: false,
          occurred_at: "2026-09-19T12:01:00.000Z",
          supporting_evidence_refs: [setup.request.source.provenance_ref],
        },
        authority_policy_ref: setup.request.authority_policy_ref,
        resource_policy_ref: setup.request.resource_policy_ref,
      })
    ).toThrow("strictly stronger");
    expect(() =>
      reviseScaP01ObligationLedgerCandidate({
        store: setup.store,
        prior_ledger_ref: admission.obligation_ledger_ref,
        operation: { ...valid, rationale: "Conflicting replay operands." },
        authority_policy_ref: setup.request.authority_policy_ref,
        resource_policy_ref: setup.request.resource_policy_ref,
      })
    ).toThrow("ref diverged");
  });
});

// A child-process qualification entrypoint. The parent supplies one exact persisted
// fixture and requires the exclusive observation file; ordinary test runs skip it.
const qualificationFixturePath = process.env.PENNY_P01_QUALIFICATION_FIXTURE_PATH;
it.skipIf(qualificationFixturePath === undefined)(
  "executes one fixture-bound P01 qualification case with dispatch observation",
  () => {
    if (qualificationFixturePath === undefined) throw new Error("missing qualification fixture");
    const raw = readFileSync(qualificationFixturePath);
    expect(sha256(raw)).toBe(process.env.PENNY_P01_QUALIFICATION_FIXTURE_SHA256);
    const cell = validateContract(
      Type.Object(
        {
          criterion_id: Type.Union(SCA_P01_REQUIRED_CRITERION_IDS.map((id) => Type.Literal(id))),
          variant_id: Type.Union(SCA_P01_QUALIFICATION_VARIANT_IDS.map((id) => Type.Literal(id))),
          nonce: Type.String({ minLength: 1 }),
          test_file: Type.Literal("tests/sca-p01-admission.test.ts"),
          test_name: Type.Literal(
            "executes one fixture-bound P01 qualification case with dispatch observation"
          ),
        },
        { additionalProperties: false }
      ),
      JSON.parse(raw.toString("utf8")),
      "qualification child fixture"
    );
    expect(raw.toString("utf8")).toBe(canonicalJson(cell));
    const rawSetup = fixture(`qualification-${cell.nonce}-${cell.criterion_id}-${cell.variant_id}`);
    const setup =
      cell.criterion_id === SCA_P01_REQUIRED_CRITERION_IDS[2]
        ? withVariantCapture(rawSetup)
        : rawSetup;
    const observer = installP01HostDispatchObserver();
    try {
      // Prove each patched host boundary fires on a real, local, no-data attempt
      // before measuring P01. Use a new baseline rather than decrementing counters.
      const selfTestBefore = observer.snapshot();
      attemptSafeChildBoundary();
      attemptSafeTcpBoundary();
      attemptSafeUnixBoundary(observer.safeUnixPath);
      const selfTestAfter = observer.snapshot();
      const selfTestDelta = {
        model: selfTestAfter.model - selfTestBefore.model,
        scanner: selfTestAfter.scanner - selfTestBefore.scanner,
        application: selfTestAfter.application - selfTestBefore.application,
      };
      expect(selfTestDelta).toEqual({ model: 1, scanner: 1, application: 1 });
      const probe = observer;
      // This is the only baseline for the complete fixture/admission span. Keep the
      // observer self-test outside that span and never rebase after work starts.
      const baseline = probe.snapshot();
      const syntheticDetections: { channel: string; code: string; delta: number }[] = [];
      const { criterion_id: criterion, variant_id: variant } = cell;

      if (criterion === SCA_P01_REQUIRED_CRITERION_IDS[0]) {
        if (variant === "negative" || variant === "unsupported" || variant === "denial") {
          const request =
            variant === "negative"
              ? { ...setup.request, unexpected: true }
              : variant === "unsupported"
                ? {
                    ...setup.request,
                    runtime_cognition: { ...setup.request.runtime_cognition, model: "unsupported" },
                  }
                : { ...setup.request, scope: { ...setup.request.scope, include_paths: ["other"] } };
          expect(
            admissionError({ store: setup.store, request, options: { dispatchProbe: probe } }).code
          ).toMatch(/invalid_request|wrong_model_identity|invalid_scope|source_scope_mismatch/u);
          expectNoCandidateWrites(setup.store);
        } else if (variant === "cancellation") {
          const controller = new AbortController();
          controller.abort();
          expect(
            admissionError({
              store: setup.store,
              request: setup.request,
              options: { dispatchProbe: probe, signal: controller.signal },
            }).code
          ).toBe("cancelled");
          expectNoCandidateWrites(setup.store);
        } else if (variant === "failure" || variant === "truncation") {
          const source = setup.request.source.snapshot_ref;
          const view = artifactStoreView(
            setup.store,
            variant === "truncation"
              ? {
                  readById: (id) =>
                    id === source.artifact_id
                      ? setup.store.readById(id).subarray(0, 8)
                      : setup.store.readById(id),
                }
              : {
                  refById: (id) =>
                    id === source.artifact_id ? undefined : setup.store.refById(id),
                }
          );
          expect(
            admissionError({
              store: view,
              request: setup.request,
              options: { dispatchProbe: probe },
            }).code
          ).toMatch(/digest_mismatch|missing_ref/u);
          expectNoCandidateWrites(setup.store);
        } else if (variant === "fixed-safe") {
          expect(setup.request.runtime_cognition.model).toBeTruthy();
          expect(setup.request.authorities.execution_authority_id).not.toBe(
            setup.request.authorities.release_authority_id
          );
        } else if (variant === "no-alert") {
          expect(probe.snapshot()).toEqual(baseline);
        }
      } else if (criterion === SCA_P01_REQUIRED_CRITERION_IDS[1]) {
        const first = setup.qualification.criteria[0]?.variants[0];
        if (first === undefined) throw new Error("missing qualification variant");
        if (variant === "denial") {
          const authorityRef = persistJson(setup.store, {
            runId: QUALIFICATION_RUN_ID,
            kind: "sca-reviewer-authority",
            operationId: `review-denied-${sha256(cell.nonce).slice(0, 16)}`,
            schemaId: SCA_REVIEWER_AUTHORITY_V1_SCHEMA,
            producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.reviewer_authority,
            value: { ...requiredRecord(setup.values, "reviewerAuthority"), decision: "denied" },
          });
          const receiptRef = persistJson(setup.store, {
            runId: QUALIFICATION_RUN_ID,
            kind: "sca-review-receipt",
            operationId: `receipt-denied-${sha256(cell.nonce).slice(0, 16)}`,
            schemaId: SCA_REVIEW_RECEIPT_V1_SCHEMA,
            producer: SCA_P01_TRUSTED_QUALIFICATION_PRODUCERS.review_receipt,
            value: {
              ...requiredRecord(setup.values, "reviewReceipt"),
              reviewer_authority_ref: authorityRef,
              decision: "BLOCKED",
            },
            upstreamRefs: [authorityRef, ...scaPhaseQualificationRefs(setup.qualification)],
          });
          const qualificationRef = replaceQualification(
            setup,
            {
              ...setup.qualification,
              reviewer_authority_ref: authorityRef,
              reviewer_receipt_ref: receiptRef,
            },
            `qualification-denied-${sha256(cell.nonce).slice(0, 16)}`
          );
          expect(
            admissionError({
              store: setup.store,
              request: { ...setup.request, p01_qualification_ref: qualificationRef },
              options: { dispatchProbe: probe },
            }).code
          ).toBe("invalid_reviewer");
          expectNoCandidateWrites(setup.store);
        } else if (variant === "negative" || variant === "unsupported") {
          const record = {
            ...setup.qualification,
            criteria: setup.qualification.criteria.map((c, i) =>
              i === 0
                ? {
                    ...c,
                    status: "NOT RUN" as const,
                    variants: c.variants.map((v, j) =>
                      j === 0 ? { ...v, status: "NOT RUN" as const } : v
                    ),
                  }
                : c
            ),
            status: "NOT RUN" as const,
          };
          if (variant === "unsupported") {
            expect(() =>
              validateScaPhaseQualificationRecordV2({
                ...setup.qualification,
                criteria: setup.qualification.criteria.map((c, i) =>
                  i === 0
                    ? {
                        ...c,
                        variants: c.variants.map((v, j) =>
                          j === 0 ? { ...v, variant_id: "unsupported-variant" } : v
                        ),
                      }
                    : c
                ),
              })
            ).toThrow();
          }
          const qualificationRef = replaceQualification(
            setup,
            record,
            `fixture-${variant}-${cell.nonce}`
          );
          expect(
            admissionError({
              store: setup.store,
              request: { ...setup.request, p01_qualification_ref: qualificationRef },
              options: { dispatchProbe: probe },
            }).code
          ).toBe("unqualified_p01");
          expectNoCandidateWrites(setup.store);
        } else if (variant === "failure" || variant === "truncation") {
          const rawLog = requiredRef(setup.refs, "logContent-01-01");
          const view = artifactStoreView(setup.store, {
            readById: (id) =>
              id === rawLog.artifact_id
                ? variant === "truncation"
                  ? setup.store.readById(id).subarray(0, 4)
                  : Buffer.from("changed")
                : setup.store.readById(id),
          });
          expect(
            admissionError({
              store: view,
              request: setup.request,
              options: { dispatchProbe: probe },
            }).code
          ).toBe("digest_mismatch");
          expectNoCandidateWrites(setup.store);
        } else if (variant === "fixed-safe" || variant === "no-alert") {
          expect(
            new Set(
              setup.qualification.criteria.flatMap((c) =>
                c.variants.map((v) => v.evidence_ref.artifact_id)
              )
            ).size
          ).toBe(44);
          expect(first.status).toBe("PASS");
        } else if (variant === "cancellation") {
          const controller = new AbortController();
          controller.abort();
          expect(
            admissionError({
              store: setup.store,
              request: setup.request,
              options: { dispatchProbe: probe, signal: controller.signal },
            }).code
          ).toBe("cancelled");
          expectNoCandidateWrites(setup.store);
        }
      } else if (criterion === SCA_P01_REQUIRED_CRITERION_IDS[2]) {
        const capture = captureOf(setup);
        expect(capture.manifest.entries.map((entry) => entry.label)).toEqual(["alpha", "beta"]);
        const bound = admitScaP01Candidate({
          store: setup.store,
          request: setup.request,
          options: { dispatchProbe: probe },
        });
        const evidence = validateScaP01AdmissionEvidenceV1(
          parsed(setup.store, bound.admission_evidence_ref)
        );
        for (const ref of capture.all_refs) expect(evidence.evidence_refs).toContainEqual(ref);
        validateFixtureContext(setup, bound);
        const { variant_capture_manifest_ref: _captureRef, ...legacySource } = setup.request.source;
        expect(() =>
          validateFixtureContext(setup, bound, {
            request: { ...setup.request, source: legacySource },
          })
        ).toThrow(/freeze/u);
        if (["negative", "unsupported", "failure", "denial", "truncation"].includes(variant)) {
          const admitted = admitScaP01Candidate({
            store: setup.store,
            request: setup.request,
            options: { dispatchProbe: probe },
          });
          const ledger = validateScaObligationLedgerV2(
            parsed(setup.store, admitted.obligation_ledger_ref)
          );
          if (variant === "denial") {
            const discovery = setup.request.source.provenance_ref;
            const deniedOperation = {
              schema_id: "penny.sca-obligation-revision-operation.v1",
              schema_version: 1,
              operation_id: `denied-${cell.nonce}`,
              action: "register",
              obligation_id: "SCA-OBL-DENIED-SURFACE",
              requested_class: "optional",
              discovery_evidence_ref: discovery,
              assigning_authority_id: "authority-admission",
              policy_refs: sortedRefs([
                setup.request.authority_policy_ref,
                setup.request.resource_policy_ref,
              ]),
              supporting_evidence_refs: [discovery],
              rationale: "Deny the proposed revision.",
              scope_decision: "allow",
              authority_decision: "deny",
              resource_policy_decision: "allow",
              material: false,
              action_started: false,
              occurred_at: CREATED_AT,
              purpose: "Verify a denied obligation revision does not enter the ledger.",
              source_mandate: { mandate_kind: "discovery", requirement_id: "denied-surface" },
              scope: "exploratory",
              semantic_phase_id: "SCA-P06",
              predecessor_ids: ["SCA-OBL-P06-ACCEPTANCE"],
              allowed_dispositions: ["pending", "omitted"],
              completion_effect: "none",
            };
            expect(() =>
              appendScaObligationLedgerV2({
                prior_ledger: ledger,
                prior_ledger_ref: admitted.obligation_ledger_ref,
                operation: deniedOperation,
                authority_policy_ref: setup.request.authority_policy_ref,
                resource_policy_ref: setup.request.resource_policy_ref,
              })
            ).toThrow();
          }
          const altered: unknown =
            variant === "truncation"
              ? { ...ledger, events: ledger.events.slice(0, -1) }
              : variant === "unsupported"
                ? { ...ledger, version: 2 }
                : variant === "failure"
                  ? { ...ledger, ledger_sha256: sha256("wrong") }
                  : { ...ledger, entries: ledger.entries.slice(1) };
          if (variant !== "denial") expect(() => validateScaObligationLedgerV2(altered)).toThrow();
        } else if (variant === "cancellation") {
          const controller = new AbortController();
          controller.abort();
          expect(
            admissionError({
              store: setup.store,
              request: setup.request,
              options: { dispatchProbe: probe, signal: controller.signal },
            }).code
          ).toBe("cancelled");
        } else if (variant === "fixed-safe" || variant === "no-alert") {
          const result = admitScaP01Candidate({
            store: setup.store,
            request: setup.request,
            options: { dispatchProbe: probe },
          });
          const ledger = validateScaObligationLedgerV2(
            parsed(setup.store, result.obligation_ledger_ref)
          );
          expect(effectiveScaObligations(ledger)["SCA-OBL-P01-ACCEPTANCE"]?.obligation_class).toBe(
            "required-result"
          );
          expect(
            effectiveScaObligations(ledger)["SCA-OBL-OPTIONAL-NATIVE-GRAPH-ESCALATION"]
              ?.obligation_class
          ).toBe("optional");
        }
      } else {
        if (variant === "negative") {
          // Exercise the fail-closed admission gate with synthetic monotonic
          // counters. Real host-boundary detector health was established before
          // the immutable measurement baseline, so this negative test cannot
          // dispatch or require rebasing the measured fixture span.
          for (const channel of ["scanner", "model", "application"] as const) {
            const negative = fixture(`qualification-${cell.nonce}-dispatch-${channel}`);
            const counters = { model: 0, scanner: 0, application: 0 };
            const syntheticProbe = { snapshot: () => ({ ...counters }) };
            const before = syntheticProbe.snapshot();
            let triggered = false;
            const code = admissionError({
              store: negative.store,
              request: negative.request,
              options: {
                dispatchProbe: syntheticProbe,
                onBoundary: (event) => {
                  if (event.stage === "before_artifact_read" && !triggered) {
                    triggered = true;
                    counters[channel] += 1;
                  }
                },
              },
            }).code;
            const after = syntheticProbe.snapshot();
            expect(triggered).toBe(true);
            expect(code).toBe("dispatch_detected");
            expect(after[channel] - before[channel]).toBe(1);
            expectNoCandidateWrites(negative.store);
            syntheticDetections.push({
              channel,
              code,
              delta: after[channel] - before[channel],
            });
          }
          expectNoCandidateWrites(setup.store);
        } else if (variant === "denial") {
          const denied = replaceRequestArtifact({
            setup,
            key: `fixture-denied-${cell.nonce}`,
            requestField: "authority_policy_ref",
            kind: "sca-authority-policy",
            schemaId: SCA_AUTHORITY_POLICY_V1_SCHEMA,
            producer: SCA_P01_TRUSTED_PRODUCERS.authority,
            value: { ...requiredRecord(setup.values, "authority"), admission_decision: "deny" },
          });
          expect(
            admissionError({
              store: setup.store,
              request: denied,
              options: { dispatchProbe: probe },
            }).code
          ).toBe("semantic_policy_denied");
          expectNoCandidateWrites(setup.store);
        } else if (variant === "cancellation") {
          const controller = new AbortController();
          controller.abort();
          expect(
            admissionError({
              store: setup.store,
              request: setup.request,
              options: { dispatchProbe: probe, signal: controller.signal },
            }).code
          ).toBe("cancelled");
          expectNoCandidateWrites(setup.store);
        } else if (variant === "unsupported") {
          expect(
            admissionError({
              store: setup.store,
              request: setup.request,
              withoutDispatchObserver: true,
            }).code
          ).toBe("dispatch_observer_unavailable");
        } else if (variant === "failure") {
          const broken = instrumentedStore(setup.store, 1);
          expect(
            admissionError({
              store: broken.store,
              request: setup.request,
              options: { dispatchProbe: probe },
            }).code
          ).toBe("persistence_failed");
        } else if (variant === "truncation") {
          const log = requiredRef(setup.refs, "logContent-01-01");
          const broken = artifactStoreView(setup.store, {
            readById: (id) =>
              id === log.artifact_id
                ? setup.store.readById(id).subarray(0, 4)
                : setup.store.readById(id),
          });
          expect(
            admissionError({
              store: broken,
              request: setup.request,
              options: { dispatchProbe: probe },
            }).code
          ).toBe("digest_mismatch");
          expectNoCandidateWrites(setup.store);
        } else if (variant === "fixed-safe" || variant === "no-alert") {
          expect(probe.snapshot().model).toBe(baseline.model);
        }
      }
      if (variant === "interruption-replay") {
        // Some criterion-specific assertions above intentionally complete an
        // admission before the shared interruption/replay check. Exercise the
        // interrupted first attempt in an independent fixture so a previously
        // admitted marker cannot turn this into a replay-only assertion.
        const interruptedSetup = fixture(`interruption-${cell.nonce}`);
        const broken = instrumentedStore(interruptedSetup.store, 3);
        expect(
          admissionError({
            store: broken.store,
            request: interruptedSetup.request,
            options: { dispatchProbe: probe },
          }).code
        ).toBe("persistence_failed");
        expect(
          campaignCandidateRef(interruptedSetup.store, "sca-p01-candidate-campaign-manifest")
        ).toBeNull();
        const recovered = admitScaP01Candidate({
          store: interruptedSetup.store,
          request: interruptedSetup.request,
          options: { dispatchProbe: probe },
        });
        expect(
          admitScaP01Candidate({
            store: interruptedSetup.store,
            request: interruptedSetup.request,
            options: { dispatchProbe: probe },
          })
        ).toEqual(recovered);
      }
      const result = admitScaP01Candidate({
        store: setup.store,
        request: setup.request,
        options: { dispatchProbe: probe },
      });
      if (variant === "recovery") {
        const reopened = ArtifactStore.openExisting(setup.store.root, {
          projectId: ARTIFACT_PROJECT_ID,
        });
        try {
          expect(
            admitScaP01Candidate({
              store: reopened,
              request: setup.request,
              options: { dispatchProbe: probe },
            })
          ).toEqual(result);
        } finally {
          reopened.close();
        }
      }
      const replay = admitScaP01Candidate({
        store: setup.store,
        request: setup.request,
        options: { dispatchProbe: probe },
      });
      expect(replay).toEqual(result);
      if (criterion === SCA_P01_REQUIRED_CRITERION_IDS[2]) {
        const discovery = setup.request.source.provenance_ref;
        const operation = {
          schema_id: "penny.sca-obligation-revision-operation.v1",
          schema_version: 1,
          operation_id: `fixture-${sha256(cell.nonce).slice(0, 16)}`,
          action: "register",
          obligation_id: "SCA-OBL-QUALIFICATION-REVISION",
          requested_class: "optional",
          discovery_evidence_ref: discovery,
          assigning_authority_id: "authority-admission",
          policy_refs: sortedRefs([
            setup.request.authority_policy_ref,
            setup.request.resource_policy_ref,
          ]),
          supporting_evidence_refs: [discovery],
          rationale: "Register the fixture-bound optional surface before action.",
          scope_decision: "allow",
          authority_decision: "allow",
          resource_policy_decision: "allow",
          material: false,
          action_started: false,
          occurred_at: CREATED_AT,
          purpose: "Exercise exact obligation revision, replay, and cancellation boundaries.",
          source_mandate: { mandate_kind: "discovery", requirement_id: "qualification-revision" },
          scope: "exploratory",
          semantic_phase_id: "SCA-P06",
          predecessor_ids: ["SCA-OBL-P06-ACCEPTANCE"],
          allowed_dispositions: ["pending", "omitted"],
          completion_effect: "none",
        };
        const revisionInput = {
          store: setup.store,
          prior_ledger_ref: result.obligation_ledger_ref,
          operation,
          authority_policy_ref: setup.request.authority_policy_ref,
          resource_policy_ref: setup.request.resource_policy_ref,
        };
        if (variant === "cancellation") {
          const controller = new AbortController();
          controller.abort();
          expect(
            revisionError({ ...revisionInput, options: { signal: controller.signal } }).code
          ).toBe("cancelled");
        }
        if (variant === "interruption-replay") {
          const interrupted = instrumentedStore(setup.store, 1);
          expect(revisionError({ ...revisionInput, store: interrupted.store }).code).toBe(
            "persistence_failed"
          );
        }
        const revised = reviseScaP01ObligationLedgerCandidate(revisionInput);
        expect(reviseScaP01ObligationLedgerCandidate(revisionInput)).toEqual(revised);
        expect(validateScaObligationLedgerV2(parsed(setup.store, revised)).version).toBe(2);
        if (variant === "recovery") {
          const reopened = ArtifactStore.openExisting(setup.store.root, {
            projectId: ARTIFACT_PROJECT_ID,
          });
          try {
            expect(
              reviseScaP01ObligationLedgerCandidate({ ...revisionInput, store: reopened })
            ).toEqual(revised);
          } finally {
            reopened.close();
          }
        }
      }
      expect(observer.snapshotCount()).toBeGreaterThan(2);
      const final = probe.snapshot();
      const delta = {
        model: final.model - baseline.model,
        scanner: final.scanner - baseline.scanner,
        application: final.application - baseline.application,
      };
      // Synthetic gate detections do not alter the real host counters measured
      // from the one post-self-test baseline through admission and replay.
      if (variant === "negative" && criterion === SCA_P01_REQUIRED_CRITERION_IDS[3])
        expect(syntheticDetections).toHaveLength(3);
      expect(delta).toEqual({ model: 0, scanner: 0, application: 0 });
      const observationPath = process.env.PENNY_P01_QUALIFICATION_OBSERVATION_PATH;
      if (observationPath === undefined) throw new Error("missing observation destination");
      writeFileSync(
        observationPath,
        canonicalJson({
          schema_id: "penny.sca-p01-child-observation.v3",
          nonce: cell.nonce,
          fixture_sha256: sha256(raw),
          criterion_id: criterion,
          variant_id: variant,
          snapshots: observer.snapshotCount(),
          self_test: { before: selfTestBefore, after: selfTestAfter, delta: selfTestDelta },
          measurement_scope: "single-post-self-test-baseline",
          synthetic_dispatch_detections: syntheticDetections,
          baseline,
          final,
          delta,
          manifest_ref: result.campaign_manifest_ref.artifact_id,
        }),
        { flag: "wx" }
      );
    } finally {
      observer.restore();
    }
  }
);

describe("cancellation, interruption, replay, and conflict", () => {
  it("requires an available dispatch observer before any artifact read or write", () => {
    const missing = fixture("missing-dispatch-observer");
    const missingStore = instrumentedStore(missing.store);
    expect(
      admissionError({
        store: missingStore.store,
        request: missing.request,
        withoutDispatchObserver: true,
      }).code
    ).toBe("dispatch_observer_unavailable");
    expect(missingStore.counts).toEqual({ reads: 0, persists: 0 });
    expectNoCandidateWrites(missing.store);

    const unavailable = fixture("unavailable-dispatch-observer");
    const unavailableStore = instrumentedStore(unavailable.store);
    expect(
      admissionError({
        store: unavailableStore.store,
        request: unavailable.request,
        options: {
          dispatchProbe: {
            snapshot: () => {
              throw new Error("observer unavailable");
            },
          },
        },
      }).code
    ).toBe("dispatch_observer_unavailable");
    expect(unavailableStore.counts).toEqual({ reads: 0, persists: 0 });
    expectNoCandidateWrites(unavailable.store);

    const lateUnavailable = fixture("late-unavailable-dispatch-observer");
    let observations = 0;
    expect(
      admissionError({
        store: lateUnavailable.store,
        request: lateUnavailable.request,
        options: {
          dispatchProbe: {
            snapshot: () => {
              observations += 1;
              if (observations >= 4) throw new Error("observer became unavailable");
              return { model: 0, scanner: 0, application: 0 };
            },
          },
        },
      }).code
    ).toBe("dispatch_observer_unavailable");
    expect(observations).toBe(4);
    expect(
      campaignCandidateRef(lateUnavailable.store, "sca-p01-candidate-campaign-manifest")
    ).toBeNull();
  });

  it("accepts zero observed dispatch delta from equal nonzero baseline and final counters", () => {
    const setup = fixture("nonzero-dispatch-baseline");
    const counters = { model: 7, scanner: 5, application: 3 };
    const result = admitScaP01Candidate({
      store: setup.store,
      request: setup.request,
      options: { dispatchProbe: { snapshot: () => ({ ...counters }) } },
    });
    const evidence = validateScaP01AdmissionEvidenceV1(
      parsed(setup.store, result.admission_evidence_ref)
    );
    expect(evidence.dispatch_delta).toEqual({ model: 0, scanner: 0, application: 0 });
  });

  it("cancels before any artifact read or write with a typed code", () => {
    const setup = fixture("cancel-before-work");
    const instrumented = instrumentedStore(setup.store);
    const controller = new AbortController();
    controller.abort();
    const error = admissionError({
      store: instrumented.store,
      request: setup.request,
      options: { signal: controller.signal },
    });
    expect(error.code).toBe("cancelled");
    expect(instrumented.counts).toEqual({ reads: 0, persists: 0 });
    expectNoCandidateWrites(setup.store);
  });

  it.each(PERSISTENCE_BOUNDARY_ORDINALS)(
    "cancels at persistence boundary %i without an admitted marker and replays exactly",
    (ordinal) => {
      const setup = fixture(`cancel-boundary-${ordinal}`);
      const controller = new AbortController();
      const error = admissionError({
        store: setup.store,
        request: setup.request,
        options: {
          signal: controller.signal,
          onBoundary: (event) => {
            if (event.stage === "before_persist" && event.ordinal === ordinal) controller.abort();
          },
        },
      });
      expect(error.code, `boundary ${ordinal}`).toBe("cancelled");
      expect(
        campaignCandidateRef(setup.store, "sca-p01-candidate-campaign-manifest"),
        `boundary ${ordinal}`
      ).toBeNull();
      const replay = admitCandidate({ store: setup.store, request: setup.request });
      expect(replay.campaign_manifest_ref).toEqual(
        campaignCandidateRef(setup.store, "sca-p01-candidate-campaign-manifest")
      );
    }
  );

  it.each(PERSISTENCE_BOUNDARY_ORDINALS)(
    "recovers exactly from interruption at persist boundary %i",
    (failAt) => {
      const setup = fixture(`crash-boundary-${failAt}`);
      const interrupted = instrumentedStore(setup.store, failAt);
      const error = admissionError({ store: interrupted.store, request: setup.request });
      expect(error.code, `persist ${failAt}`).toBe("persistence_failed");
      expect(
        campaignCandidateRef(setup.store, "sca-p01-candidate-campaign-manifest"),
        `persist ${failAt}`
      ).toBeNull();
      const replay = admitCandidate({ store: setup.store, request: setup.request });
      expect(
        validateScaCampaignManifestV2(parsed(setup.store, replay.campaign_manifest_ref))
          .campaign_status
      ).toBe("admitted");
      expect(admitCandidate({ store: setup.store, request: setup.request })).toEqual(replay);
    }
  );

  it("preflights a final-marker conflict before writing earlier candidate artifacts", () => {
    const setup = fixture("manifest-conflict");
    const conflict = persistJson(setup.store, {
      runId: RUN_ID,
      phase: CANDIDATE_PHASE,
      kind: "sca-p01-candidate-campaign-manifest",
      operationId: "sca-p01-candidate-campaign-manifest",
      schemaId: SCA_CAMPAIGN_MANIFEST_V2_SCHEMA,
      schemaVersion: 2,
      producer: CANDIDATE_PRODUCER,
      value: { conflict: true },
    });
    expect(admissionError({ store: setup.store, request: setup.request }).code).toBe(
      "artifact_conflict"
    );
    for (const operationId of CANDIDATE_OPERATIONS.slice(0, -1)) {
      expect(campaignCandidateRef(setup.store, operationId)).toBeNull();
    }
    expect(campaignCandidateRef(setup.store, CANDIDATE_OPERATIONS.at(-1) ?? "")).toEqual(conflict);
  });

  it("detects instrumented dispatch and never persists candidate output", () => {
    const setup = fixture("dispatch-detected");
    const counts = { model: 0, scanner: 0, application: 0 };
    const error = admissionError({
      store: setup.store,
      request: setup.request,
      options: {
        dispatchProbe: { snapshot: () => ({ ...counts }) },
        onBoundary: (event) => {
          if (event.stage === "before_artifact_read" && event.label === "analysis profile") {
            counts.model += 1;
          }
        },
      },
    });
    expect(error.code).toBe("dispatch_detected");
    expect(counts).toEqual({ model: 1, scanner: 0, application: 0 });
    expectNoCandidateWrites(setup.store);
  });
});

describe("context binding, planning, and inactive containment", () => {
  it("context-aware validation rejects a gate or final marker bound to another exact ref", () => {
    const setup = fixture("context-binding");
    const result = admitCandidate({ store: setup.store, request: setup.request });
    const ledger = validateScaObligationLedgerV2(parsed(setup.store, result.obligation_ledger_ref));
    const core = validateScaCampaignManifestCoreV1(parsed(setup.store, result.manifest_core_ref));
    const evidence = validateScaP01AdmissionEvidenceV1(
      parsed(setup.store, result.admission_evidence_ref)
    );
    const gate = validateScaPhaseGateRecordV2(parsed(setup.store, result.p01_gate_ref));
    const manifest = validateScaCampaignManifestV2(
      parsed(setup.store, result.campaign_manifest_ref)
    );
    expect(() =>
      validateScaP01AdmissionContextV1({
        request: setup.request,
        request_ref: result.request_ref,
        ledger,
        ledger_ref: result.obligation_ledger_ref,
        core,
        core_ref: result.manifest_core_ref,
        frozen_material_refs: core.frozen_refs,
        qualification: setup.qualification,
        qualification_ref: setup.request.p01_qualification_ref,
        admission_evidence: evidence,
        admission_evidence_ref: result.admission_evidence_ref,
        gate: { ...gate, request_ref: setup.request.source.snapshot_ref },
        gate_ref: result.p01_gate_ref,
        manifest,
      })
    ).toThrow("gate does not bind");
  });

  it("previews the exact ref persist returns without mutating the store", () => {
    const store = artifactStore("preview-helper");
    const input: PersistArtifactInput = {
      metadata: artifactMetadata({
        runId: "preview-run",
        kind: "preview-artifact",
        operationId: "preview-operation",
        schemaId: "penny.preview-artifact.v1",
        producer: "host:preview-test",
      }),
      content: canonicalJson({ schema_id: "penny.preview-artifact.v1", schema_version: 1 }),
    };
    const preview = previewArtifactRef(input);
    expect(store.refById(preview.artifact_id)).toBeUndefined();
    expect(store.persist(input)).toEqual(preview);
  });

  it("uses candidate-unique material schema IDs outside the active SCA schema surface", () => {
    const candidateMaterialSchemaIds = [
      SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
      SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
      SCA_P01_RULE_BUNDLE_V1_SCHEMA,
      SCA_P01_SELECTED_RULE_MANIFEST_V1_SCHEMA,
      SCA_P01_TOOL_EXECUTABLE_PACKAGE_V1_SCHEMA,
      SCA_P01_TOOL_MEASUREMENT_RECEIPT_V1_SCHEMA,
      SCA_P01_IMPLEMENTATION_SOURCE_BUNDLE_V1_SCHEMA,
      SCA_P01_IMPLEMENTATION_BUILD_BUNDLE_V1_SCHEMA,
      SCA_P01_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
      SCA_P01_QUALIFICATION_LOG_CONTENT_V1_SCHEMA,
    ];
    expect(new Set(candidateMaterialSchemaIds).size).toBe(candidateMaterialSchemaIds.length);
    expect(
      candidateMaterialSchemaIds.every((schemaId) => schemaId.startsWith("penny.sca-p01-"))
    ).toBe(true);
    const activeScaContracts = readFileSync(
      path.join(REPO_ROOT, "apps/orchestration/src/skill-contracts/sca.ts"),
      "utf8"
    );
    for (const schemaId of candidateMaterialSchemaIds) {
      expect(activeScaContracts, schemaId).not.toContain(schemaId);
    }
  });

  it("keeps the candidate off the package root and active SCA registry", () => {
    const packageRoot = readFileSync(
      path.join(REPO_ROOT, "apps/orchestration/src/index.ts"),
      "utf8"
    );
    const registry = readFileSync(
      path.join(REPO_ROOT, "apps/orchestration/src/playbooks/registry.ts"),
      "utf8"
    );
    const activeSca = readFileSync(
      path.join(REPO_ROOT, "apps/orchestration/src/playbooks/sca.ts"),
      "utf8"
    );
    expect(packageRoot).not.toContain("p01-admission");
    expect(packageRoot).not.toContain("p01-contracts");
    expect(packageRoot).not.toContain(P01_CANDIDATE_PLAYBOOK_NAME);
    expect(registry).not.toContain("p01-admission");
    expect(registry).not.toContain(P01_CANDIDATE_PLAYBOOK_NAME);
    expect(activeSca).not.toContain("p01-admission");
    expect(activeSca).not.toContain(P01_CANDIDATE_PLAYBOOK_NAME);
    expect(PLAYBOOK_REGISTRY.has(P01_CANDIDATE_PLAYBOOK_NAME)).toBe(false);
  });
});

describe("SCA P03 production P01 runtime root", () => {
  it("selects exact accepted Joern refs without reissuing or relabeling them", () => {
    const setup = fixture(P02_INTEGRATION_FIXTURE_LABEL);
    const accepted = admitCandidate({ store: setup.store, request: setup.request });
    const core = validateScaCampaignManifestCoreV1(parsed(setup.store, accepted.manifest_core_ref));
    const toolchain = validateScaToolchainIdentityV1(requiredValue(setup.values, "toolchain"));
    const joern = toolchain.tools.find((tool) => tool.tool_id === "parser-joern-p03");
    const scanner = toolchain.tools.find((tool) => tool.role === "scanner");
    if (joern === undefined || scanner === undefined) throw new Error("root fixture is incomplete");
    const acceptedP01 = {
      request_ref: accepted.request_ref,
      obligation_ledger_ref: accepted.obligation_ledger_ref,
      campaign_manifest_core_ref: accepted.manifest_core_ref,
      admission_evidence_ref: accepted.admission_evidence_ref,
      p01_gate_ref: accepted.p01_gate_ref,
      campaign_manifest_ref: accepted.campaign_manifest_ref,
      frozen_refs: [...scaP02FrozenRefs(core)],
    };
    const selected = validateScaP03P01RuntimeRootV1({
      store: setup.store,
      accepted_p01: acceptedP01,
      root_tool_id: joern.tool_id,
      toolchain_ref: core.frozen_refs.toolchain_ref,
      root_executable_ref: joern.executable_ref,
      root_measurement_ref: joern.measurement_receipt_ref,
    });
    expect(selected).toMatchObject({
      root_tool_id: joern.tool_id,
      toolchain_ref: core.frozen_refs.toolchain_ref,
      root_executable_ref: joern.executable_ref,
      root_measurement_ref: joern.measurement_receipt_ref,
    });
    expect(setup.store.refById(joern.executable_ref.artifact_id)).toEqual(joern.executable_ref);
    expect(setup.store.refById(joern.measurement_receipt_ref.artifact_id)).toEqual(
      joern.measurement_receipt_ref
    );
    expect(
      validateScaP03P01RuntimeIdentityRootV1({
        store: setup.store,
        accepted_p01: acceptedP01,
        runtime: {
          root_tool_id: joern.tool_id,
          toolchain_ref: core.frozen_refs.toolchain_ref,
          root_executable_ref: joern.executable_ref,
          root_measurement_ref: joern.measurement_receipt_ref,
          joern_version: joern.version,
        },
      }).root_tool_id
    ).toBe(joern.tool_id);
    expect(() =>
      validateScaP03P01RuntimeIdentityRootV1({
        store: setup.store,
        accepted_p01: acceptedP01,
        runtime: {
          root_tool_id: joern.tool_id,
          toolchain_ref: core.frozen_refs.toolchain_ref,
          root_executable_ref: joern.executable_ref,
          root_measurement_ref: joern.measurement_receipt_ref,
          joern_version: "substituted-version",
        },
      })
    ).toThrow(/version differs/u);
    const invalidVersionRun = "p03-production-invalid-version";
    expect(() => {
      Reflect.apply(freezeScaP03ProductionV1, undefined, [
        setup.store,
        {
          run_id: invalidVersionRun,
          accepted_p01: acceptedP01,
          root_tool_id: joern.tool_id,
          toolchain_ref: core.frozen_refs.toolchain_ref,
          root_executable_ref: joern.executable_ref,
          root_measurement_ref: joern.measurement_receipt_ref,
          measured: { joern_version: "substituted-version" },
        },
      ]);
    }).toThrow(/version differs/u);
    expect(
      setup.store.lastVersion(
        invalidVersionRun,
        "SCA-P03",
        null,
        "sca-p03-implementation-source",
        "freeze-implementation-source-0"
      )
    ).toBe(0);
    const invalidProductionRun = "p03-production-invalid-root";
    expect(
      setup.store.lastVersion(
        invalidProductionRun,
        "SCA-P03",
        null,
        "sca-p03-implementation-source",
        "freeze-implementation-source-0"
      )
    ).toBe(0);
    expect(() => {
      Reflect.apply(freezeScaP03ProductionV1, undefined, [
        setup.store,
        {
          run_id: invalidProductionRun,
          accepted_p01: acceptedP01,
          root_tool_id: joern.tool_id,
          toolchain_ref: core.frozen_refs.toolchain_ref,
          root_executable_ref: scanner.executable_ref,
          root_measurement_ref: joern.measurement_receipt_ref,
          measured: { joern_version: joern.version },
        },
      ]);
    }).toThrow(/one exact complete parser entry/u);
    expect(
      setup.store.lastVersion(
        invalidProductionRun,
        "SCA-P03",
        null,
        "sca-p03-implementation-source",
        "freeze-implementation-source-0"
      )
    ).toBe(0);
    for (const [label, roots] of [
      [
        "toolchain",
        {
          toolchain_ref: core.frozen_refs.source_snapshot_ref,
          root_executable_ref: joern.executable_ref,
          root_measurement_ref: joern.measurement_receipt_ref,
        },
      ],
      [
        "measurement",
        {
          toolchain_ref: core.frozen_refs.toolchain_ref,
          root_executable_ref: joern.executable_ref,
          root_measurement_ref: scanner.measurement_receipt_ref,
        },
      ],
    ] as const) {
      const runId = `p03-production-invalid-${label}`;
      expect(() => {
        Reflect.apply(freezeScaP03ProductionV1, undefined, [
          setup.store,
          {
            run_id: runId,
            accepted_p01: acceptedP01,
            root_tool_id: joern.tool_id,
            ...roots,
            measured: { joern_version: joern.version },
          },
        ]);
      }).toThrow();
      expect(
        setup.store.lastVersion(
          runId,
          "SCA-P03",
          null,
          "sca-p03-implementation-source",
          "freeze-implementation-source-0"
        )
      ).toBe(0);
    }
    const invalidClosureRun = "p03-production-invalid-p01-closure";
    expect(() => {
      Reflect.apply(freezeScaP03ProductionV1, undefined, [
        setup.store,
        {
          run_id: invalidClosureRun,
          accepted_p01: { ...acceptedP01, frozen_refs: acceptedP01.frozen_refs.slice(1) },
          root_tool_id: joern.tool_id,
          toolchain_ref: core.frozen_refs.toolchain_ref,
          root_executable_ref: joern.executable_ref,
          root_measurement_ref: joern.measurement_receipt_ref,
          measured: { joern_version: joern.version },
        },
      ]);
    }).toThrow(/exact frozen cohort/u);
    expect(
      setup.store.lastVersion(
        invalidClosureRun,
        "SCA-P03",
        null,
        "sca-p03-implementation-source",
        "freeze-implementation-source-0"
      )
    ).toBe(0);
    expect(() =>
      validateScaP03P01RuntimeRootV1({
        store: setup.store,
        accepted_p01: acceptedP01,
        root_tool_id: joern.tool_id,
        toolchain_ref: core.frozen_refs.toolchain_ref,
        root_executable_ref: scanner.executable_ref,
        root_measurement_ref: joern.measurement_receipt_ref,
      })
    ).toThrow(/one exact complete parser entry/u);
    expect(() =>
      validateScaP03P01RuntimeRootV1({
        store: setup.store,
        accepted_p01: acceptedP01,
        root_tool_id: scanner.tool_id,
        toolchain_ref: core.frozen_refs.toolchain_ref,
        root_executable_ref: scanner.executable_ref,
        root_measurement_ref: scanner.measurement_receipt_ref,
      })
    ).toThrow(/one exact complete parser entry/u);
  });

  it("freezes a separate production closure around exact accepted Joern lineage", async () => {
    const setup = fixture(P02_INTEGRATION_FIXTURE_LABEL);
    const accepted = admitCandidate({ store: setup.store, request: setup.request });
    const core = validateScaCampaignManifestCoreV1(parsed(setup.store, accepted.manifest_core_ref));
    const toolchain = validateScaToolchainIdentityV1(requiredValue(setup.values, "toolchain"));
    const joern = toolchain.tools.find((tool) => tool.tool_id === "parser-joern-p03");
    if (joern === undefined) throw new Error("Joern root fixture is absent");
    const acceptedP01 = {
      request_ref: accepted.request_ref,
      obligation_ledger_ref: accepted.obligation_ledger_ref,
      campaign_manifest_core_ref: accepted.manifest_core_ref,
      admission_evidence_ref: accepted.admission_evidence_ref,
      p01_gate_ref: accepted.p01_gate_ref,
      campaign_manifest_ref: accepted.campaign_manifest_ref,
      frozen_refs: [...scaP02FrozenRefs(core)],
    };
    const runId = "p03-production-freeze";
    const root = temporaryRoot("p03-production-freeze");
    const oracle = syntheticSourceOracle();
    const oracleBytes = Buffer.from(canonicalJson(oracle));
    const languages = ["php", "javascript", "typescript"] as const;
    const fixtures = languages.map((language) => {
      const definition = oracle.fixtures.find((entry) => entry.language === language);
      if (definition === undefined) throw new Error(`missing ${language} fixture`);
      return {
        language,
        bytes: readFileSync(
          new URL(`../../sca-service/tests/fixtures/p03-v2/${definition.file}`, import.meta.url)
        ),
      };
    });
    const implementation = (["source", "build", "normalizer", "query_runner"] as const).map(
      (role) => {
        const bytes = Buffer.from(`production-${role}`);
        return { role, path: path.join(root, `${role}.txt`), bytes, current_bytes: bytes };
      }
    );
    const planned = planScaP03ImplementationV3(
      runId,
      "p03-production-implementation",
      "revision-1",
      implementation
    );
    const fidelityRequirements = [
      {
        requirement_id: "php-language",
        dimension: "language",
        subject: "php",
        partition: "php",
        materiality: "material",
        complement_evidence_ref: null,
      },
      {
        requirement_id: "php-framework",
        dimension: "framework",
        subject: "fixture",
        partition: "php",
        materiality: "material",
        complement_evidence_ref: null,
      },
      {
        requirement_id: "php-edge_class",
        dimension: "edge_class",
        subject: "call",
        partition: "php",
        materiality: "material",
        complement_evidence_ref: null,
      },
      {
        requirement_id: "php-surface",
        dimension: "surface",
        subject: "fixture",
        partition: "php",
        materiality: "material",
        complement_evidence_ref: null,
      },
      {
        requirement_id: "javascript-language",
        dimension: "language",
        subject: "javascript",
        partition: "javascript_typescript",
        materiality: "material",
        complement_evidence_ref: null,
      },
      {
        requirement_id: "javascript-framework",
        dimension: "framework",
        subject: "fixture",
        partition: "javascript_typescript",
        materiality: "material",
        complement_evidence_ref: null,
      },
      {
        requirement_id: "javascript-edge_class",
        dimension: "edge_class",
        subject: "call",
        partition: "javascript_typescript",
        materiality: "material",
        complement_evidence_ref: null,
      },
      {
        requirement_id: "javascript-surface",
        dimension: "surface",
        subject: "fixture",
        partition: "javascript_typescript",
        materiality: "material",
        complement_evidence_ref: null,
      },
      {
        requirement_id: "typescript-language",
        dimension: "language",
        subject: "typescript",
        partition: "javascript_typescript",
        materiality: "material",
        complement_evidence_ref: null,
      },
    ] as const;
    const profile = validateScaP03QualificationProfileV2(
      withScaP03Digest(
        {
          schema_id: "penny.sca-p03-qualification-profile.v2",
          schema_version: 2,
          profile_id: "p03-production-profile",
          phase_id: "SCA-P03",
          required_languages: languages,
          required_query_ids: SCA_P03_QUERY_IDS,
          fidelity_requirements: fidelityRequirements,
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
    const stagingParent = path.join(root, "staging");
    mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
    const policy = {
      schema_id: "penny.sca-p03-runtime-policy.v1" as const,
      schema_version: 1 as const,
      policy_id: "p03-production-policy",
      staging_parent_sha256: sha256(stagingParent),
      source_posture: "read_only" as const,
      network_access: "denied" as const,
      package_acquisition: "forbidden" as const,
      target_execution: "forbidden" as const,
      shell_execution: "forbidden" as const,
      joern_server: "forbidden" as const,
      process_timeout_ms: 3000,
      max_graph_bytes: 1_048_576,
      max_query_output_bytes: 1_048_576,
      max_query_items: 100,
      max_page_items: 10,
      max_pages_per_query: 10,
      max_ast_depth: 8,
      max_ast_nodes: 32,
      max_num_def: 100,
    };
    const dockerBytes = Buffer.from("production-docker-executable");
    const imageId = `sha256:${"b".repeat(64)}`;
    const deploymentIdentity = sha256(
      canonicalJson({
        docker_executable_sha256: sha256(dockerBytes),
        docker_client_version: "1.0.0",
        docker_server_version: "1.0.0",
        image_id: imageId,
        joern_version: joern.version,
      })
    );
    const config = {
      docker_executable: path.join(root, "docker"),
      image_ref: `registry.example/joern@${imageId}`,
      expected_joern_version: joern.version,
      expected_docker_executable_sha256: sha256(dockerBytes),
      expected_docker_client_version: "1.0.0",
      expected_docker_server_version: "1.0.0",
      runtime_id: "p03-production-runtime",
      isolation_id: "p03-production-isolation",
      isolation_profile_sha256: profile.profile_sha256,
      implementation_identity_sha256: planned.identity.implementation_sha256,
      deployment_identity_sha256: deploymentIdentity,
      staging_parent: stagingParent,
      memory_bytes: 512 * 1024 * 1024,
      cpus: 1,
      pids: 128,
      max_workspace_bytes: 4 * 1024 * 1024,
      max_num_def: policy.max_num_def,
      max_command_output_bytes: 100_000,
      timeout_ms: policy.process_timeout_ms,
    };
    const expectedCases = projectSourceOracleCases(oracle);
    const anticipatedOracleRef = previewArtifactRef({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: "SCA-P03",
        branch_id: null,
        kind: "sca-p03-source-oracle",
        operation_id: "freeze-oracle",
        version: 1,
        producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
        media_type: "application/json",
        content_schema: { schema_id: SCA_P03_SOURCE_ORACLE_SCHEMA, schema_version: 2 },
        parent_ref: null,
        upstream_refs: [],
      },
      content: canonicalJson(oracle),
    });
    const reviewDraft = {
      schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
      schema_version: 1 as const,
      producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
      oracle_sha256: oracle.oracle_sha256,
      parser_identity_sha256: oracle.parser.identity_sha256,
      fixture_content_sha256: fixtures.map((entry) => sha256(entry.bytes)),
      expected_cases: expectedCases,
    };
    const review = {
      ...reviewDraft,
      review_sha256: sha256(canonicalJson(reviewDraft)),
    };
    const reviewBytes = Buffer.from(canonicalJson(review));
    const reviewRef = setup.store.persist({
      metadata: {
        schema_version: 2,
        run_id: runId,
        phase: "SCA-P03",
        branch_id: null,
        kind: "sca-p03-source-oracle-review",
        operation_id: "production-oracle-review",
        version: 1,
        producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
        media_type: "application/json",
        content_schema: { schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA, schema_version: 1 },
        parent_ref: null,
        upstream_refs: [anticipatedOracleRef],
      },
      content: reviewBytes,
    });
    const result = freezeScaP03ProductionV1(setup.store, {
      run_id: runId,
      corpus_id: "p03-production-corpus",
      query_set_id: "p03-production-query-set",
      release_id: "p03-production-release",
      implementation_id: "p03-production-implementation",
      implementation_revision: "revision-1",
      root_tool_id: joern.tool_id,
      policy_id: policy.policy_id,
      profile,
      policy,
      config,
      measured: {
        docker_executable_bytes: dockerBytes,
        docker_client_version: config.expected_docker_client_version,
        docker_server_version: config.expected_docker_server_version,
        image_ref: config.image_ref,
        image_id: imageId,
        joern_version: joern.version,
        php_frontend_version: "php-frontend-1",
        javascript_frontend_version: "javascript-frontend-1",
        jvm_version: "jvm-1",
        php_runtime_version: "php-runtime-1",
        helper_version: "helper-1",
      },
      oracle_bytes: oracleBytes,
      review_ref: reviewRef,
      review_bytes: reviewBytes,
      validated_at: CREATED_AT,
      fixtures,
      implementation,
      accepted_p01: acceptedP01,
      toolchain_ref: core.frozen_refs.toolchain_ref,
      root_executable_ref: joern.executable_ref,
      root_measurement_ref: joern.measurement_receipt_ref,
    });
    expect(result.p01_runtime_root).toMatchObject({
      root_tool_id: joern.tool_id,
      root_executable_ref: joern.executable_ref,
      root_measurement_ref: joern.measurement_receipt_ref,
    });
    const rootIds = new Set([
      core.frozen_refs.toolchain_ref.artifact_id,
      joern.executable_ref.artifact_id,
      joern.measurement_receipt_ref.artifact_id,
    ]);
    expect(result.bindings.runtime_package_refs.some((ref) => rootIds.has(ref.artifact_id))).toBe(
      false
    );
    const runtime = validateScaP03JoernRuntimeIdentityV1(
      parsed(setup.store, result.bindings.runtime_identity_ref)
    );
    expect(runtime).toMatchObject({
      toolchain_ref: core.frozen_refs.toolchain_ref,
      root_executable_ref: joern.executable_ref,
      root_measurement_ref: joern.measurement_receipt_ref,
      runtime_package_refs: result.bindings.runtime_package_refs,
      joern_version: joern.version,
    });
    const expectedUpstream = [
      ...result.bindings.runtime_package_refs,
      core.frozen_refs.toolchain_ref,
      joern.executable_ref,
      joern.measurement_receipt_ref,
    ].sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
    expect(setup.store.metadata(result.bindings.runtime_identity_ref).upstream_refs).toEqual(
      expectedUpstream
    );
    expect(
      readP03ProductionInputs(setup.store, result.production_bindings).p01_runtime_root
        .root_measurement_ref
    ).toEqual(joern.measurement_receipt_ref);
    expect(scaP03ProductionUseAuthorityFromBindingsV1(result.production_bindings)).toMatchObject({
      run_id: runId,
      accepted_p01: acceptedP01,
      runtime_identity_ref: result.bindings.runtime_identity_ref,
      runtime_package_refs: result.bindings.runtime_package_refs,
    });
    expect(() =>
      readP03ProductionInputs(setup.store, {
        ...result.production_bindings,
        roots: { ...result.production_bindings.roots, root_tool_id: "substituted" },
      })
    ).toThrow("p03_production_bindings_invalid");

    const storeRoot = artifactRoots.get(setup.store);
    const projectId = integrationProjectIds.get(setup.store);
    if (storeRoot === undefined || projectId === undefined)
      throw new Error("artifact store identity is unavailable");
    const cliRunId = "p03-production-cli-freeze";
    const cliDir = path.join(root, "cli");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    const cliImplementation = implementation.map((entry) => {
      const file = path.join(cliDir, path.basename(entry.path));
      writeFileSync(file, entry.bytes, { mode: 0o600 });
      return { role: entry.role, path: file, bytes: entry.bytes, current_bytes: entry.bytes };
    });
    const cliPlan = planScaP03ImplementationV3(
      cliRunId,
      "p03-production-cli-implementation",
      "revision-1",
      cliImplementation
    );
    const cliDocker = path.join(cliDir, "docker");
    writeFileSync(cliDocker, dockerBytes, { mode: 0o700 });
    chmodSync(cliDocker, 0o700);
    const cliPolicy = { ...policy, staging_parent_sha256: sha256(cliDir) };
    const cliConfig = {
      ...config,
      docker_executable: cliDocker,
      staging_parent: cliDir,
      implementation_identity_sha256: cliPlan.identity.implementation_sha256,
    };
    const oraclePath = path.join(cliDir, "oracle.json");
    const reviewPath = path.join(cliDir, "review.json");
    const profilePath = path.join(cliDir, "profile.json");
    const policyPath = path.join(cliDir, "policy.json");
    writeFileSync(oraclePath, oracleBytes, { mode: 0o600 });
    writeFileSync(reviewPath, reviewBytes, { mode: 0o600 });
    writeFileSync(profilePath, canonicalJson(profile), { mode: 0o600 });
    writeFileSync(policyPath, canonicalJson(cliPolicy), { mode: 0o600 });
    const fixtureFiles = fixtures.map((entry) => {
      const file = path.join(cliDir, `${entry.language}.fixture`);
      writeFileSync(file, entry.bytes, { mode: 0o600 });
      return { language: entry.language, path: file };
    });
    const cliManifest = {
      schema_id: "penny.sca-p03-cli-production-freeze-manifest.v1",
      schema_version: 1,
      store_root: storeRoot,
      project_id: projectId,
      run_id: cliRunId,
      working_dir: cliDir,
      create_store: false,
      corpus_id: "p03-production-cli-corpus",
      query_set_id: "p03-production-cli-query-set",
      release_id: "p03-production-cli-release",
      implementation_id: "p03-production-cli-implementation",
      implementation_revision: "revision-1",
      root_tool_id: joern.tool_id,
      policy_id: cliPolicy.policy_id,
      oracle_path: oraclePath,
      source_oracle_review_path: reviewPath,
      profile_path: profilePath,
      policy_path: policyPath,
      fixtures: fixtureFiles,
      implementation: cliImplementation.map((entry) => ({ role: entry.role, path: entry.path })),
      config: cliConfig,
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
        jvm: ["java", "-version"],
        php_runtime: ["php", "--version"],
        helper: ["helper", "--version"],
      },
      accepted_p01: acceptedP01,
      toolchain_ref: core.frozen_refs.toolchain_ref,
      root_executable_ref: joern.executable_ref,
      root_measurement_ref: joern.measurement_receipt_ref,
    };
    const cliManifestPath = path.join(cliDir, "production-freeze-manifest.json");
    writeFileSync(cliManifestPath, canonicalJson(cliManifest), { mode: 0o600 });
    let measuredContainer = "";
    const fakeDocker: DockerRunnerV1 = async ({ argv }) => {
      if (argv[0] === "version")
        return JSON.stringify({
          Client: { Version: cliConfig.expected_docker_client_version },
          Server: { Version: cliConfig.expected_docker_server_version },
        });
      if (argv[0] === "image")
        return JSON.stringify({ Id: imageId, RepoDigests: [cliConfig.image_ref] });
      if (argv[0] === "container" && argv[1] === "create") {
        measuredContainer = argv[argv.indexOf("--name") + 1] ?? "";
        return "c".repeat(64);
      }
      if (argv[0] === "container" && argv[1] === "inspect")
        return JSON.stringify({
          Id: "c".repeat(64),
          Image: imageId,
          Name: `/${measuredContainer}`,
          HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, Init: true },
          Config: { User: `${String(process.getuid?.())}:${String(process.getgid?.())}` },
          Mounts: [],
        });
      if (argv[0] === "container" && argv[1] === "exec") {
        const executable = argv[3];
        if (executable === "find") {
          const pattern = argv[argv.indexOf("-name") + 1];
          if (pattern === "io.joern.joern-cli-*.jar")
            return `io.joern.joern-cli-${joern.version}.jar\n`;
          if (pattern === "io.joern.php2cpg-*.jar")
            return `io.joern.php2cpg-${joern.version}-launcher.jar\nio.joern.php2cpg-${joern.version}.jar\n`;
          if (pattern === "io.joern.jssrc2cpg-*.jar")
            return `io.joern.jssrc2cpg-${joern.version}.jar\nio.joern.jssrc2cpg-${joern.version}-launcher.jar\n`;
        }
        if (executable === "which") return "/opt/joern/joern-cli/joern\n";
        if (executable === "joern") return "Usage: joern [options] [<cpg.bin>]\n";
        return executable === "helper" ? "helper 1.0" : "1.0";
      }
      return "";
    };
    const offlineProbe: NonNullable<ScaP03BootstrapCliDepsV1["createProbe"]> = ({
      config: probeConfig,
      store,
      registry,
      runtime_package_refs,
      build_files,
      current_selection_path,
    }) => ({
      now: () => new Date(),
      containerCensus: async () => [],
      inspectContainer: async () => Buffer.from("{}"),
      readBuildFile: async (ref) => {
        const file = build_files[ref.artifact_id];
        if (file === undefined) throw new Error("build mapping missing");
        return readFileSync(file);
      },
      workspacePaths: async (attemptId) => registry.paths(attemptId),
      workspaceIdentityDigest: async (attemptId) => registry.digest(attemptId),
      currentSelection: async () => readFileSync(current_selection_path),
      measureIdentity: async () => ({
        runtime_id: probeConfig.runtime_id,
        isolation_id: probeConfig.isolation_id,
        implementation_sha256: probeConfig.implementation_identity_sha256,
        runtime_package_sha256: sha256(
          canonicalJson(
            runtime_package_refs
              .map((ref) => ({ ref, current_sha256: sha256(store.read(ref)) }))
              .sort((left, right) => left.ref.artifact_id.localeCompare(right.ref.artifact_id))
          )
        ),
        deployment_sha256: probeConfig.deployment_identity_sha256,
        docker_executable_sha256: probeConfig.expected_docker_executable_sha256,
        docker_client_version: probeConfig.expected_docker_client_version,
        docker_server_version: probeConfig.expected_docker_server_version,
        image_id: imageId,
        joern_version: probeConfig.expected_joern_version,
      }),
    });
    const candidateName = "penny-p03-00000000-0000-4000-8000-000000000003";
    const candidateId = "d".repeat(64);
    await runScaP03BootstrapCliV1(["freeze-production-record", "--manifest", cliManifestPath], {
      dockerRunner: fakeDocker,
      createProbe: offlineProbe,
      deterministicTestCandidate: async (sink) => ({
        runtime_id: cliConfig.runtime_id,
        isolation_id: cliConfig.isolation_id,
        runtime_tree_sha256: imageId.slice(7),
        isolation_profile_sha256: cliConfig.isolation_profile_sha256,
        implementation_identity_sha256: cliConfig.implementation_identity_sha256,
        deployment_identity_sha256: cliConfig.deployment_identity_sha256,
        measured_joern_version: cliConfig.expected_joern_version,
        max_num_def: cliConfig.max_num_def,
        qualify: async ({
          fixtures: candidateFixtures,
          expected_cases,
          query_release,
          source_oracle_validation_ref,
        }) => {
          const workspace = path.join(cliDir, "candidate-workspace");
          mkdirSync(workspace, { mode: 0o700 });
          const stat = lstatSync(workspace);
          sink.startWorkspace(canonicalJson({ path: workspace, dev: stat.dev, ino: stat.ino }));
          sink.create(candidateName, ["container", "create"]);
          sink.id(candidateName, candidateId);
          sink.inspect(
            candidateName,
            '{"inspect":true}',
            canonicalJson({
              image: imageId,
              id: candidateId,
              name: `/${candidateName}`,
              network: "none",
              pid_mode: "",
              ipc_mode: "",
              uts_mode: "",
              readonly_root: true,
              privileged: false,
              init: true,
              cap_drop: ["ALL"],
              security_opt: ["no-new-privileges"],
              pids: cliConfig.pids,
              memory: cliConfig.memory_bytes,
              memory_swap: cliConfig.memory_bytes,
              nano_cpus: Math.round(cliConfig.cpus * 1_000_000_000),
              log: "none",
              tmpfs: {
                "/tmp": "rw,exec,nosuid,nodev,size=67108864",
                "/work": `rw,exec,nosuid,nodev,size=${String(cliConfig.max_workspace_bytes)},mode=0700,uid=${String(process.getuid?.())},gid=${String(process.getgid?.())}`,
              },
              user: `${String(process.getuid?.())}:${String(process.getgid?.())}`,
              workdir: "/tmp",
              env: ["HOME=/tmp"],
              entrypoint: ["sleep"],
              command: ["infinity"],
              running: true,
              mounts: [
                {
                  destination: "/scripts",
                  type: "bind",
                  readonly: true,
                  source_sha256: sha256("scripts"),
                },
              ],
            })
          );
          sink.startContainer(candidateName);
          sink.command(candidateName, ["container", "exec"], true);
          sink.response(candidateName, "ok");
          sink.readback(candidateName, Buffer.from("graph"));
          sink.removal(candidateName, true);
          rmSync(workspace, { recursive: true });
          sink.finishWorkspace(true);
          return {
            executed_query_release_sha256: query_release.release_sha256,
            cases: expected_cases.map((expected) => {
              const fixture = candidateFixtures.find(
                (entry) => entry.language === expected.language
              );
              if (fixture === undefined) throw new Error("candidate fixture missing");
              return observedFromSourceCase(
                expected,
                fixture,
                query_release.release_sha256,
                source_oracle_validation_ref
              );
            }),
          };
        },
      }),
      emit: () => undefined,
    });
    const cliHandoffPath = path.join(cliDir, "production-freeze-handoff.json");
    const cliHandoffBytes = readFileSync(cliHandoffPath);
    const cliHandoff = parseScaP03CliCanonical(
      ScaP03CliProductionFreezeHandoffSchema,
      cliHandoffBytes
    );
    expect(cliHandoff.status).toBe("ready_for_review");
    if (
      cliHandoff.record_ref === null ||
      cliHandoff.cleanup_ref === null ||
      cliHandoff.isolation_ref === null
    )
      throw new Error("production CLI handoff is incomplete");
    expect(cliHandoff.production_bindings.roots).toMatchObject({
      accepted_p01: acceptedP01,
      toolchain_ref: core.frozen_refs.toolchain_ref,
      root_executable_ref: joern.executable_ref,
      root_measurement_ref: joern.measurement_receipt_ref,
    });
    expect(
      cliHandoff.bindings.runtime_package_refs.some((ref) => rootIds.has(ref.artifact_id))
    ).toBe(false);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signedReview = {
      external_review_id: "production-cli-review",
      record_ref: cliHandoff.record_ref,
      attempt_ref: cliHandoff.attempt_ref,
      cleanup_ref: cliHandoff.cleanup_ref,
      isolation_ref: cliHandoff.isolation_ref,
      reviewer_id: "production-reviewer",
      reviewer_authority_id: "production-review-authority",
      decision: "PASS",
      reviewed_at: new Date(Date.now() + 2000).toISOString(),
    };
    const externalReviewPath = path.join(cliDir, "external-review.json");
    writeFileSync(
      externalReviewPath,
      canonicalJson({
        ...signedReview,
        signature: sign(null, Buffer.from(canonicalJson(signedReview)), privateKey).toString(
          "base64"
        ),
      }),
      { mode: 0o600 }
    );
    const reviewerKeyPath = path.join(cliDir, "reviewer-key.pem");
    writeFileSync(reviewerKeyPath, publicKey.export({ type: "spki", format: "pem" }), {
      mode: 0o600,
    });
    const runtimePackages = cliHandoff.bindings.runtime_package_refs.map((ref) => ({
      ref,
      path: path.join(cliDir, `package-${ref.operation_id.slice(-1)}.json`),
    }));
    const productionSealManifest = {
      schema_id: "penny.sca-p03-cli-production-seal-manifest.v1",
      schema_version: 1,
      store_root: storeRoot,
      project_id: projectId,
      run_id: cliRunId,
      working_dir: cliDir,
      config: cliConfig,
      freeze_handoff_path: cliHandoffPath,
      freeze_handoff_sha256: sha256(cliHandoffBytes),
      implementation: cliPlan.mappings.map((entry) => ({
        role: entry.role,
        path: entry.path,
        ref: entry.ref,
      })),
      runtime_packages: runtimePackages,
      external_review_path: externalReviewPath,
      reviewer_public_key_path: reviewerKeyPath,
      reviewer_public_key_sha256: sha256(publicKey.export({ type: "spki", format: "der" })),
      reviewer_id: signedReview.reviewer_id,
      reviewer_authority_id: signedReview.reviewer_authority_id,
      evaluator_id: "production-evaluator",
      attester_id: "production-attester",
      attestation_id: "production-cli-attestation",
    };
    const productionSealPath = path.join(cliDir, "production-seal-manifest.json");
    writeFileSync(productionSealPath, canonicalJson(productionSealManifest), { mode: 0o600 });
    await runScaP03BootstrapCliV1(["seal-production", "--manifest", productionSealPath], {
      createProbe: offlineProbe,
      emit: () => undefined,
    });
    const productionSealedPath = path.join(cliDir, "production-sealed-handoff.json");
    const productionSealedBytes = readFileSync(productionSealedPath);
    const productionSealed = parseScaP03CliCanonical(
      ScaP03CliProductionSealedHandoffSchema,
      productionSealedBytes
    );
    expect(productionSealed.production_binding_sha256).toBe(
      cliHandoff.production_bindings.binding_sha256
    );
    expect(productionSealed.production_record_ref.kind).toBe(
      "sca-p03-production-qualification-record"
    );
    const productionVerifyPath = path.join(cliDir, "production-verify-manifest.json");
    writeFileSync(
      productionVerifyPath,
      canonicalJson({
        ...productionSealManifest,
        schema_id: "penny.sca-p03-cli-production-verify-manifest.v1",
        sealed_handoff_path: productionSealedPath,
        sealed_handoff_sha256: sha256(productionSealedBytes),
      }),
      { mode: 0o600 }
    );
    await runScaP03BootstrapCliV1(["verify-production", "--manifest", productionVerifyPath], {
      createProbe: offlineProbe,
      emit: () => undefined,
    });
  });

  it("fails when accepted P01 lineage has no Joern entry", () => {
    const setup = fixture("p03-root-no-joern");
    const accepted = admitCandidate({ store: setup.store, request: setup.request });
    const core = validateScaCampaignManifestCoreV1(parsed(setup.store, accepted.manifest_core_ref));
    const toolchain = validateScaToolchainIdentityV1(requiredValue(setup.values, "toolchain"));
    const parser = toolchain.tools.find((tool) => tool.role === "parser");
    if (parser === undefined) throw new Error("parser fixture is absent");
    expect(() =>
      validateScaP03P01RuntimeRootV1({
        store: setup.store,
        accepted_p01: {
          request_ref: accepted.request_ref,
          obligation_ledger_ref: accepted.obligation_ledger_ref,
          campaign_manifest_core_ref: accepted.manifest_core_ref,
          admission_evidence_ref: accepted.admission_evidence_ref,
          p01_gate_ref: accepted.p01_gate_ref,
          campaign_manifest_ref: accepted.campaign_manifest_ref,
          frozen_refs: [...scaP02FrozenRefs(core)],
        },
        root_tool_id: "parser-joern-p03",
        toolchain_ref: core.frozen_refs.toolchain_ref,
        root_executable_ref: parser.executable_ref,
        root_measurement_ref: parser.measurement_receipt_ref,
      })
    ).toThrow(/one exact complete parser entry/u);
  });
});

describe("SCA P02 real candidate integration", () => {
  it.each([
    {
      caseName: "deterministic scanner run with unissued OSV blocked",
      failNpmLookup: false,
      unprovenResume: false,
    },
    {
      caseName: "unproven resumed inventory remains quarantined",
      failNpmLookup: false,
      unprovenResume: true,
    },
  ])(
    "admits P01 lineage and drives six operations: $caseName",
    async ({ failNpmLookup, unprovenResume }) => {
      const scanners = p02ScannerFixtures();
      // Bind these exact per-case bytes, including the counter paths, before P01 admission.
      const setup = fixture(P02_INTEGRATION_FIXTURE_LABEL, scanners);
      const projectId = integrationProjectIds.get(setup.store);
      const hostStateRoot = integrationStateRoots.get(setup.store);
      if (projectId === undefined || hostStateRoot === undefined) {
        throw new Error("P02 integration project partition was not provisioned");
      }
      const accepted = admitCandidate({ store: setup.store, request: setup.request });
      const core = validateScaCampaignManifestCoreV1(
        parsed(setup.store, accepted.manifest_core_ref)
      );
      const toolchain = validateScaToolchainIdentityV1(requiredValue(setup.values, "toolchain"));
      const semgrepTool = toolchain.tools.find((tool) => tool.tool_id === "scanner-semgrep-p02");
      const gitleaksTool = toolchain.tools.find((tool) => tool.tool_id === "scanner-gitleaks-p02");
      if (semgrepTool === undefined || gitleaksTool === undefined) {
        throw new Error("P02 integration fixture lacks scanner tools");
      }

      const runtimeRoot = temporaryRoot("p02-real-runtime");
      const stagingParent = path.join(runtimeRoot, "staging");
      mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
      const semgrepPath = path.join(runtimeRoot, "semgrep-fixture");
      const gitleaksPath = path.join(runtimeRoot, "gitleaks-fixture");
      writeFileSync(semgrepPath, scanners.semgrep.executableContent, { mode: 0o700 });
      writeFileSync(gitleaksPath, scanners.gitleaks.executableContent, { mode: 0o700 });
      chmodSync(semgrepPath, 0o700);
      chmodSync(gitleaksPath, 0o700);
      expect(sha256(readFileSync(semgrepPath))).toBe(semgrepTool.executable_sha256);
      expect(sha256(readFileSync(gitleaksPath))).toBe(gitleaksTool.executable_sha256);

      // This host-qualified test fixture exercises the live-shaped binding contract without
      // claiming deployed AC-P02 qualification.
      const operationProfiles = {
        inventory: sha256("p02-integration-inventory"),
        semgrep_php: sha256("p02-integration-semgrep-php"),
        semgrep_js_ts: sha256("p02-integration-semgrep-js-ts"),
        gitleaks: sha256("p02-integration-gitleaks"),
        osv_composer: sha256("p02-integration-osv-composer"),
        osv_npm: sha256("p02-integration-osv-npm"),
      };
      const isolationProfileSha256 = scaP02AggregateProfileSha256(operationProfiles);
      const hostAttestationRef = persistJson(setup.store, {
        runId: RUN_ID,
        phase: "sca-p02-input",
        kind: SCA_P02_HOST_ATTESTATION_KIND,
        operationId: "p02-integration-host-attestation",
        schemaId: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
        producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
        value: {
          schema_id: SCA_P02_HOST_ATTESTATION_V1_SCHEMA,
          schema_version: 1,
          attestation_id: "p02-integration-host-attestation",
          runtime_kind: "host_qualified",
          isolation_id: "p02-integration-isolation",
          runtime_id: "p02-integration-runtime",
          implementation_identity_sha256: "8".repeat(64),
          deployment_identity_sha256: "9".repeat(64),
          profile_id: "p02-integration-live-shape",
          profile_sha256: isolationProfileSha256,
          operation_profiles: operationProfiles,
          qualification_scope: "live_qualified",
          qualified: true,
          attested_at: "2026-09-20T00:00:00.000Z",
        },
      });
      // This integration exercises the local deterministic scanner seam. It must not claim
      // live qualification without factory-issued controlled inventory/process runners.
      const isolationEvidence = {
        schema_id: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
        schema_version: 1 as const,
        producer_id: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
        evidence_kind: "simulated_test_seam" as const,
        runtime_kind: "simulated_test_runtime" as const,
        isolation_id: "p02-integration-isolation",
        runtime_id: "p02-integration-runtime",
        implementation_identity_sha256: "8".repeat(64),
        deployment_identity_sha256: "9".repeat(64),
        qualification_scope: "deterministic_test_only" as const,
        qualified: false,
        profile_id: "p02-integration-live-shape",
        profile_sha256: isolationProfileSha256,
        qualified_at: "2026-09-20T00:00:00.000Z",
      };
      const isolationRef = persistJson(setup.store, {
        runId: RUN_ID,
        phase: "sca-p02-input",
        kind: "sca-p02-isolation-evidence",
        operationId: "p02-integration-isolation-evidence",
        schemaId: SCA_P02_ISOLATION_EVIDENCE_V1_SCHEMA,
        producer: SCA_P02_ISOLATION_EVIDENCE_PRODUCER,
        value: isolationEvidence,
      });
      const runtimePolicy = {
        schema_id: SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
        schema_version: 1 as const,
        policy_id: "p02-integration-runtime-policy",
        staging_parent: stagingParent,
        isolation_evidence_ref: isolationRef,
        executables: [
          {
            tool_id: semgrepTool.tool_id,
            executable_path: semgrepPath,
            executable_sha256: semgrepTool.executable_sha256,
            version: semgrepTool.version,
          },
          {
            tool_id: gitleaksTool.tool_id,
            executable_path: gitleaksPath,
            executable_sha256: gitleaksTool.executable_sha256,
            version: gitleaksTool.version,
          },
        ],
        operation_tools: {
          semgrep_tool_id: semgrepTool.tool_id,
          gitleaks_tool_id: gitleaksTool.tool_id,
        },
        semgrep_max_output_bytes: 1_048_576,
        gitleaks_max_output_bytes: 1_048_576,
        process_timeout_ms: 10_000,
        internal_component_identities: {
          source_census_sha256: SCA_P02_SOURCE_CENSUS_IDENTITY_SHA256,
          tree_sitter_sha256: sha256(canonicalJson(inspectInstalledTreeSitterIdentitiesV2())),
        },
        tree_sitter: {
          parse_timeout_micros: 10_000_000,
          max_file_bytes: 1_048_576,
          max_total_bytes: 8_388_608,
          max_files: 100,
          max_nodes_per_file: 100_000,
          max_depth: 1_000,
          max_diagnostics_per_file: 128,
          max_symbols_per_file: 10_000,
          query_match_limit: 10_000,
        },
        gitleaks_configuration_rule_id: "gitleaks-configuration",
        osv: {
          transport_id: "p02-integration-osv-transport",
          max_batch_size: 128,
          max_concurrency: 2,
          timeout_ms: 10_000,
          max_response_bytes: 1_048_576,
          max_advisory_requests: 32,
          freshness_max_age_seconds: 3_600,
        },
      };
      const runtimePolicyRef = persistJson(setup.store, {
        runId: RUN_ID,
        phase: "sca-p02-input",
        kind: "sca-p02-runtime-policy",
        operationId: "p02-integration-runtime-policy",
        schemaId: SCA_P02_RUNTIME_POLICY_V1_SCHEMA,
        producer: SCA_P02_RUNTIME_POLICY_PRODUCER,
        value: runtimePolicy,
        upstreamRefs: [hostAttestationRef, isolationRef],
      });
      const p02Request = validateScaP02RequestV1({
        schema_id: SCA_P02_REQUEST_V1_SCHEMA,
        schema_version: 1 as const,
        tenant_id: setup.request.tenant_id,
        project_id: setup.request.project_id,
        run_id: RUN_ID,
        accepted_p01: {
          request_ref: accepted.request_ref,
          obligation_ledger_ref: accepted.obligation_ledger_ref,
          campaign_manifest_core_ref: accepted.manifest_core_ref,
          admission_evidence_ref: accepted.admission_evidence_ref,
          p01_gate_ref: accepted.p01_gate_ref,
          campaign_manifest_ref: accepted.campaign_manifest_ref,
          frozen_refs: [...scaP02FrozenRefs(core)],
        },
        runtime_policy_ref: runtimePolicyRef,
        isolation_evidence_ref: isolationRef,
        isolation_host_attestation_ref: null,
        requested_at: "2026-09-20T00:00:00.000Z",
      });
      const inputArtifacts = scaP02InputArtifacts(p02Request);
      expect(
        admitScaP02Candidate({
          store: setup.store,
          request: p02Request,
          input_artifacts: inputArtifacts,
        }).request
      ).toEqual(p02Request);
      const captured = captureOf(setup);
      expect(p02Request.accepted_p01.frozen_refs).toContainEqual(captured.ref);
      const omittedCapture = {
        ...p02Request,
        accepted_p01: {
          ...p02Request.accepted_p01,
          frozen_refs: p02Request.accepted_p01.frozen_refs.filter(
            (ref) => ref.artifact_id !== captured.ref.artifact_id
          ),
        },
      };
      expect(() =>
        admitScaP02Candidate({
          store: setup.store,
          request: omittedCapture,
          input_artifacts: scaP02InputArtifacts(omittedCapture),
        })
      ).toThrow(/every exact P01 frozen/u);
      const member = captured.manifest.entries[0];
      if (member === undefined) throw new Error("missing variant fixture");
      const missingVariantStore = artifactStoreView(setup.store, {
        refById: (id) =>
          id === member.custody_ref.artifact_id ? undefined : setup.store.refById(id),
      });
      expect(() =>
        admitScaP02Candidate({
          store: missingVariantStore,
          request: p02Request,
          input_artifacts: inputArtifacts,
        })
      ).toThrow(/variant capture|absent/u);
      const redigestedP01LedgerRequest = validateScaP02RequestV1({
        ...p02Request,
        accepted_p01: {
          ...p02Request.accepted_p01,
          obligation_ledger_ref: {
            ...p02Request.accepted_p01.obligation_ledger_ref,
            content_digest: sha256("substituted P01 ledger bytes"),
          },
        },
      });
      expect(() =>
        admitScaP02Candidate({
          store: setup.store,
          request: redigestedP01LedgerRequest,
          input_artifacts: scaP02InputArtifacts(redigestedP01LedgerRequest),
        })
      ).toThrow(/ref drifted|drifted/u);
      const substitutedHostAttestationRef = {
        ...hostAttestationRef,
        content_digest: sha256("substituted host attestation bytes"),
        store_ref: `artifact://sha256/${sha256("substituted host attestation bytes")}`,
      };
      const invalidHostLineage = validateScaP02RequestV1({
        ...p02Request,
        isolation_host_attestation_ref: substitutedHostAttestationRef,
      });
      expect(() =>
        admitScaP02Candidate({
          store: setup.store,
          request: invalidHostLineage,
          input_artifacts: scaP02InputArtifacts(invalidHostLineage),
        })
      ).toThrow(/host.*attestation|host_attestation|exact/u);
      const checkpointer = Checkpointer.provision(
        path.join(runtimeRoot, "orchestration.db"),
        undefined,
        {
          projectId,
        }
      );
      const trustedNow = new Date("2026-09-20T00:05:00.000Z");
      const baseComponentValidationAuthority = createScaP02ComponentValidationAuthorityV1(
        setup.store
      );
      let componentValidationFailure: unknown;
      const componentValidationAuthority = {
        validateComponents(
          input: Parameters<typeof baseComponentValidationAuthority.validateComponents>[0]
        ) {
          try {
            baseComponentValidationAuthority.validateComponents(input);
          } catch (error) {
            componentValidationFailure = error;
            throw error;
          }
        },
      };
      const engine = new OrchestrationEngine(checkpointer, {
        projectRoot: runtimeRoot,
        maxSteps: 30,
        receiptAuthority: TEST_RECEIPT_AUTHORITY,
        artifactRevisions: setup.store,
        artifactStore: setup.store,
        artifactReader: setup.store,
        playbookRegistration: SCA_P02_CANDIDATE_REGISTRATION,
        scaP02ComponentValidationAuthority: componentValidationAuthority,
        trustedClock: () => trustedNow,
      });
      const transportBodies: unknown[] = [];
      let transportCalls = 0;
      const osvTransport = {
        ip_confinement: "external_worker_enforced" as const,
        async send(request: { readonly url: string; readonly body: string | null }) {
          transportCalls += 1;
          if (request.body === null) throw new Error("unexpected advisory detail request");
          const body: unknown = JSON.parse(request.body);
          transportBodies.push(body);
          if (
            failNpmLookup &&
            isRecord(body) &&
            Array.isArray(body.queries) &&
            body.queries.some(
              (query) =>
                isRecord(query) && isRecord(query.package) && query.package.ecosystem === "npm"
            )
          ) {
            return {
              status_code: 503,
              final_url: request.url,
              redirected: false,
              body: Buffer.from("service unavailable", "utf8"),
            };
          }
          const queryCount =
            isRecord(body) && Array.isArray(body.queries) ? body.queries.length : 0;
          return {
            status_code: 200,
            final_url: request.url,
            redirected: false,
            body: Buffer.from(
              canonicalJson({
                results: Array.from({ length: queryCount }, () => ({ vulns: [] })),
              }),
              "utf8"
            ),
          };
        },
      };
      let priorProcessProofs = 0;
      const adapterOptions = {
        local_recovery: {
          prove_prior_process_terminated() {
            priorProcessProofs += 1;
            return false;
          },
        },
        component_validation_authority: componentValidationAuthority,
        isolation: {
          isolation_id: isolationEvidence.isolation_id,
          runtime_id: isolationEvidence.runtime_id,
          implementation_identity_sha256: isolationEvidence.implementation_identity_sha256,
          deployment_identity_sha256: isolationEvidence.deployment_identity_sha256,
          profile_id: isolationEvidence.profile_id,
          profile_sha256: isolationEvidence.profile_sha256,
          runtime_kind: isolationEvidence.runtime_kind,
          qualification_scope: isolationEvidence.qualification_scope,
          simulation_label: "simulated_test_seam" as const,
          async run<T>({ execute }: { readonly execute: () => Promise<T> }) {
            return execute();
          },
        },
        osv_transports: {
          osv_composer: {
            transport_id: runtimePolicy.osv.transport_id,
            transport: osvTransport,
          },
          osv_npm: {
            transport_id: runtimePolicy.osv.transport_id,
            transport: osvTransport,
          },
        },
        now: () => new Date("2026-09-20T00:00:00.000Z"),
      } satisfies ScaP02OperationAdapterOptionsV1;
      let crashInjected = false;
      const adapters = createScaP02OperationAdaptersV1({
        ...adapterOptions,
        fault(point, kind) {
          if (!crashInjected && point === "after_result_cached" && kind === "semgrep_php") {
            crashInjected = true;
            throw new HostOperationSimulatedCrashError("after_fetch");
          }
        },
      });
      const leaseAuthority = new HostOperationLeaseAuthority(hostStateRoot);
      const resultCache = await FileHostOperationResultCache.provision(
        path.join(runtimeRoot, "result-cache")
      );
      const owner = new HostOperationRuntimeOwner({
        projectId,
        checkpointer,
        artifacts: setup.store,
        leaseAuthority,
        adapters,
        resultCache,
        fault(point, kind) {
          if (
            unprovenResume &&
            !crashInjected &&
            point === "after_remote_checkpoint" &&
            kind === "sca.p02.inventory.v1"
          ) {
            crashInjected = true;
            throw new HostOperationSimulatedCrashError(point);
          }
        },
      });
      const dispatch = { provider: 0, session: 0, model: 0 };
      const model: ModelClient = {
        async runAgent() {
          dispatch.provider += 1;
          dispatch.session += 1;
          dispatch.model += 1;
          throw new Error("P02 no-worker registration reached a model surface");
        },
      };
      const runner = new OrchestrationRunner(
        engine,
        new WorkerExecutor(model, setup.store, {
          projectRoot: runtimeRoot,
          parallelConcurrency: 1,
          registration: SCA_P02_CANDIDATE_REGISTRATION,
        }),
        undefined,
        owner
      );
      const identity: RunIdentity = {
        schema_version: 2,
        run_id: RUN_ID,
        session_id: "p02-real-integration-session",
        playbook: SCA_P02_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      };
      const started = engine.handle({
        schema_version: 2,
        action: "start",
        identity,
        goal: "Exercise the actual inactive P02 candidate integration slice.",
        constraints: { p02_request: p02Request },
        project_root: runtimeRoot,
        trust_profile: "hardened-untrusted",
        input_artifacts: inputArtifacts,
      });
      expect(started).toMatchObject({ action: "status", state_id: "sca_p02_inventory" });
      const first = engine.handle({ schema_version: 2, action: "recover", identity });
      let firstFailure: unknown;
      try {
        await runner.runUntilBoundary(first);
      } catch (error) {
        firstFailure = error;
      }
      if (!(firstFailure instanceof HostOperationSimulatedCrashError)) {
        const journals = checkpointer.hostOperationCallsForRun(RUN_ID);
        const platformResults = journals.flatMap((entry) =>
          entry.platform_result_ref === null ? [] : [parsed(setup.store, entry.platform_result_ref)]
        );
        throw new Error(
          `P02 initial integration failed with journals ${canonicalJson(journals)} and platform results ${canonicalJson(platformResults)}`,
          { cause: componentValidationFailure ?? firstFailure }
        );
      }
      expect(crashInjected).toBe(true);
      if (unprovenResume) {
        expect(priorProcessProofs).toBe(0);
        const [prior] = checkpointer.hostOperationCallsForRun(RUN_ID);
        if (prior === undefined) throw new Error("submitted inventory journal absent");
        expect(prior.lifecycle).toBe("submitted");
        expect(prior.operation_result_ref).toBeNull();
        expect(transportCalls).toBe(0);
        leaseAuthority.close();
        using resumedLeases = new HostOperationLeaseAuthority(hostStateRoot);
        const resumedOwner = new HostOperationRuntimeOwner({
          projectId,
          checkpointer,
          artifacts: setup.store,
          leaseAuthority: resumedLeases,
          adapters: createScaP02OperationAdaptersV1(adapterOptions),
          resultCache,
        });
        const resumedRunner = new OrchestrationRunner(
          engine,
          new WorkerExecutor(model, setup.store, {
            projectRoot: runtimeRoot,
            parallelConcurrency: 1,
            registration: SCA_P02_CANDIDATE_REGISTRATION,
          }),
          undefined,
          resumedOwner
        );
        await expect(
          resumedRunner.runUntilBoundary(
            engine.handle({ schema_version: 2, action: "recover", identity })
          )
        ).rejects.toThrow("SCA P02 inventory result is absent after host settlement");
        expect(priorProcessProofs).toBe(1);
        const [settled] = checkpointer.hostOperationCallsForRun(RUN_ID);
        if (settled === undefined) throw new Error("quarantined inventory journal absent");
        expect(settled).toMatchObject({
          lifecycle: "settled",
          operation_result_ref: null,
          remote_correlation_id: prior.remote_correlation_id,
          disposition: {
            outcome: "remote_unknown",
            remote_disposition: "may_continue",
            lease_disposition: "quarantined",
            retryable: false,
          },
        });
        expect(resumedLeases.inspect(prior.policy_binding.backend_key_sha256)).toMatchObject({
          state: "quarantined",
        });
        // Repeated recovery cannot repeat submission, proof, collector, scanner, or send.
        await expect(
          resumedRunner.runUntilBoundary(
            engine.handle({ schema_version: 2, action: "recover", identity })
          )
        ).rejects.toThrow("SCA P02 inventory result is absent after host settlement");
        expect(checkpointer.hostOperationCallsForRun(RUN_ID)).toEqual([settled]);
        expect(priorProcessProofs).toBe(1);
        expect(transportCalls).toBe(0);
        expect(dispatch).toEqual({ provider: 0, session: 0, model: 0 });
        expect(existsSync(scanners.semgrep.counterPath)).toBe(false);
        expect(existsSync(scanners.gitleaks.counterPath)).toBe(false);
        checkpointer.close();
        return;
      }
      expect(readFileSync(scanners.semgrep.counterPath, "utf8")).toBe("1");
      const crashJournal = checkpointer.hostOperationCallsForRun(RUN_ID);
      expect(crashJournal.map((entry) => [entry.operation_kind, entry.lifecycle])).toEqual([
        ["sca.p02.inventory.v1", "consumed"],
        ["sca.p02.osv-composer.v1", "consumed"],
        ["sca.p02.osv-npm.v1", "consumed"],
        ["sca.p02.semgrep-php.v1", "submitted"],
      ]);
      expect(crashJournal[3]).toMatchObject({
        lifecycle: "submitted",
        operation_id: "sca-p02-semgrep-php",
        fetched: null,
        operation_result_ref: null,
      });

      leaseAuthority.close();
      const recoveryLeaseAuthority = new HostOperationLeaseAuthority(hostStateRoot);
      const recoveryOwner = new HostOperationRuntimeOwner({
        projectId,
        checkpointer,
        artifacts: setup.store,
        leaseAuthority: recoveryLeaseAuthority,
        adapters: createScaP02OperationAdaptersV1(adapterOptions),
        resultCache: await FileHostOperationResultCache.provision(
          path.join(runtimeRoot, "result-cache")
        ),
      });
      const recoveryRunner = new OrchestrationRunner(
        engine,
        new WorkerExecutor(model, setup.store, {
          projectRoot: runtimeRoot,
          parallelConcurrency: 1,
          registration: SCA_P02_CANDIDATE_REGISTRATION,
        }),
        undefined,
        recoveryOwner
      );
      const recovered = engine.handle({ schema_version: 2, action: "recover", identity });
      let terminal: Directive;
      try {
        terminal = await recoveryRunner.runUntilBoundary(recovered);
      } catch (error) {
        const journals = checkpointer.hostOperationCallsForRun(RUN_ID);
        const platformResults = journals.flatMap((entry) =>
          entry.platform_result_ref === null ? [] : [parsed(setup.store, entry.platform_result_ref)]
        );
        throw new Error(
          `P02 recovery integration failed with journals ${canonicalJson(journals)} and platform results ${canonicalJson(platformResults)}`,
          { cause: error }
        );
      }
      const completedOperations = checkpointer.hostOperationCallsForRun(RUN_ID);
      expect(completedOperations).toHaveLength(6);
      expect(priorProcessProofs).toBe(0);
      for (const entry of completedOperations) {
        expect(entry.lifecycle).toBe("consumed");
        expect(entry.disposition).toEqual({
          outcome: "completed",
          remote_disposition: "proven_terminal",
          lease_disposition: "released",
          retryable: false,
          reason_code: null,
        });
        if (entry.operation_result_ref === null) throw new Error("P02 result absent");
        expect(setup.store.read(entry.operation_result_ref).byteLength).toBeGreaterThan(0);
      }
      const inventoryJournal = completedOperations.find(
        (entry) => entry.operation_kind === "sca.p02.inventory.v1"
      );
      if (inventoryJournal?.operation_result_ref == null) throw new Error("inventory absent");
      const entryInventoryRequest = validateScaP02OperationRequestV1(
        "inventory",
        parsed(setup.store, inventoryJournal.request_ref)
      );
      const entryInventoryResult = validateScaP02OperationResultV1(
        "inventory",
        entryInventoryRequest,
        parsed(setup.store, inventoryJournal.operation_result_ref)
      );
      expect(entryInventoryResult.status).toBe("complete");
      expect(
        entryInventoryResult.analyzer_results.every((entry) => entry.status === "complete")
      ).toBe(true);
      expect(engine.handle({ schema_version: 2, action: "recover", identity })).toEqual(terminal);
      expect(engine.handle({ schema_version: 2, action: "status", identity })).toMatchObject({
        status: "incomplete",
        met: false,
      });
      expect(readFileSync(scanners.semgrep.counterPath, "utf8")).toBe("111");
      expect(readFileSync(scanners.gitleaks.counterPath, "utf8")).toBe("1");
      if (
        terminal.action === "incomplete" &&
        isRecord(terminal.result) &&
        terminal.result.boundary === "blocked_at_p02"
      ) {
        expect(terminal).toMatchObject({
          action: "incomplete",
          status: "incomplete",
          result: {
            boundary: "blocked_at_p02",
            gate_status: "blocked",
            transition_ref: null,
            campaign_terminal: false,
            release_eligible: false,
            model_calls: 0,
          },
        });
        if (terminal.action !== "incomplete") throw new Error("P02 blocked terminal is absent");
        expect(dispatch).toEqual({ provider: 0, session: 0, model: 0 });
        expect(checkpointer.hostOperationCallsForRun(RUN_ID)).toHaveLength(6);
        expect(
          checkpointer
            .hostOperationCallsForRun(RUN_ID)
            .every((entry) => entry.lifecycle === "consumed")
        ).toBe(true);
        const output = (kind: string): ArtifactRef => {
          const found = terminal.artifacts.find((ref) => ref.kind === kind);
          if (found === undefined) throw new Error(`P02 blocked terminal lacks ${kind}`);
          return found;
        };
        const coverageRef = output("sca-p02-coverage-matrix");
        const ledgerRef = output("sca-p02-successor-obligation-ledger");
        const manifestRef = output("sca-p02-evidence-manifest");
        const gateRef = output("sca-p02-gate");
        const m1Ref = output("sca-m1-record");
        const coverage = validateScaP02CoverageMatrixV1(parsed(setup.store, coverageRef));
        const ledger = validateScaP02SuccessorLedgerV1(parsed(setup.store, ledgerRef));
        const manifest = validateScaP02EvidenceManifestV1(parsed(setup.store, manifestRef));
        const gate = validateScaP02GateV1(parsed(setup.store, gateRef));
        const m1 = validateScaM1RecordV2(parsed(setup.store, m1Ref));
        expect(setup.store.selected(RUN_ID, "sca-p02-candidate", null, "sca-m1-record")).toEqual(
          m1Ref
        );
        expect(
          coverage.entries.find((entry) => entry.analyzer_id === "source-census")
        ).toMatchObject({
          status: "complete",
          blocker_codes: [],
        });
        expect(
          coverage.entries.find((entry) => entry.analyzer_id === "osv-composer")
        ).toMatchObject({
          status: "blocked",
          blocker_codes: ["osv_isolation_unavailable"],
        });
        expect(coverage.entries.find((entry) => entry.analyzer_id === "osv-npm")).toMatchObject({
          status: "blocked",
          blocker_codes: ["osv_isolation_unavailable"],
        });
        expect(manifest.analyzers.find((entry) => entry.analyzer_id === "osv-npm")).toMatchObject({
          status: "blocked",
          blocker_codes: ["osv_isolation_unavailable"],
        });
        expect(manifest.operations).toHaveLength(6);
        for (const operation of manifest.operations) {
          const persisted = validateScaP02PersistedEvidenceV1(
            parsed(setup.store, operation.normalized_evidence_ref)
          );
          expect(persisted.raw_records.length).toBeGreaterThan(0);
          expect(persisted.operation_result_ref).toEqual(operation.operation_result_ref);
        }
        expect(ledger.dispositions[0]?.status).toBe("satisfied");
        expect(ledger.dispositions.slice(1).map((entry) => entry.status)).toEqual(
          Array.from({ length: 9 }, () => "blocked")
        );
        expect(gate.status).toBe("blocked");
        expect(gate.blocker_codes).toContain("isolation:not_live_qualified");
        expect(gate.blocker_codes).toContain("osv-npm:osv_isolation_unavailable");
        expect(
          validateScaP02GateAgainstCoverageV1({
            gate,
            coverage,
            coverage_ref: coverageRef,
            successor_ledger_ref: ledgerRef,
            evidence_manifest_ref: manifestRef,
            evidence_manifest: manifest,
            successor_ledger: ledger,
            p02_request_ref: manifest.p02_request_ref,
            runtime_policy_ref: manifest.runtime_policy_ref,
            isolation_evidence_ref: manifest.isolation_evidence_ref,
            isolation_host_attestation_ref: manifest.isolation_host_attestation_ref,
            isolation_evidence: isolationEvidence,
          }).gate
        ).toEqual(gate);
        expect(m1).toMatchObject({
          status: "blocked",
          blocker_codes: gate.blocker_codes,
          transition_authorized: false,
          nonterminal: true,
          campaign_terminal: false,
          release_eligible: false,
        });
        expect(
          validateScaM1AgainstGateV2({
            m1,
            gate,
            gate_ref: gateRef,
            coverage_ref: coverageRef,
            successor_ledger_ref: ledgerRef,
            evidence_manifest_ref: manifestRef,
            p02_request_ref: manifest.p02_request_ref,
            runtime_policy_ref: manifest.runtime_policy_ref,
            isolation_evidence_ref: manifest.isolation_evidence_ref,
            isolation_host_attestation_ref: manifest.isolation_host_attestation_ref,
          })
        ).toEqual(m1);
        expect(terminal.artifacts.some((ref) => ref.kind === "sca-p02-p03-transition")).toBe(false);
        expect(
          setup.store.refFor(
            RUN_ID,
            "sca-p02-candidate",
            null,
            "sca-p02-p03-transition",
            "sca-p02-p03-transition",
            1
          )
        ).toBeNull();
        const replay = engine.handle({ schema_version: 2, action: "recover", identity });
        expect(replay).toEqual(terminal);
        expect(engine.handle({ schema_version: 2, action: "status", identity })).toMatchObject({
          status: "incomplete",
          met: false,
        });
        expect(checkpointer.hostOperationCallsForRun(RUN_ID)).toHaveLength(6);
        recoveryLeaseAuthority.close();
        checkpointer.close();
        using reopened = Checkpointer.openExisting(
          path.join(runtimeRoot, "orchestration.db"),
          undefined,
          { projectId }
        );
        const replayEngine = new OrchestrationEngine(reopened, {
          projectRoot: runtimeRoot,
          maxSteps: 30,
          receiptAuthority: TEST_RECEIPT_AUTHORITY,
          artifactRevisions: setup.store,
          artifactStore: setup.store,
          artifactReader: setup.store,
          playbookRegistration: SCA_P02_CANDIDATE_REGISTRATION,
          scaP02ComponentValidationAuthority: componentValidationAuthority,
          trustedClock: () => trustedNow,
        });
        expect(replayEngine.handle({ schema_version: 2, action: "recover", identity })).toEqual(
          terminal
        );
        expect(reopened.hostOperationCallsForRun(RUN_ID)).toHaveLength(6);
        expect(readFileSync(scanners.semgrep.counterPath, "utf8")).toBe("111");
        expect(readFileSync(scanners.gitleaks.counterPath, "utf8")).toBe("1");
        expect(transportCalls).toBe(0);
        expect(dispatch).toEqual({ provider: 0, session: 0, model: 0 });
        return;
      }
      if (
        terminal.action === "incomplete" &&
        isRecord(terminal.result) &&
        terminal.result.gate_status !== "passed"
      ) {
        const scannerDiagnostics = terminal.artifacts
          .filter((ref) => ref.kind.includes("semgrep") || ref.kind.includes("gitleaks"))
          .map((ref) => parsed(setup.store, ref));
        throw new Error(
          `P02 integration gate blocked: ${canonicalJson(terminal.result)} scanner diagnostics ${canonicalJson(scannerDiagnostics)}`
        );
      }
      expect(terminal).toMatchObject({
        action: "incomplete",
        status: "incomplete",
        result: {
          boundary: "p03",
          gate_status: "passed",
          campaign_terminal: false,
          release_eligible: false,
          model_calls: 0,
        },
      });
      expect(dispatch).toEqual({ provider: 0, session: 0, model: 0 });
      expect(checkpointer.hostOperationCallsForRun(RUN_ID)).toHaveLength(6);
      expect(
        checkpointer
          .hostOperationCallsForRun(RUN_ID)
          .every((entry) => entry.lifecycle === "consumed")
      ).toBe(true);
      expect(transportCalls).toBe(2);

      if (terminal.action !== "incomplete" || !isRecord(terminal.result)) {
        throw new Error("P02 integration terminal is not inspectable");
      }
      const manifestRef = terminal.result.evidence_manifest_ref;
      const ledgerRef = terminal.result.successor_ledger_ref;
      const gateRef = terminal.result.gate_ref;
      const m1Ref = terminal.result.m1_ref;
      const transitionRef = terminal.result.transition_ref;
      if (
        !isRecord(manifestRef) ||
        !isRecord(ledgerRef) ||
        !isRecord(gateRef) ||
        !isRecord(m1Ref) ||
        !isRecord(transitionRef)
      ) {
        throw new Error("P02 integration terminal lacks exact output refs");
      }
      const artifact = (value: Readonly<Record<string, unknown>>): ArtifactRef => {
        if (
          typeof value.artifact_id !== "string" ||
          typeof value.run_id !== "string" ||
          typeof value.phase !== "string" ||
          !(typeof value.branch_id === "string" || value.branch_id === null) ||
          typeof value.kind !== "string" ||
          typeof value.operation_id !== "string" ||
          typeof value.version !== "number" ||
          typeof value.producer !== "string" ||
          typeof value.media_type !== "string" ||
          typeof value.byte_length !== "number" ||
          typeof value.content_digest !== "string" ||
          typeof value.store_ref !== "string"
        ) {
          throw new Error("P02 integration terminal contains a malformed artifact ref");
        }
        return {
          schema_version: 2,
          artifact_id: value.artifact_id,
          run_id: value.run_id,
          phase: value.phase,
          branch_id: value.branch_id,
          kind: value.kind,
          operation_id: value.operation_id,
          version: value.version,
          producer: value.producer,
          media_type: value.media_type,
          ...(isRecord(value.content_schema)
            ? {
                content_schema: {
                  schema_id: String(value.content_schema.schema_id),
                  schema_version: Number(value.content_schema.schema_version),
                },
              }
            : {}),
          byte_length: value.byte_length,
          content_digest: value.content_digest,
          store_ref: value.store_ref,
        };
      };
      const manifest = validateScaP02EvidenceManifestV1(parsed(setup.store, artifact(manifestRef)));
      const ledger = validateScaP02SuccessorLedgerV1(parsed(setup.store, artifact(ledgerRef)));
      const coverage = validateScaP02CoverageMatrixV1(
        parsed(setup.store, manifest.coverage_matrix_ref)
      );
      const gate = validateScaP02GateV1(parsed(setup.store, artifact(gateRef)));
      const m1 = validateScaM1RecordV2(parsed(setup.store, artifact(m1Ref)));
      expect(setup.store.selected(RUN_ID, "sca-p02-candidate", null, "sca-m1-record")).toEqual(
        artifact(m1Ref)
      );
      const transition = validateScaP02P03TransitionV1(
        parsed(setup.store, artifact(transitionRef))
      );
      expect(manifest.operations).toHaveLength(6);
      expect(manifest.analyzers).toHaveLength(10);
      const terminalArtifactIds = new Set(terminal.artifacts.map((ref) => ref.artifact_id));
      for (const operation of manifest.operations) {
        expect(
          [
            operation.operation_request_ref,
            operation.operation_result_ref,
            operation.normalized_evidence_ref,
            operation.operation_receipt_ref,
          ].every((ref) => terminalArtifactIds.has(ref.artifact_id))
        ).toBe(true);
      }
      expect(ledger.prior_p01_ledger_ref).toEqual(accepted.obligation_ledger_ref);
      expect(ledger.dispositions.map((entry) => [entry.obligation_id, entry.status])).toEqual([
        ["SCA-OBL-P01-ACCEPTANCE", "satisfied"],
        ["SCA-OBL-OUTPUT-SOURCE-CENSUS", "satisfied"],
        ["SCA-OBL-OUTPUT-SYNTAX-INDEX", "satisfied"],
        ["SCA-OBL-OUTPUT-SEMGREP", "satisfied"],
        ["SCA-OBL-OUTPUT-SECRET-SCAN", "satisfied"],
        ["SCA-OBL-OUTPUT-DEPENDENCY-INVENTORY", "satisfied"],
        ["SCA-OBL-OUTPUT-OSV-EVIDENCE", "satisfied"],
        ["SCA-OBL-OUTPUT-NORMALIZED-CANDIDATES", "satisfied"],
        ["SCA-OBL-P02-ACCEPTANCE", "satisfied"],
        ["SCA-OBL-M1-NONTERMINAL", "satisfied"],
      ]);
      expect(ledger.pending_phase_ids).toEqual([
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
      ]);
      expect(gate.status).toBe("passed");
      const deterministicTestOnlyIsolation = validateScaP02IsolationEvidenceV1({
        schema_id: isolationEvidence.schema_id,
        schema_version: isolationEvidence.schema_version,
        producer_id: isolationEvidence.producer_id,
        evidence_kind: "simulated_test_seam",
        runtime_kind: "simulated_test_runtime",
        isolation_id: isolationEvidence.isolation_id,
        runtime_id: isolationEvidence.runtime_id,
        implementation_identity_sha256: isolationEvidence.implementation_identity_sha256,
        deployment_identity_sha256: isolationEvidence.deployment_identity_sha256,
        qualification_scope: "deterministic_test_only",
        qualified: false,
        profile_id: isolationEvidence.profile_id,
        profile_sha256: isolationEvidence.profile_sha256,
        qualified_at: isolationEvidence.qualified_at,
      });
      expect(() =>
        validateScaP02GateAgainstCoverageV1({
          gate,
          coverage,
          coverage_ref: manifest.coverage_matrix_ref,
          successor_ledger_ref: artifact(ledgerRef),
          evidence_manifest_ref: artifact(manifestRef),
          evidence_manifest: manifest,
          successor_ledger: ledger,
          p02_request_ref: manifest.p02_request_ref,
          runtime_policy_ref: manifest.runtime_policy_ref,
          isolation_evidence_ref: manifest.isolation_evidence_ref,
          isolation_host_attestation_ref: manifest.isolation_host_attestation_ref,
          isolation_evidence: deterministicTestOnlyIsolation,
        })
      ).toThrow(/bind exact|is not exact|blockers|cannot pass/u);
      expect(m1).toMatchObject({
        status: "passed",
        nonterminal: true,
        release_eligible: false,
        campaign_terminal: false,
        transition_authorized: true,
      });
      expect(transition).toMatchObject({
        from_phase_id: "SCA-P02",
        to_phase_id: "SCA-P03",
        qualification_claimed: false,
        campaign_terminal: false,
        release_eligible: false,
      });
      for (const persisted of [manifest, gate, m1, transition]) {
        expect(persisted.isolation_host_attestation_ref).toEqual(hostAttestationRef);
      }
      for (const ref of [manifestRef, gateRef, m1Ref, transitionRef]) {
        expect(
          setup.store
            .metadata(artifact(ref))
            .upstream_refs.some(
              (upstream) => upstream.artifact_id === hostAttestationRef.artifact_id
            )
        ).toBe(true);
      }
      const transitionValidation = {
        transition,
        m1,
        m1_ref: artifact(m1Ref),
        gate_ref: artifact(gateRef),
        coverage_ref: manifest.coverage_matrix_ref,
        successor_ledger_ref: artifact(ledgerRef),
        evidence_manifest_ref: artifact(manifestRef),
        evidence_manifest: manifest,
        p01_request_ref: accepted.request_ref,
        p01_campaign_manifest_core_ref: accepted.manifest_core_ref,
        p01_campaign_manifest_ref: accepted.campaign_manifest_ref,
        p01_predecessor_ledger_ref: accepted.obligation_ledger_ref,
        p02_request_ref: manifest.p02_request_ref,
        runtime_policy_ref: manifest.runtime_policy_ref,
        isolation_evidence_ref: manifest.isolation_evidence_ref,
        isolation_host_attestation_ref: manifest.isolation_host_attestation_ref,
      };
      expect(validateScaP02TransitionAgainstM1V1(transitionValidation)).toEqual(transition);
      const incorrectLineageTransitionRef = persistJson(setup.store, {
        runId: RUN_ID,
        phase: "sca-p02-candidate",
        kind: "sca-p02-p03-transition",
        operationId: "sca-p02-p03-transition-incorrect-lineage",
        schemaId: "penny.sca-p02-p03-transition.v1",
        producer: "host:sca-p02-candidate",
        value: transition,
        upstreamRefs: [],
      });
      const exactLineageAdmission = createScaP03TransitionAdmissionV1({
        store: setup.store,
        trusted_clock: () => new Date("2026-09-20T00:05:00.000Z"),
      });
      expect(() =>
        exactLineageAdmission.consume({ transition_ref: incorrectLineageTransitionRef })
      ).toThrow(/exact host isolation attestation upstream lineage/u);
      const delayedAdmission = createScaP03TransitionAdmissionV1({
        store: setup.store,
        trusted_clock: () => new Date("2026-09-20T02:00:00.000Z"),
      });
      expect(() => delayedAdmission.consume({ transition_ref: artifact(transitionRef) })).toThrow(
        /expired at trusted consumption time/u
      );

      const inventoryOperation = manifest.operations.find(
        (entry) => entry.operation_kind === "inventory"
      );
      if (inventoryOperation === undefined) throw new Error("inventory manifest entry is absent");
      const inventoryRequest = validateScaP02OperationRequestV1(
        "inventory",
        parsed(setup.store, inventoryOperation.operation_request_ref)
      );
      const inventoryResult = validateScaP02OperationResultV1(
        "inventory",
        inventoryRequest,
        parsed(setup.store, inventoryOperation.operation_result_ref)
      );
      if (inventoryResult.operation_kind !== "inventory") {
        throw new Error("inventory result kind drifted");
      }

      const replaceComponentEvidence = (
        result: ScaP02OperationResultV1,
        targetSchemaId: string,
        update: (value: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>
      ): ScaP02OperationResultV1 => {
        let replaced = false;
        const bundles = result.raw_evidence.map((evidence) => {
          const decoded = decodeScaP02RawEvidenceV1(evidence);
          if (!isRecord(decoded.value) || decoded.value.schema_id !== targetSchemaId) {
            return { evidence, raw_records: decoded.raw_records };
          }
          replaced = true;
          return buildScaP02RawEvidenceV1({
            analyzer_id: evidence.analyzer_id,
            value: update(decoded.value),
          });
        });
        if (!replaced) throw new Error(`component evidence '${targetSchemaId}' is absent`);
        const rawEvidence = bundles.map((bundle) => bundle.evidence);
        const rawRecords = bundles.flatMap((bundle) => bundle.raw_records);
        const provenance = deriveScaP02ProvenanceV1({
          raw_evidence: rawEvidence,
          raw_records: rawRecords,
        });
        return {
          ...result,
          raw_evidence: rawEvidence,
          raw_records: rawRecords,
          normalized_observations: [...provenance.normalized_observations],
          correlations: [...provenance.correlations],
        };
      };

      const treeDrift = replaceComponentEvidence(
        inventoryResult,
        "penny.sca-tree-sitter-index-result.v2",
        (value) => {
          const { index_sha256: _observed, ...unsigned } = value;
          if (!isUnknownArray(unsigned.files) || !isRecord(unsigned.files[0])) {
            throw new Error("tree-sitter drift fixture lacks a file result");
          }
          const driftedFiles = unsigned.files.map((file, index) => {
            if (index !== 0 || !isRecord(file) || !isUnknownArray(file.diagnostics)) return file;
            return {
              ...file,
              diagnostics: [
                ...file.diagnostics,
                {
                  code: "adversarial_drift",
                  message: "semantically valid deterministic rebuild drift",
                  range: null,
                },
              ],
            };
          });
          const drifted = { ...unsigned, files: driftedFiles };
          return { ...drifted, index_sha256: sha256(canonicalJson(drifted)) };
        }
      );
      expect(() =>
        componentValidationAuthority.validateComponents({
          operation_kind: "inventory",
          request: inventoryRequest,
          result: treeDrift,
        })
      ).toThrow(/deterministic admitted-input rebuild/u);

      const dependencyDrift = replaceComponentEvidence(
        inventoryResult,
        "penny.sca-dependency-inventory-result.v2",
        (value) => {
          const { inventory_sha256: _observed, ...unsigned } = value;
          if (!isUnknownArray(unsigned.documents) || !isRecord(unsigned.documents[0])) {
            throw new Error("dependency drift fixture lacks a document result");
          }
          const driftedDocuments = unsigned.documents.map((document, index) =>
            index === 0 && isRecord(document) ? { ...document, sha256: "0".repeat(64) } : document
          );
          const drifted = { ...unsigned, documents: driftedDocuments };
          return { ...drifted, inventory_sha256: sha256(canonicalJson(drifted)) };
        }
      );
      expect(() =>
        componentValidationAuthority.validateComponents({
          operation_kind: "inventory",
          request: inventoryRequest,
          result: dependencyDrift,
        })
      ).toThrow(/deterministic admitted-input rebuild/u);

      const custodySummaryDrifts: readonly [string, unknown][] = [
        ["file_manifest_sha256", "0".repeat(64)],
        ["custody_sha256", "1".repeat(64)],
        ["tree_sha256", "2".repeat(64)],
        ["file_count", 999],
        ["byte_count", 999],
        ["filesystem_modes_prepared_read_only", false],
      ];
      for (const [field, driftedValue] of custodySummaryDrifts) {
        const custodyDrift = replaceComponentEvidence(
          inventoryResult,
          "penny.sca-p02-custody-summary.v1",
          (value) => ({ ...value, [field]: driftedValue })
        );
        expect(() =>
          componentValidationAuthority.validateComponents({
            operation_kind: "inventory",
            request: inventoryRequest,
            result: custodyDrift,
          })
        ).toThrow(/custody summary|source_custody_summary_drift/u);
      }

      const semgrepOperation = manifest.operations.find(
        (entry) => entry.operation_kind === "semgrep_php"
      );
      if (semgrepOperation === undefined) throw new Error("semgrep PHP manifest entry is absent");
      const semgrepRequest = validateScaP02OperationRequestV1(
        "semgrep_php",
        parsed(setup.store, semgrepOperation.operation_request_ref)
      );
      const semgrepResult = validateScaP02OperationResultV1(
        "semgrep_php",
        semgrepRequest,
        parsed(setup.store, semgrepOperation.operation_result_ref)
      );
      if (semgrepRequest.operation_kind !== "semgrep_php") {
        throw new Error("semgrep PHP request kind drifted");
      }
      const semgrepSucceededWithFindings = replaceComponentEvidence(
        semgrepResult,
        "penny.sca-semgrep-result.v1",
        (value) => {
          const stdout = canonicalJson({
            errors: [],
            results: [
              {
                check_id: semgrepRequest.selected_rule_bindings[0]?.rule_id,
                extra: { message: "authoritative admission adversarial finding" },
                path: "src/example.php",
                start: { line: 1 },
              },
            ],
          });
          return {
            ...value,
            status: "succeeded",
            exit_code: 0,
            finding_count: 1,
            raw_stdout: stdout,
            raw_stdout_sha256: sha256(stdout),
          };
        }
      );
      expect(() =>
        componentValidationAuthority.validateComponents({
          operation_kind: "semgrep_php",
          request: semgrepRequest,
          result: semgrepSucceededWithFindings,
        })
      ).toThrow();

      for (const kind of [
        "osv_composer",
        "osv_npm",
      ] as const satisfies readonly ScaP02OperationKind[]) {
        const operation = manifest.operations.find((entry) => entry.operation_kind === kind);
        if (operation === undefined) throw new Error(`${kind} manifest entry is absent`);
        const request = validateScaP02OperationRequestV1(
          kind,
          parsed(setup.store, operation.operation_request_ref)
        );
        if (request.operation_kind !== kind) throw new Error(`${kind} request drifted`);
        expect(request.isolation_profile_sha256).toBe(operationProfiles[kind]);
        const ecosystem = kind === "osv_composer" ? "Packagist" : "npm";
        expect(request.coordinates).toEqual(
          inventoryResult.dependency_coordinates.filter(
            (coordinate) => coordinate.package.ecosystem === ecosystem
          )
        );
        expect(request.mappings).toEqual(
          inventoryResult.dependency_mappings.filter(
            (mapping) => mapping.package.ecosystem === ecosystem
          )
        );
        const osvResult = validateScaP02OperationResultV1(
          kind,
          request,
          parsed(setup.store, operation.operation_result_ref)
        );
        if (kind === "osv_npm") {
          const planDrift = replaceComponentEvidence(
            osvResult,
            "penny.sca-osv-plan.v2",
            (value) => {
              const { plan_sha256: _observed, ...unsigned } = value;
              const drifted = { ...unsigned, dependency_inventory_sha256: "0".repeat(64) };
              return { ...drifted, plan_sha256: sha256(canonicalJson(drifted)) };
            }
          );
          expect(() =>
            componentValidationAuthority.validateComponents({
              operation_kind: kind,
              request,
              result: planDrift,
            })
          ).toThrow(/plan does not exactly correspond|deterministic plan drift/u);
          const freshnessDrift = {
            ...osvResult,
            freshness: {
              ...osvResult.freshness,
              expires_at:
                osvResult.freshness.expires_at === null
                  ? "2026-09-20T01:00:00.000Z"
                  : new Date(Date.parse(osvResult.freshness.expires_at) + 1_000).toISOString(),
            },
          };
          expect(() =>
            componentValidationAuthority.validateComponents({
              operation_kind: kind,
              request,
              result: freshnessDrift,
            })
          ).toThrow();
        }
      }
      const transportedPackages = transportBodies.flatMap((body) =>
        isRecord(body) && Array.isArray(body.queries)
          ? body.queries.flatMap((query) =>
              isRecord(query) && isRecord(query.package) && typeof query.package.name === "string"
                ? [
                    `${String(query.package.ecosystem)}:${query.package.name}:${String(query.version)}`,
                  ]
                : []
            )
          : []
      );
      expect(transportedPackages.sort()).toEqual(
        inventoryResult.dependency_coordinates
          .map(
            (coordinate) =>
              `${coordinate.package.ecosystem}:${coordinate.package.name}:${coordinate.package.version}`
          )
          .sort()
      );
      expect(existsSync(path.join(runtimeRoot, "result-cache"))).toBe(true);

      // Continue the same accepted P01→P02 lineage through the actual inactive P03 candidate.
      const joernTool = toolchain.tools.find((tool) => tool.tool_id === "parser-joern-p03");
      if (joernTool === undefined) throw new Error("P03 integration fixture lacks measured Joern");
      const p03Phase = "sca-p03-input";
      const p03Implementation = withScaP03Digest(
        {
          schema_id: SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
          schema_version: 1,
          implementation_id: "p03-integration-implementation",
          implementation_revision: "p03-integration-r1",
          source_sha256: sha256("p03 integration source"),
          build_sha256: sha256("p03 integration build"),
          normalizer_sha256: sha256("p03 integration normalizer"),
          query_runner_sha256: sha256("p03 integration query runner"),
        },
        "implementation_sha256"
      );
      const p03ImplementationSha256 = p03Implementation.implementation_sha256;
      if (p03ImplementationSha256 === undefined) {
        throw new Error("P03 implementation fixture lacks its canonical digest");
      }
      const p03ImplementationRef = persistJson(setup.store, {
        runId: P03_RUN_ID,
        phase: p03Phase,
        kind: "sca-p03-implementation-identity",
        operationId: "p03-integration-implementation",
        schemaId: SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
        producer: SCA_P03_IMPLEMENTATION_PRODUCER,
        value: p03Implementation,
      });
      const runtimeTreeSha256 = sha256(
        canonicalJson({
          root_executable_ref: joernTool.executable_ref,
          runtime_package_refs: [joernTool.executable_ref],
          version: joernTool.version,
        })
      );
      const p03RuntimeIdentity = withScaP03Digest(
        {
          schema_id: SCA_P03_JOERN_RUNTIME_IDENTITY_V1_SCHEMA,
          schema_version: 1,
          runtime_id: "p03-integration-simulated-runtime",
          runtime_kind: "simulated_joern_test_runtime" as const,
          qualification_scope: "deterministic_test_only" as const,
          root_tool_id: joernTool.tool_id,
          root_executable_ref: joernTool.executable_ref,
          root_measurement_ref: joernTool.measurement_receipt_ref,
          toolchain_ref: core.frozen_refs.toolchain_ref,
          runtime_package_refs: [joernTool.executable_ref],
          runtime_tree_sha256: runtimeTreeSha256,
          joern_version: "simulated-test-seam-1",
          php_frontend_version: "simulated-php-1",
          javascript_frontend_version: "simulated-javascript-1",
          jvm_version: "not-executed-test-seam",
          php_runtime_version: "not-executed-test-seam",
          helper_version: "penny-p03-test-seam-1",
        },
        "identity_sha256"
      );
      const p03RuntimeIdentityRef = persistJson(setup.store, {
        runId: P03_RUN_ID,
        phase: p03Phase,
        kind: "sca-p03-joern-runtime-identity",
        operationId: "p03-integration-runtime-identity",
        schemaId: SCA_P03_JOERN_RUNTIME_IDENTITY_V1_SCHEMA,
        producer: SCA_P03_RUNTIME_IDENTITY_PRODUCER,
        value: p03RuntimeIdentity,
        upstreamRefs: [
          joernTool.executable_ref,
          joernTool.measurement_receipt_ref,
          core.frozen_refs.toolchain_ref,
        ],
      });
      const p03IsolationProfileSha256 = sha256(
        canonicalJson({ profile_id: "p03-integration-test-isolation", test_only: true })
      );
      const p03Isolation = {
        schema_id: SCA_P03_ISOLATION_EVIDENCE_V1_SCHEMA,
        schema_version: 1 as const,
        producer_id: SCA_P03_ISOLATION_PRODUCER,
        evidence_kind: "simulated_joern_test_seam" as const,
        runtime_kind: "simulated_joern_test_runtime" as const,
        qualification_scope: "deterministic_test_only" as const,
        qualified: false,
        simulation_label: "simulated_joern_test_seam" as const,
        runtime_id: p03RuntimeIdentity.runtime_id,
        isolation_id: "p03-integration-test-isolation",
        implementation_identity_sha256: p03ImplementationSha256,
        deployment_identity_sha256: sha256("p03 simulated deployment"),
        profile_id: "p03-integration-test-isolation-profile",
        profile_sha256: p03IsolationProfileSha256,
        runtime_tree_sha256: runtimeTreeSha256,
        qualified_at: "2026-09-20T00:05:00.000Z",
      };
      const p03IsolationRef = persistJson(setup.store, {
        runId: P03_RUN_ID,
        phase: p03Phase,
        kind: "sca-p03-isolation-evidence",
        operationId: "p03-integration-isolation",
        schemaId: SCA_P03_ISOLATION_EVIDENCE_V1_SCHEMA,
        producer: SCA_P03_ISOLATION_PRODUCER,
        value: p03Isolation,
        upstreamRefs: [p03RuntimeIdentityRef, p03ImplementationRef],
      });
      const p03RuntimePolicy = {
        schema_id: SCA_P03_RUNTIME_POLICY_V1_SCHEMA,
        schema_version: 1 as const,
        policy_id: "p03-integration-runtime-policy",
        staging_parent_sha256: sha256(path.join(runtimeRoot, "p03-staging")),
        source_posture: "read_only" as const,
        network_access: "denied" as const,
        package_acquisition: "forbidden" as const,
        target_execution: "forbidden" as const,
        shell_execution: "forbidden" as const,
        joern_server: "forbidden" as const,
        process_timeout_ms: 10_000,
        max_graph_bytes: 16_777_216,
        max_query_output_bytes: 16_777_216,
        max_query_items: 10_000,
        max_page_items: 100,
        max_pages_per_query: 10,
        max_ast_depth: 8,
        max_ast_nodes: 32,
        max_num_def: 10_000,
      };
      const p03RuntimePolicyRef = persistJson(setup.store, {
        runId: P03_RUN_ID,
        phase: p03Phase,
        kind: "sca-p03-runtime-policy",
        operationId: "p03-integration-runtime-policy",
        schemaId: SCA_P03_RUNTIME_POLICY_V1_SCHEMA,
        producer: SCA_P03_RUNTIME_POLICY_PRODUCER,
        value: p03RuntimePolicy,
        upstreamRefs: [p03IsolationRef, p03RuntimeIdentityRef],
      });
      const p03FidelityRequirements = [
        {
          requirement_id: "p03-language-php",
          dimension: "language" as const,
          subject: "php",
          partition: "php" as const,
          materiality: "material" as const,
          complement_evidence_ref: null,
        },
        {
          requirement_id: "p03-language-javascript",
          dimension: "language" as const,
          subject: "javascript",
          partition: "javascript_typescript" as const,
          materiality: "material" as const,
          complement_evidence_ref: null,
        },
        {
          requirement_id: "p03-language-typescript",
          dimension: "language" as const,
          subject: "typescript",
          partition: "javascript_typescript" as const,
          materiality: "material" as const,
          complement_evidence_ref: null,
        },
        ...(["php", "javascript_typescript"] as const).flatMap((partition) => [
          {
            requirement_id: `p03-framework-${partition}`,
            dimension: "framework" as const,
            subject: "fixture-web-framework",
            partition,
            materiality: "material" as const,
            complement_evidence_ref: null,
          },
          {
            requirement_id: `p03-edge-${partition}`,
            dimension: "edge_class" as const,
            subject: "call-and-dataflow",
            partition,
            materiality: "material" as const,
            complement_evidence_ref: null,
          },
          {
            requirement_id: `p03-surface-${partition}`,
            dimension: "surface" as const,
            subject: "entrypoint-and-trust-boundary",
            partition,
            materiality: "material" as const,
            complement_evidence_ref: null,
          },
        ]),
      ];
      const p03QualificationProfile = withScaP03Digest(
        {
          schema_id: SCA_P03_QUALIFICATION_PROFILE_V1_SCHEMA,
          schema_version: 1,
          profile_id: "p03-integration-qualification-profile",
          phase_id: "SCA-P03" as const,
          required_languages: ["php", "javascript", "typescript"] as const,
          required_query_ids: SCA_P03_QUERY_IDS,
          fidelity_requirements: p03FidelityRequirements,
          requires_live_runtime: true as const,
          criterion_ids: [
            "AC-P03.graph-construction",
            "AC-P03.baseline-queries",
            "AC-P03.recovery-cancellation",
            "AC-P03.zero-model-ordering",
          ] as const,
        },
        "profile_sha256"
      );
      const p03QualificationProfileRef = persistJson(setup.store, {
        runId: P03_RUN_ID,
        phase: p03Phase,
        kind: "sca-p03-qualification-profile",
        operationId: "p03-integration-qualification-profile",
        schemaId: SCA_P03_QUALIFICATION_PROFILE_V1_SCHEMA,
        producer: SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
        value: p03QualificationProfile,
      });
      const fixtureDefinitions = [
        [
          "p03-fixture-php",
          "php",
          "fixtures/example.php",
          "<?php function example() { return 1; }\n",
        ],
        [
          "p03-fixture-javascript",
          "javascript",
          "fixtures/example.js",
          "export function example() { return 1; }\n",
        ],
        [
          "p03-fixture-typescript",
          "typescript",
          "fixtures/example.ts",
          "export const example: number = 1;\n",
        ],
      ] as const;
      const p03FixtureRefs = fixtureDefinitions.map(
        ([fixtureId, language, fixturePath, content]) => {
          const bytes = Buffer.from(content, "utf8");
          return persistJson(setup.store, {
            runId: P03_RUN_ID,
            phase: p03Phase,
            kind: "sca-p03-qualification-fixture-content",
            operationId: fixtureId,
            schemaId: SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
            producer: SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
            value: {
              schema_id: SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
              schema_version: 1,
              fixture_id: fixtureId,
              language,
              path: fixturePath,
              encoding: "base64",
              content_base64: bytes.toString("base64"),
              byte_length: bytes.byteLength,
              content_sha256: sha256(bytes),
            },
          });
        }
      );
      const p03FixtureCorpus = withScaP03Digest(
        {
          schema_id: SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V1_SCHEMA,
          schema_version: 1,
          corpus_id: "p03-integration-fixture-corpus",
          fixture_content_refs: p03FixtureRefs,
          fixture_ids: fixtureDefinitions.map(([fixtureId]) => fixtureId),
          languages: ["php", "javascript", "typescript"] as const,
          expected_cases: (["php", "javascript", "typescript"] as const).flatMap((language) =>
            SCA_P03_QUERY_IDS.map((queryId) => ({
              case_id: `p03-${language}-${queryId.replaceAll(".", "-")}`,
              language,
              query_id: queryId,
              expected_observed_sha256: sha256(
                canonicalJson({
                  corpus_id: "p03-integration-fixture-corpus",
                  language,
                  query_id: queryId,
                  expected: "known-ground-truth",
                })
              ),
            }))
          ),
        },
        "corpus_sha256"
      );
      const p03FixtureCorpusRef = persistJson(setup.store, {
        runId: P03_RUN_ID,
        phase: p03Phase,
        kind: "sca-p03-qualification-fixture-corpus",
        operationId: "p03-integration-fixture-corpus",
        schemaId: SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V1_SCHEMA,
        producer: SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
        value: p03FixtureCorpus,
        upstreamRefs: p03FixtureRefs,
      });
      const p03ScriptRefs: ArtifactRef[] = [];
      const p03PlanRefs: ArtifactRef[] = [];
      const p03QueryReleaseId = "p03-integration-query-release-1";
      for (const [index, queryId] of SCA_P03_QUERY_IDS.entries()) {
        const plan = withScaP03Digest(
          {
            schema_id: SCA_P03_QUERY_PLAN_V1_SCHEMA,
            schema_version: 1,
            plan_id: `p03-plan-${String(index + 1).padStart(2, "0")}`,
            query_id: queryId,
            steps: [
              { kind: "select_node" as const, node_class: "method" as const },
              { kind: "project" as const, fields: ["node_id", "name", "file_name"] as const },
              { kind: "limit" as const, max_items: 10_000 },
            ],
            max_ast_depth: 8,
            max_ast_nodes: 32,
          },
          "plan_sha256"
        );
        p03PlanRefs.push(
          persistJson(setup.store, {
            runId: P03_RUN_ID,
            phase: p03Phase,
            kind: "sca-p03-query-plan",
            operationId: `p03-query-plan-${String(index + 1).padStart(2, "0")}`,
            schemaId: SCA_P03_QUERY_PLAN_V1_SCHEMA,
            producer: SCA_P03_QUERY_AUTHORITY_PRODUCER,
            value: plan,
          })
        );
        const scriptBytes = Buffer.from(
          canonicalJson({
            schema_id: "penny.sca-p03-query-binding.v1",
            schema_version: 1,
            release_id: p03QueryReleaseId,
            query_id: queryId,
            executor_id: queryId,
            plan_id: plan.plan_id,
            plan_sha256: plan.plan_sha256,
          }),
          "utf8"
        );
        p03ScriptRefs.push(
          persistJson(setup.store, {
            runId: P03_RUN_ID,
            phase: p03Phase,
            kind: "sca-p03-query-script",
            operationId: `p03-query-script-${String(index + 1).padStart(2, "0")}`,
            schemaId: SCA_P03_QUERY_SCRIPT_V1_SCHEMA,
            producer: SCA_P03_QUERY_AUTHORITY_PRODUCER,
            value: {
              schema_id: SCA_P03_QUERY_SCRIPT_V1_SCHEMA,
              schema_version: 1,
              query_id: queryId,
              script_id: `p03-script-${String(index + 1).padStart(2, "0")}`,
              language: "penny_typed_query_binding_v1",
              review_status: "host_reviewed_frozen",
              encoding: "base64",
              content_base64: scriptBytes.toString("base64"),
              byte_length: scriptBytes.byteLength,
              content_sha256: sha256(scriptBytes),
            },
          })
        );
      }
      const p03QuerySet = withScaP03Digest(
        {
          schema_id: SCA_P03_BASELINE_QUERY_SET_V1_SCHEMA,
          schema_version: 1,
          query_set_id: "p03-integration-baseline-query-set",
          release_id: p03QueryReleaseId,
          ordered_queries: SCA_P03_QUERY_IDS.map((queryId, index) => {
            const scriptRef = p03ScriptRefs[index];
            const planRef = p03PlanRefs[index];
            if (scriptRef === undefined || planRef === undefined) {
              throw new Error("P03 query authority fixture is incomplete");
            }
            return {
              query_id: queryId,
              script_ref: scriptRef,
              script_sha256: scriptRef.content_digest,
              plan_ref: planRef,
              plan_sha256: planRef.content_digest,
            };
          }),
          native_query_authorized: false as const,
        },
        "query_set_sha256"
      );
      const p03QuerySetRef = persistJson(setup.store, {
        runId: P03_RUN_ID,
        phase: p03Phase,
        kind: "sca-p03-baseline-query-set",
        operationId: "p03-integration-baseline-query-set",
        schemaId: SCA_P03_BASELINE_QUERY_SET_V1_SCHEMA,
        producer: SCA_P03_QUERY_AUTHORITY_PRODUCER,
        value: p03QuerySet,
        upstreamRefs: [...p03ScriptRefs, ...p03PlanRefs],
      });
      const p02EvidenceRefs = [
        p02Request.runtime_policy_ref,
        p02Request.isolation_evidence_ref,
        ...(p02Request.isolation_host_attestation_ref === null
          ? []
          : [p02Request.isolation_host_attestation_ref]),
        ...manifest.operations.flatMap((operation) => [
          operation.operation_request_ref,
          operation.operation_result_ref,
          operation.normalized_evidence_ref,
          operation.operation_receipt_ref,
        ]),
      ];
      const acceptedP01 = {
        request_ref: accepted.request_ref,
        obligation_ledger_ref: accepted.obligation_ledger_ref,
        campaign_manifest_core_ref: accepted.manifest_core_ref,
        admission_evidence_ref: accepted.admission_evidence_ref,
        p01_gate_ref: accepted.p01_gate_ref,
        campaign_manifest_ref: accepted.campaign_manifest_ref,
        frozen_refs: [...scaP02FrozenRefs(core)],
      };
      const acceptedP02 = {
        transition_ref: artifact(transitionRef),
        p02_request_ref: manifest.p02_request_ref,
        gate_ref: artifact(gateRef),
        m1_ref: artifact(m1Ref),
        coverage_matrix_ref: manifest.coverage_matrix_ref,
        evidence_manifest_ref: artifact(manifestRef),
        successor_ledger_ref: artifact(ledgerRef),
        evidence_refs: p02EvidenceRefs,
      };
      const p03RequestBase = {
        schema_id: SCA_P03_REQUEST_V2_SCHEMA,
        schema_version: 1 as const,
        tenant_id: setup.request.tenant_id,
        project_id: setup.request.project_id,
        run_id: P03_RUN_ID,
        phase_id: "SCA-P03" as const,
        accepted_p01: acceptedP01,
        accepted_p02: acceptedP02,
        source_snapshot_ref: core.frozen_refs.source_snapshot_ref,
        source_snapshot_sha256: core.frozen_refs.source_snapshot_ref.content_digest,
        runtime_policy_ref: p03RuntimePolicyRef,
        joern_runtime_identity_ref: p03RuntimeIdentityRef,
        isolation_evidence_ref: p03IsolationRef,
        host_isolation_attestation_ref: null,
        implementation_identity_ref: p03ImplementationRef,
        qualification_profile_ref: p03QualificationProfileRef,
        fixture_corpus_ref: p03FixtureCorpusRef,
        // Legacy P01→P03 integration data predates independent source review. These
        // placeholders satisfy the new request shape but cannot pass P03 admission;
        // migrate this fixture before treating it as positive P03 integration evidence.
        source_oracle_ref: p03FixtureCorpusRef,
        source_oracle_validation_ref: p03FixtureCorpusRef,
        fixture_content_refs: p03FixtureRefs,
        fidelity_complement_refs: [],
        baseline_query_set_ref: p03QuerySetRef,
        query_script_refs: p03ScriptRefs,
        query_plan_refs: p03PlanRefs,
        runtime_package_refs: [joernTool.executable_ref],
        requested_at: "2026-09-20T00:06:00.000Z",
      };
      const p03Request = validateScaP03RequestV2(
        withScaP03Digest(
          {
            ...p03RequestBase,
            p01_binding_sha256: scaP03P01BindingSha256(p03RequestBase),
            p02_binding_sha256: scaP03P02BindingSha256(p03RequestBase),
            p03_runtime_binding_sha256: scaP03RuntimeBindingSha256(p03RequestBase),
          },
          "request_sha256"
        )
      );
      const p03InputArtifacts = scaP03InputArtifacts(p03Request);
      const omittedEvidenceBase = {
        ...p03RequestBase,
        accepted_p02: {
          ...p03RequestBase.accepted_p02,
          evidence_refs: p02EvidenceRefs.slice(1),
        },
      };
      const omittedEvidenceRequest = validateScaP03RequestV2(
        withScaP03Digest(
          {
            ...omittedEvidenceBase,
            p01_binding_sha256: scaP03P01BindingSha256(omittedEvidenceBase),
            p02_binding_sha256: scaP03P02BindingSha256(omittedEvidenceBase),
            p03_runtime_binding_sha256: scaP03RuntimeBindingSha256(omittedEvidenceBase),
          },
          "request_sha256"
        )
      );
      expect(() =>
        admitScaP03Candidate({
          store: setup.store,
          request: omittedEvidenceRequest,
          input_artifacts: scaP03InputArtifacts(omittedEvidenceRequest),
          trusted_clock: () => trustedNow,
        })
      ).toThrow(/omits or substitutes exact P02 operation evidence/u);
      expect(
        admitScaP03Candidate({
          store: setup.store,
          request: p03Request,
          input_artifacts: p03InputArtifacts,
          trusted_clock: () => trustedNow,
        }).request
      ).toEqual(p03Request);

      recoveryLeaseAuthority.close();
      const p03Checkpointer = Checkpointer.provision(
        path.join(runtimeRoot, "p03-orchestration.db"),
        undefined,
        { projectId }
      );
      const p03Engine = new OrchestrationEngine(p03Checkpointer, {
        projectRoot: runtimeRoot,
        maxSteps: 30,
        receiptAuthority: TEST_RECEIPT_AUTHORITY,
        artifactRevisions: setup.store,
        artifactStore: setup.store,
        artifactReader: setup.store,
        playbookRegistration: SCA_P03_CANDIDATE_REGISTRATION,
        trustedClock: () => trustedNow,
      });
      const p03Executions: string[] = [];
      const simulatedRuntime = createScaP03SimulatedJoernRuntimeV1({
        runtime_id: p03RuntimeIdentity.runtime_id,
        isolation_id: p03Isolation.isolation_id,
        runtime_tree_sha256: runtimeTreeSha256,
        isolation_profile_sha256: p03Isolation.profile_sha256,
        implementation_identity_sha256: p03Isolation.implementation_identity_sha256,
        deployment_identity_sha256: p03Isolation.deployment_identity_sha256,
        onExecute(operation, partition) {
          p03Executions.push(`${operation}:${partition ?? "none"}`);
        },
      });
      const p03LeaseAuthority = new HostOperationLeaseAuthority(hostStateRoot);
      const p03Owner = new HostOperationRuntimeOwner({
        projectId,
        checkpointer: p03Checkpointer,
        artifacts: setup.store,
        leaseAuthority: p03LeaseAuthority,
        adapters: createScaP03OperationAdaptersV1({
          runtime: simulatedRuntime,
          now: () => trustedNow,
        }),
        resultCache: await FileHostOperationResultCache.provision(
          path.join(runtimeRoot, "p03-result-cache")
        ),
        useValidator: createScaP03ProductionUseValidatorV1(setup.store, {
          run_id: p03Request.run_id,
          accepted_p01: p03Request.accepted_p01,
          runtime_identity_ref: p03Request.joern_runtime_identity_ref,
          runtime_package_refs: p03Request.runtime_package_refs,
        }),
      });
      const p03Runner = new OrchestrationRunner(
        p03Engine,
        new WorkerExecutor(model, setup.store, {
          projectRoot: runtimeRoot,
          parallelConcurrency: 1,
          registration: SCA_P03_CANDIDATE_REGISTRATION,
        }),
        undefined,
        p03Owner
      );
      const p03Identity: RunIdentity = {
        schema_version: 2,
        run_id: P03_RUN_ID,
        session_id: "p03-real-integration-session",
        playbook: SCA_P03_CANDIDATE_PLAYBOOK_NAME,
        engine_owner: "typescript",
      };
      expect(
        p03Engine.handle({
          schema_version: 2,
          action: "start",
          identity: p03Identity,
          goal: "Exercise the actual inactive P03 candidate integration slice.",
          constraints: { p03_request: p03Request },
          project_root: runtimeRoot,
          trust_profile: "hardened-untrusted",
          input_artifacts: p03InputArtifacts,
        })
      ).toMatchObject({ action: "status", state_id: "sca_p03_qualifying_joern" });
      const p03Terminal = await p03Runner.runUntilBoundary(
        p03Engine.handle({ schema_version: 2, action: "recover", identity: p03Identity })
      );
      expect(p03Terminal).toMatchObject({
        action: "incomplete",
        status: "incomplete",
        result: {
          phase_id: "SCA-P03",
          boundary: "blocked_at_p03",
          gate_status: "blocked",
          transition_ref: null,
          campaign_terminal: false,
          release_eligible: false,
          model_calls: 0,
          model_turns: 0,
        },
      });
      expect(p03Executions).toEqual([
        "qualify_joern:none",
        "build_source_graph:php",
        "build_source_graph:javascript_typescript",
        "run_baseline_query_batch:php",
        "run_baseline_query_batch:javascript_typescript",
      ]);
      expect(p03Executions.filter((entry) => entry === "build_source_graph:php")).toHaveLength(1);
      expect(p03Checkpointer.hostOperationCallsForRun(P03_RUN_ID)).toHaveLength(5);
      expect(
        p03Checkpointer
          .hostOperationCallsForRun(P03_RUN_ID)
          .every((entry) => entry.lifecycle === "consumed")
      ).toBe(true);
      if (p03Terminal.action !== "incomplete" || !isRecord(p03Terminal.result)) {
        throw new Error("P03 integration terminal is not inspectable");
      }
      const gateRefValue = p03Terminal.result.gate_ref;
      const ledgerRefValue = p03Terminal.result.successor_ledger_ref;
      const coverageRefValue = p03Terminal.result.coverage_matrix_ref;
      const graphManifestRefValue = p03Terminal.result.graph_manifest_ref;
      const supportMatrixRefValue = p03Terminal.result.graph_support_matrix_ref;
      if (
        !isRecord(gateRefValue) ||
        !isRecord(ledgerRefValue) ||
        !isRecord(coverageRefValue) ||
        !isRecord(graphManifestRefValue) ||
        !isRecord(supportMatrixRefValue)
      ) {
        throw new Error("P03 integration terminal lacks exact artifact refs");
      }
      const p03GateRef = artifact(gateRefValue);
      const p03LedgerRef = artifact(ledgerRefValue);
      const p03CoverageRef = artifact(coverageRefValue);
      const p03GraphManifestRef = artifact(graphManifestRefValue);
      const p03Gate = validateScaP03GateV1(parsed(setup.store, p03GateRef));
      const p03Ledger = validateScaP03SuccessorLedgerV1(parsed(setup.store, p03LedgerRef));
      const p03Coverage = validateScaP03CoverageMatrixV1(parsed(setup.store, p03CoverageRef));
      const p03GraphManifest = validateScaP03GraphManifestV1(
        parsed(setup.store, p03GraphManifestRef)
      );
      expect(p03Gate.blocker_codes).toContain("isolation_unqualified");
      expect(p03GraphManifest.complete).toBe(true);
      const supportMatrix = validateScaP03GraphSupportMatrixV2(
        parsed(setup.store, artifact(supportMatrixRefValue))
      );
      expect(supportMatrix.complete).toBe(false);
      expect(
        supportMatrix.entries.every(
          (entry) =>
            entry.qualification_scope === "deterministic_test_only" &&
            entry.support === "partial" &&
            entry.blocker_codes.includes("qualification_failed")
        )
      ).toBe(true);
      expect(
        supportMatrix.entries.every((entry) =>
          entry.evidence_refs.some((ref) => ref.kind === "sca-p03-qualification-evidence")
        )
      ).toBe(true);
      expect(
        p03Coverage.entries
          .filter((entry) => entry.status !== "complete")
          .map((entry) => entry.coverage_id)
      ).toEqual([]);
      expect(p03Ledger.dispositions.map((entry) => entry.obligation_id)).toEqual([
        "SCA-OBL-OUTPUT-SOURCE-BOUND-GRAPH",
        "SCA-OBL-OUTPUT-BASELINE-GRAPH-QUERIES",
        "SCA-OBL-OUTPUT-GRAPH-CANDIDATES",
        "SCA-OBL-P03-ACCEPTANCE",
      ]);
      expect(
        p03Terminal.artifacts.some(
          (ref) => ref.content_schema?.schema_id === SCA_P03_SUCCESSOR_LEDGER_V1_SCHEMA
        )
      ).toBe(true);
      expect(p03Terminal.artifacts.some((ref) => ref.kind === "sca-p03-p04-transition")).toBe(
        false
      );
      expect(dispatch).toEqual({ provider: 0, session: 0, model: 0 });
      p03LeaseAuthority.close();
      p03Checkpointer.close();
      checkpointer.close();
    },
    420_000
  );
});

describe("inactive host P01 campaign issuer", () => {
  function hostProbe() {
    const counts = { model: 0, scanner: 0, application: 0 };
    return { counts, probe: { snapshot: () => ({ ...counts }) } };
  }
  it("issues six exact outputs and adopts replay without new versions", () => {
    const setup = fixture("issuer-success");
    const host = hostProbe();
    const issue = () =>
      issueScaP01CampaignGate({
        store: setup.store,
        request: setup.request,
        dispatchProbe: host.probe,
      });
    const first = issue();
    expect(resultRefs(issue())).toEqual(resultRefs(first));
    for (const kind of CANDIDATE_OPERATIONS)
      expect(setup.store.lastVersion(RUN_ID, CANDIDATE_PHASE, null, kind, kind)).toBe(1);
    expect(parsed(setup.store, first.p01_gate_ref)).toMatchObject({
      status: "passed",
      phase_id: "SCA-P01",
    });
    expect(parsed(setup.store, first.campaign_manifest_ref)).toMatchObject({
      campaign_status: "admitted",
    });
    expect(host.counts).toEqual({ model: 0, scanner: 0, application: 0 });
  });
  it("refuses a partial cohort rather than repairing it", () => {
    const setup = fixture("issuer-partial");
    const controller = new AbortController();
    expect(() =>
      issueScaP01CampaignGate({
        store: setup.store,
        request: setup.request,
        dispatchProbe: hostProbe().probe,
        signal: controller.signal,
        onBoundary: (event) => {
          if (event.stage === "before_persist" && event.ordinal === 2) controller.abort();
        },
      })
    ).toThrow();
    expect(campaignCandidateRef(setup.store, CANDIDATE_OPERATIONS[0])).not.toBeNull();
    expect(() =>
      issueScaP01CampaignGate({
        store: setup.store,
        request: setup.request,
        dispatchProbe: hostProbe().probe,
      })
    ).toThrow("partial P01 cohort");
    expect(campaignCandidateRef(setup.store, CANDIDATE_OPERATIONS[1])).toBeNull();
  });
  it("refuses missing, malformed, changing, or nonzero host dispatch observations", () => {
    for (const label of ["unavailable", "nonzero", "changed"] as const) {
      const setup = fixture(`issuer-${label}`);
      const host = hostProbe();
      let reads = 0;
      const probe = {
        snapshot: () => {
          reads++;
          if (label === "unavailable") throw new Error("observer offline");
          if (label === "nonzero" || (label === "changed" && reads > 1)) host.counts.scanner++;
          return { ...host.counts };
        },
      };
      expect(() =>
        issueScaP01CampaignGate({
          store: setup.store,
          request: setup.request,
          dispatchProbe: probe,
        })
      ).toThrow();
      expectNoCandidateWrites(setup.store);
    }
  });
  it("refuses cancellation, wrong qualification, and changed input bytes", () => {
    const setup = fixture("issuer-input-refusal");
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      issueScaP01CampaignGate({
        store: setup.store,
        request: setup.request,
        dispatchProbe: hostProbe().probe,
        signal: controller.signal,
      })
    ).toThrow();
    expect(() =>
      issueScaP01CampaignGate({
        store: setup.store,
        request: { ...setup.request, implementation_revision: "wrong-revision" },
        dispatchProbe: hostProbe().probe,
      })
    ).toThrow();
    const alteredStore: ArtifactHostStore = {
      persist: (value) => setup.store.persist(value),
      select: (ref) => setup.store.select(ref),
      metadata: (ref) => setup.store.metadata(ref),
      refById: (id) => setup.store.refById(id),
      refFor: (...args) => setup.store.refFor(...args),
      lastVersion: (...args) => setup.store.lastVersion(...args),
      readById: (id) =>
        id === setup.request.source.snapshot_ref.artifact_id
          ? Buffer.from("changed")
          : setup.store.readById(id),
    };
    expect(() =>
      issueScaP01CampaignGate({
        store: alteredStore,
        request: setup.request,
        dispatchProbe: hostProbe().probe,
      })
    ).toThrow();
    expectNoCandidateWrites(setup.store);
  });
});

describe("P01 issuer current-qualification and output integrity", () => {
  it("accepts a passed qualification with measured unchanged nonzero host counters", () => {
    const setup = fixture("issuer-current-qualification");
    const counters = { model: 4, scanner: 7, application: 2 };
    let observations = 0;
    const result = issueScaP01CampaignGate({
      store: setup.store,
      request: setup.request,
      dispatchProbe: {
        snapshot: () => {
          observations++;
          return { ...counters };
        },
      },
    });
    expect(setup.qualification.status).toBe("PASS");
    expect(result.p01_gate_ref.run_id).toBe(setup.request.run_id);
    expect(observations).toBeGreaterThan(6);
    expect(counters).toEqual({ model: 4, scanner: 7, application: 2 });
  });
  it("refuses changed replay operands and substituted output bytes", () => {
    const setup = fixture("issuer-output-integrity");
    const probe = { snapshot: () => ({ model: 0, scanner: 0, application: 0 }) };
    issueScaP01CampaignGate({ store: setup.store, request: setup.request, dispatchProbe: probe });
    expect(() =>
      issueScaP01CampaignGate({
        store: setup.store,
        request: { ...setup.request, report_namespace: "other" },
        dispatchProbe: probe,
      })
    ).toThrow();
    const view: ArtifactHostStore = {
      persist: (value) => setup.store.persist(value),
      select: (ref) => setup.store.select(ref),
      metadata: (ref) => setup.store.metadata(ref),
      refById: (id) => setup.store.refById(id),
      refFor: (...args) => setup.store.refFor(...args),
      lastVersion: (...args) => setup.store.lastVersion(...args),
      readById: (id) =>
        id === campaignCandidateRef(setup.store, "sca-p01-candidate-gate")?.artifact_id
          ? Buffer.from("substituted")
          : setup.store.readById(id),
    };
    expect(() =>
      issueScaP01CampaignGate({ store: view, request: setup.request, dispatchProbe: probe })
    ).toThrow();
  });
});

describe("P01 issuer postwrite refusal", () => {
  it("does not return a gate if dispatch changes after the sixth write", () => {
    const setup = fixture("issuer-postwrite-dispatch");
    const counts = { model: 0, scanner: 0, application: 0 };
    const probe = { snapshot: () => ({ ...counts }) };
    const store: ArtifactHostStore = {
      persist: (input) => {
        const ref = setup.store.persist(input);
        if (input.metadata.kind === "sca-p01-candidate-campaign-manifest") counts.application++;
        return ref;
      },
      select: (ref) => setup.store.select(ref),
      metadata: (ref) => setup.store.metadata(ref),
      refById: (id) => setup.store.refById(id),
      readById: (id) => setup.store.readById(id),
      refFor: (...args) => setup.store.refFor(...args),
      lastVersion: (...args) => setup.store.lastVersion(...args),
    };
    expect(() =>
      issueScaP01CampaignGate({ store, request: setup.request, dispatchProbe: probe })
    ).toThrow();
    expect(counts.application).toBe(1);
  });
});

describe("acceptance-bound P01 variant capture lineage", () => {
  it("P02 admits only the exact frozen root and validates every accepted transitive member offline", () => {
    const setup = withVariantCapture(fixture("p02-capture-closure"));
    const accepted = admitCandidate({ store: setup.store, request: setup.request });
    const request = p02CaptureAdmissionFixture(setup, accepted),
      capture = captureOf(setup);
    const inputs = scaP02InputArtifacts(request);
    expect(
      admitScaP02Candidate({ store: setup.store, request, input_artifacts: inputs }).request
    ).toEqual(request);
    expect(inputs.artifacts.map((binding) => binding.ref)).toContainEqual(capture.ref);
    const omitted = {
      ...request,
      accepted_p01: {
        ...request.accepted_p01,
        frozen_refs: request.accepted_p01.frozen_refs.filter(
          (ref) => ref.artifact_id !== capture.ref.artifact_id
        ),
      },
    };
    expect(() =>
      admitScaP02Candidate({
        store: setup.store,
        request: omitted,
        input_artifacts: scaP02InputArtifacts(omitted),
      })
    ).toThrow(/every exact P01 frozen/u);
    for (const member of capture.all_refs) {
      const unavailable = artifactStoreView(setup.store, {
        refById: (id) => (id === member.artifact_id ? undefined : setup.store.refById(id)),
      });
      expect(() =>
        admitScaP02Candidate({ store: unavailable, request, input_artifacts: inputs })
      ).toThrow(/absent|variant capture/u);
    }
    const first = capture.manifest.entries[0];
    if (first === undefined) throw new Error("missing capture member");
    const upstreamDrift = artifactStoreView(setup.store, {
      metadata: (ref) =>
        ref.artifact_id === first.provenance_ref.artifact_id
          ? { ...setup.store.metadata(ref), upstream_refs: [] }
          : setup.store.metadata(ref),
    });
    expect(() =>
      admitScaP02Candidate({ store: upstreamDrift, request, input_artifacts: inputs })
    ).toThrow(/upstream/u);
  });
  it("refuses same-run cross-entry provenance and member mutation before any manifest write", () => {
    const setup = fixture("capture-same-run-crosslink");
    const left = { label: "left", ...capturedVariant(setup.store, "left", "left", "", "shared") };
    const right = {
      label: "right",
      ...capturedVariant(setup.store, "right", "right", "", "shared"),
    };
    const manifest = {
      schema_id: SCA_P01_VARIANT_CAPTURE_MANIFEST_V1_SCHEMA,
      schema_version: 1,
      tenant_id: setup.request.tenant_id,
      project_id: setup.request.project_id,
      run_id: setup.request.run_id,
      implementation_revision: setup.request.implementation_revision,
      baseline_snapshot_ref: setup.request.source.snapshot_ref,
      baseline_provenance_ref: setup.request.source.provenance_ref,
      entries: [left, right],
    };
    let writes = 0;
    const store = artifactStoreView(setup.store, {
      persist: (input) => {
        writes++;
        return setup.store.persist(input);
      },
    });
    expect(() =>
      buildScaP01VariantCaptureManifestV1({
        store,
        manifest: {
          ...manifest,
          entries: [
            { ...left, provenance_ref: right.provenance_ref },
            { ...right, provenance_ref: left.provenance_ref },
          ],
        },
      })
    ).toThrow(/provenance/u);
    expect(writes).toBe(0);
    let reads = 0;
    const mutated = artifactStoreView(setup.store, {
      persist: (input) => store.persist(input),
      readById: (id) => {
        if (id === left.provenance_ref.artifact_id && ++reads === 2)
          return Buffer.from("mutated on builder prewrite reread");
        return setup.store.readById(id);
      },
    });
    expect(() => buildScaP01VariantCaptureManifestV1({ store: mutated, manifest })).toThrow(
      /drifted/u
    );
    expect(reads).toBe(2);
    const baseline = validateScaCampaignSourceSnapshotV2(
      parsed(setup.store, setup.request.source.snapshot_ref)
    );
    const baselineBytesDrift = artifactStoreView(setup.store, {
      persist: (input) => store.persist(input),
      readById: (id) =>
        id === baseline.file_manifest_ref.artifact_id
          ? Buffer.from("mutated baseline manifest before capture publication")
          : setup.store.readById(id),
    });
    expect(() =>
      buildScaP01VariantCaptureManifestV1({ store: baselineBytesDrift, manifest })
    ).toThrow(/drifted/u);
    const baselineUpstreamDrift = artifactStoreView(setup.store, {
      persist: (input) => store.persist(input),
      metadata: (ref) =>
        ref.artifact_id === setup.request.source.snapshot_ref.artifact_id
          ? { ...setup.store.metadata(ref), upstream_refs: [] }
          : setup.store.metadata(ref),
    });
    expect(() =>
      buildScaP01VariantCaptureManifestV1({ store: baselineUpstreamDrift, manifest })
    ).toThrow(/upstream/u);
    expect(writes).toBe(0);
    expectNoCandidateWrites(setup.store);
  });

  it("rejects malformed persisted roots during admission before any candidate write", () => {
    const setup = withVariantCapture(fixture("capture-malformed-admission"));
    const capture = captureOf(setup),
      first = capture.manifest.entries[0];
    if (first === undefined) throw new Error("missing capture entry");
    for (const value of [
      { ...capture.manifest, entries: [first, first] },
      { ...capture.manifest, entries: [...capture.manifest.entries].reverse() },
      { ...capture.manifest, schema_version: 2 },
      { ...capture.manifest, unexpected: true },
      { ...capture.manifest, tenant_id: "other-tenant" },
      { ...capture.manifest, baseline_provenance_ref: first.provenance_ref },
    ]) {
      const text = canonicalJson(value),
        metadata = setup.store.metadata(capture.ref);
      const ref = previewArtifactRef({ metadata, content: text });
      let writes = 0;
      const store = artifactStoreView(setup.store, {
        refById: (id) => (id === ref.artifact_id ? ref : setup.store.refById(id)),
        readById: (id) => (id === ref.artifact_id ? Buffer.from(text) : setup.store.readById(id)),
        persist: (input) => {
          writes++;
          return setup.store.persist(input);
        },
      });
      expect(() =>
        admitCandidate({
          store,
          request: {
            ...setup.request,
            source: { ...setup.request.source, variant_capture_manifest_ref: ref },
          },
        })
      ).toThrow(/variant capture/u);
      expect(writes).toBe(0);
      expectNoCandidateWrites(setup.store);
    }
  });

  it("accepts the full capture closure through request/core/evidence/gate and exact replay", () => {
    const setup = withVariantCapture(fixture("capture-success"));
    const capture = captureOf(setup);
    const accepted = issueScaP01CampaignGate({
      store: setup.store,
      request: setup.request,
      dispatchProbe: ZERO_DISPATCH_PROBE,
    });
    validateFixtureContext(setup, accepted);
    const core = validateScaCampaignManifestCoreV1(parsed(setup.store, accepted.manifest_core_ref));
    const evidence = validateScaP01AdmissionEvidenceV1(
      parsed(setup.store, accepted.admission_evidence_ref)
    );
    expect(core.frozen_refs.variant_capture_manifest_ref).toEqual(capture.ref);
    expect(scaP01AdmissionRequestRefs(setup.request)).toContainEqual(capture.ref);
    expect(scaP02FrozenRefs(core)).toContainEqual(capture.ref);
    for (const ref of capture.all_refs) expect(evidence.evidence_refs).toContainEqual(ref);
    expect(
      readScaP01VariantCaptureV1({
        store: setup.store,
        manifest_ref: capture.ref,
        context: setup.request,
        evidence_refs: evidence.evidence_refs,
      }).manifest
    ).toEqual(capture.manifest);
    expect(
      issueScaP01CampaignGate({
        store: setup.store,
        request: setup.request,
        dispatchProbe: ZERO_DISPATCH_PROBE,
      })
    ).toEqual(accepted);
    const rootlessEvidence = {
      ...evidence,
      evidence_refs: evidence.evidence_refs.filter(
        (ref) => ref.artifact_id !== capture.ref.artifact_id
      ),
    };
    expect(() =>
      validateFixtureContext(setup, accepted, { admission_evidence: rootlessEvidence })
    ).toThrow(/omits/u);
    for (const member of capture.all_refs)
      expect(() =>
        readScaP01VariantCaptureV1({
          store: setup.store,
          manifest_ref: capture.ref,
          context: setup.request,
          evidence_refs: evidence.evidence_refs.filter(
            (ref) => ref.artifact_id !== member.artifact_id
          ),
        })
      ).toThrow(/not in accepted/u);
  });

  it("keeps legacy absence, exact bytes, input-ref order and replay unchanged", () => {
    const setup = fixture("legacy-capture-absence");
    const requestBytes = canonicalJson(setup.request);
    expect(canonicalJson(validateScaP01AdmissionRequestV3(setup.request))).toBe(requestBytes);
    expect(Object.hasOwn(setup.request.source, "variant_capture_manifest_ref")).toBe(false);
    expect(scaP01AdmissionRequestRefs(setup.request)).toHaveLength(13);
    const accepted = admitCandidate({ store: setup.store, request: setup.request });
    const core = validateScaCampaignManifestCoreV1(parsed(setup.store, accepted.manifest_core_ref));
    expect(Object.hasOwn(core.frozen_refs, "variant_capture_manifest_ref")).toBe(false);
    expect(scaP02FrozenRefs(core)).toHaveLength(29);
    const legacyP02 = p02CaptureAdmissionFixture(setup, accepted);
    expect(
      admitScaP02Candidate({
        store: setup.store,
        request: legacyP02,
        input_artifacts: scaP02InputArtifacts(legacyP02),
      }).request
    ).toEqual(legacyP02);
    expect(setup.store.readById(accepted.request_ref.artifact_id).toString()).toBe(requestBytes);
    // Measured from the exact pre-change source on this generic fixture, not live evidence.
    expect(sha256(canonicalJson(accepted))).toBe(
      "c4a5404bb4fd501b551d141edc6a251dfdec134371c566df120080c04b81eb29"
    );
    const before = currentCandidateRefs(setup.store).map((ref) =>
      setup.store.readById(ref.artifact_id)
    );
    expect(before.map((bytes) => sha256(bytes))).toEqual([
      "7f00b7dce6c1e4cabe33a461026df9dfec8fa62ed8ccb1af3f6fe8d1d1816407",
      "9d9405ea69fdba4f80d1d80d8e05f678ded60b3df99edb558037abbe12a93bd2",
      "e9396029fc161d1d1c06b2d9730d52210839b2dce950aaeec4d6f800bae2c785",
      "13f683c2275e5d7552427ee3681fc4c2caeca9682c6a6746116b5a6165febbeb",
      "feef19c0c3f35cbc52bf845276125118436f2ef20bd547255512be8b1b8c2764",
      "8379e9b6e1e1fc97a0d43197c43b6f4827bcb50b684f12a873ca21cef2403ffc",
    ]);
    expect(admitCandidate({ store: setup.store, request: setup.request })).toEqual(accepted);
    expect(
      currentCandidateRefs(setup.store).map((ref) => setup.store.readById(ref.artifact_id))
    ).toEqual(before);
  });

  it("rejects both request/core presence mismatches and changed root refs", () => {
    const setup = withVariantCapture(fixture("capture-presence"));
    const accepted = admitCandidate({ store: setup.store, request: setup.request });
    const core = validateScaCampaignManifestCoreV1(parsed(setup.store, accepted.manifest_core_ref));
    const { variant_capture_manifest_ref: _root, ...absentSource } = setup.request.source;
    expect(() =>
      validateFixtureContext(setup, accepted, {
        request: { ...setup.request, source: absentSource },
      })
    ).toThrow(/freeze/u);
    const { variant_capture_manifest_ref: _frozen, ...absentFrozen } = core.frozen_refs;
    const { binding_sha256: _binding, ...unsigned } = core;
    const absentUnsigned = { ...unsigned, frozen_refs: absentFrozen };
    const absentCore = { ...absentUnsigned, binding_sha256: sha256(canonicalJson(absentUnsigned)) };
    expect(() =>
      validateFixtureContext(setup, accepted, {
        core: absentCore,
        frozen_material_refs: absentFrozen,
      })
    ).toThrow(/freeze/u);
    expect(() =>
      readScaP01VariantCaptureV1({
        store: setup.store,
        manifest_ref: captureOf(setup).ref,
        context: { ...setup.request, implementation_revision: "different-revision" },
      })
    ).toThrow(/revision/u);
  });

  it("rejects duplicate/unordered labels, role reuse, cross-entry material and provenance before manifest publication", () => {
    const setup = withVariantCapture(fixture("capture-negatives"));
    const capture = captureOf(setup),
      [first, second] = capture.manifest.entries;
    if (first === undefined || second === undefined) throw new Error("sparse capture");
    let writes = 0;
    const store = artifactStoreView(setup.store, {
      persist: (input) => {
        writes++;
        return setup.store.persist(input);
      },
    });
    for (const manifest of [
      { ...capture.manifest, entries: [first, first] },
      { ...capture.manifest, entries: [second, first] },
      { ...capture.manifest, entries: [] },
      {
        ...capture.manifest,
        entries: [{ ...first, snapshot_ref: setup.request.source.snapshot_ref }, second],
      },
      {
        ...capture.manifest,
        entries: [
          { ...first, custody_ref: second.custody_ref },
          { ...second, custody_ref: first.custody_ref },
        ],
      },
      {
        ...capture.manifest,
        entries: [
          { ...first, provenance_ref: second.provenance_ref },
          { ...second, provenance_ref: first.provenance_ref },
        ],
      },
      { ...capture.manifest, implementation_revision: "" },
    ])
      expect(() => buildScaP01VariantCaptureManifestV1({ store, manifest })).toThrow();
    expect(writes).toBe(0);
    expectNoCandidateWrites(setup.store);
    expect(
      scaP01VariantCaptureManifestRefs(validateScaP01VariantCaptureManifestV1(capture.manifest))
    ).toHaveLength(10);
  });

  it("refuses an internally consistent same-run unadmitted replacement even under identical labels", () => {
    const setup = withVariantCapture(fixture("capture-substitution"));
    const capture = captureOf(setup);
    const accepted = admitCandidate({ store: setup.store, request: setup.request });
    const member = capture.manifest.entries[0];
    if (member === undefined) throw new Error("missing capture member");
    const replacement = capturedVariant(
      setup.store,
      member.label,
      "unadmitted replacement bytes",
      "-replacement"
    );
    expect(replacement.snapshot_ref.run_id).toBe(member.snapshot_ref.run_id);
    const substitutedManifest = {
      ...capture.manifest,
      entries: capture.manifest.entries.map((entry) =>
        entry.label === member.label ? { label: entry.label, ...replacement } : entry
      ),
    };
    const text = canonicalJson(substitutedManifest);
    const metadata = {
      ...setup.store.metadata(capture.ref),
      upstream_refs: [...scaP01VariantCaptureManifestRefs(substitutedManifest)],
    };
    const replacementRoot = previewArtifactRef({ metadata, content: text });
    const substitutedRequest = {
      ...setup.request,
      source: { ...setup.request.source, variant_capture_manifest_ref: replacementRoot },
    };
    const view = artifactStoreView(setup.store, {
      refById: (id) =>
        id === replacementRoot.artifact_id ? replacementRoot : setup.store.refById(id),
      readById: (id) =>
        id === replacementRoot.artifact_id ? Buffer.from(text) : setup.store.readById(id),
      metadata: (ref) =>
        ref.artifact_id === replacementRoot.artifact_id ? metadata : setup.store.metadata(ref),
    });
    expect(
      readScaP01VariantCaptureV1({
        store: view,
        manifest_ref: replacementRoot,
        context: substitutedRequest,
      }).manifest
    ).toEqual(substitutedManifest);
    const evidence = validateScaP01AdmissionEvidenceV1(
      parsed(setup.store, accepted.admission_evidence_ref)
    );
    expect(() =>
      readScaP01VariantCaptureV1({
        store: view,
        manifest_ref: replacementRoot,
        context: substitutedRequest,
        evidence_refs: evidence.evidence_refs,
      })
    ).toThrow(/not in accepted/u);
    expect(() => validateFixtureContext(setup, accepted, { request: substitutedRequest })).toThrow(
      /freeze/u
    );
  });

  it("rejects bytes, root upstream and member provenance metadata mutations at prewrite with zero candidate writes", () => {
    for (const mode of [
      "root-bytes",
      "member-bytes",
      "root-upstream",
      "member-upstream",
    ] as const) {
      const setup = withVariantCapture(fixture(`capture-prewrite-${mode}`));
      const capture = captureOf(setup),
        first = capture.manifest.entries[0];
      if (first === undefined) throw new Error("missing capture member");
      const target = mode.startsWith("root") ? capture.ref : first.provenance_ref;
      let mutated = false,
        writes = 0;
      const store = artifactStoreView(setup.store, {
        readById: (id) =>
          mutated && mode.endsWith("bytes") && id === target.artifact_id
            ? Buffer.from("mutated")
            : setup.store.readById(id),
        metadata: (ref) =>
          mutated && mode.endsWith("upstream") && ref.artifact_id === target.artifact_id
            ? { ...setup.store.metadata(ref), upstream_refs: [] }
            : setup.store.metadata(ref),
        persist: (input) => {
          writes++;
          return setup.store.persist(input);
        },
      });
      expect(() =>
        admitCandidate({
          store,
          request: setup.request,
          options: {
            onBoundary: (event) => {
              if (event.stage === "before_persist" && event.ordinal === 1) mutated = true;
            },
          },
        })
      ).toThrow();
      expect(writes).toBe(0);
      expectNoCandidateWrites(setup.store);
    }
  });

  it("issuer postwrite validation refuses variant upstream mutation", () => {
    const setup = withVariantCapture(fixture("capture-postwrite"));
    const capture = captureOf(setup),
      member = capture.manifest.entries[0];
    if (member === undefined) throw new Error("missing capture member");
    let mutated = false;
    const store = artifactStoreView(setup.store, {
      metadata: (ref) =>
        mutated && ref.artifact_id === member.provenance_ref.artifact_id
          ? { ...setup.store.metadata(ref), upstream_refs: [] }
          : setup.store.metadata(ref),
      persist: (input) => {
        const ref = setup.store.persist(input);
        if (input.metadata.kind === "sca-p01-candidate-campaign-manifest") mutated = true;
        return ref;
      },
    });
    expect(() =>
      issueScaP01CampaignGate({ store, request: setup.request, dispatchProbe: ZERO_DISPATCH_PROBE })
    ).toThrow(/upstream/u);
  });
});
