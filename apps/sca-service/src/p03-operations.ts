import { Type } from "typebox";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { isVerifiedScaP03DockerHostRuntimeV1 } from "./p03-docker-runtime.js";
import { revalidateP03SourceOracle } from "./p03-oracle-authority.js";
import {
  validateContract,
  type ArtifactRef,
  type HostOperationArtifactContractV1,
} from "../../orchestration/dist/contracts.js";
import type {
  HostOperationAdapterTerminalV1,
  HostOperationAdapterV1,
  HostOperationExecutionContextV1,
  HostOperationRequestInspectionV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import {
  validateScaP01SourceCustodyCorpusV1,
  validateScaP01SourceFileManifestV1,
  validateScaP01SourceMaterialV1,
} from "../../orchestration/dist/sca/p01-contracts.js";
import {
  SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA,
  SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA,
  SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA,
  SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
  SCA_P03_INPUT_SLOTS,
  SCA_P03_QUALIFICATION_RESULT_V2_SCHEMA,
  SCA_P03_QUERY_IDS,
  SCA_P03_MAX_GRAPH_BYTES,
  SCA_P03_MAX_QUERY_PAGES,
  makeScaP03QueryCandidateV2,
  scaP03QualificationObservationSha256V2,
  scaP03FrontendLanguageV1,
  scaP03QualificationCaseMatchesV2,
  validateScaP03QualificationResultProjectionV2,
  scaP03OracleBoundReleaseSha256V2,
  scaP03QueryReleaseSha256V2,
  validateScaP03QualificationCaseObservationsV2,
  validateScaP03QueryBindingAgainstPlanV2,
  validateScaP03BaselineQueryPageV2,
  validateScaP03BaselineQuerySetV2,
  validateScaP03ImplementationIdentityV1,
  validateScaP03HostIsolationAttestationV1,
  validateScaP03JoernRuntimeIdentityV1,
  validateScaP03IsolationEvidenceV1,
  validateScaP03OperationRequestV1,
  validateScaP03RequestV2,
  parseSourceOracleValidationReceiptBytes,
  validateScaP03OperationResultV1,
  validateScaP03QualificationFixtureContentV1,
  validateScaP03QualificationFixtureCorpusV2,
  validateScaP03QualificationProfileV2,
  validateScaP03QueryPlanV2,
  validateScaP03QueryScriptV2,
  validateScaP03RuntimePolicyV1,
  withScaP03Digest,
  type ScaP03BaselineQueryBatchRequestV2,
  type ScaP03BaselineQueryBatchResultV2,
  type ScaP03BaselineQueryPageV2,
  type ScaP03FidelityObservationV2,
  type ScaP03FidelityRequirementV1,
  type ScaP03GraphBuildRequestV1,
  type ScaP03GraphBuildResultV1,
  type ScaP03GraphCleanupEvidenceV1,
  type ScaP03OperationKind,
  type ScaP03OperationRequestV1,
  type ScaP03OperationResultV1,
  type ScaP03Partition,
  type ScaP03QualificationFixtureCorpusV2,
  type ScaP03QualificationRequestV2,
  type ScaP03QueryBindingV2,
  type ScaP03QueryPlanV2,
  type ScaP03QualificationResultV2,
  type ScaP03QueryCandidateV2,
  type ScaP03QualificationCaseV2,
  type ScaP03QualificationBlockerCodeV2,
  type ScaP03QueryId,
  type SourceOracleValidationReceipt,
} from "../../orchestration/dist/sca/p03-contracts.js";

const GRAPH_CONTRACT: HostOperationArtifactContractV1 = {
  schema_version: 1,
  port_name: "p03_graph_component",
  artifact_kind: "sca-p03-graph-component",
  schema_id: SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
  schema_version_required: 1,
};
const PAGE_CONTRACT: HostOperationArtifactContractV1 = {
  schema_version: 1,
  port_name: "p03_baseline_query_page",
  artifact_kind: "sca-p03-baseline-query-page",
  schema_id: SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA,
  schema_version_required: 2,
};

const CacheOutputSchema = Type.Object(
  {
    artifact_kind: Type.Union([
      Type.Literal("sca-p03-graph-component"),
      Type.Literal("sca-p03-baseline-query-page"),
    ]),
    media_type: Type.Union([
      Type.Literal("application/vnd.penny.joern-cpg"),
      Type.Literal("application/json"),
    ]),
    content_schema_id: Type.Union([
      Type.Literal(SCA_P03_GRAPH_COMPONENT_V1_SCHEMA),
      Type.Literal(SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA),
    ]),
    content_base64: Type.String({ maxLength: 180 * 1024 * 1024 }),
    byte_length: Type.Integer({ minimum: 1, maximum: SCA_P03_MAX_GRAPH_BYTES }),
    content_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false }
);
const CacheEnvelopeSchema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-p03-operation-cache.v1"),
    schema_version: Type.Literal(1),
    operation_kind: Type.Union([
      Type.Literal("qualify_joern"),
      Type.Literal("build_source_graph"),
      Type.Literal("run_baseline_query_batch"),
    ]),
    result: Type.Unknown(),
    outputs: Type.Array(CacheOutputSchema, { maxItems: SCA_P03_MAX_QUERY_PAGES }),
  },
  { additionalProperties: false }
);

type CacheOutput = Readonly<{
  artifact_kind: "sca-p03-graph-component" | "sca-p03-baseline-query-page";
  media_type: "application/vnd.penny.joern-cpg" | "application/json";
  content_schema_id:
    | typeof SCA_P03_GRAPH_COMPONENT_V1_SCHEMA
    | typeof SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA;
  content_base64: string;
  byte_length: number;
  content_sha256: string;
}>;

type SourceFile = Readonly<{
  path: string;
  content_sha256: string;
  bytes: Uint8Array;
  role: "primary" | "contextual";
}>;

export type ScaP03RuntimeFixtureV1 = Readonly<{
  fixture_id: string;
  language: "php" | "javascript" | "typescript";
  path: string;
  content_sha256: string;
  bytes: Uint8Array;
}>;

export type ScaP03FrozenQueryV1 = Readonly<{
  query_id: ScaP03QueryId;
  script_id: string;
  script_sha256: string;
  binding: ScaP03QueryBindingV2;
  plan: ScaP03QueryPlanV2;
}>;

export type ScaP03FrozenQueryReleaseV1 = Readonly<{
  query_set_id: string;
  release_id: string;
  release_sha256: string;
  queries: readonly ScaP03FrozenQueryV1[];
}>;

export interface ScaP03RuntimeQualificationOutputV1 {
  readonly executed_query_release_sha256: string;
  readonly cases: readonly ScaP03QualificationCaseV2[];
}

export interface ScaP03RuntimeGraphOutputV1 {
  readonly graph_bytes: Uint8Array;
  readonly accounted_files: readonly Readonly<{
    path: string;
    content_sha256: string;
    disposition: "parsed" | "contextual" | "unsupported" | "failed";
    reason_code: string | null;
  }>[];
  readonly graph_opened: boolean;
  readonly cleanup_evidence: ScaP03GraphCleanupEvidenceV1;
}

export interface ScaP03RuntimeQueryOutputV1 {
  readonly executed_query_release_sha256: string;
  readonly pages: readonly Readonly<{
    query_id: ScaP03QueryId;
    page_number: number;
    items: readonly ScaP03QueryCandidateV2[];
    complete: boolean;
  }>[];
  readonly fidelity_observations: readonly ScaP03FidelityObservationV2[];
  readonly truncated: boolean;
}

interface ScaP03JoernRuntimeCommonV1 {
  readonly runtime_id: string;
  readonly isolation_id: string;
  readonly runtime_tree_sha256: string;
  readonly isolation_profile_sha256: string;
  readonly implementation_identity_sha256: string;
  readonly deployment_identity_sha256: string;
  qualify(input: {
    readonly request: ScaP03QualificationRequestV2;
    readonly context?: HostOperationExecutionContextV1;
    readonly fixtures: readonly ScaP03RuntimeFixtureV1[];
    readonly expected_cases: ScaP03QualificationFixtureCorpusV2["expected_cases"];
    readonly source_oracle_validation_ref?: ArtifactRef;
    readonly source_oracle_validation_receipt?: SourceOracleValidationReceipt;
    readonly query_release: ScaP03FrozenQueryReleaseV1;
    readonly fidelity_requirements: readonly ScaP03FidelityRequirementV1[];
    readonly signal: AbortSignal;
  }): Promise<ScaP03RuntimeQualificationOutputV1>;
  buildGraph(input: {
    readonly request: ScaP03GraphBuildRequestV1;
    readonly context?: HostOperationExecutionContextV1;
    readonly files: readonly SourceFile[];
    readonly signal: AbortSignal;
  }): Promise<ScaP03RuntimeGraphOutputV1>;
  runBaselineQueries(input: {
    readonly request: ScaP03BaselineQueryBatchRequestV2;
    readonly context?: HostOperationExecutionContextV1;
    readonly query_release: ScaP03FrozenQueryReleaseV1;
    readonly graph_bytes: Uint8Array;
    readonly accounted_files: readonly Readonly<{
      path: string;
      content_sha256: string;
      disposition: "parsed" | "contextual" | "unsupported" | "failed";
      reason_code: string | null;
    }>[];
    readonly signal: AbortSignal;
  }): Promise<ScaP03RuntimeQueryOutputV1>;
}

