import { previewArtifactRef, type ArtifactHostStore } from "../artifact-store.js";
import { canonicalJson, sha256 } from "../canonical-json.js";
import type { ArtifactRef, InputArtifacts } from "../contracts.js";
import type { HostOperationUseValidatorV1 } from "../host-operations/owner.js";
import {
  SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
  SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
  SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
  SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
  validateScaCampaignManifestCoreV1,
  validateScaCampaignSourceSnapshotV2,
  validateScaP01AdmissionRequestV3,
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
} from "./p01-contracts.js";
import {
  ScaP03P01RuntimeRootError,
  validateScaP03P01RuntimeIdentityRootV1,
  type ScaP03AcceptedP01BindingsV1,
} from "./p03-p01-runtime-root.js";
import {
  admitScaP02Candidate,
  createScaP03TransitionAdmissionV1,
  scaP02InputArtifacts,
} from "./p02-admission.js";
import {
  SCA_M1_RECORD_V2_SCHEMA,
  SCA_P02_ANALYZER_IDS,
  SCA_P02_CANDIDATE_PRODUCER,
  SCA_P02_CANDIDATE_REQUEST_KIND,
  SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
  SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA,
  SCA_P02_GATE_V1_SCHEMA,
  SCA_P02_P03_TRANSITION_V1_SCHEMA,
  SCA_P02_REQUEST_V1_SCHEMA,
  SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA,
  validateScaM1RecordV2,
  validateScaP02CoverageMatrixV1,
  validateScaP02EvidenceManifestV1,
  validateScaP02GateV1,
  validateScaP02RequestV1,
  validateScaP02SuccessorLedgerV1,
  type ScaP02EvidenceManifestV1,
  type ScaP02P03TransitionV1,
  type ScaP02RequestV1,
} from "./p02-contracts.js";
import { requireScaP03AcceptedP02Qualification } from "./p03-p02-qualification-guard.js";
import {
  SCA_P03_BASELINE_QUERY_SET_V2_SCHEMA,
  SCA_P03_CANDIDATE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_MAX_ORACLE_BYTES,
  parseSourceOracleBytes,
  parseSourceOracleValidationReceiptBytes,
  parseSourceOracleReviewV1Bytes,
  projectSourceOracleCases,
  assertSourceOracleReceiptCorrespondence,
  SCA_P03_FIDELITY_COMPLEMENT_V2_SCHEMA,
  SCA_P03_HOST_ATTESTATION_V1_SCHEMA,
  SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
  SCA_P03_IMPLEMENTATION_PRODUCER,
  SCA_P03_ISOLATION_EVIDENCE_V1_SCHEMA,
  SCA_P03_ISOLATION_PRODUCER,
  SCA_P03_JOERN_RUNTIME_IDENTITY_V1_SCHEMA,
  SCA_P03_OBLIGATION_IDS,
  SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
  SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
  SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V2_SCHEMA,
  SCA_P03_QUALIFICATION_PROFILE_V2_SCHEMA,
  SCA_P03_QUERY_AUTHORITY_PRODUCER,
  SCA_P03_QUERY_IDS,
  SCA_P03_QUERY_PLAN_V2_SCHEMA,
  SCA_P03_QUERY_SCRIPT_V2_SCHEMA,
  SCA_P03_RUNTIME_IDENTITY_PRODUCER,
  SCA_P03_RUNTIME_POLICY_PRODUCER,
  SCA_P03_RUNTIME_POLICY_V1_SCHEMA,
  SCA_P03_REQUEST_V2_SCHEMA,
  scaP03P01BindingSha256,
  scaP03P02BindingSha256,
  scaP03RuntimeBindingSha256,
  validateScaP03QueryBindingAgainstPlanV2,
  validateScaP03BaselineQuerySetV2,
  validateScaP03FidelityComplementEvidenceV2,
  validateScaP03HostIsolationAttestationV1,
  validateScaP03ImplementationIdentityV1,
  validateScaP03IsolationEvidenceV1,
  validateScaP03JoernRuntimeIdentityV1,
  validateScaP03OperationRequestV1,
  validateScaP03QualificationFixtureContentV1,
  validateScaP03QualificationFixtureCorpusV2,
  validateScaP03QualificationProfileV2,
  validateScaP03QueryPlanV2,
  validateScaP03QueryScriptV2,
  validateScaP03RequestV2,
  validateScaP03RuntimePolicyV1,
  type ScaP03BaselineQuerySetV2,
  type ScaP03ImplementationIdentityV1,
  type ScaP03IsolationEvidenceV1,
  type ScaP03JoernRuntimeIdentityV1,
  type ScaP03QualificationFixtureCorpusV2,
  type ScaP03QualificationProfileV2,
  type ScaP03RequestV2,
  type ScaP03RuntimePolicyV1,
} from "./p03-contracts.js";

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const P01_CANDIDATE_PRODUCER = "host:sca-p01-candidate";

export interface ScaP03AdmissionResultV1 {
  readonly request: ScaP03RequestV2;
  readonly p02_request: ScaP02RequestV1;
  readonly runtime_policy: ScaP03RuntimePolicyV1;
  readonly runtime_identity: ScaP03JoernRuntimeIdentityV1;
  readonly isolation_evidence: ScaP03IsolationEvidenceV1;
  readonly implementation_identity: ScaP03ImplementationIdentityV1;
  readonly qualification_profile: ScaP03QualificationProfileV2;
  readonly fixture_corpus: ScaP03QualificationFixtureCorpusV2;
  readonly baseline_query_set: ScaP03BaselineQuerySetV2;
}

export class ScaP03AdmissionError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "missing_ref"
      | "ref_mismatch"
      | "artifact_contract_mismatch"
      | "invalid_p02_binding"
      | "invalid_p01_binding"
      | "invalid_runtime_binding"
      | "invalid_input_set",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaP03AdmissionError";
  }
}

