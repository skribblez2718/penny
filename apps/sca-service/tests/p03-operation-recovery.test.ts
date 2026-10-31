import { readFileSync } from "node:fs";

import { observedFromSourceCase } from "./p03-test-oracle.js";
import { syntheticSourceOracle } from "./p03-synthetic-source-oracle.js";
import { validateSourceOracleBytes } from "../src/p03-source-oracle.js";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import { validateContract, type ArtifactRef } from "../../orchestration/dist/contracts.js";
import {
  SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
  SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
  scaP01SourceTreeDigest,
} from "../../orchestration/dist/sca/p01-contracts.js";
import type {
  HostOperationExecutionContextV1,
  HostOperationPersistedOutputV1,
} from "../../orchestration/dist/host-operations/contracts.js";
import {
  SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA,
  SCA_P03_BASELINE_QUERY_SET_V2_SCHEMA,
  SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA,
  SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA,
  SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
  SCA_P03_INPUT_SLOTS,
  SCA_P03_OPERATION_IDS,
  SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
  SCA_P03_QUALIFICATION_PROFILE_V2_SCHEMA,
  SCA_P03_QUALIFICATION_REQUEST_V2_SCHEMA,
  SCA_P03_QUERY_IDS,
  SCA_P03_REQUEST_V2_SCHEMA,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  projectSourceOracleCases,
  sealSourceOracleValidationReceipt,
  scaP03P01BindingSha256,
  scaP03P02BindingSha256,
  scaP03RuntimeBindingSha256,
  scaP03OracleBoundReleaseSha256V2,
  SCA_P03_QUERY_PLAN_V2_SCHEMA,
  SCA_P03_QUERY_SCRIPT_V2_SCHEMA,
  SCA_P03_RUNTIME_POLICY_V1_SCHEMA,
  validateScaP03OperationRequestV1,
  validateScaP03OperationResultV1,
  validateScaP03BaselineQueryPageV2,
  validateScaP03QualificationFixtureCorpusV2,
  validateScaP03QualificationResultProjectionV2,
  makeScaP03QueryCandidateV2,
  scaP03QualificationObservationSha256V2,
  validateScaP03QueryPlanV2,
  withScaP03Digest,
  type ScaP03OperationRequestV1,
} from "../../orchestration/dist/sca/p03-contracts.js";
import { SCA_P03_OPERATION_DECLARATIONS } from "../../orchestration/dist/sca/p03-playbook.js";
import {
  createScaP03OperationAdaptersV1,
  createScaP03SimulatedJoernRuntimeV1,
} from "../src/p03-operations.js";
import { p02TestOperationEnvelope } from "./p02-test-context.js";

const FIXED_NOW = new Date("2026-09-20T00:00:00.000Z");

function artifact(
  label: string,
  bytes = Buffer.from(canonicalJson({ label }), "utf8"),
  authority?: { kind: string; schema_id: string; producer: string }
): {
  readonly ref: ArtifactRef;
  readonly bytes: Uint8Array;
} {
  const digest = sha256(bytes);
  const safe = label.replaceAll(/[^a-z0-9-]/gu, "-");
  return {
    ref: {
      schema_version: 2,
      artifact_id: `art_${sha256(`${label}:${digest}`)}`,
      run_id: "p03-operation-run",
      phase: authority ? "SCA-P03" : "fixture",
      branch_id: null,
      kind: authority?.kind ?? `p03-${safe}`,
      operation_id: `p03-${safe}`,
      version: 1,
      producer: authority?.producer ?? "host:p03-operation-test",
      media_type: "application/json",
      content_schema: {
        schema_id: authority?.schema_id ?? `penny.p03-${safe}.v1`,
        schema_version: authority?.schema_id.endsWith(".v2") ? 2 : 1,
      },
      byte_length: bytes.byteLength,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
    },
    bytes,
  };
}

