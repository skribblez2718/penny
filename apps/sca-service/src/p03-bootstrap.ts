import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import type { ArtifactRef, OutputArtifactMetadata } from "../../orchestration/dist/contracts.js";
import type { ScaP03ProductionUseAuthorityV1 } from "../../orchestration/dist/sca/p03-admission.js";
import {
  validateScaP03P01RuntimeIdentityRootV1,
  type ScaP03AcceptedP01BindingsV1,
  type ScaP03ExactArtifactReaderV1,
  type ScaP03P01RuntimeRootSelectionV1,
} from "../../orchestration/dist/sca/p03-p01-runtime-root.js";
import {
  SCA_P03_ATTESTATION_BINDING_V2_SCHEMA,
  SCA_P03_BOOTSTRAP_RECORD_V2_SCHEMA,
  SCA_P03_BOOTSTRAP_REVIEW_V2_SCHEMA,
  validateScaP03AttestationBindingV2,
  validateScaP03BootstrapQualificationRecordV2,
  validateScaP03BootstrapReviewV2,
  type ScaP03BootstrapQualificationRecordV2,
  type ScaP03BootstrapQualificationRecordV3,
  type ScaP03BootstrapReviewV2,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import {
  SCA_P03_PRODUCTION_INPUT_CONTRACTS,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  validateScaP03BaselineQuerySetV2,
  validateScaP03HostIsolationAttestationV1,
  validateScaP03ImplementationIdentityV1,
  validateScaP03JoernRuntimeIdentityV1,
  validateScaP03QualificationFixtureContentV1,
  validateScaP03QualificationFixtureCorpusV2,
  validateScaP03QualificationProfileV2,
  scaP03QualificationCaseMatchesV2,
  scaP03OracleBoundReleaseSha256V2,
  validateScaP03RuntimePolicyV1,
  validateScaP03QueryBindingAgainstPlanV2,
  validateScaP03QueryPlanV2,
  validateScaP03QueryScriptV2,
  type ScaP03QualificationFixtureCorpusV2,
  type SourceOracleValidationReceipt,
} from "../../orchestration/dist/sca/p03-contracts.js";
import { revalidateP03SourceOracle } from "./p03-oracle-authority.js";
import { parseSourceOracleValidationReceiptBytes } from "./p03-source-oracle-receipt.js";
import type {
  ScaP03DockerCandidateV1,
  ScaP03DockerCandidateConfigV1,
} from "./p03-docker-runtime.js";
import type {
  ScaP03FrozenQueryReleaseV1,
  ScaP03RuntimeQualificationOutputV1,
} from "./p03-operations.js";

/** An actual manifest-backed ArtifactStore (or an equally trusted exact-ref reader). */
export interface ScaP03BootstrapArtifactReaderV1 {
  read(ref: ArtifactRef): Uint8Array;
  /** Manifest-backed metadata; a ref's own labels are not provenance. */
  metadata(ref: ArtifactRef): OutputArtifactMetadata;
}

export type ScaP03BootstrapVerificationReaderV1 = ScaP03ExactArtifactReaderV1 &
  ScaP03BootstrapArtifactReaderV1;

// Closed bootstrap custody roles. These names label persisted proof; they do not provision authority.
export const P03_BOOTSTRAP_ROLES = {
  frozen: "host:sca-p03-frozen-inputs",
  cleanup: "host:sca-p03-cleanup-verifier",
  isolation: "host:sca-p03-isolation-verifier",
  evaluator: "host:sca-p03-bootstrap-evaluator",
  reviewer: "host:sca-p03-bootstrap-reviewer",
  attester: "host:sca-p03-bootstrap-attester",
} as const;
export const P03_BOOTSTRAP_EVIDENCE_SCHEMAS = {
  package: "penny.sca-p03-runtime-package.v1",
  cleanup: "penny.sca-p03-bootstrap-cleanup-evidence.v1",
  isolation: "penny.sca-p03-bootstrap-isolation-evidence.v1",
  receipt: "penny.sca-p03-bootstrap-reviewer-receipt.v1",
} as const;

type Policy = Readonly<{
  kind: string;
  schema_id: string;
  schema_version: number;
  producer: string;
  parent: ArtifactRef | null;
  upstream: readonly ArtifactRef[];
  run_id: string;
}>;
export function checkArtifact(
  store: ScaP03BootstrapArtifactReaderV1,
  ref: ArtifactRef,
  policy: Policy
): void {
  const metadata = store.metadata(ref);
  if (
    ref.schema_version !== 2 ||
    metadata.schema_version !== 2 ||
    ref.run_id !== policy.run_id ||
    ref.phase !== "SCA-P03" ||
    ref.branch_id !== null ||
    ref.kind !== policy.kind ||
    ref.producer !== policy.producer ||
    ref.media_type !== "application/json" ||
    ref.content_schema?.schema_id !== policy.schema_id ||
    ref.content_schema.schema_version !== policy.schema_version ||
    metadata.run_id !== ref.run_id ||
    metadata.phase !== ref.phase ||
    metadata.branch_id !== ref.branch_id ||
    metadata.kind !== ref.kind ||
    metadata.operation_id !== ref.operation_id ||
    metadata.version !== ref.version ||
    metadata.producer !== ref.producer ||
    metadata.media_type !== ref.media_type ||
    !same(metadata.content_schema, ref.content_schema) ||
    !same(metadata.parent_ref, policy.parent) ||
    !same(metadata.upstream_refs, policy.upstream)
  )
    throw new Error("p03_bootstrap_artifact_provenance_invalid");
}
function frozenPolicy(
  run_id: string,
  kind: string,
  schema_id: string,
  upstream: readonly ArtifactRef[] = []
): Policy {
  return {
    run_id,
    kind,
    schema_id,
    schema_version: schema_id.endsWith(".v2") ? 2 : 1,
    producer: P03_BOOTSTRAP_ROLES.frozen,
    parent: null,
    upstream,
  };
}
export function recordUpstream(record: ScaP03BootstrapQualificationRecordV2): ArtifactRef[] {
  return [
    record.fixture_corpus_ref,
    record.source_oracle_ref,
    record.source_oracle_validation_ref,
    record.source_oracle_review_ref,
    record.baseline_query_set_ref,
    record.qualification_profile_ref,
    record.runtime_policy_ref,
    record.implementation_identity_ref,
    record.runtime_identity_ref,
    ...record.fixture_content_refs,
    ...record.query_script_refs,
    ...record.query_plan_refs,
    ...record.runtime_package_refs,
    record.cleanup_evidence_ref,
    record.host_isolation_evidence_ref,
  ];
}
export interface ScaP03ProductionRootBindingsV1 {
  readonly accepted_p01: ScaP03AcceptedP01BindingsV1;
  readonly root_tool_id: string;
  readonly toolchain_ref: ArtifactRef;
  readonly root_executable_ref: ArtifactRef;
  readonly root_measurement_ref: ArtifactRef;
}

export interface ScaP03FrozenProductionBindingsV1 {
  readonly schema_id: "penny.sca-p03-frozen-production-bindings.v1";
  readonly schema_version: 1;
  readonly run_id: string;
  readonly frozen: ScaP03FrozenBootstrapBindingsV3;
  readonly roots: ScaP03ProductionRootBindingsV1;
  readonly binding_sha256: string;
}

export type ScaP03FrozenBootstrapBindingsV3 = Pick<
  ScaP03BootstrapQualificationRecordV3,
  | "fixture_corpus_ref"
  | "source_oracle_ref"
  | "source_oracle_validation_ref"
  | "source_oracle_review_ref"
  | "parser_identity_sha256"
  | "baseline_query_set_ref"
  | "qualification_profile_ref"
  | "runtime_policy_ref"
  | "implementation_identity_ref"
  | "runtime_identity_ref"
  | "fixture_content_refs"
  | "query_script_refs"
  | "query_plan_refs"
  | "runtime_package_refs"
  | "implementation_source_refs"
  | "runtime_id"
  | "isolation_id"
  | "runtime_tree_sha256"
  | "joern_version"
  | "max_num_def"
  | "implementation_identity_sha256"
  | "deployment_identity_sha256"
  | "profile_id"
  | "profile_sha256"
  | "release_id"
  | "release_sha256"
>;
function checkLegacyEvidenceArtifacts(
  store: ScaP03BootstrapArtifactReaderV1,
  record: ScaP03BootstrapQualificationRecordV2,
  run_id: string
): void {
  checkArtifact(store, record.cleanup_evidence_ref, {
    run_id,
    kind: "sca-p03-cleanup-evidence",
    schema_id: P03_BOOTSTRAP_EVIDENCE_SCHEMAS.cleanup,
    schema_version: 1,
    producer: P03_BOOTSTRAP_ROLES.cleanup,
    parent: null,
    upstream: [],
  });
  checkArtifact(store, record.host_isolation_evidence_ref, {
    run_id,
    kind: "sca-p03-isolation-evidence",
    schema_id: P03_BOOTSTRAP_EVIDENCE_SCHEMAS.isolation,
    schema_version: 1,
    producer: P03_BOOTSTRAP_ROLES.isolation,
    parent: null,
    upstream: [],
  });
}
function checkRecordArtifacts(
  store: ScaP03BootstrapArtifactReaderV1,
  record: ScaP03FrozenBootstrapBindingsV3 | ScaP03BootstrapQualificationRecordV2,
  run_id: string
): void {
  const production = (
    ref: ArtifactRef,
    contract: (typeof SCA_P03_PRODUCTION_INPUT_CONTRACTS)[keyof typeof SCA_P03_PRODUCTION_INPUT_CONTRACTS],
    upstream: readonly ArtifactRef[] = []
  ) =>
    checkArtifact(store, ref, {
      run_id,
      kind: contract.kind,
      schema_id: contract.content_schema.schema_id,
      schema_version: contract.content_schema.schema_version,
      producer: contract.producer,
      parent: null,
      upstream,
    });
  for (const ref of record.fixture_content_refs)
    production(ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.fixture_content);
  for (const ref of record.query_script_refs)
    production(ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.query_script);
  for (const ref of record.query_plan_refs)
    production(ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.query_plan);
  for (const ref of record.runtime_package_refs)
    checkArtifact(
      store,
      ref,
      frozenPolicy(run_id, "sca-p03-runtime-package", P03_BOOTSTRAP_EVIDENCE_SCHEMAS.package)
    );
  production(
    record.fixture_corpus_ref,
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.fixture_corpus,
    record.fixture_content_refs
  );
  checkArtifact(store, record.source_oracle_ref, {
    run_id,
    kind: "sca-p03-source-oracle",
    schema_id: SCA_P03_SOURCE_ORACLE_SCHEMA,
    schema_version: 2,
    producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
    parent: null,
    upstream: [],
  });
  checkArtifact(store, record.source_oracle_review_ref, {
    run_id,
    kind: "sca-p03-source-oracle-review",
    schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    schema_version: 1,
    producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    parent: null,
    upstream: [record.source_oracle_ref],
  });
  checkArtifact(store, record.source_oracle_validation_ref, {
    run_id,
    kind: "sca-p03-source-oracle-validation",
    schema_id: SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
    schema_version: 1,
    producer: SCA_P03_SOURCE_ORACLE_VALIDATOR,
    parent: null,
    upstream: [
      record.source_oracle_ref,
      record.fixture_corpus_ref,
      ...record.fixture_content_refs,
      record.source_oracle_review_ref,
    ].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
  });
  production(record.baseline_query_set_ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.baseline_query_set, [
    ...record.query_script_refs,
    ...record.query_plan_refs,
  ]);
  production(
    record.qualification_profile_ref,
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.qualification_profile
  );
  production(record.runtime_policy_ref, SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_policy);
  production(
    record.implementation_identity_ref,
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.implementation_identity,
    "implementation_source_refs" in record ? record.implementation_source_refs : []
  );
  const runtimeIdentity = validateScaP03JoernRuntimeIdentityV1(
    body(store, record.runtime_identity_ref)
  );
  const runtimeIdentityUpstream = [
    ...record.runtime_package_refs,
    runtimeIdentity.toolchain_ref,
    runtimeIdentity.root_executable_ref,
    runtimeIdentity.root_measurement_ref,
  ]
    .filter((ref, index, refs) => refs.findIndex((candidate) => same(candidate, ref)) === index)
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
  production(
    record.runtime_identity_ref,
    SCA_P03_PRODUCTION_INPUT_CONTRACTS.runtime_identity,
    runtimeIdentityUpstream
  );
}

/** Injected by the trusted host, never derived from candidate observations or JSON claims. */
export interface ScaP03BootstrapHostAuthorityV1 {
  readonly reviewer_id: string;
  readonly reviewer_authority_id: string;
  verifyReviewerReceipt(
    review: ScaP03BootstrapReviewV2,
    receipt: Uint8Array
  ): boolean | Promise<boolean>;
  verifyCleanupEvidence(
    record: ScaP03BootstrapQualificationRecordV2,
    evidence: Uint8Array
  ): boolean | Promise<boolean>;
  verifyIsolationEvidence(
    record: ScaP03BootstrapQualificationRecordV2,
    evidence: Uint8Array
  ): boolean | Promise<boolean>;
  /** Host-owned current selection/revocation check; a historical PASS is not perpetual authority. */
  isCurrentQualification(record: ScaP03BootstrapQualificationRecordV2): boolean | Promise<boolean>;
  /** Must independently establish origin; synthetic fixtures must return deterministic_test_only. */
  evidenceClass(
    record: ScaP03BootstrapQualificationRecordV2
  ): "live" | "deterministic_test_only" | Promise<"live" | "deterministic_test_only">;
}

export function readP03BootstrapBytes(
  store: ScaP03BootstrapArtifactReaderV1,
  ref: ArtifactRef
): Uint8Array {
  if (ref.byte_length > 16 * 1024 * 1024) throw new Error("p03_bootstrap_artifact_too_large");
  const bytes = store.read(ref);
  if (
    bytes.byteLength !== ref.byte_length ||
    sha256(bytes) !== ref.content_digest ||
    ref.store_ref !== `artifact://sha256/${ref.content_digest}`
  )
    throw new Error("p03_bootstrap_artifact_mismatch");
  return bytes;
}
function body(store: ScaP03BootstrapArtifactReaderV1, ref: ArtifactRef): unknown {
  const bytes = readP03BootstrapBytes(store, ref);
  const text = Buffer.from(bytes).toString("utf8");
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error("p03_bootstrap_noncanonical_artifact");
  return value;
}
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Reconstruct release from frozen bytes, not a release label; expected run comes from host/binding. */
export function readP03BootstrapInputs(
  store: ScaP03BootstrapArtifactReaderV1,
  record: ScaP03FrozenBootstrapBindingsV3 | ScaP03BootstrapQualificationRecordV2,
  run_id: string
): {
  corpus: ScaP03QualificationFixtureCorpusV2;
  release: ScaP03FrozenQueryReleaseV1;
  policy: ReturnType<typeof validateScaP03RuntimePolicyV1>;
  profile: ReturnType<typeof validateScaP03QualificationProfileV2>;
  parser_identity_sha256: string;
  receipt: SourceOracleValidationReceipt;
} {
  checkRecordArtifacts(store, record, run_id);
  const corpus = validateScaP03QualificationFixtureCorpusV2(body(store, record.fixture_corpus_ref));
  const profile = validateScaP03QualificationProfileV2(
    body(store, record.qualification_profile_ref)
  );
  const policy = validateScaP03RuntimePolicyV1(body(store, record.runtime_policy_ref));
  const implementation = validateScaP03ImplementationIdentityV1(
    body(store, record.implementation_identity_ref)
  );
  const identity = validateScaP03JoernRuntimeIdentityV1(body(store, record.runtime_identity_ref));
  const set = validateScaP03BaselineQuerySetV2(body(store, record.baseline_query_set_ref));
  if (
    corpus.fixture_content_refs.length !== record.fixture_content_refs.length ||
    !same(corpus.fixture_content_refs, record.fixture_content_refs) ||
    !same(
      set.ordered_queries.map((entry) => entry.script_ref),
      record.query_script_refs
    ) ||
    !same(
      set.ordered_queries.map((entry) => entry.plan_ref),
      record.query_plan_refs
    ) ||
    !same(identity.runtime_package_refs, record.runtime_package_refs) ||
    implementation.implementation_sha256 !== record.implementation_identity_sha256 ||
    identity.runtime_id !== record.runtime_id ||
    identity.runtime_tree_sha256 !== record.runtime_tree_sha256 ||
    identity.joern_version !== record.joern_version ||
    policy.max_num_def !== record.max_num_def ||
    identity.runtime_kind !== "host_qualified_joern" ||
    identity.qualification_scope !== "live_qualified" ||
    profile.profile_id !== record.profile_id ||
    profile.profile_sha256 !== record.profile_sha256 ||
    set.release_id !== record.release_id
  )
    throw new Error("p03_bootstrap_frozen_input_mismatch");
  const fixtures = record.fixture_content_refs.map((ref, index) => {
    const fixture = validateScaP03QualificationFixtureContentV1(body(store, ref));
    if (
      fixture.fixture_id !== corpus.fixture_ids[index] ||
      fixture.language !== corpus.languages[index]
    )
      throw new Error("p03_bootstrap_fixture_mismatch");
    return {
      ref,
      fixture_id: fixture.fixture_id,
      language: fixture.language,
      path: fixture.path,
      content_sha256: fixture.content_sha256,
      bytes: Buffer.from(fixture.content_base64, "base64"),
    };
  });
  const receiptBytes = readP03BootstrapBytes(store, record.source_oracle_validation_ref);
  const receipt = parseSourceOracleValidationReceiptBytes(receiptBytes);
  if (!same(receipt.review_ref, record.source_oracle_review_ref))
    throw new Error("p03_bootstrap_oracle_review_cross_splice");
  const authority = revalidateP03SourceOracle({
    run_id,
    oracle_ref: record.source_oracle_ref,
    oracle_bytes: readP03BootstrapBytes(store, record.source_oracle_ref),
    receipt_ref: record.source_oracle_validation_ref,
    receipt_bytes: receiptBytes,
    review_ref: record.source_oracle_review_ref,
    review_bytes: readP03BootstrapBytes(store, record.source_oracle_review_ref),
    corpus_ref: record.fixture_corpus_ref,
    corpus,
    fixtures,
  });
  if (record.parser_identity_sha256 !== authority.parser_identity_sha256)
    throw new Error("p03_bootstrap_parser_identity_drift");
  for (const ref of record.runtime_package_refs) readP03BootstrapBytes(store, ref);
  if ("implementation_source_refs" in record) {
    const refs = record.implementation_source_refs;
    if (
      refs.length === 0 ||
      refs.length > 128 ||
      refs.reduce((sum, ref) => sum + ref.byte_length, 0) > 32 * 1024 * 1024 ||
      refs.some((ref, i) => i > 0 && ref.artifact_id <= (refs[i - 1]?.artifact_id ?? ""))
    )
      throw new Error("p03_bootstrap_implementation_refs_invalid");
    for (const ref of refs) {
      const metadata = store.metadata(ref);
      if (
        ref.run_id !== run_id ||
        metadata.run_id !== run_id ||
        ref.phase !== "SCA-P03" ||
        ref.branch_id !== null ||
        ref.kind !== "sca-p03-implementation-source" ||
        ref.producer !== P03_BOOTSTRAP_ROLES.frozen ||
        metadata.kind !== ref.kind ||
        metadata.producer !== ref.producer ||
        metadata.operation_id !== ref.operation_id ||
        !same(metadata.upstream_refs, []) ||
        metadata.parent_ref !== null
      )
        throw new Error("p03_bootstrap_implementation_ref_provenance_invalid");
      readP03BootstrapBytes(store, ref);
    }
  }
  const queries = set.ordered_queries.map((entry, index) => {
    const scriptRef = record.query_script_refs[index];
    const planRef = record.query_plan_refs[index];
    if (scriptRef === undefined || planRef === undefined)
      throw new Error("p03_bootstrap_query_missing");
    const script = validateScaP03QueryScriptV2(body(store, scriptRef));
    const plan = validateScaP03QueryPlanV2(body(store, planRef));
    const binding = validateScaP03QueryBindingAgainstPlanV2({
      release_id: set.release_id,
      query_id: entry.query_id,
      script,
      plan,
    });
    if (
      planRef.content_digest !== entry.plan_sha256 ||
      entry.script_sha256 !== scriptRef.content_digest
    )
      throw new Error("p03_bootstrap_query_binding_mismatch");
    return {
      query_id: entry.query_id,
      script_id: script.script_id,
      script_sha256: script.content_sha256,
      binding,
      plan,
    };
  });
  const release_sha256 = scaP03OracleBoundReleaseSha256V2({
    query_set_id: set.query_set_id,
    release_id: set.release_id,
    query_set_sha256: set.query_set_sha256,
    queries,
    oracle_ref: record.fixture_corpus_ref,
    oracle: corpus,
  });
  if (release_sha256 !== record.release_sha256) throw new Error("p03_bootstrap_release_drift");
  return {
    corpus,
    policy,
    profile,
    parser_identity_sha256: authority.parser_identity_sha256,
    receipt: authority.validated_receipt,
    release: {
      query_set_id: set.query_set_id,
      release_id: set.release_id,
      release_sha256,
      queries,
    },
  };
}

export function createScaP03FrozenProductionBindingsV1(input: {
  readonly run_id: string;
  readonly frozen: ScaP03FrozenBootstrapBindingsV3;
  readonly roots: ScaP03ProductionRootBindingsV1;
}): ScaP03FrozenProductionBindingsV1 {
  const unsigned = {
    schema_id: "penny.sca-p03-frozen-production-bindings.v1" as const,
    schema_version: 1 as const,
    run_id: input.run_id,
    frozen: input.frozen,
    roots: input.roots,
  };
  return { ...unsigned, binding_sha256: sha256(canonicalJson(unsigned)) };
}

export function validateScaP03FrozenProductionBindingsV1(
  value: ScaP03FrozenProductionBindingsV1
): ScaP03FrozenProductionBindingsV1 {
  const keys = (candidate: object): readonly string[] => Object.keys(candidate).sort();
  if (
    !same(keys(value), [
      "binding_sha256",
      "frozen",
      "roots",
      "run_id",
      "schema_id",
      "schema_version",
    ]) ||
    !same(keys(value.roots), [
      "accepted_p01",
      "root_executable_ref",
      "root_measurement_ref",
      "root_tool_id",
      "toolchain_ref",
    ]) ||
    !same(keys(value.roots.accepted_p01), [
      "admission_evidence_ref",
      "campaign_manifest_core_ref",
      "campaign_manifest_ref",
      "frozen_refs",
      "obligation_ledger_ref",
      "p01_gate_ref",
      "request_ref",
    ]) ||
    !/^[a-f0-9]{64}$/u.test(value.binding_sha256)
  ) {
    throw new Error("p03_production_bindings_invalid");
  }
  const expected = createScaP03FrozenProductionBindingsV1({
    run_id: value.run_id,
    frozen: value.frozen,
    roots: value.roots,
  });
  if (
    value.schema_id !== expected.schema_id ||
    value.schema_version !== 1 ||
    !same(value, expected)
  )
    throw new Error("p03_production_bindings_invalid");
  return value;
}

/** Derive the immutable host-operation authority from one validated production binding. */
export function scaP03ProductionUseAuthorityFromBindingsV1(
  value: ScaP03FrozenProductionBindingsV1
): ScaP03ProductionUseAuthorityV1 {
  const production = validateScaP03FrozenProductionBindingsV1(value);
  return structuredClone({
    run_id: production.run_id,
    accepted_p01: production.roots.accepted_p01,
    runtime_identity_ref: production.frozen.runtime_identity_ref,
    runtime_package_refs: production.frozen.runtime_package_refs,
  });
}

/** Revalidate production P01 roots together with the frozen P03 closure on every use. */
export function readP03ProductionInputs(
  store: ScaP03ExactArtifactReaderV1 & ScaP03BootstrapArtifactReaderV1,
  production: ScaP03FrozenProductionBindingsV1
): ReturnType<typeof readP03BootstrapInputs> & {
  readonly p01_runtime_root: ScaP03P01RuntimeRootSelectionV1;
} {
  const context = validateScaP03FrozenProductionBindingsV1(production);
  const { frozen: record, roots, run_id } = context;
  const identity = validateScaP03JoernRuntimeIdentityV1(body(store, record.runtime_identity_ref));
  const p01RuntimeRoot = validateScaP03P01RuntimeIdentityRootV1({
    store,
    accepted_p01: roots.accepted_p01,
    runtime: identity,
  });
  const inputs = readP03BootstrapInputs(store, record, run_id);
  if (
    identity.root_tool_id !== roots.root_tool_id ||
    !same(identity.toolchain_ref, roots.toolchain_ref) ||
    !same(identity.root_executable_ref, roots.root_executable_ref) ||
    !same(identity.root_measurement_ref, roots.root_measurement_ref) ||
    identity.root_tool_id !== p01RuntimeRoot.root_tool_id ||
    !same(identity.toolchain_ref, p01RuntimeRoot.toolchain_ref) ||
    !same(identity.root_executable_ref, p01RuntimeRoot.root_executable_ref) ||
    !same(identity.root_measurement_ref, p01RuntimeRoot.root_measurement_ref)
  )
    throw new Error("p03_production_p01_root_drift");
  return { ...inputs, p01_runtime_root: p01RuntimeRoot };
}

export function exactP03BootstrapObservations(
  corpus: ScaP03QualificationFixtureCorpusV2,
  release: ScaP03FrozenQueryReleaseV1,
  fixtures: readonly Pick<
    Parameters<ScaP03DockerCandidateV1["qualify"]>[0]["fixtures"][number],
    "fixture_id" | "language" | "path" | "content_sha256"
  >[],
  output:
    | Pick<ScaP03BootstrapQualificationRecordV2, "observations" | "executed_query_release_sha256">
    | ScaP03RuntimeQualificationOutputV1,
  approvedComplementRef?: ArtifactRef
): boolean {
  const cases = "cases" in output ? output.cases : output.observations;
  return (
    output.executed_query_release_sha256 === release.release_sha256 &&
    cases.length === corpus.expected_cases.length &&
    cases.every((entry, index) => {
      const expected = corpus.expected_cases[index];
      return (
        expected !== undefined &&
        entry.case_id === expected.case_id &&
        entry.language === expected.language &&
        entry.query_id === expected.query_id &&
        (() => {
          const fixture = fixtures.find((item) => item.language === entry.language);
          return (
            fixture !== undefined &&
            scaP03QualificationCaseMatchesV2(
              entry,
              expected,
              fixture,
              release.release_sha256,
              approvedComplementRef
            )
          );
        })()
      );
    })
  );
}

/** Host evaluator; never called by the candidate itself and never produces a reviewed PASS. */
export async function evaluateScaP03BootstrapCandidateV2(input: {
  /** Trusted host-selected run; never infer it from a record's frozen refs. */
  run_id: string;
  candidate: ScaP03DockerCandidateV1;
  store: ScaP03BootstrapArtifactReaderV1;
  authority: ScaP03BootstrapHostAuthorityV1;
  bindings: Omit<
    ScaP03BootstrapQualificationRecordV2,
    | "schema_id"
    | "schema_version"
    | "record_sha256"
    | "observations"
    | "executed_query_release_sha256"
    | "exact_expected_observations"
    | "cleanup_verified"
    | "host_isolation_verified"
  >;
  fixtures: Parameters<ScaP03DockerCandidateV1["qualify"]>[0]["fixtures"];
  signal: AbortSignal;
}): Promise<ScaP03BootstrapQualificationRecordV2> {
  const { candidate, store, authority, bindings } = input;
  const provisional: ScaP03BootstrapQualificationRecordV2 = {
    ...bindings,
    schema_id: SCA_P03_BOOTSTRAP_RECORD_V2_SCHEMA,
    schema_version: 2,
    record_sha256: "0".repeat(64),
    observations: [],
    executed_query_release_sha256: "0".repeat(64),
    exact_expected_observations: false,
    cleanup_verified: false,
    host_isolation_verified: false,
  };
  // Validate frozen inputs before any candidate execution.
  checkLegacyEvidenceArtifacts(store, provisional, input.run_id);
  const { corpus, release, profile, receipt } = readP03BootstrapInputs(
    store,
    provisional,
    input.run_id
  );
  if (
    candidate.runtime_id !== bindings.runtime_id ||
    candidate.isolation_id !== bindings.isolation_id ||
    candidate.runtime_tree_sha256 !== bindings.runtime_tree_sha256 ||
    candidate.implementation_identity_sha256 !== bindings.implementation_identity_sha256 ||
    candidate.deployment_identity_sha256 !== bindings.deployment_identity_sha256 ||
    candidate.isolation_profile_sha256 !== bindings.profile_sha256 ||
    candidate.measured_joern_version !== bindings.joern_version ||
    candidate.max_num_def !== bindings.max_num_def ||
    !same(
      input.fixtures.map((f) => ({
        id: f.fixture_id,
        language: f.language,
        path: f.path,
        sha: f.content_sha256,
      })),
      bindings.fixture_content_refs.map((ref) => {
        const f = validateScaP03QualificationFixtureContentV1(body(store, ref));
        return { id: f.fixture_id, language: f.language, path: f.path, sha: f.content_sha256 };
      })
    ) ||
    input.fixtures.some((f) => sha256(f.bytes) !== f.content_sha256)
  )
    throw new Error("p03_bootstrap_candidate_identity_mismatch");
  const output = await candidate.qualify({
    fixtures: input.fixtures,
    expected_cases: corpus.expected_cases,
    source_oracle_validation_ref: bindings.source_oracle_validation_ref,
    source_oracle_validation_receipt: receipt,
    query_release: release,
    fidelity_requirements: profile.fidelity_requirements,
    signal: input.signal,
  });
  const draft = {
    ...bindings,
    schema_id: SCA_P03_BOOTSTRAP_RECORD_V2_SCHEMA,
    schema_version: 2 as const,
    observations: output.cases.map((entry) => ({ ...entry })),
    executed_query_release_sha256: output.executed_query_release_sha256,
    exact_expected_observations: exactP03BootstrapObservations(
      corpus,
      release,
      input.fixtures,
      output,
      bindings.source_oracle_validation_ref
    ),
    cleanup_verified: false,
    host_isolation_verified: false,
  };
  const provisionalRecord = validateScaP03BootstrapQualificationRecordV2({
    ...draft,
    record_sha256: sha256(canonicalJson(draft)),
  });
  const verifiedDraft = {
    ...draft,
    cleanup_verified: await authority.verifyCleanupEvidence(
      provisionalRecord,
      readP03BootstrapBytes(store, bindings.cleanup_evidence_ref)
    ),
    host_isolation_verified: await authority.verifyIsolationEvidence(
      provisionalRecord,
      readP03BootstrapBytes(store, bindings.host_isolation_evidence_ref)
    ),
  };
  const record = validateScaP03BootstrapQualificationRecordV2({
    ...verifiedDraft,
    record_sha256: sha256(canonicalJson(verifiedDraft)),
  });
  if ((await authority.evidenceClass(record)) !== record.evidence_class)
    throw new Error("p03_bootstrap_evidence_class_mismatch");
  if (!(await authority.isCurrentQualification(record)))
    throw new Error("p03_bootstrap_stale_selection");
  return record;
}

export async function verifyScaP03BootstrapProofV2(input: {
  store: ScaP03BootstrapArtifactReaderV1;
  authority: ScaP03BootstrapHostAuthorityV1;
  config: ScaP03DockerCandidateConfigV1;
  binding_ref: ArtifactRef;
  host_attestation_ref: ArtifactRef;
  qualification_record_ref: ArtifactRef;
  review_ref: ArtifactRef;
}): Promise<{
  attestation_id: string;
  attestation_sha256: string;
  proof_sha256: string;
  parser_identity_sha256: string;
  source_oracle_ref: ArtifactRef;
  source_oracle_validation_ref: ArtifactRef;
}> {
  // Preserve exact negative diagnostics for old proof bytes, but never issue
  // a live proof from V2 (which lacks an attempt witness and external review).
  void input;
  throw new Error("p03_bootstrap_v2_live_forbidden");
}

/** Explicit deterministic constructor seam only; never use this result as live qualification. */
export async function verifyScaP03DeterministicTestProofV2(
  input: Parameters<typeof verifyScaP03BootstrapProofV2>[0]
): Promise<{
  attestation_id: string;
  attestation_sha256: string;
  proof_sha256: string;
  parser_identity_sha256: string;
  source_oracle_ref: ArtifactRef;
  source_oracle_validation_ref: ArtifactRef;
}> {
  return verifyProof(input, "deterministic_test_only");
}

async function verifyProof(
  input: Parameters<typeof verifyScaP03BootstrapProofV2>[0],
  evidenceClass: "live" | "deterministic_test_only"
): Promise<{
  attestation_id: string;
  attestation_sha256: string;
  proof_sha256: string;
  parser_identity_sha256: string;
  source_oracle_ref: ArtifactRef;
  source_oracle_validation_ref: ArtifactRef;
}> {
  const { store, authority, config } = input;
  const binding = validateScaP03AttestationBindingV2(body(store, input.binding_ref));
  if (
    !same(binding.host_attestation_ref, input.host_attestation_ref) ||
    !same(binding.qualification_record_ref, input.qualification_record_ref) ||
    !same(binding.review_ref, input.review_ref)
  )
    throw new Error("p03_bootstrap_binding_substituted");
  const record = validateScaP03BootstrapQualificationRecordV2(
    body(store, input.qualification_record_ref)
  );
  const review = validateScaP03BootstrapReviewV2(body(store, input.review_ref));
  const attestation = validateScaP03HostIsolationAttestationV1(
    body(store, input.host_attestation_ref)
  );
  const run_id = input.binding_ref.run_id;
  checkArtifact(store, input.qualification_record_ref, {
    run_id,
    kind: "sca-p03-bootstrap-record",
    schema_id: SCA_P03_BOOTSTRAP_RECORD_V2_SCHEMA,
    schema_version: 2,
    producer: P03_BOOTSTRAP_ROLES.evaluator,
    parent: null,
    upstream: recordUpstream(record),
  });
  checkArtifact(store, review.reviewer_receipt_ref, {
    run_id,
    kind: "sca-p03-reviewer-receipt",
    schema_id: P03_BOOTSTRAP_EVIDENCE_SCHEMAS.receipt,
    schema_version: 1,
    producer: P03_BOOTSTRAP_ROLES.reviewer,
    parent: null,
    upstream: [input.qualification_record_ref],
  });
  checkArtifact(store, input.review_ref, {
    run_id,
    kind: "sca-p03-bootstrap-review",
    schema_id: SCA_P03_BOOTSTRAP_REVIEW_V2_SCHEMA,
    schema_version: 2,
    producer: P03_BOOTSTRAP_ROLES.reviewer,
    parent: null,
    upstream: [
      review.reviewer_receipt_ref,
      record.source_oracle_ref,
      record.source_oracle_validation_ref,
    ],
  });
  checkArtifact(store, input.host_attestation_ref, {
    run_id,
    kind: SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.kind,
    schema_id: SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.content_schema.schema_id,
    schema_version:
      SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.content_schema.schema_version,
    producer: SCA_P03_PRODUCTION_INPUT_CONTRACTS.host_attestation.producer,
    parent: null,
    upstream: [
      input.qualification_record_ref,
      input.review_ref,
      record.source_oracle_ref,
      record.source_oracle_validation_ref,
    ],
  });
  checkArtifact(store, input.binding_ref, {
    run_id,
    kind: "sca-p03-attestation-binding",
    schema_id: SCA_P03_ATTESTATION_BINDING_V2_SCHEMA,
    schema_version: 2,
    producer: P03_BOOTSTRAP_ROLES.attester,
    parent: null,
    upstream: [
      input.qualification_record_ref,
      input.review_ref,
      input.host_attestation_ref,
      record.source_oracle_ref,
      record.source_oracle_validation_ref,
    ],
  });
  checkLegacyEvidenceArtifacts(store, record, run_id);
  const { corpus, release, policy, parser_identity_sha256 } = readP03BootstrapInputs(
    store,
    record,
    run_id
  );
  const cleanup = await authority.verifyCleanupEvidence(
    record,
    readP03BootstrapBytes(store, record.cleanup_evidence_ref)
  );
  const isolation = await authority.verifyIsolationEvidence(
    record,
    readP03BootstrapBytes(store, record.host_isolation_evidence_ref)
  );
  const proofDeploymentIdentity = sha256(
    canonicalJson({
      docker_executable_sha256: config.expected_docker_executable_sha256,
      docker_client_version: config.expected_docker_client_version,
      docker_server_version: config.expected_docker_server_version,
      image_id: `sha256:${attestation.runtime_tree_sha256}`,
      joern_version: config.expected_joern_version,
    })
  );
  if (
    record.evidence_class !== evidenceClass ||
    review.evidence_class !== evidenceClass ||
    (await authority.evidenceClass(record)) !== evidenceClass ||
    !record.exact_expected_observations ||
    !exactP03BootstrapObservations(
      corpus,
      release,
      record.fixture_content_refs.map((ref) =>
        validateScaP03QualificationFixtureContentV1(body(store, ref))
      ),
      record,
      record.source_oracle_validation_ref
    ) ||
    !record.cleanup_verified ||
    !record.host_isolation_verified ||
    !cleanup ||
    !isolation ||
    !(await authority.isCurrentQualification(record)) ||
    !same(review.record_ref, input.qualification_record_ref) ||
    !same(review.source_oracle_ref, record.source_oracle_ref) ||
    !same(review.source_oracle_validation_ref, record.source_oracle_validation_ref) ||
    !same(binding.source_oracle_ref, record.source_oracle_ref) ||
    !same(binding.source_oracle_validation_ref, record.source_oracle_validation_ref) ||
    binding.parser_identity_sha256 !== parser_identity_sha256 ||
    !same(attestation.source_oracle_ref, record.source_oracle_ref) ||
    !same(attestation.source_oracle_validation_ref, record.source_oracle_validation_ref) ||
    attestation.parser_identity_sha256 !== parser_identity_sha256 ||
    review.reviewer_id !== authority.reviewer_id ||
    review.reviewer_authority_id !== authority.reviewer_authority_id ||
    input.review_ref.producer === input.qualification_record_ref.producer ||
    review.reviewer_id === input.qualification_record_ref.producer ||
    review.reviewer_receipt_ref.producer !== input.review_ref.producer ||
    !(await authority.verifyReviewerReceipt(
      review,
      readP03BootstrapBytes(store, review.reviewer_receipt_ref)
    )) ||
    attestation.runtime_id !== config.runtime_id ||
    attestation.isolation_id !== config.isolation_id ||
    attestation.implementation_identity_sha256 !== config.implementation_identity_sha256 ||
    attestation.deployment_identity_sha256 !== config.deployment_identity_sha256 ||
    proofDeploymentIdentity !== config.deployment_identity_sha256 ||
    attestation.profile_sha256 !== config.isolation_profile_sha256 ||
    attestation.profile_id !== record.profile_id ||
    record.runtime_id !== config.runtime_id ||
    record.isolation_id !== config.isolation_id ||
    record.runtime_tree_sha256 !== attestation.runtime_tree_sha256 ||
    record.implementation_identity_sha256 !== config.implementation_identity_sha256 ||
    record.deployment_identity_sha256 !== config.deployment_identity_sha256 ||
    record.profile_sha256 !== config.isolation_profile_sha256 ||
    record.joern_version !== config.expected_joern_version ||
    record.max_num_def !== config.max_num_def ||
    policy.staging_parent_sha256 !== sha256(config.staging_parent) ||
    policy.process_timeout_ms !== config.timeout_ms ||
    Date.parse(review.reviewed_at) <= Date.parse(record.evaluated_at) ||
    Date.parse(attestation.attested_at) <= Date.parse(review.reviewed_at)
  )
    throw new Error("p03_bootstrap_review_unqualified");
  if (evidenceClass === "live") throw new Error("p03_bootstrap_review_unqualified");
  return {
    attestation_id: attestation.attestation_id,
    attestation_sha256: input.host_attestation_ref.content_digest,
    source_oracle_ref: record.source_oracle_ref,
    source_oracle_validation_ref: record.source_oracle_validation_ref,
    parser_identity_sha256,
    proof_sha256: sha256(
      canonicalJson({
        binding_ref: input.binding_ref,
        qualification_record_ref: input.qualification_record_ref,
        review_ref: input.review_ref,
        host_attestation_ref: input.host_attestation_ref,
        source_oracle_ref: record.source_oracle_ref,
        source_oracle_validation_ref: record.source_oracle_validation_ref,
        parser_identity_sha256,
      })
    ),
  };
}