export type ScaP03JoernRuntimeV1 = ScaP03JoernRuntimeCommonV1 &
  (
    | Readonly<{
        runtime_kind: "simulated_joern_test_runtime";
        qualification_scope: "deterministic_test_only";
        simulation_label: "simulated_joern_test_seam";
      }>
    | Readonly<{
        runtime_kind: "host_qualified_joern";
        qualification_scope: "live_qualified";
        host_attestation_id: string;
        host_attestation_sha256: string;
        host_attestation_ref: ArtifactRef;
        source_oracle_ref: ArtifactRef;
        source_oracle_validation_ref: ArtifactRef;
        parser_identity_sha256: string;
        staging_parent: string;
        measured_joern_version: string;
        max_num_def: number;
      }>
  );

export interface ScaP03OperationAdapterOptionsV1 {
  readonly runtime?: ScaP03JoernRuntimeV1;
  readonly now?: () => Date;
  readonly local_recovery?: Readonly<{
    prove_prior_process_terminated?: (input: {
      readonly operation_kind: ScaP03OperationKind;
      readonly request_sha256: string;
      readonly prior_correlation_id: string;
    }) => boolean | Promise<boolean>;
  }>;
  readonly fault?: (
    point: "before_result_cache" | "after_result_cached",
    operation: ScaP03OperationKind,
    partition: ScaP03Partition | null
  ) => void;
}