function fixture(reviewed = false) {
  const implementationValue = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-implementation-identity.v1",
      schema_version: 1,
      implementation_id: "p03-operation-implementation",
      implementation_revision: "p03-operation-r1",
      source_sha256: "6".repeat(64),
      build_sha256: "7".repeat(64),
      normalizer_sha256: "8".repeat(64),
      query_runner_sha256: "9".repeat(64),
    },
    "implementation_sha256"
  );
  const implementationSha256 = implementationValue.implementation_sha256;
  if (implementationSha256 === undefined) throw new Error("implementation digest is absent");
  const deploymentIdentitySha256 = "a".repeat(64);
  const isolationValue = {
    schema_id: "penny.sca-p03-isolation-evidence.v1",
    schema_version: 1,
    producer_id: "host:sca-p03-isolation-qualification",
    evidence_kind: "simulated_joern_test_seam",
    runtime_kind: "simulated_joern_test_runtime",
    qualification_scope: "deterministic_test_only",
    qualified: false,
    simulation_label: "simulated_joern_test_seam",
    runtime_id: "p03-operation-runtime",
    isolation_id: "p03-operation-isolation",
    implementation_identity_sha256: implementationSha256,
    deployment_identity_sha256: deploymentIdentitySha256,
    profile_id: "p03-operation-profile",
    profile_sha256: "5".repeat(64),
    runtime_tree_sha256: "4".repeat(64),
    qualified_at: FIXED_NOW.toISOString(),
  };
  const policyValue = {
    schema_id: SCA_P03_RUNTIME_POLICY_V1_SCHEMA,
    schema_version: 1,
    policy_id: "p03-operation-policy",
    staging_parent_sha256: sha256("/p03-operation-test-staging"),
    source_posture: "read_only",
    network_access: "denied",
    package_acquisition: "forbidden",
    target_execution: "forbidden",
    shell_execution: "forbidden",
    joern_server: "forbidden",
    process_timeout_ms: 25,
    max_graph_bytes: 1_048_576,
    max_query_output_bytes: 1_048_576,
    max_query_items: 100,
    max_page_items: 10,
    max_pages_per_query: 10,
    max_ast_depth: 8,
    max_ast_nodes: 32,
    max_num_def: 10_000,
  };
  const fidelityRequirements = [
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
        subject: "fixture-framework",
        partition,
        materiality: "non_material" as const,
        complement_evidence_ref: null,
      },
      {
        requirement_id: `p03-edge-${partition}`,
        dimension: "edge_class" as const,
        subject: "call",
        partition,
        materiality: "material" as const,
        complement_evidence_ref: null,
      },
      {
        requirement_id: `p03-surface-${partition}`,
        dimension: "surface" as const,
        subject: "entrypoint",
        partition,
        materiality: "material" as const,
        complement_evidence_ref: null,
      },
    ]),
  ];
  const profileValue = withScaP03Digest(
    {
      schema_id: SCA_P03_QUALIFICATION_PROFILE_V2_SCHEMA,
      schema_version: 2,
      profile_id: "p03-operation-qualification-profile",
      phase_id: "SCA-P03" as const,
      required_languages: ["php", "javascript", "typescript"] as const,
      required_query_ids: SCA_P03_QUERY_IDS,
      fidelity_requirements: fidelityRequirements,
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
  const oracle = reviewed
    ? validateSourceOracleBytes(
        readFileSync(new URL("./fixtures/p03-v2/oracle.json", import.meta.url))
      )
    : syntheticSourceOracle();
  const fixtureRuntime = (["php", "javascript", "typescript"] as const).map((language) => {
    const definition = oracle.fixtures.find((entry) => entry.language === language);
    if (!definition) throw new Error("synthetic fixture missing");
    const bytes = readFileSync(new URL(`./fixtures/p03-v2/${definition.file}`, import.meta.url));
    return {
      fixture_id: definition.fixture_id,
      language,
      path: definition.path,
      content_sha256: sha256(bytes),
      bytes,
    };
  });
  const fixtureContents = fixtureRuntime.map((fixture) =>
    artifact(
      fixture.fixture_id,
      Buffer.from(
        canonicalJson({
          schema_id: SCA_P03_QUALIFICATION_FIXTURE_CONTENT_V1_SCHEMA,
          schema_version: 1,
          fixture_id: fixture.fixture_id,
          language: fixture.language,
          path: fixture.path,
          encoding: "base64",
          content_base64: Buffer.from(fixture.bytes).toString("base64"),
          byte_length: fixture.bytes.byteLength,
          content_sha256: fixture.content_sha256,
        }),
        "utf8"
      )
    )
  );
  const releaseId = "p03-operation-query-release";
  const planValues = SCA_P03_QUERY_IDS.map((queryId, index) =>
    validateScaP03QueryPlanV2(
      withScaP03Digest(
        {
          schema_id: SCA_P03_QUERY_PLAN_V2_SCHEMA,
          schema_version: 2,
          plan_id: `p03-operation-plan-${String(index)}`,
          query_id: queryId,
          steps: [
            { kind: "select_node" as const, node_class: "method" as const },
            ...(queryId === "p03.call-resolution.v2" || queryId === "p03.framework-dispatch.v2"
              ? [{ kind: "traverse_edge" as const, edge: "call" as const, max_hops: 1 }]
              : queryId === "p03.control-guard.v2"
                ? [{ kind: "traverse_edge" as const, edge: "cfg" as const, max_hops: 1 }]
                : queryId === "p03.dataflow-source-sink.v2"
                  ? [{ kind: "traverse_edge" as const, edge: "reaching_def" as const, max_hops: 1 }]
                  : []),
            { kind: "project" as const, fields: ["node_id", "file_name"] as const },
            { kind: "limit" as const, max_items: 100 },
          ],
          max_ast_depth: 8,
          max_ast_nodes: 32,
        },
        "plan_sha256"
      )
    )
  );
  const plans = planValues.map((plan, index) =>
    artifact(`query-plan-${String(index)}`, Buffer.from(canonicalJson(plan), "utf8"))
  );
  const bindings = planValues.map((plan) => ({
    schema_id: "penny.sca-p03-query-binding.v2" as const,
    schema_version: 2 as const,
    release_id: releaseId,
    query_id: plan.query_id,
    executor_id: plan.query_id,
    plan_id: plan.plan_id,
    plan_sha256: plan.plan_sha256,
  }));
  const scriptValues = bindings.map((binding, index) => {
    const bytes = Buffer.from(canonicalJson(binding), "utf8");
    return {
      schema_id: SCA_P03_QUERY_SCRIPT_V2_SCHEMA,
      schema_version: 2 as const,
      query_id: binding.query_id,
      script_id: `p03-operation-script-${String(index)}`,
      language: "penny_typed_query_binding_v2" as const,
      review_status: "host_reviewed_frozen" as const,
      encoding: "base64" as const,
      content_base64: bytes.toString("base64"),
      byte_length: bytes.byteLength,
      content_sha256: sha256(bytes),
    };
  });
  const scripts = scriptValues.map((script, index) =>
    artifact(`query-script-${String(index)}`, Buffer.from(canonicalJson(script), "utf8"))
  );
  const querySetValue = withScaP03Digest(
    {
      schema_id: SCA_P03_BASELINE_QUERY_SET_V2_SCHEMA,
      schema_version: 2,
      query_set_id: "p03-operation-query-set",
      release_id: releaseId,
      ordered_queries: SCA_P03_QUERY_IDS.map((queryId, index) => {
        const script = scripts[index];
        const plan = plans[index];
        if (script === undefined || plan === undefined)
          throw new Error("query release is incomplete");
        return {
          query_id: queryId,
          script_ref: script.ref,
          script_sha256: script.ref.content_digest,
          plan_ref: plan.ref,
          plan_sha256: plan.ref.content_digest,
        };
      }),
      native_query_authorized: false as const,
    },
    "query_set_sha256"
  );
  const querySetSha256 = querySetValue.query_set_sha256;
  if (querySetSha256 === undefined) throw new Error("query set digest is absent");
  const runtimeQueries = SCA_P03_QUERY_IDS.map((queryId, index) => {
    const plan = planValues[index];
    const script = scriptValues[index];
    const binding = bindings[index];
    if (plan === undefined || script === undefined || binding === undefined) {
      throw new Error("runtime query release is incomplete");
    }
    return {
      query_id: queryId,
      script_id: script.script_id,
      script_sha256: script.content_sha256,
      binding,
      plan,
    };
  });
  const expectedCases = projectSourceOracleCases(oracle);
  const corpusValue = withScaP03Digest(
    {
      schema_id: "penny.sca-p03-qualification-fixture-corpus.v2",
      schema_version: 2,
      corpus_id: "p03-operation-corpus",
      fixture_content_refs: fixtureContents.map((entry) => entry.ref),
      fixture_ids: fixtureRuntime.map((entry) => entry.fixture_id),
      languages: ["php", "javascript", "typescript"] as const,
      expected_cases: expectedCases,
    },
    "corpus_sha256"
  );
  const corpusArtifact = artifact(
    "fixture-corpus",
    Buffer.from(canonicalJson(corpusValue), "utf8")
  );
  const oracleArtifact = artifact("source-oracle", Buffer.from(canonicalJson(oracle)), {
    kind: "sca-p03-source-oracle",
    schema_id: SCA_P03_SOURCE_ORACLE_SCHEMA,
    producer: SCA_P03_SOURCE_ORACLE_PRODUCER,
  });
  const reviewBody = {
    schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    schema_version: 1,
    producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    oracle_sha256: oracle.oracle_sha256,
    parser_identity_sha256: oracle.parser.identity_sha256,
    fixture_content_sha256: fixtureRuntime.map((entry) => entry.content_sha256),
    expected_cases: expectedCases,
  };
  const reviewArtifact = artifact(
    "source-oracle-review",
    Buffer.from(
      canonicalJson({
        ...reviewBody,
        review_sha256: sha256(canonicalJson(reviewBody)),
      })
    ),
    {
      kind: "sca-p03-source-oracle-review",
      schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
      producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    }
  );
  const [php, javascript, typescript] = fixtureRuntime;
  const [phpRef, javascriptRef, typescriptRef] = fixtureContents;
  if (!php || !javascript || !typescript || !phpRef || !javascriptRef || !typescriptRef)
    throw new Error("fixture roster incomplete");
  const receipt = sealSourceOracleValidationReceipt({
    oracle_ref: oracleArtifact.ref,
    oracle_sha256: oracle.oracle_sha256,
    review_ref: reviewArtifact.ref,
    parser_identity_sha256: oracle.parser.identity_sha256,
    fixtures: [
      {
        fixture_id: php.fixture_id,
        language: php.language,
        content_ref: phpRef.ref,
        content_sha256: php.content_sha256,
      },
      {
        fixture_id: javascript.fixture_id,
        language: javascript.language,
        content_ref: javascriptRef.ref,
        content_sha256: javascript.content_sha256,
      },
      {
        fixture_id: typescript.fixture_id,
        language: typescript.language,
        content_ref: typescriptRef.ref,
        content_sha256: typescript.content_sha256,
      },
    ],
    corpus_ref: corpusArtifact.ref,
    corpus_sha256: corpusValue.corpus_sha256,
    expected_cases: expectedCases,
    validated_at: FIXED_NOW.toISOString(),
  });
  const receiptArtifact = artifact(
    "source-oracle-validation",
    Buffer.from(canonicalJson(receipt)),
    {
      kind: "sca-p03-source-oracle-validation",
      schema_id: SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
      producer: SCA_P03_SOURCE_ORACLE_VALIDATOR,
    }
  );
  const releaseSha256 = scaP03OracleBoundReleaseSha256V2({
    query_set_id: querySetValue.query_set_id,
    release_id: querySetValue.release_id,
    query_set_sha256: querySetSha256,
    queries: runtimeQueries,
    oracle_ref: corpusArtifact.ref,
    oracle: validateScaP03QualificationFixtureCorpusV2(corpusValue),
  });
  const values = {
    p03_request: artifact("request"),
    runtime_policy: artifact("runtime-policy", Buffer.from(canonicalJson(policyValue), "utf8")),
    runtime_identity: artifact("runtime-identity"),
    isolation_evidence: artifact(
      "isolation-evidence",
      Buffer.from(canonicalJson(isolationValue), "utf8")
    ),
    implementation_identity: artifact(
      "implementation-identity",
      Buffer.from(canonicalJson(implementationValue), "utf8")
    ),
    qualification_profile: artifact(
      "qualification-profile",
      Buffer.from(canonicalJson(profileValue), "utf8")
    ),
    baseline_query_set: artifact(
      "baseline-query-set",
      Buffer.from(canonicalJson(querySetValue), "utf8")
    ),
    fixture_corpus: corpusArtifact,
  };
  const source = artifact("source-snapshot");
  const p01Ref = artifact("p01-binding").ref;
  const p02Ref = artifact("p02-binding").ref;
  const p02QualificationDefinition = artifact("p02-qualification-definition");
  const p02QualificationGate = artifact("p02-qualification-gate");
  const p02AuthorityRef = (
    entry: typeof p02QualificationDefinition,
    kind: string,
    schema_id: string,
    schema_version: number
  ): ArtifactRef => ({
    ...entry.ref,
    phase: "SCA-P02",
    kind,
    producer: "host:sca-p02-qualification-authority",
    content_schema: { schema_id, schema_version },
  });
  const accepted_p01 = {
    request_ref: p01Ref,
    obligation_ledger_ref: p01Ref,
    campaign_manifest_core_ref: p01Ref,
    admission_evidence_ref: p01Ref,
    p01_gate_ref: p01Ref,
    campaign_manifest_ref: p01Ref,
    frozen_refs: [p01Ref],
  };
  const accepted_p02 = {
    transition_ref: p02Ref,
    p02_request_ref: p02Ref,
    gate_ref: p02Ref,
    qualification_definition_ref: p02AuthorityRef(
      p02QualificationDefinition,
      "sca-p02-v3-definition-snapshot",
      "penny.sca-p02-v3-definition-snapshot.v1",
      1
    ),
    qualification_gate_ref: p02AuthorityRef(
      p02QualificationGate,
      "sca-p02-phase-gate-v3",
      "penny.sca-phase-gate-record.v3",
      3
    ),
    m1_ref: p02Ref,
    coverage_matrix_ref: p02Ref,
    evidence_manifest_ref: p02Ref,
    successor_ledger_ref: p02Ref,
    evidence_refs: Array.from({ length: 26 }, () => p02Ref),
  };
  const p03Body = {
    schema_id: SCA_P03_REQUEST_V2_SCHEMA,
    schema_version: 2,
    tenant_id: "p03-operation-tenant",
    project_id: "p03-operation-project",
    run_id: "p03-operation-run",
    phase_id: "SCA-P03" as const,
    accepted_p01,
    accepted_p02,
    source_snapshot_ref: source.ref,
    source_snapshot_sha256: source.ref.content_digest,
    runtime_policy_ref: values.runtime_policy.ref,
    joern_runtime_identity_ref: values.runtime_identity.ref,
    isolation_evidence_ref: values.isolation_evidence.ref,
    host_isolation_attestation_ref: null,
    implementation_identity_ref: values.implementation_identity.ref,
    qualification_profile_ref: values.qualification_profile.ref,
    fixture_corpus_ref: corpusArtifact.ref,
    source_oracle_ref: oracleArtifact.ref,
    source_oracle_validation_ref: receiptArtifact.ref,
    fixture_content_refs: fixtureContents.map((entry) => entry.ref),
    fidelity_complement_refs: [],
    baseline_query_set_ref: values.baseline_query_set.ref,
    query_script_refs: scripts.map((entry) => entry.ref),
    query_plan_refs: plans.map((entry) => entry.ref),
    runtime_package_refs: [artifact("runtime-package").ref],
    p01_binding_sha256: scaP03P01BindingSha256({ accepted_p01 }),
    p02_binding_sha256: scaP03P02BindingSha256({ accepted_p02 }),
    p03_runtime_binding_sha256: scaP03RuntimeBindingSha256({
      runtime_policy_ref: values.runtime_policy.ref,
      joern_runtime_identity_ref: values.runtime_identity.ref,
      isolation_evidence_ref: values.isolation_evidence.ref,
      host_isolation_attestation_ref: null,
      implementation_identity_ref: values.implementation_identity.ref,
      qualification_profile_ref: values.qualification_profile.ref,
      fixture_corpus_ref: corpusArtifact.ref,
      source_oracle_ref: oracleArtifact.ref,
      source_oracle_validation_ref: receiptArtifact.ref,
      baseline_query_set_ref: values.baseline_query_set.ref,
    }),
    requested_at: FIXED_NOW.toISOString(),
  };
  values.p03_request = artifact(
    "request",
    Buffer.from(canonicalJson(withScaP03Digest(p03Body, "request_sha256")))
  );
  const common = {
    schema_id: SCA_P03_QUALIFICATION_REQUEST_V2_SCHEMA,
    schema_version: 2,
    tenant_id: "p03-operation-tenant",
    project_id: "p03-operation-project",
    run_id: "p03-operation-run",
    phase_id: "SCA-P03" as const,
    operation_id: SCA_P03_OPERATION_IDS.qualify,
    operation_kind: "qualify_joern" as const,
    p01_binding_sha256: p03Body.p01_binding_sha256,
    p02_binding_sha256: p03Body.p02_binding_sha256,
    p03_runtime_binding_sha256: p03Body.p03_runtime_binding_sha256,
    source_snapshot_ref: source.ref,
    source_snapshot_sha256: source.ref.content_digest,
    p03_request_ref: values.p03_request.ref,
    runtime_policy_ref: values.runtime_policy.ref,
    joern_runtime_identity_ref: values.runtime_identity.ref,
    isolation_evidence_ref: values.isolation_evidence.ref,
    host_isolation_attestation_ref: null,
    implementation_identity_ref: values.implementation_identity.ref,
    qualification_profile_ref: values.qualification_profile.ref,
    baseline_query_set_ref: values.baseline_query_set.ref,
    runtime_id: "p03-operation-runtime",
    runtime_kind: "simulated_joern_test_runtime" as const,
    qualification_scope: "deterministic_test_only" as const,
    runtime_tree_sha256: "4".repeat(64),
    isolation_id: "p03-operation-isolation",
    isolation_profile_sha256: "5".repeat(64),
    fixture_corpus_ref: values.fixture_corpus.ref,
    source_oracle_ref: oracleArtifact.ref,
    source_oracle_validation_ref: receiptArtifact.ref,
    fixture_content_refs: fixtureContents.map((entry) => entry.ref),
    query_script_refs: scripts.map((entry) => entry.ref),
    query_plan_refs: plans.map((entry) => entry.ref),
  };
  const request = validateScaP03OperationRequestV1(
    "qualify_joern",
    withScaP03Digest(common, "request_sha256")
  );
  if (request.operation_kind !== "qualify_joern") throw new Error("fixture kind drifted");
  const inputs = new Map<string, { readonly ref: ArtifactRef; readonly bytes: Uint8Array }>([
    ["p03_request", values.p03_request],
    [SCA_P03_INPUT_SLOTS.runtime_policy, values.runtime_policy],
    [SCA_P03_INPUT_SLOTS.runtime_identity, values.runtime_identity],
    [SCA_P03_INPUT_SLOTS.isolation_evidence, values.isolation_evidence],
    [SCA_P03_INPUT_SLOTS.implementation_identity, values.implementation_identity],
    [SCA_P03_INPUT_SLOTS.qualification_profile, values.qualification_profile],
    [SCA_P03_INPUT_SLOTS.baseline_query_set, values.baseline_query_set],
    [SCA_P03_INPUT_SLOTS.fixture_corpus, values.fixture_corpus],
    [SCA_P03_INPUT_SLOTS.source_oracle, oracleArtifact],
    [SCA_P03_INPUT_SLOTS.source_oracle_validation, receiptArtifact],
    [SCA_P03_INPUT_SLOTS.source_oracle_review, reviewArtifact],
    ...fixtureContents.map(
      (entry, index) => [`fixture_content_${String(index).padStart(4, "0")}`, entry] as const
    ),
    ...scripts.map(
      (entry, index) => [`query_script_${String(index).padStart(4, "0")}`, entry] as const
    ),
    ...plans.map(
      (entry, index) => [`query_plan_${String(index).padStart(4, "0")}`, entry] as const
    ),
  ]);
  return {
    request,
    inputs,
    implementationSha256,
    deploymentIdentitySha256,
    values,
    policyValue,
    profileValue,
    fidelityRequirements,
    releaseSha256,
    corpusValue: validateScaP03QualificationFixtureCorpusV2(corpusValue),
    runtimeQueries,
    querySetValue,
    scripts,
    plans,
    source,
  };
}

function context(input: {
  readonly request: ScaP03OperationRequestV1;
  readonly inputs: ReadonlyMap<string, { readonly ref: ArtifactRef; readonly bytes: Uint8Array }>;
  readonly lifecycle: "lease_acquired" | "submitted" | "fetched" | "persisting";
  readonly priorCorrelationId?: string;
  readonly cache: { bytes: Uint8Array | null };
  readonly signal?: AbortSignal;
  readonly capture: (content: string) => void;
  readonly captureArtifactCount?: (count: number) => void;
  readonly captureOutputs?: (outputs: readonly Uint8Array[]) => void;
}): HostOperationExecutionContextV1 {
  const declaration =
    input.request.operation_kind === "qualify_joern"
      ? SCA_P03_OPERATION_DECLARATIONS.qualify
      : input.request.operation_kind === "build_source_graph"
        ? SCA_P03_OPERATION_DECLARATIONS.build_source_graph
        : SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch;
  const requestBytes = canonicalJson(input.request);
  const envelope = p02TestOperationEnvelope({
    declaration,
    requestBytes,
    requestSha256: input.request.request_sha256,
    lifecycle: input.lifecycle,
    createdAt: FIXED_NOW.toISOString(),
  });
  const correlationId = input.priorCorrelationId ?? `p03_${input.request.request_sha256}`;
  return {
    ...envelope,
    journal:
      input.lifecycle === "lease_acquired"
        ? envelope.journal
        : {
            ...envelope.journal,
            remote_correlation_id: correlationId,
            remote_correlation_sha256: sha256(correlationId),
          },
    declaration,
    request_bytes: Buffer.from(requestBytes, "utf8"),
    signal: input.signal ?? new AbortController().signal,
    reportActivity() {},
    readInput(slot) {
      const value = input.inputs.get(slot);
      if (value === undefined) throw new Error(`missing fixture input '${slot}'`);
      return value;
    },
    emitProgress() {},
    beginSubmission() {},
    recordRemoteAccepted() {},
    async cacheResult(bytes) {
      input.cache.bytes = Buffer.from(bytes);
      return {
        schema_version: 1 as const,
        request_sha256: input.request.request_sha256,
        content_sha256: sha256(bytes),
        byte_length: bytes.byteLength,
        bytes: Buffer.from(bytes),
      };
    },
    async readCachedResult() {
      if (input.cache.bytes === null) return null;
      return {
        schema_version: 1 as const,
        request_sha256: input.request.request_sha256,
        content_sha256: sha256(input.cache.bytes),
        byte_length: input.cache.bytes.byteLength,
        bytes: Buffer.from(input.cache.bytes),
      };
    },
    recordFetched() {},
    persist(persistence): HostOperationPersistedOutputV1 {
      const content = String(persistence.operation_result.content);
      input.capture(content);
      const result = artifact("operation-result", Buffer.from(content, "utf8")).ref;
      const outputArtifacts = (persistence.outputs ?? []).map((output, index) => {
        const bytes =
          typeof output.content === "string"
            ? Buffer.from(output.content, "utf8")
            : Buffer.from(output.content);
        return artifact(`operation-output-${String(index)}`, bytes).ref;
      });
      input.captureArtifactCount?.(outputArtifacts.length);
      input.captureOutputs?.(
        (persistence.outputs ?? []).map((output) =>
          typeof output.content === "string"
            ? Buffer.from(output.content, "utf8")
            : Buffer.from(output.content)
        )
      );
      return { operation_result_ref: result, output_artifacts: outputArtifacts };
    },
    registerRemoteCancellation() {},
  };
}

function commonOperationFields(setup: ReturnType<typeof fixture>) {
  const request = setup.request;
  return {
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    phase_id: request.phase_id,
    p01_binding_sha256: request.p01_binding_sha256,
    p02_binding_sha256: request.p02_binding_sha256,
    p03_runtime_binding_sha256: request.p03_runtime_binding_sha256,
    source_snapshot_ref: request.source_snapshot_ref,
    source_snapshot_sha256: request.source_snapshot_sha256,
    p03_request_ref: request.p03_request_ref,
    runtime_policy_ref: request.runtime_policy_ref,
    joern_runtime_identity_ref: request.joern_runtime_identity_ref,
    isolation_evidence_ref: request.isolation_evidence_ref,
    host_isolation_attestation_ref: request.host_isolation_attestation_ref,
    implementation_identity_ref: request.implementation_identity_ref,
    qualification_profile_ref: request.qualification_profile_ref,
    baseline_query_set_ref: request.baseline_query_set_ref,
    runtime_id: request.runtime_id,
    runtime_kind: request.runtime_kind,
    qualification_scope: request.qualification_scope,
    runtime_tree_sha256: request.runtime_tree_sha256,
    isolation_id: request.isolation_id,
    isolation_profile_sha256: request.isolation_profile_sha256,
  };
}

function selectCommonInputs(setup: ReturnType<typeof fixture>) {
  const slots = [
    "p03_request",
    SCA_P03_INPUT_SLOTS.runtime_policy,
    SCA_P03_INPUT_SLOTS.runtime_identity,
    SCA_P03_INPUT_SLOTS.isolation_evidence,
    SCA_P03_INPUT_SLOTS.implementation_identity,
    SCA_P03_INPUT_SLOTS.qualification_profile,
  ];
  const selected = new Map<string, { readonly ref: ArtifactRef; readonly bytes: Uint8Array }>();
  for (const slot of slots) {
    const entry = setup.inputs.get(slot);
    if (entry === undefined) throw new Error(`common P03 input '${slot}' is absent`);
    selected.set(slot, entry);
  }
  return selected;
}

function graphFixture() {
  const setup = fixture();
  const fileBytes = Buffer.from("<?php function target(): void {}\n", "utf8");
  const fileIdentity = {
    path: "src/target.php",
    byte_count: fileBytes.byteLength,
    content_sha256: sha256(fileBytes),
  };
  const treeSha256 = scaP01SourceTreeDigest([fileIdentity]);
  const manifestValue = {
    schema_id: SCA_P01_SOURCE_FILE_MANIFEST_V1_SCHEMA,
    schema_version: 1 as const,
    snapshot_id: "p03-operation-source-snapshot",
    scope: { include_paths: ["src"], exclude_paths: [] },
    files: [fileIdentity],
    file_count: 1,
    byte_count: fileBytes.byteLength,
    tree_sha256: treeSha256,
  };
  const sourceManifest = artifact(
    "graph-source-manifest",
    Buffer.from(canonicalJson(manifestValue), "utf8")
  );
  const custodyValue = {
    schema_id: SCA_P01_SOURCE_CUSTODY_CORPUS_V1_SCHEMA,
    schema_version: 1 as const,
    custody_id: "p03-operation-source-custody",
    snapshot_id: manifestValue.snapshot_id,
    file_manifest_ref: sourceManifest.ref,
    files: [
      {
        path: fileIdentity.path,
        encoding: "base64" as const,
        content_base64: fileBytes.toString("base64"),
        byte_count: fileBytes.byteLength,
        content_sha256: fileIdentity.content_sha256,
      },
    ],
    file_count: 1,
    byte_count: fileBytes.byteLength,
    tree_sha256: treeSha256,
    sealed: true as const,
  };
  const sourceCustody = artifact(
    "graph-source-custody",
    Buffer.from(canonicalJson(custodyValue), "utf8")
  );
  const request = validateScaP03OperationRequestV1(
    "build_source_graph",
    withScaP03Digest(
      {
        schema_id: SCA_P03_GRAPH_BUILD_REQUEST_V1_SCHEMA,
        schema_version: 1,
        ...commonOperationFields(setup),
        operation_id: SCA_P03_OPERATION_IDS.build_php,
        operation_kind: "build_source_graph" as const,
        partition: "php" as const,
        frontend_language: "PHP" as const,
        source_file_manifest_ref: sourceManifest.ref,
        source_custody_ref: sourceCustody.ref,
        expected_files: [
          {
            path: fileIdentity.path,
            content_sha256: fileIdentity.content_sha256,
            role: "primary" as const,
          },
        ],
        max_num_def: setup.policyValue.max_num_def,
        max_graph_bytes: setup.policyValue.max_graph_bytes,
      },
      "request_sha256"
    )
  );
  if (request.operation_kind !== "build_source_graph")
    throw new Error("graph fixture kind drifted");
  const inputs = selectCommonInputs(setup);
  inputs.set(SCA_P03_INPUT_SLOTS.source_file_manifest, sourceManifest);
  inputs.set(SCA_P03_INPUT_SLOTS.source_custody, sourceCustody);
  return { ...setup, request, inputs, fileIdentity };
}

function queryFixture() {
  const setup = fixture();
  const graphBuild = graphFixture();
  const graphBuildRequest = artifact(
    "query-graph-build-request",
    Buffer.from(canonicalJson(graphBuild.request), "utf8")
  );
  const graphComponent = artifact(
    "query-graph-component",
    Buffer.from("p03-query-fixture-graph", "utf8")
  );
  const cleanupBody = {
    workspace_removed: true,
    graph_handles_closed: true,
    process_exit_observed: true,
  };
  const graphBuildKeySha256 = sha256(
    canonicalJson({
      partition: graphBuild.request.partition,
      frontend_language: graphBuild.request.frontend_language,
      source_snapshot_sha256: graphBuild.request.source_snapshot_sha256,
      expected_files: graphBuild.request.expected_files,
      runtime_tree_sha256: graphBuild.request.runtime_tree_sha256,
      implementation_identity_ref: graphBuild.request.implementation_identity_ref,
      max_num_def: graphBuild.request.max_num_def,
    })
  );
  const graphId = `p03graph_${sha256(
    canonicalJson({
      graph_build_key_sha256: graphBuildKeySha256,
      content_sha256: graphComponent.ref.content_digest,
    })
  )}`;
  const graphBuildResultValue = withScaP03Digest(
    {
      schema_id: SCA_P03_GRAPH_BUILD_RESULT_V1_SCHEMA,
      schema_version: 1,
      tenant_id: graphBuild.request.tenant_id,
      project_id: graphBuild.request.project_id,
      run_id: graphBuild.request.run_id,
      phase_id: graphBuild.request.phase_id,
      operation_id: graphBuild.request.operation_id,
      operation_kind: graphBuild.request.operation_kind,
      request_sha256: graphBuild.request.request_sha256,
      p01_binding_sha256: graphBuild.request.p01_binding_sha256,
      p02_binding_sha256: graphBuild.request.p02_binding_sha256,
      p03_runtime_binding_sha256: graphBuild.request.p03_runtime_binding_sha256,
      source_snapshot_ref: graphBuild.request.source_snapshot_ref,
      source_snapshot_sha256: graphBuild.request.source_snapshot_sha256,
      runtime_id: graphBuild.request.runtime_id,
      runtime_kind: graphBuild.request.runtime_kind,
      qualification_scope: graphBuild.request.qualification_scope,
      runtime_tree_sha256: graphBuild.request.runtime_tree_sha256,
      isolation_id: graphBuild.request.isolation_id,
      isolation_profile_sha256: graphBuild.request.isolation_profile_sha256,
      status: "complete" as const,
      blocker_codes: [],
      completed_at: FIXED_NOW.toISOString(),
      partition: graphBuild.request.partition,
      frontend_language: graphBuild.request.frontend_language,
      graph: {
        media_type: "application/vnd.penny.joern-cpg",
        content_schema_id: SCA_P03_GRAPH_COMPONENT_V1_SCHEMA,
        content_sha256: graphComponent.ref.content_digest,
        byte_length: graphComponent.ref.byte_length,
      },
      graph_build_key_sha256: graphBuildKeySha256,
      graph_id: graphId,
      accounted_files: [
        {
          path: graphBuild.fileIdentity.path,
          content_sha256: graphBuild.fileIdentity.content_sha256,
          disposition: "parsed" as const,
          reason_code: null,
        },
      ],
      graph_opened: true,
      cleanup_status: "proven" as const,
      cleanup_evidence: {
        ...cleanupBody,
        cleanup_sha256: sha256(canonicalJson(cleanupBody)),
      },
      complete: true,
    },
    "result_sha256"
  );
  const graphBuildResult = artifact(
    "query-graph-build-result",
    Buffer.from(canonicalJson(graphBuildResultValue), "utf8")
  );
  const request = validateScaP03OperationRequestV1(
    "run_baseline_query_batch",
    withScaP03Digest(
      {
        schema_id: SCA_P03_BASELINE_QUERY_BATCH_REQUEST_V2_SCHEMA,
        schema_version: 2,
        ...commonOperationFields(setup),
        operation_id: SCA_P03_OPERATION_IDS.query_php,
        operation_kind: "run_baseline_query_batch" as const,
        partition: "php" as const,
        graph_component_ref: graphComponent.ref,
        graph_component_sha256: graphComponent.ref.content_digest,
        graph_build_request_ref: graphBuildRequest.ref,
        graph_build_result_ref: graphBuildResult.ref,
        ordered_query_ids: SCA_P03_QUERY_IDS,
        fidelity_requirements: setup.fidelityRequirements.filter(
          (entry) => entry.partition === "php"
        ),
        query_script_refs: setup.scripts.map((entry) => entry.ref),
        query_plan_refs: setup.plans.map((entry) => entry.ref),
        max_query_output_bytes: setup.policyValue.max_query_output_bytes,
        max_query_items: setup.policyValue.max_query_items,
        max_page_items: setup.policyValue.max_page_items,
        max_pages_per_query: setup.policyValue.max_pages_per_query,
      },
      "request_sha256"
    )
  );
  if (request.operation_kind !== "run_baseline_query_batch") {
    throw new Error("query fixture kind drifted");
  }
  const inputs = selectCommonInputs(setup);
  const baseline = setup.inputs.get(SCA_P03_INPUT_SLOTS.baseline_query_set);
  if (baseline === undefined) throw new Error("baseline query set input is absent");
  inputs.set(SCA_P03_INPUT_SLOTS.baseline_query_set, baseline);
  inputs.set("graph_component", graphComponent);
  inputs.set(SCA_P03_INPUT_SLOTS.graph_build_request, graphBuildRequest);
  inputs.set("graph_build_result", graphBuildResult);
  for (const [index, script] of setup.scripts.entries()) {
    inputs.set(`query_script_${String(index).padStart(4, "0")}`, script);
  }
  for (const [index, plan] of setup.plans.entries()) {
    inputs.set(`query_plan_${String(index).padStart(4, "0")}`, plan);
  }
  return { ...setup, request, inputs, graphComponent, graphBuildResult };
}

type RuntimeFixtureIdentity = Readonly<{
  request: ScaP03OperationRequestV1;
  implementationSha256: string;
  deploymentIdentitySha256: string;
}>;

function simulatedRuntime(
  setup: RuntimeFixtureIdentity,
  onExecute?: (kind: "qualify_joern" | "build_source_graph" | "run_baseline_query_batch") => void
) {
  return createScaP03SimulatedJoernRuntimeV1({
    runtime_id: setup.request.runtime_id,
    isolation_id: setup.request.isolation_id,
    runtime_tree_sha256: setup.request.runtime_tree_sha256,
    isolation_profile_sha256: setup.request.isolation_profile_sha256,
    implementation_identity_sha256: setup.implementationSha256,
    deployment_identity_sha256: setup.deploymentIdentitySha256,
    ...(onExecute === undefined ? {} : { onExecute: (kind) => onExecute(kind) }),
  });
}

function paginatedRecoveryRuntime(
  setup: RuntimeFixtureIdentity,
  onExecute: (kind: "qualify_joern" | "build_source_graph" | "run_baseline_query_batch") => void
) {
  const base = simulatedRuntime(setup, onExecute);
  if (setup.request.operation_kind !== "run_baseline_query_batch") return base;
  return {
    ...base,
    async runBaselineQueries(input: Parameters<typeof base.runBaselineQueries>[0]) {
      const output = await base.runBaselineQueries(input);
      const first = output.pages[0];
      if (first === undefined) throw new Error("paginated recovery fixture lacks its first page");
      return {
        ...output,
        pages: [
          { ...first, complete: false },
          { ...first, page_number: 2, items: [], complete: true },
          ...output.pages.slice(1),
        ],
      };
    },
  };
}

describe("P03 host operation cache and cancellation", () => {
  it("recovers after cache publication without executing the Joern runtime twice", async () => {
    const setup = fixture();
    const cache = { bytes: null as Uint8Array | null };
    let executions = 0;
    const runtime = createScaP03SimulatedJoernRuntimeV1({
      runtime_id: setup.request.runtime_id,
      isolation_id: setup.request.isolation_id,
      runtime_tree_sha256: setup.request.runtime_tree_sha256,
      isolation_profile_sha256: setup.request.isolation_profile_sha256,
      implementation_identity_sha256: setup.implementationSha256,
      deployment_identity_sha256: setup.deploymentIdentitySha256,
      onExecute() {
        executions += 1;
      },
    });
    const crashing = createScaP03OperationAdaptersV1({
      runtime,
      now: () => FIXED_NOW,
      fault(point) {
        if (point === "after_result_cached") throw new Error("simulated-crash-after-cache");
      },
    }).get(SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id);
    if (crashing === undefined) throw new Error("qualification adapter is absent");
    await expect(
      crashing.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "lease_acquired",
          cache,
          capture() {},
        })
      )
    ).rejects.toThrow("simulated-crash-after-cache");
    expect(cache.bytes).not.toBeNull();
    expect(executions).toBe(1);

    let persisted = "";
    const recovered = createScaP03OperationAdaptersV1({
      runtime,
      now: () => FIXED_NOW,
      local_recovery: {
        prove_prior_process_terminated() {
          throw new Error("cached recovery must not request termination proof");
        },
      },
    }).get(SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id);
    if (recovered === undefined) throw new Error("recovery adapter is absent");
    await recovered.run(
      context({
        request: setup.request,
        inputs: setup.inputs,
        lifecycle: "submitted",
        cache,
        capture(content) {
          persisted = content;
        },
      })
    );
    expect(executions).toBe(1);
    const result: unknown = JSON.parse(persisted);
    expect(validateScaP03OperationResultV1("qualify_joern", setup.request, result)).toMatchObject({
      status: "blocked",
      qualified: false,
      qualification_scope: "deterministic_test_only",
    });
  });

  it("replays blocked cases with diagnoses and refuses cache code mutation", async () => {
    const setup = fixture();
    const base = createScaP03SimulatedJoernRuntimeV1({
      runtime_id: setup.request.runtime_id,
      isolation_id: setup.request.isolation_id,
      runtime_tree_sha256: setup.request.runtime_tree_sha256,
      isolation_profile_sha256: setup.request.isolation_profile_sha256,
      implementation_identity_sha256: setup.implementationSha256,
      deployment_identity_sha256: setup.deploymentIdentitySha256,
    });
    let executions = 0;
    const runtime = {
      ...base,
      async qualify(input: Parameters<typeof base.qualify>[0]) {
        executions++;
        const result = await base.qualify(input);
        return {
          ...result,
          cases: result.cases.map((entry, index) =>
            index === 7
              ? {
                  ...entry,
                  status: "blocked" as const,
                  blocker_code: "p03_fixture_nodes_absent" as const,
                  observed_sha256: scaP03QualificationObservationSha256V2({
                    fixture_id: entry.fixture_id,
                    fixture_sha256: entry.fixture_sha256,
                    query_id: entry.query_id,
                    frontend_language: entry.frontend_language,
                    release_sha256: result.executed_query_release_sha256,
                    blocker_code: "p03_fixture_nodes_absent",
                    observations: entry.observations,
                  }),
                }
              : entry
          ),
        };
      },
    };
    const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
      SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id
    );
    if (adapter === undefined) throw new Error("qualification adapter absent");
    const cache = { bytes: null as Uint8Array | null };
    let persisted = "";
    const run = (lifecycle: "lease_acquired" | "submitted") =>
      adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle,
          cache,
          capture(content) {
            persisted = content;
          },
        })
      );
    await run("lease_acquired");
    const result = validateScaP03OperationResultV1(
      "qualify_joern",
      setup.request,
      JSON.parse(persisted)
    );
    expect(result.status).toBe("blocked");
    expect(result.cases[7]?.blocker_code).toBe("p03_fixture_nodes_absent");
    await run("submitted");
    expect(executions).toBe(1);
    const entry = result.cases[7];
    if (entry === undefined) throw new Error("blocked case absent");
    const { result_sha256: _digest, ...core } = result;
    void _digest;
    const mutated = withScaP03Digest(
      {
        ...core,
        cases: [
          ...result.cases.slice(0, 7),
          { ...entry, blocker_code: "p03_graph_frontend_mismatch" },
          ...result.cases.slice(8),
        ],
      },
      "result_sha256"
    );
    const cacheWith = (value: unknown) =>
      Buffer.from(
        canonicalJson({
          schema_id: "penny.sca-p03-operation-cache.v1",
          schema_version: 1,
          operation_kind: "qualify_joern",
          result: value,
          outputs: [],
        })
      );
    cache.bytes = cacheWith(mutated);
    await expect(run("submitted")).rejects.toThrow(/qualification observations or digest diverge/u);
    const undiagnosed = {
      ...entry,
      status: "failed" as const,
      blocker_code: null,
      observed_sha256: scaP03QualificationObservationSha256V2({
        fixture_id: entry.fixture_id,
        fixture_sha256: entry.fixture_sha256,
        query_id: entry.query_id,
        frontend_language: entry.frontend_language,
        release_sha256: result.executed_query_release_sha256,
        blocker_code: null,
        observations: entry.observations,
      }),
    };
    cache.bytes = cacheWith(
      withScaP03Digest(
        {
          ...core,
          cases: [...result.cases.slice(0, 7), undiagnosed, ...result.cases.slice(8)],
        },
        "result_sha256"
      )
    );
    await expect(run("submitted")).rejects.toThrow(/qualification observations or digest diverge/u);
    cache.bytes = cacheWith(
      withScaP03Digest(
        {
          ...core,
          cases: [
            ...result.cases.slice(0, 7),
            { ...entry, blocker_code: "private stdout injected" },
            ...result.cases.slice(8),
          ],
        },
        "result_sha256"
      )
    );
    await expect(run("submitted")).rejects.toThrow();
    expect(executions).toBe(1);
  });

  it("changes qualification release identity when script, plan, oracle selector or oracle reference changes", () => {
    const setup = fixture();
    const release = (changes: {
      queries?: typeof setup.runtimeQueries;
      oracle?: typeof setup.corpusValue;
      oracle_ref?: ArtifactRef;
    }) =>
      scaP03OracleBoundReleaseSha256V2({
        query_set_id: setup.querySetValue.query_set_id,
        release_id: setup.querySetValue.release_id,
        query_set_sha256: setup.querySetValue.query_set_sha256,
        queries: changes.queries ?? setup.runtimeQueries,
        oracle_ref: changes.oracle_ref ?? setup.values.fixture_corpus.ref,
        oracle: changes.oracle ?? setup.corpusValue,
      });
    expect(release({})).toBe(setup.releaseSha256);
    expect(
      release({
        queries: setup.runtimeQueries.map((entry, index) =>
          index === 0 ? { ...entry, script_sha256: sha256("other descriptor") } : entry
        ),
      })
    ).not.toBe(setup.releaseSha256);
    expect(
      release({
        queries: setup.runtimeQueries.map((entry, index) =>
          index === 0
            ? { ...entry, plan: { ...entry.plan, max_ast_depth: entry.plan.max_ast_depth + 1 } }
            : entry
        ),
      })
    ).not.toBe(setup.releaseSha256);
    const first = setup.corpusValue.expected_cases[0];
    if (!first) throw new Error("oracle case missing");
    expect(
      release({
        oracle: {
          ...setup.corpusValue,
          expected_cases: [
            { ...first, case_id: "other-case" },
            ...setup.corpusValue.expected_cases.slice(1),
          ],
        },
      })
    ).not.toBe(setup.releaseSha256);
    const assertion = first.oracle_assertions.find((item) => item.expectation === "present");
    const positiveStart = assertion?.start;
    if (positiveStart === undefined) throw new Error("positive start missing");
    expect(
      release({
        oracle: {
          ...setup.corpusValue,
          expected_cases: [
            {
              ...first,
              oracle_assertions: first.oracle_assertions.map((item) =>
                item === assertion
                  ? { ...item, start: { ...positiveStart, name: "other-start" } }
                  : item
              ),
            },
            ...setup.corpusValue.expected_cases.slice(1),
          ],
        },
      })
    ).not.toBe(setup.releaseSha256);
    expect(
      release({
        oracle_ref: {
          ...setup.values.fixture_corpus.ref,
          artifact_id: `art_${sha256("other ref")}`,
        },
      })
    ).not.toBe(setup.releaseSha256);
  });

  it("binds ordered closed oracle assertions in the fixture corpus digest", () => {
    const setup = fixture();
    const corpus = validateScaP03QualificationFixtureCorpusV2(
      JSON.parse(Buffer.from(setup.values.fixture_corpus.bytes).toString("utf8"))
    );
    const first = corpus.expected_cases[0];
    const material = corpus.expected_cases.find(
      (entry) => entry.query_id === "p03.call-resolution.v2"
    );
    if (first === undefined || material === undefined) throw new Error("synthetic oracle absent");
    const { corpus_sha256: _digest, ...core } = corpus;
    void _digest;
    const changed = {
      ...core,
      expected_cases: [
        {
          ...first,
          oracle_assertions: [
            {
              ...first.oracle_assertions[0],
              expectation: "absent",
            },
          ],
        },
        ...core.expected_cases.slice(1),
      ],
    };
    expect(() =>
      validateScaP03QualificationFixtureCorpusV2({
        ...changed,
        corpus_sha256: corpus.corpus_sha256,
      })
    ).toThrow();
    expect(() =>
      validateScaP03QualificationFixtureCorpusV2(
        withScaP03Digest(
          {
            ...core,
            expected_cases: core.expected_cases.map((entry) =>
              entry.case_id === material.case_id
                ? {
                    ...entry,
                    oracle_assertions: [
                      {
                        expectation: "absent",
                        candidate_kind: "call_or_unresolved_call",
                        claim: "call_resolution",
                        disposition: "unresolved",
                      },
                    ],
                  }
                : entry
            ),
          },
          "corpus_sha256"
        )
      )
    ).toThrow("positive start selector");
    expect(() =>
      validateScaP03QualificationFixtureCorpusV2(
        withScaP03Digest(
          {
            ...core,
            expected_cases: [
              { ...first, oracle_assertions: [{ ...first.oracle_assertions[0], invented: true }] },
              ...core.expected_cases.slice(1),
            ],
          },
          "corpus_sha256"
        )
      )
    ).toThrow();
  });

  it("refuses substituted oracle, receipt, review, fixture and changed expected cases before writes or cache replay", async () => {
    const setup = fixture();
    let executions = 0;
    let persists = 0;
    const runtime = paginatedRecoveryRuntime(setup, () => {
      executions++;
    });
    const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
      SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id
    );
    if (!adapter) throw new Error("qualification adapter absent");
    const cache = { bytes: null as Uint8Array | null };
    const captured = (inputs: typeof setup.inputs, lifecycle: "lease_acquired" | "submitted") =>
      context({
        request: setup.request,
        inputs,
        lifecycle,
        cache,
        capture() {
          persists++;
        },
      });
    const mutations = [
      [SCA_P03_INPUT_SLOTS.source_oracle, "foreign-oracle"],
      [SCA_P03_INPUT_SLOTS.source_oracle_validation, "proof-swap"],
      [SCA_P03_INPUT_SLOTS.source_oracle_review, "cross-splice-review"],
      [SCA_P03_INPUT_SLOTS.fixture_corpus, "changed-expected-cases"],
      ["fixture_content_0000", "fixture-substitution"],
    ] as const;
    for (const [slot, label] of mutations) {
      const inputs = new Map(setup.inputs);
      const original = inputs.get(slot);
      if (!original) throw new Error("mutation input absent");
      inputs.set(slot, { ref: original.ref, bytes: Buffer.from(canonicalJson({ label })) });
      await expect(adapter.run(captured(inputs, "lease_acquired"))).rejects.toThrow(
        `p03_exact_input_mismatch:${slot}`
      );
      expect({ executions, persists, cached: cache.bytes }).toEqual({
        executions: 0,
        persists: 0,
        cached: null,
      });
    }
    await adapter.run(captured(setup.inputs, "lease_acquired"));
    expect(cache.bytes).not.toBeNull();
    const before = { executions, persists };
    const altered = new Map(setup.inputs);
    const oracleInput = altered.get(SCA_P03_INPUT_SLOTS.source_oracle);
    if (!oracleInput) throw new Error("oracle input absent");
    altered.set(SCA_P03_INPUT_SLOTS.source_oracle, {
      ref: oracleInput.ref,
      bytes: Buffer.from("{}"),
    });
    await expect(adapter.run(captured(altered, "submitted"))).rejects.toThrow(
      `p03_exact_input_mismatch:${SCA_P03_INPUT_SLOTS.source_oracle}`
    );
    expect({ executions, persists }).toEqual(before);
  });

  it("accepts only receipt-bound deterministic reviewed relationship candidates through production source revalidation", async () => {
    const setup = fixture(true);
    const base = createScaP03SimulatedJoernRuntimeV1({
      runtime_id: setup.request.runtime_id,
      isolation_id: setup.request.isolation_id,
      runtime_tree_sha256: setup.request.runtime_tree_sha256,
      isolation_profile_sha256: setup.request.isolation_profile_sha256,
      implementation_identity_sha256: setup.implementationSha256,
      deployment_identity_sha256: setup.deploymentIdentitySha256,
    });
    const runtime = {
      ...base,
      async qualify(input: Parameters<typeof base.qualify>[0]) {
        expect(input.source_oracle_validation_ref).toEqual(
          setup.request.source_oracle_validation_ref
        );
        expect(input.source_oracle_validation_receipt?.expected_cases).toEqual(
          input.expected_cases
        );
        return {
          executed_query_release_sha256: input.query_release.release_sha256,
          cases: input.expected_cases.map((expected) => {
            const fixture = input.fixtures.find((item) => item.language === expected.language);
            if (fixture === undefined) throw new Error("fixture missing");
            return observedFromSourceCase(
              expected,
              fixture,
              input.query_release.release_sha256,
              input.source_oracle_validation_ref
            );
          }),
        };
      },
    };
    const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
      SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id
    );
    if (adapter === undefined) throw new Error("qualification adapter absent");
    const cache = { bytes: null as Uint8Array | null };
    let persisted = "";
    await adapter.run(
      context({
        request: setup.request,
        inputs: setup.inputs,
        lifecycle: "lease_acquired",
        cache,
        capture(content) {
          persisted = content;
        },
      })
    );
    const result = validateScaP03OperationResultV1(
      "qualify_joern",
      setup.request,
      JSON.parse(persisted)
    );
    expect(result.status).toBe("complete");
    expect(result.qualified).toBe(false); // deterministic is never AC evidence
    const expected = result.cases.filter(
      (entry) =>
        ["p03.control-guard.v2", "p03.framework-dispatch.v2"].includes(entry.query_id) ||
        (entry.language !== "javascript" && entry.query_id === "p03.dataflow-source-sink.v2")
    );
    expect(expected).toHaveLength(8);
    for (const entry of expected) {
      expect(entry.status).toBe("passed");
      expect(
        entry.observations[0]?.edges.every(
          (edge) =>
            edge.provenance === "qualified_complement" &&
            canonicalJson(edge.complement_ref) ===
              canonicalJson(setup.request.source_oracle_validation_ref)
        )
      ).toBe(true);
    }
    const changed = { ...result, source_oracle_validation_ref: setup.request.source_oracle_ref };
    expect(() =>
      validateScaP03OperationResultV1("qualify_joern", setup.request, changed)
    ).toThrow();
    const sourceTruth = projectSourceOracleCases(
      validateSourceOracleBytes(
        readFileSync(new URL("./fixtures/p03-v2/oracle.json", import.meta.url))
      )
    );
    const guardIndex = result.cases.findIndex(
      (entry) => entry.language === "php" && entry.query_id === "p03.control-guard.v2"
    );
    const guardCase = result.cases[guardIndex];
    const guardCandidate = guardCase?.observations[0];
    if (
      guardCase === undefined ||
      guardCandidate === undefined ||
      result.executed_query_release_sha256 === null
    )
      throw new Error("guard candidate absent");
    const { candidate_id: _guardId, serialized_bytes: _guardBytes, ...guardCore } = guardCandidate;
    void _guardId;
    void _guardBytes;
    const inverted = makeScaP03QueryCandidateV2({
      ...guardCore,
      edges: guardCore.edges.map((edge) => ({ ...edge, branch_orientation: "false" as const })),
    });
    const observations = [inverted];
    const corrupted = {
      ...guardCase,
      observations,
      observation_count: 1,
      observed_sha256: scaP03QualificationObservationSha256V2({
        fixture_id: guardCase.fixture_id,
        fixture_sha256: guardCase.fixture_sha256,
        query_id: guardCase.query_id,
        frontend_language: guardCase.frontend_language,
        release_sha256: result.executed_query_release_sha256,
        blocker_code: null,
        observations,
      }),
    };
    const spliced = {
      ...result,
      cases: result.cases.map((entry, index) => (index === guardIndex ? corrupted : entry)),
    };
    expect(() =>
      validateScaP03QualificationResultProjectionV2(
        spliced,
        sourceTruth,
        setup.request.source_oracle_validation_ref
      )
    ).toThrow(/reviewed source truth|verdict/u);
    expect(() =>
      validateScaP03QualificationResultProjectionV2(
        result,
        sourceTruth,
        setup.request.source_oracle_ref
      )
    ).toThrow(/receipt/u);
    if (cache.bytes === null) throw new Error("qualification cache missing");
    const cached = validateContract(
      Type.Object(
        { result: Type.Unknown(), outputs: Type.Array(Type.Unknown()) },
        { additionalProperties: true }
      ),
      JSON.parse(Buffer.from(cache.bytes).toString("utf8")),
      "qualification cache"
    );
    const { result_sha256: _resultDigest, ...resultCore } = result;
    void _resultDigest;
    cache.bytes = Buffer.from(
      canonicalJson({
        ...cached,
        result: withScaP03Digest(
          {
            ...resultCore,
            source_oracle_validation_ref: setup.request.source_oracle_ref,
          },
          "result_sha256"
        ),
      })
    );
    await expect(
      adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "submitted",
          cache,
          capture() {
            throw new Error("spliced cache must not persist");
          },
        })
      )
    ).rejects.toThrow(/authority refs drifted/u);
  });

  it("replays retained same-start sibling observations; refuses a rehashed foreign start", async () => {
    const setup = fixture();
    const base = createScaP03SimulatedJoernRuntimeV1({
      runtime_id: setup.request.runtime_id,
      isolation_id: setup.request.isolation_id,
      runtime_tree_sha256: setup.request.runtime_tree_sha256,
      isolation_profile_sha256: setup.request.isolation_profile_sha256,
      implementation_identity_sha256: setup.implementationSha256,
      deployment_identity_sha256: setup.deploymentIdentitySha256,
    });
    let executions = 0;
    const runtime = {
      ...base,
      async qualify(input: Parameters<typeof base.qualify>[0]) {
        executions++;
        return {
          executed_query_release_sha256: input.query_release.release_sha256,
          cases: (["php", "javascript", "typescript"] as const).flatMap((language) => {
            const fixture = input.fixtures.find((item) => item.language === language);
            if (fixture === undefined) throw new Error("synthetic fixture absent");
            return SCA_P03_QUERY_IDS.map((query_id) => {
              const expected = input.expected_cases.find(
                (entry) => entry.language === language && entry.query_id === query_id
              );
              if (!expected) throw new Error("source case absent");
              const caseResult = observedFromSourceCase(
                expected,
                fixture,
                input.query_release.release_sha256,
                input.source_oracle_validation_ref
              );
              if (language !== "php" || query_id !== "p03.call-resolution.v2") return caseResult;
              const positive = caseResult.observations[0];
              const start = positive?.vertices[0];
              const end = positive?.vertices.at(-1);
              if (positive === undefined || start === undefined || end === undefined)
                throw new Error("synthetic call missing");
              const { candidate_id: _id, serialized_bytes: _length, ...core } = positive;
              void _id;
              void _length;
              const sibling = makeScaP03QueryCandidateV2({
                ...core,
                stable_locator: `${core.stable_locator}:other`,
                vertices: [start, { ...end, name: "other_method" }],
              });
              const observations = [positive, sibling].sort((a, b) =>
                a.candidate_id.localeCompare(b.candidate_id)
              );
              return {
                ...caseResult,
                observations,
                observation_count: observations.length,
                observed_sha256: scaP03QualificationObservationSha256V2({
                  fixture_id: caseResult.fixture_id,
                  fixture_sha256: caseResult.fixture_sha256,
                  query_id,
                  frontend_language: caseResult.frontend_language,
                  release_sha256: input.query_release.release_sha256,
                  blocker_code: null,
                  observations,
                }),
              };
            });
          }),
        };
      },
    };
    const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
      SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id
    );
    if (adapter === undefined) throw new Error("qualification adapter absent");
    const cache = { bytes: null as Uint8Array | null };
    let persisted = "";
    await adapter.run(
      context({
        request: setup.request,
        inputs: setup.inputs,
        lifecycle: "lease_acquired",
        cache,
        capture(content) {
          persisted = content;
        },
      })
    );
    const result = validateScaP03OperationResultV1(
      "qualify_joern",
      setup.request,
      JSON.parse(persisted)
    );
    expect(result).toMatchObject({ status: "complete", qualified: false });
    expect(result.cases[0]?.observation_count).toBe(1);
    const reviewedCall = result.cases.find(
      (entry) => entry.language === "php" && entry.query_id === "p03.call-resolution.v2"
    );
    expect(reviewedCall).toMatchObject({ status: "passed", observation_count: 2 });
    expect(reviewedCall?.observations.map((item) => item.vertices.at(-1)?.name).sort()).toEqual([
      "other_method",
      "persist_record",
    ]);
    let replayed = "";
    await adapter.run(
      context({
        request: setup.request,
        inputs: setup.inputs,
        lifecycle: "submitted",
        cache,
        capture(content) {
          replayed = content;
        },
      })
    );
    expect(replayed).toBe(persisted);
    expect(executions).toBe(1);

    const first = result.cases[0];
    const candidate = first?.observations[0];
    if (
      first === undefined ||
      candidate === undefined ||
      result.executed_query_release_sha256 === null
    )
      throw new Error("synthetic candidate absent");
    const { candidate_id: _id, serialized_bytes: _length, ...core } = candidate;
    void _id;
    void _length;
    const start = core.vertices[0];
    if (start === undefined) throw new Error("synthetic start absent");
    const observations = [
      candidate,
      makeScaP03QueryCandidateV2({
        ...core,
        vertices: [{ ...start, name: "decoy" }, ...core.vertices.slice(1)],
      }),
    ].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));
    const mutated = {
      ...first,
      observations,
      observation_count: observations.length,
      observed_sha256: scaP03QualificationObservationSha256V2({
        fixture_id: first.fixture_id,
        fixture_sha256: first.fixture_sha256,
        query_id: first.query_id,
        frontend_language: first.frontend_language,
        release_sha256: result.executed_query_release_sha256,
        blocker_code: first.blocker_code,
        observations,
      }),
    };
    const { result_sha256: _digest, ...resultCore } = result;
    void _digest;
    const changed = withScaP03Digest(
      { ...resultCore, cases: [mutated, ...result.cases.slice(1)] },
      "result_sha256"
    );
    const cached = validateContract(
      Type.Object({ result: Type.Unknown() }),
      JSON.parse(Buffer.from(cache.bytes ?? []).toString("utf8")),
      "qualification cache"
    );
    expect(cached.result).toBeDefined();
    cache.bytes = Buffer.from(
      canonicalJson({
        schema_id: "penny.sca-p03-operation-cache.v1",
        schema_version: 1,
        operation_kind: "qualify_joern",
        result: changed,
        outputs: [],
      }),
      "utf8"
    );
    await expect(
      adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "submitted",
          cache,
          capture() {},
        })
      )
    ).rejects.toThrow("SCA P03 qualification retained foreign oracle targets");
    expect(executions).toBe(1);
  });

  it("requires exact local process termination proof before uncached submitted re-execution", async () => {
    for (const setup of [fixture(), graphFixture(), queryFixture()]) {
      let executions = 0;
      let persists = 0;
      const runtime = paginatedRecoveryRuntime(setup, () => {
        executions += 1;
      });
      const declaration =
        setup.request.operation_kind === "qualify_joern"
          ? SCA_P03_OPERATION_DECLARATIONS.qualify
          : setup.request.operation_kind === "build_source_graph"
            ? SCA_P03_OPERATION_DECLARATIONS.build_source_graph
            : SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch;
      const cache = { bytes: null as Uint8Array | null };
      const recoveryContext = (priorCorrelationId?: string) =>
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "submitted",
          ...(priorCorrelationId === undefined ? {} : { priorCorrelationId }),
          cache,
          capture() {
            persists += 1;
          },
        });
      const crashing = createScaP03OperationAdaptersV1({
        runtime,
        now: () => FIXED_NOW,
        fault(point) {
          if (point === "before_result_cache") throw new Error("simulated-crash-before-cache");
        },
      }).get(declaration.adapter_id);
      if (crashing === undefined) throw new Error("P03 adapter is absent");
      await expect(
        crashing.run(
          context({
            request: setup.request,
            inputs: setup.inputs,
            lifecycle: "lease_acquired",
            cache,
            capture() {
              persists += 1;
            },
          })
        )
      ).rejects.toThrow("simulated-crash-before-cache");
      expect(cache.bytes).toBeNull();
      expect(executions).toBe(1);
      expect(persists).toBe(0);

      for (const local_recovery of [
        undefined,
        { prove_prior_process_terminated: async () => false },
        {
          prove_prior_process_terminated: async () => {
            throw new Error("observer unavailable");
          },
        },
      ]) {
        const denied = createScaP03OperationAdaptersV1({
          runtime,
          now: () => FIXED_NOW,
          local_recovery,
        }).get(declaration.adapter_id);
        if (denied === undefined) throw new Error("P03 recovery adapter is absent");
        await expect(denied.run(recoveryContext())).rejects.toThrow(
          "local_prior_process_termination_unproven"
        );
        expect({ executions, persists, cached: cache.bytes }).toEqual({
          executions: 1,
          persists: 0,
          cached: null,
        });
      }

      let proofCalls = 0;
      const recovered = createScaP03OperationAdaptersV1({
        runtime,
        now: () => FIXED_NOW,
        local_recovery: {
          prove_prior_process_terminated(input) {
            proofCalls += 1;
            expect(input).toEqual({
              operation_kind: setup.request.operation_kind,
              request_sha256: setup.request.request_sha256,
              prior_correlation_id: `p03_${setup.request.request_sha256}`,
            });
            return true;
          },
        },
      }).get(declaration.adapter_id);
      if (recovered === undefined) throw new Error("P03 recovery adapter is absent");
      await expect(recovered.run(recoveryContext("p03_wrong-correlation"))).rejects.toThrow(
        "p03_operation_journal_cannot_resume"
      );
      expect({ proofCalls, executions, persists }).toEqual({
        proofCalls: 0,
        executions: 1,
        persists: 0,
      });
      for (const lifecycle of ["fetched", "persisting"] as const) {
        await expect(
          recovered.run(
            context({
              request: setup.request,
              inputs: setup.inputs,
              lifecycle,
              cache,
              capture() {
                persists += 1;
              },
            })
          )
        ).rejects.toThrow("p03_cached_result_missing_after_fetch");
      }
      expect({ proofCalls, executions, persists }).toEqual({
        proofCalls: 0,
        executions: 1,
        persists: 0,
      });

      let persisted = "";
      await recovered.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "submitted",
          cache,
          capture(content) {
            persisted = content;
          },
        })
      );
      expect(proofCalls).toBe(1);
      expect(executions).toBe(2);
      expect(JSON.parse(persisted)).toMatchObject({
        status: setup.request.operation_kind === "qualify_joern" ? "blocked" : "complete",
      });
    }
  });

  it("replays graph and paginated-query cache after a post-cache crash without re-execution", async () => {
    for (const setup of [graphFixture(), queryFixture()]) {
      let executions = 0;
      const runtime = paginatedRecoveryRuntime(setup, () => {
        executions += 1;
      });
      const declaration =
        setup.request.operation_kind === "build_source_graph"
          ? SCA_P03_OPERATION_DECLARATIONS.build_source_graph
          : SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch;
      const cache = { bytes: null as Uint8Array | null };
      const crashing = createScaP03OperationAdaptersV1({
        runtime,
        now: () => FIXED_NOW,
        fault(point) {
          if (point === "after_result_cached") throw new Error("simulated-post-cache-crash");
        },
      }).get(declaration.adapter_id);
      if (crashing === undefined) throw new Error("P03 graph/query adapter is absent");
      await expect(
        crashing.run(
          context({
            request: setup.request,
            inputs: setup.inputs,
            lifecycle: "lease_acquired",
            cache,
            capture() {},
          })
        )
      ).rejects.toThrow("simulated-post-cache-crash");
      expect(cache.bytes).not.toBeNull();
      expect(executions).toBe(1);

      let persisted = "";
      const recovered = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
        declaration.adapter_id
      );
      if (recovered === undefined) throw new Error("P03 graph/query recovery adapter is absent");
      await recovered.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "submitted",
          cache,
          capture(content) {
            persisted = content;
          },
        })
      );
      expect(executions).toBe(1);
      const replayed: unknown = JSON.parse(persisted);
      expect(replayed).toMatchObject({ status: "complete", complete: true });
      if (setup.request.operation_kind === "run_baseline_query_batch") {
        if (
          typeof replayed !== "object" ||
          replayed === null ||
          !("page_descriptors" in replayed) ||
          !Array.isArray(replayed.page_descriptors)
        ) {
          throw new Error("replayed paginated query result lacks page descriptors");
        }
        expect(replayed.page_descriptors).toHaveLength(8);
      }
    }
  });

  it("blocks a runtime that reports a qualification observation outside frozen ground truth", async () => {
    const setup = fixture();
    const base = createScaP03SimulatedJoernRuntimeV1({
      runtime_id: setup.request.runtime_id,
      isolation_id: setup.request.isolation_id,
      runtime_tree_sha256: setup.request.runtime_tree_sha256,
      isolation_profile_sha256: setup.request.isolation_profile_sha256,
      implementation_identity_sha256: setup.implementationSha256,
      deployment_identity_sha256: setup.deploymentIdentitySha256,
    });
    const runtime = {
      ...base,
      async qualify(input: Parameters<typeof base.qualify>[0]) {
        const result = await base.qualify(input);
        const first = result.cases[0];
        if (first === undefined) throw new Error("qualification fixture lacks cases");
        expect("expected_cases" in input).toBe(false);
        return {
          executed_query_release_sha256: result.executed_query_release_sha256,
          cases: [{ ...first, observed_sha256: "f".repeat(64) }, ...result.cases.slice(1)],
        };
      },
    };
    const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
      SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id
    );
    if (adapter === undefined) throw new Error("qualification adapter is absent");
    let persisted = "";
    await adapter.run(
      context({
        request: setup.request,
        inputs: setup.inputs,
        lifecycle: "lease_acquired",
        cache: { bytes: null },
        capture(content) {
          persisted = content;
        },
      })
    );
    const blocked = validateScaP03OperationResultV1(
      "qualify_joern",
      setup.request,
      JSON.parse(persisted)
    );
    expect(blocked).toMatchObject({
      status: "blocked",
      qualified: false,
      blocker_codes: ["joern_qualification_failed"],
    });
    expect(
      blocked.cases.every((entry) => entry.blocker_code === "joern_qualification_failed")
    ).toBe(true);
    expect(blocked.cases.every((entry) => entry.status === "blocked")).toBe(true);
  });

  it("publishes graph and query outputs that round-trip against their exact descriptors", async () => {
    const graph = graphFixture();
    const graphRuntime = simulatedRuntime(graph);
    const graphAdapter = createScaP03OperationAdaptersV1({
      runtime: graphRuntime,
      now: () => FIXED_NOW,
    }).get(SCA_P03_OPERATION_DECLARATIONS.build_source_graph.adapter_id);
    if (graphAdapter === undefined) throw new Error("graph adapter is absent");
    let graphPersisted = "";
    let graphArtifactCount = 0;
    await graphAdapter.run(
      context({
        request: graph.request,
        inputs: graph.inputs,
        lifecycle: "lease_acquired",
        cache: { bytes: null },
        capture(content) {
          graphPersisted = content;
        },
        captureArtifactCount(count) {
          graphArtifactCount = count;
        },
      })
    );
    expect(
      validateScaP03OperationResultV1(
        "build_source_graph",
        graph.request,
        JSON.parse(graphPersisted)
      )
    ).toMatchObject({ status: "complete", complete: true, cleanup_status: "proven" });
    expect(graphArtifactCount).toBe(1);

    const query = queryFixture();
    const queryRuntime = simulatedRuntime(query);
    const queryAdapter = createScaP03OperationAdaptersV1({
      runtime: queryRuntime,
      now: () => FIXED_NOW,
    }).get(SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch.adapter_id);
    if (queryAdapter === undefined) throw new Error("query adapter is absent");
    let queryPersisted = "";
    let pageOutputs: readonly Uint8Array[] = [];
    await queryAdapter.run(
      context({
        request: query.request,
        inputs: query.inputs,
        lifecycle: "lease_acquired",
        cache: { bytes: null },
        capture(content) {
          queryPersisted = content;
        },
        captureOutputs(outputs) {
          pageOutputs = outputs;
        },
      })
    );
    const queryResult = validateScaP03OperationResultV1(
      "run_baseline_query_batch",
      query.request,
      JSON.parse(queryPersisted)
    );
    if (queryResult.operation_kind !== "run_baseline_query_batch") {
      throw new Error("query result kind drifted");
    }
    expect(queryResult).toMatchObject({ status: "complete", complete: true, truncated: false });
    expect(pageOutputs).toHaveLength(queryResult.page_descriptors.length);
    for (const [index, bytes] of pageOutputs.entries()) {
      const descriptor = queryResult.page_descriptors[index];
      if (descriptor === undefined) throw new Error("query page descriptor is absent");
      expect({ digest: sha256(bytes), byteLength: bytes.byteLength }).toEqual({
        digest: descriptor.content_sha256,
        byteLength: descriptor.byte_length,
      });
      expect(
        validateScaP03BaselineQueryPageV2(JSON.parse(Buffer.from(bytes).toString("utf8")))
      ).toMatchObject({
        query_id: descriptor.query_id,
        page_number: descriptor.page_number,
      });
    }
  });

  it("never caches or persists cleanup-unproven runtime errors for any P03 operation", async () => {
    for (const setup of [fixture(), graphFixture(), queryFixture()]) {
      let executions = 0;
      let persists = 0;
      const base = simulatedRuntime(setup);
      const fail = async (): Promise<never> => {
        executions += 1;
        throw new Error("p03_cleanup_unproven");
      };
      const runtime = { ...base, qualify: fail, buildGraph: fail, runBaselineQueries: fail };
      const adapterId =
        setup.request.operation_kind === "qualify_joern"
          ? SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id
          : setup.request.operation_kind === "build_source_graph"
            ? SCA_P03_OPERATION_DECLARATIONS.build_source_graph.adapter_id
            : SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch.adapter_id;
      const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
        adapterId
      );
      if (adapter === undefined) throw new Error("P03 adapter is absent");
      const cache = { bytes: null };
      const captured = (lifecycle: "lease_acquired" | "submitted") =>
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle,
          cache,
          capture() {
            persists += 1;
          },
        });
      await expect(adapter.run(captured("lease_acquired"))).rejects.toThrow("p03_cleanup_unproven");
      expect({ executions, persists, cached: cache.bytes }).toEqual({
        executions: 1,
        persists: 0,
        cached: null,
      });
      await expect(adapter.run(captured("submitted"))).rejects.toThrow(
        "local_prior_process_termination_unproven"
      );
      expect(executions).toBe(1);
    }
  });

  it("fails closed on graph cleanup failure without publishing a stale graph", async () => {
    const setup = graphFixture();
    const base = simulatedRuntime(setup);
    const runtime = {
      ...base,
      async buildGraph(input: Parameters<typeof base.buildGraph>[0]) {
        const output = await base.buildGraph(input);
        const cleanupBody = {
          workspace_removed: false,
          graph_handles_closed: true,
          process_exit_observed: true,
        };
        return {
          ...output,
          cleanup_evidence: {
            ...cleanupBody,
            cleanup_sha256: sha256(canonicalJson(cleanupBody)),
          },
        };
      },
    };
    const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
      SCA_P03_OPERATION_DECLARATIONS.build_source_graph.adapter_id
    );
    if (adapter === undefined) throw new Error("graph adapter is absent");
    let persisted = "";
    let artifactCount = -1;
    const cache = { bytes: null };
    await expect(
      adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "lease_acquired",
          cache,
          capture(content) {
            persisted = content;
          },
          captureArtifactCount(count) {
            artifactCount = count;
          },
        })
      )
    ).rejects.toThrow("p03_cleanup_unproven");
    expect({ persisted, artifactCount, cached: cache.bytes }).toEqual({
      persisted: "",
      artifactCount: -1,
      cached: null,
    });
    await expect(
      adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "submitted",
          cache,
          capture() {
            throw new Error("must not persist");
          },
        })
      )
    ).rejects.toThrow("local_prior_process_termination_unproven");
  });

  it("blocks an oversized graph before output publication", async () => {
    const setup = graphFixture();
    const base = simulatedRuntime(setup);
    const runtime = {
      ...base,
      async buildGraph(input: Parameters<typeof base.buildGraph>[0]) {
        const output = await base.buildGraph(input);
        return {
          ...output,
          graph_bytes: Buffer.alloc(setup.request.max_graph_bytes + 1, 1),
        };
      },
    };
    const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
      SCA_P03_OPERATION_DECLARATIONS.build_source_graph.adapter_id
    );
    if (adapter === undefined) throw new Error("graph adapter is absent");
    let persisted = "";
    let artifactCount = -1;
    await adapter.run(
      context({
        request: setup.request,
        inputs: setup.inputs,
        lifecycle: "lease_acquired",
        cache: { bytes: null },
        capture(content) {
          persisted = content;
        },
        captureArtifactCount(count) {
          artifactCount = count;
        },
      })
    );
    expect(
      validateScaP03OperationResultV1("build_source_graph", setup.request, JSON.parse(persisted))
    ).toMatchObject({
      status: "blocked",
      graph: null,
      blocker_codes: ["graph_output_limit_exceeded"],
    });
    expect(artifactCount).toBe(0);
  });

  it("preserves ordinary unsupported candidates independently of requirement support", async () => {
    const setup = queryFixture();
    const base = simulatedRuntime(setup);
    for (const unrelatedGap of [false, true]) {
      const runtime = {
        ...base,
        async runBaselineQueries(input: Parameters<typeof base.runBaselineQueries>[0]) {
          const output = await base.runBaselineQueries(input);
          const symbol = output.pages[0]?.items[0];
          if (symbol === undefined) throw new Error("query fixture lacks a symbol");
          const { candidate_id: _id, serialized_bytes: _bytes, ...core } = symbol;
          void _id;
          void _bytes;
          const unsupported = makeScaP03QueryCandidateV2({
            ...core,
            query_id: "p03.unsupported-surface.v2",
            candidate_kind: "unsupported_or_unresolved_surface",
            claim: "unsupported_surface",
            disposition: "unsupported",
            reason_code: "unsupported_surface_observed",
          });
          return {
            ...output,
            pages: output.pages.map((page) =>
              page.query_id === "p03.unsupported-surface.v2"
                ? { ...page, items: [unsupported] }
                : page
            ),
            fidelity_observations: output.fidelity_observations.map((entry) =>
              unrelatedGap && entry.requirement_id === "p03-framework-php"
                ? {
                    ...entry,
                    support: "partial" as const,
                    reason_code: "unrelated_non_material_gap",
                  }
                : entry
            ),
          };
        },
      };
      const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
        SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch.adapter_id
      );
      if (adapter === undefined) throw new Error("query adapter is absent");
      let persisted = "";
      let artifactCount = -1;
      await adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "lease_acquired",
          cache: { bytes: null },
          capture(content) {
            persisted = content;
          },
          captureArtifactCount(count) {
            artifactCount = count;
          },
        })
      );
      expect(
        validateScaP03OperationResultV1(
          "run_baseline_query_batch",
          setup.request,
          JSON.parse(persisted)
        )
      ).toMatchObject({
        status: "complete",
        complete: true,
        blocker_codes: [],
      });
      expect(artifactCount).toBe(SCA_P03_QUERY_IDS.length);
    }
  });

  it("blocks runtimes that ignore or substitute the frozen query release", async () => {
    const setup = queryFixture();
    const base = simulatedRuntime(setup);
    const runtime = {
      ...base,
      async runBaselineQueries(input: Parameters<typeof base.runBaselineQueries>[0]) {
        const output = await base.runBaselineQueries(input);
        return { ...output, executed_query_release_sha256: "f".repeat(64) };
      },
    };
    const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
      SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch.adapter_id
    );
    if (adapter === undefined) throw new Error("query adapter is absent");
    let persisted = "";
    await adapter.run(
      context({
        request: setup.request,
        inputs: setup.inputs,
        lifecycle: "lease_acquired",
        cache: { bytes: null },
        capture(content) {
          persisted = content;
        },
      })
    );
    expect(
      validateScaP03OperationResultV1(
        "run_baseline_query_batch",
        setup.request,
        JSON.parse(persisted)
      )
    ).toMatchObject({
      status: "blocked",
      blocker_codes: ["query_release_mismatch"],
      page_descriptors: [],
    });
  });

  it("enforces host timeouts even when a runtime ignores abort", async () => {
    const setup = queryFixture();
    const base = simulatedRuntime(setup);
    const runtime = {
      ...base,
      async runBaselineQueries() {
        return await new Promise<never>(() => {});
      },
    };
    const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
      SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch.adapter_id
    );
    if (adapter === undefined) throw new Error("query adapter is absent");
    let persisted = "";
    const cache = { bytes: null };
    await expect(
      adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "lease_acquired",
          cache,
          capture(content) {
            persisted = content;
          },
        })
      )
    ).rejects.toThrow("operation_timeout");
    expect({ persisted, cached: cache.bytes }).toEqual({ persisted: "", cached: null });
    await expect(
      adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "submitted",
          cache,
          capture() {
            throw new Error("must not persist");
          },
        })
      )
    ).rejects.toThrow("local_prior_process_termination_unproven");
  });

  it("rejects duplicate and over-limit query pages without publishing page artifacts", async () => {
    const setup = queryFixture();
    const base = simulatedRuntime(setup);
    for (const mutate of [
      async (output: Awaited<ReturnType<typeof base.runBaselineQueries>>) => ({
        ...output,
        pages: [output.pages[0], output.pages[0], ...output.pages.slice(1)],
      }),
      async (output: Awaited<ReturnType<typeof base.runBaselineQueries>>) => {
        const first = output.pages[0];
        if (first === undefined || first.items[0] === undefined) throw new Error("page is empty");
        return {
          ...output,
          pages: [
            {
              ...first,
              items: Array.from({ length: setup.request.max_page_items + 1 }, (_, index) => ({
                ...first.items[0],
                candidate_id: `p03-over-limit-${String(index)}`,
              })),
            },
            ...output.pages.slice(1),
          ],
        };
      },
    ]) {
      const runtime = {
        ...base,
        async runBaselineQueries(input: Parameters<typeof base.runBaselineQueries>[0]) {
          return await mutate(await base.runBaselineQueries(input));
        },
      };
      const adapter = createScaP03OperationAdaptersV1({ runtime, now: () => FIXED_NOW }).get(
        SCA_P03_OPERATION_DECLARATIONS.run_baseline_query_batch.adapter_id
      );
      if (adapter === undefined) throw new Error("query adapter is absent");
      let persisted = "";
      let artifactCount = -1;
      await adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "lease_acquired",
          cache: { bytes: null },
          capture(content) {
            persisted = content;
          },
          captureArtifactCount(count) {
            artifactCount = count;
          },
        })
      );
      expect(
        validateScaP03OperationResultV1(
          "run_baseline_query_batch",
          setup.request,
          JSON.parse(persisted)
        )
      ).toMatchObject({ status: "blocked", page_descriptors: [] });
      expect(artifactCount).toBe(0);
    }
  });

  it("honors cancellation before runtime execution or persistence", async () => {
    const setup = fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    let executions = 0;
    let persists = 0;
    const runtime = createScaP03SimulatedJoernRuntimeV1({
      runtime_id: setup.request.runtime_id,
      isolation_id: setup.request.isolation_id,
      runtime_tree_sha256: setup.request.runtime_tree_sha256,
      isolation_profile_sha256: setup.request.isolation_profile_sha256,
      implementation_identity_sha256: setup.implementationSha256,
      deployment_identity_sha256: setup.deploymentIdentitySha256,
      onExecute() {
        executions += 1;
      },
    });
    const adapter = createScaP03OperationAdaptersV1({ runtime }).get(
      SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id
    );
    if (adapter === undefined) throw new Error("qualification adapter is absent");
    await expect(
      adapter.run(
        context({
          request: setup.request,
          inputs: setup.inputs,
          lifecycle: "lease_acquired",
          cache: { bytes: null },
          signal: controller.signal,
          capture() {
            persists += 1;
          },
        })
      )
    ).rejects.toThrow(/cancelled by test/u);
    expect({ executions, persists }).toEqual({ executions: 0, persists: 0 });
  });

  it("rejects an exact-ref input whose bytes no longer match its digest", async () => {
    const setup = fixture();
    const stale = new Map(setup.inputs);
    const policy = stale.get(SCA_P03_INPUT_SLOTS.runtime_policy);
    if (policy === undefined) throw new Error("runtime policy fixture is absent");
    stale.set(SCA_P03_INPUT_SLOTS.runtime_policy, {
      ref: policy.ref,
      bytes: Buffer.from("substituted", "utf8"),
    });
    let executions = 0;
    const runtime = createScaP03SimulatedJoernRuntimeV1({
      runtime_id: setup.request.runtime_id,
      isolation_id: setup.request.isolation_id,
      runtime_tree_sha256: setup.request.runtime_tree_sha256,
      isolation_profile_sha256: setup.request.isolation_profile_sha256,
      implementation_identity_sha256: setup.implementationSha256,
      deployment_identity_sha256: setup.deploymentIdentitySha256,
      onExecute() {
        executions += 1;
      },
    });
    const adapter = createScaP03OperationAdaptersV1({ runtime }).get(
      SCA_P03_OPERATION_DECLARATIONS.qualify.adapter_id
    );
    if (adapter === undefined) throw new Error("qualification adapter is absent");
    await expect(
      adapter.run(
        context({
          request: setup.request,
          inputs: stale,
          lifecycle: "lease_acquired",
          cache: { bytes: null },
          capture() {},
        })
      )
    ).rejects.toThrow(/p03_exact_input_mismatch:runtime_policy/u);
    expect(executions).toBe(0);
  });
});