function fail(code: ScaP03AdmissionError["code"], message: string, cause?: unknown): never {
  throw new ScaP03AdmissionError(code, message, cause === undefined ? undefined : { cause });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readExact(store: ArtifactHostStore, ref: ArtifactRef, label: string): Buffer {
  const stored = store.refById(ref.artifact_id);
  if (stored === undefined) fail("missing_ref", `${label} is absent`);
  if (!same(stored, ref)) fail("ref_mismatch", `${label} exact ref drifted`);
  let metadata;
  let bytes: Buffer;
  try {
    metadata = store.metadata(ref);
    bytes = store.readById(ref.artifact_id);
  } catch (error) {
    fail("ref_mismatch", `${label} could not be read exactly`, error);
  }
  const preview = previewArtifactRef({ metadata, content: bytes });
  if (
    !same(preview, ref) ||
    bytes.byteLength !== ref.byte_length ||
    sha256(bytes) !== ref.content_digest
  ) {
    fail("ref_mismatch", `${label} bytes or metadata drifted`);
  }
  return bytes;
}

function readJson(store: ArtifactHostStore, ref: ArtifactRef, label: string): unknown {
  const bytes = readExact(store, ref, label);
  if (bytes.byteLength > MAX_JSON_BYTES) {
    fail("artifact_contract_mismatch", `${label} exceeds the JSON byte limit`);
  }
  const text = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail("artifact_contract_mismatch", `${label} is not JSON`, error);
  }
  if (canonicalJson(value) !== text) {
    fail("artifact_contract_mismatch", `${label} is not canonical JSON`);
  }
  return value;
}

function assertContract(
  ref: ArtifactRef,
  expected: {
    readonly kind: string;
    readonly schemaId: string;
    readonly schemaVersion: number;
    readonly producer?: string;
    readonly mediaType?: string;
  },
  label: string
): void {
  if (
    ref.kind !== expected.kind ||
    ref.content_schema?.schema_id !== expected.schemaId ||
    ref.content_schema.schema_version !== expected.schemaVersion ||
    ref.media_type !== (expected.mediaType ?? "application/json") ||
    (expected.producer !== undefined && ref.producer !== expected.producer)
  ) {
    fail("artifact_contract_mismatch", `${label} has an unexpected artifact contract`);
  }
}

function exactInputRefs(request: ScaP03RequestV2): readonly ArtifactRef[] {
  return [
    request.accepted_p02.transition_ref,
    request.accepted_p02.p02_request_ref,
    request.accepted_p02.gate_ref,
    request.accepted_p02.qualification_definition_ref,
    request.accepted_p02.qualification_gate_ref,
    request.accepted_p02.m1_ref,
    request.accepted_p02.coverage_matrix_ref,
    request.accepted_p02.evidence_manifest_ref,
    request.accepted_p02.successor_ledger_ref,
    ...request.accepted_p02.evidence_refs,
    request.accepted_p01.request_ref,
    request.accepted_p01.obligation_ledger_ref,
    request.accepted_p01.campaign_manifest_core_ref,
    request.accepted_p01.admission_evidence_ref,
    request.accepted_p01.p01_gate_ref,
    request.accepted_p01.campaign_manifest_ref,
    ...request.accepted_p01.frozen_refs,
    request.source_snapshot_ref,
    request.runtime_policy_ref,
    request.joern_runtime_identity_ref,
    request.isolation_evidence_ref,
    ...(request.host_isolation_attestation_ref === null
      ? []
      : [request.host_isolation_attestation_ref]),
    request.implementation_identity_ref,
    request.qualification_profile_ref,
    request.fixture_corpus_ref,
    request.source_oracle_ref,
    request.source_oracle_validation_ref,
    ...request.fixture_content_refs,
    ...request.fidelity_complement_refs,
    request.baseline_query_set_ref,
    ...request.query_script_refs,
    ...request.query_plan_refs,
    ...request.runtime_package_refs,
    ...(request.bootstrap_verification === undefined
      ? []
      : [request.bootstrap_verification.sealed_inputs_ref]),
  ];
}