function parseCanonical(bytes: Uint8Array, label: string): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not JSON`, { cause: error });
  }
  if (canonicalJson(value) !== text) throw new Error(`${label} is not canonical JSON`);
  return value;
}

function dynamicSlot(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(4, "0")}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertInputRef(
  context: HostOperationExecutionContextV1,
  slot: string,
  expectedRef: ArtifactRef
): Uint8Array {
  const input = context.readInput(slot);
  if (!same(input.ref, expectedRef) || sha256(input.bytes) !== expectedRef.content_digest) {
    throw new Error(`p03_exact_input_mismatch:${slot}`);
  }
  return input.bytes;
}

function validateCommonInputs(
  context: HostOperationExecutionContextV1,
  request: ScaP03OperationRequestV1,
  runtime: ScaP03JoernRuntimeV1 | undefined
): {
  readonly policy: ReturnType<typeof validateScaP03RuntimePolicyV1>;
  readonly profile: ReturnType<typeof validateScaP03QualificationProfileV2>;
} {
  assertInputRef(context, "p03_request", request.p03_request_ref);
  const policyBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.runtime_policy,
    request.runtime_policy_ref
  );
  const policy = validateScaP03RuntimePolicyV1(parseCanonical(policyBytes, "P03 runtime policy"));
  // Check the private runtime path before any execution or cached-result recovery,
  // regardless of the request's claimed scope or attestation presence.
  if (
    runtime?.runtime_kind === "host_qualified_joern" &&
    sha256(runtime.staging_parent) !== policy.staging_parent_sha256
  )
    throw new Error("p03_runtime_staging_parent_mismatch");
  const identityBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.runtime_identity,
    request.joern_runtime_identity_ref
  );
  const isolationBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.isolation_evidence,
    request.isolation_evidence_ref
  );
  const implementationBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.implementation_identity,
    request.implementation_identity_ref
  );
  const isolation = validateScaP03IsolationEvidenceV1(
    parseCanonical(isolationBytes, "P03 isolation evidence")
  );
  const implementation = validateScaP03ImplementationIdentityV1(
    parseCanonical(implementationBytes, "P03 implementation identity")
  );
  if (
    implementation.implementation_sha256 !== isolation.implementation_identity_sha256 ||
    (runtime !== undefined &&
      (runtime.implementation_identity_sha256 !== isolation.implementation_identity_sha256 ||
        runtime.deployment_identity_sha256 !== isolation.deployment_identity_sha256))
  ) {
    throw new Error("p03_runtime_implementation_or_deployment_mismatch");
  }
  const profileBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.qualification_profile,
    request.qualification_profile_ref
  );
  const profile = validateScaP03QualificationProfileV2(
    parseCanonical(profileBytes, "P03 qualification profile")
  );
  if (request.qualification_scope === "live_qualified") {
    const identity = validateScaP03JoernRuntimeIdentityV1(
      parseCanonical(identityBytes, "P03 Joern runtime identity")
    );
    if (
      identity.runtime_id !== request.runtime_id ||
      identity.runtime_kind !== request.runtime_kind ||
      identity.qualification_scope !== request.qualification_scope ||
      identity.runtime_tree_sha256 !== request.runtime_tree_sha256 ||
      isolation.runtime_id !== request.runtime_id ||
      isolation.isolation_id !== request.isolation_id ||
      isolation.runtime_tree_sha256 !== request.runtime_tree_sha256 ||
      isolation.profile_sha256 !== request.isolation_profile_sha256
    )
      throw new Error("p03_runtime_identity_custody_mismatch");
    if (request.host_isolation_attestation_ref !== null) {
      const attestation = validateScaP03HostIsolationAttestationV1(
        parseCanonical(
          assertInputRef(
            context,
            SCA_P03_INPUT_SLOTS.host_attestation,
            request.host_isolation_attestation_ref
          ),
          "P03 host attestation"
        )
      );
      if (
        isolation.qualification_scope !== "live_qualified" ||
        !same(isolation.host_attestation_ref, request.host_isolation_attestation_ref) ||
        isolation.host_attestation_id !== attestation.attestation_id ||
        isolation.host_attestation_sha256 !==
          request.host_isolation_attestation_ref.content_digest ||
        attestation.runtime_id !== request.runtime_id ||
        attestation.isolation_id !== request.isolation_id ||
        attestation.runtime_tree_sha256 !== request.runtime_tree_sha256 ||
        attestation.implementation_identity_sha256 !== implementation.implementation_sha256 ||
        attestation.deployment_identity_sha256 !== isolation.deployment_identity_sha256 ||
        attestation.profile_sha256 !== isolation.profile_sha256 ||
        attestation.profile_sha256 !== profile.profile_sha256 ||
        attestation.profile_id !== profile.profile_id ||
        isolation.profile_id !== profile.profile_id ||
        (runtime?.runtime_kind === "host_qualified_joern" &&
          (runtime.host_attestation_id !== attestation.attestation_id ||
            runtime.measured_joern_version !== identity.joern_version ||
            runtime.max_num_def !== policy.max_num_def))
      )
        throw new Error("p03_host_attestation_custody_mismatch");
    }
  }
  if (
    (request.operation_kind === "build_source_graph" &&
      (request.max_graph_bytes !== policy.max_graph_bytes ||
        request.max_num_def !== policy.max_num_def)) ||
    (request.operation_kind === "run_baseline_query_batch" &&
      (request.max_query_output_bytes !== policy.max_query_output_bytes ||
        request.max_query_items !== policy.max_query_items ||
        request.max_page_items !== policy.max_page_items ||
        request.max_pages_per_query !== policy.max_pages_per_query ||
        !same(
          request.fidelity_requirements,
          profile.fidelity_requirements.filter((entry) => entry.partition === request.partition)
        )))
  ) {
    throw new Error("p03_operation_request_policy_or_profile_drift");
  }
  return { policy, profile };
}

function runtimeMatches(
  runtime: ScaP03JoernRuntimeV1 | undefined,
  request: ScaP03OperationRequestV1
): runtime is ScaP03JoernRuntimeV1 {
  if (
    runtime === undefined ||
    runtime.runtime_id !== request.runtime_id ||
    runtime.runtime_kind !== request.runtime_kind ||
    runtime.qualification_scope !== request.qualification_scope ||
    runtime.runtime_tree_sha256 !== request.runtime_tree_sha256 ||
    runtime.isolation_id !== request.isolation_id ||
    runtime.isolation_profile_sha256 !== request.isolation_profile_sha256
  ) {
    return false;
  }
  if (runtime.qualification_scope === "deterministic_test_only") {
    return (
      runtime.simulation_label === "simulated_joern_test_seam" &&
      request.host_isolation_attestation_ref === null
    );
  }
  return (
    isVerifiedScaP03DockerHostRuntimeV1(runtime) &&
    request.host_isolation_attestation_ref !== null &&
    runtime.host_attestation_sha256 === request.host_isolation_attestation_ref.content_digest &&
    same(runtime.host_attestation_ref, request.host_isolation_attestation_ref) &&
    (request.operation_kind !== "qualify_joern" ||
      (same(runtime.source_oracle_ref, request.source_oracle_ref) &&
        same(runtime.source_oracle_validation_ref, request.source_oracle_validation_ref)))
  );
}

function resultCommon(request: ScaP03OperationRequestV1, now: Date) {
  return {
    schema_version: 1 as const,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    phase_id: request.phase_id,
    operation_id: request.operation_id,
    request_sha256: request.request_sha256,
    p01_binding_sha256: request.p01_binding_sha256,
    p02_binding_sha256: request.p02_binding_sha256,
    p03_runtime_binding_sha256: request.p03_runtime_binding_sha256,
    source_snapshot_ref: request.source_snapshot_ref,
    source_snapshot_sha256: request.source_snapshot_sha256,
    runtime_id: request.runtime_id,
    runtime_kind: request.runtime_kind,
    qualification_scope: request.qualification_scope,
    runtime_tree_sha256: request.runtime_tree_sha256,
    isolation_id: request.isolation_id,
    isolation_profile_sha256: request.isolation_profile_sha256,
    completed_at: now.toISOString(),
  };
}

function qualificationBlockerCode(code: string): ScaP03QualificationBlockerCodeV2 {
  switch (code) {
    case "joern_runtime_unavailable":
    case "joern_qualification_failed":
    case "operation_timeout":
    case "p03_fixture_custody_invalid":
      return code;
    default:
      return "p03_qualification_runtime_failed";
  }
}

function qualificationCases(blocker_code: ScaP03QualificationBlockerCodeV2) {
  return (["php", "javascript", "typescript"] as const).flatMap((language) =>
    SCA_P03_QUERY_IDS.map((queryId) => ({
      case_id: `p03-${language}-${queryId.replaceAll(".", "-")}`,
      language,
      query_id: queryId,
      frontend_language: scaP03FrontendLanguageV1(language),
      status: "blocked" as const,
      blocker_code,
      fixture_id: null,
      fixture_sha256: null,
      observation_count: 0,
      observations: [],
      observed_sha256: scaP03QualificationObservationSha256V2({
        fixture_id: null,
        fixture_sha256: null,
        query_id: queryId,
        frontend_language: scaP03FrontendLanguageV1(language),
        release_sha256: null,
        blocker_code,
        observations: [],
      }),
    }))
  );
}

function cleanupEvidence(input: {
  readonly workspace_removed: boolean;
  readonly graph_handles_closed: boolean;
  readonly process_exit_observed: boolean;
}): ScaP03GraphCleanupEvidenceV1 {
  return { ...input, cleanup_sha256: sha256(canonicalJson(input)) };
}

function blockedResult(
  request: ScaP03OperationRequestV1,
  code: string,
  now: Date
): ScaP03OperationResultV1 {
  const common = {
    ...resultCommon(request, now),
    status: "blocked" as const,
    blocker_codes: [code],
  };
  if (request.operation_kind === "qualify_joern") {
    return validateScaP03OperationResultV1(
      request.operation_kind,
      request,
      withScaP03Digest(
        {
          schema_id: SCA_P03_QUALIFICATION_RESULT_V2_SCHEMA,
          ...common,
          schema_version: 2,
          operation_kind: request.operation_kind,
          qualified: false,
          executed_query_release_sha256: null,
          cases: qualificationCases(qualificationBlockerCode(code)),
          fixture_corpus_ref: request.fixture_corpus_ref,
          source_oracle_ref: request.source_oracle_ref,
          source_oracle_validation_ref: request.source_oracle_validation_ref,
          parser_identity_sha256: null,
          baseline_query_set_ref: request.baseline_query_set_ref,
        },
        "result_sha256"
      )
    );
  }
  if (request.operation_kind === "build_source_graph") {
    return validateScaP03OperationResultV1(
      request.operation_kind,
      request,
      withScaP03Digest(
        {
          schema_id: SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA,
          ...common,
          operation_kind: request.operation_kind,
          partition: request.partition,
          frontend_language: request.frontend_language,
          graph: null,
          graph_build_key_sha256: graphBuildKey(request),
          graph_id: null,
          accounted_files: request.expected_files.map((file) => ({
            path: file.path,
            content_sha256: file.content_sha256,
            disposition: "failed" as const,
            reason_code: code,
          })),
          graph_opened: false,
          // Only used before runtime dispatch or after a returned, verified cleanup report.
          cleanup_status: "proven" as const,
          cleanup_evidence: cleanupEvidence({
            workspace_removed: true,
            graph_handles_closed: true,
            process_exit_observed: true,
          }),
          complete: false,
        },
        "result_sha256"
      )
    );
  }
  return validateScaP03OperationResultV1(
    request.operation_kind,
    request,
    withScaP03Digest(
      {
        schema_id: SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA,
        ...common,
        schema_version: 2,
        operation_kind: request.operation_kind,
        partition: request.partition,
        graph_component_ref: request.graph_component_ref,
        graph_component_sha256: request.graph_component_sha256,
        graph_build_result_ref: request.graph_build_result_ref,
        baseline_query_set_ref: request.baseline_query_set_ref,
        executed_query_release_sha256: null,
        page_descriptors: [],
        query_footers: [],
        fidelity_observations: [],
        complete: false,
        truncated: false,
      },
      "result_sha256"
    )
  );
}

function graphBuildKey(request: ScaP03GraphBuildRequestV1): string {
  return sha256(
    canonicalJson({
      partition: request.partition,
      frontend_language: request.frontend_language,
      source_snapshot_sha256: request.source_snapshot_sha256,
      expected_files: request.expected_files,
      runtime_tree_sha256: request.runtime_tree_sha256,
      implementation_identity_ref: request.implementation_identity_ref,
      max_num_def: request.max_num_def,
    })
  );
}

function qualificationResult(
  request: ScaP03QualificationRequestV2,
  expectedCases: ScaP03QualificationFixtureCorpusV2["expected_cases"],
  fixtures: readonly ScaP03RuntimeFixtureV1[],
  release: ScaP03FrozenQueryReleaseV1,
  output: ScaP03RuntimeQualificationOutputV1,
  now: Date,
  parser_identity_sha256: string
): ScaP03QualificationResultV2 {
  const allPassed =
    output.executed_query_release_sha256 === release.release_sha256 &&
    output.cases.length === expectedCases.length &&
    output.cases.every((entry, index) => {
      const expected = expectedCases[index];
      return (
        expected !== undefined &&
        entry.case_id === expected.case_id &&
        entry.language === expected.language &&
        entry.query_id === expected.query_id &&
        (() => {
          const fixture = fixtures.find((fixture) => fixture.language === entry.language);
          return (
            fixture !== undefined &&
            scaP03QualificationCaseMatchesV2(
              entry,
              expected,
              fixture,
              release.release_sha256,
              request.source_oracle_validation_ref
            )
          );
        })()
      );
    });
  const blockers = allPassed ? [] : ["qualification_case_failed"];
  const status = blockers.length === 0 ? ("complete" as const) : ("blocked" as const);
  const result = validateScaP03OperationResultV1(
    request.operation_kind,
    request,
    withScaP03Digest(
      {
        schema_id: SCA_P03_QUALIFICATION_RESULT_V2_SCHEMA,
        ...resultCommon(request, now),
        schema_version: 2,
        operation_kind: request.operation_kind,
        status,
        blocker_codes: blockers,
        qualified: allPassed && request.qualification_scope === "live_qualified",
        executed_query_release_sha256: output.executed_query_release_sha256,
        cases: output.cases,
        fixture_corpus_ref: request.fixture_corpus_ref,
        source_oracle_ref: request.source_oracle_ref,
        source_oracle_validation_ref: request.source_oracle_validation_ref,
        parser_identity_sha256,
        baseline_query_set_ref: request.baseline_query_set_ref,
      },
      "result_sha256"
    )
  );
  validateScaP03QualificationResultProjectionV2(
    result,
    expectedCases,
    request.source_oracle_validation_ref
  );
  return result;
}

function readSourceFiles(
  context: HostOperationExecutionContextV1,
  request: ScaP03GraphBuildRequestV1
): readonly SourceFile[] {
  const manifestInput = context.readInput(SCA_P03_INPUT_SLOTS.source_file_manifest);
  const custodyInput = context.readInput(SCA_P03_INPUT_SLOTS.source_custody);
  if (
    !same(manifestInput.ref, request.source_file_manifest_ref) ||
    !same(custodyInput.ref, request.source_custody_ref)
  ) {
    throw new Error("p03_source_custody_ref_mismatch");
  }
  const manifest = validateScaP01SourceFileManifestV1(
    parseCanonical(manifestInput.bytes, "P03 source manifest")
  );
  const custody = validateScaP01SourceCustodyCorpusV1(
    parseCanonical(custodyInput.bytes, "P03 source custody")
  );
  validateScaP01SourceMaterialV1({
    snapshot: {
      schema_id: "penny.sca-campaign-source-snapshot.v2",
      schema_version: 2,
      snapshot_id: manifest.snapshot_id,
      tree_sha256: manifest.tree_sha256,
      file_manifest_ref: manifestInput.ref,
      file_manifest_sha256: manifestInput.ref.content_digest,
      custody_ref: custodyInput.ref,
      custody_sha256: custodyInput.ref.content_digest,
      scope: manifest.scope,
      file_count: manifest.file_count,
      byte_count: manifest.byte_count,
      status: "frozen",
    },
    file_manifest_ref: manifestInput.ref,
    file_manifest: manifest,
    custody_ref: custodyInput.ref,
    custody,
  });
  const expected = new Map(request.expected_files.map((file) => [file.path, file]));
  if (expected.size !== manifest.files.length) throw new Error("p03_source_manifest_set_mismatch");
  return manifest.files.map((file) => {
    const requestFile = expected.get(file.path);
    const custodyFile = custody.files.find((entry) => entry.path === file.path);
    if (
      requestFile === undefined ||
      custodyFile === undefined ||
      requestFile.content_sha256 !== file.content_sha256 ||
      custodyFile.content_sha256 !== file.content_sha256
    ) {
      throw new Error("p03_source_snapshot_file_mismatch");
    }
    return {
      path: file.path,
      content_sha256: file.content_sha256,
      bytes: Buffer.from(custodyFile.content_base64, "base64"),
      role: requestFile.role,
    };
  });
}

class ScaP03OperationConstraintError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ScaP03OperationConstraintError";
  }
}

function constraintCode(error: unknown, fallback: string): string {
  return error instanceof ScaP03OperationConstraintError ? error.code : fallback;
}

function rethrowIfTerminationUnproven(error: unknown): void {
  if (
    (error instanceof Error && error.message === "p03_cleanup_unproven") ||
    (error instanceof ScaP03OperationConstraintError && error.code === "operation_timeout")
  )
    throw error;
}

function graphResult(
  request: ScaP03GraphBuildRequestV1,
  output: ScaP03RuntimeGraphOutputV1,
  now: Date
): ScaP03GraphBuildResultV1 {
  const expectedCleanupSha256 = sha256(
    canonicalJson({
      workspace_removed: output.cleanup_evidence.workspace_removed,
      graph_handles_closed: output.cleanup_evidence.graph_handles_closed,
      process_exit_observed: output.cleanup_evidence.process_exit_observed,
    })
  );
  if (output.cleanup_evidence.cleanup_sha256 !== expectedCleanupSha256) {
    throw new Error("p03_cleanup_unproven");
  }
  const cleanupProven =
    output.cleanup_evidence.workspace_removed &&
    output.cleanup_evidence.graph_handles_closed &&
    output.cleanup_evidence.process_exit_observed;
  if (!cleanupProven) throw new Error("p03_cleanup_unproven");
  const graphBytes = Buffer.from(output.graph_bytes);
  if (graphBytes.byteLength === 0 || graphBytes.byteLength > request.max_graph_bytes) {
    throw new ScaP03OperationConstraintError("graph_output_limit_exceeded");
  }
  const graphBlockers = [
    ...(output.graph_opened ? [] : ["graph_open_failed"]),
    ...(cleanupProven ? [] : ["cleanup_unproven"]),
    ...(output.accounted_files.some(
      (file) => file.disposition === "unsupported" || file.disposition === "failed"
    )
      ? ["graph_file_unsupported"]
      : []),
  ];
  const graphDescriptor = {
    media_type: "application/vnd.penny.joern-cpg" as const,
    content_schema_id: SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
    byte_length: graphBytes.byteLength,
    content_sha256: sha256(graphBytes),
  };
  const buildKey = graphBuildKey(request);
  const graphComplete = graphBlockers.length === 0;
  return validateScaP03OperationResultV1(
    request.operation_kind,
    request,
    withScaP03Digest(
      {
        schema_id: SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA,
        ...resultCommon(request, now),
        operation_kind: request.operation_kind,
        status: graphComplete ? ("complete" as const) : ("blocked" as const),
        blocker_codes: graphBlockers,
        partition: request.partition,
        frontend_language: request.frontend_language,
        graph: graphComplete ? graphDescriptor : null,
        graph_build_key_sha256: buildKey,
        graph_id: graphComplete
          ? `p03graph_${sha256(
              canonicalJson({
                graph_build_key_sha256: buildKey,
                content_sha256: graphDescriptor.content_sha256,
              })
            )}`
          : null,
        accounted_files: output.accounted_files,
        graph_opened: output.graph_opened,
        cleanup_status: cleanupProven ? ("proven" as const) : ("unproven" as const),
        cleanup_evidence: output.cleanup_evidence,
        complete: graphComplete,
      },
      "result_sha256"
    )
  );
}

function queryPage(
  request: ScaP03BaselineQueryBatchRequestV2,
  page: ScaP03RuntimeQueryOutputV1["pages"][number],
  release: ScaP03FrozenQueryReleaseV1,
  accountedPaths: readonly string[]
): ScaP03BaselineQueryPageV2 {
  return validateScaP03BaselineQueryPageV2(
    withScaP03Digest(
      {
        schema_id: SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA,
        schema_version: 2,
        run_id: request.run_id,
        phase_id: request.phase_id,
        partition: request.partition,
        source_snapshot_ref: request.source_snapshot_ref,
        source_snapshot_sha256: request.source_snapshot_sha256,
        graph_component_ref: request.graph_component_ref,
        graph_component_sha256: request.graph_component_sha256,
        baseline_query_set_ref: request.baseline_query_set_ref,
        query_release_sha256: release.release_sha256,
        accounted_paths: accountedPaths,
        query_id: page.query_id,
        page_number: page.page_number,
        items: page.items,
        item_count: page.items.length,
        complete: page.complete,
      },
      "page_sha256"
    )
  );
}

function queryResult(
  request: ScaP03BaselineQueryBatchRequestV2,
  pages: readonly ScaP03BaselineQueryPageV2[],
  output: ScaP03RuntimeQueryOutputV1,
  release: ScaP03FrozenQueryReleaseV1,
  now: Date
): ScaP03BaselineQueryBatchResultV2 {
  if (output.executed_query_release_sha256 !== release.release_sha256) {
    throw new ScaP03OperationConstraintError("query_release_mismatch");
  }
  if (pages.length > SCA_P03_MAX_QUERY_PAGES) {
    throw new ScaP03OperationConstraintError("query_page_limit_exceeded");
  }
  const observedKeys = pages.map((page) => `${page.query_id}\u0000${String(page.page_number)}`);
  const expectedKeys = SCA_P03_QUERY_IDS.flatMap((queryId) => {
    const count = pages.filter((page) => page.query_id === queryId).length;
    if (count === 0 || count > request.max_pages_per_query) {
      throw new ScaP03OperationConstraintError("query_page_limit_exceeded");
    }
    return Array.from({ length: count }, (_, index) => `${queryId}\u0000${String(index + 1)}`);
  });
  if (!same(observedKeys, expectedKeys) || new Set(observedKeys).size !== observedKeys.length) {
    throw new ScaP03OperationConstraintError("query_pages_noncontiguous_or_duplicate");
  }
  if (pages.some((page) => page.item_count > request.max_page_items)) {
    throw new ScaP03OperationConstraintError("query_page_item_limit_exceeded");
  }
  const totalItems = pages.reduce((sum, page) => sum + page.item_count, 0);
  if (totalItems > request.max_query_items) {
    throw new ScaP03OperationConstraintError("query_item_limit_exceeded");
  }
  const candidateIds = pages.flatMap((page) => page.items.map((item) => item.candidate_id));
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new ScaP03OperationConstraintError("query_candidate_duplicate");
  }
  if (
    !same(
      output.fidelity_observations.map((entry) => entry.requirement_id),
      request.fidelity_requirements.map((entry) => entry.requirement_id)
    ) ||
    output.fidelity_observations.some(
      (entry) => (entry.support === "supported") !== (entry.reason_code === null)
    )
  ) {
    throw new ScaP03OperationConstraintError("fidelity_observation_mismatch");
  }
  for (const queryId of SCA_P03_QUERY_IDS) {
    const queryPages = pages.filter((page) => page.query_id === queryId);
    if (
      queryPages.some(
        (page, index) => page.complete !== (!output.truncated && index === queryPages.length - 1)
      )
    ) {
      throw new ScaP03OperationConstraintError("query_page_completion_mismatch");
    }
  }
  const pageBytes = pages.map((page) => Buffer.from(canonicalJson(page), "utf8"));
  const totalBytes = pageBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  if (totalBytes > request.max_query_output_bytes) {
    throw new ScaP03OperationConstraintError("query_output_limit_exceeded");
  }
  const descriptors = pages.map((page, index) => {
    const bytes = pageBytes[index];
    if (bytes === undefined) throw new Error("p03_query_page_bytes_missing");
    return {
      query_id: page.query_id,
      page_number: page.page_number,
      item_count: page.item_count,
      byte_length: bytes.byteLength,
      content_sha256: sha256(bytes),
    };
  });
  const footers = SCA_P03_QUERY_IDS.map((queryId) => {
    const queryPages = descriptors.filter((page) => page.query_id === queryId);
    return {
      query_id: queryId,
      item_count: queryPages.reduce((sum, page) => sum + page.item_count, 0),
      byte_count: queryPages.reduce((sum, page) => sum + page.byte_length, 0),
      page_count: queryPages.length,
      complete:
        !output.truncated &&
        pages.filter((page) => page.query_id === queryId).at(-1)?.complete === true,
    };
  });
  const blockers = output.truncated ? ["query_truncated"] : [];
  const status = output.truncated ? ("truncated" as const) : ("complete" as const);
  return validateScaP03OperationResultV1(
    request.operation_kind,
    request,
    withScaP03Digest(
      {
        schema_id: SCA_P03_BASELINE_QUERY_BATCH_RESULT_V2_SCHEMA,
        ...resultCommon(request, now),
        schema_version: 2,
        operation_kind: request.operation_kind,
        status,
        blocker_codes: blockers,
        partition: request.partition,
        graph_component_ref: request.graph_component_ref,
        graph_component_sha256: request.graph_component_sha256,
        graph_build_result_ref: request.graph_build_result_ref,
        baseline_query_set_ref: request.baseline_query_set_ref,
        executed_query_release_sha256: output.executed_query_release_sha256,
        page_descriptors: descriptors,
        query_footers: footers,
        fidelity_observations: output.fidelity_observations,
        complete: !output.truncated,
        truncated: output.truncated,
      },
      "result_sha256"
    )
  );
}

function cacheOutput(input: {
  readonly artifact_kind: CacheOutput["artifact_kind"];
  readonly media_type: CacheOutput["media_type"];
  readonly content_schema_id: CacheOutput["content_schema_id"];
  readonly bytes: Uint8Array;
}): CacheOutput {
  const bytes = Buffer.from(input.bytes);
  return {
    artifact_kind: input.artifact_kind,
    media_type: input.media_type,
    content_schema_id: input.content_schema_id,
    content_base64: bytes.toString("base64"),
    byte_length: bytes.byteLength,
    content_sha256: sha256(bytes),
  };
}

function validateCacheOutputs(
  request: ScaP03OperationRequestV1,
  result: ScaP03OperationResultV1,
  outputs: readonly CacheOutput[],
  expectedCases?: ScaP03QualificationFixtureCorpusV2["expected_cases"]
): void {
  if (request.operation_kind === "qualify_joern") {
    if (result.operation_kind !== "qualify_joern") {
      throw new Error("p03_qualification_cache_result_kind_drift");
    }
    if (outputs.length !== 0) throw new Error("p03_qualification_cache_has_outputs");
    if (result.executed_query_release_sha256 !== null) {
      if (expectedCases === undefined) throw new Error("p03_qualification_cache_oracle_missing");
      validateScaP03QualificationResultProjectionV2(
        result,
        expectedCases,
        request.source_oracle_validation_ref
      );
    }
    for (const entry of result.cases)
      validateScaP03QualificationCaseObservationsV2(
        entry,
        result.executed_query_release_sha256,
        undefined,
        request.source_oracle_validation_ref
      );
    return;
  }
  if (request.operation_kind === "build_source_graph") {
    if (result.operation_kind !== "build_source_graph") {
      throw new Error("p03_graph_cache_result_kind_drift");
    }
    const graphResultValue = result;
    if (graphResultValue.graph === null) {
      if (outputs.length !== 0) throw new Error("p03_blocked_graph_cache_has_output");
      return;
    }
    const graph = outputs[0];
    if (
      outputs.length !== 1 ||
      graph === undefined ||
      graph.artifact_kind !== GRAPH_CONTRACT.artifact_kind ||
      graph.media_type !== "application/vnd.penny.joern-cpg" ||
      graph.content_schema_id !== GRAPH_CONTRACT.schema_id ||
      graph.content_sha256 !== graphResultValue.graph.content_sha256 ||
      graph.byte_length !== graphResultValue.graph.byte_length
    ) {
      throw new Error("p03_graph_cache_binding_failed");
    }
    return;
  }
  if (result.operation_kind !== "run_baseline_query_batch") {
    throw new Error("p03_query_cache_result_kind_drift");
  }
  const queryResultValue = result;
  if (queryResultValue.status === "blocked") {
    if (outputs.length !== 0) throw new Error("p03_blocked_query_cache_has_outputs");
    return;
  }
  if (
    outputs.length !== queryResultValue.page_descriptors.length ||
    outputs.some((output, index) => {
      const descriptor = queryResultValue.page_descriptors[index];
      return (
        descriptor === undefined ||
        output.artifact_kind !== PAGE_CONTRACT.artifact_kind ||
        output.media_type !== "application/json" ||
        output.content_schema_id !== PAGE_CONTRACT.schema_id ||
        output.content_sha256 !== descriptor.content_sha256 ||
        output.byte_length !== descriptor.byte_length
      );
    })
  ) {
    throw new Error("p03_query_cache_binding_failed");
  }
  const pages = outputs.map((output) =>
    validateScaP03BaselineQueryPageV2(
      parseCanonical(
        Buffer.from(output.content_base64, "base64"),
        "SCA P03 cached baseline query page"
      )
    )
  );
  for (const [index, page] of pages.entries()) {
    const descriptor = queryResultValue.page_descriptors[index];
    if (
      descriptor === undefined ||
      descriptor.query_id !== page.query_id ||
      descriptor.page_number !== page.page_number ||
      descriptor.item_count !== page.item_count ||
      page.run_id !== request.run_id ||
      page.phase_id !== request.phase_id ||
      page.partition !== request.partition ||
      !same(page.source_snapshot_ref, request.source_snapshot_ref) ||
      page.source_snapshot_sha256 !== request.source_snapshot_sha256 ||
      !same(page.graph_component_ref, request.graph_component_ref) ||
      page.graph_component_sha256 !== request.graph_component_sha256 ||
      !same(page.baseline_query_set_ref, request.baseline_query_set_ref)
    ) {
      throw new Error("p03_query_page_round_trip_binding_failed");
    }
  }
  for (const queryId of SCA_P03_QUERY_IDS) {
    const queryPages = pages.filter((page) => page.query_id === queryId);
    if (
      queryPages.some(
        (page, index) =>
          page.complete !== (!queryResultValue.truncated && index === queryPages.length - 1)
      )
    ) {
      throw new Error("p03_query_page_round_trip_completion_failed");
    }
  }
}

function parseCache(
  bytes: Uint8Array,
  request: ScaP03OperationRequestV1,
  expectedCases?: ScaP03QualificationFixtureCorpusV2["expected_cases"]
): { readonly result: ScaP03OperationResultV1; readonly outputs: readonly CacheOutput[] } {
  const envelope = validateContract(
    CacheEnvelopeSchema,
    parseCanonical(bytes, "SCA P03 cached operation envelope"),
    "SCA P03 cached operation envelope"
  );
  if (envelope.operation_kind !== request.operation_kind) {
    throw new Error("p03_cached_operation_kind_drift");
  }
  const result = validateScaP03OperationResultV1(request.operation_kind, request, envelope.result);
  for (const output of envelope.outputs) {
    const decoded = Buffer.from(output.content_base64, "base64");
    if (
      decoded.byteLength !== output.byte_length ||
      decoded.toString("base64") !== output.content_base64 ||
      sha256(decoded) !== output.content_sha256
    ) {
      throw new Error("p03_cached_output_digest_drift");
    }
    if (output.artifact_kind === "sca-p03-baseline-query-page") {
      validateScaP03BaselineQueryPageV2(
        parseCanonical(decoded, "SCA P03 cached baseline query page")
      );
    }
  }
  validateCacheOutputs(request, result, envelope.outputs, expectedCases);
  return { result, outputs: envelope.outputs };
}

function outputContract(output: CacheOutput): HostOperationArtifactContractV1 {
  return output.artifact_kind === "sca-p03-graph-component" ? GRAPH_CONTRACT : PAGE_CONTRACT;
}

async function persistResult(input: {
  readonly context: HostOperationExecutionContextV1;
  readonly request: ScaP03OperationRequestV1;
  readonly result: ScaP03OperationResultV1;
  readonly outputs: readonly CacheOutput[];
  readonly options: ScaP03OperationAdapterOptionsV1;
  readonly alreadyCached: boolean;
  readonly expectedCases: ScaP03QualificationFixtureCorpusV2["expected_cases"] | undefined;
}): Promise<HostOperationAdapterTerminalV1> {
  validateCacheOutputs(input.request, input.result, input.outputs, input.expectedCases);
  // A cached blocked result is not host termination evidence either.
  if (
    input.result.operation_kind === "build_source_graph" &&
    input.result.cleanup_status !== "proven"
  )
    throw new Error("p03_cleanup_unproven");
  if (!input.alreadyCached) {
    input.options.fault?.(
      "before_result_cache",
      input.request.operation_kind,
      "partition" in input.request ? input.request.partition : null
    );
  }
  const envelopeBytes = Buffer.from(
    canonicalJson({
      schema_id: "penny.sca-p03-operation-cache.v1",
      schema_version: 1,
      operation_kind: input.request.operation_kind,
      result: input.result,
      outputs: input.outputs,
    }),
    "utf8"
  );
  if (
    input.outputs.length + 1 > input.context.declaration.max_output_artifacts ||
    envelopeBytes.byteLength > input.context.declaration.max_output_bytes
  ) {
    throw new Error("p03_operation_cache_exceeds_registered_capacity");
  }
  const cached = await input.context.cacheResult(envelopeBytes);
  if (
    cached.content_sha256 !== sha256(envelopeBytes) ||
    cached.byte_length !== envelopeBytes.byteLength
  ) {
    throw new Error("p03_operation_cache_binding_failed");
  }
  if (!input.alreadyCached) {
    input.options.fault?.(
      "after_result_cached",
      input.request.operation_kind,
      "partition" in input.request ? input.request.partition : null
    );
  }
  if (input.context.journal.lifecycle !== "persisting") {
    input.context.recordFetched({
      schema_version: 1,
      content_sha256: cached.content_sha256,
      byte_length: cached.byte_length,
      item_count: input.outputs.length + 1,
      poll_count: 0,
    });
  }
  const disposition = {
    outcome: "completed" as const,
    remote_disposition: "proven_terminal" as const,
    lease_disposition: "released" as const,
    retryable: false as const,
    reason_code: null,
  };
  const persisted = input.context.persist({
    disposition,
    operation_result: {
      contract: input.context.declaration.result,
      media_type: "application/json",
      content: canonicalJson(input.result),
    },
    outputs: input.outputs.map((output) => ({
      contract: outputContract(output),
      media_type: output.media_type,
      content: Buffer.from(output.content_base64, "base64"),
    })),
  });
  return {
    disposition,
    operation_result_ref: persisted.operation_result_ref,
    output_artifacts: persisted.output_artifacts,
  };
}

function beginOrResume(
  context: HostOperationExecutionContextV1,
  request: ScaP03OperationRequestV1
): void {
  const correlationId = `p03_${request.request_sha256}`;
  if (context.journal.lifecycle === "lease_acquired") {
    context.beginSubmission();
    context.recordRemoteAccepted(correlationId);
    return;
  }
  if (
    !["submitted", "fetched", "persisting"].includes(context.journal.lifecycle) ||
    context.journal.remote_correlation_id !== correlationId ||
    context.journal.remote_correlation_sha256 !== sha256(correlationId)
  ) {
    throw new Error("p03_operation_journal_cannot_resume");
  }
}

function operationClock(context: HostOperationExecutionContextV1, now?: () => Date): Date {
  const value = now?.() ?? new Date(context.journal.created_at);
  if (!Number.isFinite(value.getTime())) throw new Error("p03_operation_clock_invalid");
  return value;
}

/** The canonical owner owns renewable active inactivity. A second fixed wall timer here
 * would kill productive work even while owner-accepted progress continues. Transport inactivity
 * and independent bounded cleanup remain runtime responsibilities. */
async function runWithTimeout<T>(input: {
  readonly timeoutMs: number;
  readonly parentSignal: AbortSignal;
  readonly settleOnAbort: boolean;
  readonly execute: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  input.parentSignal.throwIfAborted();
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)
    throw new ScaP03OperationConstraintError("operation_timeout");
  if (input.settleOnAbort) {
    const value = await input.execute(input.parentSignal);
    input.parentSignal.throwIfAborted();
    return value;
  }
  // Simulated test runtimes have no owner-backed work transport. Retain their finite fixture
  // watchdog; this branch is never used by host-qualified or initial live Docker work.
  const controller = new AbortController();
  let rejectAbort: (error: unknown) => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    controller.abort(input.parentSignal.reason);
    rejectAbort(
      input.parentSignal.reason ?? new ScaP03OperationConstraintError("operation_timeout")
    );
  };
  input.parentSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    const error = new ScaP03OperationConstraintError("operation_timeout");
    controller.abort(error);
    rejectAbort(error);
  }, input.timeoutMs);
  try {
    return await Promise.race([input.execute(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    input.parentSignal.removeEventListener("abort", abort);
  }
}

function bindRequest(kind: ScaP03OperationKind, bytes: Uint8Array): ScaP03OperationRequestV1 {
  return validateScaP03OperationRequestV1(
    kind,
    parseCanonical(bytes, `SCA P03 ${kind} operation request`)
  );
}

function inspect(kind: ScaP03OperationKind, input: HostOperationRequestInspectionV1) {
  const request = bindRequest(kind, input.request_bytes);
  return {
    schema_version: 1 as const,
    operation_kind: input.directive.operation_kind,
    adapter_id: input.declaration.adapter_id,
    backend_binding_id: input.declaration.backend_binding_id,
    backend_key_sha256: request.backend_resource_sha256 ?? request.request_sha256,
  };
}

function readFrozenQueryRelease(
  context: HostOperationExecutionContextV1,
  request: Pick<
    ScaP03QualificationRequestV2 | ScaP03BaselineQueryBatchRequestV2,
    "baseline_query_set_ref" | "query_script_refs" | "query_plan_refs"
  >,
  policy: ReturnType<typeof validateScaP03RuntimePolicyV1>
): ScaP03FrozenQueryReleaseV1 {
  const setBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.baseline_query_set,
    request.baseline_query_set_ref
  );
  const set = validateScaP03BaselineQuerySetV2(parseCanonical(setBytes, "P03 baseline query set"));
  if (
    !same(
      set.ordered_queries.map((entry) => entry.script_ref),
      request.query_script_refs
    ) ||
    !same(
      set.ordered_queries.map((entry) => entry.plan_ref),
      request.query_plan_refs
    )
  ) {
    throw new Error("p03_frozen_query_release_ref_mismatch");
  }
  const queries = set.ordered_queries.map((entry, index) => {
    const scriptRef = request.query_script_refs[index];
    const planRef = request.query_plan_refs[index];
    if (scriptRef === undefined || planRef === undefined) {
      throw new Error("p03_frozen_query_release_incomplete");
    }
    const script = validateScaP03QueryScriptV2(
      parseCanonical(
        assertInputRef(context, dynamicSlot("query_script", index), scriptRef),
        `P03 query script ${index}`
      )
    );
    const plan = validateScaP03QueryPlanV2(
      parseCanonical(
        assertInputRef(context, dynamicSlot("query_plan", index), planRef),
        `P03 query plan ${index}`
      )
    );
    const binding = validateScaP03QueryBindingAgainstPlanV2({
      release_id: set.release_id,
      query_id: entry.query_id,
      script,
      plan,
    });
    if (
      entry.script_sha256 !== scriptRef.content_digest ||
      entry.plan_sha256 !== planRef.content_digest ||
      plan.max_ast_depth > policy.max_ast_depth ||
      plan.max_ast_nodes > policy.max_ast_nodes
    ) {
      throw new Error("p03_frozen_query_release_binding_mismatch");
    }
    return {
      query_id: entry.query_id,
      script_id: script.script_id,
      script_sha256: script.content_sha256,
      binding,
      plan,
    };
  });

  return {
    query_set_id: set.query_set_id,
    release_id: set.release_id,
    release_sha256: scaP03QueryReleaseSha256V2({
      query_set_id: set.query_set_id,
      release_id: set.release_id,
      query_set_sha256: set.query_set_sha256,
      queries,
    }),
    queries,
  };
}

function verifyQualificationInputs(
  context: HostOperationExecutionContextV1,
  request: ScaP03QualificationRequestV2,
  policy: ReturnType<typeof validateScaP03RuntimePolicyV1>
): {
  readonly corpus: ScaP03QualificationFixtureCorpusV2;
  readonly fixtures: readonly ScaP03RuntimeFixtureV1[];
  readonly release: ScaP03FrozenQueryReleaseV1;
  readonly parser_identity_sha256: string;
  readonly receipt: SourceOracleValidationReceipt;
} {
  const p03 = validateScaP03RequestV2(
    parseCanonical(assertInputRef(context, "p03_request", request.p03_request_ref), "P03 request")
  );
  if (
    !same(p03.source_oracle_ref, request.source_oracle_ref) ||
    !same(p03.source_oracle_validation_ref, request.source_oracle_validation_ref) ||
    !same(p03.fixture_corpus_ref, request.fixture_corpus_ref) ||
    !same(p03.fixture_content_refs, request.fixture_content_refs) ||
    !same(p03.baseline_query_set_ref, request.baseline_query_set_ref) ||
    !same(p03.query_script_refs, request.query_script_refs) ||
    !same(p03.query_plan_refs, request.query_plan_refs)
  )
    throw new Error("p03_qualification_request_oracle_ref_mismatch");
  const oracleBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.source_oracle,
    request.source_oracle_ref
  );
  const receiptBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.source_oracle_validation,
    request.source_oracle_validation_ref
  );
  const receipt = parseSourceOracleValidationReceiptBytes(receiptBytes);
  const reviewBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.source_oracle_review,
    receipt.review_ref
  );
  const corpusBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.fixture_corpus,
    request.fixture_corpus_ref
  );
  const corpus = validateScaP03QualificationFixtureCorpusV2(
    parseCanonical(corpusBytes, "P03 qualification fixture corpus")
  );
  const fixtures = request.fixture_content_refs.map((ref, index) => {
    const fixture = validateScaP03QualificationFixtureContentV1(
      parseCanonical(
        assertInputRef(context, dynamicSlot("fixture_content", index), ref),
        `P03 qualification fixture ${index}`
      )
    );
    if (fixture.fixture_id !== corpus.fixture_ids[index]) {
      throw new Error("p03_qualification_fixture_id_mismatch");
    }
    return {
      fixture_id: fixture.fixture_id,
      language: fixture.language,
      path: fixture.path,
      content_sha256: fixture.content_sha256,
      bytes: Buffer.from(fixture.content_base64, "base64"),
    };
  });
  if (
    ["php", "javascript", "typescript"].some(
      (language) => fixtures.filter((fixture) => fixture.language === language).length !== 1
    )
  )
    throw new Error("p03_qualification_fixture_language_mismatch");
  const base = readFrozenQueryRelease(context, request, policy);
  const set = validateScaP03BaselineQuerySetV2(
    parseCanonical(
      assertInputRef(
        context,
        SCA_P03_INPUT_SLOTS.baseline_query_set,
        request.baseline_query_set_ref
      ),
      "P03 baseline query set"
    )
  );
  const authority = revalidateP03SourceOracle({
    run_id: request.run_id,
    oracle_ref: request.source_oracle_ref,
    oracle_bytes: oracleBytes,
    receipt_ref: request.source_oracle_validation_ref,
    receipt_bytes: receiptBytes,
    review_ref: receipt.review_ref,
    review_bytes: reviewBytes,
    corpus_ref: request.fixture_corpus_ref,
    corpus,
    fixtures: fixtures.map((fixture, index) => {
      const ref = request.fixture_content_refs[index];
      if (ref === undefined) throw new Error("p03_oracle_fixture_ref_missing");
      return { ...fixture, ref };
    }),
  });
  return {
    corpus,
    fixtures,
    receipt: authority.validated_receipt,
    parser_identity_sha256: authority.parser_identity_sha256,
    release: {
      ...base,
      release_sha256: scaP03OracleBoundReleaseSha256V2({
        query_set_id: base.query_set_id,
        release_id: base.release_id,
        query_set_sha256: set.query_set_sha256,
        queries: base.queries,
        oracle_ref: request.fixture_corpus_ref,
        oracle: corpus,
      }),
    },
  };
}

function verifyQueryInputs(
  context: HostOperationExecutionContextV1,
  request: ScaP03BaselineQueryBatchRequestV2,
  policy: ReturnType<typeof validateScaP03RuntimePolicyV1>
): {
  readonly graphBytes: Uint8Array;
  readonly buildResult: ScaP03GraphBuildResultV1;
  readonly release: ScaP03FrozenQueryReleaseV1;
} {
  const graphBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.graph_component,
    request.graph_component_ref
  );
  const buildBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.graph_build_result,
    request.graph_build_result_ref
  );
  const buildRequestBytes = assertInputRef(
    context,
    SCA_P03_INPUT_SLOTS.graph_build_request,
    request.graph_build_request_ref
  );
  const buildRequest = validateScaP03OperationRequestV1(
    "build_source_graph",
    parseCanonical(buildRequestBytes, "P03 graph build request input")
  );
  const buildResultValue = validateScaP03OperationResultV1(
    "build_source_graph",
    buildRequest,
    parseCanonical(buildBytes, "P03 graph build result input")
  );
  if (
    buildRequest.operation_kind !== "build_source_graph" ||
    buildResultValue.operation_kind !== "build_source_graph" ||
    buildResultValue.graph === null ||
    !buildResultValue.complete ||
    buildResultValue.cleanup_status !== "proven" ||
    !same(buildResultValue.source_snapshot_ref, request.source_snapshot_ref) ||
    buildResultValue.source_snapshot_sha256 !== request.source_snapshot_sha256 ||
    buildResultValue.partition !== request.partition ||
    buildResultValue.graph.content_sha256 !== sha256(graphBytes) ||
    buildResultValue.graph.content_sha256 !== request.graph_component_sha256
  ) {
    throw new Error("p03_query_graph_source_or_digest_mismatch");
  }
  return {
    graphBytes,
    buildResult: buildResultValue,
    release: readFrozenQueryRelease(context, request, policy),
  };
}

function createAdapter(
  adapterId: string,
  kind: ScaP03OperationKind,
  options: ScaP03OperationAdapterOptionsV1
): HostOperationAdapterV1 {
  return {
    adapter_id: adapterId,
    inspectRequest: (input) => inspect(kind, input),
    async run(context) {
      const request = bindRequest(kind, context.request_bytes);
      if (request.operation_kind !== kind) throw new Error("p03_operation_request_kind_drift");
      const commonInputs = validateCommonInputs(context, request, options.runtime);
      context.signal.throwIfAborted();
      const freshSubmission = context.journal.lifecycle === "lease_acquired";
      beginOrResume(context, request);
      const cached = await context.readCachedResult();
      if (cached !== null) {
        const inputs =
          request.operation_kind === "qualify_joern"
            ? verifyQualificationInputs(context, request, commonInputs.policy)
            : null;
        const recovered = parseCache(cached.bytes, request, inputs?.corpus.expected_cases);
        if (request.operation_kind === "qualify_joern") {
          if (recovered.result.operation_kind !== "qualify_joern")
            throw new Error("p03_qualification_cache_result_kind_drift");
          if (inputs === null) throw new Error("p03_qualification_cache_oracle_missing");
          if (
            options.runtime?.runtime_kind === "host_qualified_joern" &&
            options.runtime.parser_identity_sha256 !== inputs.parser_identity_sha256
          )
            throw new Error("p03_qualification_parser_identity_drift");
          if (recovered.result.executed_query_release_sha256 !== null) {
            const matches =
              recovered.result.cases.length === inputs.corpus.expected_cases.length &&
              recovered.result.cases.every((entry, index) => {
                const expected = inputs.corpus.expected_cases[index];
                const fixture = inputs.fixtures.find((f) => f.language === entry.language);
                return (
                  expected !== undefined &&
                  fixture !== undefined &&
                  scaP03QualificationCaseMatchesV2(
                    entry,
                    expected,
                    fixture,
                    inputs.release.release_sha256,
                    request.source_oracle_validation_ref
                  )
                );
              });
            if (
              (recovered.result.status === "complete") !== matches ||
              recovered.result.parser_identity_sha256 !== inputs.parser_identity_sha256 ||
              recovered.result.executed_query_release_sha256 !== inputs.release.release_sha256
            )
              throw new Error("p03_qualification_cache_oracle_drift");
          }
        }
        return persistResult({
          context,
          request,
          result: recovered.result,
          outputs: recovered.outputs,
          options,
          alreadyCached: true,
          expectedCases: inputs?.corpus.expected_cases,
        });
      }
      if (context.journal.lifecycle === "fetched" || context.journal.lifecycle === "persisting") {
        throw new Error("p03_cached_result_missing_after_fetch");
      }
      if (!freshSubmission && context.journal.lifecycle === "submitted") {
        // beginOrResume has already checked the exact journal correlation and its digest.
        let terminationProven = false;
        try {
          terminationProven =
            (await options.local_recovery?.prove_prior_process_terminated?.({
              operation_kind: request.operation_kind,
              request_sha256: request.request_sha256,
              prior_correlation_id: `p03_${request.request_sha256}`,
            })) === true;
        } catch {
          // An observer failure is not evidence that the previous process exited.
        }
        if (!terminationProven) throw new Error("local_prior_process_termination_unproven");
        context.signal.throwIfAborted();
      }
      const now = operationClock(context, options.now);
      const runtime = options.runtime;
      let result: ScaP03OperationResultV1;
      let outputs: readonly CacheOutput[] = [];
      let expectedCases: ScaP03QualificationFixtureCorpusV2["expected_cases"] | undefined;
      if (!runtimeMatches(runtime, request)) {
        result = blockedResult(request, "joern_runtime_unavailable", now);
      } else if (request.operation_kind === "qualify_joern") {
        const qualificationInputs = verifyQualificationInputs(
          context,
          request,
          commonInputs.policy
        );
        if (
          runtime.runtime_kind === "host_qualified_joern" &&
          runtime.parser_identity_sha256 !== qualificationInputs.parser_identity_sha256
        )
          throw new Error("p03_qualification_parser_identity_drift");
        expectedCases = qualificationInputs.corpus.expected_cases;
        try {
          const qualified = await runWithTimeout({
            timeoutMs: commonInputs.policy.process_timeout_ms,
            parentSignal: context.signal,
            settleOnAbort: runtime.runtime_kind === "host_qualified_joern",
            execute: (signal) =>
              runtime.qualify({
                request,
                context,
                fixtures: qualificationInputs.fixtures,
                expected_cases: qualificationInputs.corpus.expected_cases,
                source_oracle_validation_ref: request.source_oracle_validation_ref,
                source_oracle_validation_receipt: qualificationInputs.receipt,
                query_release: qualificationInputs.release,
                fidelity_requirements: commonInputs.profile.fidelity_requirements,
                signal,
              }),
          });
          context.signal.throwIfAborted();
          result = qualificationResult(
            request,
            qualificationInputs.corpus.expected_cases,
            qualificationInputs.fixtures,
            qualificationInputs.release,
            qualified,
            now,
            qualificationInputs.parser_identity_sha256
          );
        } catch (error) {
          context.signal.throwIfAborted();
          rethrowIfTerminationUnproven(error);
          result = blockedResult(
            request,
            error instanceof Error && error.message === "p03_fixture_custody_invalid"
              ? "p03_fixture_custody_invalid"
              : constraintCode(error, "joern_qualification_failed"),
            now
          );
        }
      } else if (request.operation_kind === "build_source_graph") {
        const files = readSourceFiles(context, request);
        if (!files.some((file) => file.role === "primary")) {
          result = blockedResult(request, "graph_primary_surface_absent", now);
        } else {
          try {
            const built = await runWithTimeout({
              timeoutMs: commonInputs.policy.process_timeout_ms,
              parentSignal: context.signal,
              settleOnAbort: runtime.runtime_kind === "host_qualified_joern",
              execute: (signal) => runtime.buildGraph({ request, context, files, signal }),
            });
            context.signal.throwIfAborted();
            result = graphResult(request, built, now);
            outputs =
              result.status === "complete" && result.graph !== null
                ? [
                    cacheOutput({
                      artifact_kind: "sca-p03-graph-component",
                      media_type: "application/vnd.penny.joern-cpg",
                      content_schema_id: SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
                      bytes: built.graph_bytes,
                    }),
                  ]
                : [];
          } catch (error) {
            context.signal.throwIfAborted();
            rethrowIfTerminationUnproven(error);
            if (
              !(
                error instanceof ScaP03OperationConstraintError &&
                error.code === "graph_output_limit_exceeded"
              )
            )
              throw error;
            result = blockedResult(request, error.code, now);
          }
        }
      } else {
        const graph = verifyQueryInputs(context, request, commonInputs.policy);
        try {
          const queried = await runWithTimeout({
            timeoutMs: commonInputs.policy.process_timeout_ms,
            parentSignal: context.signal,
            settleOnAbort: runtime.runtime_kind === "host_qualified_joern",
            execute: (signal) =>
              runtime.runBaselineQueries({
                request,
                context,
                query_release: graph.release,
                graph_bytes: graph.graphBytes,
                accounted_files: graph.buildResult.accounted_files,
                signal,
              }),
          });
          context.signal.throwIfAborted();
          const pages = queried.pages.map((page) =>
            queryPage(
              request,
              page,
              graph.release,
              graph.buildResult.accounted_files
                .filter(
                  (file) => file.disposition === "parsed" || file.disposition === "contextual"
                )
                .map((file) => file.path)
            )
          );
          result = queryResult(request, pages, queried, graph.release, now);
          outputs = pages.map((page) =>
            cacheOutput({
              artifact_kind: "sca-p03-baseline-query-page",
              media_type: "application/json",
              content_schema_id: SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA,
              bytes: Buffer.from(canonicalJson(page), "utf8"),
            })
          );
        } catch (error) {
          context.signal.throwIfAborted();
          rethrowIfTerminationUnproven(error);
          result = blockedResult(
            request,
            constraintCode(error, "joern_baseline_query_failed"),
            now
          );
        }
      }
      return persistResult({
        context,
        request,
        result,
        outputs,
        options,
        alreadyCached: false,
        expectedCases,
      });
    },
  };
}

export function createScaP03OperationAdaptersV1(
  options: ScaP03OperationAdapterOptionsV1 = {}
): ReadonlyMap<string, HostOperationAdapterV1> {
  if (
    options.runtime?.runtime_kind === "host_qualified_joern" &&
    !isVerifiedScaP03DockerHostRuntimeV1(options.runtime)
  )
    throw new Error("p03_unverified_host_runtime_injection");
  const definitions = [
    ["sca-p03-qualify-joern-adapter-v1", "qualify_joern"],
    ["sca-p03-build-source-graph-adapter-v1", "build_source_graph"],
    ["sca-p03-run-baseline-query-batch-adapter-v1", "run_baseline_query_batch"],
  ] as const;
  const adapters = definitions.map(([adapterId, kind]) => createAdapter(adapterId, kind, options));
  return new Map(adapters.map((adapter) => [adapter.adapter_id, adapter]));
}

function candidate(input: {
  readonly kind: ScaP03QueryCandidateV2["candidate_kind"];
  readonly queryId: ScaP03QueryId;
  readonly path: string;
  readonly summary: string;
  readonly graphSha256: string;
  readonly sourceSha256: string;
  readonly releaseSha256: string;
}): ScaP03QueryCandidateV2 {
  const claim =
    input.queryId === "p03.call-resolution.v2"
      ? ("call_resolution" as const)
      : input.queryId === "p03.control-guard.v2"
        ? ("control_reachability" as const)
        : input.queryId === "p03.dataflow-source-sink.v2"
          ? ("reaching_definition" as const)
          : input.queryId === "p03.framework-dispatch.v2"
            ? ("framework_dispatch" as const)
            : ("observation" as const);
  const linked = claim === "call_resolution";
  const first = {
    node_id: `${input.queryId}:1`,
    role: linked ? ("call_site" as const) : ("symbol" as const),
    label: linked ? "call" : "method",
    name: "simulated",
    full_name: null,
    path: input.path,
    line: 1,
    column: null,
    location_provenance: "direct" as const,
    location_owner_node_id: null,
    location_evidence: null,
  };
  const last = {
    node_id: `${input.queryId}:2`,
    role: "callee" as const,
    label: "method",
    name: "simulated-callee",
    full_name: null,
    path: input.path,
    line: 2,
    column: null,
    location_provenance: "direct" as const,
    location_owner_node_id: null,
    location_evidence: null,
  };
  return makeScaP03QueryCandidateV2({
    candidate_kind: input.kind,
    query_id: input.queryId,
    claim,
    disposition: linked ? "supported" : "unresolved",
    reason_code: linked ? null : "simulated_relationship_unproven",
    source_selector: claim === "reaching_definition" ? "simulated-source" : null,
    sink_selector: claim === "reaching_definition" ? "simulated-sink" : null,
    framework: null,
    registration_form: null,
    callback_resolution: claim === "framework_dispatch" ? "dynamic" : null,
    assumptions: [],
    graph_component_sha256: input.graphSha256,
    source_snapshot_sha256: input.sourceSha256,
    query_release_sha256: input.releaseSha256,
    vertices: linked ? [first, last] : [first],
    edges: linked
      ? [
          {
            src_index: 0,
            dst_index: 1,
            src_node_id: first.node_id,
            dst_node_id: last.node_id,
            kind: "call",
            direction: "forward",
            provenance: "observed_cpg",
            branch_orientation: null,
            complement_ref: null,
          },
        ]
      : [],
    hop_count: linked ? 1 : 0,
    truncated: false,
    path: input.path,
    line: 1,
    stable_locator: `${input.queryId}:${input.path}:1`,
    summary: input.summary,
  });
}

export function scaP03SimulatedQualificationObservationSha256V1(input: {
  readonly fixture: Pick<
    ScaP03RuntimeFixtureV1,
    "fixture_id" | "language" | "path" | "content_sha256"
  >;
  readonly query: ScaP03FrozenQueryV1;
  readonly release_sha256: string;
}): string {
  return scaP03QualificationObservationSha256V2({
    fixture_id: input.fixture.fixture_id,
    fixture_sha256: input.fixture.content_sha256,
    query_id: input.query.query_id,
    frontend_language: scaP03FrontendLanguageV1(input.fixture.language),
    release_sha256: input.release_sha256,
    blocker_code: "p03_oracle_assertion_mismatch",
    observations: [],
  });
}

/**
 * Test-only deterministic seam. It emits source-bound opaque bytes and frozen-query pages, but its
 * identity can never satisfy live AC-P03 qualification.
 */
export function createScaP03SimulatedJoernRuntimeV1(input: {
  readonly runtime_id: string;
  readonly isolation_id: string;
  readonly runtime_tree_sha256: string;
  readonly isolation_profile_sha256: string;
  readonly implementation_identity_sha256: string;
  readonly deployment_identity_sha256: string;
  readonly onExecute?: (operation: ScaP03OperationKind, partition: ScaP03Partition | null) => void;
}): ScaP03JoernRuntimeV1 {
  return {
    runtime_kind: "simulated_joern_test_runtime",
    qualification_scope: "deterministic_test_only",
    simulation_label: "simulated_joern_test_seam",
    runtime_id: input.runtime_id,
    isolation_id: input.isolation_id,
    runtime_tree_sha256: input.runtime_tree_sha256,
    isolation_profile_sha256: input.isolation_profile_sha256,
    implementation_identity_sha256: input.implementation_identity_sha256,
    deployment_identity_sha256: input.deployment_identity_sha256,
    async qualify({ fixtures, query_release: release, signal }) {
      signal.throwIfAborted();
      input.onExecute?.("qualify_joern", null);
      return {
        executed_query_release_sha256: release.release_sha256,
        cases: (["php", "javascript", "typescript"] as const).flatMap((language) => {
          const fixture = fixtures.find((entry) => entry.language === language);
          if (fixture === undefined) throw new Error(`simulated fixture '${language}' is absent`);
          return release.queries.map((query) => ({
            case_id: `p03-${language}-${query.query_id.replaceAll(".", "-")}`,
            language,
            query_id: query.query_id,
            frontend_language: scaP03FrontendLanguageV1(language),
            status: "blocked" as const,
            blocker_code: "p03_oracle_assertion_mismatch" as const,
            fixture_id: fixture.fixture_id,
            fixture_sha256: fixture.content_sha256,
            observation_count: 0,
            observations: [],
            observed_sha256: scaP03SimulatedQualificationObservationSha256V1({
              fixture,
              query,
              release_sha256: release.release_sha256,
            }),
          }));
        }),
      };
    },
    async buildGraph({ request, files, signal }) {
      signal.throwIfAborted();
      input.onExecute?.("build_source_graph", request.partition);
      const graphBytes = Buffer.concat([
        Buffer.from("PENNY-SIMULATED-JOERN-CPG\u0000", "utf8"),
        Buffer.from(
          canonicalJson({
            simulation_label: "simulated_joern_test_seam",
            partition: request.partition,
            frontend_language: request.frontend_language,
            source_snapshot_sha256: request.source_snapshot_sha256,
            files: files.map((file) => ({
              path: file.path,
              content_sha256: file.content_sha256,
              role: file.role,
            })),
          }),
          "utf8"
        ),
      ]);
      return {
        graph_bytes: graphBytes,
        accounted_files: files.map((file) => ({
          path: file.path,
          content_sha256: file.content_sha256,
          disposition: file.role === "primary" ? ("parsed" as const) : ("contextual" as const),
          reason_code: null,
        })),
        graph_opened: true,
        cleanup_evidence: cleanupEvidence({
          workspace_removed: true,
          graph_handles_closed: true,
          process_exit_observed: true,
        }),
      };
    },
    async runBaselineQueries({
      request,
      query_release: release,
      graph_bytes,
      accounted_files,
      signal,
    }) {
      signal.throwIfAborted();
      input.onExecute?.("run_baseline_query_batch", request.partition);
      const primary = accounted_files.find((file) => file.disposition === "parsed");
      if (primary === undefined || graph_bytes.byteLength === 0) {
        throw new Error("simulated_joern_graph_input_missing");
      }
      const kinds: Readonly<Record<ScaP03QueryId, ScaP03QueryCandidateV2["candidate_kind"]>> = {
        "p03.graph-integrity.v2": "symbol_or_entrypoint",
        "p03.symbol-entrypoint-index.v2": "symbol_or_entrypoint",
        "p03.call-resolution.v2": "call_or_unresolved_call",
        "p03.control-guard.v2": "guard_or_control_relationship",
        "p03.dataflow-source-sink.v2": "source_to_sink_flow",
        "p03.framework-dispatch.v2": "route_or_framework_surface",
        "p03.unsupported-surface.v2": "unsupported_or_unresolved_surface",
      };
      return {
        executed_query_release_sha256: release.release_sha256,
        pages: release.queries.map((query) => ({
          query_id: query.query_id,
          page_number: 1,
          items:
            query.query_id === "p03.unsupported-surface.v2"
              ? []
              : [
                  candidate({
                    kind: kinds[query.query_id],
                    queryId: query.query_id,
                    path: primary.path,
                    summary: `Deterministic test-only ${query.query_id} observation for ${request.partition}.`,
                    graphSha256: request.graph_component_sha256,
                    sourceSha256: request.source_snapshot_sha256,
                    releaseSha256: release.release_sha256,
                  }),
                ],
          complete: true,
        })),
        fidelity_observations: request.fidelity_requirements.map((requirement) => ({
          requirement_id: requirement.requirement_id,
          support: "supported" as const,
          reason_code: null,
        })),
        truncated: false,
      };
    },
  };
}