export function scaP03InputArtifacts(request: ScaP03RequestV2): InputArtifacts {
  const seen = new Set<string>();
  const artifacts: { slot: string; ref: ArtifactRef }[] = [];
  for (const ref of exactInputRefs(request)) {
    const key = canonicalJson(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    artifacts.push({ slot: `sca_p03_input_${String(artifacts.length).padStart(4, "0")}`, ref });
  }
  return { schema_version: 2, artifacts };
}

function assertExactInputSet(request: ScaP03RequestV2, inputArtifacts: InputArtifacts): void {
  const expected = new Set(exactInputRefs(request).map((ref) => canonicalJson(ref)));
  const observed = inputArtifacts.artifacts.map((binding) => canonicalJson(binding.ref));
  if (
    inputArtifacts.schema_version !== 2 ||
    observed.length !== expected.size ||
    new Set(observed).size !== observed.length ||
    observed.some((key) => !expected.has(key))
  ) {
    fail("invalid_input_set", "P03 input artifacts must equal the exact unique admitted set");
  }
}

export function assertScaP03AuthorityContracts(request: ScaP03RequestV2): void {
  const contracts = [
    [
      request.runtime_policy_ref,
      "sca-p03-runtime-policy",
      SCA_P03_RUNTIME_POLICY_V1_SCHEMA,
      SCA_P03_RUNTIME_POLICY_PRODUCER,
      "P03 runtime policy",
    ],
    [
      request.joern_runtime_identity_ref,
      "sca-p03-joern-runtime-identity",
      SCA_P03_JOERN_RUNTIME_IDENTITY_V1_SCHEMA,
      SCA_P03_RUNTIME_IDENTITY_PRODUCER,
      "P03 Joern runtime identity",
    ],
    [
      request.isolation_evidence_ref,
      "sca-p03-isolation-evidence",
      SCA_P03_ISOLATION_EVIDENCE_V1_SCHEMA,
      SCA_P03_ISOLATION_PRODUCER,
      "P03 isolation evidence",
    ],
    [
      request.implementation_identity_ref,
      "sca-p03-implementation-identity",
      SCA_P03_IMPLEMENTATION_IDENTITY_V1_SCHEMA,
      SCA_P03_IMPLEMENTATION_PRODUCER,
      "P03 implementation identity",
    ],
    [
      request.qualification_profile_ref,
      "sca-p03-qualification-profile",
      SCA_P03_QUALIFICATION_PROFILE_V2_SCHEMA,
      SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
      "P03 qualification profile",
    ],
    [
      request.fixture_corpus_ref,
      "sca-p03-qualification-fixture-corpus",
      SCA_P03_QUALIFICATION_FIXTURE_CORPUS_V2_SCHEMA,
      SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
      "P03 qualification fixture corpus",
    ],
    [
      request.source_oracle_ref,
      "sca-p03-source-oracle",
      SCA_P03_SOURCE_ORACLE_SCHEMA,
      SCA_P03_SOURCE_ORACLE_PRODUCER,
      "P03 source oracle",
    ],
    [
      request.source_oracle_validation_ref,
      "sca-p03-source-oracle-validation",
      SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
      SCA_P03_SOURCE_ORACLE_VALIDATOR,
      "P03 oracle validation",
    ],
    [
      request.baseline_query_set_ref,
      "sca-p03-baseline-query-set",
      SCA_P03_BASELINE_QUERY_SET_V2_SCHEMA,
      SCA_P03_QUERY_AUTHORITY_PRODUCER,
      "P03 baseline query set",
    ],
  ] as const;
  for (const [ref, kind, schemaId, producer, label] of contracts) {
    assertContract(
      ref,
      { kind, schemaId, schemaVersion: schemaId.endsWith(".v2") ? 2 : 1, producer },
      label
    );
  }
  if (request.host_isolation_attestation_ref !== null) {
    assertContract(
      request.host_isolation_attestation_ref,
      {
        kind: "sca-p03-host-isolation-attestation",
        schemaId: SCA_P03_HOST_ATTESTATION_V1_SCHEMA,
        schemaVersion: 1,
        producer: SCA_P03_ISOLATION_PRODUCER,
      },
      "P03 host isolation attestation"
    );
  }
  for (const [index, ref] of request.fixture_content_refs.entries()) {
    assertContract(
      ref,
      {
        kind: "sca-p03-qualification-fixture-content",
        schemaId: SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
        schemaVersion: 1,
        producer: SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
      },
      `P03 qualification fixture content ${index}`
    );
  }
  for (const [index, ref] of request.fidelity_complement_refs.entries()) {
    assertContract(
      ref,
      {
        kind: "sca-p03-fidelity-complement-evidence",
        schemaId: SCA_P03_FIDELITY_COMPLEMENT_V2_SCHEMA,
        schemaVersion: 2,
        producer: SCA_P03_QUALIFICATION_AUTHORITY_PRODUCER,
      },
      `P03 fidelity complement evidence ${index}`
    );
  }
  for (const [index, ref] of request.query_script_refs.entries()) {
    assertContract(
      ref,
      {
        kind: "sca-p03-query-script",
        schemaId: SCA_P03_QUERY_SCRIPT_V2_SCHEMA,
        schemaVersion: 2,
        producer: SCA_P03_QUERY_AUTHORITY_PRODUCER,
      },
      `P03 query script ${index}`
    );
  }
  for (const [index, ref] of request.query_plan_refs.entries()) {
    assertContract(
      ref,
      {
        kind: "sca-p03-query-plan",
        schemaId: SCA_P03_QUERY_PLAN_V2_SCHEMA,
        schemaVersion: 2,
        producer: SCA_P03_QUERY_AUTHORITY_PRODUCER,
      },
      `P03 query plan ${index}`
    );
  }
}

function assertP02Contracts(request: ScaP03RequestV2): void {
  const p02 = request.accepted_p02;
  const contracts = [
    [
      p02.transition_ref,
      "sca-p02-p03-transition",
      SCA_P02_P03_TRANSITION_V1_SCHEMA,
      1,
      "P02 transition",
    ],
    [
      p02.p02_request_ref,
      SCA_P02_CANDIDATE_REQUEST_KIND,
      SCA_P02_REQUEST_V1_SCHEMA,
      1,
      "P02 request",
    ],
    [p02.gate_ref, "sca-p02-gate", SCA_P02_GATE_V1_SCHEMA, 1, "P02 gate"],
    [p02.m1_ref, "sca-m1-record", SCA_M1_RECORD_V2_SCHEMA, 2, "P02 M1"],
    [
      p02.coverage_matrix_ref,
      "sca-p02-coverage-matrix",
      SCA_P02_COVERAGE_MATRIX_V1_SCHEMA,
      1,
      "P02 coverage",
    ],
    [
      p02.evidence_manifest_ref,
      "sca-p02-evidence-manifest",
      SCA_P02_EVIDENCE_MANIFEST_V1_SCHEMA,
      1,
      "P02 evidence manifest",
    ],
    [
      p02.successor_ledger_ref,
      "sca-p02-successor-obligation-ledger",
      SCA_P02_SUCCESSOR_LEDGER_V1_SCHEMA,
      1,
      "P02 successor ledger",
    ],
  ] as const;
  for (const [ref, kind, schemaId, schemaVersion, label] of contracts) {
    assertContract(
      ref,
      { kind, schemaId, schemaVersion, producer: SCA_P02_CANDIDATE_PRODUCER },
      label
    );
  }
  for (const [ref, kind, schemaId, schemaVersion] of [
    [
      p02.qualification_definition_ref,
      "sca-p02-v3-definition-snapshot",
      "penny.sca-p02-v3-definition-snapshot.v1",
      1,
    ],
    [p02.qualification_gate_ref, "sca-p02-phase-gate-v3", "penny.sca-phase-gate-record.v3", 3],
  ] as const) {
    assertContract(
      ref,
      { kind, schemaId, schemaVersion, producer: "host:sca-p02-qualification-authority" },
      "P02 qualification"
    );
  }
}

function assertP01Bindings(request: ScaP03RequestV2, p02Request: ScaP02RequestV1): void {
  if (!same(request.accepted_p01, p02Request.accepted_p01)) {
    fail("invalid_p01_binding", "P03 accepted P01 lineage differs from the exact P02 lineage");
  }
  assertContract(
    request.accepted_p01.request_ref,
    {
      kind: "sca-p01-candidate-request",
      schemaId: SCA_P01_ADMISSION_REQUEST_V3_SCHEMA,
      schemaVersion: 3,
      producer: P01_CANDIDATE_PRODUCER,
    },
    "P01 request"
  );
}

function assertLiveAttestationBinding(input: {
  readonly request: ScaP03RequestV2;
  readonly runtime: ScaP03JoernRuntimeIdentityV1;
  readonly isolation: ScaP03IsolationEvidenceV1;
  readonly store: ArtifactHostStore;
}): void {
  const live = input.isolation.qualification_scope === "live_qualified";
  if (
    live !== (input.request.host_isolation_attestation_ref !== null) ||
    input.runtime.qualification_scope !== input.isolation.qualification_scope ||
    input.runtime.runtime_kind !== input.isolation.runtime_kind ||
    input.runtime.runtime_id !== input.isolation.runtime_id ||
    input.runtime.runtime_tree_sha256 !== input.isolation.runtime_tree_sha256
  ) {
    fail("invalid_runtime_binding", "P03 runtime/isolation qualification bindings disagree");
  }
  if (!live || input.request.host_isolation_attestation_ref === null) return;
  const attestation = validateScaP03HostIsolationAttestationV1(
    readJson(input.store, input.request.host_isolation_attestation_ref, "P03 host attestation")
  );
  if (
    attestation.attestation_id !== input.isolation.host_attestation_id ||
    input.request.host_isolation_attestation_ref.content_digest !==
      input.isolation.host_attestation_sha256 ||
    !same(input.request.host_isolation_attestation_ref, input.isolation.host_attestation_ref) ||
    attestation.runtime_id !== input.runtime.runtime_id ||
    attestation.runtime_tree_sha256 !== input.runtime.runtime_tree_sha256 ||
    attestation.isolation_id !== input.isolation.isolation_id ||
    attestation.profile_sha256 !== input.isolation.profile_sha256
  ) {
    fail("invalid_runtime_binding", "P03 live host isolation attestation is stale or misbound");
  }
}

function assertRuntimeRootedInP01(input: {
  readonly store: ArtifactHostStore;
  readonly request: ScaP03RequestV2;
  readonly runtime: ScaP03JoernRuntimeIdentityV1;
}): void {
  try {
    validateScaP03P01RuntimeIdentityRootV1({
      store: input.store,
      accepted_p01: input.request.accepted_p01,
      runtime: input.runtime,
    });
  } catch (error) {
    fail(
      error instanceof ScaP03P01RuntimeRootError && error.code === "invalid_p01_cohort"
        ? "invalid_p01_binding"
        : "invalid_runtime_binding",
      error instanceof Error ? error.message : "P03 P01 runtime root is invalid",
      error
    );
  }
  for (const [index, ref] of input.request.runtime_package_refs.entries()) {
    readExact(input.store, ref, `P03 runtime package ${index}`);
  }
  if (!same(input.runtime.runtime_package_refs, input.request.runtime_package_refs)) {
    fail("invalid_runtime_binding", "P03 runtime package closure is incomplete or substituted");
  }
}

function assertSourceBinding(input: {
  readonly store: ArtifactHostStore;
  readonly request: ScaP03RequestV2;
}): void {
  const core = validateScaCampaignManifestCoreV1(
    readJson(
      input.store,
      input.request.accepted_p01.campaign_manifest_core_ref,
      "P01 manifest core"
    )
  );
  if (!same(input.request.source_snapshot_ref, core.frozen_refs.source_snapshot_ref)) {
    fail("invalid_p01_binding", "P03 source snapshot differs from the P01 frozen source");
  }
  const snapshot = validateScaCampaignSourceSnapshotV2(
    readJson(input.store, core.frozen_refs.source_snapshot_ref, "P01 source snapshot")
  );
  const manifest = validateScaP01SourceFileManifestV1(
    readJson(input.store, core.frozen_refs.source_file_manifest_ref, "P01 source manifest")
  );
  const custody = validateScaP01SourceCustodyCorpusV1(
    readJson(input.store, core.frozen_refs.source_custody_ref, "P01 source custody")
  );
  validateScaP01SourceMaterialV1({
    snapshot,
    file_manifest_ref: core.frozen_refs.source_file_manifest_ref,
    file_manifest: manifest,
    custody_ref: core.frozen_refs.source_custody_ref,
    custody,
  });
  assertContract(
    core.frozen_refs.source_snapshot_ref,
    {
      kind: "source-snapshot",
      schemaId: SCA_CAMPAIGN_SOURCE_SNAPSHOT_V2_SCHEMA,
      schemaVersion: 2,
    },
    "P01 source snapshot"
  );
  assertContract(
    core.frozen_refs.source_file_manifest_ref,
    {
      kind: "sca-p01-source-file-manifest",
      schemaId: SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
      schemaVersion: 1,
    },
    "P01 source manifest"
  );
  assertContract(
    core.frozen_refs.source_custody_ref,
    {
      kind: "sca-p01-source-custody-corpus",
      schemaId: SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
      schemaVersion: 1,
    },
    "P01 source custody"
  );
  if (
    snapshot.tree_sha256 !== manifest.tree_sha256 ||
    snapshot.tree_sha256 !== custody.tree_sha256
  ) {
    fail("invalid_p01_binding", "P03 P01 source material has inconsistent tree digests");
  }
}

/** Revalidate exact accepted P01 source and Joern roots for one persisted P03 request. */
export function validateScaP03ProductionRuntimeUseV1(input: {
  readonly store: ArtifactHostStore;
  readonly request_ref: ArtifactRef;
}): ScaP03RequestV2 {
  assertContract(
    input.request_ref,
    {
      kind: "sca-p03-candidate-request",
      schemaId: SCA_P03_REQUEST_V2_SCHEMA,
      schemaVersion: 2,
      producer: SCA_P03_CANDIDATE_PRODUCER,
    },
    "P03 persisted request"
  );
  const request = validateScaP03RequestV2(
    readJson(input.store, input.request_ref, "P03 persisted request")
  );
  if (request.run_id !== input.request_ref.run_id) {
    fail("invalid_request", "P03 persisted request belongs to another run");
  }
  const runtime = validateScaP03JoernRuntimeIdentityV1(
    readJson(input.store, request.joern_runtime_identity_ref, "P03 runtime identity")
  );
  assertRuntimeRootedInP01({ store: input.store, request, runtime });
  assertSourceBinding({ store: input.store, request });
  return request;
}

export interface ScaP03ProductionUseAuthorityV1 {
  readonly run_id: string;
  readonly accepted_p01: ScaP03AcceptedP01BindingsV1;
  readonly runtime_identity_ref: ArtifactRef;
  readonly runtime_package_refs: readonly ArtifactRef[];
}

/** Host-owner hook: validation runs before every journal/cache/recovery fast path. */
export function createScaP03ProductionUseValidatorV1(
  store: ArtifactHostStore,
  authority: ScaP03ProductionUseAuthorityV1
): HostOperationUseValidatorV1 {
  const selected = structuredClone(authority);
  return Object.freeze({
    validateUse(input: Parameters<HostOperationUseValidatorV1["validateUse"]>[0]) {
      let value: unknown;
      const text = Buffer.from(input.request_bytes).toString("utf8");
      try {
        value = JSON.parse(text);
      } catch (error) {
        fail("invalid_request", "P03 operation request is not JSON", error);
      }
      if (canonicalJson(value) !== text || !isUnknownRecord(value)) {
        fail("invalid_request", "P03 operation request is not canonical JSON");
      }
      const operationKind = value.operation_kind;
      if (
        operationKind !== "qualify_joern" &&
        operationKind !== "build_source_graph" &&
        operationKind !== "run_baseline_query_batch"
      ) {
        fail("invalid_request", "P03 operation kind is invalid");
      }
      const operation = validateScaP03OperationRequestV1(operationKind, value);
      const binding = input.directive.input_artifacts.artifacts.find(
        (entry) => entry.slot === "p03_request"
      );
      if (binding === undefined || !same(binding.ref, operation.p03_request_ref)) {
        fail("invalid_input_set", "P03 operation omits its exact persisted request");
      }
      const request = validateScaP03ProductionRuntimeUseV1({
        store,
        request_ref: binding.ref,
      });
      if (
        request.run_id !== selected.run_id ||
        !same(request.accepted_p01, selected.accepted_p01) ||
        !same(request.joern_runtime_identity_ref, selected.runtime_identity_ref) ||
        !same(request.runtime_package_refs, selected.runtime_package_refs)
      ) {
        fail("invalid_input_set", "P03 operation differs from host-selected production authority");
      }
    },
  });
}

function assertQueryAuthority(input: {
  readonly store: ArtifactHostStore;
  readonly request: ScaP03RequestV2;
  readonly querySet: ScaP03BaselineQuerySetV2;
}): void {
  const scriptRefs = input.querySet.ordered_queries.map((entry) => entry.script_ref);
  const planRefs = input.querySet.ordered_queries.map((entry) => entry.plan_ref);
  if (
    !same(scriptRefs, input.request.query_script_refs) ||
    !same(planRefs, input.request.query_plan_refs)
  ) {
    fail("invalid_runtime_binding", "P03 request query authority closure is substituted");
  }
  for (const [index, query] of input.querySet.ordered_queries.entries()) {
    const scriptRef = input.request.query_script_refs[index];
    const planRef = input.request.query_plan_refs[index];
    if (scriptRef === undefined || planRef === undefined) {
      fail("invalid_runtime_binding", "P03 query authority closure is incomplete");
    }
    const script = validateScaP03QueryScriptV2(
      readJson(input.store, scriptRef, `P03 query script ${index}`)
    );
    const plan = validateScaP03QueryPlanV2(
      readJson(input.store, planRef, `P03 query plan ${index}`)
    );
    try {
      validateScaP03QueryBindingAgainstPlanV2({
        release_id: input.querySet.release_id,
        query_id: query.query_id,
        script,
        plan,
      });
    } catch {
      fail("invalid_runtime_binding", `P03 query authority '${query.query_id}' is misbound`);
    }
    if (
      query.query_id !== SCA_P03_QUERY_IDS[index] ||
      scriptRef.content_digest !== query.script_sha256 ||
      planRef.content_digest !== query.plan_sha256
    ) {
      fail("invalid_runtime_binding", `P03 query authority '${query.query_id}' is misbound`);
    }
  }
}

function assertQualificationCorpus(input: {
  readonly store: ArtifactHostStore;
  readonly request: Pick<
    ScaP03RequestV2,
    | "run_id"
    | "source_oracle_ref"
    | "source_oracle_validation_ref"
    | "fixture_corpus_ref"
    | "fixture_content_refs"
  >;
  readonly corpus: ScaP03QualificationFixtureCorpusV2;
}): void {
  if (!same(input.corpus.fixture_content_refs, input.request.fixture_content_refs)) {
    fail("invalid_runtime_binding", "P03 qualification fixture closure is substituted");
  }
  const fixtures = input.request.fixture_content_refs.map((ref, index) =>
    validateScaP03QualificationFixtureContentV1(
      readJson(input.store, ref, `P03 fixture content ${index}`)
    )
  );
  if (
    !same(
      fixtures.map((fixture) => fixture.fixture_id),
      input.corpus.fixture_ids
    )
  ) {
    fail("invalid_runtime_binding", "P03 fixture IDs differ from the corpus manifest");
  }
  for (const language of ["php", "javascript", "typescript"] as const) {
    if (!fixtures.some((fixture) => fixture.language === language)) {
      fail("invalid_runtime_binding", `P03 qualification corpus lacks ${language}`);
    }
  }
}

/** Host receipt verification only. The service must independently replay native Tree-sitter semantics at runtime. */
export function assertSourceOracleAuthority(input: {
  readonly store: ArtifactHostStore;
  readonly request: Pick<
    ScaP03RequestV2,
    | "run_id"
    | "source_oracle_ref"
    | "source_oracle_validation_ref"
    | "fixture_corpus_ref"
    | "fixture_content_refs"
  >;
  readonly corpus: ScaP03QualificationFixtureCorpusV2;
}): void {
  const { store, request, corpus } = input;
  const oracleRef = request.source_oracle_ref;
  const receiptRef = request.source_oracle_validation_ref;
  assertContract(
    oracleRef,
    {
      kind: "sca-p03-source-oracle",
      schemaId: SCA_P03_SOURCE_ORACLE_SCHEMA,
      schemaVersion: 2,
      producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
    },
    "P03 oracle"
  );
  assertContract(
    receiptRef,
    {
      kind: "sca-p03-source-oracle-validation",
      schemaId: SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
      schemaVersion: 1,
      producer: SCA_P03_SOURCE_ORACLE_VALIDATOR,
    },
    "P03 oracle receipt"
  );
  if (
    !same(request.fixture_content_refs, corpus.fixture_content_refs) ||
    [request.fixture_corpus_ref, ...request.fixture_content_refs].some(
      (ref) => ref.run_id !== request.run_id || ref.phase !== "SCA-P03" || ref.version !== 1
    )
  )
    fail("invalid_runtime_binding", "P03 oracle fixture cohort or revision drift");
  const reviewRef = store
    .metadata(receiptRef)
    .upstream_refs.find((ref) => ref.kind === "sca-p03-source-oracle-review");
  if (
    oracleRef.version !== 1 ||
    receiptRef.version !== 1 ||
    oracleRef.byte_length > SCA_P03_MAX_ORACLE_BYTES ||
    receiptRef.byte_length > SCA_P03_MAX_ORACLE_BYTES ||
    oracleRef.run_id !== request.run_id ||
    receiptRef.run_id !== request.run_id ||
    oracleRef.phase !== "SCA-P03" ||
    receiptRef.phase !== "SCA-P03" ||
    reviewRef === undefined ||
    reviewRef.version !== 1 ||
    reviewRef.byte_length > SCA_P03_MAX_ORACLE_BYTES ||
    reviewRef.run_id !== request.run_id ||
    reviewRef.phase !== "SCA-P03" ||
    reviewRef.kind !== "sca-p03-source-oracle-review" ||
    reviewRef.content_schema?.schema_id !== SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA ||
    reviewRef.content_schema.schema_version !== 1 ||
    reviewRef.producer !== SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER ||
    reviewRef.media_type !== "application/json" ||
    reviewRef.artifact_id === oracleRef.artifact_id ||
    reviewRef.artifact_id === receiptRef.artifact_id
  )
    fail("invalid_runtime_binding", "P03 oracle authority revision or review drift");
  const oracle = parseSourceOracleBytes(readExact(store, oracleRef, "P03 oracle"));
  const receipt = parseSourceOracleValidationReceiptBytes(
    readExact(store, receiptRef, "P03 oracle receipt")
  );
  const review = parseSourceOracleReviewV1Bytes(
    readExact(store, reviewRef, "P03 independent oracle review")
  );
  if (
    review.oracle_sha256 !== oracle.oracle_sha256 ||
    review.parser_identity_sha256 !== oracle.parser.identity_sha256 ||
    !same(
      review.fixture_content_sha256,
      (["php", "javascript", "typescript"] as const).map(
        (language) =>
          oracle.fixtures.find((fixture) => fixture.language === language)?.content_sha256
      )
    ) ||
    !same(review.expected_cases, projectSourceOracleCases(oracle)) ||
    !same(review.expected_cases, corpus.expected_cases)
  )
    fail("invalid_runtime_binding", "P03 independent review does not authorize source selectors");
  const fixtures = request.fixture_content_refs.map((ref, index) => {
    const content = validateScaP03QualificationFixtureContentV1(
      readJson(store, ref, `P03 oracle fixture ${index}`)
    );
    return {
      ref,
      fixture_id: content.fixture_id,
      language: content.language,
      path: content.path,
      content_sha256: content.content_sha256,
      bytes: Buffer.from(content.content_base64, "base64"),
    };
  });
  const required = [
    oracleRef,
    request.fixture_corpus_ref,
    ...request.fixture_content_refs,
    reviewRef,
  ].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  const actual = store.metadata(receiptRef).upstream_refs;
  if (
    actual.length !== required.length ||
    !same(actual, required) ||
    new Set(required.map((ref) => ref.artifact_id)).size !== required.length ||
    !same(receipt.oracle_ref, oracleRef) ||
    !same(receipt.review_ref, reviewRef)
  )
    fail("invalid_runtime_binding", "P03 oracle validation provenance closure drift");
  try {
    assertSourceOracleReceiptCorrespondence({
      oracle,
      oracle_ref: oracleRef,
      receipt,
      review_ref: reviewRef,
      corpus,
      corpus_ref: request.fixture_corpus_ref,
      fixtures,
    });
  } catch (error) {
    fail("invalid_runtime_binding", "P03 oracle validation correspondence drift", error);
  }
}

function assertFidelityComplements(input: {
  readonly store: ArtifactHostStore;
  readonly request: ScaP03RequestV2;
  readonly profile: ScaP03QualificationProfileV2;
}): void {
  const expectedRefs = input.profile.fidelity_requirements.flatMap((requirement) =>
    requirement.complement_evidence_ref === null ? [] : [requirement.complement_evidence_ref]
  );
  if (!same(expectedRefs, input.request.fidelity_complement_refs)) {
    fail("invalid_runtime_binding", "P03 fidelity complement closure is substituted");
  }
  for (const requirement of input.profile.fidelity_requirements) {
    if (requirement.complement_evidence_ref === null) continue;
    const complement = validateScaP03FidelityComplementEvidenceV2(
      readJson(
        input.store,
        requirement.complement_evidence_ref,
        `P03 fidelity complement '${requirement.requirement_id}'`
      )
    );
    if (
      complement.profile_id !== input.profile.profile_id ||
      complement.requirement_id !== requirement.requirement_id ||
      complement.partition !== requirement.partition
    ) {
      fail(
        "invalid_runtime_binding",
        `P03 fidelity complement '${requirement.requirement_id}' is misbound`
      );
    }
  }
}

export function validateScaP03AcceptedP02CohortV1(input: {
  readonly request: Pick<ScaP03RequestV2, "accepted_p01" | "accepted_p02">;
  readonly transition: ScaP02P03TransitionV1;
  readonly p02_request: Pick<
    ScaP02RequestV1,
    | "run_id"
    | "runtime_policy_ref"
    | "isolation_evidence_ref"
    | "isolation_host_attestation_ref"
    | "accepted_p01"
  >;
  readonly evidence_manifest: Pick<
    ScaP02EvidenceManifestV1,
    | "p02_request_ref"
    | "runtime_policy_ref"
    | "isolation_evidence_ref"
    | "isolation_host_attestation_ref"
    | "p01_request_ref"
    | "p01_campaign_manifest_core_ref"
    | "p01_campaign_manifest_ref"
    | "p01_predecessor_ledger_ref"
    | "successor_ledger_ref"
    | "coverage_matrix_ref"
  >;
}): void {
  const expectedTransition = {
    run_id: input.p02_request.run_id,
    p02_request_ref: input.request.accepted_p02.p02_request_ref,
    runtime_policy_ref: input.p02_request.runtime_policy_ref,
    isolation_evidence_ref: input.p02_request.isolation_evidence_ref,
    isolation_host_attestation_ref: input.p02_request.isolation_host_attestation_ref,
    p01_request_ref: input.request.accepted_p01.request_ref,
    p01_campaign_manifest_core_ref: input.request.accepted_p01.campaign_manifest_core_ref,
    p01_campaign_manifest_ref: input.request.accepted_p01.campaign_manifest_ref,
    successor_ledger_ref: input.request.accepted_p02.successor_ledger_ref,
    evidence_manifest_ref: input.request.accepted_p02.evidence_manifest_ref,
    p02_gate_ref: input.request.accepted_p02.gate_ref,
    coverage_matrix_ref: input.request.accepted_p02.coverage_matrix_ref,
    m1_ref: input.request.accepted_p02.m1_ref,
  };
  const observedTransition = {
    run_id: input.transition.run_id,
    p02_request_ref: input.transition.p02_request_ref,
    runtime_policy_ref: input.transition.runtime_policy_ref,
    isolation_evidence_ref: input.transition.isolation_evidence_ref,
    isolation_host_attestation_ref: input.transition.isolation_host_attestation_ref,
    p01_request_ref: input.transition.p01_request_ref,
    p01_campaign_manifest_core_ref: input.transition.p01_campaign_manifest_core_ref,
    p01_campaign_manifest_ref: input.transition.p01_campaign_manifest_ref,
    successor_ledger_ref: input.transition.successor_ledger_ref,
    evidence_manifest_ref: input.transition.evidence_manifest_ref,
    p02_gate_ref: input.transition.p02_gate_ref,
    coverage_matrix_ref: input.transition.coverage_matrix_ref,
    m1_ref: input.transition.m1_ref,
  };
  if (
    !same(observedTransition, expectedTransition) ||
    !same(input.p02_request.accepted_p01, input.request.accepted_p01) ||
    !same(input.evidence_manifest.p02_request_ref, input.request.accepted_p02.p02_request_ref) ||
    !same(input.evidence_manifest.runtime_policy_ref, input.p02_request.runtime_policy_ref) ||
    !same(
      input.evidence_manifest.isolation_evidence_ref,
      input.p02_request.isolation_evidence_ref
    ) ||
    !same(
      input.evidence_manifest.isolation_host_attestation_ref,
      input.p02_request.isolation_host_attestation_ref
    ) ||
    !same(input.evidence_manifest.p01_request_ref, input.request.accepted_p01.request_ref) ||
    !same(
      input.evidence_manifest.p01_campaign_manifest_core_ref,
      input.request.accepted_p01.campaign_manifest_core_ref
    ) ||
    !same(
      input.evidence_manifest.p01_campaign_manifest_ref,
      input.request.accepted_p01.campaign_manifest_ref
    ) ||
    !same(
      input.evidence_manifest.p01_predecessor_ledger_ref,
      input.request.accepted_p01.obligation_ledger_ref
    ) ||
    !same(
      input.evidence_manifest.successor_ledger_ref,
      input.request.accepted_p02.successor_ledger_ref
    ) ||
    !same(
      input.evidence_manifest.coverage_matrix_ref,
      input.request.accepted_p02.coverage_matrix_ref
    )
  ) {
    fail("invalid_p02_binding", "P03 transition and accepted P02/P01 cohort are cross-spliced");
  }
}

function assertP02Lineage(input: {
  readonly store: ArtifactHostStore;
  readonly request: ScaP03RequestV2;
  readonly trustedClock: () => Date;
}): ScaP02RequestV1 {
  const transition = createScaP03TransitionAdmissionV1({
    store: input.store,
    trusted_clock: input.trustedClock,
  }).consume({ transition_ref: input.request.accepted_p02.transition_ref });
  const p02Request = validateScaP02RequestV1(
    readJson(input.store, input.request.accepted_p02.p02_request_ref, "P02 request")
  );
  admitScaP02Candidate({
    store: input.store,
    request: p02Request,
    input_artifacts: scaP02InputArtifacts(p02Request),
  });
  const p02Gate = validateScaP02GateV1(
    readJson(input.store, input.request.accepted_p02.gate_ref, "P02 gate")
  );
  const m1 = validateScaM1RecordV2(
    readJson(input.store, input.request.accepted_p02.m1_ref, "P02 M1")
  );
  const coverage = validateScaP02CoverageMatrixV1(
    readJson(input.store, input.request.accepted_p02.coverage_matrix_ref, "P02 coverage")
  );
  const manifest = validateScaP02EvidenceManifestV1(
    readJson(input.store, input.request.accepted_p02.evidence_manifest_ref, "P02 manifest")
  );
  const ledger = validateScaP02SuccessorLedgerV1(
    readJson(input.store, input.request.accepted_p02.successor_ledger_ref, "P02 ledger")
  );
  validateScaP03AcceptedP02CohortV1({
    request: input.request,
    transition,
    p02_request: p02Request,
    evidence_manifest: manifest,
  });
  if (
    p02Gate.status !== "passed" ||
    p02Gate.blocker_codes.length !== 0 ||
    p02Gate.isolation_scope !== "live_qualified" ||
    p02Gate.isolation_host_attestation_ref === null ||
    m1.status !== "passed" ||
    !m1.nonterminal ||
    m1.release_eligible ||
    m1.campaign_terminal ||
    m1.model_calls !== 0 ||
    m1.model_turns !== 0 ||
    !m1.transition_authorized
  ) {
    fail("invalid_p02_binding", "P03 requires the exact positive nonterminal P02/M1 boundary");
  }
  if (
    !same(
      coverage.entries.map((entry) => entry.analyzer_id),
      SCA_P02_ANALYZER_IDS
    )
  ) {
    fail("invalid_p02_binding", "P03 requires the exact ordered P02 analyzer coverage");
  }
  if (
    manifest.operations.length !== 6 ||
    manifest.operations.some(
      (entry, index) =>
        entry.operation_kind !==
        (
          [
            "inventory",
            "semgrep_php",
            "semgrep_js_ts",
            "gitleaks",
            "osv_composer",
            "osv_npm",
          ] as const
        )[index]
    )
  ) {
    fail("invalid_p02_binding", "P03 requires the exact ordered six-operation P02 manifest");
  }
  const expectedEvidenceRefs = [
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
  if (!same(input.request.accepted_p02.evidence_refs, expectedEvidenceRefs)) {
    fail("invalid_p02_binding", "P03 request omits or substitutes exact P02 operation evidence");
  }
  for (const [index, ref] of expectedEvidenceRefs.entries()) {
    readExact(input.store, ref, `P02 exact operation evidence ${index}`);
  }
  for (const entry of coverage.entries) {
    if (
      entry.status !== "complete" ||
      entry.blocker_codes.length !== 0 ||
      (entry.applicability === "applicable" && entry.fresh !== true)
    ) {
      fail("invalid_p02_binding", `P03 rejects incomplete P02 analyzer '${entry.analyzer_id}'`);
    }
  }
  const p03Prior = ledger.prior_entries.filter((entry) =>
    SCA_P03_OBLIGATION_IDS.some((obligationId) => obligationId === entry.obligation_id)
  );
  if (
    !same(
      p03Prior.map((entry) => entry.obligation_id),
      SCA_P03_OBLIGATION_IDS
    ) ||
    p03Prior.some((entry) => entry.obligation_class !== "required-result")
  ) {
    fail("invalid_p02_binding", "P02 successor ledger lacks exact required P03 obligations");
  }
  if (
    !same(input.request.accepted_p02.p02_request_ref, p02Gate.p02_request_ref) ||
    !same(input.request.accepted_p02.gate_ref, m1.gate_ref) ||
    !same(input.request.accepted_p02.coverage_matrix_ref, m1.coverage_matrix_ref) ||
    !same(input.request.accepted_p02.evidence_manifest_ref, m1.evidence_manifest_ref) ||
    !same(input.request.accepted_p02.successor_ledger_ref, m1.successor_ledger_ref)
  ) {
    fail("invalid_p02_binding", "P03 P02/M1 exact refs disagree");
  }
  return p02Request;
}

export function admitScaP03Candidate(input: {
  readonly store: ArtifactHostStore;
  readonly request: unknown;
  readonly input_artifacts: InputArtifacts;
  readonly trusted_clock: () => Date;
}): ScaP03AdmissionResultV1 {
  let request: ScaP03RequestV2;
  try {
    request = validateScaP03RequestV2(input.request);
  } catch (error) {
    fail(
      "invalid_request",
      error instanceof Error ? error.message : "P03 request is invalid",
      error
    );
  }
  assertExactInputSet(request, input.input_artifacts);
  assertP02Contracts(request);
  assertScaP03AuthorityContracts(request);
  try {
    requireScaP03AcceptedP02Qualification({
      store: input.store,
      definition_ref: request.accepted_p02.qualification_definition_ref,
      gate_ref: request.accepted_p02.qualification_gate_ref,
      tenant_id: request.tenant_id,
      project_id: request.project_id,
      accepted_p02_refs: [
        request.accepted_p02.transition_ref,
        request.accepted_p02.p02_request_ref,
        request.accepted_p02.gate_ref,
        request.accepted_p02.m1_ref,
        request.accepted_p02.coverage_matrix_ref,
        request.accepted_p02.evidence_manifest_ref,
        request.accepted_p02.successor_ledger_ref,
        ...request.accepted_p02.evidence_refs,
      ],
    });
  } catch (error) {
    fail("invalid_p02_binding", "P03 requires the exact accepted P02 V3 qualification", error);
  }
  const p02Request = assertP02Lineage({
    store: input.store,
    request,
    trustedClock: input.trusted_clock,
  });
  assertP01Bindings(request, p02Request);
  const p01Request = validateScaP01AdmissionRequestV3(
    readJson(input.store, request.accepted_p01.request_ref, "P01 request")
  );
  if (
    request.tenant_id !== p02Request.tenant_id ||
    request.project_id !== p02Request.project_id ||
    request.tenant_id !== p01Request.tenant_id ||
    request.project_id !== p01Request.project_id ||
    request.run_id === p02Request.run_id ||
    request.p01_binding_sha256 !== scaP03P01BindingSha256(request) ||
    request.p02_binding_sha256 !== scaP03P02BindingSha256(request) ||
    request.p03_runtime_binding_sha256 !== scaP03RuntimeBindingSha256(request)
  ) {
    fail("invalid_p01_binding", "P03 tenant/project/run or lineage digests are inconsistent");
  }
  assertSourceBinding({ store: input.store, request });

  const runtimePolicy = validateScaP03RuntimePolicyV1(
    readJson(input.store, request.runtime_policy_ref, "P03 runtime policy")
  );
  const runtimeIdentity = validateScaP03JoernRuntimeIdentityV1(
    readJson(input.store, request.joern_runtime_identity_ref, "P03 Joern runtime identity")
  );
  const isolation = validateScaP03IsolationEvidenceV1(
    readJson(input.store, request.isolation_evidence_ref, "P03 isolation evidence")
  );
  const implementation = validateScaP03ImplementationIdentityV1(
    readJson(input.store, request.implementation_identity_ref, "P03 implementation identity")
  );
  const qualificationProfile = validateScaP03QualificationProfileV2(
    readJson(input.store, request.qualification_profile_ref, "P03 qualification profile")
  );
  const corpus = validateScaP03QualificationFixtureCorpusV2(
    readJson(input.store, request.fixture_corpus_ref, "P03 qualification corpus")
  );
  const querySet = validateScaP03BaselineQuerySetV2(
    readJson(input.store, request.baseline_query_set_ref, "P03 baseline query set")
  );
  assertLiveAttestationBinding({
    request,
    runtime: runtimeIdentity,
    isolation,
    store: input.store,
  });
  assertRuntimeRootedInP01({ store: input.store, request, runtime: runtimeIdentity });
  assertQueryAuthority({ store: input.store, request, querySet });
  assertQualificationCorpus({ store: input.store, request, corpus });
  assertFidelityComplements({ store: input.store, request, profile: qualificationProfile });
  assertSourceOracleAuthority({ store: input.store, request, corpus });
  for (const ref of exactInputRefs(request)) readExact(input.store, ref, "P03 exact input");

  return {
    request,
    p02_request: p02Request,
    runtime_policy: runtimePolicy,
    runtime_identity: runtimeIdentity,
    isolation_evidence: isolation,
    implementation_identity: implementation,
    qualification_profile: qualificationProfile,
    fixture_corpus: corpus,
    baseline_query_set: querySet,
  };
}
